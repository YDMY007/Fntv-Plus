// src/preload/web/diag.ts — 网页注入环境的诊断日志回传（仅 web 用，桌面端走 IPC log-message）。
//
// 背景：轮播墙等 embyWall 功能失败时，诊断证据（[CAROUSEL]/[LAYOUT]/异常栈）只存在于
// 浏览器 console，后端日志看不到，用户也没有 devtools。这里把关键 console 输出与全局
// 错误批量回传给注入后端（POST /app/fntvplus/api/client-log），后端落 client.log，
// 管理页「实时日志」即可看到前端发生了什么。
//
// 只回传我们自己的输出（[EmbyWall]/[fntv 前缀）与 error 级别，不回传页面自身噪音。

const API = '/app/fntvplus/api/client-log';
const buf: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

/* ========== Authx 捕获：记录页面自身请求的合法签名，供 shim 的 fnos-gen-authx 回放 ========== */
// fnOS 前端自己调 item/list 等接口时带合法 Authx（axios 走 XHR）。网页 shim 没有桌面主进程的
// 签名器，回放页面捕获值是零逆向的权宜之计；同源 sys/img GET 则靠剥掉坏头 + cookie 直取。
const authxMap: Array<{ path: string; authx: string }> = [];

function normalizePath(url: string): string {
  let p = String(url || '');
  const m = p.match(/^https?:\/\/[^/]+(\/.*)$/);
  if (m) p = m[1];
  else if (!p.startsWith('/')) return '';
  return p.split('?')[0]; // 签名按 path 匹配（query 差异容忍，前缀双向兜底）
}

function recordAuthx(url: string, authx: string): void {
  if (!authx || authx === 'undefined' || authx === 'null') return;
  const path = normalizePath(url);
  if (!path) return;
  for (let i = authxMap.length - 1; i >= 0; i--) {
    if (authxMap[i].path === path) {
      authxMap[i].authx = authx; // 刷新为最新（签名可能带时间戳）
      return;
    }
  }
  if (authxMap.length > 200) authxMap.shift();
  authxMap.push({ path, authx });
  push('[diag] captured Authx for ' + path);
}

/** shim 的 fnos-gen-authx 查询入口：精确 → 双向前缀匹配，取最新捕获值。 */
export function getCapturedAuthx(path: string): string {
  const p = normalizePath(path);
  if (!p) return '';
  for (let i = authxMap.length - 1; i >= 0; i--) {
    if (authxMap[i].path === p) return authxMap[i].authx;
  }
  for (let i = authxMap.length - 1; i >= 0; i--) {
    if (p.startsWith(authxMap[i].path) || authxMap[i].path.startsWith(p)) return authxMap[i].authx;
  }
  return '';
}

/** 钩 XHR/fetch：捕获页面自身请求的 Authx + 剥离同源请求里 undefined/空的坏 Authx 头。 */
function installCapture(): void {
  try {
    const xo = XMLHttpRequest.prototype.open as any;
    const xs = XMLHttpRequest.prototype.setRequestHeader as any;
    (XMLHttpRequest.prototype as any).open = function (method: string, url: any, ...rest: any[]) {
      try {
        (this as any).__fntvUrl = String(url);
      } catch (_) {}
      return xo.apply(this, [method, url, ...rest] as any);
    };
    (XMLHttpRequest.prototype as any).setRequestHeader = function (n: string, v: string) {
      try {
        if (String(n).toLowerCase() === 'authx') recordAuthx((this as any).__fntvUrl || '', String(v));
      } catch (_) {}
      return xs.apply(this, [n, v] as any);
    };
  } catch (_) {}

  try {
    const fo = window.fetch.bind(window);
    const stripBadAuthx = (hs: any): boolean => {
      // 返回 true 表示发生了剥离
      let stripped = false;
      if (hs && typeof hs === 'object' && !Array.isArray(hs) && typeof hs.forEach !== 'function') {
        for (const k of Object.keys(hs)) {
          if (k.toLowerCase() === 'authx') {
            const v = hs[k];
            if (v === undefined || v === null || v === '' || v === 'undefined') {
              delete hs[k];
              stripped = true;
            }
          }
        }
      }
      return stripped;
    };
    window.fetch = (input: any, init?: any) => {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        let authx = '';
        const hs = init && init.headers;
        if (hs) {
          if (typeof hs.forEach === 'function') {
            hs.forEach((v: any, k: any) => {
              if (String(k).toLowerCase() === 'authx') authx = String(v);
            });
          } else if (Array.isArray(hs)) {
            for (const kv of hs) if (String(kv[0]).toLowerCase() === 'authx') authx = String(kv[1]);
          } else {
            for (const k of Object.keys(hs)) if (k.toLowerCase() === 'authx') authx = String(hs[k]);
          }
        }
        recordAuthx(url, authx);
        if (stripBadAuthx(init && init.headers)) push('[diag] stripped bad Authx for ' + url);
      } catch (_) {}
      return fo(input, init);
    };
  } catch (_) {}
}

function fmt(a: any[]): string {
  return a
    .map((x) => {
      if (typeof x === 'string') return x;
      try {
        return JSON.stringify(x);
      } catch (_) {
        return String(x);
      }
    })
    .join(' ');
}

function push(line: string): void {
  if (buf.length > 500) buf.splice(0, buf.length - 500); // 防爆内存
  let t = '';
  try {
    // 带日期（MM-dd HH:mm:ss.mmm）——区分跨天/跨会话的历史条目
    t = new Date().toISOString().slice(5, 23).replace('T', ' ');
  } catch (_) {}
  buf.push(t + ' ' + line);
  if (buf.length >= 20) flush();
  else if (!timer) timer = setTimeout(flush, 2000);
}

function flush(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!buf.length) return;
  const body = buf.splice(0).join('\n');
  try {
    fetch(API, { method: 'POST', body, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }).catch(() => {});
  } catch (_) {
    /* 网络不可用时静默丢弃 */
  }
}

/** 拦截 console（仅捕获转发，原样放行）+ 全局错误钩子 + Authx 捕获。在 payload boot 最前调用。 */
export function installDiag(): void {
  installCapture();

  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  const wrap = (origFn: (...a: any[]) => void, level: string) => (...args: any[]) => {
    try {
      const s = fmt(args);
      if (level === 'error' || s.startsWith('[EmbyWall]') || s.startsWith('[fntv')) {
        push('[' + level + '] ' + s);
      }
    } catch (_) {}
    origFn(...args);
  };
  console.log = wrap(orig.log, 'log');
  console.warn = wrap(orig.warn, 'warn');
  console.error = wrap(orig.error, 'error');

  try {
    window.addEventListener('error', (e: any) => {
      push('[onerror] ' + (e.message || String(e)) + ' @' + (e.filename || '') + ':' + (e.lineno || ''));
    });
    window.addEventListener('unhandledrejection', (e: any) => {
      const r = e.reason;
      push('[unhandledrejection] ' + ((r && (r.stack || r.message)) || String(r)));
    });
    window.addEventListener('beforeunload', flush);
  } catch (_) {}

  push('[diag] installed @' + location.href);
}

// 模块体顶层自动安装：本模块是 payload 第一个 import，确保先于所有插件初始化装好错误钩子
installDiag(); // 模块加载即自动安装
