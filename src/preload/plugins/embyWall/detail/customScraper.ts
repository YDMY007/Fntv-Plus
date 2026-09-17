// embyWall/detail/customScraper.ts — [自定义刮削] 自定义刮削源回填（移植自 Web 版 fpk v1.5.0+）
// ─────────────────────────────────────────────────────────────────────────────
// 用户方案：不改 trim.media 官方刮削（不动 --item/系统文件），由本应用在前端层做
// 「标题 → 自定义刮削服务 → 元数据回填飞牛」：
//   1) [lc-1177] 季页第二个按钮「⟳ 自定义刮削」（由 bangumiBackfill 挂载）内部：
//      先走 Bangumi，Bangumi 未匹配/失败 → 回落本模块的自建服务通道（runCustomScraperFlow）；
//      本模块**不再单独挂按钮**（旧的 fnos-cs-scraper-btn 已撤，避免一排三个按钮两个同名）。
//   2) 读季信息（getEditDetail）拿标题/季号/TMDB id，枚举本季集（item/list，DOM 兜底）；
//   3) POST {title, season, tmdbId, episodes:[{index,guid}]} 到用户配置的自定义刮削地址；
//      期望响应 JSON：{ "episodes": [ { "index": 1, "title": "...", "overview": "..." }, ... ] }
//      （index 缺省按数组序号+1；title/overview 均可选，null/缺省=不动该字段）
//   4) 逐集 getEditDetail 读全量 → 合并（仅覆盖空值/可升级值，绝不倒打中文）→ saveEditDetail
//      全量回写（*_locked 字段仿 epBackfill），并做读回复核 + DOM 即时补丁。
// 复用 epBackfill 的全部管线函数（fnosEpisodeList/decideField/patchEpisodeCard/…）。
// 桌面版适配（fpk 交接报告 §6.2 方案 2）：③ 的服务请求经主进程 `custom-scraper:fetch`
//   代理转发——桌面用户不必给自建服务配 CORS 头（Web 版直连才需要）。
// 设置项（config.json，与 Web 版键名对齐）：customScraperEnabled / customScraperUrl。
// ─────────────────────────────────────────────────────────────────────────────
import { ipcRenderer } from 'electron';
import { dlog, log } from '../log';
import { S } from '../state';
import { fnosGetEditDetail } from '../carousel/logo';
import {
  decideField, numOrNull, seasonGuid, resolveSeasonMeta,
  fnosEpisodeList, episodeGuidsFromDom, fnosSaveEditDetail,
  patchEpisodeCard, isPlaceholderTitle, setBtn,
} from './epBackfill';

const CONCURRENCY = 4;
let _running = false;

/** 季页判定（同 epBackfill） */
function seasonPageGuid(): string | null { return seasonGuid(); }

/** 调自定义刮削服务：POST {title, season, tmdbId, episodes} → 规范化响应。
 *  桌面版经主进程转发（免 CORS）；主进程通道异常时回落页面直连（自建服务若配了 CORS 仍可用）。
 *  容错：episodes 数组元素允许 {index, episode, number} 任一作集号；title/name；overview/description。 */
async function fetchFromCustomScraper(
  url: string, payload: {
    title: string; season: number; tmdbId: string;
    trimId?: string; imdbId?: string; doubanId?: string; guid?: string;
    episodes: { index: number | null; guid: string }[];
  },
): Promise<Map<number, { title: string | null; overview: string | null }>> {
  const out = new Map<number, { title: string | null; overview: string | null }>();
  let j: any = null;
  try {
    const r: any = await ipcRenderer.invoke('custom-scraper:fetch', { url, payload });
    if (r && r.ok) {
      j = r.data;
    } else {
      // 主进程转发失败（网络层）→ 回落页面直连（服务配了 CORS 时仍可通）
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      j = await resp.json();
    }
  } catch (e: any) {
    throw new Error('自定义刮削服务请求失败: ' + String(e && e.message || e).substring(0, 100));
  }
  const eps = j && (Array.isArray(j.episodes) ? j.episodes : (Array.isArray(j.data) ? j.data : null));
  if (!eps) throw new Error('响应缺少 episodes 数组');
  eps.forEach((e: any, i: number) => {
    if (!e || typeof e !== 'object') return;
    const num = numOrNull(e.index ?? e.episode ?? e.number) ?? (i + 1);
    const title = (e.title ?? e.name) != null ? String(e.title ?? e.name).trim() : null;
    const overview = (e.overview ?? e.description) != null ? String(e.overview ?? e.description).trim() : null;
    out.set(num, { title: title || null, overview: overview || null });
  });
  return out;
}

/**
 * [lc-1177] 自定义刮削回填主流程（与 epBackfill.runBackfill 同构，数据源换成自定义地址）。
 * ⚠ 本模块**不再单独挂按钮**（旧 `fnos-cs-scraper-btn` 已撤）——季页只保留两个按钮：
 *   ①「⟳ 补全集信息」= TMDB（epBackfill）；②「⟳ 自定义刮削」= 统一入口（bangumiBackfill），
 *   先走 Bangumi，Bangumi 未匹配时由本函数接手回落。故导出给 bangumiBackfill 调用。
 * 返回 true = 已接手并完成（含"数据已最新"），false = 未配置/无数据/失败（调用方继续报错）。
 */
export async function runCustomScraperFlow(btn: HTMLElement): Promise<boolean> {
  const guid = seasonPageGuid();
  if (!guid || _running) return false;
  const enabled = S.customScraperEnabled;
  const url = String(S.customScraperUrl || '').trim();
  if (!enabled || !url) {
    setBtn(btn, '⚠ 未配置', 'Bangumi 未匹配；请到 侧栏设置 → 自定义刮削 → 自定义刮削源 开启并填写地址。');
    window.setTimeout(() => { if (btn.isConnected) setBtn(btn, '⟳ 自定义刮削'); }, 5000);
    return false;
  }
  _running = true;
  const origin = location.origin;
  const stats = { filled: 0, upgraded: 0, unchanged: 0, failed: 0, unmatched: 0, total: 0 };
  const tick = (): void => {
    const done = stats.filled + stats.upgraded + stats.unchanged + stats.failed + stats.unmatched;
    if (btn.isConnected) setBtn(btn, '⏳ 回填中 ' + done + '/' + stats.total);
  };
  try {
    // 1) 季信息：标题/季号/TMDB id（给自定义服务尽可能多的匹配线索）
    //    [lc-1176] 季自身字段 → 父级剧集 → DOM → document.title 四级兜底（Bangumi 源季标题恒空）
    const data = await fnosGetEditDetail(origin, guid);
    if (!data) throw new Error('读取季信息失败（getEditDetail）');
    const meta = await resolveSeasonMeta(origin, guid);
    // [v1.7.0] 锚点全链(精准匹配优先级): tmdb_id > trim_id(tt…) > imdb_id > douban_id
    const tmdbId = ((): string => {
      const t = data.tmdb_id ?? data.tmdbId;
      const s = String(t ?? '').trim();
      return /^\d+$/.test(s) ? s : (meta.tmdbId || '');
    })();
    const trimId = String(data.trim_id ?? '').trim();        // 形如 tt1399 / bg456080
    const imdbId = String(data.imdb_id ?? '').trim();
    const doubanId = String(data.douban_id ?? '').trim();
    const title = meta.title;
    const seasonNumber = meta.seasonNumber;
    if (!title && !tmdbId) throw new Error('无标题且无 TMDB id，无法刮削');

    // 2) 枚举本季集
    let episodes = await fnosEpisodeList(origin, guid).catch(() => [] as { guid: string; index: number | null }[]);
    if (!episodes.length) episodes = episodeGuidsFromDom();
    if (!episodes.length) throw new Error('未枚举到本季任何集');
    stats.total = episodes.length;

    // 3) 请求自定义刮削服务
    setBtn(btn, '⏳ 请求刮削服务…');
    const scrap = await fetchFromCustomScraper(url, {
      title, season: seasonNumber ?? 0, tmdbId,
      trimId, imdbId, doubanId, guid,
      episodes,
    });
    if (!scrap.size) {
      setBtn(btn, '⚠ 服务无分集数据', '自定义服务响应的 episodes 为空。');
      window.setTimeout(() => { if (btn.isConnected) setBtn(btn, '⟳ 自定义刮削'); }, 5000);
      _running = false;
      return false;
    }

    // 4) 逐集读全量 → 裁决合并 → 回写 → 复核 → DOM 补丁（管线与 epBackfill 完全一致）
    let idx = 0;
    const worker = async (): Promise<void> => {
      while (idx < episodes.length) {
        const ep = episodes[idx++];
        try {
          const ed = await fnosGetEditDetail(origin, ep.guid);
          if (!ed) { stats.failed++; tick(); continue; }
          const num = numOrNull(ed.index_number ?? ed.index) ?? ep.index;
          const t = (num !== null) ? scrap.get(num) : undefined;
          if (!t) { stats.unmatched++; tick(); continue; }
          const titleKey = ('title' in ed) ? 'title' : ('name' in ed ? 'name' : 'title');
          const ovKey = ('overview' in ed) ? 'overview' : ('description' in ed ? 'description' : 'overview');
          const curTitle = String(ed[titleKey] ?? '');
          const curOv = String(ed[ovKey] ?? '');
          // 空值填入 + 纯占位符可覆盖；绝不拿英文倒打已有中文（decideField 语义与 epBackfill 一致）
          const newTitle = decideField(curTitle, t.title || '', '', isPlaceholderTitle);
          const newOv = decideField(curOv, t.overview || '', '');
          if (newTitle === null && newOv === null) { stats.unchanged++; tick(); continue; }
          const body: any = { ...ed, nonce: fnNonce() };
          if (!body.guid && !body.item_guid) body.guid = ep.guid;
          let titleChanged = false, ovChanged = false;
          if (newTitle !== null) { body[titleKey] = newTitle; body.title_locked = true; titleChanged = true; }
          if (newOv !== null) { body[ovKey] = newOv; body.overview_locked = true; ovChanged = true; }
          const saved = await fnosSaveEditDetail(origin, body);
          if (!saved) { stats.failed++; tick(); continue; }
          const vf = await fnosGetEditDetail(origin, ep.guid);
          const vTitle = String(vf ? (vf[titleKey] ?? '') : '');
          const vOv = String(vf ? (vf[ovKey] ?? '') : '');
          if ((titleChanged && vTitle.trim() !== (newTitle as string).trim())
            || (ovChanged && vOv.trim() !== (newOv as string).trim())) {
              stats.failed++; tick(); continue;
          }
          if (titleChanged) stats.filled++;
          if (ovChanged) stats.filled++;
          patchEpisodeCard(ep.guid, titleChanged ? (newTitle as string) : null, ovChanged ? (newOv as string) : null);
          tick();
        } catch (e: any) {
          stats.failed++;
          dlog('[customScraper] 单集异常 ' + ep.guid + ' ' + String(e && e.message || e).substring(0, 100));
          tick();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, episodes.length) }, worker));

    // 5) 结果反馈
    const done = stats.filled;
    if (stats.failed) {
      setBtn(btn, '⚠ 回填 ' + done + ' · 失败 ' + stats.failed, '部分集写入失败，详见日志；可再点一次重试。');
    } else if (done) {
      setBtn(btn, '✓ 已回填 ' + stats.filled + ' 项', '自定义刮削数据已写回飞牛元数据。');
    } else if (stats.unmatched) {
      setBtn(btn, '⚠ ' + stats.unmatched + ' 集未匹配', '自定义服务未返回这些集的数据。');
    } else {
      setBtn(btn, '✓ 数据已最新', '与自定义刮削服务一致，无需回填。');
    }
    log('[customScraper] 完成 ' + (title || tmdbId) + ' total=' + stats.total + ' filled=' + stats.filled
      + ' unchanged=' + stats.unchanged + ' unmatched=' + stats.unmatched + ' failed=' + stats.failed);
    // 有集写回、或全部已是最新 = 本通道已接手（"服务未返回这些集"也视为已尝试过，不再回落报错）
    return true;
  } catch (e: any) {
    const msg = String(e && e.message || e).substring(0, 80);
    log('[customScraper] 失败: ' + msg);
    if (btn.isConnected) {
      setBtn(btn, '⚠ ' + msg, msg);
      btn.style.color = 'var(--fnos-ui-warn,#b06a3a)';
      window.setTimeout(() => { if (btn.isConnected) { btn.style.color = ''; setBtn(btn, '⟳ 自定义刮削'); } }, 6000);
    }
    return false;
  } finally {
    _running = false;
  }
}

function fnNonce(): string {
  return String(Math.floor(Math.random() * 900000) + 100000);
}

/** [v1.5.0] 自举：模块加载即拉一次设置同步 S（不依赖用户打开设置面板）。
 *  [lc-1177] 按钮并入「⟳ 自定义刮削」统一入口后，这里只负责同步开关/地址，不再自行挂按钮。 */
function bootstrapFromSettings(): void {
  try {
    ipcRenderer.invoke('settings:get').then((s: any) => {
      if (!s || typeof s !== 'object') return;
      S.customScraperEnabled = s.customScraperEnabled === true;
      S.customScraperUrl = String(s.customScraperUrl || '');
    }).catch(() => { /* ignore */ });
  } catch { /* ignore */ }
}
bootstrapFromSettings();
