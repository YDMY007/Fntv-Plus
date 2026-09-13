// embyWall/pageBg.ts — [v1.11.0] 页面背景自定义：不再锁死深浅模式的实心白/黑。
// ─────────────────────────────────────────────────────────────────────────────
// 原生背景链路（实测取证）：底色最终画在 **body** 上——浅色=实心白（容器白底由白底清除器
// 清透，见 embyWall.ts 全局清除器，BODY 在其跳过表里永不被清）；深色=实心近黑（semi token）。
// 本模块在 body 上以高特异性 !important 规则接管：
//   solid    body 直涂纯色
//   gradient body 直涂 linear-gradient(角度, c1→c2)（fixed 附着）
//   image    body 清透 + 固定层 #fntv-page-bg-layer 画图（z-index:-1 盖住 html 底、垫在内容下），
//            层上叠暗化渐变 + blur 滤镜（模糊需独立层，body 的 background-image 无法单独模糊）
// 并按 glassUI 同款选择器把 #root/#app/body>div 及 semi-color-bg-0/1 容器清透——
// 否则深色模式这些不透明容器会盖死 body 上的自定义背景（浅色本就靠清除器透掉）。
// 特异性：html[三属性].fnos-tv-page body = (0,4,2)，稳定压过原生 token、glassUI 背景层
// (0,3,2) 与性能模式兜底实底 (0,3,2)；样式表每次 apply 都重挂到 head 末尾，平局也后到胜。
// 深浅模式不各自锁色：同一组自定义背景在两种模式下都生效（文字/UI 仍随主题切换）。
// 开关/参数在设置面板「通用→页面背景」卡；patch.ts 启动 seed 后 applyPageBg()。
// ─────────────────────────────────────────────────────────────────────────────
import { S } from './state';

const STYLE_ID = 'fntv-page-bg-style';
const LAYER_ID = 'fntv-page-bg-layer';

/** 图片 URL 的 CSS url() 转义（dataURL 含逗号/引号场景）。 */
function cssUrl(raw: string): string {
  return 'url("' + String(raw).replace(/"/g, '%22') + '")';
}

/** 幂等挂/移图片固定层。 */
function ensureImageLayer(src: string, dim: number, blur: number): void {
  let layer = document.getElementById(LAYER_ID) as HTMLDivElement | null;
  if (!src) { if (layer && layer.parentNode) layer.parentNode.removeChild(layer); return; }
  if (!layer) {
    layer = document.createElement('div');
    layer.id = LAYER_ID;
    layer.setAttribute('data-fnos-ui', '1'); // 白底清除器保护
    layer.style.cssText = 'position:fixed;inset:0;z-index:-1;pointer-events:none;';
    (document.body || document.documentElement).appendChild(layer);
  }
  const d = Math.min(85, Math.max(0, dim)) / 100;
  layer.style.background = 'linear-gradient(rgba(0,0,0,' + d + '),rgba(0,0,0,' + d + ')),' + cssUrl(src) + ' center/cover no-repeat';
  layer.style.filter = blur > 0 ? 'blur(' + blur + 'px)' : '';
  // blur 会把边缘采到透明→泛白，轻微放大补偿
  layer.style.transform = blur > 0 ? 'scale(1.07)' : '';
}

/** 按当前 S 配置应用页面背景（幂等；native=完全还原原生）。 */
export function applyPageBg(): void {
  const html = document.documentElement;
  const mode = S.pageBgMode;
  const st = (() => {
    let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
    }
    return el;
  })();

  if (mode === 'native') {
    html.removeAttribute('data-fntv-bg-active');
    html.removeAttribute('data-fntv-bg-mode');
    html.removeAttribute('data-fntv-bg');
    if (st.parentNode) st.parentNode.removeChild(st);
    const old = document.getElementById(LAYER_ID);
    if (old && old.parentNode) old.parentNode.removeChild(old);
    return;
  }

  // 标记 + 特异性锚（三属性压过原生/glassUI/性能兜底）
  html.setAttribute('data-fntv-bg-active', '1');
  html.setAttribute('data-fntv-bg-mode', mode);
  html.setAttribute('data-fntv-bg', '1');

  const ROOT = 'html[data-fntv-bg-active][data-fntv-bg-mode="' + mode + '"][data-fntv-bg].fnos-tv-page';
  // 容器清透（glassUI ②③ 同款选择器）：深色模式不透明容器会盖死 body 自定义背景
  const CLEAR = ROOT + ' [class*="bg-[var(--semi-color-bg-1)"],'
    + ROOT + ' [class*="bg-[var(--semi-color-bg-0)"]{background-color:transparent!important}'
    + ROOT + ' #root,' + ROOT + ' #app,' + ROOT + ' body > div,'
    + ROOT + ' body > nav,' + ROOT + ' body > header,' + ROOT + ' body > section{background:transparent!important}';

  let bodyCss = '';
  if (mode === 'solid') {
    bodyCss = 'background:' + S.pageBgColor + '!important;background-color:' + S.pageBgColor + '!important;'
      + 'background-image:none!important;';
  } else if (mode === 'gradient') {
    const a = Math.min(360, Math.max(0, Number(S.pageBgAngle) || 160));
    bodyCss = 'background:linear-gradient(' + a + 'deg,' + S.pageBgColor + ',' + S.pageBgColor2 + ') fixed!important;'
      + 'background-color:' + S.pageBgColor + '!important;';
  } else if (mode === 'image') {
    bodyCss = 'background:transparent!important;background-color:transparent!important;';
  }
  st.textContent = ROOT + ' body{' + bodyCss + '}' + CLEAR;

  // 重挂到 head 末尾：与 glassUI 等特异性规则同现时「后到胜」
  (document.head || document.documentElement).appendChild(st);

  if (mode === 'image') {
    ensureImageLayer(S.pageBgImage, S.pageBgDim, S.pageBgBlur);
  } else {
    const old = document.getElementById(LAYER_ID);
    if (old && old.parentNode) old.parentNode.removeChild(old);
  }
}
