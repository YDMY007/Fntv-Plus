// preload/plugins/customLogo.ts
//
// [lc-1046] 首页顶部 Logo 自定义：内置预设(流媒体平台) / 上传自定义 / 恢复默认 + 弹窗实时预览
// ─────────────────────────────────────────────────────────────────────────────
// 背景：首页顶部居中的「飞牛影视」logo 是本项目 titlebar.ts 注入的 #tb-logo ——
//   build/iconfntv.png → base64 data URI，body 顶层 position:fixed 居中(top:72px)，仅首页显示
//   ([v367] 挂 body 顶层的固定悬浮方案，[v375] isHomePage 可见性)。本插件把它的 src 做成可自定义。
// 预设来源：用户提供的 24 个流媒体平台透明底 PNG(长边≈1024px)，入 resource/logos/ 规范化命名，
//   经 package.json build.files 打进安装包；运行时 fs.readFileSync + __dirname 定位
//   (与 titlebar 读 build/iconfntv.png 同一套路径约定：开发态=项目根/打包态=asar 虚拟根)。
// 持久化：localStorage 'fntvLogo.custom' = {type:'default'|'preset'|'custom', presetId?}；
//   自定义上传的 dataURL 存 'fntvLogo.customData'(≤1.5MB 原图 → dataURL ≈2MB，localStorage 5MB 额度安全；
//   预读用户上传文件时超限直接拒绝并提示)。
// 注入方式：沿用 glassUI 的非侵入锚点(#fnos-appearance-ctrl 后挂) + MutationObserver 兜底 + 4s keepalive，
//   与设置面板 SPA 重建解耦。
// 实时预览：[lc-1046b] 一步到位 —— 点选预设=立即持久化+上到真实 #tb-logo+面板自动关闭（约 0.55s 展示），
//   无「保存」步骤、无残留遮罩（用户报障：旧两步式点选后遮罩挂着要再手点一下才关）。
//   ✕/ESC/点空白=仅关闭面板（选择已生效）。白色主体的 logo(Disney+/Prime/芒果/HBO Max 字标/Hulu/Peacock)
//   在 chips 与预览区都垫深色底，并给「适合深色背景」提示。
// 与 titlebar 的关系：titlebar import 本模块取 resolveLogoSrc()（单向依赖，本模块绝不 import titlebar，
//   直接操作 #tb-logo DOM）；默认 logo 的 dataURI 由 titlebar 调 registerDefaultLogo() 登记。
// ─────────────────────────────────────────────────────────────────────────────
import * as fs from 'fs';
import * as path from 'path';
import { registerHook } from '../core/hooks';
import { HookType } from '../core/hooks';
import logger from '../core/logger';

const log = logger;

const STORAGE_KEY = 'fntvLogo.custom';
const CUSTOM_DATA_KEY = 'fntvLogo.customData';
/** 上传体积上限：原始文件 1.5MB（dataURL ≈ 2MB，localStorage 单源安全）。 */
const MAX_UPLOAD_BYTES = 1.5 * 1024 * 1024;
/** 预设 PNG 目录（编译后 __dirname = dest/preload/plugins → 项目根/resource/logos，打包态=asar 根）。 */
const PRESET_DIR = path.resolve(__dirname, '../../../resource/logos');

export interface LogoChoice { type: 'default' | 'preset' | 'custom'; presetId?: string; }
interface PresetLogo { id: string; name: string; file: string; group: '国内平台' | '国际平台'; lightBody?: boolean; }

/** 内置预设清单（与 resource/logos/ 一一对应；lightBody=官方形态即白色主体，需深色背景才看得清）。 */
export const PRESETS: PresetLogo[] = [
  { id: 'cn_iqiyi', name: '爱奇艺', file: 'cn_iqiyi.png', group: '国内平台' },
  { id: 'cn_tencent', name: '腾讯视频', file: 'cn_tencent.png', group: '国内平台' },
  { id: 'cn_youku', name: '优酷', file: 'cn_youku.png', group: '国内平台' },
  { id: 'cn_mango', name: '芒果TV', file: 'cn_mango.png', group: '国内平台', lightBody: true },
  { id: 'cn_migu', name: '咪咕视频', file: 'cn_migu.png', group: '国内平台' },
  { id: 'cn_xigua', name: '西瓜视频', file: 'cn_xigua.png', group: '国内平台' },
  { id: 'cn_bilibili', name: '哔哩哔哩', file: 'cn_bilibili.png', group: '国内平台' },
  { id: 'intl_netflix', name: 'Netflix', file: 'intl_netflix.png', group: '国际平台' },
  { id: 'intl_disneyplus', name: 'Disney+', file: 'intl_disneyplus.png', group: '国际平台', lightBody: true },
  { id: 'intl_disney', name: 'Disney', file: 'intl_disney.png', group: '国际平台' },
  { id: 'intl_prime', name: 'Prime Video', file: 'intl_prime.png', group: '国际平台', lightBody: true },
  { id: 'intl_hbomax', name: 'HBO Max', file: 'intl_hbomax.png', group: '国际平台' },
  { id: 'intl_hbomax_word', name: 'HBO Max 字标', file: 'intl_hbomax_word.png', group: '国际平台', lightBody: true },
  { id: 'intl_hbo', name: 'HBO', file: 'intl_hbo.png', group: '国际平台' },
  { id: 'intl_appletv', name: 'Apple TV+', file: 'intl_appletv.png', group: '国际平台' },
  { id: 'intl_hulu', name: 'Hulu', file: 'intl_hulu.png', group: '国际平台', lightBody: true },
  { id: 'intl_peacock', name: 'Peacock', file: 'intl_peacock.png', group: '国际平台', lightBody: true },
  { id: 'intl_paramount', name: 'Paramount+', file: 'intl_paramount.png', group: '国际平台' },
  { id: 'intl_youtube', name: 'YouTube', file: 'intl_youtube.png', group: '国际平台' },
  { id: 'intl_spotify', name: 'Spotify', file: 'intl_spotify.png', group: '国际平台' },
  { id: 'intl_twitch', name: 'Twitch', file: 'intl_twitch.png', group: '国际平台' },
  { id: 'intl_crunchyroll', name: 'Crunchyroll', file: 'intl_crunchyroll.png', group: '国际平台' },
  { id: 'intl_vimeo', name: 'Vimeo', file: 'intl_vimeo.png', group: '国际平台' },
  { id: 'intl_dailymotion', name: 'Dailymotion', file: 'intl_dailymotion.png', group: '国际平台' },
];

// ── dataURI 解析（同步 fs 读 + 内存缓存；读不到返回 ''）──
const _presetCache = new Map<string, string>();
let _defaultLogoUri = '';

/** titlebar 启动时登记默认 logo（build/iconfntv.png 的 dataURI），「恢复默认」据此还原。 */
export function registerDefaultLogo(uri: string): void {
  if (uri) _defaultLogoUri = uri;
}

function presetDataUri(p: PresetLogo): string {
  if (_presetCache.has(p.id)) return _presetCache.get(p.id) as string;
  try {
    const buf = fs.readFileSync(path.join(PRESET_DIR, p.file));
    const uri = 'data:image/png;base64,' + buf.toString('base64');
    _presetCache.set(p.id, uri);
    return uri;
  } catch (e) {
    log.warn('[customLogo] 预设读取失败:', p.file, String(e).substring(0, 80));
    return '';
  }
}

export function getChoice(): LogoChoice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { type: 'default' };
    const j = JSON.parse(raw);
    if (j && (j.type === 'default' || j.type === 'preset' || j.type === 'custom')) return j as LogoChoice;
  } catch { /* ignore */ }
  return { type: 'default' };
}

function setChoice(c: LogoChoice): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(c)); } catch (e) { log.warn('[customLogo] 持久化失败', String(e).substring(0, 80)); }
}

/** 按选项解析 logo dataURI；default → 登记的默认图，preset → 预设文件，custom → localStorage dataURL。 */
export function resolveLogoSrc(choice?: LogoChoice): string {
  const c = choice || getChoice();
  if (c.type === 'preset' && c.presetId) {
    const p = PRESETS.find((x) => x.id === c.presetId);
    return p ? presetDataUri(p) : '';
  }
  if (c.type === 'custom') {
    try { return localStorage.getItem(CUSTOM_DATA_KEY) || ''; } catch { return ''; }
  }
  return _defaultLogoUri;
}

/** 把当前选项实时上到真实 #tb-logo（titlebar 的 4s 守卫复用同一元素，src 换上即持续生效）。 */
export function applyLogoToDom(choice?: LogoChoice): void {
  const img = document.getElementById('tb-logo') as HTMLImageElement | null;
  if (!img) return;
  const src = resolveLogoSrc(choice);
  if (src && img.src !== src) img.src = src;
}

// ── 设置卡片（外观区锚点注入，glassUI 同款模式）──

function currentLabel(): string {
  const c = getChoice();
  if (c.type === 'custom') return '自定义上传';
  if (c.type === 'preset') {
    const p = PRESETS.find((x) => x.id === c.presetId);
    return p ? '预设 · ' + p.name : '预设（已失效）';
  }
  return '默认（飞牛影视）';
}

function currentThumbUri(): string {
  return resolveLogoSrc();
}

function mkSmallBtn(text: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.style.cssText = 'border:none;cursor:pointer;border-radius:8px;padding:6px 12px;font-size:11.5px;font-weight:600;'
    + 'background:var(--fnos-ui-btn-bg,rgba(150,120,200,.12));color:var(--fnos-ui-btn-text,#5c4d7d);'
    + 'transition:background .15s;';
  b.addEventListener('mouseenter', () => { b.style.background = 'var(--fnos-ui-btn-hover,rgba(183,155,232,.32))'; });
  b.addEventListener('mouseleave', () => { b.style.background = 'var(--fnos-ui-btn-bg,rgba(150,120,200,.12))'; });
  return b;
}

/** 深色展示底（白色主体的 logo 在浅色 UI 上看不见，统一垫深色 + 细微棋盘感）。 */
const CHIP_BG = 'linear-gradient(165deg,rgba(28,24,38,.88),rgba(18,15,26,.92))';

function refreshCard(): void {
  const card = document.getElementById('fntv-logo-ctrl');
  if (!card) return;
  const label = card.querySelector('#fntv-logo-cur-label') as HTMLElement | null;
  const thumb = card.querySelector('#fntv-logo-cur-thumb') as HTMLImageElement | null;
  if (label) label.textContent = currentLabel();
  if (thumb) {
    const uri = currentThumbUri();
    if (uri) { thumb.src = uri; thumb.style.display = 'block'; }
    else thumb.style.display = 'none';
  }
}

function buildCard(): HTMLElement {
  const block = document.createElement('div');
  block.id = 'fntv-logo-ctrl';
  block.style.cssText = 'margin-top:18px;padding-top:14px;border-top:1px solid var(--fnos-ui-border,rgba(150,120,200,.14));'
    + 'display:flex;flex-direction:column;';

  const title = document.createElement('div');
  title.style.cssText = 'font-size:13px;font-weight:700;letter-spacing:.5px;margin-bottom:4px;color:var(--fnos-ui-text,#4a3d63);';
  title.textContent = '自定义 Logo';
  const sub = document.createElement('div');
  sub.style.cssText = 'font-size:11px;line-height:1.5;margin-bottom:10px;color:var(--fnos-ui-muted2,#8778a5);';
  sub.textContent = '替换首页顶部居中的「飞牛影视」标识（仅首页显示）。可选内置平台预设或上传自己的图片。';
  block.appendChild(title);
  block.appendChild(sub);

  // 当前行：深色底缩略图 + 文本
  const cur = document.createElement('div');
  cur.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:10px;';
  const thumbWrap = document.createElement('div');
  thumbWrap.style.cssText = 'width:86px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;'
    + 'background:' + CHIP_BG + ';';
  const thumb = document.createElement('img');
  thumb.id = 'fntv-logo-cur-thumb';
  thumb.alt = '';
  thumb.draggable = false;
  thumb.style.cssText = 'max-width:72px;max-height:24px;object-fit:contain;display:block;';
  thumbWrap.appendChild(thumb);
  const curLabel = document.createElement('span');
  curLabel.id = 'fntv-logo-cur-label';
  curLabel.style.cssText = 'font-size:12px;font-weight:600;color:var(--fnos-ui-text,#4a3d63);';
  cur.appendChild(thumbWrap);
  cur.appendChild(curLabel);
  block.appendChild(cur);

  // 操作行
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
  const presetBtn = mkSmallBtn('选择预设');
  const uploadBtn = mkSmallBtn('上传自定义');
  const resetBtn = mkSmallBtn('恢复默认');
  row.appendChild(presetBtn);
  row.appendChild(uploadBtn);
  row.appendChild(resetBtn);
  block.appendChild(row);

  const showUploadError = (msg: string): void => {
    uploadBtn.textContent = '⚠ ' + msg;
    window.setTimeout(() => { uploadBtn.textContent = '上传自定义'; }, 3500);
  };

  // 上传：隐藏 file input（图片 ≤1.5MB，dataURL 进 localStorage）
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/png,image/jpeg,image/webp,image/svg+xml';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = ''; // 允许重复选择同一文件
    if (!f) return;
    const preErr = setCustomFromFile(f);
    if (preErr) { showUploadError(preErr); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const err = applyCustomDataUrl(String(reader.result || ''));
      if (err) showUploadError(err);
    };
    reader.onerror = () => showUploadError('读取文件失败');
    reader.readAsDataURL(f);
  });
  uploadBtn.addEventListener('click', () => fileInput.click());
  presetBtn.addEventListener('click', () => openPresetPanel());
  resetBtn.addEventListener('click', () => { resetToDefault(); });
  block.appendChild(fileInput);

  return block;
}

/** 上传预校验（类型/体积）。返回错误文案，null=通过（实际读取由 FileReader 完成后走 applyCustomDataUrl）。 */
export function setCustomFromFile(f: File): string | null {
  if (!f.type || !f.type.startsWith('image/')) return '仅支持图片文件';
  if (f.size > MAX_UPLOAD_BYTES) return '文件超过 1.5MB';
  return null;
}

/** 真正落盘+应用（上传 change 回调读出 dataURL 后调用；独立导出便于验证）。 */
export function applyCustomDataUrl(dataUrl: string): string | null {
  if (!/^data:image\//.test(dataUrl || '')) return '不是有效的图片';
  if (dataUrl.length > MAX_UPLOAD_BYTES * 1.4) return '文件超过 1.5MB';
  try { localStorage.setItem(CUSTOM_DATA_KEY, dataUrl); } catch (e) { return '图片过大，存储失败'; }
  setChoice({ type: 'custom' });
  applyLogoToDom();
  refreshCard();
  return null;
}

export function resetToDefault(): void {
  try { localStorage.removeItem(CUSTOM_DATA_KEY); } catch { /* ignore */ }
  setChoice({ type: 'default' });
  applyLogoToDom();
  refreshCard();
}

// ── 预设选择弹窗（[lc-1046b] 一步到位：点选预设=立即持久化+上真 logo+自动关面板，
//    无「保存」步骤 —— 用户报障：旧两步式点选后遮罩一直挂着要再手点一下才关）──

let _panelOpen = false;
let _closeTimer = 0;

function closePresetPanel(): void {
  if (_closeTimer) { clearTimeout(_closeTimer); _closeTimer = 0; }
  const ov = document.getElementById('fntv-logo-preset-panel');
  if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
  _panelOpen = false;
  document.removeEventListener('keydown', onKeydown, true);
}

function _panelEsc(e: KeyboardEvent): void {
  if (e.key === 'Escape' && _panelOpen) { e.stopPropagation(); closePresetPanel(); }
}

function onKeydown(e: KeyboardEvent): void { _panelEsc(e); }

export function openPresetPanel(): void {
  if (_panelOpen) return;
  _panelOpen = true;
  const curId = getChoice().type === 'preset' ? (getChoice().presetId || null) : null;

  const ov = document.createElement('div');
  ov.id = 'fntv-logo-preset-panel';
  ov.style.cssText = 'position:fixed;inset:0;z-index:2147483601;display:flex;align-items:center;justify-content:center;'
    + 'background:rgba(18,14,28,.45);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);'
    + '-webkit-app-region:no-drag;app-region:no-drag;';
  ov.addEventListener('click', (e) => { if (e.target === ov) closePresetPanel(); });

  const panel = document.createElement('div');
  panel.style.cssText = 'width:min(660px,calc(100vw - 80px));max-height:80vh;overflow:hidden;display:flex;flex-direction:column;'
    + 'border-radius:18px;background:var(--fnos-ui-panel-bg,linear-gradient(165deg,rgba(252,247,253,.97),rgba(244,238,251,.98)));'
    + 'color:var(--fnos-ui-text,#4a3d63);box-shadow:0 18px 50px rgba(80,60,120,.30),inset 0 0 0 1px rgba(255,255,255,.22);';

  // 头部
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:14px 16px 10px;flex-shrink:0;';
  const htitle = document.createElement('span');
  htitle.textContent = '选择预设 Logo';
  htitle.style.cssText = 'font-size:15px;font-weight:700;letter-spacing:.3px;';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'border:none;cursor:pointer;background:var(--fnos-ui-btn-bg,rgba(150,120,200,.12));color:var(--fnos-ui-btn-text2,#7a6a9a);'
    + 'width:30px;height:30px;border-radius:9px;font-size:14px;font-weight:700;';
  closeBtn.addEventListener('click', () => closePresetPanel());
  head.appendChild(htitle);
  head.appendChild(closeBtn);
  panel.appendChild(head);

  // 实时预览条：点选预设立即上到真实 #tb-logo，同时这里放大展示
  const preview = document.createElement('div');
  preview.style.cssText = 'display:flex;align-items:center;gap:12px;margin:0 16px 12px;padding:10px 12px;border-radius:12px;flex-shrink:0;'
    + 'background:var(--fnos-ui-input-bg,rgba(255,255,255,.5));';
  const pvChip = document.createElement('div');
  pvChip.id = 'fntv-logo-pv-chip';
  pvChip.style.cssText = 'width:150px;height:52px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;'
    + 'background:' + CHIP_BG + ';';
  const pvImg = document.createElement('img');
  pvImg.id = 'fntv-logo-pv-img';
  pvImg.alt = '';
  pvImg.draggable = false;
  pvImg.style.cssText = 'max-width:126px;max-height:36px;object-fit:contain;';
  pvChip.appendChild(pvImg);
  const pvText = document.createElement('div');
  pvText.style.cssText = 'display:flex;flex-direction:column;gap:3px;min-width:0;';
  const pvName = document.createElement('div');
  pvName.id = 'fntv-logo-pv-name';
  pvName.style.cssText = 'font-size:13px;font-weight:700;';
  const pvHint = document.createElement('div');
  pvHint.id = 'fntv-logo-pv-hint';
  pvHint.style.cssText = 'font-size:11px;line-height:1.45;color:var(--fnos-ui-muted2,#8778a5);';
  pvText.appendChild(pvName);
  pvText.appendChild(pvHint);
  preview.appendChild(pvChip);
  preview.appendChild(pvText);
  panel.appendChild(preview);

  // 预设网格（国内/国际两节）
  const scroll = document.createElement('div');
  scroll.style.cssText = 'overflow-y:auto;padding:0 16px 8px;flex:1 1 auto;min-height:0;';
  const updatePreview = (p: PresetLogo | null): void => {
    const uri = p ? presetDataUri(p) : '';
    if (uri) { pvImg.src = uri; pvImg.style.display = 'block'; } else pvImg.style.display = 'none';
    pvName.textContent = p ? p.name : '未选择';
    pvHint.textContent = p
      ? (p.lightBody ? '已应用 ✓（白色主体 logo，建议深色背景使用）' : '已应用 ✓')
      : '点击下方任意预设，立即生效并自动关闭。';
  };
  const groups: PresetLogo['group'][] = ['国内平台', '国际平台'];
  for (const g of groups) {
    const secT = document.createElement('div');
    secT.textContent = g;
    secT.style.cssText = 'font-size:11.5px;font-weight:600;letter-spacing:.4px;color:var(--fnos-ui-sec,#9575cd);margin:8px 0 8px;';
    scroll.appendChild(secT);
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(128px,1fr));gap:10px;';
    for (const p of PRESETS.filter((x) => x.group === g)) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.dataset.presetId = p.id;
      chip.style.cssText = 'cursor:pointer;border:2px solid transparent;border-radius:12px;padding:10px 8px 8px;'
        + 'display:flex;flex-direction:column;align-items:center;gap:6px;background:' + CHIP_BG + ';'
        + 'transition:border-color .15s,transform .15s;';
      const img = document.createElement('img');
      img.alt = p.name;
      img.draggable = false;
      const uri = presetDataUri(p);
      if (uri) img.src = uri;
      img.style.cssText = 'max-width:104px;max-height:34px;object-fit:contain;';
      const nm = document.createElement('span');
      nm.textContent = p.name + (p.lightBody ? ' ⚪' : '');
      nm.style.cssText = 'font-size:11px;font-weight:600;color:rgba(255,255,255,.82);';
      nm.title = p.lightBody ? '白色主体 logo，适合深色背景' : p.name;
      chip.appendChild(img);
      chip.appendChild(nm);
      if (p.id === curId) chip.style.borderColor = 'var(--fnos-ui-accent,#b79be8)';
      chip.addEventListener('mouseenter', () => { chip.style.transform = 'translateY(-1px)'; });
      chip.addEventListener('mouseleave', () => { chip.style.transform = ''; });
      chip.addEventListener('click', () => {
        // [lc-1046b] 一步到位：点选=持久化+上真 logo+刷新卡片，短暂停留展示结果后面板自动关闭
        setChoice({ type: 'preset', presetId: p.id });
        applyLogoToDom();
        refreshCard();
        for (const el of Array.from(grid.children) as HTMLElement[]) el.style.borderColor = 'transparent';
        chip.style.borderColor = 'var(--fnos-ui-accent,#b79be8)';
        updatePreview(p);
        if (_closeTimer) clearTimeout(_closeTimer);
        _closeTimer = window.setTimeout(() => { _closeTimer = 0; closePresetPanel(); }, 550);
      });
      grid.appendChild(chip);
    }
    scroll.appendChild(grid);
  }
  panel.appendChild(scroll);

  // 底部提示（无「保存/取消」步骤 —— 点选即生效并自动关闭，✕/ESC/点空白=仅关闭）
  const foot = document.createElement('div');
  foot.style.cssText = 'padding:10px 16px 14px;flex-shrink:0;font-size:11px;color:var(--fnos-ui-muted2,#8778a5);';
  foot.textContent = '点击预设立即生效并自动关闭；当前选择会记住，可随时回来换或「恢复默认」。';
  panel.appendChild(foot);

  ov.appendChild(panel);
  document.body.appendChild(ov);
  document.addEventListener('keydown', onKeydown, true);

  // 初始预览：当前选中项（或提示未选择）
  updatePreview(PRESETS.find((x) => x.id === curId) || null);
}

// ── 锚点注入（glassUI 同款：观察器 + keepalive）──

function tryInjectCard(): boolean {
  const anchor = document.getElementById('fnos-appearance-ctrl');
  if (!anchor || !anchor.parentElement) return false;
  if (anchor.parentElement.querySelector('#fntv-logo-ctrl')) return true;
  anchor.parentElement.insertBefore(buildCard(), anchor.nextSibling);
  refreshCard();
  log.info('[customLogo] 设置卡片已注入');
  return true;
}

function handle(): void {
  if (!tryInjectCard()) {
    const target = document.body || document.documentElement;
    const obs = new MutationObserver(() => {
      if (tryInjectCard()) obs.disconnect();
    });
    obs.observe(target, { childList: true, subtree: true });
  }
  // 设置面板被 SPA 重建后补回（极廉价查询）
  window.setInterval(() => { try { tryInjectCard(); } catch { /* ignore */ } }, 4000);
}

registerHook(HookType.OnReady, handle);
export {};
