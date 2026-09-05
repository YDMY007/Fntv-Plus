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

// ── 画稿(项目风格 token: 粉紫亚克力渐变 + 玻璃光斑 + 宫灯橙粉渐变点睛) ──
const sharedCss = `
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:"Microsoft YaHei","PingFang SC",sans-serif; overflow:hidden; }
  .stage { position:relative; overflow:hidden;
    background:linear-gradient(165deg,#f7f9fd 0%,#eef1fa 52%,#e3e9f6 100%); }
  .blob { position:absolute; border-radius:50%; filter:blur(2px); }
  .b1 { background:radial-gradient(circle at 35% 35%, rgba(150,120,200,.42), rgba(150,120,200,0) 70%); }
  .b2 { background:radial-gradient(circle at 60% 40%, rgba(148,196,236,.36), rgba(148,196,236,0) 70%); }
  .b3 { background:radial-gradient(circle at 50% 45%, rgba(186,222,206,.30), rgba(186,222,206,0) 70%); }
  .glass { position:absolute; border-radius:14px;
    background:linear-gradient(165deg, rgba(255,255,255,.62), rgba(255,255,255,.28));
    border:1px solid rgba(255,255,255,.65);
    box-shadow:0 10px 28px rgba(91,60,160,.16), inset 0 1px 0 rgba(255,255,255,.9); }
  .logo { object-fit:contain; }
  .name { font-weight:800; color:#2f3550; letter-spacing:.4px; }
  .sub  { font-weight:600; color:#5a6480; }
  .orb  { border-radius:50%; background:linear-gradient(135deg,#6d7ff2,#8a63e8);
          box-shadow:0 6px 18px rgba(109,127,242,.38), inset 0 1px 0 rgba(255,255,255,.5); }
`;

const sidebarHtml = (uninstall) => `<!doctype html><html><head><meta charset="utf-8"><style>
  ${sharedCss}
  .stage { width:164px; height:314px; }
  .b1 { width:150px; height:150px; left:-42px; top:-36px; }
  .b2 { width:130px; height:130px; right:-40px; top:64px; }
  .b3 { width:150px; height:150px; left:-30px; bottom:44px; }
  .glass { left:12px; right:12px; top:96px; height:118px; padding:14px 10px;
           display:flex; flex-direction:column; align-items:center; justify-content:center; gap:9px; }
  .logo { width:118px; }
  .name { font-size:14px; }
  .sub { font-size:8.5px; text-align:center; line-height:1.5; }
  .orb { width:30px; height:30px; position:absolute; right:16px; bottom:22px; }
  .tag { position:absolute; left:0; right:0; bottom:12px; text-align:center;
         font-size:8.5px; color:#8a93ad; letter-spacing:1.2px; }
  .badge { position:absolute; top:34px; left:14px; right:14px; text-align:center;
           font-size:10.5px; font-weight:800; color:${uninstall ? '#b3564d' : '#4a5fd0'}; letter-spacing:2.5px; }
</style></head><body>
  <div class="stage">
    <div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>
    <div class="badge">${uninstall ? 'UNINSTALL' : 'SETUP WIZARD'}</div>
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
  .stage { width:150px; height:57px; display:flex; align-items:center; gap:7px; padding:0 8px; }
  .b1 { width:90px; height:90px; left:52px; top:-30px; }
  .b3 { width:90px; height:90px; left:-34px; top:6px; }
  .logo { height:20px; }
  .name { font-size:10px; }
  .sub { font-size:7px; }
</style></head><body>
  <div class="stage">
    <div class="blob b1"></div><div class="blob b3"></div>
    <img class="logo" src="${LOGO_URI}">
    <div><div class="name">Fntv-Plus</div><div class="sub">飞牛影视增强</div></div>
  </div>
</body></html>`;

// [lc-1055] 开场闪屏(AdvSplash 淡入→停留→淡出)：480×300 品牌卡, 安装/卸载双变体
const splashHtml = (uninstall) => `<!doctype html><html><head><meta charset="utf-8"><style>
  ${sharedCss}
  .stage { width:480px; height:300px; }
  .b1 { width:420px; height:420px; left:-120px; top:-110px; }
  .b2 { width:360px; height:360px; right:-100px; top:40px; }
  .b3 { width:400px; height:400px; right:60px; bottom:-160px; }
  .glass { left:60px; right:60px; top:56px; height:188px; padding:22px 20px;
           display:flex; flex-direction:column; align-items:center; justify-content:center; gap:13px; }
  .logo { width:210px; }
  .name { font-size:21px; }
  .sub { font-size:11.5px; text-align:center; line-height:1.6; }
  .badge { position:absolute; top:26px; left:0; right:0; text-align:center;
           font-size:12px; font-weight:800; color:${uninstall ? '#b3564d' : '#4a5fd0'}; letter-spacing:4px; }
  .orb { width:44px; height:44px; position:absolute; left:50%; transform:translateX(-50%); bottom:34px; }
  .orb::after { content:''; position:absolute; inset:-9px; border-radius:50%;
                border:1.5px solid rgba(109,127,242,.35); border-radius:50%; }
  .tag { position:absolute; left:0; right:0; bottom:12px; text-align:center;
         font-size:9px; color:#8a93ad; letter-spacing:3px; }
</style></head><body>
  <div class="stage">
    <div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>
    <div class="badge">${uninstall ? 'UNINSTALL WIZARD' : 'SETUP WIZARD'}</div>
    <div class="glass">
      <img class="logo" src="${LOGO_URI}">
      <div class="name">Fntv-Plus</div>
      <div class="sub">${uninstall ? '即将从本机移除 Fntv-Plus 及其组件<br>你的登录与配置不会丢失' : '飞牛影视 · 第三方增强客户端<br>正在准备安装向导…'}</div>
    </div>
    <div class="orb"></div>
    <div class="tag">FNTV-PLUS</div>
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
  await renderBmp(page, splashHtml(false), 480, 300, Path.join(outDir, 'installerSplash.bmp'));
  await renderBmp(page, splashHtml(true), 480, 300, Path.join(outDir, 'uninstallerSplash.bmp'));
  await browser.close();
  console.log('[gen-nsis-art] done');
})().catch((e) => { console.error(e); process.exit(1); });
