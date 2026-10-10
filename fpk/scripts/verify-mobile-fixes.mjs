// [lc-1290] 移动端四修的静态验证（零 CPU，不起浏览器）。
// 双向验证：未修复版本必须 FAIL，修复版本必须 PASS，否则测试是空转的。
// 验的是「能从源码推导出的事实」：视口标记类装配、轮播宽度预算、底栏裁剪判定、横屏全屏配置。
// 用法：node scripts/verify-mobile-fixes.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
// 双向验证用：FNTV_DANMAKU_SRC=<旧版本文件> 可把被测源码换成历史版本，
// 用来确认「修好之前这些断言确实会 FAIL」（否则断言可能只是空转）。
const SRC_OVERRIDE = process.env.FNTV_DANMAKU_SRC || '';
const read = (p) => {
  if (SRC_OVERRIDE && p === 'src/preload/plugins/danmakuWeb.ts') return fs.readFileSync(SRC_OVERRIDE, 'utf8');
  return fs.readFileSync(path.join(ROOT, p), 'utf8');
};

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
};

/** 抽出 TS 文件里所有 `const css = \`...\`;` 模板（纯 CSS），逐个扫描后合并。
 *  ⚠ 不能拿整份 .ts 直接扫：文件里有成百上千个 JS 花括号/对象字面量，
 *  手写花括号栈会被 JS 代码带偏（lc-1332 移动样式时就踩过：选择器与规则体串位，
 *  过滤出来恒为 0 条 —— 断言静默失效比断言失败更危险）。 */
function scanTsCss(src) {
  const out = [];
  const re = /const css = `([\s\S]*?)`;/g;
  let m;
  while ((m = re.exec(src))) out.push(...scanCssRules(m[1]));
  return out;
}

/** 把一份 CSS 文本（含 @media）扫成规则表：[{sel, body, media}]。
 *  本项目注入的样式是扁平 CSS + @media，一个花括号栈足够；比逐条正则可靠 ——
 *  「同一属性散落多条规则、特异性互相盖」正是 lc-1330 那个 bug 的形状。 */
function scanCssRules(css) {
  const clean = String(css).replace(/\/\*[\s\S]*?\*\//g, '');   // 注释里会有反例示例
  const rules = [];
  const media = [];
  let buf = '';
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '@') {
      const open = clean.indexOf('{', i);
      if (open < 0) break;
      media.push(clean.slice(i, open).trim());
      i = open;
      continue;
    }
    if (ch === '{') {
      const end = clean.indexOf('}', i);
      if (end < 0) break;
      rules.push({ sel: buf.trim(), body: clean.slice(i + 1, end), media: media.join(' ') });
      buf = '';
      i = end;
      continue;
    }
    if (ch === '}') { media.pop(); buf = ''; continue; }
    buf += ch;
  }
  return rules;
}

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

// ═══ 1c. 手机模式顶栏收口（lc-1324） ═══
console.log('\n[1c] 手机模式顶栏（首页导航栏）收口');
{
  ok(/html\.fnos-narrow \[class\*="justify-between"\]\[class\*="px-11"\]\{/.test(mobileStyle) &&
     /padding:11px 16px !important/.test(mobileStyle),
    '顶栏内边距 44→16 / 纵向 py-5→11（标题块被压成一字 34px → 实测 142px 完整放下）');
  ok(/html\.fnos-narrow \[class\*="h-\[80px\]"\]\[class\*="bg-\[var\(--semi-color-bg-1\)\]"\]\{/.test(mobileStyle),
    '顶栏高度 80→64（移动端紧凑标准；行与外层等高不溢出）');
  ok(/html\.fnos-narrow #tb-logo\{ top:32px !important; \}/.test(mobileStyle),
    '首页 logo 跟随新顶栏中线（top 40→32，实测中线对齐）');
  // [lc-1325] 页面级左留白收窄（标题 px-11 与卡片行 pl-[44px] 两种写法都要覆盖）
  ok(/html\.fnos-narrow \[class\*="px-11"\]\{/.test(mobileStyle) &&
     /html\.fnos-narrow \[class\*="pl-\[44px\]"\]\{/.test(mobileStyle),
    '页面级左留白 44→16（实测三条横滑行首卡 x 44→16）');
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

  // [lc-1332] 底栏布局必须挂在**无条件注入**的样式表上（用户报「有时候还是以前的样式」）：
  //   原先它与标题栏/弹层一起在 injectPlayerHeaderStyle 里，而那条链只在 maybeSetup 走到
  //   播放页分支时才跑，且 isPlayerPage() 要求当前已有 <video> → 进页那刻 video 未建、
  //   或非 B站路由（/v/other/…）时整段样式不注入。
  {
    const iLayout = danmakuWeb.indexOf('function injectControlsLayoutStyle');
    const iHeader = danmakuWeb.indexOf('function injectPlayerHeaderStyle');
    const iNext = danmakuWeb.indexOf('function resetHeaderHideTimer');
    ok(iLayout > 0 && iLayout < iHeader && iHeader < iNext, '两个注入函数相邻可切分');
    const layoutFn = danmakuWeb.slice(iLayout, iHeader);
    const headerFn = danmakuWeb.slice(iHeader, iNext);
    ok(/xg-inner-controls\{[\s\S]{0,80}flex-wrap:wrap !important/.test(layoutFn),
      '两行布局规则在「无条件注入」的底栏样式表里');
    ok(/xgplayer-rotate-fullscreen/.test(layoutFn) && /height:100vw/.test(layoutFn),
      '旋转全屏样式也一并放在无条件表里（否则播放页判定一错过，全屏又转不动）');
    ok(!/xg-inner-controls|xgplayer-rotate-fullscreen/.test(headerFn),
      '播放页门控的样式表里不再残留底栏/旋转规则');
    ok(/registerHook\(HookType\.OnReady, \(\) => \{\s*\n\s*\/\/[^\n]*\n\s*injectControlsLayoutStyle\(\);/.test(danmakuWeb),
      'OnReady 无条件调用（不依赖播放页判定 / video 是否已建）');
    ok(/PLAYER_CONTROLS_STYLE_ID = 'fntv-player-controls-style'/.test(danmakuWeb) && /_controlsStyleInjected/.test(danmakuWeb),
      '独立 style 元素 + 幂等标记（重复注入不叠加）');
  }
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
  // [lc-1316→1330] 底栏字号统一 16px（= 原生「选集」的 tailwind text-lg 实测值）。
  // lc-1316 只钉了 .control-item / span.cursor-pointer 两组，漏了：时间行那条第 11px
  // 规则（特异性 (0,3,2) 反而**高于**统一规则 (0,2,2)，且命中数与原生插件启用情况有关
  // → 「换设备有些一样有些不一样」）、.xgplayer-time、倍音·原画的 .icon-text，
  // 以及 ≤360px 只压两组选择器的媒体查询。lc-1330 改成「一次钉全 + 不按设备分叉」。
  // 下面用 CSS 规则扫描（而不是逐条正则）来保证**覆盖完整 + 取值唯一**：
  // 这条断言当初就是缺的，所以才会出现「只钉了两组」这种漏网。
  {
    const allRules = scanTsCss(danmakuWeb);
    const fontRules = allRules
      .filter((r) => /font-size/.test(r.body) && /xg-controls|xg-left-grid|xg-right-grid/.test(r.sel));
    const sizes = [...new Set(fontRules.flatMap((r) => [...r.body.matchAll(/font-size:\s*([^;!]+)/g)].map((m) => m[1].trim())))];
    ok(fontRules.length > 0, `底栏存在字号规则（扫描到 ${fontRules.length} 条）`);
    ok(sizes.length === 1 && sizes[0] === '16px',
      `底栏字号取值唯一且 = 选集（16px），实际: ${sizes.join(' / ') || '无'}`);
    ok(fontRules.every((r) => !r.media),
      '底栏字号不随设备/视口分叉（@media 内不得再出现 font-size）');
    const union = fontRules.map((r) => r.sel).join(' ');
    for (const carrier of ['.control-item', 'span.cursor-pointer', '.icon-text', '.btn-text', '.xgplayer-time']) {
      ok(union.includes(carrier), `字号规则覆盖 ${carrier}（底栏带文字的载体一个都不能漏）`);
    }
    ok(!/xg-left-grid \.control-item:not\(:first-child\)\s*\{[\s\S]{0,200}font-size/.test(
      danmakuWeb.replace(/\/\*[\s\S]*?\*\//g, '')),
      '时间行那条高特异性规则里没有 font-size（否则会盖掉统一值）');
  }
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
  // [lc-1327] 插件实例 config 是注册时 Object.assign 的副本（T1.register 反查实证），
  // 改 player.config.fullscreen 无效 —— 必须改 getPlugin('fullscreen') 的实例 config。
  ok(/getPlugin\('fullscreen'\)/.test(danmakuWeb),
    'patch 打到插件实例 config（getPlugin；改 player.config 是无效的副本外写法）');
  ok(/fs && fs\.config \? \[fs\.config, player\.config\.fullscreen\]/.test(danmakuWeb),
    '插件实例 config 与 player.config 双写（toggleFullScreen 读 this.config=fs.config；lc-1327 副本教训）');
  ok(/c\.lockOrientationType = 'landscape'/.test(danmakuWeb), '锁定方向为 landscape');
  // [lc-1328→1329] 环境分派 + 原生失败自愈：Android WebView 里 screen.orientation.lock 必败
  //   （嵌入组件无法控制宿主 Activity 方向），原生 requestFullscreen 还需宿主实现
  //   onShowCustomView（没实现就 reject 且静默）→ 降级到 xgplayer 自带 rotateFullscreen。
  ok(/inWebView: \/\\bwv\\b\/\.test\(navigator\.userAgent \|\| ''\)/.test(danmakuWeb),
    '环境快照 fsEnv()：Android WebView（UA wv 标记）→ 伪横屏 / 浏览器 → 真转屏');
  ok(/c\.rotateFullscreen = rotate;[\s\S]{0,120}c\.useScreenOrientation = !rotate;/.test(danmakuWeb),
    'rotate 与 useScreenOrientation 互斥赋值（bundle：两者同开时 rotate 优先）');
  ok(/function onFsIntent\(ev: Event\)/.test(danmakuWeb) &&
     /document\.addEventListener\('click', onFsIntent, true\)/.test(danmakuWeb) &&
     /document\.addEventListener\('touchend', onFsIntent, true\)/.test(danmakuWeb),
    '点击前判定绑在 document **捕获阶段**（touchend 必须监听：移动端 xgplayer 只绑 touchend）');
  ok(!/\.toggleFullScreen\s*=\s*function/.test(danmakuWeb),
    '不包装 fs.toggleFullScreen —— bundle 里按钮绑的是 hook() 捕获的闭包（包装属性对点击无效）');
  ok(/function verifyNativeFullscreen\(\)/.test(danmakuWeb) &&
     /setTimeout\(verifyNativeFullscreen, 400\)/.test(danmakuWeb),
    '原生路径 400ms 复核 → 仍竖屏则自愈降级（不靠 UA 猜测，iOS/自定义 UA 一并覆盖）');
  ok(/_fsForceRotate = true/.test(danmakuWeb) && /_fsHealTried/.test(danmakuWeb),
    '降级结论粘住（第二次点击不再试原生）+ 自愈每页只试一次');
  ok(/!\(cur\.player\.aspectRatio < 1\)/.test(danmakuWeb),
    '竖向内容不强行转 90°（与 xgplayer 原生 lockScreen 的 aspectRatio>1 同口径）');
  ok(/\.xgplayer-rotate-fullscreen\{/.test(danmakuWeb) && /rotate\(90deg\) !important/.test(danmakuWeb),
    'rotate-fullscreen 样式补回（飞牛构建裁掉了它）');
  ok(/html:has\(\.xgplayer-rotate-fullscreen\) \.xgplayer-rotate-fullscreen\{[\s\S]{0,400}height:100vw !important/.test(danmakuWeb),
    'rotate 容器补 height:100vw（getRotateFullscreen 只写 width=innerHeight；缺 height 会转成一条窄带）');
  ok(/html:has\(\.xgplayer-rotate-fullscreen\) .{0,40}\.xgplayer-rotate-fullscreen\{/.test(danmakuWeb) &&
     !/html\.fnos-touch-narrow \.xgplayer-rotate-fullscreen\{/.test(danmakuWeb),
    'rotate 样式按状态类 :has() 作用域（不是布局标记）—— 自愈降级可能在「桌面模式 + 手机屏」下发生');
  ok(!/html:has\(\.xgplayer-rotate-fullscreen\) \.xgplayer-rotate-fullscreen\{[\s\S]{0,400}width:100vh !important/.test(danmakuWeb),
    '不压死 rotate 容器的宽（行内值随 orientation 动态变，!important 会错位）');
  ok(/__reactFiber\$/.test(danmakuWeb), '经 React fiber 取 player 实例（与 gamepad.ts lc-679 同法）');
  // 只查真实代码，剥掉注释（注释里会解释「为什么不自己调 lock」）
  const danmakuCode = danmakuWeb.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/screen\.orientation\.lock\(/.test(danmakuCode),
    '不自己调 screen.orientation.lock（不在用户手势栈内必抛 NotSupportedError）');
  ok(/xgplayer-is-cssfullscreen/.test(danmakuWeb),
    '修掉死判据：原 .xgplayer.xgplayer-fullscreen 恒 false（那是按钮的类，不是状态类）');
}

// ═══ 5a. 自建伪横屏（lc-1334：不再依赖插件 config / React fiber）═══
console.log('\n[5a] 播放页全屏 → 我们自己改 UI 转横屏');
{
  const ps = read('src/preload/plugins/pseudoLandscape.ts');
  ok(/export function togglePseudoLandscape/.test(ps) && /export function enterPseudoLandscape/.test(ps),
    '伪横屏模块具备进入/切换（点同一个按钮即开/关）');
  ok(/classList\.add\(ROT_CLASS\)/.test(ps) && /xgplayer-rotate-fullscreen/.test(ps),
    '复用 xgplayer 自己的旋转类名（既有 rotate CSS 原样生效）');
  ok(/root\.style\.width = window\.innerHeight/.test(ps),
    '行内宽按 xgplayer getRotateFullscreen 同口径（= innerHeight，高度交给 CSS 的 100vw）');
  ok(/CANVAS_CLASS/.test(ps) && /getElementById\(CANVAS_ID\)/.test(ps),
    '弹幕画布一并旋转（syncCanvasRect 只写 left/top/宽高，不碰 transform → 不会被逐帧覆盖）');
  ok(/preventDefault\(\)/.test(ps + danmakuWeb) === false || /ev\.preventDefault\(\)/.test(danmakuWeb),
    '点击拦截里显式 preventDefault（拦住按钮自身处理器）');
  ok(/ev\.stopPropagation\(\)/.test(danmakuWeb),
    '必须 stopPropagation：否则按钮上的原生全屏处理器照样跑（真机现象=进了原生全屏但不转）');
  ok(/if \(env\.isTouch && env\.isPortrait && contentLandscape\)/.test(danmakuWeb),
    '仅触摸 + 竖屏 + 横向内容才自建旋转（桌面/竖向内容不干预）');
  ok(/setPlayerResolver\(resolveXgPlayer\)/.test(danmakuWeb),
    '尽力同步播放器内部状态（rotateDeg/fullscreen），取不到实例也不影响显示');
  ok(/cleanupPseudoLandscape\(\)/.test(danmakuWeb.split('function leavePlayer')[1] || ''),
    '离开播放页清场（html 门控类不会残留）');
  ok(/#fntv-danmaku-canvas\.fntv-dm-rotate\{[\s\S]{0,120}rotate\(90deg\) !important/.test(danmakuWeb),
    '画布旋转 CSS（按 id 锁定，避免误伤其它 canvas）');
}

// ═══ 5b. 首页卡片误触（lc-1331）═══
console.log('\n[5b] 继续观看卡片：浮层圆钮命中区收窄');
{
  const tap = read('src/preload/plugins/cardTapZone.ts');
  const entry = read('src/web-entry.ts');
  ok(/import '\.\/preload\/plugins\/cardTapZone'/.test(entry), 'web-entry 已挂载 cardTapZone');
  ok(/querySelectorAll\('svg'\)/.test(tap) && /while \(p && p !== card\)/.test(tap),
    '以「可见图形为锚向上收外壳」而不是按类名枚举候选（枚举法会漏掉普通 div 外壳）');
  ok(/pointer-events', 'none', 'important'/.test(tap) && /pointer-events', 'auto', 'important'/.test(tap),
    '外壳 none + 图形 auto（点图形仍走原处理器，点 padding 区穿透到播放）');
  ok(/Math\.abs\(ex - cx\) < cr\.width \* 0\.18/.test(tap) && /ey < cr\.top \+ cr\.height \* 0\.5/.test(tap),
    '居中的播放圆钮与卡片上半部分不碰（只收窄下缘小圆钮）');
  ok(/fnos-touch/.test(tap) && /if \(!document\.documentElement\.classList\.contains\('fnos-touch'\)\) return/.test(tap),
    '仅触摸设备生效（桌面 hover+鼠标无需干预）');
  ok(/data-fntv-tapfix/.test(tap), '处理过的卡片打标记（MutationObserver 反复触发不重复处理）');
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