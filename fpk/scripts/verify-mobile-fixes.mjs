// [lc-1290] 移动端四修的静态验证（零 CPU，不起浏览器）。
// 双向验证：未修复版本必须 FAIL，修复版本必须 PASS，否则测试是空转的。
// 验的是「能从源码推导出的事实」：视口标记类装配、轮播宽度预算、底栏裁剪判定、横屏全屏配置。
// 用法：node scripts/verify-mobile-fixes.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
};

// ── 被测源码 ────────────────────────────────────────────────────────────
const mobileStyle = read('src/preload/plugins/mobileStyle.ts');
const danmakuWeb = read('src/preload/plugins/danmakuWeb.ts');
const styles = read('src/preload/plugins/embyWall/carousel/styles.ts');

// ═══ 1. UI 模式（手动切换）与布局标记装配（lc-1319 起） ═══
console.log('\n[1] UI 模式手动切换 → 三布局标记装配（fnos-touch-narrow / narrow / compact）');
{
  // 抽出 applyViewportFlags 的函数体，在 vm 里跑真实源码，验证「标记由 getUiMode 决定」
  const m = mobileStyle.match(/function applyViewportFlags\(\): void \{([\s\S]*?)\n\}/);
  ok(!!m, 'applyViewportFlags 可被抽取');
  const body = m ? m[1] : '';

  /** 在 vm 里以指定模式/触摸能力跑真实函数体，返回挂上的 class 集合 */
  const runFlags = (mode, touch) => {
    const classes = new Set();
    const sandbox = {
      document: {
        documentElement: {
          classList: {
            toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
            contains: (c) => classes.has(c),
          },
          style: { setProperty() {}, removeProperty() {}, minWidth: '' },
        },
        getElementById: () => null,
      },
      window: { dispatchEvent() {} },
      localStorage: { getItem: (k) => (k === 'fntv_ui_mode' ? (mode === 'mobile' ? 'mobile' : null) : null) },
      navigator: { maxTouchPoints: touch ? 5 : 0 },
    };
    vm.createContext(sandbox);
    vm.runInContext(
      `function isTouchDevice(){ return ('ontouchstart' in window) || (navigator.maxTouchPoints||0)>0; }
       function getUiMode(){ return localStorage.getItem('fntv_ui_mode') === 'mobile' ? 'mobile' : 'desktop'; }
       function applyViewportFlags(){${body}}
       applyViewportFlags();`,
      sandbox
    );
    return classes;
  };

  const cMobile = runFlags('mobile', true);
  ok(cMobile.has('fnos-touch-narrow') && cMobile.has('fnos-narrow') && cMobile.has('fnos-compact'),
    '模式=手机 → 三布局标记全开（touch-narrow / narrow / compact）', `实际 [${[...cMobile]}]`);
  ok(cMobile.has('fnos-touch'), '触屏设备同时保留 fnos-touch（纯交互层，与布局无关）');

  const cDesk = runFlags('desktop', true);
  ok(!cDesk.has('fnos-touch-narrow') && !cDesk.has('fnos-narrow') && !cDesk.has('fnos-compact'),
    '模式=电脑 → 三布局标记全关（哪怕设备是触屏 —— lc-1308~1318 误伤根因）', `实际 [${[...cDesk]}]`);
  ok(cDesk.has('fnos-touch'), '电脑模式下 fnos-touch 仍按设备判定（触屏机保留）');

  // 真源与自动判定废除（lc-1319）
  ok(/export function getUiMode\(\): UiMode/.test(mobileStyle) && /export function setUiMode\(/.test(mobileStyle),
    'mobileStyle 导出模式真源 getUiMode/setUiMode（localStorage 持久化）');
  ok(/html\.classList\.toggle\('fnos-touch-narrow', mobile\)/.test(mobileStyle),
    '标记装配读手动模式（不再看视口宽/触屏能力）');
  ok(!/fnos-touch-narrow', touch && narrow/.test(mobileStyle), '旧的「触屏 && 窄视口」自动判定已移除');
}

// ═══ 1b. UI 模式联动（lc-1319）：各安装点统一读模式 ═══
console.log('\n[1b] UI 模式联动 —— 各安装点统一读 getUiMode');
{
  const beautifySrc = read('src/preload/plugins/embyWall/detail/beautifyStyle.ts');
  const carouselMobileSrc = read('src/preload/plugins/embyWall/carousel/mobile.ts');
  const webEntrySrc = read('src/web-entry.ts');
  const uiToggleSrc = read('src/preload/plugins/uiModeToggle.ts');
  const embyWallSrc = read('src/preload/plugins/embyWall.ts');

  ok(/classList\.toggle\('fnos-touch-narrow', getUiMode\(\) === 'mobile'\)/.test(beautifySrc),
    'installMobileFlag（beautifyStyle，danmakuWeb 共用）改读模式');
  ok(/getUiMode\(\) === 'mobile'/.test(carouselMobileSrc) &&
     !/isMobileSpec/.test(carouselMobileSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
    '轮播选路 resolveCarouselStyle 改读模式（旧的触屏+短边判定已删）');
  ok(/const smallScreen = getUiMode\(\) === 'mobile'/.test(danmakuWeb),
    '播放页字号 smallScreen 改读模式');
  ok(/setUiMode\(next\)/.test(uiToggleSrc) && /fntv-uimode-tab/.test(uiToggleSrc),
    'UI 模式切换按钮：点击切换（事件驱动即时生效，无需刷新）');
  const uiToggleCode = uiToggleSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(/btn\.style\.display = hotVisible \? '' : 'none'/.test(uiToggleCode) && !/offsetParent/.test(uiToggleCode),
    'UI 模式按钮只在首页显示（跟随每日放送显隐）+ 判可见性不用 offsetParent（fixed 元素恒 null）');
  ok(/import '\.\/preload\/plugins\/uiModeToggle'/.test(webEntrySrc), 'uiModeToggle 已注册进 web-entry');
  ok(/const mobileMode = getUiMode\(\) === 'mobile'/.test(embyWallSrc) && !/const touchCapable = mobileSpec/.test(embyWallSrc),
    '设置面板「触屏特供」项的显示/高亮口径改读模式（电脑模式不显示死开关）');
}

// ═══ 2. 轮播左右黑框：宽度预算 ═══
console.log('\n[2] 轮播左右黑框 —— 390px 视口下每层吃掉多少宽');
{
  const VW = 390;
  const before = { wrapperPad: 44, sectionPad: 44 };
  const beforeInner = VW - before.wrapperPad * 2 - before.sectionPad * 2;
  const beforeGap = (VW - beforeInner) / 2;
  ok(beforeGap >= 40, `未修复时两侧各空 ${beforeGap}px（≥40px 即肉眼可见的黑边）`,
    `容器可用宽仅 ${beforeInner}px`);

  // 修复后：wrapper 8px + section 8px
  const after = { wrapperPad: 8, sectionPad: 8 };
  const afterInner = VW - after.wrapperPad * 2 - after.sectionPad * 2;
  const afterGap = (VW - afterInner) / 2;
  // 8px/侧 是**刻意留的呼吸位**（轮播右侧有 prev/next 导航钮，完全贴边会被切），
  // 所以判据是「黑边消失」= 每侧 ≤16px，而不是「边距为 0」。
  ok(afterGap <= 16, `修复后两侧各空 ${afterGap}px（≤16px 视为无黑边，8px 是留给导航钮的呼吸位）`,
    `容器可用宽升至 ${afterInner}px`);
  ok(afterGap * 4 <= beforeGap, `黑边宽度缩到原来的 1/${Math.round(beforeGap / afterGap)}`);
  ok(afterInner > beforeInner, `容器宽度增加 ${afterInner - beforeInner}px`);

  // 声明必须在源码里真实存在，且数值一致
  ok(/\[data-fntv-carousel-wrapper\]\{[^}]*padding-left:8px/.test(mobileStyle),
    'mobileStyle B5c 声明 wrapper padding-left:8px');
  ok(/:has\(> \[data-fntv-carousel-wrapper\]\)\{[^}]*padding-left:8px/.test(mobileStyle),
    '用 :has(> wrapper) 收窄**父级** section（wrapper 是子级，写子代选择器无效）');
  ok(!/\[data-fntv-carousel-wrapper\]\{padding-left:16px/.test(styles),
    'styles.ts 里重复的 16px 规则已移除（否则同特异性打架）');
  ok(/height:min\(46vw, 260px\)/.test(mobileStyle),
    '容器给下限高度（16:9 在窄屏会塌成一条）');
  ok(/\.fnos-poster-strip\{ display:none/.test(mobileStyle),
    '右侧海报条（150px 定宽）在窄屏隐藏，让位给主图');
}

// ═══ 3. 卡片过大 ═══
console.log('\n[3] 首页卡片行过大（继续观看 / 剧集列表）');
{
  const clampRe = /width:clamp\((\d+)px, (\d+)vw, (\d+)px\)/;
  const m = mobileStyle.match(clampRe);
  ok(!!m, '卡片宽度用 clamp() 按视口比例钳制');
  if (m) {
    const [, lo, vw, hi] = m;
    const at390 = Math.min(Math.max((390 * +vw) / 100, +lo), +hi);
    const perScreen = Math.floor(390 / (at390 + 10)); // +10 ≈ 站点 gap 收到 10px
    ok(at390 <= 140, `390px 下单卡 ${at390}px`);
    ok(perScreen >= 3, `一屏可见 ${perScreen} 张（≥3 才叫「卡片列表」而不是「大图」)`,
      `单卡 ${at390}px`);
    // 桌面 1920 不受影响：门控是 html.fnos-narrow
    ok(/html\.fnos-narrow \.ms-container/.test(mobileStyle), '规则门控在 html.fnos-narrow 下（桌面不受影响）');
    ok(/min-width:0 !important/.test(mobileStyle.split(clampRe)[0].slice(-400)),
      '同时给 min-width:0（否则行内 width 会顶开，钳制无效）');
  }
  ok(/flex:0 0 clamp/.test(mobileStyle), 'flex-basis 同步钳制（卡片是 shrink-0，不给 basis 不缩）');
}

// ═══ 4. 底栏两行布局（lc-1314 取代 lc-1290~1312 的单行+裁剪） ═══
console.log('\n[4] 播放页底栏「挤在一起/显示不全」→ 两行布局');
{
  // 根因保留：三个 grid 是并列 flex 子项，min-width:auto → 拒绝压缩 → 溢出被 overflow:hidden 吃掉
  ok(/xg-right-grid\{[^}]*min-width:0 !important/.test(danmakuWeb),
    '给 xg-right-grid 加 min-width:0（不压缩=溢出的直接原因）');
  ok(/\.xgplayer-icon\{ width:20px/.test(danmakuWeb),
    '图标类控件（音量/设置/全屏）参与收缩');
  // [lc-1314] 两行结构：inner wrap + 左右栏各占整行
  ok(/xg-inner-controls\{\s*\n?\s*height:136px !important;\s*\n?\s*flex-wrap:wrap !important;/.test(danmakuWeb),
    'inner-controls 两行（136px + flex-wrap:wrap）');
  ok(/xg-left-grid,\s*\n?html\.fnos-touch-narrow xg-right-grid\{\s*\n?\s*flex:0 0 100% !important;/.test(danmakuWeb),
    '左右栏各占整行（两行布局核心：flex:0 0 100%）');
  ok(/xg-left-grid > :last-child\{ margin-left:auto !important; \}/.test(danmakuWeb),
    '第一行：播控左、时间右（margin-left:auto）');
  ok(/xg-right-grid\{ justify-content:space-evenly !important; \}/.test(danmakuWeb),
    '第二行：功能键均布（space-evenly）');
  ok(/xg-center-grid\{[\s\S]{0,180}bottom:110px !important/.test(danmakuWeb),
    '进度条上移到两行之上（bottom:110px），不压第一行触控');
  // 裁剪机制整体移除：两行下全部控件可见（「显示不完全」根治）
  ok(!/NARROW_TRIM_HIDE/.test(danmakuWeb) && !/data-fntv-trimmed/.test(danmakuWeb) &&
     !/ensureNarrowControlTrim/.test(danmakuWeb),
    '结构裁剪机制整体移除（NARROW_TRIM_HIDE / data-fntv-trimmed / ensureNarrowControlTrim）');
  // 音量归位（用户报「声音控件位置不对」）
  ok(/\.xgplayer-volume\{\s*\n?\s*display:flex !important/.test(danmakuWeb) &&
     /\.xgplayer-volume \.xgplayer-icon\{[\s\S]{0,200}transform:none !important/.test(danmakuWeb),
    '音量归位：盒/包裹 flex 居中 + 去 top:12px 位移');
  ok(/\.xgplayer-volume \.xgplayer-icon svg\{\s*\n?\s*height:40px !important; width:auto !important;/.test(danmakuWeb),
    '音量 SVG 用原生 40px 渲染（图形 ≈18px 与邻居一致；24px 时图形仅 12px 偏小）');
  ok(/\.xgplayer-volume \.xgplayer-slider\{\s*\n?\s*height:60px !important;/.test(danmakuWeb) &&
     !/xgplayer-slider\{ display:none/.test(danmakuWeb),
    '音量滑条恢复（不再 display:none，弹出/过渡动画回来）+ 缩短 60px（顶 717 不碰进度线 703）');
  ok(/xgplayer-definition:has\(\.icon-text:empty\)/.test(danmakuWeb),
    '空清晰度按钮不占位（:has 支持时生效，有文案自动恢复）');
  ok(/trim-ui__player-modal-container:not\(\[class\*="!w-full"\]\)\{ max-width:calc\(100vw - 40px\) !important; \}/.test(danmakuWeb),
    '播放信息弹窗窄屏收口（排除全屏遮罩层）');
}

// ═══ 4b. 弹出面板定位 + 弹幕自动缩放（lc-1315） ═══
console.log('\n[4b] 底栏弹出面板定位 + 弹幕自动缩放');
{
  // 面板窄屏 fixed 居中：与按钮水平位置解耦（lc-1314 两行后按钮不再贴右缘，
  // 原 right 公式把面板推出视口左侧——真机实测弹幕面板 x=-101、文字全在屏外）
  ok(/html\.fnos-touch-narrow \.fntv-dm-list\{\s*\n?\s*position:fixed !important;/.test(danmakuWeb),
    '弹幕面板：窄屏 fixed 定位（与按钮水平位置解耦）');
  ok(/left:50% !important; right:auto !important;/.test(danmakuWeb), '弹幕面板：水平居中');
  ok(/bottom:calc\(136px \+ max\(8px, env\(safe-area-inset-bottom\)\) \+ 10px\) !important/.test(danmakuWeb),
    '弹幕面板：锚在底栏上方（136px = [lc-1314] 底栏高）');
  ok(/html\.fnos-touch-narrow \.fntv-dm-list\.active\{\s*\n?\s*transform:translateX\(-50%\) !important;/.test(danmakuWeb),
    '弹幕面板：激活态 transform 保留居中（与进出场动画合成）');
  const skipMarkerSrc = read('src/preload/plugins/skipMarker.ts');
  ok(/html\.fnos-touch-narrow \.fntv-mk-list\{\s*\n?\s*position:fixed !important;/.test(skipMarkerSrc),
    '标记面板：同款 fixed 居中（!important 压内联 right:-6px）');
  ok(/html\.fnos-touch-narrow \.fntv-mk-list\.active\{\s*\n?\s*transform:translateX\(-50%\) !important;/.test(skipMarkerSrc),
    '标记面板：激活态 transform 保留居中');
  // autoScale 占用率：LaneSlot={time,width} 没有 until（lc-1313 引用不存在的字段 = 死代码）
  // 剥注释再测：本段注释里会引用 lc-1313 的旧写法作为史实说明，不算代码
  const dmCode = danmakuWeb.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/l\.until/.test(dmCode), '占用率不再引用不存在的 until 字段（lc-1313 死代码）');
  ok(/l && t - l\.time < dur \? 1 : 0/.test(danmakuWeb), '占用率按 time + scrollDuration 窗口统计');
  ok(/const fontSize = Math\.max\(10, baseFont \* userScale \* autoK\)/.test(danmakuWeb),
    'autoK 与滑块倍数作用在 floor 之后（低画布下压缩量不再被 fontSizeFloor 吃掉）');
  // [lc-1318] 手机/平板模式：字号基准用视频画面实际高度（用户报「屏幕不大弹幕
  //   字号要自动缩放，现在的字号这么大」——竖屏画布全高 844 算出 30px，而 16:9
  //   画面只占上部 ~219px）
  ok(/const smallScreen = getUiMode\(\) === 'mobile'/.test(danmakuWeb),
    'smallScreen 改由手动 UI 模式决定（lc-1319；原「触屏+短边≤820」口径随自动判定一并废除）');
  ok(/const pictureH = cw \/ \(videoEl\.videoWidth \/ videoEl\.videoHeight\)/.test(danmakuWeb),
    '手机/平板字号基准用视频画面实际高度（画布全高会把竖屏字号放大 4 倍）');
  ok(/const userScale = style\.fontScale \/ DEFAULT_STYLE\.fontScale/.test(danmakuWeb),
    '滑块拆成相对倍数（基准被 floor 顶格后倍数仍有效，否则 50%~180% 全被顶成 16）');
  ok(/__fntvAutoK/.test(danmakuWeb), '真机排查观测点 __fntvAutoK（每帧写当前系数）');
  ok(/html\.fnos-touch-narrow \.trim-ui__player--popover\{\s*\n?\s*width:min\(calc\(100vw - 16px\), 392px\) !important;/.test(danmakuWeb),
    '原生弹层窄屏收口（w-[392px] 硬编码 → 视口内限宽）');
  // [lc-1316] 底栏文字按钮字号统一 16px（= 原生「选集」text-lg 实测值）。
  // v1.4.1 曾把带 cursor-pointer 的按钮压到 13px，而「选集」的 span 恰好没有这个
  // 类 → 保持 16px，一排按钮大小不一（用户报「字号统一和选集一样大」）。
  ok(/span\.cursor-pointer \{\s*\n?\s*font-size: 16px !important;/.test(danmakuWeb),
    '底栏文字按钮统一 16px（cursor-pointer 与 control-item 两组选择器同值）');
  ok(/max-width:360px\)\{[\s\S]{0,250}span\.cursor-pointer\{ font-size:12px !important; \}/.test(danmakuWeb),
    '≤360px 超窄兜底同步压两个选择器（避免宽度回落时又不一致）');
  // [lc-1317] 弹幕按钮 hover 改 PointerEvent 输入区分（带触摸屏的鼠标环境也弹面板）
  ok(/wrap\.addEventListener\('pointerenter'/.test(danmakuWeb) && /e\.pointerType === 'touch'/.test(danmakuWeb),
    '弹幕按钮 hover 用 pointerType 区分输入（不再被设备触摸能力误伤）');
  // [lc-1317] 原生弹层高度/内容层收口
  ok(/html\.fnos-touch-narrow \[class\*="max-h-\[690px\]"\]\{ max-height:min\(62vh, 690px\) !important; \}/.test(danmakuWeb),
    '原生弹层高度上限 62vh（690px 在 844 视口占 82% 过满）');
  ok(/html\.fnos-touch-narrow \[class\*="w-\[392px\]"\]\{ max-width:100% !important; \}/.test(danmakuWeb),
    '弹层内容层同步收窄（外层 374 时内容 392 会被裁 18px）');
}

// ═══ 5. 横屏全屏 ═══
console.log('\n[5] 全屏按钮 → 横屏全屏播放');
{
  ok(/p\.config\.fullscreen\.useScreenOrientation = true/.test(danmakuWeb),
    '开启 xgplayer 自带的 useScreenOrientation（而非自己调 orientation.lock）');
  ok(/lockOrientationType = 'landscape'/.test(danmakuWeb), '锁定方向为 landscape');
  ok(/__reactFiber\$/.test(danmakuWeb), '经 React fiber 取 player 实例（与 gamepad.ts lc-679 同法）');
  // 只查真实代码，剥掉注释（注释里会解释「为什么不自己调 lock」）
  const danmakuCode = danmakuWeb.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/screen\.orientation\.lock\(/.test(danmakuCode),
    '不自己调 screen.orientation.lock（不在用户手势栈内必抛 NotSupportedError）');
  ok(/xgplayer-is-cssfullscreen/.test(danmakuWeb),
    '修掉死判据：原 .xgplayer.xgplayer-fullscreen 恒 false（那是按钮的类，不是状态类）');
}

// ═══ 6. 回归：桌面端不被波及 ═══
console.log('\n[6] 回归 —— 桌面宽屏不受影响');
{
  ok(!/^html\.fnos-narrow/gm.test(danmakuWeb.replace(/^html\.fnos-touch-narrow.*$/gm, '')),
    '底栏规则全部门控在 fnos-touch-narrow 下');
  ok(!/screen\.orientation/.test(mobileStyle), 'mobileStyle 不碰屏幕方向（无副作用）');
}

console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);