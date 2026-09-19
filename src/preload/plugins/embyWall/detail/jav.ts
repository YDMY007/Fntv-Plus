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
// 挂载：body 级浮动胶囊按钮。路由支持 电影 /v/movie/<32hex>（guid 裸 hex）与
//   文件夹 /v/folder/fv_<32hex>（条目 guid 必须带 fv_ 前缀，裸 hex 返回 code -6——
//   JAV 普遍是文件夹条目，识别靠标题番号、不靠目录名）+ S.javEnabled 开关，
// 与 epBackfill/customScraper 同一批导航钩子调度（embyWall.ts scheduleJavButton）。
// ─────────────────────────────────────────────────────────────────────────────
import { ipcRenderer } from 'electron';
import { dlog, log } from '../log';
import { S } from '../state';
import { findActiveDetailView, findDetailHero } from './glass';
import { fnosGetEditDetail, uploadImageToFnos } from '../carousel/logo';
import { fnosSaveEditDetail } from './epBackfill';

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

/** 当前详情条目 guid（电影/folder 两种路由，jav 刮削共用一条回填管线）。 */
function detailGuid(): string | null {
  return folderGuid() || movieGuid();
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
  if (!S.javEnabled || !detailGuid()) { removeJavButton(); return; }
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
    if (S.javEnabled && detailGuid()) ensureJavButton();
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

function creditsEqual(a: any[], b: any): boolean {
  if (!Array.isArray(b) || b.length !== a.length) return false;
  return a.every((c, i) => String(c.name) === String(b[i] && b[i].name) && String(c.job) === String(b[i] && b[i].job));
}

/** 主流程：读条目 → javbus 查询 → 全量读改写回填（标题/简介/日期/演员/封面，locked）→ 复核。 */
async function runJav(btn: HTMLButtonElement): Promise<void> {
  const guid = detailGuid();
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

    // 3) 组装回填：全量读改写，仅改本流程负责的字段 + locked（防字段缺失被清空）
    const titleKey = ('title' in data) ? 'title' : (('name' in data) ? 'name' : 'title');
    const body: any = { ...data, nonce: fnNonce() };
    if (!body.guid && !body.item_guid) body.guid = guid;
    const done: string[] = [];
    const newTitle = String(meta.title || '').trim();
    if (newTitle && newTitle !== curTitle) {
      body[titleKey] = newTitle;
      body.title_locked = true;
      done.push('标题');
    }
    const ov = buildOverview(meta);
    if (ov && ov !== String(data.overview || '').trim()) {
      body.overview = ov;
      body.overview_locked = true;
      done.push('简介');
    }
    if (meta.date && meta.date !== String(data.air_date || '').trim()) {
      body.air_date = meta.date;
      body.air_date_locked = true;
      done.push('日期');
    }
    const credits = await buildCredits(origin, meta);
    if (credits.length && !creditsEqual(credits, data.credits)) {
      body.credits = credits;
      body.credits_locked = true;
      done.push('演员');
    }

    // 4) 封面落库：jav:image 代理 → 临时图床('poster') → hash_path 写 posters。
    //    folder 自定义封面需 poster_type=1(Single) 才会替换自动截图（实测枚举 Multiple=0/Single=1）。
    let coverDataUrl = '';
    let coverHash = '';
    if (meta.cover) {
      setBtn(btn, '⏳ 封面上传中…');
      try {
        const img: any = await ipcRenderer.invoke('jav:image', { url: meta.cover });
        if (img && img.ok && img.dataUrl) {
          coverDataUrl = img.dataUrl;
          const hashPath = await uploadImageToFnos(origin, coverDataUrl, 'poster');
          if (hashPath && hashPath !== String(data.posters || '').trim()) {
            coverHash = hashPath;
            body.posters = coverHash;
            body.posters_locked = true;
            if (Number(data.poster_type) !== 1) body.poster_type = 1;
            done.push('封面');
          }
        }
      } catch (e) { dlog('[jav] 封面上传失败: ' + String(e).substring(0, 80)); }
    }

    if (!done.length) {
      setBtn(btn, '✓ 已是最新', meta.code + '（标题/简介/日期/演员/封面均已一致）');
      window.setTimeout(() => { if (btn.isConnected) setBtn(btn, '⟳ jav 刮削'); }, 6000);
      return;
    }

    // 5) 保存 + 复核（读回比对关键字段，写不回如实按失败计——数据可能未落盘）
    setBtn(btn, '⏳ 回填中…');
    let saved = await fnosSaveEditDetail(origin, body);
    let verified = false;
    if (saved) {
      const vf = await fnosGetEditDetail(origin, guid);
      verified = !!vf;
      if (verified && body.title_locked) verified = String(vf[titleKey] ?? '').trim() === newTitle;
      if (verified && body.overview_locked) verified = String(vf.overview ?? '').trim() === ov;
      if (verified && body.air_date_locked) verified = String(vf.air_date ?? '').trim() === String(body.air_date);
      if (verified && body.posters_locked) verified = String(vf.posters ?? '').trim() === coverHash;
      if (verified && body.credits_locked) verified = creditsEqual(credits, vf.credits);
    }
    if (saved && !verified) dlog('[jav] 部分字段写回未确认（可能字段名/权限不符）');

    // 6) 封面就地替换 hero 海报（即时视觉；服务端已落库，重进页面同样生效）
    let coverOk = false;
    if (coverDataUrl) {
      const poster = heroPosterImg();
      if (poster) { poster.src = coverDataUrl; coverOk = true; }
    }

    // 7) 按钮反馈
    const who = Array.isArray(meta.actresses) && meta.actresses.length
      ? ' · ' + meta.actresses.map((a: any) => a && a.name).filter(Boolean).slice(0, 3).join('・') : '';
    if (saved && verified) {
      setBtn(btn, '✓ 已回填（' + done.join('/') + '）', meta.code + ' ' + (meta.date || '') + who
        + (coverOk ? '' : '（hero 海报位未找到，封面已落库，重进页面生效）'));
    } else if (saved) {
      setBtn(btn, '⚠ 回填未确认', '写入已提交但复核未通过，详见日志。');
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
