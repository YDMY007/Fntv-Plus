// embyWall/detail/jav.ts — [v1.10.x] JAV 番号刮削（个人库整理，设置卡默认关闭）。
// ─────────────────────────────────────────────────────────────────────────────
// 背景：JAV 文件飞牛原生刮削基本瞎匹配（标题=文件名、海报错乱）。文件名里的番号
//（ABC-123 / FC2-PPV-1234567）是天然匹配键 → 后端 jav/lookup（javbus 抓取，jav.go）
// 按番号取 标题/封面/日期/类别/演员，本模块在详情页提供「⟳ jav 刮削」按钮：
//   1) getEditDetail 读条目 → 标题里提取番号（后端同款正则，前端只透传标题）；
//   2) 查询成功 → saveEditDetail 全量读改写回填 标题/简介/发行日期/演员 + 对应 *_locked
//     （防飞牛再刮削覆盖，仿 epBackfill）。演员须先 /person/search 查重 → /person/create
//     拿真实 guid（实测：person_guid 空串被静默丢弃、temp-person__ 前缀被硬拒 -6）；
//   3) 封面经 jav:image 代理取回 dataURL → uploadImageToFnos('poster') 临时图床 →
//     hash_path 写 posters 字段落库（2026-09-19 实测：posters 为单 hash_path 字符串、
//     image_type='poster' code=0；folder 自定义封面需 poster_type=1 Single）；
//   4) 按钮状态机反馈（未识别番号 / 查询失败 / 已回填），详情进日志。
// 挂载：body 级浮动胶囊按钮。路由支持 电影 /v/movie/<32hex>（guid 裸 hex）、
//   文件夹 /v/folder/fv_<32hex>（条目 guid 必须带 fv_ 前缀，裸 hex 返回 code -6）与
//   文件 /v/other/<32hex>（guid 裸 hex）+ S.javEnabled 开关，与 epBackfill/customScraper
//   同一批导航钩子调度（embyWall.ts scheduleJavButton）。
//   识别靠标题番号、不靠目录名（每用户目录结构/命名都不同）。folder 路由回填双层：
//   文件夹本体 + 其下全部子视频（POST item/list {parent_guid,exclude_folder:1} type=Video，
//   [lc-1250] 夹名识别不到番号（混合番号夹）→ 降级逐子视频按各自文件名番号批量刮，
//   实测子项 guid 为裸 hex），一层影片一文件夹的整理习惯下即「整套落库」。
// ─────────────────────────────────────────────────────────────────────────────
import { ipcRenderer } from 'electron';
import { dlog, log } from '../log';
import { S } from '../state';
import { findActiveDetailView, findDetailHero } from './glass';
import { fnosGetEditDetail, uploadImageToFnos } from '../carousel/logo';
import { fnosSaveEditDetail } from './epBackfill';
import { repositionFolderScraperButton } from './folderScraper';

const JAV_BTN_ID = 'fnos-jav-btn';
let _running = false;

/** 电影详情路由 guid（/v/movie/<32hex>，裸 hex）。 */
export function movieGuid(): string | null {
  const m = location.pathname.match(/\/v\/movie\/([a-f0-9]{32})/);
  return m ? m[1] : null;
}

/** 文件夹详情路由 guid（/v/folder/fv_<32hex> → 条目 guid 带 fv_ 前缀，飞牛编辑接口仅认此形态）。 */
export function folderGuid(): string | null {
  const m = location.pathname.match(/\/v\/folder\/fv_([a-f0-9]{32})/);
  return m ? 'fv_' + m[1] : null;
}

/** 文件条目路由 guid（/v/other/<32hex>，裸 hex——与 folder 的 fv_ 前缀不同，实测确认）。 */
export function otherGuid(): string | null {
  const m = location.pathname.match(/\/v\/other\/([a-f0-9]{32})/);
  return m ? m[1] : null;
}

/** 当前详情条目 guid（电影/folder/文件三种路由，jav 刮削共用一条回填管线）。 */
function detailGuid(): string | null {
  return folderGuid() || otherGuid() || movieGuid();
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
  btn.setAttribute('title', '从标题番号在 javbus 查询并回填 标题/简介/日期/演员/封面（封面经临时图床落库）。设置→自定义刮削→Jav 刮削 开关。');
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

/** 幂等挂载：电影/folder 路由 + 开启 → 确保按钮在；否则撤按钮。 */
export function ensureJavButton(): void {
  schedulePendingLayoutSwitch(); // [lc-1250] 有待切横幅时, 每次导航先补切
  const onList = listOtherPage();
  if (!S.javEnabled || (!detailGuid() && !onList)) { removeJavButton(); return; }
  const existing = document.getElementById(JAV_BTN_ID);
  if (existing && existing.isConnected) {
    // 路由间共用一枚按钮：按当前页型刷新文案（运行中不打断进度显示）
    if (!_running) setBtn(existing, onList ? '⟳ 全库刮削' : '⟳ jav 刮削');
    repositionFolderScraperButton(); // [lc-1250] jav 在位 → 文件夹刮削按钮让位上移
    return;
  }
  makeBtn();
  const b = document.getElementById(JAV_BTN_ID);
  if (b && onList) setBtn(b, '⟳ 全库刮削');
  repositionFolderScraperButton(); // [lc-1250] 异步挂载完成后立即让文件夹刮削按钮避让
  dlog('[jav] 按钮已挂载 ' + location.pathname);
}

export function removeJavButton(): void {
  const b = document.getElementById(JAV_BTN_ID);
  if (b && b.parentNode) b.parentNode.removeChild(b);
  repositionFolderScraperButton(); // [lc-1250] jav 摘除 → 文件夹刮削按钮落回底部
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
    if (S.javEnabled && (detailGuid() || listOtherPage())) ensureJavButton();
  }).catch(() => { /* ignore */ });
} catch { /* ignore */ }

/** 简介：演员/发行日期/类别拼摘要（javbus 元数据都是短标签，行式排版）。 */
function buildOverview(meta: any): string {
  const parts: string[] = [];
  if (Array.isArray(meta.actresses) && meta.actresses.length) {
    parts.push('【演员】' + meta.actresses.map((a: any) => a && a.name).filter(Boolean).join('・'));
  }
  if (meta.date) parts.push('【发行】' + meta.date);
  if (Array.isArray(meta.genres) && meta.genres.length) parts.push('【类别】' + meta.genres.join('・'));
  return parts.join('\n');
}

/** person/search {keyword} → 候选列表（按名字精确匹配取 guid）。 */
async function fnosPersonSearch(origin: string, keyword: string): Promise<any[]> {
  try {
    const body = { keyword, nonce: fnNonce() };
    const authx = await ipcRenderer.invoke('fnos-gen-authx', '/v/api/v1/person/search', body).catch(() => '');
    const resp = await fetch(origin + '/v/api/v1/person/search', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(authx ? { Authx: authx } : {}) },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return [];
    const j = await resp.json().catch(() => null);
    return (j && j.code === 0 && j.data && Array.isArray(j.data.list)) ? j.data.list : [];
  } catch { return []; }
}

/** person/create {name} → 真实 person guid（原生「新建演员」同款端点）。 */
async function fnosPersonCreate(origin: string, name: string): Promise<string> {
  try {
    const body = { name, nonce: fnNonce() };
    const authx = await ipcRenderer.invoke('fnos-gen-authx', '/v/api/v1/person/create', body).catch(() => '');
    const resp = await fetch(origin + '/v/api/v1/person/create', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(authx ? { Authx: authx } : {}) },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return '';
    const j = await resp.json().catch(() => null);
    return (j && j.code === 0 && j.data && j.data.guid) ? String(j.data.guid) : '';
  } catch { return ''; }
}

/** 演员 → credits。person_guid 必须为真实 guid：空串被服务端静默丢弃（code 0 但不入库）、
 *  原生前端的 temp-person__ 前缀被硬拒（-6）——必须先 /person/search 查重、没有再 /person/create。
 *  单个演员失败只跳过该演员，不毁掉整次回填。 */
async function buildCredits(origin: string, meta: any): Promise<any[]> {
  const out: any[] = [];
  const names = (Array.isArray(meta.actresses) ? meta.actresses : [])
    .map((a: any) => String((a && a.name) || '').trim()).filter(Boolean);
  for (let i = 0; i < names.length; i++) {
    let guid = '';
    try {
      const hits = await fnosPersonSearch(origin, names[i]);
      const hit = hits.find((p: any) => String((p && p.name) || '').trim() === names[i] && p.guid);
      guid = hit ? String(hit.guid) : await fnosPersonCreate(origin, names[i]);
    } catch { /* guid 留空 → 跳过 */ }
    if (!guid) continue;
    out.push({ job: 'Actor', name: names[i], order: i, person_guid: guid, profile_path: '', role: '' });
  }
  return out;
}

/** [lc-1276] 演员写入判定（写前跳过 + 写后复核共用）：「写入的每个演员名都在读回集合中」。
 *  不比对顺序/job/长度——fnOS 读回 credits 会重排并补人员 guid，逐项全等会把写成功误判
 *  为需重写/复核未过；集合包含语义也更稳：条目已有用户手动加的演员时不覆盖。 */
function creditsWrittenPresent(want: any[], got: any): boolean {
  if (!Array.isArray(got)) return false;
  const gotNames = new Set(got.map((c: any) => String((c && c.name) || '').trim()).filter(Boolean));
  return want.every((c) => gotNames.has(String((c && c.name) || '').trim()));
}

/** folder 子项里的视频文件（单层，不递归子文件夹）：item/list {parent_guid, exclude_folder:1}
 *  → type=Video（实测子项 guid 为裸 hex，与 epBackfill 的 episode 列表同端点不同类型过滤）。 */
async function folderChildVideos(origin: string, fGuid: string): Promise<string[]> {
  try {
    const body = { parent_guid: fGuid, exclude_folder: 1, sort_column: 'sort_title', sort_type: 'ASC', nonce: fnNonce() };
    const authx = await ipcRenderer.invoke('fnos-gen-authx', '/v/api/v1/item/list', body).catch(() => '');
    const resp = await fetch(origin + '/v/api/v1/item/list', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(authx ? { Authx: authx } : {}) },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return [];
    const j = await resp.json().catch(() => null);
    const list = (j && j.code === 0 && j.data && Array.isArray(j.data.list)) ? j.data.list : [];
    return list
      .filter((it: any) => it && it.guid && String(it.type || '').toLowerCase() === 'video')
      .map((it: any) => String(it.guid))
      .filter((g: string) => /^[a-f0-9]{32}$/.test(g));
  } catch { return []; }
}

/** 单条目回填：全量读改写（仅改本流程负责的字段 + locked），写后复核。
 *  prep 里的 ov/credits/coverHash 由调用方准备一次、跨条目复用（人员/封面不重复建/传）。 */
async function backfillOne(origin: string, guid: string, prep: { meta: any; ov: string; credits: any[]; coverHash: string }): Promise<{ saved: boolean; verified: boolean; done: string[] }> {
  const data = await fnosGetEditDetail(origin, guid);
  if (!data) return { saved: false, verified: false, done: [] };
  const meta = prep.meta;
  const titleKey = ('title' in data) ? 'title' : (('name' in data) ? 'name' : 'title');
  const curTitle = String(data[titleKey] || '').trim();
  const body: any = { ...data, nonce: fnNonce() };
  if (!body.guid && !body.item_guid) body.guid = guid;
  const done: string[] = [];
  const newTitle = String(meta.title || '').trim();
  if (newTitle && newTitle !== curTitle) {
    body[titleKey] = newTitle;
    body.title_locked = true;
    done.push('标题');
  }
  if (prep.ov && prep.ov !== String(data.overview || '').trim()) {
    body.overview = prep.ov;
    body.overview_locked = true;
    done.push('简介');
  }
  if (meta.date && meta.date !== String(data.air_date || '').trim()) {
    body.air_date = meta.date;
    body.air_date_locked = true;
    done.push('日期');
  }
  if (prep.credits.length && !creditsWrittenPresent(prep.credits, data.credits)) {
    body.credits = prep.credits;
    body.credits_locked = true;
    done.push('演员');
  }
  if (prep.coverHash && prep.coverHash !== String(data.posters || '').trim()) {
    body.posters = prep.coverHash;
    body.posters_locked = true;
    if (Number(data.poster_type) !== 1) body.poster_type = 1; // Single:自定义封面替换自动截图
    done.push('封面');
  }
  if (!done.length) return { saved: true, verified: true, done: [] };
  const saved = await fnosSaveEditDetail(origin, body);
  let verified = false;
  if (saved) {
    const vf = await fnosGetEditDetail(origin, guid);
    verified = !!vf;
    // [lc-1276] 容错复核：fnOS 读回时会对字段做归一化（日期补时间/posters 变形态/credits
    // 重排或补人员 guid），逐字节全等会把「写成功」误判成「复核未通过」。改语义级比对：
    // 日期比日期部分、posters 按文件名包含、credits 按「写入的演员都在读回集合中」（忽略
    // 顺序/job 形态）；标题/简介 fnOS 原样回读，保持 trim 全等。
    if (verified && body.title_locked) verified = String(vf[titleKey] ?? '').trim() === newTitle;
    if (verified && body.overview_locked) verified = String(vf.overview ?? '').trim() === prep.ov;
    if (verified && body.air_date_locked) verified = String(vf.air_date ?? '').trim().slice(0, 10) === String(body.air_date).trim().slice(0, 10);
    if (verified && body.posters_locked) {
      const got = String(vf.posters ?? '').trim();
      const want = String(prep.coverHash || '').trim();
      const base = want.split('/').pop() || want;
      verified = got === want || (base !== '' && got.indexOf(base) >= 0);
    }
    if (verified && body.credits_locked) verified = creditsWrittenPresent(prep.credits, vf.credits);
  }
  return { saved, verified, done };
}

/** [lc-1250] 其他视频库列表页路由（/v/list/other，query 不参与判定）。 */
export function listOtherPage(): boolean {
  return /^\/v\/list\/other\/?$/.test(location.pathname);
}

/** [lc-1250] 单条准备：按标题查 javbus → 简介/演员/封面一次性备齐。
 *  返回 { nocode:true }（标题识别不到番号）/ { err }（javbus 失败等）/ { prep }（成功）。 */
async function javPrepByTitle(origin: string, guid: string, title: string): Promise<{ nocode?: boolean; err?: string; prep?: { meta: any; ov: string; credits: any[]; coverHash: string } }> {
  const r: any = title ? await ipcRenderer.invoke('jav:lookup', { title, guid }) : null;
  if (!r || !r.ok) {
    const err = String((r && r.error) || '查询失败');
    return err.indexOf('番号') >= 0 ? { nocode: true } : { err };
  }
  const meta = r.meta || {};
  const ov = buildOverview(meta);
  const credits = await buildCredits(origin, meta).catch(() => [] as any[]);
  let coverHash = '';
  if (meta.cover) {
    try {
      const img: any = await ipcRenderer.invoke('jav:image', { url: meta.cover });
      if (img && img.ok && img.dataUrl) {
        coverHash = (await uploadImageToFnos(origin, img.dataUrl, 'poster')) || '';
      }
    } catch (e: any) { dlog('[jav] 封面准备失败: ' + String(e).substring(0, 80)); }
  }
  return { prep: { meta, ov, credits, coverHash } };
}

/** [lc-1250] 单条「按自身标题番号查询+完整落库」。返回 'ok' | 'nocode' | 'fail'。 */
async function javScrapeByTitle(origin: string, guid: string, title: string): Promise<'ok' | 'nocode' | 'fail'> {
  const p = await javPrepByTitle(origin, guid, title);
  if (p.nocode) return 'nocode';
  if (!p.prep) return 'fail';
  const res = await backfillOne(origin, guid, p.prep);
  return res.saved ? 'ok' : 'fail';
}

/** [lc-1250] 全库根级枚举：不带 parent_guid 的 item/list 即全库视图（实测返回
 *  Directory/Movie/TV 等）。只收 Directory（须 ancestor_category=Others，防止把
 *  电视剧库目录拖进来）与未识别 Video；Movie/TV 已识别作品跳过。分页取完。 */
async function listLibraryRoot(origin: string): Promise<{ dirs: string[]; videos: string[] }> {
  const dirs: string[] = [];
  const videos: string[] = [];
  for (let page = 1; page <= 50; page++) {
    const body = { sort_column: 'sort_title', sort_type: 'ASC', page, page_size: 200, nonce: fnNonce() };
    const authx = await ipcRenderer.invoke('fnos-gen-authx', '/v/api/v1/item/list', body).catch(() => '');
    const resp = await fetch(origin + '/v/api/v1/item/list', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(authx ? { Authx: authx } : {}) },
      body: JSON.stringify(body),
    });
    if (!resp.ok) break;
    const j = await resp.json().catch(() => null);
    const list = (j && j.code === 0 && j.data && Array.isArray(j.data.list)) ? j.data.list : [];
    for (const it of list) {
      if (!it || !it.guid) continue;
      const g = String(it.guid);
      const t = String(it.type || '').toLowerCase();
      if (t === 'directory' && String(it.ancestor_category || '') === 'Others') dirs.push(g);
      else if (t === 'video') videos.push(g);
    }
    if (list.length < 200) break;
  }
  return { dirs, videos };
}

/** [lc-1250] 枚举文件夹直属子项（不带 exclude_folder）：Video → videos，Directory → dirs。
 *  实测子文件夹 type=Directory、guid 带 fv_ 前缀。 */
async function folderChildren(origin: string, fGuid: string): Promise<{ videos: string[]; dirs: string[] }> {
  const videos: string[] = [];
  const dirs: string[] = [];
  try {
    const body = { parent_guid: fGuid, sort_column: 'sort_title', sort_type: 'ASC', nonce: fnNonce() };
    const authx = await ipcRenderer.invoke('fnos-gen-authx', '/v/api/v1/item/list', body).catch(() => '');
    const resp = await fetch(origin + '/v/api/v1/item/list', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(authx ? { Authx: authx } : {}) },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return { videos, dirs };
    const j = await resp.json().catch(() => null);
    const list = (j && j.code === 0 && j.data && Array.isArray(j.data.list)) ? j.data.list : [];
    for (const it of list) {
      if (!it || !it.guid) continue;
      const g = String(it.guid);
      const t = String(it.type || '').toLowerCase();
      if (t === 'video' && /^[a-f0-9]{32}$/.test(g)) videos.push(g);
      else if (t === 'directory') dirs.push(g);
    }
  } catch { /* 返回已收集部分 */ }
  return { videos, dirs };
}

/** [lc-1250] jav 刮削成功后把「布局」自动切到「横幅海报」：刮入的封面是 1920×1080
 *  横版图，竖幅海报布局会上下裁切难看。实现走原生 UI 自动化（点开工具栏「布局」
 *  下拉 → 点「横幅海报」项），与用户手点完全同路径，不碰任何内部状态/私有 API。
 *  页面没有布局工具栏（详情页等）时返回 false（交给待切记账在下次导航补切）。 */
async function switchLayoutToLandscape(): Promise<boolean> {
  try {
    // ① 工具栏「布局」触发器：叶子 span 文本精确匹配 + 可点祖先
    const spans = Array.from(document.querySelectorAll('span')) as HTMLElement[];
    const trigger = spans.find((s) => (s.textContent || '').trim() === '布局'
      && s.children.length === 0 && s.offsetParent !== null
      && s.closest('[class*="cursor-pointer"]'));
    if (!trigger) { dlog('[jav] 未找到布局菜单（本页无布局工具栏），跳过横幅切换'); return false; }
    const host = (trigger.closest('[class*="cursor-pointer"]') as HTMLElement) || (trigger.parentElement as HTMLElement);
    if (!host) return false;
    host.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    host.click();
    await new Promise((r) => setTimeout(r, 500));
    // ② Semi 下拉 portal（body 级浮层）里找「横幅海报」项
    const items = Array.from(document.querySelectorAll('.semi-dropdown-item, .semi-popover li, [class*="dropdown-item"]')) as HTMLElement[];
    const target = items.find((it) => (it.textContent || '').trim() === '横幅海报' && it.offsetParent !== null);
    if (!target) { dlog('[jav] 布局菜单未弹出或无横幅海报项，跳过'); return false; }
    target.click();
    await new Promise((r) => setTimeout(r, 300));
    log('[jav] 布局已自动切换为横幅海报');
    return true;
  } catch (e: any) {
    dlog('[jav] 布局切换失败: ' + String(e && e.message || e).substring(0, 80));
    return false;
  }
}

let _pendingLayoutSwitch = false;
let _switchChainGen = 0;

/** [lc-1250] 待切横幅记账：单视频详情页没有布局工具栏，刮成功后先记一笔，
 *  导航回文件夹/列表页（工具栏渲染出来）时自动补切。 */
function markPendingLayoutSwitch(): void {
  _pendingLayoutSwitch = true;
}

/** [lc-1250] 补切链：每次导航重置一代表（防旧链叠加），300/900/2000/4000ms 各试一次，
 *  成功（找到工具栏并切换）即清账；一直没工具栏（比如去了首页）则账保留到下次。 */
function schedulePendingLayoutSwitch(): void {
  if (!_pendingLayoutSwitch || _running) return;
  const gen = ++_switchChainGen;
  [300, 900, 2000, 4000].forEach((ms) => {
    window.setTimeout(() => {
      if (gen !== _switchChainGen || !_pendingLayoutSwitch || _running) return;
      void switchLayoutToLandscape().then((ok) => { if (ok) _pendingLayoutSwitch = false; });
    }, ms);
  });
}

/** [lc-1250] 文件夹树递归刮削（用户诉求「在外面就刮」的完整版）：
 *  夹名番号命中 → 本体+直属子视频整体回填（单番号分段夹，同 lc-1222 语义）；
 *  未命中 → 直属子视频按各自文件名番号刮；**子文件夹递归下钻（深度上限 3）**——
 *  修复「混合夹里的套夹（如 测试/SNOS-332-UC/489155.com@SNOS-332-UC.mp4）必须
 *  点进具体视频才能刮」的问题。stats/tick 由调用方注入，顺序执行防 javbus 限流。 */
async function javScrapeFolderTree(
  origin: string, fGuid: string, depth: number,
  stats: { ok: number; fail: number; nocode: number },
  tick: (label: string) => void,
): Promise<void> {
  if (depth > 3) return;
  const { videos, dirs } = await folderChildren(origin, fGuid);
  const ed = await fnosGetEditDetail(origin, fGuid).catch(() => null);
  const dTitle = String((ed && (ed.title || ed.name)) || '').trim();
  const p = await javPrepByTitle(origin, fGuid, dTitle);
  if (p.prep) {
    // 单番号夹：本体 + 直属子视频共用同一份元数据
    tick('⏳ 回填 ' + (dTitle || fGuid).slice(0, 16) + '…');
    try {
      const r1 = await backfillOne(origin, fGuid, p.prep);
      if (r1.saved) stats.ok++; else stats.fail++;
    } catch (e: any) { stats.fail++; }
    for (const c of videos) {
      try {
        const r = await backfillOne(origin, c, p.prep);
        if (r.saved) stats.ok++; else stats.fail++;
      } catch (e: any) { stats.fail++; }
    }
  } else {
    if (p.nocode) stats.nocode++; else stats.fail++;
    for (const c of videos) {
      const ced = await fnosGetEditDetail(origin, c).catch(() => null);
      const cTitle = String((ced && (ced.title || ced.name)) || '').trim();
      tick('⏳ 刮削 ' + (cTitle || c).slice(0, 16) + '…');
      try {
        const st = await javScrapeByTitle(origin, c, cTitle);
        if (st === 'ok') stats.ok++; else if (st === 'nocode') stats.nocode++; else stats.fail++;
      } catch (e: any) { stats.fail++; }
    }
  }
  for (const d of dirs) {
    await javScrapeFolderTree(origin, d, depth + 1, stats, tick);
  }
}

/** [lc-1250] 混合番号文件夹批量刮削入口（文件夹页按钮）：递归整棵文件夹树。
 *  返回按钮结果摘要。 */
async function runJavBatchChildren(btn: HTMLButtonElement, origin: string, fGuid: string): Promise<string> {
  const stats = { ok: 0, fail: 0, nocode: 0 };
  const tick = (label: string): void => {
    const done = stats.ok + stats.fail + stats.nocode;
    setBtn(btn, label + ' (' + done + ')');
  };
  await javScrapeFolderTree(origin, fGuid, 0, stats, tick);
  log('[jav] 文件夹批量完成: ok=' + stats.ok + ' fail=' + stats.fail + ' nocode=' + stats.nocode);
  if (stats.ok > 0) { // [lc-1250] 横版封面配横幅海报布局（当场切, 失败留给补切链）
    markPendingLayoutSwitch();
    if (await switchLayoutToLandscape()) _pendingLayoutSwitch = false;
  }
  if (stats.ok) return '✓ 已回填 ' + stats.ok + (stats.nocode ? ' · 未识别 ' + stats.nocode : '') + (stats.fail ? ' · 失败 ' + stats.fail : '');
  if (stats.nocode) return '⚠ ' + stats.nocode + ' 个未识别番号';
  return '⚠ 回填失败';
}

/** [lc-1250] 其他视频库列表页（/v/list/other）一键全库刮削：根级 Directory(Others) 递归
 *  整棵文件夹树（语义同上），根级未识别 Video 按自身标题刮；Movie/TV 已识别作品跳过。
 *  顺序执行，按钮实时进度。 */
async function runJavLibrary(btn: HTMLButtonElement, origin: string): Promise<string> {
  setBtn(btn, '⏳ 枚举库内容…');
  const { dirs, videos } = await listLibraryRoot(origin);
  if (!dirs.length && !videos.length) return '⚠ 未枚举到可刮内容';
  const stats = { ok: 0, fail: 0, nocode: 0 };
  let done = 0;
  const tick = (label: string): void => {
    done = stats.ok + stats.fail + stats.nocode;
    setBtn(btn, label + ' (' + done + ')');
  };
  for (const d of dirs) {
    await javScrapeFolderTree(origin, d, 0, stats, tick);
  }
  for (const v of videos) {
    try {
      const ed = await fnosGetEditDetail(origin, v).catch(() => null);
      const vTitle = String((ed && (ed.title || ed.name)) || '').trim();
      const st = await javScrapeByTitle(origin, v, vTitle);
      if (st === 'ok') stats.ok++; else if (st === 'nocode') stats.nocode++; else stats.fail++;
    } catch (e: any) { stats.fail++; }
    tick('⏳ 全库刮削');
  }
  log('[jav] 全库批量完成: ok=' + stats.ok + ' fail=' + stats.fail + ' nocode=' + stats.nocode);
  if (stats.ok > 0) { // [lc-1250] 横版封面配横幅海报布局（当场切, 失败留给补切链）
    markPendingLayoutSwitch();
    if (await switchLayoutToLandscape()) _pendingLayoutSwitch = false;
  }
  if (stats.ok) return '✓ 已回填 ' + stats.ok + (stats.nocode ? ' · 未识别 ' + stats.nocode : '') + (stats.fail ? ' · 失败 ' + stats.fail : '');
  if (stats.nocode) return '⚠ ' + stats.nocode + ' 个未识别番号';
  return '⚠ 回填失败';
}

/** 主流程：读条目 → javbus 查询 → 一次性准备（演员/封面跨条目复用）→ 双层回填 → hero 就地刷新。 */
async function runJav(btn: HTMLButtonElement): Promise<void> {
  if (_running) return;
  const origin = location.origin;
  // [lc-1250] 其他视频库列表页：一键全库刮削（无单条目上下文，独立分支）
  if (listOtherPage()) {
    _running = true;
    try {
      const summary = await runJavLibrary(btn, origin);
      setBtn(btn, summary, summary.indexOf('⚠') === 0 ? summary : 'jav 全库刮削完成，可重进页面查看。');
      btn.style.color = summary.indexOf('⚠') === 0 ? 'var(--fnos-ui-warn,#b06a3a)' : '';
      window.setTimeout(() => {
        if (btn.isConnected) { btn.style.color = ''; setBtn(btn, '⟳ 全库刮削'); }
      }, 8000);
    } finally { _running = false; }
    return;
  }
  const folderG = folderGuid();
  const guid = folderG || otherGuid() || movieGuid();
  if (!guid) return;
  _running = true;
  try {
    // 1) 读条目（取当前标题供番号提取）
    const data = await fnosGetEditDetail(origin, guid);
    if (!data) throw new Error('读取条目失败（getEditDetail）');
    const curTitle = String(data.title || data.name || '').trim();

    // 2) javbus 查询（番号提取在后端：code 优先、标题兜底）
    setBtn(btn, '⏳ jav 查询中…');
    const r: any = await ipcRenderer.invoke('jav:lookup', { title: curTitle, guid });
    if (!r || !r.ok) {
      // [lc-1250] 文件夹名识别不到番号 → 混合番号文件夹场景：降级为逐子视频按各自
      // 文件名番号批量刮削（用户诉求「在外面就刮削」；单番号分段夹仍走下方整体回填）
      if (folderG) {
        const summary = await runJavBatchChildren(btn, origin, folderG);
        setBtn(btn, summary, summary.indexOf('⚠') === 0 ? summary : 'jav 文件夹批量刮削完成，可重进页面查看。');
        btn.style.color = summary.indexOf('⚠') === 0 ? 'var(--fnos-ui-warn,#b06a3a)' : '';
        window.setTimeout(() => {
          if (btn.isConnected) { btn.style.color = ''; setBtn(btn, '⟳ jav 刮削'); }
        }, 8000);
        return;
      }
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

    // 3) 一次性准备：简介文本、演员 credits（人员 search→create 只跑一次，guids 跨层级复用）、
    //    封面上传临时图床（folder 与子视频共用同一 hash）
    const ov = buildOverview(meta);
    setBtn(btn, '⏳ 匹配演员…');
    const credits = await buildCredits(origin, meta);
    let coverDataUrl = '';
    let coverHash = '';
    if (meta.cover) {
      setBtn(btn, '⏳ 封面上传中…');
      try {
        const img: any = await ipcRenderer.invoke('jav:image', { url: meta.cover });
        if (img && img.ok && img.dataUrl) {
          coverDataUrl = img.dataUrl;
          coverHash = (await uploadImageToFnos(origin, coverDataUrl, 'poster')) || '';
        }
      } catch (e) { dlog('[jav] 封面上传失败: ' + String(e).substring(0, 80)); }
    }

    // 4) 回填目标：folder = 本体 + 其下全部子视频（单层）；文件/电影 = 自身
    const targets = folderG ? [folderG, ...(await folderChildVideos(origin, folderG))] : [guid];

    // 5) 逐条目全量读改写 + 复核
    // [lc-1276] 按目标计数而非 all 布尔：folder 批量时单个子项失败会把整批拉成「回填失败」，
    // 用户看到的是多数条目数据已写入 —— 报「部分回填 N/M」才符合实况。
    const done: string[] = [];
    let savedCount = 0;
    let failCount = 0;
    let unverifiedCount = 0;
    for (let i = 0; i < targets.length; i++) {
      setBtn(btn, '⏳ 回填中…(' + (i + 1) + '/' + targets.length + ')');
      const res = await backfillOne(origin, targets[i], { meta, ov, credits, coverHash });
      if (res.saved) {
        savedCount++;
        if (!res.verified) unverifiedCount++;
      } else {
        failCount++;
      }
      for (const d of res.done) if (!done.includes(d)) done.push(d);
    }

    // 6) 封面就地替换 hero 海报（即时视觉；服务端已落库，重进页面同样生效）
    let coverOk = false;
    if (coverDataUrl) {
      const poster = heroPosterImg();
      if (poster) { poster.src = coverDataUrl; coverOk = true; }
    }

    // 7) 按钮反馈
    const who = Array.isArray(meta.actresses) && meta.actresses.length
      ? ' · ' + meta.actresses.map((a: any) => a && a.name).filter(Boolean).slice(0, 3).join('・') : '';
    const scope = targets.length > 1 ? ' ×' + targets.length : '';
    if (failCount === 0 && unverifiedCount === 0) {
      if (done.length) markPendingLayoutSwitch(); // [lc-1250] 详情页无布局工具栏, 导航回列表页后自动补切横幅
      setBtn(btn, done.length ? ('✓ 已回填（' + done.join('/') + scope + '）') : '✓ 已是最新',
        meta.code + ' ' + (meta.date || '') + who
        + (done.length && coverHash && !coverOk ? '（hero 海报位未找到，封面已落库，重进页面生效）' : ''));
    } else if (failCount > 0 && savedCount > 0) {
      setBtn(btn, '⚠ 部分回填 ' + savedCount + '/' + targets.length,
        '部分条目写入/读取失败，其余已生效，详见日志；可重试补齐。');
    } else if (failCount === 0) {
      setBtn(btn, '⚠ 回填未确认', '写入已提交但复核未通过，详见日志；若条目数据无误可忽略。');
    } else {
      setBtn(btn, '⚠ 回填失败', 'saveEditDetail 写入失败，详见日志；查询数据不受影响。');
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
