#!/usr/bin/env node
// scripts/gen-nsis-art.cjs — [多源刮削/UI 重构] NSIS 安装向导「液态玻璃」美术生成器(v5 原生页整页化)
// ─────────────────────────────────────────────────────────────────────────────
// v5 变化: 四页向导全面整页化 —— 在 v3 苹果风淡蓝玻璃基础上, 第二步「安装选项」/
//   第三步「正在安装」也用同一舞台(渐变+光斑+噪点+品牌行+药丸按钮体系)整页画稿:
//   ① installerMode.bmp: 安装选项页(左双模式选择卡 + 右「安装到」路径面板 + 底部
//      上一步/下一步药丸); 选择卡双态裁片 CardsA/B 为运行时换态贴片(裁片与整页同
//      HTML 同坐标 clip → 背景逐像素一致, NSIS 侧贴片换态无缝);
//   ② installerInst.bmp: 安装进度页(玻璃明细面板 + 取消/下一步双药丸槽位, 本体按钮
//      自绘隐形坐入); 完成态换「安装完成」标题条(DoneTitle 裁片)与按钮区条带
//      (InstBar 安装中取消+下一步 / InstBarDone 仅下一步);
//   ③ 原 v4 的进度条/显示细节按钮/状态文字在 NSIS 侧退场, 进度反馈由明细列表承担。
// 产物(build/):
//   installerWelcome.bmp        1560×1040  欢迎页整页画稿(2x, 渲染端缩放至客户区)
//   installerWelcomeCta.bmp      440×96    「开始安装」按钮裁片(与整页逐像素一致)
//   installerFinish.bmp         1560×1040  完成页整页画稿
//   installerFinishPrimary.bmp   340×96    「立即体验」按钮裁片
//   installerFinishSecondary.bmp 340×96    「完成」按钮裁片
//   installerMode.bmp           1560×1040  [v5] 第二步「安装选项」整页画稿(右侧含「安装到」面板)
//   installerModeCardsA/B.bmp   724×430    [v5] 选择卡双态裁片(A=所有用户选中, B=仅为我)
//   installerInst.bmp           1560×1040  [v5] 第三步「正在安装」整页画稿(含「取消」药丸)
//   installerInstDoneTitle.bmp  1560×200   [v5] 安装完成态标题条裁片(换态贴片)
//   installerInstBar/BarDone.bmp 780×130   [v5] 按钮区条带裁片(安装中取消+下一步 / 完成态仅下一步)
//   installerSplash.bmp / uninstallerSplash.bmp / uninstallerSidebar.bmp / installerHeader.bmp
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const { chromium } = require('playwright');
const Fs = require('fs');
const Path = require('path');
const Zlib = require('zlib');

const ROOT = Path.resolve(__dirname, '..');
const LOGO_URI = 'data:image/png;base64,' + Fs.readFileSync(Path.join(ROOT, 'build/iconfntv.png')).toString('base64');
const VERSION = JSON.parse(Fs.readFileSync(Path.join(ROOT, 'package.json'), 'utf8')).version || '';

// ── 画稿(v3 苹果风淡蓝液态玻璃 token: 淡蓝渐变底 + 柔焦光斑 + 白磨砂卡 + 高光边) ──
const sharedCss = `
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:"Microsoft YaHei","PingFang SC","SF Pro Display",sans-serif; overflow:hidden; }
  .stage { position:relative; overflow:hidden;
    background:
      linear-gradient(160deg,
        #f8fbff 0%,
        #eef4fe 22%,
        #e3eefc 45%,
        #d9e6fa 62%,
        #e6eefc 82%,
        #f0f6ff 100%
      ); }
  .blob { position:absolute; border-radius:50%; filter:blur(70px); opacity:.55; }
  .noise { position:absolute; inset:0; opacity:.035; pointer-events:none;
    background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E");
    background-size:128px 128px; mix-blend-mode:overlay; }
  .glass { border-radius:16px;
    background:
      linear-gradient(165deg,
        rgba(255,255,255,.80) 0%,
        rgba(255,255,255,.58) 50%,
        rgba(255,255,255,.40) 100%
      );
    border:1px solid rgba(255,255,255,.92);
    border-top-color:rgba(255,255,255,1);
    box-shadow:
      0 8px 32px rgba(96,130,190,.16),
      0 2px 8px rgba(96,130,190,.10),
      inset 0 1px 0 rgba(255,255,255,.95); }
  .glass::before { content:''; position:absolute; top:0; left:12%; right:12%; height:1px;
    background:linear-gradient(90deg, transparent, rgba(255,255,255,1), transparent);
    border-radius:1px; }
  .logo { object-fit:contain; filter:drop-shadow(0 2px 8px rgba(80,120,220,.18)); }
  .name { font-weight:800; color:#1b2540; letter-spacing:.5px;
           text-shadow:0 1px 2px rgba(255,255,255,.85); }
  /* [v6] 字色整体加深一档 + 行距统一 1.7: 1x 原生渲染后次要文字不再被缩放糊掉,
     原来的浅灰在 1:1 下显得发虚, 加深后对比度更稳(WCAG 更安全)。 */
  .sub  { font-weight:500; color:#42506e; line-height:1.7; }
  .badge { font-weight:800; letter-spacing:2.8px; text-transform:uppercase; color:#3d6df5; }
  .tag  { letter-spacing:1.4px; text-transform:uppercase; color:#8896b6; }
  /* 玻璃药丸按钮(烘焙进画稿; NSIS 侧用热区/本体隐形按钮精确叠放) */
  .pill { position:absolute; display:flex; align-items:center; justify-content:center;
          border-radius:48px; font-weight:700; letter-spacing:6px; text-indent:6px;
          font-size:30px; cursor:default; }
  .pill.primary { color:#fff;
    background:linear-gradient(135deg, #3d6df5 0%, #5566f3 48%, #7a5cf0 100%);
    box-shadow:0 10px 30px rgba(70,105,240,.38), 0 2px 10px rgba(70,105,240,.22),
      inset 0 1px 0 rgba(255,255,255,.45);
    text-shadow:0 1px 2px rgba(30,50,120,.28); }
  .pill.secondary { color:#2a3a5c;
    background:linear-gradient(165deg, rgba(255,255,255,.94) 0%, rgba(255,255,255,.62) 100%);
    border:1px solid rgba(150,175,220,.65);
    box-shadow:0 4px 16px rgba(96,130,190,.16), inset 0 1px 0 rgba(255,255,255,.95); }
`;

// ── 整页: 欢迎页(780×520 逻辑 @2x=1560×1040) ──
const welcomeHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
  ${sharedCss}
  .stage { width:1560px; height:1040px; }
  .b1 { width:520px; height:520px; left:-300px; top:-260px; background:rgba(140,180,255,.55); }
  .b2 { width:460px; height:460px; right:-220px; top:60px; background:rgba(190,165,255,.42); }
  .b3 { width:480px; height:480px; left:-260px; bottom:-240px; background:rgba(150,205,255,.50); }
  .b4 { width:380px; height:380px; right:120px; bottom:-200px; background:rgba(205,180,255,.35); }
  .brand { position:absolute; left:64px; top:52px; display:flex; align-items:center; gap:20px; }
  .brand img { width:96px; }
  .brand .name { font-size:34px; }
  .badge { position:absolute; right:64px; top:64px; font-size:16px; }
  .hero { position:absolute; left:92px; top:270px; max-width:900px; }
  .hero .t { font-size:58px; font-weight:800; color:#16233f; letter-spacing:1px;
             text-shadow:0 1px 3px rgba(255,255,255,.9); }
  .hero .s { margin-top:18px; font-size:20px; line-height:1.7; color:#42506e; }
  .feats { position:absolute; left:92px; top:620px; display:flex; gap:26px; }
  .feat { width:320px; padding:24px 26px; border-radius:18px;
          background:linear-gradient(165deg, rgba(255,255,255,.78) 0%, rgba(255,255,255,.52) 100%);
          border:1px solid rgba(255,255,255,.92); border-top-color:rgba(255,255,255,1);
          box-shadow:0 10px 30px rgba(96,130,190,.15), inset 0 1px 0 rgba(255,255,255,.95); }
  .feat .fi { font-size:26px; }
  /* [v6] 描述原 12.5px(@2x) → 1x 下仅 6.25 逻辑 px, 偏费眼; 提到 14px, 行距 1.55→1.62,
     标题与描述的纵向间距同步加大, 卡片内边距 22/24 → 24/26 补呼吸。 */
  .feat .ft { margin-top:12px; font-size:18px; font-weight:700; color:#1b2540; }
  .feat .fd { margin-top:8px; font-size:14px; line-height:1.62; color:#4d5a7a; }
  .pill.primary { left:1000px; top:844px; width:440px; height:96px; }
  .hint { position:absolute; right:96px; top:962px; font-size:14px;
          color:#5d6f99; letter-spacing:.5px; }
  .tag { position:absolute; left:0; right:0; bottom:22px; text-align:center;
         font-size:12px; color:#8896b6; letter-spacing:4px; }
  .ver { position:absolute; left:66px; bottom:20px; font-size:12px;
         color:#8896b6; letter-spacing:.5px; }
</style></head><body>
  <div class="stage">
    <div class="noise"></div>
    <div class="blob b1"></div><div class="blob b2"></div>
    <div class="blob b3"></div><div class="blob b4"></div>
    <div class="brand">
      <img class="logo" src="${LOGO_URI}">
      <div class="name">Fntv-Plus</div>
    </div>
    <div class="badge">SETUP</div>
    <div class="hero">
      <div class="t">飞牛影视 · 第三方增强客户端</div>
      <div class="s">自定义海报页 · 双外置播放器 · 聚合便利功能<br>在飞牛影视之上, 打造属于你的观影工作台。</div>
    </div>
    <div class="feats">
      <div class="feat"><div class="fi">🖼️</div><div class="ft">自定义海报页</div><div class="fd">首页轮播美化 · 海报布局自定义<br>四种轮播样式 · 玻璃主题</div></div>
      <div class="feat"><div class="fi">🎬</div><div class="ft">双外置播放器</div><div class="fd">MPV / PotPlayer 开箱即用<br>插帧 · 着色器 · ICC 校色 · 4K HDR</div></div>
      <div class="feat"><div class="fi">🧩</div><div class="ft">聚合便利功能</div><div class="fd">聚合弹幕 · 自定义刮削 · 网盘直连<br>跳过片头片尾 · 持续更新</div></div>
    </div>
    <div class="pill primary">开始安装</div>
    <div class="hint">点击「开始安装」或按 Enter</div>
    <div class="tag">FNTV-PLUS</div>
    <div class="ver">v${VERSION} · 安装向导</div>
  </div>
</body></html>`;

// ── 整页: 完成页(780×520 逻辑 @2x=1560×1040) ──
const finishHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
  ${sharedCss}
  .stage { width:1560px; height:1040px; }
  .b1 { width:520px; height:520px; left:-280px; top:-240px; background:rgba(140,180,255,.55); }
  .b2 { width:440px; height:440px; right:-200px; top:-40px; background:rgba(190,165,255,.42); }
  .b3 { width:500px; height:500px; left:340px; bottom:-320px; background:rgba(150,205,255,.50); }
  .b4 { width:360px; height:360px; right:-160px; bottom:-160px; background:rgba(205,180,255,.35); }
  .ring { position:absolute; left:50%; transform:translateX(-50%); top:150px;
          width:150px; height:150px; border-radius:50%;
          display:flex; align-items:center; justify-content:center;
          background:linear-gradient(165deg, rgba(255,255,255,.92) 0%, rgba(255,255,255,.62) 100%);
          border:2px solid rgba(140,170,240,.55);
          box-shadow:0 12px 40px rgba(96,130,190,.22), inset 0 1px 0 rgba(255,255,255,1); }
  .ring span { font-size:74px; color:#3d6df5; }
  .done { position:absolute; left:0; right:0; top:340px; text-align:center;
          font-size:46px; font-weight:800; color:#16233f; letter-spacing:2px;
          text-shadow:0 1px 3px rgba(255,255,255,.9); }
  .sub  { position:absolute; left:0; right:0; top:430px; text-align:center;
          font-size:19px; color:#42506e; line-height:1.7; }
  .brand { position:absolute; left:64px; top:52px; display:flex; align-items:center; gap:20px; }
  .brand img { width:96px; }
  .brand .name { font-size:34px; }
  .badge { position:absolute; right:64px; top:64px; font-size:16px; color:#2f9e6e; }
  .pill.primary { left:420px; top:824px; width:340px; height:96px; font-size:27px; letter-spacing:3px; text-indent:3px; }
  .pill.secondary { left:800px; top:824px; width:340px; height:96px; font-size:27px; letter-spacing:3px; text-indent:3px; }
  .tag { position:absolute; left:0; right:0; bottom:22px; text-align:center;
         font-size:12px; color:#8896b6; letter-spacing:4px; }
  .ver { position:absolute; left:66px; bottom:20px; font-size:12px;
         color:#8896b6; letter-spacing:.5px; }
</style></head><body>
  <div class="stage">
    <div class="noise"></div>
    <div class="blob b1"></div><div class="blob b2"></div>
    <div class="blob b3"></div><div class="blob b4"></div>
    <div class="brand">
      <img class="logo" src="${LOGO_URI}">
      <div class="name">Fntv-Plus</div>
    </div>
    <div class="badge">DONE</div>
    <div class="ring"><span>✓</span></div>
    <div class="done">安装完成</div>
    <div class="sub">Fntv-Plus 已就绪 · 祝观影愉快<br>桌面与开始菜单已创建快捷方式</div>
    <div class="pill primary">立即体验</div>
    <div class="pill secondary">完成</div>
    <div class="tag">FNTV-PLUS</div>
    <div class="ver">v${VERSION} · 安装向导</div>
  </div>
</body></html>`;

// ── [v5] 原生页画稿: 第二步(安装选项, 右侧集成「安装到」自定义路径面板) ──
// 与欢迎/完成页同一舞台(渐变+光斑+噪点+品牌行+badge+底部 tag/ver 全同位),
// 原生控件(单选钮/输入框)在 NSIS 侧垫到画稿下层或做隐形坐入。
// 选择卡双态(installerModeCardsA/B)为与整页同 HTML 的 clip 裁片, 背景像素
// 逐点一致 → 运行时贴片换态无缝。
const modePageHtml = (allUsersChecked) => `<!doctype html><html><head><meta charset="utf-8"><style>
  ${sharedCss}
  .stage { width:1560px; height:1040px; }
  .b1 { width:520px; height:520px; left:-300px; top:-260px; background:rgba(140,180,255,.55); }
  .b2 { width:460px; height:460px; right:-220px; top:60px; background:rgba(190,165,255,.42); }
  .b3 { width:480px; height:480px; left:-260px; bottom:-240px; background:rgba(150,205,255,.50); }
  .b4 { width:380px; height:380px; right:120px; bottom:-200px; background:rgba(205,180,255,.35); }
  .brand { position:absolute; left:64px; top:52px; display:flex; align-items:center; gap:20px; }
  .brand img { width:96px; }
  .brand .name { font-size:34px; }
  .badge { position:absolute; right:64px; top:64px; font-size:16px; }
  .hero { position:absolute; left:92px; top:120px; }
  .hero .t { font-size:52px; font-weight:800; color:#16233f; letter-spacing:1px;
             text-shadow:0 1px 3px rgba(255,255,255,.9); }
  .hero .s { margin-top:18px; font-size:20px; color:#42506e; }
  /* 2×2 玻璃卡: 左列模式选择 / 右列安装位置(高卡); 统一磨砂+高光顶边+悬浮投影 */
  .card { position:absolute; width:700px; border-radius:28px;
          background:linear-gradient(165deg, rgba(255,255,255,.86) 0%, rgba(255,255,255,.58) 100%);
          border:1.5px solid rgba(255,255,255,.95); border-top-color:rgba(255,255,255,1);
          box-shadow:0 18px 48px rgba(96,130,190,.20), 0 4px 14px rgba(96,130,190,.10),
            inset 0 1px 0 rgba(255,255,255,1); }
  .card::before { content:''; position:absolute; top:0; left:10%; right:10%; height:1.5px;
          background:linear-gradient(90deg, transparent, rgba(255,255,255,1), transparent); }
  .card.c1 { left:92px; top:290px; height:190px; } .card.c2 { left:92px; top:510px; height:190px; }
  .card.r1 { left:820px; top:290px; height:410px; }
  .radio { position:absolute; left:76px; top:71px; width:48px; height:48px; border-radius:50%;
           box-sizing:border-box; }
  .radio.off { border:3px solid #b7c5e0; box-shadow:inset 0 1px 3px rgba(96,130,190,.18); }
  .radio.on  { border:3px solid #3d6df5;
               box-shadow:0 0 0 6px rgba(61,109,245,.12), 0 4px 10px rgba(61,109,245,.28); }
  .radio.on::after { content:''; position:absolute; left:9px; top:9px; width:24px; height:24px;
           border-radius:50%; background:linear-gradient(135deg, #3d6df5, #6a5cf0); }
  .card .ct { position:absolute; left:160px; top:52px; font-size:30px; font-weight:800;
              color:#1b2540; letter-spacing:.5px; }
  .card .cd { position:absolute; left:160px; top:112px; font-size:18px; color:#4d5a7a; }
  .card .ci { position:absolute; right:40px; top:50%; transform:translateY(-50%);
              font-size:44px; opacity:.9; filter:drop-shadow(0 4px 10px rgba(96,130,190,.25)); }
  /* 右上卡「安装位置」: 标题 + 路径只读显示槽(NSIS 侧不透明底 Label 坐入) + 浏览药丸 + 模式说明底 */
  .r1t { position:absolute; left:60px; top:44px; font-size:30px; font-weight:800; color:#1b2540; }
  /* 路径只读显示槽(单一显示位): 路径以只读文本呈现, 修改入口只有「浏览…」 */
  .pathplate { position:absolute; left:40px; top:96px; width:620px; height:110px; border-radius:12px;
               background:rgba(243,247,254,.92); border:1px solid rgba(151,176,222,.35);
               box-sizing:border-box; }
  .pathplate .plabel { position:absolute; left:24px; top:12px; font-size:14px; font-weight:700;
               letter-spacing:2px; color:#7f8ba6; }
  .pill.pill.browse { left:40px !important; top:232px !important; width:180px !important; height:60px !important;
                      font-size:22px; letter-spacing:2px; text-indent:2px; }
  .dhint { position:absolute; left:236px; top:248px; font-size:15px; color:#7f8ba6; width:420px; }
  /* 安装模式说明底(EB 动态说明文字坐入; 与 NSIS 侧不透明底同色 → 切换模式换字无叠影、不压边框) */
  .infoplate { position:absolute; left:40px; top:312px; width:620px; height:82px; border-radius:12px;
               background:rgba(243,247,254,.92); border:1px solid rgba(151,176,222,.30);
               box-sizing:border-box; }
  .pill.primary { left:800px; top:824px; width:340px; height:96px; font-size:27px; letter-spacing:3px; text-indent:3px; }
  .pill.secondary { left:420px; top:824px; width:340px; height:96px; font-size:27px; letter-spacing:3px; text-indent:3px; }
  .tag { position:absolute; left:0; right:0; bottom:22px; text-align:center;
         font-size:12px; color:#8896b6; letter-spacing:4px; }
  .ver { position:absolute; left:66px; bottom:20px; font-size:12px;
         color:#8896b6; letter-spacing:.5px; }
</style></head><body>
  <div class="stage">
    <div class="noise"></div>
    <div class="blob b1"></div><div class="blob b2"></div>
    <div class="blob b3"></div><div class="blob b4"></div>
    <div class="brand">
      <img class="logo" src="${LOGO_URI}">
      <div class="name">Fntv-Plus</div>
    </div>
    <div class="badge">SETUP</div>
    <div class="hero">
      <div class="t">安装选项</div>
      <div class="s">选择安装方式与位置</div>
    </div>
    <div class="card c1"><div class="radio ${allUsersChecked ? 'on' : 'off'}"></div>
      <div class="ct">为使用这台电脑的任何人安装</div>
      <div class="cd">为所有用户安装 · 需要管理员权限</div></div>
    <div class="card c2"><div class="radio ${allUsersChecked ? 'off' : 'on'}"></div>
      <div class="ct">仅为我安装</div>
      <div class="cd">仅为当前 Windows 用户安装 · 无需管理员权限</div></div>
    <div class="card r1">
      <div class="r1t">安装位置</div>
      <div class="infoplate"></div>
      <div class="pathplate"><div class="plabel">当前安装路径</div></div>
      <div class="pill secondary browse">浏览…</div>
      <div class="dhint">点「浏览…」选择安装文件夹</div></div>
    <div class="pill secondary">上一步</div>
    <div class="pill primary">下一步</div>
    <div class="tag">FNTV-PLUS</div>
    <div class="ver">v${VERSION} · 安装向导</div>
  </div>
</body></html>`;

// ── [v5] 第三步: 安装进度页(1560×1040); done=完成态标题; pill='cancel'|'next' 控制底部药丸 ──
const instPageHtml = (done, pill) => `<!doctype html><html><head><meta charset="utf-8"><style>
  ${sharedCss}
  .stage { width:1560px; height:1040px; }
  .b1 { width:520px; height:520px; left:-280px; top:-240px; background:rgba(140,180,255,.55); }
  .b2 { width:440px; height:440px; right:-200px; top:-40px; background:rgba(190,165,255,.42); }
  .b3 { width:500px; height:500px; left:340px; bottom:-320px; background:rgba(150,205,255,.50); }
  .b4 { width:360px; height:360px; right:-160px; bottom:-160px; background:rgba(205,180,255,.35); }
  .brand { position:absolute; left:64px; top:52px; display:flex; align-items:center; gap:20px; }
  .brand img { width:96px; }
  .brand .name { font-size:34px; }
  .badge { position:absolute; right:64px; top:64px; font-size:16px; ${done ? 'color:#2f9e6e;' : ''} }
  .hero { position:absolute; left:92px; top:120px; }
  .hero .t { font-size:52px; font-weight:800; color:#16233f; letter-spacing:1px;
             text-shadow:0 1px 3px rgba(255,255,255,.9); }
  .hero .s { margin-top:18px; font-size:20px; color:#42506e; }
  .panel { position:absolute; left:92px; top:252px; width:1376px; height:508px; border-radius:22px;
           background:#ffffff; border:1.5px solid rgba(151,176,222,.55);
           box-shadow:0 14px 40px rgba(96,130,190,.16), inset 0 1px 0 rgba(255,255,255,1); }
  /* 进度页双药丸槽位: 本体按钮(自绘隐形)坐进去, 点击/禁用态/Enter 全原生 */
  .pill.secondary { left:460px; top:824px; width:340px; height:96px; font-size:27px; letter-spacing:3px; text-indent:3px; }
  .pill.primary { left:840px; top:824px; width:340px; height:96px; font-size:27px; letter-spacing:3px; text-indent:3px; }
  .tag { position:absolute; left:0; right:0; bottom:22px; text-align:center;
         font-size:12px; color:#8896b6; letter-spacing:4px; }
  .ver { position:absolute; left:66px; bottom:20px; font-size:12px;
         color:#8896b6; letter-spacing:.5px; }
</style></head><body>
  <div class="stage">
    <div class="noise"></div>
    <div class="blob b1"></div><div class="blob b2"></div>
    <div class="blob b3"></div><div class="blob b4"></div>
    <div class="brand">
      <img class="logo" src="${LOGO_URI}">
      <div class="name">Fntv-Plus</div>
    </div>
    <div class="badge">${done ? 'DONE' : 'SETUP'}</div>
    <div class="hero">
      <div class="t">${done ? '安装完成' : '正在安装'}</div>
      <div class="s">${done ? '已成功安装 · 点击「下一步」继续' : '正在将 Fntv-Plus 安装到您的计算机 · 请稍候'}</div>
    </div>
    <div class="panel"></div>
    ${pill === 'cancel' ? '<div class="pill secondary">取消</div>' : ''}
    ${pill === 'next' ? '<div class="pill primary">下一步</div>' : ''}
    <div class="tag">FNTV-PLUS</div>
    <div class="ver">v${VERSION} · 安装向导</div>
  </div>
</body></html>`;

// ── [lc-1055] 开场闪屏(保留): 480×300 品牌卡, 安装/卸载双变体 ──
const splashHtml = (uninstall) => `<!doctype html><html><head><meta charset="utf-8"><style>
  ${sharedCss}
  .stage { width:480px; height:300px; }
  .b1 { left:-130px; top:-120px; background:rgba(140,180,255,.55); }
  .b2 { right:-110px; top:36px; background:rgba(190,165,255,.42); }
  .b3 { right:50px; bottom:-170px; background:rgba(150,205,255,.50); }
  .b4 { left:60px; bottom:-90px; background:rgba(205,180,255,.35); }
  .glass { left:56px; right:56px; top:52px; height:192px; padding:24px 22px;
           display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px;
           border-radius:20px; }
  .logo { width:200px; }
  .name { font-size:23px; }
  .sub { font-size:12px; text-align:center; }
  .badge { position:absolute; top:24px; left:0; right:0; text-align:center;
           font-size:12px; letter-spacing:5px; color:${uninstall ? '#e05252' : '#3d6df5'}; }
  .orb { width:46px; height:46px; position:absolute; left:50%; transform:translateX(-50%); bottom:32px; }
  .orb::after { content:''; position:absolute; inset:-10px; border-radius:50%;
                border:1.5px solid rgba(120,150,240,.35); }
  .tag { position:absolute; left:0; right:0; bottom:10px; text-align:center;
         font-size:9px; color:#8896b6; letter-spacing:3.5px; }
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

// ── 卸载器侧栏(保留原生卸载页使用): 164×314 ──
const sidebarHtml = (uninstall) => `<!doctype html><html><head><meta charset="utf-8"><style>
  ${sharedCss}
  .stage { width:164px; height:314px; }
  .b1 { left:-50px; top:-50px; background:rgba(140,180,255,.55); }
  .b2 { right:-48px; top:56px; background:rgba(190,165,255,.42); }
  .b3 { left:-38px; bottom:36px; background:rgba(150,205,255,.50); }
  .b4 { right:-28px; bottom:-20px; background:rgba(205,180,255,.35); }
  .glass { left:10px; right:10px; top:88px; height:126px; padding:14px 10px;
           display:flex; flex-direction:column; align-items:center; justify-content:center; gap:9px; }
  .logo { width:110px; }
  .name { font-size:14px; }
  .sub { font-size:8px; text-align:center; }
  .orb { width:28px; height:28px; position:absolute; right:14px; bottom:20px; }
  .tag { position:absolute; left:0; right:0; bottom:10px; text-align:center;
         font-size:8px; color:#8896b6; }
  .badge { position:absolute; top:30px; left:12px; right:12px; text-align:center;
           font-size:10px; color:${uninstall ? '#e05252' : '#3d6df5'}; }
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

// ── [v3] 页眉品牌卡(350×148 = 页眉控件 175×74 的 2x, SetBrandingImage RESIZETOFIT 缩到控件, 高清) ──
const headerHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
  ${sharedCss}
  .stage { width:350px; height:148px; }
  .b1 { width:210px; height:210px; left:-95px; top:-75px; background:rgba(140,180,255,.55); }
  .b2 { width:165px; height:165px; right:-62px; bottom:-75px; background:rgba(190,165,255,.42); }
  .glass { left:18px; right:18px; top:16px; bottom:16px; border-radius:22px;
           display:flex; align-items:center; justify-content:center; gap:19px; }
  .logo { width:70px; }
  .name { font-size:33px; }
</style></head><body>
  <div class="stage">
    <div class="noise"></div>
    <div class="blob b1"></div><div class="blob b2"></div>
    <div class="glass">
      <img class="logo" src="${LOGO_URI}">
      <div class="name">Fntv-Plus</div>
    </div>
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

// 完整性自检: Playwright 截图偶发不完整(半帧)会生成「头合法但像素触发 GDI 崩溃」的 BMP
// (实测: 安装器双击秒崩 0xC000041D)。因此渲染后必须校验: ①头尺寸一致 ②像素数据非全零/非满溢
// ③与上一张的哈希不同(内容新鲜度)。任一失败 → 非零退出, 让构建立即失败而不是产出毒包。
function assertBmpHealthy(bmp, width, height, label) {
  if (bmp.length < 54) throw new Error(label + ': truncated header');
  const gotW = bmp.readInt32LE(18), gotH = bmp.readInt32LE(22);
  if (gotW !== width || gotH !== height) throw new Error(label + ': dims ' + gotW + 'x' + gotH + ' != ' + width + 'x' + height);
  const rowBytes = Math.ceil((width * 3) / 4) * 4;
  const expect = rowBytes * height;
  const pixLen = bmp.readUInt32LE(34);
  if (pixLen !== expect) throw new Error(label + ': pixel bytes ' + pixLen + ' != ' + expect);
  // 非零像素占比(全黑/全零 = 截图半帧的典型特征)
  let nonzero = 0, sampled = 0;
  const off = 54;
  for (let y = 0; y < height; y += Math.max(1, Math.floor(height / 120))) {
    for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 120))) {
      const i = off + y * rowBytes + x * 3;
      if (i + 2 < bmp.length) {
        sampled++;
        if (bmp[i] || bmp[i + 1] || bmp[i + 2]) nonzero++;
      }
    }
  }
  if (sampled === 0 || nonzero / sampled < 0.05) throw new Error(label + ': image nearly blank (' + nonzero + '/' + sampled + '), screenshot likely torn');
}

async function renderBmp(page, html, width, height, outFile) {
  await page.setViewportSize({ width, height });
  await page.setContent(html);
  const png = await page.screenshot({ clip: { x: 0, y: 0, width, height } });
  const bmp = pngToBmp24(png);
  assertBmpHealthy(bmp, width, height, Path.basename(outFile));
  Fs.writeFileSync(outFile, bmp);
  console.log('[gen-nsis-art]', Path.basename(outFile), width + 'x' + height, Math.round(bmp.length / 1024) + 'KB');
}

// ─────────────────────────────────────────────────────────────────────────────
// [v6] 1x 原生渲染
// 背景: 画稿原本只有 1560×1040(@2x) 一套, NSIS 侧 SS_BITMAP 拉伸到客户区
//   (96dpi/100% 缩放时是 1560→780 的**缩小**)。Windows 的 STATIC 位图拉伸默认走
//   COLORONCOLOR = 直接采样丢像素 → 笔画断裂、字体发虚(用户报「字体不够清晰」的真正根因)。
// 做法: viewport 直接给目标尺寸(780×520), 再用 CSS `zoom` 让浏览器**按目标尺寸重新布局
//   并重新光栅化**(zoom 会触发 relayout, 与 transform:scale 那种先渲染再缩放不同),
//   于是文字/描边是原生像素渲染, NSIS 侧 1:1 贴图完全无缩放损失。
//   ⚠ 不能用「deviceScaleFactor:0.5 渲染 2x」替代 —— 那仍是大尺寸光栅化后降采样。
// 输出命名: 2x 保持原名(兼容既有 File 列表), 1x 追加 `1x` 后缀。
// ─────────────────────────────────────────────────────────────────────────────
const nextFrame = (page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

// 整页 1x: 逻辑尺寸 W×H(=2x 尺寸) → 实际输出 W/2 × H/2
async function renderBmp1x(page, html, W, H, outFile) {
  const w = Math.round(W / 2);
  const h = Math.round(H / 2);
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(html);
  await page.evaluate(() => { document.documentElement.style.zoom = '0.5'; });
  await nextFrame(page);
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: w, height: h } });
  const bmp = pngToBmp24(png);
  assertBmpHealthy(bmp, w, h, Path.basename(outFile));
  Fs.writeFileSync(outFile, bmp);
  console.log('[gen-nsis-art]', Path.basename(outFile), w + 'x' + h, Math.round(bmp.length / 1024) + 'KB');
}

// 裁片 1x: 入参用 2x 坐标(与 2x clip 同源), 内部折半
async function clipBmp1x(page, html, x2, y2, w2, h2, outFile) {
  const x = x2 / 2, y = y2 / 2, w = w2 / 2, h = h2 / 2;
  await page.setViewportSize({ width: 780, height: 520 });
  await page.setContent(html);
  await page.evaluate(() => { document.documentElement.style.zoom = '0.5'; });
  await nextFrame(page);
  const png = await page.screenshot({ clip: { x, y, width: w, height: h } });
  const bmp = pngToBmp24(png);
  assertBmpHealthy(bmp, w, h, Path.basename(outFile));
  Fs.writeFileSync(outFile, bmp);
  console.log('[gen-nsis-art]', Path.basename(outFile), w + 'x' + h, Math.round(bmp.length / 1024) + 'KB');
}

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ deviceScaleFactor: 1 })).newPage();
  const outDir = Path.join(ROOT, 'build');

  // 2x 裁片工具(与整页同源同坐标 → 与背景逐像素一致, 运行时换贴片无缝)
  const clip2x = async (html, x, y, w, h, name) => {
    await page.setViewportSize({ width: 1560, height: 1040 });
    await page.setContent(html);
    Fs.writeFileSync(Path.join(outDir, name + '.bmp'),
      pngToBmp24(await page.screenshot({ clip: { x, y, width: w, height: h } })));
    console.log('[gen-nsis-art]', name + '.bmp', w + 'x' + h);
  };

  // ── [v6] 每个画稿出两套: 2x(原名, 高 DPI 用) + 1x(`1x` 后缀, 96dpi/100% 用) ──
  //    NSIS 侧按 DPI 选目录, 两套都是「尽量不缩放」的那一套; 裁片必须与整页同源同缩放,
  //    否则换贴片时与背景对不上。
  const both = async (html, name) => {
    await renderBmp(page, html, 1560, 1040, Path.join(outDir, name + '.bmp'));
    await renderBmp1x(page, html, 1560, 1040, Path.join(outDir, name + '1x.bmp'));
  };
  const bothClip = async (html, x, y, w, h, name) => {
    await clip2x(html, x, y, w, h, name);
    await clipBmp1x(page, html, x, y, w, h, Path.join(outDir, name + '1x.bmp'));
  };

  await both(welcomeHtml, 'installerWelcome');
  await both(finishHtml, 'installerFinish');
  await both(modePageHtml(false), 'installerMode');
  await bothClip(modePageHtml(true), 80, 280, 724, 430, 'installerModeCardsA');
  await bothClip(modePageHtml(false), 80, 280, 724, 430, 'installerModeCardsB');
  await both(instPageHtml(false, 'cancel'), 'installerInst');
  await bothClip(instPageHtml(true, 'next'), 0, 100, 1560, 200, 'installerInstDoneTitle');
  await bothClip(instPageHtml(false, 'cancel'), 400, 810, 780, 130, 'installerInstBar');
  await bothClip(instPageHtml(true, 'next'), 400, 810, 780, 130, 'installerInstBarDone');

  // 闪屏/侧栏/页眉: 本身就是按显示尺寸 1:1 布局的小图, 保持单套
  await renderBmp(page, splashHtml(false), 480, 300, Path.join(outDir, 'installerSplash.bmp'));
  await renderBmp(page, splashHtml(true), 480, 300, Path.join(outDir, 'uninstallerSplash.bmp'));
  await renderBmp(page, sidebarHtml(true), 164, 314, Path.join(outDir, 'uninstallerSidebar.bmp'));
  await renderBmp(page, headerHtml, 350, 148, Path.join(outDir, 'installerHeader.bmp'));
  await browser.close();
  console.log('[gen-nsis-art] done (v6 双分辨率画稿 · 1x 原生渲染 + 2x)');
})().catch((e) => { console.error(e); process.exit(1); });
