// personWorks.ts — 演员详情页「TMDB 完整作品」注入（lc-1033）
// ─────────────────────────────────────────────────────────────────────────────
// 背景：飞牛演员页只显示库内作品；本插件把 TMDB 全量出演作品（含库外缺失）以与原生
// 作品网格一致的语言追加到页面底部，已入库绿色角标（点击进库内详情），缺失灰化 +
// 「缺失」角标（点击开 TMDB 页）。数据由主进程 person:tmdb-credits 提供
// （personTmdb.ts：飞牛 person/item/list + TMDB combined_credits + owned 匹配）。
// [lc-1040] 防限流：面板默认收起一行头，点开才触发数据查询；海报进视口才下载
// （w342）；数据（主进程 7 天磁盘缓存+SWR）与图片（内存+磁盘）都有持久层，二次点开零网络。
// 参考：第三方油猴插件 fnos-actor-tmdb v4.5（端点与匹配策略经其验证）。
// ─────────────────────────────────────────────────────────────────────────────
import { ipcRenderer, shell } from 'electron';
import { registerHook } from '../core/hooks';
import { HookType } from '../core/hooks';


const STYLE_ID = 'fnos-person-works-style';
const PANEL_ID = 'fnos-person-works';
// [lc-1040] 海报尺寸 w92→w342：卡片实际渲染 162px 宽，2x DPI 下需要 324px 源图——
// w92 拉伸两倍就是用户报的「太糊」。w342 是 TMDB 标准档里 2x 的正解；磁盘缓存按完整 URL 存，
// 换尺寸=换 key，首次会一次性重下（旧 w92 条目成为孤儿，无害）。
const POSTER_BASE = 'https://image.tmdb.org/t/p/w342';

const esc = (s: any): string => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ── 纯渲染（导出供验证复用）──
function cardHtml(m: any): string {
  const owned = !!m.owned;
  const year = m.date ? m.date.slice(0, 4) : '';
  const score = m.score > 0 ? `<span class="fpw-score">${Number(m.score).toFixed(1)}</span>` : '';
  const tvTag = m.media === 'tv' ? '<span class="fpw-tvtag">剧集</span>' : '';
  const missingTag = owned ? '' : '<span class="fpw-missing">缺失</span>';
  const inner = `
    <div class="fpw-poster${owned ? '' : ' missing'}">
      ${m.poster ? `<img alt="" data-path="${esc(m.poster)}">` : '<div class="fpw-noposter">无图</div>'}
      ${score}${missingTag}
    </div>
    <div class="fpw-title">${esc(m.title)}${owned ? '<span class="fpw-owned">已入库</span>' : ''}</div>
    <div class="fpw-sub">${tvTag}${esc(year || '—')}${m.character ? ' · ' + esc(m.character) : ''}</div>`;
  if (owned && m.guid) {
    const route = m.media === 'tv' ? 'tv' : 'movie';
    return `<a class="fpw-card owned" href="/v/${route}/${esc(m.guid)}" data-internal="1">${inner}</a>`;
  }
  const tmdb = `https://www.themoviedb.org/${m.media}/${m.id}`;
  return `<div class="fpw-card missing" data-tmdb="${esc(tmdb)}" title="库内缺失 · 点击查看 TMDB">${inner}</div>`;
}

const PANEL_CSS = `
#${PANEL_ID}{ margin:0 0 10px; }
#${PANEL_ID} .fpw-head{ display:flex; align-items:baseline; gap:10px; margin-bottom:12px; }
#${PANEL_ID} .fpw-h-title{ font-size:15px; font-weight:600; color:var(--semi-color-text-0); }
#${PANEL_ID} .fpw-h-sub{ font-size:12px; color:var(--semi-color-text-2); }
#${PANEL_ID} .fpw-h-toggle{ margin-left:auto; font-size:11.5px; color:var(--semi-color-primary); cursor:pointer; user-select:none; }
#${PANEL_ID} .fpw-h-toggle:hover{ text-decoration:underline; }
#${PANEL_ID} .fpw-h-collapse{ color:var(--semi-color-text-2); }
#${PANEL_ID} .fpw-head.fpw-head-click{ cursor:pointer; }
#${PANEL_ID} .fpw-head.fpw-head-click:hover .fpw-h-title{ color:var(--semi-color-primary); }
#${PANEL_ID} .fpw-grid{ display:flex; flex-wrap:wrap; gap:20px 20px; }
#${PANEL_ID} .fpw-card{ width:162px; cursor:pointer; border-radius:10px; transition:transform .22s ease; }
#${PANEL_ID} .fpw-card:hover{ transform:translateY(-3px); }
#${PANEL_ID} .fpw-card:hover .fpw-title{ color:var(--semi-color-primary); }
#${PANEL_ID} .fpw-poster{ position:relative; width:100%; aspect-ratio:2/3; border-radius:10px; overflow:hidden;
  background:var(--semi-color-fill-0); margin-bottom:8px; }
#${PANEL_ID} .fpw-poster img{ width:100%; height:100%; object-fit:cover; display:block; }
#${PANEL_ID} .fpw-poster.missing img{ filter:grayscale(.65) brightness(.88); opacity:.85; }
#${PANEL_ID} .fpw-noposter{ width:100%; height:100%; display:flex; align-items:center; justify-content:center;
  font-size:11px; color:var(--semi-color-text-2); }
#${PANEL_ID} .fpw-score{ position:absolute; top:8px; left:8px; font-size:11px; font-weight:600;
  color:#fff; background:rgba(0,0,0,.55); padding:1px 6px; border-radius:6px; }
#${PANEL_ID} .fpw-missing{ position:absolute; top:8px; right:8px; font-size:10.5px; font-weight:600;
  color:#ffd7d7; background:rgba(180,40,40,.78); padding:1px 6px; border-radius:6px; }
#${PANEL_ID} .fpw-title{ font-size:13px; line-height:1.35; color:var(--semi-color-text-0);
  overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
#${PANEL_ID} .fpw-owned{ display:inline-block; margin-left:5px; font-size:10px; font-weight:500;
  padding:0 5px; border-radius:4px; background:var(--semi-color-success); color:#fff; vertical-align:1px; }
#${PANEL_ID} .fpw-sub{ margin-top:3px; font-size:11.5px; color:var(--semi-color-text-2);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
#${PANEL_ID} .fpw-tvtag{ display:inline-block; margin-right:5px; font-size:10.5px; padding:0 5px;
  border-radius:4px; background:var(--semi-color-fill-1); color:var(--semi-color-text-1); }
#${PANEL_ID} .fpw-msg{ font-size:12px; color:var(--semi-color-text-2); padding:14px 2px; }
#${PANEL_ID} .fpw-card.missing, #${PANEL_ID} .fpw-card.owned{ text-decoration:none; }
`;

// ── 运行时 ──
let _styleInjected = false;
let _onlyMissing = false;
let _loadError = '';     // 最近一次加载错误——收起态显示「点击重试」
const _cache = new Map<string, any>();   // guid → credits 响应（渲染进程会话级；持久层在主进程磁盘缓存）
const _inflight = new Set<string>();
let _currentGuid = '';
let _waitingForCol = false;

function ensureStyle(): void {
    if (_styleInjected) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = PANEL_CSS;
    (document.head || document.documentElement).appendChild(st);
    _styleInjected = true;
}

function activeCol(): HTMLElement | null {
    // 演员页作品列：唯一 mb-[46px] 容器（person 页结构，活体 2026-09-05）
    const views = document.querySelectorAll('.trim-ui__cache-outlet--exclude');
    for (let i = views.length - 1; i >= 0; i--) {
        const v = views[i] as HTMLElement;
        if (v && v.offsetParent !== null) {
            const col = v.querySelector<HTMLElement>('div[class*="mb-[46px]"]');
            if (col) return col;
        }
    }
    return document.querySelector<HTMLElement>('div[class*="mb-[46px]"]');
}

function renderPanel(container: HTMLElement, data: any): void {
    let box = container.querySelector<HTMLDivElement>('#' + PANEL_ID);
    if (!box) {
        box = document.createElement('div');
        box.id = PANEL_ID;
        container.appendChild(box); // 追加为作品列末尾（原生「作为演员」网格之后）
    }
    if (box.dataset.guid !== _currentGuid) { box.innerHTML = ''; box.dataset.guid = _currentGuid; }
    ensureStyle();
    const items: any[] = data.items || [];
    const ownedCount = Number(data.ownedCount || 0);
    const list = _onlyMissing ? items.filter((m) => !m.owned) : items;
    const head = `
      <div class="fpw-head">
        <span class="fpw-h-title">TMDB 完整作品</span>
        <span class="fpw-h-sub">共 ${items.length} 部 · 库内 ${ownedCount} 部</span>
        <span class="fpw-h-toggle fpw-h-collapse">收起</span>
        <span class="fpw-h-toggle fpw-h-missing-toggle">${_onlyMissing ? '显示全部' : '仅看缺失'}</span>
      </div>`;
    const grid = `<div class="fpw-grid">${list.map(cardHtml).join('') || '<div class="fpw-msg">没有缺失作品 ✓ 全部已入库</div>'}</div>`;
    box.innerHTML = head + grid;

    const toggle = box.querySelector('.fpw-h-missing-toggle');
    if (toggle) toggle.addEventListener('click', () => { _onlyMissing = !_onlyMissing; renderPanel(container, data); });
    // [lc-1040] 收起：数据留在内存缓存，再点开毫秒级还原、零网络
    const collapse = box.querySelector('.fpw-h-collapse');
    if (collapse) collapse.addEventListener('click', () => { renderCollapsed(container); });

    // [lc-1040] 海报懒加载：进视口才走主进程 tmdb:image 代理（内存+磁盘缓存，规避 DNS 污染；
    // 复用详情页 TMDB 卡管线）——不再百张齐发，滚动到哪下载到哪
    observePosters(box);
    // 缺失卡：点击开 TMDB 页（库内卡是 <a>，由 fnOS 路由接管）
    box.querySelectorAll<HTMLElement>('.fpw-card.missing').forEach((el) => {
        el.addEventListener('click', (ev: Event) => {
            ev.preventDefault();
            const u = el.getAttribute('data-tmdb');
            if (u) { try { shell.openExternal(u); } catch { window.open(u, '_blank'); } }
        });
    });
}

function renderMsg(container: HTMLElement, msg: string): void {
    ensureStyle();
    let box = container.querySelector<HTMLDivElement>('#' + PANEL_ID);
    if (!box) { box = document.createElement('div'); box.id = PANEL_ID; container.appendChild(box); }
    box.dataset.guid = _currentGuid;
    box.innerHTML = `<div class="fpw-head"><span class="fpw-h-title">TMDB 完整作品</span></div><div class="fpw-msg">${esc(msg)}</div>`;
}

/** [lc-1040] 收起态：只有一行头，零网络请求（进演员页不再自动拉数据/下图片）。
 *  点击头部才真正查询/下载；有错误时同位置显示「点击重试」。 */
function renderCollapsed(container: HTMLElement): void {
    ensureStyle();
    let box = container.querySelector<HTMLDivElement>('#' + PANEL_ID);
    if (!box) { box = document.createElement('div'); box.id = PANEL_ID; container.appendChild(box); }
    box.dataset.guid = _currentGuid;
    box.innerHTML = '<div class="fpw-head fpw-head-click" role="button">'
        + '<span class="fpw-h-title">TMDB 完整作品</span>'
        + `<span class="fpw-h-sub">${_loadError ? esc(_loadError) : '未加载 · 点击后查询 TMDB'}</span>`
        + `<span class="fpw-h-toggle">${_loadError ? '点击重试' : '点击加载'}</span></div>`;
    const head = box.querySelector('.fpw-head');
    if (head) head.addEventListener('click', () => { void expandCurrent(); });
}

/** [lc-1040] 点开才触发查询/下载（用户要求防限流）：数据走主进程磁盘缓存（lc-1039，7 天+SWR），
 *  二次点开毫秒级零网络；海报则由 observePosters 按“进视口”逐批下载。 */
async function expandCurrent(): Promise<void> {
    const guid = _currentGuid;
    const container = activeCol();
    if (!guid || !container || _inflight.has(guid)) return;
    const cached = _cache.get(guid);
    if (cached) { renderPanel(container, cached); return; }
    _inflight.add(guid);
    _loadError = '';
    renderMsg(container, '正在从 TMDB 拉取完整作品…');
    try {
        let r: any = null;
        try {
            r = await ipcRenderer.invoke('person:tmdb-credits', guid);
        } catch (err: any) {
            const msg = String((err && err.message) || err);
            // [lc-1034] 主进程插件未加载（常见于只刷新了页面、主进程还是旧版）→ 给出可执行指引
            if (msg.indexOf('No handler registered') !== -1) {
                renderMsg(container, '主进程尚未加载本插件——请完整重启客户端（退出进程再启动，仅刷新页面无效）后重试');
                return;
            }
            throw err;
        }
        if (_currentGuid !== guid) return; // 已切页
        if (!r || r.error) { _loadError = (r && r.error) || '拉取失败'; renderCollapsed(container); return; }
        _cache.set(guid, r);
        if (r.noImdb) { renderMsg(container, '该演员无 IMDb 关联，无法获取 TMDB 完整作品'); return; }
        renderPanel(container, r);
    } catch (e: any) {
        if (_currentGuid === guid) {
            _loadError = '拉取失败: ' + (e && e.message ? e.message : e);
            renderCollapsed(container); // 错误态回落收起头部，点击即重试
        }
    } finally {
        _inflight.delete(guid);
    }
}

let _posterIO: IntersectionObserver | null = null;

function loadPoster(img: HTMLImageElement): void {
    const p = img.getAttribute('data-path') || '';
    if (!p) return;
    const u = POSTER_BASE + p;
    ipcRenderer.invoke('tmdb:image', u)
        .then((r: any) => { if (r && r.ok && r.dataUrl && document.body.contains(img)) img.src = r.dataUrl; })
        .catch(() => { if (document.body.contains(img)) img.src = u; }); // 代理失败退直链
}

/** [lc-1040] 视口内才下载海报（rootMargin 预拉约一屏）；「仅看缺失」切换重渲染后对新卡重新观察。
 *  主进程内存+磁盘双层缓存兜底：同一张图整个软件生命周期只真正下载一次。 */
function observePosters(box: HTMLElement): void {
    if (_posterIO) { _posterIO.disconnect(); _posterIO = null; }
    const imgs = Array.from(box.querySelectorAll<HTMLImageElement>('img[data-path]'));
    if (typeof IntersectionObserver === 'undefined') { imgs.forEach(loadPoster); return; }
    _posterIO = new IntersectionObserver((entries) => {
        for (const en of entries) {
            if (!en.isIntersecting) continue;
            const img = en.target as HTMLImageElement;
            if (_posterIO) _posterIO.unobserve(img);
            loadPoster(img);
        }
    }, { rootMargin: '300px 0px' });
    imgs.forEach((im) => { if (_posterIO) _posterIO.observe(im); });
}

/** 有界等待作品列渲染（原生「作为演员」网格就绪后再注入，避免插早被 React 冲掉）。
 *  [lc-1040] 只注入收起态头部，不自动拉取。 */
function waitForColumn(guid: string, attempt: number): void {
    if (_currentGuid !== guid) return; // 已切走
    const col = activeCol();
    if (col && col.children.length >= 2) {
        renderCollapsed(col);
        return;
    }
    if (attempt >= 10) {  return; }
    setTimeout(() => waitForColumn(guid, attempt + 1), 600);
}

/** [lc-1036] 二级详情页（季页）演职人员行富化：逐演员拉 TMDB 简报
 *  （职业分类/生日/代表作前二），注入行右缘补充信息槽（beautifyStyle E2 ④b 槽位）。 */
const _castEnrichBusy = { v: false };
function enrichCast(): void {
    if (_castEnrichBusy.v) return;
    const views = document.querySelectorAll('.trim-ui__cache-outlet--exclude');
    let view: HTMLElement | null = null;
    for (let i = views.length - 1; i >= 0; i--) {
        const v = views[i] as HTMLElement;
        if (v && v.offsetParent !== null && v.querySelector('a[href*="/v/person/"]')) { view = v; break; }
    }
    if (!view) return;
    const links = Array.from(view.querySelectorAll('a[href*="/v/person/"]')) as HTMLAnchorElement[];
    const todo = links.filter((a) => !a.dataset.fpwEnriched);
    if (!todo.length) return;
    _castEnrichBusy.v = true;
    todo.forEach((a, i) => {
        a.dataset.fpwEnriched = String(i);
        const m = (a.getAttribute('href') || '/').match(/([0-9a-f]{32})/i);
        if (!m) return;
        const guid = m[1].toLowerCase();
        setTimeout(() => {
            ipcRenderer.invoke('person:tmdb-brief', guid).then((b: any) => {
                if (!b || b.error || !document.body.contains(a)) return;
                const parts: string[] = [];
                // [lc-1036] 原生角色文案已含职业分类（如角色 p 就是「演员」）时不重复推送
                const roleEl = a.querySelector('p:not([class*="text-base"])');
                const roleTxt = roleEl ? (roleEl.textContent || '').trim() : '';
                if (b.dept && roleTxt.indexOf(b.dept) === -1) parts.push(b.dept);
                if (b.birthday) parts.push(b.birthday);
                if (b.top && b.top.length) parts.push(b.top.join('、'));
                if (!parts.length) return;
                const span = document.createElement('span');
                span.className = 'fn-cast-extra';
                span.textContent = parts.join(' · ');
                span.title = span.textContent;
                a.appendChild(span);
            }).catch(() => {});
        }, i * 180);
    });
    setTimeout(() => { _castEnrichBusy.v = false; }, 900);
}

function checkRoute(): void {
    // [lc-1036] 二级详情页（季页）→ 演职人员行富化
    if (/\/v\/(?:tv|movie)\/season\/[0-9a-f]{32}/i.test(location.pathname)) enrichCast();
    const m = location.pathname.match(/\/v\/person\/([0-9a-f]{32})/i);
    if (!m) {
        if (_currentGuid) {
            _currentGuid = '';
            _loadError = '';   // [lc-1040] 换页复位；观察器随面板 DOM 移除自动失效
            if (_posterIO) { _posterIO.disconnect(); _posterIO = null; }
            const b = document.getElementById(PANEL_ID);
            if (b && b.parentElement) b.parentElement.removeChild(b);
        }
        return;
    }
    const guid = m[1].toLowerCase();
    if (guid === _currentGuid) return;
    _currentGuid = guid;
    _onlyMissing = false;
    _loadError = '';   // [lc-1040] 每个演员页都从收起态开始（点开才拉）
    waitForColumn(guid, 0);
}

function handle(): void {
    try {
        setInterval(checkRoute, 1200);
        checkRoute();
        
    } catch (e: any) { log.warn('初始化失败:', e && e.message); }
}
registerHook(HookType.OnReady, handle);

// 供验证工装复用（纯渲染）
export const __test = { cardHtml, PANEL_CSS };
export {};
