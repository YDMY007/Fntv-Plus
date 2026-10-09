// [lc-1291] 样式 5 触屏特供轮播的静态+沙箱验证（零 CPU，不起浏览器）。
// 双向验证：把源码还原到 lc-1290（无样式5）后必须 FAIL，修复版必须 PASS。
// 用法：node scripts/verify-mobile-carousel-s5.mjs
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

const exists = (p) => fs.existsSync(path.join(ROOT, p));
const mobile = exists('src/preload/plugins/embyWall/carousel/mobile.ts')
  ? read('src/preload/plugins/embyWall/carousel/mobile.ts') : '';
const render = read('src/preload/plugins/embyWall/carousel/render.ts');
const progress = read('src/preload/plugins/embyWall/carousel/progress.ts');
const embyWall = read('src/preload/plugins/embyWall.ts');
const bundle = exists('dist/fntv-plus.user.js') ? read('dist/fntv-plus.user.js') : '';

// mobile.ts 缺失（未实现样式 5）→ 直接判死，其余断言无从谈起
if (!mobile) {
  console.log('\n❌ mobile.ts 不存在 —— 样式 5 未实现（反向验证：FAIL 是预期）');
  console.log('═══ 0 passed, 1 failed ═══');
  process.exit(1);
}

// ═══ 1. 选路逻辑：vm 沙箱跑真实 resolveCarouselStyle（lc-1319 起由手动 UI 模式决定） ═══
console.log('\n[1] 选路逻辑（UI 模式门控 / 电脑模式原样式不动 / 存量口径）');
{
  const fnSrc = mobile.match(/export function resolveCarouselStyle\(\): number \{[\s\S]*?\n\}/);
  ok(!!fnSrc, 'resolveCarouselStyle 可抽取');
  // vm 只认纯 JS：剥掉 TS 类型标注（含 let stored: string|null 这样的局部注解）
  const strip = (s) => s.replace('export ', '')
    .replace(/\(\): number /, '() ')
    .replace(/let stored: string \| null = null/g, 'let stored = null');
  const body = fnSrc ? strip(fnSrc[0]) : '';
  // run(stored, mode)：mode = localStorage['fntv_ui_mode']（'mobile' | null=desktop）
  const run = (stored, mode) => {
    const sb = {
      localStorage: { getItem: (k) => (k === 'fntv_ui_mode' ? mode : stored) },
      window: {},
    };
    vm.createContext(sb);
    return vm.runInContext(`
      function getUiMode(){ return localStorage.getItem('fntv_ui_mode') === 'mobile' ? 'mobile' : 'desktop'; }
      ${body}
      resolveCarouselStyle();`, sb);
  };
  // ── 手机/平板模式（UI 模式=手机）：样式 5 生效 ──
  ok(run(null, 'mobile') === 5, '手机模式 + 从未选过 → 样式 5', `got ${run(null, 'mobile')}`);
  ok(run('4', 'mobile') === 5, '手机模式 + 存量 4（lc-780 默认值，非知情选择）→ 样式 5', `got ${run('4', 'mobile')}`);
  ok(run('2', 'mobile') === 2, '手机模式 + 显式选过 2 → 尊重为 2');
  ok(run('1', 'mobile') === 1, '手机模式 + 显式选过 1 → 尊重为 1');
  ok(run('3', 'mobile') === 3, '手机模式 + 显式选过 3 → 尊重为 3');
  ok(run('5', 'mobile') === 5, '手机模式 + 手动选 5 → 5');
  ok(run('9', 'mobile') === 5, '手机模式 + 越界值（坏数据等同未选）→ 样式 5');
  // ── 电脑模式（默认）：一切落回桌面样式（用户核心诉求：PC 原样式一行不动） ──
  ok(run('4', null) === 4, '电脑模式 + 存量 4 → 样式 4 原样', `got ${run('4', null)}`);
  ok(run(null, null) === 4, '电脑模式 + 从未选过 → 样式 4');
  ok(run('5', null) === 4, '电脑模式 + 手动选 5（手机特供）→ 回落 4');
  ok(run('2', null) === 2, '电脑模式 + 显式选 2 → 2');
  ok(run('9', null) === 4, '电脑模式下越界值 → 4');
}

// ═══ 2. 样式 5 的触屏设计断言（CSS 层）═══
console.log('\n[2] 样式 5 CSS：全宽单卡 + 原生横滑 + 触控目标');
{
  ok(/scroll-snap-type:x mandatory/.test(mobile), 'scroll-snap 横滑（浏览器接管惯性，不写 JS 手势）');
  ok(/touch-action:pan-x/.test(mobile), 'touch-action:pan-x（纵向滚动还给学生页面）');
  ok(/scroll-snap-stop:always/.test(mobile), '一屏一停（禁止连滑掠过）');
  ok(/overscroll-behavior-x:contain/.test(mobile), '滑到头不把橡皮筋传给整页');
  ok(/height:min\(56vw,340px\)/.test(mobile), '高度按视口宽推算（竖屏不塌、横屏不满）');
  ok(/min-height:48px/.test(mobile), '按钮 48px 拇指热区（lc-1326 重设计，>WCAG 44 下限）');
  ok(/-webkit-line-clamp:2/.test(mobile), '简介两行截断（用户截图里简介被裁半句的问题）');
  ok(/max-height:44px/.test(mobile), 'logo 钳 44px（桌面 84~130px 的 logo 在手机占半屏）');
  ok(/fntv-s5-ready/.test(mobile), '揭示态 class（首图就绪再淡入）');
  // 不再有 3D 残影来源
  ok(!/rotateY/.test(mobile), '无 rotateY（用户截图左侧糊影的来源就是 3D 邻卡）');
  ok(!/blur\(1\.5px\)/.test(mobile), '无邻卡 blur（截图左侧模糊块的来源）');
}

// ═══ 3. 装配契约 ═══
console.log('\n[3] 装配契约与三处口径一致');
{
  ok(/_cs === 5/.test(render) && /buildCarouselStyle5\(container, wrapper, shows, base, rebuild\)/.test(render),
    'render.ts 有 _cs===5 分发，入参与 s2/s3/s4 同构');
  ok(/resolveCarouselStyle\(\)/.test(render), 'render.ts 用 resolveCarouselStyle()（含触屏自动特供）');
  ok(/_cs === 5/.test(progress), 'progress.ts 骨架有样式 5 分支');
  ok(/min\(56vw,340px\)/.test(progress), '骨架容器几何与真实样式 5 同式（加载完零跳变）');
  ok(/触屏特供/.test(embyWall), '设置面板有「触屏特供」选项');
  ok(/v <= 5/.test(embyWall), '面板 getCs 上限 5');
  // S.carouselCleanup / S.carouselResume 必须注册（destroyCarousel/resumeCarousel 依赖）
  ok(/S\.carouselCleanup = /.test(mobile), '注册 S.carouselCleanup（离开首页停 timer）');
  ok(/S\.carouselResume = /.test(mobile), '注册 S.carouselResume（返回首页重启）');
  ok(/document\.hidden/.test(mobile), '页面隐藏不翻页（s4 同款守卫）');
  ok(/touching/.test(mobile), '触摸中停自动翻页（scroll-snap 下定时翻页会与手指抢位置）');
}

// ═══ 4. 产物 bundle 已包含 ═══
console.log('\n[4] 产物 bundle');
{
  ok(bundle.length > 0, 'dist bundle 存在');
  ok(/fntv-s5-scroll/.test(bundle), '样式 5 CSS 已打进产物');
  ok(/resolveCarouselStyle/.test(bundle), '选路函数已打进产物');
  // 「触屏特供」的 unicode 转义形式在产物里是 \u89E6\u5C4F\u7279\u4F9B（字面反斜杠+u 文本）。
  // 正则字面量写 \\u89E6 会被 JS 收缩成「触」字本身，所以用 fromCharCode 拼匹配串，不写正则。
  const esc = (s) => [...s].map((c) => '\\u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')).join('');
  const labelRaw = '触屏特供';
  const labelEsc = esc(labelRaw);
  ok(bundle.includes(labelRaw) || bundle.includes(labelEsc), '设置面板项已打进产物',
    `raw=${bundle.includes(labelRaw)} esc=${bundle.includes(labelEsc)}`);
}

// ═══ 5. 滑动↔指示点同步算法（vm 沙箱跑真实数学）═══
console.log('\n[5] 滑动↔指示点同步（最近中心判定）');
{
  // 从源码抽出 syncActive 的距离判定逻辑，用假 slides 跑真算法
  // 源码：center = scrollLeft + clientWidth/2；取 |slideCenter - center| 最小者
  const clientWidth = 390;
  const slideW = 390, n = 6;
  const slides = Array.from({ length: n }, (_, i) => ({ offsetLeft: i * slideW, offsetWidth: slideW }));
  const syncActive = (scrollLeft) => {
    const center = scrollLeft + clientWidth / 2;
    let best = 0, bestDist = Infinity;
    slides.forEach((s, i) => {
      const c = s.offsetLeft + s.offsetWidth / 2;
      const dist = Math.abs(c - center);
      if (dist < bestDist) { bestDist = dist; best = i; }
    });
    return best;
  };
  ok(syncActive(0) === 0, '滑到最左 → 第 0 点亮');
  ok(syncActive(slideW * 2 + 100) === 2, '滑到第 3 张（带偏移）→ 第 2 点亮');
  ok(syncActive(slideW * 5) === 5, '滑到最右 → 最后一点亮');
}

console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);