// embyWall/detail/folderScraper.ts — [v1.13.0] 个人视频文件夹（other 库）自定义刮削
// ─────────────────────────────────────────────────────────────────────────────
// 背景：个人视频库（/v/list/other）的文件夹页（/v/folder/fv_<32hex>）里的文件条目
//       （番号视频 / strm 等）飞牛原生刮削基本瞎匹配。季页「⟳ 自定义刮削」在本页
//       两头落空——seasonGuid() 不认 /v/folder/ 路由，「选集」标题锚点也不存在
//       → 独立成模块，挂载方式取 jav.ts 的 body 级浮动胶囊（不依赖飞牛内部 DOM）：
//   1) 文件夹页浮动胶囊按钮「⟳ 文件夹刮削」；
//   2) item/list(parent_guid=<文件夹guid>, exclude_folder:1) 枚举本文件夹文件条目
//      （分页取全，个人文件夹可能有上百个文件）；
//   3) POST 自定义刮削服务（复用 customScraperUrl，协议为季集请求的文件夹扩展）：
//      { mode:'folder', title:文件夹名, folderGuid, items/episodes:[{index,guid,name}] }
//      —— name=条目当前标题（即文件名，番号匹配键，季集请求没有的扩展字段）；
//      响应兼容 {episodes|items|data:[{index|name, title?, overview?}]}，
//      匹配顺序：name 归一化匹配 > index 匹配；
//   4) 逐项 getEditDetail 读全量 → decideField 裁决（空值填入/占位可覆盖/中文覆盖
//      英文，绝不倒打已有中文）→ saveEditDetail 全量回写（*_locked 字段锁）→
//      读回复核 → DOM 即时补丁（a[href*="<guid>"] 通配——本页卡片链接不一定是
//      /v/tv/episode/，季页 patchEpisodeCard 的选择器在此不命中，故单独实现）。
// 开关与地址复用 customScraperEnabled / customScraperUrl（同一个自建服务，不加新配置）。
// 挂载调度：embyWall.ts 三处导航钩子 + 模块加载自举——文件夹页不满足 isDetailPage()，
//   初始/深链直达时导航钩子不重放，必须无条件调度一次（函数内部自判路由）。
// ─────────────────────────────────────────────────────────────────────────────
import { ipcRenderer } from 'electron';
import { dlog, log } from '../log';
import { S } from '../state';
import { ACTIVE_VIEW_SEL } from './glass';
import { fnosGetEditDetail } from '../carousel/logo';
import { decideField, numOrNull, setBtn, isPlaceholderTitle, fnosSaveEditDetail } from './epBackfill';

const FOLDER_BTN_ID = 'fnos-folder-scraper-btn';
const CONCURRENCY = 4;
const MAX_PAGES = 10;
const PAGE_SIZE = 1000;
let _running = false;

/** 文件夹页路由 id（/v/folder/<id>，实测形如 fv_<32hex>；放宽为字母数字下划线容忍后续前缀）。 */
export function folderGuid(): string | null {
  const m = location.pathname.match(/\/v\/folder\/([A-Za-z0-9_]+)/);
  return m ? m[1] : null;
}

function fnNonce(): string {
  return String(Math.floor(Math.random() * 900000) + 100000);
}

/** item/list POST（与 epBackfill.fnosPost 同款：Authx 签名 + cookie；此处独立成局部函数便于双端移植）。 */
async function fnosPost(origin: string, path: string, body: any): Promise<any | null> {
  const authx = await ipcRenderer.invoke('fnos-gen-authx', path, body).catch(() => '');
  const resp = await fetch(origin + path, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(authx ? { Authx: authx } : {}) },
    body: JSON.stringify(body),
  });
  if (!resp.ok) { dlog('[folderScraper] POST ' + path + ' HTTP ' + resp.status); return null; }
  const j = await resp.json().catch(() => null);
  if (!j || j.code !== 0) { dlog('[folderScraper] POST ' + path + ' 业务失败 ' + JSON.stringify(j).substring(0, 160)); return null; }
  return j.data || null;
}

interface FolderItem { guid: string; name: string; index: number | null; }

/** 枚举文件夹内文件条目（exclude_folder:1 只留文件，子文件夹请进入后逐层刮削）。 */
async function fnosFolderItems(origin: string, fGuid: string): Promise<FolderItem[]> {
  const out: FolderItem[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await fnosPost(origin, '/v/api/v1/item/list', {
      parent_guid: fGuid, exclude_folder: 1,
      sort_column: 'sort_title', sort_type: 'ASC',
      page, page_size: PAGE_SIZE, nonce: fnNonce(),
    });
    const list = data && Array.isArray((data as any).list) ? (data as any).list : [];
    for (const it of list) {
      if (!it || !it.guid) continue;
      if (String(it.type || '').toLowerCase() === 'folder') continue;
      const name = String(it.title ?? it.name ?? '').trim();
      if (!name) continue;
      out.push({ guid: String(it.guid), name, index: numOrNull(it.index_number ?? it.index) });
    }
    if (list.length < PAGE_SIZE) break;
  }
  return out;
}

/** 文件名匹配键：去扩展名 + 去分隔符/空白 + 小写（SNOS-332-UC.mp4 → snos332uc）。 */
function normName(s: string): string {
  return String(s || '').toLowerCase().replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[\s._\-–—]+/g, '');
}

interface ScrapeHit { index: number | null; name: string | null; title: string | null; overview: string | null; }

/** 调自定义刮削服务（文件夹模式）。容错同 customScraper：响应数组键 items/episodes/data 任一，
 *  集号 index/episode/number 任一；name 回显键 filename/file/name（无 title 时）任一。 */
async function fetchFolderScrape(url: string, payload: any): Promise<ScrapeHit[]> {
  let j: any = null;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    j = await resp.json();
  } catch (e: any) {
    throw new Error('自定义刮削服务请求失败: ' + String(e && e.message || e).substring(0, 100));
  }
  const arr = j && (Array.isArray(j.items) ? j.items
    : Array.isArray(j.episodes) ? j.episodes
    : Array.isArray(j.data) ? j.data : null);
  if (!arr) throw new Error('响应缺少 items/episodes 数组');
  const out: ScrapeHit[] = [];
  arr.forEach((e: any, i: number) => {
    if (!e || typeof e !== 'object') return;
    const index = numOrNull(e.index ?? e.episode ?? e.number);
    const name = (e.filename ?? e.file ?? (e.title == null ? e.name : null));
    out.push({
      index: index ?? (i + 1),
      name: name != null ? String(name).trim() : null,
      title: (e.title ?? e.name) != null ? String(e.title ?? e.name).trim() : null,
      overview: (e.overview ?? e.description) != null ? String(e.overview ?? e.description).trim() : null,
    });
  });
  return out;
}

/** 归一化 name 匹配 > index 匹配。 */
function matchFor(item: FolderItem, byName: Map<string, ScrapeHit>, byIndex: Map<number, ScrapeHit>): ScrapeHit | undefined {
  const nk = normName(item.name);
  if (nk && byName.has(nk)) return byName.get(nk);
  if (item.index !== null && byIndex.has(item.index)) return byIndex.get(item.index);
  return undefined;
}

/** 文件夹网格卡片即时补丁：条目链接形制不定（/v/movie/、播放直达等），用 href 含 guid 通配；
 *  视图定位不依赖 DETAIL_HERO_SEL（文件夹页 hero 不保证命中），直接找含该链接的活跃视图。
 *  文本节点补丁规则与 patchEpisodeCard 一致：标题只写首个文本节点（保清晰度胶囊 span）、
 *  简介只动「纯文本 p」，结构不符宁可不刷新也不冒改写风险。 */
function patchFolderCard(guid: string, title: string | null, overview: string | null): void {
  const views = document.querySelectorAll<HTMLElement>(ACTIVE_VIEW_SEL);
  for (let i = views.length - 1; i >= 0; i--) {
    const v = views[i];
    if (v.offsetParent === null) continue;
    const link = v.querySelector<HTMLAnchorElement>('a[href*="' + guid + '"]');
    if (!link) continue;
    const card = (link.closest('[data-id="details"]') as HTMLElement | null)
      || (link.parentElement as HTMLElement | null);
    if (!card) return;
    const titleP = (link.querySelector('p') as HTMLElement | null) || (card.querySelector('p') as HTMLElement | null);
    if (titleP && title !== null) {
      const tn = titleP.firstChild;
      if (tn && tn.nodeType === Node.TEXT_NODE) {
        if (tn.nodeValue !== title) tn.nodeValue = title;
      } else {
        titleP.insertBefore(document.createTextNode(title), titleP.firstChild);
      }
    }
    if (overview !== null) {
      const ps = Array.from(card.querySelectorAll('p')).filter((p) => p !== titleP);
      const ovP = ps.length ? ps[ps.length - 1] : null;
      if (ovP && ovP.children.length === 0) {
        const tn = ovP.firstChild;
        if (tn && tn.nodeType === Node.TEXT_NODE) {
          if (tn.nodeValue !== overview) tn.nodeValue = overview;
        } else if (!ovP.firstChild) {
          ovP.appendChild(document.createTextNode(overview));
        }
      }
    }
    return;
  }
}

/** 自定义刮削回填主流程（与 customScraper.runCustomScraper 同构：数据源同一服务，枚举换成文件夹）。 */
async function runFolderScraper(btn: HTMLButtonElement): Promise<void> {
  const guid = folderGuid();
  if (!guid || _running) return;
  const url = String(S.customScraperUrl || '').trim();
  if (!S.customScraperEnabled || !url) {
    setBtn(btn, '⚠ 未配置', '请到 侧栏设置 → 自定义刮削 → 自定义刮削源 开启并填写地址。');
    window.setTimeout(() => { if (btn.isConnected) setBtn(btn, '⟳ 文件夹刮削'); }, 5000);
    return;
  }
  _running = true;
  const origin = location.origin;
  const stats = { filled: 0, unchanged: 0, failed: 0, unmatched: 0, total: 0 };
  const tick = (): void => {
    const done = stats.filled + stats.unchanged + stats.failed + stats.unmatched;
    if (btn.isConnected) setBtn(btn, '⏳ 回填中 ' + done + '/' + stats.total);
  };
  try {
    // 0) 文件夹名（给服务尽可能多的上下文；getEditDetail 对 fv_ 文件夹 guid 若不可用则不致命）
    let folderTitle = '';
    const fd = await fnosGetEditDetail(origin, guid).catch(() => null);
    if (fd) folderTitle = String(fd.title || fd.name || '').trim();

    // 1) 枚举本文件夹文件条目
    const items = await fnosFolderItems(origin, guid);
    if (!items.length) {
      setBtn(btn, '⚠ 未枚举到文件', 'item/list 未返回本文件夹的文件条目（fv_ guid 可能不被接口接受），详见日志。');
      window.setTimeout(() => { if (btn.isConnected) setBtn(btn, '⟳ 文件夹刮削'); }, 6000);
      _running = false;
      return;
    }
    stats.total = items.length;

    // 2) 请求自定义刮削服务（items/episodes 双键同内容：老服务按 episodes 读也能拿到 name）
    setBtn(btn, '⏳ 请求刮削服务…');
    const hits = await fetchFolderScrape(url, {
      mode: 'folder', title: folderTitle, folderGuid: guid, guid,
      items, episodes: items,
    });
    const byName = new Map<string, ScrapeHit>();
    const byIndex = new Map<number, ScrapeHit>();
    for (const h of hits) {
      const nk = h.name ? normName(h.name) : '';
      if (nk && !byName.has(nk)) byName.set(nk, h);
      if (h.index !== null && !byIndex.has(h.index)) byIndex.set(h.index, h);
    }
    if (!byName.size && !byIndex.size) {
      setBtn(btn, '⚠ 服务无匹配数据', '自定义服务响应未携带可匹配的 name/index。');
      window.setTimeout(() => { if (btn.isConnected) setBtn(btn, '⟳ 文件夹刮削'); }, 5000);
      _running = false;
      return;
    }

    // 3) 逐项读全量 → 裁决合并 → 回写 → 复核 → DOM 补丁（管线与 customScraper 完全一致）
    let idx = 0;
    const worker = async (): Promise<void> => {
      while (idx < items.length) {
        const item = items[idx++];
        try {
          const ed = await fnosGetEditDetail(origin, item.guid);
          if (!ed) { stats.failed++; tick(); continue; }
          const m = matchFor(item, byName, byIndex);
          if (!m) { stats.unmatched++; tick(); continue; }
          const titleKey = ('title' in ed) ? 'title' : ('name' in ed ? 'name' : 'title');
          const ovKey = ('overview' in ed) ? 'overview' : ('description' in ed ? 'description' : 'overview');
          const curTitle = String(ed[titleKey] ?? '');
          const curOv = String(ed[ovKey] ?? '');
          const newTitle = decideField(curTitle, m.title ?? '', '', isPlaceholderTitle);
          const newOv = decideField(curOv, m.overview ?? '', '');
          if (newTitle === null && newOv === null) { stats.unchanged++; tick(); continue; }
          const body: any = { ...ed, nonce: fnNonce() };
          if (!body.guid && !body.item_guid) body.guid = item.guid;
          let titleChanged = false, ovChanged = false;
          if (newTitle !== null) { body[titleKey] = newTitle; body.title_locked = true; titleChanged = true; }
          if (newOv !== null) { body[ovKey] = newOv; body.overview_locked = true; ovChanged = true; }
          const saved = await fnosSaveEditDetail(origin, body);
          if (!saved) { stats.failed++; tick(); continue; }
          const vf = await fnosGetEditDetail(origin, item.guid);
          const vTitle = String(vf ? (vf[titleKey] ?? '') : '');
          const vOv = String(vf ? (vf[ovKey] ?? '') : '');
          if ((titleChanged && vTitle.trim() !== (newTitle as string).trim())
            || (ovChanged && vOv.trim() !== (newOv as string).trim())) {
              stats.failed++; tick(); continue;
          }
          if (titleChanged) stats.filled++;
          if (ovChanged) stats.filled++;
          patchFolderCard(item.guid, titleChanged ? (newTitle as string) : null, ovChanged ? (newOv as string) : null);
          tick();
        } catch (e: any) {
          stats.failed++;
          dlog('[folderScraper] 单项异常 ' + item.guid + ' ' + String(e && e.message || e).substring(0, 100));
          tick();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));

    // 4) 结果反馈
    if (stats.failed) {
      setBtn(btn, '⚠ 回填 ' + stats.filled + ' · 失败 ' + stats.failed, '部分条目写入失败，详见日志；可再点一次重试。');
    } else if (stats.filled) {
      setBtn(btn, '✓ 已回填 ' + stats.filled + ' 项', '自定义刮削数据已写回飞牛元数据。');
    } else if (stats.unmatched) {
      setBtn(btn, '⚠ ' + stats.unmatched + ' 项未匹配', '自定义服务未返回这些文件的 数据（检查 name/index 匹配键）。');
    } else {
      setBtn(btn, '✓ 数据已最新', '与自定义刮削服务一致，无需回填。');
    }
    log('[folderScraper] 完成 ' + (folderTitle || guid) + ' total=' + stats.total + ' filled=' + stats.filled
      + ' unchanged=' + stats.unchanged + ' unmatched=' + stats.unmatched + ' failed=' + stats.failed);
  } catch (e: any) {
    const msg = String(e && e.message || e).substring(0, 80);
    log('[folderScraper] 失败: ' + msg);
    if (btn.isConnected) {
      setBtn(btn, '⚠ ' + msg, msg);
      btn.style.color = 'var(--fnos-ui-warn,#b06a3a)';
      window.setTimeout(() => { if (btn.isConnected) { btn.style.color = ''; setBtn(btn, '⟳ 文件夹刮削'); } }, 6000);
    }
  } finally {
    _running = false;
  }
}

// ── 按钮挂载（jav.ts 同款 body 级浮动胶囊：文件夹页无「选集」标题锚点可内联）──

function makeBtn(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = FOLDER_BTN_ID;
  btn.textContent = '⟳ 文件夹刮削';
  btn.setAttribute('title', '把本文件夹内文件的文件名发给自定义刮削服务，按返回数据回填各文件的标题/简介'
    + '（侧栏设置 → 自定义刮削 中配置；子文件夹请进入后逐层刮削）');
  btn.style.cssText = 'position:fixed;right:18px;bottom:26px;z-index:2147483500;display:inline-flex;align-items:center;'
    + 'padding:7px 14px;border-radius:999px;font-size:11.5px;font-weight:600;cursor:pointer;letter-spacing:.3px;'
    + 'background:rgba(28,24,40,.82)!important;color:#e7e2f5;border:1px solid rgba(255,255,255,.16);'
    + 'box-shadow:0 6px 18px rgba(10,8,20,.35);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);'
    + 'transition:background .15s,transform .15s;user-select:none;';
  btn.setAttribute('data-fnos-ui', '1'); // 白底清除器保护
  btn.addEventListener('mouseenter', () => { btn.style.transform = 'translateY(-1px)'; });
  btn.addEventListener('mouseleave', () => { btn.style.transform = ''; });
  btn.addEventListener('click', (e: Event) => { e.preventDefault(); e.stopPropagation(); void runFolderScraper(btn); });
  return btn;
}

/** 幂等挂载：非文件夹页 / 未启用自开服务 → 摘除。 */
export function ensureFolderScraperButton(): void {
  if (!folderGuid() || !S.customScraperEnabled) { removeFolderScraperButton(); return; }
  const existing = document.getElementById(FOLDER_BTN_ID);
  if (existing && existing.isConnected) return;
  document.body.appendChild(makeBtn());
  dlog('[folderScraper] 按钮已挂载 ' + location.pathname);
}

export function removeFolderScraperButton(): void {
  const b = document.getElementById(FOLDER_BTN_ID);
  if (b && b.parentNode) b.parentNode.removeChild(b);
}

/** 导航钩子入口（embyWall.ts 三处 + 模块自举调用；内部自判路由与开关）。 */
export function scheduleFolderScraperButton(): void {
  ensureFolderScraperButton();
}

/** 自举：模块加载即拉设置同步 S（不依赖用户打开设置面板），完成后按当前路由挂/摘按钮。 */
function bootstrapFromSettings(): void {
  try {
    ipcRenderer.invoke('settings:get').then((s: any) => {
      if (!s || typeof s !== 'object') return;
      S.customScraperEnabled = s.customScraperEnabled === true;
      S.customScraperUrl = String(s.customScraperUrl || '');
      scheduleFolderScraperButton();
    }).catch(() => { /* 非后端环境: localStorage 兜底由 shim settings:get 内部处理 */ });
  } catch { /* ignore */ }
}
bootstrapFromSettings();
