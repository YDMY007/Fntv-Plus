import axios from 'axios';
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { registerHandler } from '../core/ipcHandler';
import * as log from '../../../modules/logger';

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
  if (process.resourcesPath) {
    arr.push(path.join(process.resourcesPath, 'third_party', 'fntv-mpv', 'portable_config', 'scripts', 'uosc_danmaku'));
  }
  const appPath = app.getAppPath();
  arr.push(path.join(appPath, 'third_party', 'fntv-mpv', 'portable_config', 'scripts', 'uosc_danmaku'));
  if (process.platform === 'win32') {
    arr.push(path.join(os.homedir(), 'AppData', 'Roaming', 'mpv', 'scripts', 'uosc_danmaku'));
  } else {
    arr.push(path.join(os.homedir(), '.config', 'mpv', 'scripts', 'uosc_danmaku'));
  }
  return arr;
}

function resolveDanmakuDir(): string | null {
  const candidates = getUoscDanmakuCandidates();
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0] || null;
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
  const targets = candidates.filter((d) => fs.existsSync(d));
  const writeTo = targets.length ? targets : candidates.filter(Boolean);
  let saved = false;
  for (const dir of writeTo) {
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
async function handleQrLib(): Promise<string> {
  const dir = resolveDanmakuDir();
  if (!dir) return '';
  const f = path.join(dir, 'qrcode.min.js');
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
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

function init(): void {
  registerHandler('bili:qr-generate', handleQrGenerate, { useHandle: true });
  registerHandler('bili:qr-poll', handleQrPoll, { useHandle: true });
  registerHandler('bili:cookie-status', handleCookieStatus, { useHandle: true });
  registerHandler('bili:qr-lib', handleQrLib, { useHandle: true });
  registerHandler('bili:clear', handleClear, { useHandle: true });
  log.info('B站弹幕 Cookie 扫码登录插件已加载');
}

export {
  init
};
