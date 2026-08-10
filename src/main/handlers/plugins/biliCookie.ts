import axios from 'axios';
import { app, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { registerHandler } from '../core/ipcHandler';
import * as log from '../../../modules/logger';
import { getQrcodeLibSource } from './qrcodeLib';

/**
 * B站弹幕 Cookie 扫码登录（集成到设置面板）
 * 流程：主进程直连 B站 passport（Node 无 CORS 限制）→ 生成二维码 → 轮询扫码状态
 *       → 成功时从登录回跳 URL 解析 Cookie → 写入 uosc_danmaku/bili_cookie.txt
 * 该文件会被 handlers/index.ts 自动加载（同目录 *.js 即视为插件，需导出 init）。
 */

const PASSPORT = 'https://passport.bilibili.com/x/passport-login/web/qrcode';
const HOME = 'https://www.bilibili.com/';
const UA = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com' };
// 需要导出的 Cookie 键（与现有 get_bili_cookie.html 保持一致）
const COOKIE_KEYS = ['SESSDATA', 'bili_jct', 'buvid3', 'buvid4', 'DedeUserID', 'DedeUserID__ckMd5', 'sid', 'ac_time_value'];

// 进程级 cookie 罐：复用匿名 buvid3，保持 generate/poll 同源会话
let jar: Record<string, string> = {};
let curKey = '';

function storeSetCookie(setCookie?: string | string[]): void {
  if (!setCookie) return;
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const sc of arr) {
    const head = sc.split(';')[0];
    const idx = head.indexOf('=');
    if (idx > 0) jar[head.slice(0, idx).trim()] = head.slice(idx + 1).trim();
  }
}
function cookieHeader(): string {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

// 候选 uosc_danmaku 目录（dev / 打包 / 用户 mpv 目录），取首个存在者
function getUoscDanmakuCandidates(): string[] {
  const arr: string[] = [];
  // 仅在打包态使用 resourcesPath：dev 下它指向 node_modules/electron/dist/resources，
  // 并非应用资源目录；往里写会污染 node_modules 并制造「存在但缺 bili_danmaku.js」的阴影目录。
  if (app.isPackaged && process.resourcesPath) {
    arr.push(path.join(process.resourcesPath, 'third_party', 'fntv-mpv', 'portable_config', 'scripts', 'uosc_danmaku'));
  }
  const appPath = app.getAppPath();
  arr.push(path.join(appPath, 'third_party', 'fntv-mpv', 'portable_config', 'scripts', 'uosc_danmaku'));
  // [新] 打包态 MPV 实际脚本目录：exe 同目录 portable_config（extraFiles 解压，可写）
  //   与 apis/extra.lua 通过 mp.get_script_directory() 定位到的 bili_danmaku.js 同目录，
  //   必须一致，否则 MPV 端读不到这里写的 bili_cookie.txt（换机/重装后弹幕搜索无登录态）。
  arr.push(path.join(path.dirname(app.getPath('exe')), 'third_party', 'fntv-mpv', 'portable_config', 'scripts', 'uosc_danmaku'));
  if (process.platform === 'win32') {
    arr.push(path.join(os.homedir(), 'AppData', 'Roaming', 'mpv', 'scripts', 'uosc_danmaku'));
  } else {
    arr.push(path.join(os.homedir(), '.config', 'mpv', 'scripts', 'uosc_danmaku'));
  }
  return arr;
}

function isAsarPath(p: string): boolean {
  return app.isPackaged && (p.includes('app.asar') || p.toLowerCase().includes('.asar'));
}

function resolveDanmakuDir(): string | null {
  const candidates = getUoscDanmakuCandidates();
  // 1) 优先：已存在 bili_cookie.txt 的目录（cookie 实际落盘处，通常与 MPV 脚本目录一致）
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.existsSync(path.join(c, 'bili_cookie.txt'))) return c;
  }
  // 2) 其次：非 asar 的真实可写目录（exe 同目录 portable_config / 用户 mpv）
  for (const c of candidates) {
    if (isAsarPath(c)) continue;
    if (fs.existsSync(c)) return c;
  }
  // 3) 回退：第一个非 asar 候选（即便尚不存在，mkdir 后也可写）
  for (const c of candidates) {
    if (isAsarPath(c)) continue;
    return c;
  }
  return null;
}

function parseCookieFromUrl(u: string): string {
  try {
    const url = new URL(u);
    const p = url.searchParams;
    const parts = COOKIE_KEYS.filter((k) => p.get(k)).map((k) => `${k}=${p.get(k)}`);
    return parts.join('; ');
  } catch {
    return '';
  }
}

// 从响应 Set-Cookie 中收割登录态 Cookie（作为 data.url 解析失败的兜底）
function harvestSetCookie(sc?: string | string[]): string {
  if (!sc) return '';
  const arr = Array.isArray(sc) ? sc : [sc];
  const got: Record<string, string> = {};
  for (const s of arr) {
    const head = s.split(';')[0];
    const idx = head.indexOf('=');
    if (idx > 0) {
      const k = head.slice(0, idx).trim();
      if (COOKIE_KEYS.includes(k)) got[k] = head.slice(idx + 1).trim();
    }
  }
  return Object.entries(got).map(([k, v]) => `${k}=${v}`).join('; ');
}

function saveCookie(ck: string): void {
  const candidates = getUoscDanmakuCandidates();
  // 排除只读的 asar 路径（打包态 resourcesPath/appPath 指向 app.asar 内部，写入静默失败）；
  // 优先写入 exe 同目录 portable_config（与 MPV 实际脚本目录一致，确保 MPV 端能读到此 cookie）。
  const writable = candidates.filter((d) => !isAsarPath(d));
  let saved = false;
  for (const dir of writable) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'bili_cookie.txt'), ck, 'utf8');
      log.info('biliCookie: 已保存 Cookie -> ' + path.join(dir, 'bili_cookie.txt'));
      saved = true;
    } catch (e) {
      log.error('biliCookie: 保存失败 ' + dir, e);
    }
  }
  if (!saved) log.error('biliCookie: 找不到可写的 uosc_danmaku 目录');
}

// ===== IPC 处理 =====

async function handleQrGenerate(): Promise<{ ok: boolean; key?: string; url?: string; error?: string }> {
  try {
    // 先取匿名 buvid3（部分情况下 generate 需要）
    try {
      const r0 = await axios.get(HOME, { headers: UA, timeout: 10000 });
      storeSetCookie((r0.headers as any)['set-cookie']);
    } catch {
      /* 网络不佳也可尝试继续 */
    }
    // 注意：B站 generate 端点实际为 GET（与已验证可用的 qr_server.py 代理行为一致；用 POST 会返回 405）
    const r1 = await axios.get(PASSPORT + '/generate', {
      headers: { ...UA, 'Cookie': cookieHeader() },
      timeout: 10000
    });
    storeSetCookie((r1.headers as any)['set-cookie']);
    const j = r1.data;
    if (!j || j.code !== 0 || !j.data || !j.data.qrcode_key) {
      return { ok: false, error: (j && (j.message || ('code ' + j.code))) || '未知错误' };
    }
    curKey = j.data.qrcode_key;
    return { ok: true, key: curKey, url: j.data.url };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function handleQrPoll(_event: any, key?: string): Promise<{ code: number; status: string; cookie?: string; expired?: boolean }> {
  const k = key || curKey;
  if (!k) return { code: -1, status: '未初始化，请先获取二维码' };
  try {
    const r = await axios.get(PASSPORT + '/poll?qrcode_key=' + encodeURIComponent(k), {
      headers: { ...UA, 'Cookie': cookieHeader() },
      timeout: 10000
    });
    storeSetCookie((r.headers as any)['set-cookie']);
    const j = r.data;
    const c = (j && j.data && j.data.code) ?? -1;
    if (c === 0) {
      let ck = parseCookieFromUrl((j.data && j.data.url) || '');
      if (!ck) ck = harvestSetCookie((r.headers as any)['set-cookie']);
      if (ck) {
        saveCookie(ck);
        return { code: 0, status: '登录成功，Cookie 已保存', cookie: ck };
      }
      return { code: 0, status: '登录成功但未能解析 Cookie，请重试' };
    } else if (c === 86038 || c === 86039) {
      return { code: c, status: '二维码已过期，请刷新', expired: true };
    } else if (c === 86090 || c === 86091 || c === 86101) {
      const msg = c === 86090 ? '已扫码，请在手机上点确认' : (c === 86101 ? '请用手机 B站 APP 扫码' : '已扫码，请在手机上点确认');
      return { code: c, status: msg };
    }
    return { code: c, status: '等待中… (状态 ' + c + ')' };
  } catch (e: any) {
    return { code: -2, status: '网络错误: ' + (e?.message || e) };
  }
}

async function handleCookieStatus(): Promise<{ exists: boolean; uid?: string; raw?: string }> {
  const dir = resolveDanmakuDir();
  if (!dir) return { exists: false };
  const file = path.join(dir, 'bili_cookie.txt');
  if (!fs.existsSync(file)) return { exists: false };
  try {
    const txt = fs.readFileSync(file, 'utf8').trim();
    const m = txt.match(/DedeUserID=([^;]+)/);
    return { exists: true, uid: m ? m[1] : undefined, raw: txt };
  } catch {
    return { exists: false };
  }
}

// 返回 qrcode.min.js 源码，供渲染进程注入后渲染二维码（避免新增 npm 依赖）
// 注意：源码已内联打包（见 ./qrcodeLib.ts），不再依赖外部 third_party 文件，
// 否则换机/打包环境下该文件缺失会导致前端报"二维码库加载失败"。
async function handleQrLib(): Promise<string> {
  return getQrcodeLibSource();
}

// 清除已保存的 B站 Cookie（删除 bili_cookie.txt）
async function handleClear(): Promise<{ ok: boolean; error?: string }> {
  const dir = resolveDanmakuDir();
  if (!dir) return { ok: false, error: '找不到 uosc_danmaku 目录' };
  const file = path.join(dir, 'bili_cookie.txt');
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      log.info('biliCookie: 已清除 Cookie -> ' + file);
    }
    return { ok: true };
  } catch (e: any) {
    log.error('biliCookie: 清除失败', e);
    return { ok: false, error: e?.message || String(e) };
  }
}

// 手动粘贴 Cookie 保存（扫码/风控失效时的兜底，结构与豆瓣 manual-cookie 对齐）
async function handleManualCookie(_event: any, ck?: string): Promise<{ ok: boolean; error?: string }> {
  const cookie = (ck || '').trim();
  if (!cookie) return { ok: false, error: 'Cookie 为空' };
  try {
    saveCookie(cookie);
    log.info('biliCookie: 已通过手动粘贴保存 Cookie');
    return { ok: true };
  } catch (e: any) {
    log.error('biliCookie: 手动保存失败', e);
    return { ok: false, error: e?.message || String(e) };
  }
}

// 打开弹幕文件夹（与 Node 端 biliDanmaku.ts CACHE_DIR 完全一致：%PUBLIC%\fnos-danmaku，
// 即 MPV DANMAKU_PATH 落盘目录。按钮打开的就是"对应的弹幕文件夹"，不再开 TEMP 根）
async function handleOpenDanmakuFolder(): Promise<{ ok: boolean; error?: string }> {
  const base = process.env.PUBLIC || process.env.ProgramData || os.tmpdir();
  const dir = path.join(base, 'fnos-danmaku');
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(dir);
    if (err) {
      log.warn('biliCookie: openPath 返回错误', err);
      return { ok: false, error: err };
    }
    log.info('biliCookie: 已打开弹幕文件夹 -> ' + dir);
    return { ok: true };
  } catch (e: any) {
    log.error('biliCookie: 打开弹幕文件夹失败', e);
    return { ok: false, error: e?.message || String(e) };
  }
}

function init(): void {
  registerHandler('bili:qr-generate', handleQrGenerate, { useHandle: true });
  registerHandler('bili:qr-poll', handleQrPoll, { useHandle: true });
  registerHandler('bili:cookie-status', handleCookieStatus, { useHandle: true });
  registerHandler('bili:qr-lib', handleQrLib, { useHandle: true });
  registerHandler('bili:clear', handleClear, { useHandle: true });
  registerHandler('bili:manual-cookie', handleManualCookie, { useHandle: true });
  registerHandler('bili:open-danmaku-folder', handleOpenDanmakuFolder, { useHandle: true });
  log.info('B站弹幕 Cookie 扫码登录插件已加载');
}

export {
  init
};
