// embyWall/detail/jav.ts — [v1.10.x] JAV 番号刮削（个人库整理，设置卡默认关闭）。
// ─────────────────────────────────────────────────────────────────────────────
// 背景：JAV 文件飞牛原生刮削基本瞎匹配（标题=文件名、海报错乱）。文件名里的番号
//（ABC-123 / FC2-PPV-1234567）是天然匹配键 → 后端 jav/lookup（javbus 抓取，jav.go）
// 按番号取 标题/封面/日期/类别/演员，本模块在电影详情页提供「⟳ jav 刮削」按钮：
//   1) getEditDetail 读条目 → 标题里提取番号（后端同款正则，前端只透传标题）；
//   2) 查询成功 → saveEditDetail 回写 title（title_locked 防飞牛再刮削覆盖，仿 epBackfill）；
//   3) 封面经 jav:image 代理取回 dataURL，就地替换 hero 海报（纯前端视觉，不写服务端——
//      fnOS posters 字段为数组结构，写回格式未抓包验证，宁缺勿错）；
//   4) 按钮状态机反馈（未识别番号 / 查询失败 / 已回填），详情进日志。
// 挂载：body 级浮动胶囊按钮（仅 /v/movie/<guid> 路由 + S.javEnabled 开启时出现），
// 与 epBackfill/customScraper 同一批导航钩子调度（embyWall.ts scheduleJavButton）。
// ─────────────────────────────────────────────────────────────────────────────
import { ipcRenderer } from 'electron';
import { dlog, log } from '../log';
import { S } from '../state';
import { findActiveDetailView, findDetailHero } from './glass';
import { fnosGetEditDetail } from '../carousel/logo';
import { fnosSaveEditDetail } from './epBackfill';

const JAV_BTN_ID = 'fnos-jav-btn';
let _running = false;

/** 电影详情路由 guid（/v/movie/<32hex>）。 */
export function movieGuid(): string | null {
  const m = location.pathname.match(/\/v\/movie\/([a-f0-9]{32})/);
  return m ? m[1] : null;
}

function fnNonce(): string {
  return String(Math.floor(Math.random() * 900000) + 100000);
}

function setBtn(btn: HTMLElement, text: string, title?: string): void {
  btn.textContent = text;
  if (title !== undefined) btn.setAttribute('title', title);
}

/** hero 海报挑选（backdrop.ts cacheHeroImages 同启发式：竖版 200~400 高、宽 <300）。 */
function heroPosterImg(): HTMLImageElement | null {
  const view = findActiveDetailView();
  if (!view) return null;
  const hero = findDetailHero(view);
  if (!hero) return null;
  return Array.from(hero.querySelectorAll('img'))
    .filter((im) => (im.currentSrc || im.src) && im.offsetHeight >= 200 && im.offsetHeight <= 400 && im.offsetWidth < 300)[0] || null;
}

function makeBtn(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = JAV_BTN_ID;
  btn.textContent = '⟳ jav 刮削';
  btn.setAttribute('title', '从文件名番号在 javbus 查询并回填标题（封面就地替换，仅本地视觉）。设置→自定义刮削→Jav 刮削 开关。');
  btn.style.cssText = 'position:fixed;right:18px;bottom:26px;z-index:2147483500;display:inline-flex;align-items:center;'
    + 'padding:7px 14px;border-radius:999px;font-size:11.5px;font-weight:600;cursor:pointer;letter-spacing:.3px;'
    + 'background:rgba(28,24,40,.82)!important;color:#e7e2f5;border:1px solid rgba(255,255,255,.16);'
    + 'box-shadow:0 6px 18px rgba(10,8,20,.35);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);'
    + 'transition:background .15s,transform .15s;user-select:none;';
  btn.setAttribute('data-fnos-ui', '1'); // 白底清除器保护
  // 行内 !important（行内压过样式表 !important）：页面背景自定义/玻璃的 body>div 清透规则
  // 都会把无 important 的行内底色清成全透，浮层按钮必须保住自身底色
  btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(52,44,76,.9)!important'; });
  btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(28,24,40,.82)!important'; });
  btn.addEventListener('click', (e: Event) => { e.preventDefault(); e.stopPropagation(); void runJav(btn); });
  document.body.appendChild(btn);
  return btn;
}

/** 幂等挂载：电影路由 + 开启 → 确保按钮在；否则撤按钮。 */
export function ensureJavButton(): void {
  if (!S.javEnabled || !movieGuid()) { removeJavButton(); return; }
  const existing = document.getElementById(JAV_BTN_ID);
  if (existing && existing.isConnected) return;
  makeBtn();
  dlog('[jav] 按钮已挂载 ' + location.pathname);
}

export function removeJavButton(): void {
  const b = document.getElementById(JAV_BTN_ID);
  if (b && b.parentNode) b.parentNode.removeChild(b);
}

/** 导航钩子调用：离开页面立即撤按钮，进电影页时挂。 */
export function scheduleJavButton(): void {
  ensureJavButton();
}

/** 自举：模块加载即拉一次设置同步 S.javEnabled（不依赖用户打开设置面板）。 */
try {
  ipcRenderer.invoke('settings:get').then((s: any) => {
    if (!s || typeof s !== 'object') return;
    S.javEnabled = s.javEnabled === true;
    if (S.javEnabled && movieGuid()) ensureJavButton();
  }).catch(() => { /* ignore */ });
} catch { /* ignore */ }

/** 主流程：读条目 → javbus 查询 → 回填标题（locked）→ 封面替换 hero 海报。 */
async function runJav(btn: HTMLButtonElement): Promise<void> {
  const guid = movieGuid();
  if (!guid || _running) return;
  _running = true;
  const origin = location.origin;
  try {
    // 1) 读条目（取当前标题供番号提取）
    const data = await fnosGetEditDetail(origin, guid);
    if (!data) throw new Error('读取条目失败（getEditDetail）');
    const curTitle = String(data.title || data.name || '').trim();

    // 2) javbus 查询（番号提取在后端：code 优先、标题兜底）
    setBtn(btn, '⏳ jav 查询中…');
    const r: any = await ipcRenderer.invoke('jav:lookup', { title: curTitle, guid });
    if (!r || !r.ok) {
      const err = String((r && r.error) || '查询失败');
      const noCode = err.indexOf('番号') >= 0;
      setBtn(btn, noCode ? '⚠ 未识别番号' : '⚠ javbus 失败', err);
      window.setTimeout(() => { if (btn.isConnected) setBtn(btn, '⟳ jav 刮削'); }, 5000);
      return;
    }
    const meta = r.meta || {};
    log('[jav] 命中 ' + meta.code + '：' + (meta.title || '')
      + (Array.isArray(meta.actresses) && meta.actresses.length
        ? ' / ' + meta.actresses.map((a: any) => a && a.name).filter(Boolean).join('・') : '')
      + (meta.date ? ' / ' + meta.date : ''));

    // 3) 回填标题（全量读改写 + title_locked，仿 epBackfill 防再刮削覆盖）
    const newTitle = String(meta.title || '').trim();
    if (!newTitle) throw new Error('返回标题为空');
    let saved = false;
    if (newTitle !== curTitle) {
      const titleKey = ('title' in data) ? 'title' : (('name' in data) ? 'name' : 'title');
      const body: any = { ...data, nonce: fnNonce() };
      if (!body.guid && !body.item_guid) body.guid = guid;
      body[titleKey] = newTitle;
      body.title_locked = true;
      saved = await fnosSaveEditDetail(origin, body);
      if (saved) {
        // 复核：读不回新标题 → 如实按失败计（数据可能未落盘）
        const vf = await fnosGetEditDetail(origin, guid);
        saved = !!vf && String(vf[titleKey] ?? '').trim() === newTitle;
      }
      if (!saved) dlog('[jav] 标题写回未确认（可能字段名/权限不符），封面仍替换');
    } else {
      saved = true; // 标题已一致，无需写
    }

    // 4) 封面就地替换 hero 海报（仅本地视觉；服务端 posters 写回格式未验证，不写）
    let coverOk = false;
    if (meta.cover) {
      try {
        const img: any = await ipcRenderer.invoke('jav:image', { url: meta.cover });
        if (img && img.ok && img.dataUrl) {
          const poster = heroPosterImg();
          if (poster) { poster.src = img.dataUrl; coverOk = true; }
        }
      } catch (e) { dlog('[jav] 封面获取失败: ' + String(e).substring(0, 80)); }
    }

    // 5) 按钮反馈
    const who = Array.isArray(meta.actresses) && meta.actresses.length
      ? ' · ' + meta.actresses.map((a: any) => a && a.name).filter(Boolean).slice(0, 3).join('・') : '';
    if (saved) {
      setBtn(btn, '✓ 已回填' + (coverOk ? ' + 封面' : ''), meta.code + ' ' + (meta.date || '') + who
        + (coverOk ? '' : '（封面未替换：hero 内未找到海报位）'));
    } else {
      setBtn(btn, '⚠ 回填失败', '标题写回未确认，详见日志；封面/查询数据不受影响。');
    }
    window.setTimeout(() => { if (btn.isConnected) setBtn(btn, '⟳ jav 刮削'); }, 6000);
  } catch (e: any) {
    log('[jav] 失败: ' + String(e && e.message || e).substring(0, 100));
    setBtn(btn, '⚠ ' + String(e && e.message || e).substring(0, 24), String(e && e.message || e));
    window.setTimeout(() => { if (btn.isConnected) { setBtn(btn, '⟳ jav 刮削'); } }, 5000);
  } finally {
    _running = false;
  }
}
