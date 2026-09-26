import { ipcRenderer } from 'electron';
import { isFntvTvPage } from '../../core/pageMode';
import { log } from './log';

// embyWall/login.ts — 登录页增强：登录后自动跳影视、/v/login 账号自动填充、登录页自定义背景
// 由 scripts/embywall-split.js 从 embyWall.ts 整段抽取；改实现请改这里，不要在入口文件里补。

// [lc-473] 登录后自动跳影视(精准 pathname 检测版, 取代 lc-205 关键词检测):
//   判定完全基于 pathname(isFntvTvPage), 绝不扫页面文字关键词 → 不会误命中影视主页造成死循环。
//   - 命中条件: 当前落在「飞牛原生桌面」(根路径 '/', 即 fnOS 主页) 且用户未主动切系统页(fntv-system-intent)。
//   - 一次性跳转(无 setInterval): 仅页面加载后延迟 1.5s 执行一次; 跳到 /v 后 pathname 变 /v → 不再触发 → 无循环。
//   - 用户手动"切换系统页面"(fntv:enter-system-page, lc-375)会置 fntv-system-intent='1', 本逻辑跳过,
//     实现"到达影视后再手动切系统页才不触发"的语义。
//   - 飞牛影视页(/v, 含 /v/login 等子路由)、已主动切系统页 → 一律不干预(关键: 绝不碰 /v 主页)。
//   主进程 pathname 守卫(lc-203)对 pathname 偏离 /v 已做纠正; 本逻辑是渲染端对"原生桌面 '/'"的
//   精准补充——直接在 fnOS 主页落点处跳影视, 比等守卫异步 reload 更快更稳。
(function autoJumpToTv(): void {
  const tryJump = (): void => {
    try {
      // 用户主动切系统页(侧栏"切换系统页面"按钮已置位)→ 不跳, 尊重手动选择
      if (sessionStorage.getItem('fntv-system-intent') === '1') return;
      // 已在飞牛影视页(/v, 含 /v/login 等子路由)→ 不干预(关键: 绝不碰 /v 主页, 杜绝关键词误命中死循环)
      if (isFntvTvPage()) return;
      const p = location.pathname || '/';
      // 仅当落在飞牛原生桌面(根路径 '/')时跳影视; 其他非 /v 路径(异常)不主动跳, 交给主进程守卫
      if (p !== '/') return;
      const target = location.origin + '/v';
      if (location.href === target) return;
      ipcRenderer.send('renderer-desktop-fix',
        '登录后自动跳影视: 当前在飞牛原生桌面(/), 跳转到 /v');
      location.href = target;
    } catch (e) { /* ignore */ }
  };
  // 页面可能 SPA 延迟渲染, 延迟 1.5s 执行一次; 一次性(无 setInterval)→ 任何循环都不可能发生
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(tryJump, 1500));
  } else {
    setTimeout(tryJump, 1500);
  }
})();

// [lc-213] /v/login 自动填充: 当主窗口因 deskMonitor(lc-212)跳到 /v 后被 fnOS 重定向到 /v/login 时,
//   自动用保存的凭据填充用户名+密码并提交登录, 让用户无需手动再输一次.
//   触发场景: FN ID 登录 → 弹窗输访问码 → deskMonitor 检测桌面 → 主窗口跳 /v → /v 无影视会话 → 跳 /v/login.
//   凭据来源: auth.ts 的 get-config IPC 返回 config(account/domain) + history(含密码若勾选"记住密码").
(function autoFillVLogin(): void {
  // 仅在飞牛影视登录页(/v/login)介入; fnOS 系统 /signin 不归这里管
  if (location.pathname !== '/v/login') return;

  const { ipcRenderer } = require('electron');

  // 模拟原生输入(同 fnid_login.ts getInjectionScript 的 triggerInput)
  function triggerInput(input: HTMLInputElement, value: string): void {
    const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (!desc || !desc.set) { input.value = value; return; }
    desc.set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 延迟等 DOM 渲染(fnOS 登录页是 React SPA)
  setTimeout(() => {
    try {
      // [lc-213 修正] 'get-config' 是事件式注册(ipcMain.on, 非 ipcMain.handle),
      //   故不能用 ipcRenderer.invoke(会报"No handler registered")——须用 send + once('config-data'),
      //   与本地登录页 resource/login/index.html 的写法一致.
      ipcRenderer.send('get-config');
      ipcRenderer.once('config-data', (_e: any, data: any) => {
        try {
          const config = (data && data.config) || {};
          const history = (data && data.history) || [];

          // 优先从 config 取账号; 历史记录里也找同域条目取密码
          let username = config.account || '';
          let password = '';

          // 从历史记录找密码(用户勾了"记住密码"时 history 条目含 password 字段)
          const domain = config.domain || '';
          for (const h of history) {
            if (h.domain === domain && h.account === username && h.password) {
              password = h.password;
              break;
            }
          }

          if (!username) { log('[lc-213] /v/login 自动填充跳过: 无保存的账号'); return; }

          // 多选择器兼容(同 fnid_login.ts 注入脚本)
          const uInput = document.getElementById('username')
            || document.querySelector('input[name="username"]')
            || document.querySelector('input[placeholder*="用户名"]')
            || document.querySelector('input[placeholder*="账号"]')
            || (function() { const inputs = document.querySelectorAll('input[type="text"], input:not([type])'); return inputs.length > 0 ? inputs[0] as HTMLInputElement : null; })();
          const pInput = document.getElementById('password')
            || document.querySelector('input[name="password"]')
            || document.querySelector('input[placeholder*="密码"]')
            || (function() { const inputs = document.querySelectorAll('input[type="password"]'); return inputs.length > 0 ? inputs[0] as HTMLInputElement : null; })();

          if (!uInput) { log('[lc-213] /v/login 未找到用户名输入框'); return; }

          log(`[lc-213] /v/login 自动填充: 用户名=${username}, 密码=${password ? '有' : '无(未记住密码)'}`);
          triggerInput(uInput as HTMLInputElement, username);
          if (password && pInput) {
            triggerInput(pInput as HTMLInputElement, password);
            // 填充后自动点登录按钮
            setTimeout(() => {
              const btn = document.querySelector('button[type="submit"]')
                || Array.from(document.querySelectorAll('button')).find((b: HTMLElement) => /登录/.test(b.innerText))
                || document.querySelector('input[type="submit"]');
              if (btn) { (btn as HTMLElement).click(); log('[lc-213] /v/login 已自动点击登录'); }
              else { log('[lc-213] /v/login 未找到登录按钮'); }
            }, 400);
          } else {
            log('[lc-213] /v/login 仅填充了用户名, 密码为空(需用户手动输入或勾选"记住密码")');
          }
        } catch (e) {
          log('[lc-213] /v/login 自动填充处理异常:', String(e).slice(0, 120));
        }
      });
    } catch (e) {
      log('[lc-213] /v/login 自动填充异常:', String(e).slice(0, 120));
    }
  }, 800); // 等 React 渲染完登录表单
})();

// [lc-120] 把任意本地图片路径转为 file:// URL（登录页伪元素 background-image 用）
function toFileUrl(p: string): string {
  if (!p) return '';
  if (/^file:\/\//i.test(p)) return p;
  const norm = p.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(norm)) return 'file:///' + norm; // Windows D:/x -> file:///D:/x
  if (norm.startsWith('/')) return 'file://' + norm;
  return 'file:///' + norm;
}

// [lc-120] 应用/清除自定义登录页背景：设或清空 --fnos-login-bg 变量（mainwin.ts 登录页伪元素读取）
export function applyLoginBgVar(p: string): void {
  if (p) {
    document.documentElement.style.setProperty('--fnos-login-bg', 'url("' + toFileUrl(p) + '")');
  } else {
    document.documentElement.style.setProperty('--fnos-login-bg', '');
  }
}
