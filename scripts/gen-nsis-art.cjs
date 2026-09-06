#!/usr/bin/env node
// scripts/gen-nsis-art.cjs — [lc-1054] NSIS 安装/卸载向导品牌图生成器
// ─────────────────────────────────────────────────────────────────────────────
// 背景: 安装包用的是 electron-builder NSIS 向导(oneClick:false), 默认灰白向导页很古老。
//   MUI2 支持三张品牌位图: installerSidebar(164×314, 欢迎/完成页侧栏) /
//   uninstallerSidebar(164×314, 卸载确认页侧栏) / installerHeader(150×57, 目录/进度页头图)。
//   本脚本用 playwright 渲染「项目风格画稿」(粉紫亚克力渐变 + 玻璃光斑 + 产品 logo/文案),
//   截图成 PNG 后经内置 PNG 解码器(第 9/10 章 zlib inflate + 逐行反滤波)转成 24bpp BMP
//  (NSIS 只认无 alpha 的 BMP), 落到 build/ 供 package.json 的 nsis 配置引用。
// 用法: node scripts/gen-nsis-art.cjs  (改画稿后重跑即可再生成)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const { chromium } = require('playwright');
const Fs = require('fs');
const Path = require('path');
const Zlib = require('zlib');

const ROOT = Path.resolve(__dirname, '..');
const LOGO_URI = 'data:image/png;base64,' + Fs.readFileSync(Path.join(ROOT, 'build/iconfntv.png')).toString('base64');

// ── 画稿(lc-1073 液体玻璃 token: 深靛底+流动光斑+磨砂噪点+高光折射边+内发光) ──
const sharedCss = `
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:"Microsoft YaHei","PingFang SC","SF Pro Display",sans-serif; overflow:hidden; }
  .stage { position:relative; overflow:hidden;
    background:
      linear-gradient(160deg,
        #0a0e27 0%,
        #141842 18%,
        #1a1545 35%,
        #251b4a 52%,
        #1e2856 72%,
        #162240 88%,
        #0d152e 100%
      ); }
  /* 流动光斑 — 大面积、高饱和、强模糊，模拟液体折射 */
  .blob { position:absolute; border-radius:50%; filter:blur(3px); }
  .b1 { background:radial-gradient(circle at 30% 30%,
      rgba(99,102,241,.55) 0%, rgba(139,92,246,.40) 35%, rgba(168,85,247,0) 72%);
      width:180px; height:180px; }
  .b2 { background:radial-gradient(circle at 65% 38%,
      rgba(56,189,248,.45) 0%, rgba(34,211,238,.28) 40%, rgba(6,182,212,0) 75%);
      width:160px; height:160px; }
  .b3 { background:radial-gradient(circle at 45% 65%,
      rgba(167,139,250,.38) 0%, rgba(192,132,252,.22) 40%, rgba(216,180,254,0) 72%);
      width:170px; height:170px; }
  .b4 { background:radial-gradient(circle at 75% 75%,
      rgba(99,102,241,.32) 0%, rgba(129,140,248,.16) 45%, rgba(165,180,252,0) 75%);
      width:130px; height:130px; }
  /* 噪点纹理层 — 模拟磨砂玻璃颗粒感 */
  .noise { position:absolute; inset:0; opacity:.055; pointer-events:none;
    background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E");
    background-size:128px 128px; mix-blend-mode:overlay; }
  /* 液体玻璃卡片 */
  .glass { position:absolute; border-radius:16px;
    background:
      linear-gradient(165deg,
        rgba(255,255,255,.22) 0%,
        rgba(255,255,255,.13) 35%,
        rgba(255,255,255,.07) 70%,
        rgba(255,255,255,.04) 100%
      );
    border:1px solid rgba(255,255,255,.20);
    border-top-color:rgba(255,255,255,.42);
    border-left-color:rgba(255,255,255,.30);
    box-shadow:
      0 8px 32px rgba(0,0,0,.28),
      0 2px 8px rgba(0,0,0,.18),
      inset 0 1px 0 rgba(255,255,255,.28),
      inset 0 -1px 0 rgba(0,0,0,.06);
    backdrop-filter:saturate(180%) blur(1px); }
  /* 高光折射条纹 */
  .glass::before { content:''; position:absolute; top:0; left:12%; right:12%; height:1px;
    background:linear-gradient(90deg, transparent, rgba(255,255,255,.55), transparent);
    border-radius:1px; }
  .glass::after { content:''; position:absolute; top:2px; left:22%; right:22%; height:.5px;
    background:linear-gradient(90deg, transparent 20%, rgba(255,255,255,.25) 50%, transparent 80%); }
  .logo { object-fit:contain; filter:brightness(1.02) drop-shadow(0 2px 8px rgba(99,102,241,.25)); }
  .name { font-weight:800; color:#e8ecf7; letter-spacing:.5px;
           text-shadow:0 1px 3px rgba(0,0,0,.35), 0 0 20px rgba(139,92,246,.18); }
  .sub  { font-weight:500; color:rgba(200,208,230,.78);
          text-shadow:0 1px 2px rgba(0,0,0,.25); line-height:1.55; }
  /* 发光 orb — 液态核心 */
  .orb  { border-radius:50%;
    background:linear-gradient(135deg, #6366f1, #8b5cf6, #a78bfa);
    box-shadow:
      0 4px 16px rgba(99,102,241,.50),
      0 0 28px rgba(139,92,246,.30),
      inset 0 1px 0 rgba(255,255,255,.35),
      inset 0 -2px 6px rgba(0,0,0,.15); }
  .badge { font-weight:800; letter-spacing:2.8px;
           text-transform:uppercase;
           text-shadow:0 0 12px currentColor, 0 1px 3px rgba(0,0,0,.4); }
  .tag  { letter-spacing:1.4px; text-transform:uppercase;
          text-shadow:0 1px 2px rgba(0,0,0,.35); }
`;

const sidebarHtml = (uninstall) => `<!doctype html><html><head><meta charset="utf-8"><style>
  ${sharedCss}
  .stage { width:164px; height:314px; }
  .b1 { left:-50px; top:-50px; }
  .b2 { right:-48px; top:56px; }
  .b3 { left:-38px; bottom:36px; }
  .b4 { right:-28px; bottom:-20px; }
  .glass { left:10px; right:10px; top:88px; height:126px; padding:14px 10px;
           display:flex; flex-direction:column; align-items:center; justify-content:center; gap:9px; }
  .logo { width:110px; }
  .name { font-size:13.5px; }
  .sub { font-size:8px; text-align:center; }
  .orb { width:28px; height:28px; position:absolute; right:14px; bottom:20px; }
  .tag { position:absolute; left:0; right:0; bottom:10px; text-align:center;
         font-size:7.5px; color:rgba(160,170,200,.55); }
  .badge { position:absolute; top:30px; left:12px; right:12px; text-align:center;
           font-size:9.5px; color:${uninstall ? '#f87171' : '#818cf8'}; }
</style></head><body>
  <div class="stage">
    <div class="noise"></div>
    <div class="blob b1"></div><div class="blob b2"></div>
    <div class="blob b3"></div><div class="blob b4"></div>
    <div class="badge">${uninstall ? 'UNINSTALL' : 'SETUP'}</div>
    <div class="glass">
      <img class="logo" src="${LOGO_URI}">
      <div class="name">Fntv-Plus</div>
      <div class="sub">飞牛影视 · 第三方增强客户端<br>${uninstall ? '即将从本机移除' : '全新向导 · 一键安装'}</div>
    </div>
    <div class="orb"></div>
    <div class="tag">FNTV-PLUS</div>
  </div>
</body></html>`;

const headerHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
  ${sharedCss}
  .stage { width:150px; height:57px; display:flex; align-items:center; gap:7px; padding:0 8px;
    border-radius:0; }
  .b1 { width:90px; height:90px; left:48px; top:-32px; filter:blur(2.5px); }
  .b3 { width:80px; height:80px; left:-30px; top:4px; filter:blur(2.5px); }
  .logo { height:20px; }
  .name { font-size:10px; }
  .sub { font-size:6.5px; }
</style></head><body>
  <div class="stage">
    <div class="noise"></div>
    <div class="blob b1"></div><div class="blob b3"></div>
    <img class="logo" src="${LOGO_URI}">
    <div><div class="name">Fntv-Plus</div><div class="sub">飞牛影视增强</div></div>
  </div>
</body></html>`;

// [lc-1055] 开场闪屏(AdvSplash 淡入→停留→淡出)：480×300 品牌卡, 安装/卸载双变体
const splashHtml = (uninstall) => `<!doctype html><html><head><meta charset="utf-8"><style>
  ${sharedCss}
  .stage { width:480px; height:300px; }
  .b1 { left:-130px; top:-120px; }
  .b2 { right:-110px; top:36px; }
  .b3 { right:50px; bottom:-170px; }
  .b4 { left:60px; bottom:-90px; }
  .glass { left:56px; right:56px; top:52px; height:192px; padding:24px 22px;
           display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px;
           border-radius:20px; }
  .logo { width:200px; }
  .name { font-size:23px; }
  .sub { font-size:11.5px; text-align:center; line-height:1.65; }
  .badge { position:absolute; top:24px; left:0; right:0; text-align:center;
           font-size:12px; color:${uninstall ? '#f87171' : '#818cf8'}; letter-spacing:5px; }
  .orb { width:46px; height:46px; position:absolute; left:50%; transform:translateX(-50%); bottom:32px; }
  .orb::after { content:''; position:absolute; inset:-10px; border-radius:50%;
                border:1.5px solid rgba(139,92,246,.30); }
  .tag { position:absolute; left:0; right:0; bottom:10px; text-align:center;
         font-size:9px; color:rgba(160,170,200,.50); letter-spacing:3.5px; }
</style></head><body>
  <div class="stage">
    <div class="noise"></div>
    <div class="blob b1"></div><div class="blob b2"></div>
    <div class="blob b3"></div><div class="blob b4"></div>
    <div class="badge">${uninstall ? 'UNINSTALL' : 'SETUP'}</div>
    <div class="glass">
      <img class="logo" src="${LOGO_URI}">
      <div class="name">Fntv-Plus</div>
      <div class="sub">${uninstall ? '即将从本机移除 Fntv-Plus 及其组件<br>你的登录与配置不会丢失' : '飞牛影视 · 第三方增强客户端<br>正在准备安装向导…'}</div>
    </div>
    <div class="orb"></div>
    <div class="tag">FNTV-PLUS</div>
  </div>
</body></html>`;

// [lc-1073] 安装页整页液体玻璃背景：490×327 满铺霜化底, 与侧栏/头图同主题(无文字, 控件浮于其上)
const bgHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
  ${sharedCss}
  .stage { width:490px; height:327px; }
  .b1 { left:-170px; top:-160px; }
  .b2 { right:-160px; top:-70px; }
  .b3 { left:-130px; bottom:-160px; }
  .b4 { right:-110px; bottom:-130px; }
</style></head><body>
  <div class="stage">
    <div class="noise"></div>
    <div class="blob b1"></div><div class="blob b2"></div>
    <div class="blob b3"></div><div class="blob b4"></div>
  </div>
</body></html>`;

// ── PNG(RGBA 8bit 非隔行, Chromium 截图格式) → 24bpp 底向上 BMP ──
function pngToBmp24(png) {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let pos = 8, w = 0, h = 0, depth = 0, colorType = 0;
  const idat = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    if (type === 'IHDR') {
      w = png.readUInt32BE(pos + 8); h = png.readUInt32BE(pos + 12);
      depth = png[pos + 16]; colorType = png[pos + 17] & 0x0f;
      if (depth !== 8 || (colorType !== 6 && colorType !== 2)) throw new Error('unsupported png ' + depth + '/' + colorType);
    } else if (type === 'IDAT') idat.push(png.subarray(pos + 8, pos + 8 + len));
    pos += 12 + len;
  }
  const raw = Zlib.inflateSync(Buffer.concat(idat));
  const bpp = colorType === 6 ? 4 : 3;
  const stride = w * bpp;
  // 逐行反滤波 (0 none / 1 sub / 2 up / 3 avg / 4 paeth)
  const rows = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      cur[x] = v;
    }
    rows.push(cur); prev = cur;
  }
  // 24bpp BGR, 行 4 字节对齐, 底向上
  const rowBytes = Math.ceil((w * 3) / 4) * 4;
  const pixelData = Buffer.alloc(rowBytes * h);
  for (let y = 0; y < h; y++) {
    const srcRow = rows[h - 1 - y]; // bottom-up
    for (let x = 0; x < w; x++) {
      const si = x * bpp;
      const di = y * rowBytes + x * 3;
      pixelData[di] = srcRow[si + 2];
      pixelData[di + 1] = srcRow[si + 1];
      pixelData[di + 2] = srcRow[si];
    }
  }
  const fileSize = 54 + pixelData.length;
  const out = Buffer.alloc(54);
  out.write('BM', 0);
  out.writeUInt32LE(fileSize, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(w, 18);
  out.writeInt32LE(h, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(pixelData.length, 34);
  return Buffer.concat([out, pixelData]);
}

async function renderBmp(page, html, width, height, outFile) {
  await page.setViewportSize({ width, height });
  await page.setContent(html);
  const png = await page.screenshot({ clip: { x: 0, y: 0, width, height } });
  const bmp = pngToBmp24(png);
  Fs.writeFileSync(outFile, bmp);
  console.log('[gen-nsis-art]', Path.basename(outFile), width + 'x' + height, Math.round(bmp.length / 1024) + 'KB');
}

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ deviceScaleFactor: 1 })).newPage();
  const outDir = Path.join(ROOT, 'build');
  await renderBmp(page, sidebarHtml(false), 164, 314, Path.join(outDir, 'installerSidebar.bmp'));
  await renderBmp(page, sidebarHtml(true), 164, 314, Path.join(outDir, 'uninstallerSidebar.bmp'));
  await renderBmp(page, headerHtml, 150, 57, Path.join(outDir, 'installerHeader.bmp'));
  await renderBmp(page, bgHtml, 490, 327, Path.join(outDir, 'installerBackground.bmp'));
  await renderBmp(page, splashHtml(false), 480, 300, Path.join(outDir, 'installerSplash.bmp'));
  await renderBmp(page, splashHtml(true), 480, 300, Path.join(outDir, 'uninstallerSplash.bmp'));
  await browser.close();
  console.log('[gen-nsis-art] done');
})().catch((e) => { console.error(e); process.exit(1); });
