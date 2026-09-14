// embyWall/detail/bangumiBackfill.ts — [多源刮削] 季页「自定义刮削」：按标题匹配条目，
// 把每集中文标题/简介与剧名/简介经飞牛官方编辑接口回填（管线复用 lc-1045 epBackfill / lc-425 logo 回写）。
// ─────────────────────────────────────────────────────────────────────────────
// 数据流（先本地、后写回；按钮状态实时分步刷新，文案中性不出现数据源名）：
//   ① item/list(parent_guid=季guid) 枚举本季集（DOM href 回落，同 epBackfill）
//   ② 三段式 IPC: bangumi:meta-search(匹配) → bangumi:meta-detail(条目信息) → bangumi:meta-episodes(分集)
//      —— 主进程带盘上缓存(userData/bangumi_subject_meta.json)：数据先落本地，写回失败可重试不重拉网络；
//      单次请求 15s 超时 + 自动重试 1 次（用户日志实证 Bangumi 偶发 12s 超时导致误报"未匹配"）
//   ③ 逐集 getEditDetail 读全量 → decideField 裁决（空则填 / 非 CJK 被中文覆盖 / 已中文不动）
//      → saveEditDetail 仅改 title/overview(+*_locked:true 防 fnOS 下次刮削覆盖)
//      → 复核读回确认落盘 → 选集卡 DOM 即时补丁（patchEpisodeCard，epBackfill 导出复用）
//   ④ 机会式剧集级：季详情 parent 字段解析出剧 guid → 剧名(name_cn)/简介(summary) 同管线回填；
//      字段形状不认识就跳过并日志留档（lc-421 抓包校准风格）
// 与 epBackfill 的分工：epBackfill = TMDB 源（中文缺位时兜底英文）；本模块 = Bangumi 源
// （中文优先，番剧场景每集中文名/剧情简介覆盖面远好于 TMDB）。裁决函数直接复用，保证两源行为一致。
// ─────────────────────────────────────────────────────────────────────────────
import { ipcRenderer } from 'electron';
import { dlog, log } from '../log';
import { fnosGetEditDetail } from '../carousel/logo';
import { decideField, hasCJK, isPlaceholderTitle, patchEpisodeCard, epNumFromTitle } from './epBackfill';

const BTN_ID = 'fnos-bgfix-btn';
const RETRY_DELAYS = [0, 400, 1000, 2000, 3400, 5000];
/** 逐集读改写的并发上限（与 epBackfill 同：4 路并行对 NAS 温和且总时长秒级） */
const CONCURRENCY = 4;
const SEASON_GUID_RE = /\/v\/tv\/season\/([a-f0-9]{32})/;

function seasonGuid(): string | null {
    const m = location.pathname.match(SEASON_GUID_RE);
    return m ? m[1] : null;
}

function numOrNull(v: any): number | null {
    if (typeof v === 'number' && !isNaN(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
    return null;
}

// ── 飞牛 API（nonce + Authx 约定同 logo.ts lc-425 / epBackfill lc-1045）──

function fnNonce(): string {
    return String(Math.floor(Math.random() * 900000) + 100000);
}

/** 带签名 POST（渲染进程 fetch，credentials 会话鉴权），返回业务 data 或 null。 */
async function fnosPost(origin: string, path: string, body: any): Promise<any | null> {
    const authx = await ipcRenderer.invoke('fnos-gen-authx', path, body).catch(() => '');
    const resp = await fetch(origin + path, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(authx ? { Authx: authx } : {}) },
        body: JSON.stringify(body),
    });
    if (!resp.ok) { dlog('[bgBackfill] POST ' + path + ' HTTP ' + resp.status); return null; }
    const j = await resp.json().catch(() => null);
    if (!j || j.code !== 0) { dlog('[bgBackfill] POST ' + path + ' 业务失败 ' + JSON.stringify(j).substring(0, 160)); return null; }
    return j.data || null;
}

/** 带签名 GET（同源会话鉴权），返回业务 data 或 null。用于 item/{guid} 详情探测。 */
async function fnosGet(origin: string, path: string): Promise<any | null> {
    const authx = await ipcRenderer.invoke('fnos-gen-authx', path).catch(() => '');
    const resp = await fetch(origin + path, {
        method: 'GET', credentials: 'include',
        headers: authx ? { Authx: authx } : {},
    });
    if (!resp.ok) { dlog('[bgBackfill] GET ' + path + ' HTTP ' + resp.status); return null; }
    const j = await resp.json().catch(() => null);
    if (!j || j.code !== 0) { dlog('[bgBackfill] GET 业务失败 ' + JSON.stringify(j).substring(0, 160)); return null; }
    return j.data || null;
}

/** 枚举本季全部集（guid + 集号）。item/list 失败时由调用方回落 DOM href 收集。 */
async function fnosEpisodeList(origin: string, seasonGuidStr: string): Promise<{ guid: string; index: number | null }[]> {
    const data = await fnosPost(origin, '/v/api/v1/item/list', {
        parent_guid: seasonGuidStr, exclude_folder: 1,
        sort_column: 'sort_title', sort_type: 'ASC', nonce: fnNonce(),
    });
    const list = data && Array.isArray((data as any).list) ? (data as any).list : [];
    const out: { guid: string; index: number | null }[] = [];
    for (const it of list) {
        if (!it || !it.guid) continue;
        if (String(it.type || '').toLowerCase() !== 'episode') continue;
        out.push({ guid: String(it.guid), index: numOrNull(it.index_number ?? it.index) });
    }
    return out;
}

/** DOM 回落：活跃视图选集卡的 a[href="/v/tv/episode/<guid>"]。 */
function episodeGuidsFromDom(): { guid: string; index: number | null }[] {
    const view = (document.querySelector('.fnos-detail-view, [class*="detail"]') as HTMLElement) || document.body;
    const out: { guid: string; index: number | null }[] = [];
    const seen = new Set<string>();
    const links = view.querySelectorAll<HTMLAnchorElement>('a[href*="/v/tv/episode/"]');
    for (let i = 0; i < links.length; i++) {
        const m = (links[i].getAttribute('href') || '').match(/\/v\/tv\/episode\/([a-f0-9]{32})/);
        if (!m || seen.has(m[1])) continue;
        seen.add(m[1]);
        out.push({ guid: m[1], index: null });
    }
    return out;
}

/** 全量回写（仅调用方改好的字段 + nonce；字段锁定由调用方放进了 body）。 */
async function fnosSaveEditDetail(origin: string, body: any): Promise<boolean> {
    const authx = await ipcRenderer.invoke('fnos-gen-authx', '/v/api/v1/item/saveEditDetail', body).catch(() => '');
    const resp = await fetch(origin + '/v/api/v1/item/saveEditDetail', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(authx ? { Authx: authx } : {}) },
        body: JSON.stringify(body),
    });
    if (!resp.ok) { dlog('[bgBackfill] saveEditDetail HTTP ' + resp.status); return false; }
    const j = await resp.json().catch(() => null);
    // [多源刮削] 成功判定必须按 code===0 —— 实测成功响应是 {code:0, data:null},
    //  旧写法「data !== null」把所有成功写回误判成失败(failed 虚高、复核从未执行)。
    return !!j && j.code === 0;
}

/** 从季页上下文提取用于 Bangumi 搜索的「剧名」：季编辑数据标题剥季缀 → 文档标题兜底。 */
function extractSearchTitle(data: any): string {
    let t = String((data && (data.title || data.name)) || '').trim();
    t = t.replace(/^第\s*[0-9一二三四五六七八九十]+\s*季$/, '').replace(/Season\s*\d+$/i, '').trim();
    if (t) return t;
    // 兜底：document.title 形如「XXX 第2季 - 飞牛影视」
    const dt = String(document.title || '').replace(/[-–—|]\s*飞牛影视.*$/, '').trim();
    const m = dt.match(/^(.*?)\s*(?:第\s*[0-9一二三四五六七八九十]+\s*季|Season\s*\d+)?\s*$/i);
    return ((m && m[1]) || '').trim();
}

/** 机会式解析剧集 guid：季详情的 parent 系字段 → item/{guid} 详情再探 → 放弃（日志留档字段形状）。 */
async function resolveSeriesGuid(origin: string, sg: string, seasonData: any): Promise<string | null> {
    const pick = (d: any): string | null => {
        if (!d) return null;
        const c = d.parent_guid || d.parent_id || d.parent_item_guid || d.series_guid || d.show_guid
            || (d.parent && d.parent.guid) || null;
        const s = c == null ? '' : String(c);
        return /^[a-f0-9]{32}$/.test(s) ? s : null;
    };
    const direct = pick(seasonData);
    if (direct) return direct;
    try {
        const info = await fnosGet(origin, '/v/api/v1/item/' + sg);
        const via = pick(info);
        if (via) { dlog('[bgBackfill] 剧集 guid 经 item 详情解析: ' + via); return via; }
        // 字段形状留档（lc-421 校准风格）：本机首见时打一条，后续 fnOS 版本接入直接补字段名
        dlog('[bgBackfill] 季详情无 parent 系字段, keys=' + Object.keys(info || seasonData || {}).join(','));
    } catch { /* ignore */ }
    return null;
}

// ── 按钮挂载/状态（与 epBackfill 同款外观，独立 id）──

function setBtn(btn: HTMLElement, text: string, title?: string): void {
    btn.textContent = text;
    if (title !== undefined) btn.setAttribute('title', title);
}

function makeBtn(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = BTN_ID;
    btn.textContent = '⟳ 自定义刮削';
    btn.setAttribute('title', '自定义刮削: 匹配条目并回填本季每集的中文标题/剧情简介到飞牛'
        + '（中文优先；已有中文不被覆盖）。命中条目时也会尝试回填剧名与剧集简介。');
    btn.style.cssText = 'display:inline-flex;align-items:center;margin-left:9px;padding:3px 10px;border-radius:999px;'
        + 'font-size:11.5px;font-weight:600;cursor:pointer;vertical-align:middle;letter-spacing:.3px;'
        + 'background:var(--fnos-ui-btn-bg,rgba(90,120,200,.12));color:var(--fnos-ui-accent,#6d7ff2);'
        + 'border:none;transition:background .15s,color .15s;flex-shrink:0;';
    btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--fnos-ui-btn-hover,rgba(109,127,242,.32))'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'var(--fnos-ui-btn-bg,rgba(90,120,200,.12))'; });
    btn.addEventListener('click', (e: Event) => { e.preventDefault(); e.stopPropagation(); void runBackfill(btn); });
    return btn;
}

/** 「选集」标题元素（epBackfill 同款定位；其按钮已挂时直接排在其后，保持两按钮相邻）。 */
function findAnchorForInsert(): HTMLElement | null {
    const epBtn = document.getElementById('fnos-epfix-btn');
    if (epBtn && epBtn.isConnected) return epBtn;
    const view = (document.querySelector('.fnos-detail-view, [class*="detail"]') as HTMLElement) || document.body;
    const nodes = view.querySelectorAll('strong,b,h1,h2,h3,h4,p,span,div,em');
    let prefixHit: HTMLElement | null = null;
    const limit = Math.min(nodes.length, 2500);
    for (let i = 0; i < limit; i++) {
        const el = nodes[i] as HTMLElement;
        if (el.querySelector('#' + BTN_ID)) continue;          // 已是我们按钮的宿主
        if (el.querySelector('#fnos-epfix-btn')) return el;    // epBackfill 按钮的宿主 → 插它后面
        const t = (el.textContent || '').trim();
        if (t === '选集') {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return el;
        } else if (!prefixHit && /^选集/.test(t) && t.length <= 8) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) prefixHit = el;
        }
    }
    return prefixHit;
}

/** 幂等挂载：epBackfill 按钮在 → 排其后；否则找「选集」标题自行挂。找不到锚点 → 静默（重试链再来）。 */
export function ensureBangumiFixButton(): void {
    if (!seasonGuid()) { removeBangumiFixButton(); return; }
    const existing = document.getElementById(BTN_ID);
    if (existing && existing.isConnected) return;
    const anchor = findAnchorForInsert();
    if (!anchor) return;
    if (anchor.id === 'fnos-epfix-btn') anchor.insertAdjacentElement('afterend', makeBtn());
    else anchor.appendChild(makeBtn());
    dlog('[bgBackfill] 按钮已挂载 ' + location.pathname);
}

export function removeBangumiFixButton(): void {
    const b = document.getElementById(BTN_ID);
    if (b && b.parentNode) b.parentNode.removeChild(b);
}

// ── 主流程 ──

let _running = false;
let _retryTimers: number[] = [];

interface Stats { filled: number; upgraded: number; unchanged: number; failed: number; unmatched: number; unverified: number; total: number; }

async function runBackfill(btn: HTMLButtonElement): Promise<void> {
    const sg = seasonGuid();
    if (!sg || _running) return;
    _running = true;
    const origin = location.origin;
    const stats: Stats = { filled: 0, upgraded: 0, unchanged: 0, failed: 0, unmatched: 0, unverified: 0, total: 0 };
    const tick = (): void => {
        const done = stats.filled + stats.upgraded + stats.unchanged + stats.failed + stats.unmatched + stats.unverified;
        if (btn.isConnected) setBtn(btn, '⏳ 回填中 ' + done + '/' + stats.total);
    };
    try {
        // 1) 季信息：标题（剥季缀作搜索词）
        const seasonData = await fnosGetEditDetail(origin, sg);
        if (!seasonData) throw new Error('读取季信息失败（getEditDetail）');
        const searchTitle = extractSearchTitle(seasonData);
        if (!searchTitle) throw new Error('无法确定剧名（季标题与页面标题都没有）');

        // 2) 枚举本季集（item/list 为主，DOM 回落）
        let episodes = await fnosEpisodeList(origin, sg).catch(() => [] as { guid: string; index: number | null }[]);
        if (!episodes.length) episodes = episodeGuidsFromDom();
        if (!episodes.length) throw new Error('未枚举到本季任何集（item/list 与 DOM 都为空）');
        stats.total = episodes.length;

        // 3) [多源刮削] 三段式拉取(匹配→条目信息→分集): 每步刷新按钮状态, 数据先落主进程缓存。
        //    按钮文案一律中性(不出现数据源名); 源细节只进日志便排查。
        setBtn(btn, '⏳ 匹配条目…');
        const sr: any = await ipcRenderer.invoke('bangumi:meta-search', searchTitle, episodes.length);
        if (!sr || !sr.ok) {
            log('[bgBackfill] 条目匹配失败:', (sr && sr.error) || '');
            throw new Error(sr && sr.kind === 'timeout' ? '数据源超时,请重试' : '未匹配到条目');
        }
        const subjectId = Number(sr.data.subjectId);
        setBtn(btn, '⏳ 获取条目信息…');
        const dr: any = await ipcRenderer.invoke('bangumi:meta-detail', subjectId);
        if (!dr || !dr.ok) {
            log('[bgBackfill] 条目信息失败:', (dr && dr.error) || '');
            throw new Error(dr && dr.kind === 'timeout' ? '数据源超时,请重试' : '刮削失败,请重试');
        }
        const detail = dr.data;
        setBtn(btn, '⏳ 获取分集数据…');
        const er: any = await ipcRenderer.invoke('bangumi:meta-episodes', subjectId);
        if (!er || !er.ok) {
            log('[bgBackfill] 分集数据失败:', (er && er.error) || '');
            throw new Error(er && er.kind === 'timeout' ? '数据源超时,请重试' : '刮削失败,请重试');
        }
        const bgByNum = new Map<number, any>();
        // [多源刮削] 播出日期索引: 集号解析全失败时的兜底匹配(仅当该日期在数据源唯一才采用)
        const bgByDate = new Map<string, any[]>();
        for (const e of er.data.eps || []) {
            bgByNum.set(e.ep, e);
            if (e.airdate) { const arr = bgByDate.get(e.airdate) || []; arr.push(e); bgByDate.set(e.airdate, arr); }
        }

        // 4) 逐集：读全量 → 裁决 → 写回 → 复核 → DOM 补丁（按钮实时显示当前进度）
        let idx = 0;
        const doneCount = (): number => stats.filled + stats.upgraded + stats.unchanged + stats.failed + stats.unmatched + stats.unverified;
        const worker = async (): Promise<void> => {
            while (idx < episodes.length) {
                const ep = episodes[idx++];
                setBtn(btn, '⏳ 回填中 ' + (doneCount() + 1) + '/' + stats.total);
                try {
                    const ed = await fnosGetEditDetail(origin, ep.guid);
                    if (!ed) { stats.failed++; tick(); continue; }
                    // [多源刮削] 集号解析链(同 epBackfill): fnOS 0.9.8 无 index_number →
                    //  标题「第 N 集」解析 → item/list 序号 → 播出日期唯一匹配
                    const num = numOrNull(ed.index_number ?? ed.index ?? ed.episode_number)
                        ?? epNumFromTitle(String(ed.title ?? ed.name ?? ''))
                        ?? ep.index;
                    let t = (num !== null) ? bgByNum.get(num) : undefined;
                    if (!t && ed.air_date) {
                        const byDate = bgByDate.get(String(ed.air_date));
                        if (byDate && byDate.length === 1) t = byDate[0];
                    }
                    if (!t) {
                        dlog('[bgBackfill] 集号无法确定: guid=' + ep.guid + ' title=' + String(ed.title ?? ed.name ?? '')
                            + ' air_date=' + String(ed.air_date || ''));
                        stats.unmatched++; tick(); continue;
                    }
                    const titleKey = ('title' in ed) ? 'title' : ('name' in ed ? 'name' : 'title');
                    const ovKey = ('overview' in ed) ? 'overview' : ('description' in ed ? 'description' : 'overview');
                    const curTitle = String(ed[titleKey] ?? '');
                    const curOv = String(ed[ovKey] ?? '');
                    const candTitle = t.nameCn || t.name || '';
                    const newTitle = decideField(curTitle, candTitle, '', isPlaceholderTitle);
                    const newOv = decideField(curOv, t.desc || '', '');
                    if (newTitle === null && newOv === null) { stats.unchanged++; tick(); continue; }
                    const body: any = { ...ed, nonce: fnNonce() };
                    // 防御：getEditDetail 返回体可能不带 guid 字段（lc-1045 实测），缺了显式补
                    if (!body.guid && !body.item_guid) body.guid = ep.guid;
                    let titleChanged = false, ovChanged = false;
                    if (newTitle !== null) { body[titleKey] = newTitle; body.title_locked = true; titleChanged = true; }
                    if (newOv !== null) { body[ovKey] = newOv; body.overview_locked = true; ovChanged = true; }
                    const saved = await fnosSaveEditDetail(origin, body);
                    if (!saved) { stats.failed++; tick(); continue; }
                    // 复核：写后立即读回可能撞上服务端旧值缓存(实测 code:0 但回读旧内容) →
                    //  隔 700ms 重读一次；仍不一致计「未确认」(提交成败需刷新页面核实)，不算硬失败
                    let verified = false;
                    for (let v = 0; v < 2 && !verified; v++) {
                        if (v > 0) await new Promise((r) => setTimeout(r, 700));
                        const vf = await fnosGetEditDetail(origin, ep.guid);
                        const vTitle = String(vf ? (vf[titleKey] ?? '') : '');
                        const vOv = String(vf ? (vf[ovKey] ?? '') : '');
                        verified = (!titleChanged || vTitle.trim() === (newTitle as string).trim())
                            && (!ovChanged || vOv.trim() === (newOv as string).trim());
                    }
                    if (!verified) {
                        stats.unverified++;
                        dlog('[bgBackfill] 已提交但复核未确认(疑似服务端写后读延迟): guid=' + ep.guid);
                        tick();
                        continue;
                    }
                    if (titleChanged && hasCJK(newTitle as string)) stats.filled++;
                    else if (titleChanged) stats.upgraded++;
                    if (ovChanged && hasCJK(newOv as string)) stats.filled++;
                    else if (ovChanged) stats.upgraded++;
                    patchEpisodeCard(ep.guid, titleChanged ? (newTitle as string) : null, ovChanged ? (newOv as string) : null);
                    tick();
                } catch (e: any) {
                    stats.failed++;
                    dlog('[bgBackfill] 单集失败 ' + ep.guid + ' ' + String(e).substring(0, 100));
                    tick();
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, episodes.length) }, worker));

        // 5) 机会式剧集级回填：剧名(name_cn)/简介(summary)
        let seriesNote = '';
        try {
            const seriesGuid = await resolveSeriesGuid(origin, sg, seasonData);
            if (seriesGuid) {
                const sd = await fnosGetEditDetail(origin, seriesGuid);
                if (sd) {
                    const tKey = ('title' in sd) ? 'title' : ('name' in sd ? 'name' : 'title');
                    const oKey = ('overview' in sd) ? 'overview' : ('description' in sd ? 'description' : 'overview');
                    const newT = decideField(String(sd[tKey] ?? ''), detail.nameCn || '', '');
                    const newO = decideField(String(sd[oKey] ?? ''), detail.summary || '', '');
                    if (newT !== null || newO !== null) {
                        const body: any = { ...sd, nonce: fnNonce() };
                        if (!body.guid && !body.item_guid) body.guid = seriesGuid;
                        if (newT !== null) { body[tKey] = newT; body.title_locked = true; }
                        if (newO !== null) { body[oKey] = newO; body.overview_locked = true; }
                        if (await fnosSaveEditDetail(origin, body)) {
                            log('[bgBackfill] 剧集级回填完成 guid=' + seriesGuid);
                            seriesNote = '（剧名/简介已同步）';
                        } else {
                            seriesNote = '（剧集级写回失败）';
                        }
                    } else {
                        seriesNote = '（剧集级已一致）';
                    }
                }
            } else {
                dlog('[bgBackfill] 未解析到剧集 guid，跳过剧集级回填');
            }
        } catch (e: any) {
            dlog('[bgBackfill] 剧集级回填异常 ' + String(e).substring(0, 100));
        }

        // 6) 结果反馈
        const done = stats.filled + stats.upgraded;
        const uv = stats.unverified;
        if (stats.failed) {
            setBtn(btn, '⚠ 补全 ' + done + ' · 失败 ' + stats.failed, '部分集写入失败，详见日志；可再点一次重试。');
        } else if (done) {
            setBtn(btn, '✓ 中文回填 ' + stats.filled + ' · 原文兜底 ' + stats.upgraded + (uv ? ' · 未确认 ' + uv : ''),
                uv ? '已提交但部分复核未确认，刷新页面核实；详见日志。'
                   : (stats.upgraded ? '部分集数据源无中文，已用原文补齐（未加锁，后续中文可覆盖）。' : '标题/简介已写回飞牛元数据' + seriesNote + '。'));
        } else if (uv) {
            setBtn(btn, '⚠ 已提交 ' + uv + ' · 未确认', '写回已提交但复核未确认，请刷新页面核实；详见日志。');
        } else if (stats.unmatched) {
            setBtn(btn, '⚠ ' + stats.unmatched + ' 集未匹配', '数据源缺这些集的数据或集号对不上。');
        } else {
            setBtn(btn, '✓ 数据已最新' + seriesNote, '每集标题/简介都已一致，无需补全。');
        }
        log('[bgBackfill] 完成「' + searchTitle + '」 total=' + stats.total + ' filled=' + stats.filled
            + ' fallback=' + stats.upgraded + ' unchanged=' + stats.unchanged
            + ' unmatched=' + stats.unmatched + ' failed=' + stats.failed
            + ' unverified=' + stats.unverified);
    } catch (e: any) {
        const msg = String(e && e.message || e).substring(0, 80);
        log('[bgBackfill] 失败: ' + msg);
        if (btn.isConnected) {
            setBtn(btn, '⚠ ' + msg, msg);
            btn.style.color = 'var(--fnos-ui-warn,#b06a3a)';
            window.setTimeout(() => { if (btn.isConnected) { btn.style.color = ''; setBtn(btn, '⟳ 自定义刮削'); } }, 5000);
        }
        _running = false;
        return;
    }
    window.setTimeout(() => {
        _running = false;
        if (btn.isConnected) setBtn(btn, '⟳ 自定义刮削');
    }, 4000);
}

/** 导航钩子调用：季页 → 有界重试链挂按钮；离开 → 撤按钮（与 scheduleEpBackfill 同一批调用点）。 */
export function scheduleBangumiBackfill(): void {
    for (let i = 0; i < _retryTimers.length; i++) clearTimeout(_retryTimers[i]);
    _retryTimers = [];
    if (!seasonGuid()) { removeBangumiFixButton(); return; }
    for (let i = 0; i < RETRY_DELAYS.length; i++) {
        _retryTimers.push(window.setTimeout(() => {
            if (!seasonGuid()) return;               // 已离开该页
            ensureBangumiFixButton();
        }, RETRY_DELAYS[i]));
    }
}
