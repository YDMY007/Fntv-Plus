// preload/plugins/embyWall.ts
import { ipcRenderer } from 'electron';
import { registerHook } from '../core/hooks';
import { HookType } from '../core/hooks';
import { isFntvTvPage } from '../core/pageMode';
import { isSyncableItemType } from '../../modules/fn_api/types';
import { ensureLibraryIndex, LibItem } from './hotUpdates';

const LOG = '[EmbyWall]';
// EmbyWall 渲染日志独立开关：由主进程调试过滤下发，默认关闭(安静)。
// 关闭时 log() 完全不输出(终端 console.log 与上报主进程的 IPC 都跳过)，
// 因此既能清掉 CMD 刷屏，也能避免写入 app.log 文件。
let _embyWallLogEnabled = false;
// 详情页「关闭背景框」开关的运行时缓存：false=保留玻璃背景框(默认)，true=恢复 fnOS 原生外观
let _detailBoxless = false;
// 鼠标滚轮横向滚动开关的运行时缓存：true=开启(默认，竖向滚轮转横向滑动)；false=关闭(恢复飞牛原生上下滚)
let _wheelHScrollEnabled = false;
// 「热门剧更新」数据源运行时缓存（'tmdb' / 'douban'），默认豆瓣；由启动时 settings:get 回填
let _hotSource: 'tmdb' | 'douban' = 'douban';
// 轮播图标题替换为 TMDB 透明 Logo 开关的运行时缓存：true=替换(默认)，false=保留文字标题
let _carouselLogoEnabled = true;
// 当前已渲染轮播的引用，供设置切换时即时应用/还原（无需等下次导航/重建）
let _carouselInfos: HTMLElement[] = [];
let _carouselShows: any[] = [];
let _carouselBase = '';

function _applyEmbyWallDebugFilter(payload: { enabled?: boolean; components?: Record<string, boolean> } | undefined): void {
  const enabled = !!payload?.enabled;
  const comps = payload?.components || {};
  // 调试总开关开启 且 EmbyWall 组件未被显式关闭(默认开启) → 显示
  _embyWallLogEnabled = enabled && comps['embywall'] !== false;
}

ipcRenderer.on('debug-filter', (_e: any, payload: any) => _applyEmbyWallDebugFilter(payload));
// 页面加载时主动向主进程索取当前调试过滤(异步返回前默认安静)
try { ipcRenderer.send('debug-filter-request'); } catch (e) {}

// [lc-516] 「应用补丁」向导弹窗监听：模块顶层注册，直接唤起自包含的补丁应用弹窗。
// ===== [lc-516] 模块级、自包含的补丁应用弹窗 =====
// 由设置面板「应用补丁」按钮调用，也由更新弹窗经 fntv-open-settings('patch') 通道跳转后自动唤起。
// 弹窗自身创建到 document.body，独立于设置面板；不依赖 injectSettingsUI 的执行时机。
let _patchApplyModal: HTMLElement | null = null;
let _patchApplyProgHandler: ((_e: any, p: any) => void) | null = null;

// 居中文字（模块级，不依赖设置面板内的 centerText）
function fntvCenterText(text: string, size: string, color: string, extra = ''): HTMLElement {
    const d = document.createElement('div');
    d.textContent = text;
    d.style.cssText = `font-size:${size};color:${color};${extra}`;
    return d;
}
// 按钮行（模块级，直接用 button 元素，不依赖设置面板内的 mkBtn）
function fntvActionRow(actions: Array<{ label: string; primary: boolean; onClick: () => void }>): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;';
    for (const a of actions) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = a.label;
        b.style.cssText = 'flex:1;padding:9px 0;border-radius:9px;font-size:13px;font-weight:700;cursor:pointer;'
            + (a.primary
                ? 'background:var(--fnos-ui-pill-bg)!important;color:var(--fnos-ui-pill-text);border:1px solid var(--fnos-ui-pill-border);'
                : 'background:var(--fnos-ui-input-bg);color:var(--fnos-ui-text);border:1px solid var(--fnos-ui-border);');
        b.addEventListener('click', (e: Event) => { e.stopPropagation(); a.onClick(); });
        row.appendChild(b);
    }
    return row;
}
// 旋转 spinner（模块级）
function fntvSpinner(): HTMLElement {
    const s = document.createElement('div');
    s.style.cssText = 'width:30px;height:30px;margin:2px auto 0;border-radius:50%;'
        + 'border:3px solid var(--fnos-ui-border);border-top-color:var(--fnos-ui-pill-bg);'
        + 'animation:fnosPatchSpin .8s linear infinite;';
    return s;
}

function fntvOpenPatchApplyPopup(autoApply: boolean): void {
    if (!_patchApplyModal) {
        // 注入 keyframes（仅一次；独立弹窗可能在设置面板注入前打开，故此处也注入）
        if (!document.getElementById('fntv-patch-kf')) {
            const st = document.createElement('style');
            st.id = 'fntv-patch-kf';
            st.textContent = '@keyframes fnosPatchSpin{to{transform:rotate(360deg)}}'
                + '@keyframes fnosPatchIndet{0%{margin-left:0}50%{margin-left:55%}100%{margin-left:0}}';
            document.head.appendChild(st);
        }
        const modal = document.createElement('div');
        modal.id = 'fntv-patch-apply-popup';
        modal.setAttribute('data-fnos-ui', '1'); // 免疫白底清除器
        modal.style.cssText = 'position:fixed;z-index:2147483706;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.5);';
        modal.addEventListener('click', (e: Event) => {
            // 仅非进行中状态允许点遮罩关闭；下载/应用中禁止（避免打断）
            if (e.target === modal && modal.getAttribute('data-closable') === '1') fntvClosePatchApplyPopup();
        });
        const card = document.createElement('div');
        card.style.cssText = 'width:340px;border-radius:16px;padding:22px;color:var(--fnos-ui-text);'
            + 'background:var(--fnos-ui-panel-bg)!important;border:1px solid var(--fnos-ui-border-outer);'
            + 'box-shadow:0 18px 50px rgba(80,60,120,.28),0 4px 16px rgba(80,60,120,.14);'
            + 'backdrop-filter:blur(30px) saturate(150%);-webkit-backdrop-filter:blur(30px) saturate(150%);text-align:center;';
        const body = document.createElement('div');
        body.id = 'fntv-patch-apply-body';
        card.appendChild(body);
        modal.appendChild(card);
        document.body.appendChild(modal);
        _patchApplyModal = modal;
    }
    _patchApplyModal.style.display = 'flex';
    _patchApplyModal.setAttribute('data-closable', '1');
    fntvRenderPatchApply('checking', null);
    ipcRenderer.invoke('settings:check-patch').then((info: any) => {
        if (info && info.hasUpdate) {
            if (autoApply) fntvStartPatchApply();
            else fntvRenderPatchApply('available', info);
        } else {
            fntvRenderPatchApply('uptodate', info);
        }
    }).catch((err: any) => {
        fntvRenderPatchApply('error', { message: '检查失败: ' + ((err && err.message) || err) });
    });
}

function fntvClosePatchApplyPopup(): void {
    if (_patchApplyModal) { _patchApplyModal.remove(); _patchApplyModal = null; }
    if (_patchApplyProgHandler) { ipcRenderer.removeListener('settings:patch-progress', _patchApplyProgHandler); _patchApplyProgHandler = null; }
}

// 渲染不同状态：checking / available / uptodate / error / downloading / applying / restarting
function fntvRenderPatchApply(state: string, info: any): void {
    const modal = _patchApplyModal;
    if (!modal) return;
    const body = modal.querySelector('#fntv-patch-apply-body') as HTMLElement;
    if (!body) return;
    // 关闭可用性：仅非进行中状态允许遮罩/叉关闭
    const closable = (state === 'checking' || state === 'available' || state === 'uptodate' || state === 'error');
    modal.setAttribute('data-closable', closable ? '1' : '0');
    body.innerHTML = '';
    const version = (info && info.version) ? info.version : '';
    const curVer = (info && info.currentVersion) ? info.currentVersion : '';

    if (state === 'checking') {
        body.appendChild(fntvSpinner());
        body.appendChild(fntvCenterText('正在检查更新…', '14px', 'var(--fnos-ui-text)', 'margin-top:14px;font-weight:600;'));
        return;
    }
    if (state === 'available') {
        body.appendChild(fntvCenterText('🔥 发现新热补丁', '16px', 'var(--fnos-ui-pill-text)', 'font-weight:800;margin-bottom:10px;'));
        const chip = document.createElement('div');
        chip.textContent = 'v' + version;
        chip.style.cssText = 'display:inline-block;padding:5px 14px;border-radius:20px;font-size:15px;font-weight:800;'
            + 'background:var(--fnos-ui-pill-bg)!important;color:var(--fnos-ui-pill-text);border:1px solid var(--fnos-ui-pill-border);margin-bottom:8px;';
        body.appendChild(chip);
        body.appendChild(fntvCenterText(curVer ? `当前已应用：${curVer}` : '当前未应用任何热补丁', '11.5px', 'var(--fnos-ui-muted)', 'opacity:.8;margin-bottom:16px;'));
        body.appendChild(fntvActionRow([
            { label: '稍后', primary: false, onClick: () => fntvClosePatchApplyPopup() },
            { label: '立即应用', primary: true, onClick: () => fntvStartPatchApply() },
        ]));
        return;
    }
    if (state === 'uptodate') {
        body.appendChild(fntvCenterText('✓', '26px', 'var(--fnos-ui-accent)', 'font-weight:800;margin-bottom:6px;'));
        body.appendChild(fntvCenterText('已是最新热补丁', '15px', 'var(--fnos-ui-text)', 'font-weight:700;margin-bottom:6px;'));
        body.appendChild(fntvCenterText(curVer ? `当前版本：v${curVer}` : (info && info.message) || '', '11.5px', 'var(--fnos-ui-muted)', 'opacity:.8;margin-bottom:16px;'));
        body.appendChild(fntvActionRow([{ label: '关闭', primary: true, onClick: () => fntvClosePatchApplyPopup() }]));
        return;
    }
    if (state === 'error') {
        body.appendChild(fntvCenterText('⚠', '24px', '#ff7a7a', 'font-weight:800;margin-bottom:6px;'));
        body.appendChild(fntvCenterText('出错了', '15px', 'var(--fnos-ui-text)', 'font-weight:700;margin-bottom:8px;'));
        body.appendChild(fntvCenterText((info && info.message) || '未知错误', '12px', 'var(--fnos-ui-muted)', 'opacity:.85;line-height:1.6;margin-bottom:16px;word-break:break-word;'));
        body.appendChild(fntvActionRow([{ label: '关闭', primary: true, onClick: () => fntvClosePatchApplyPopup() }]));
        return;
    }
    if (state === 'downloading' || state === 'applying' || state === 'restarting') {
        const pct = (info && typeof info.percent === 'number') ? info.percent : -1;
        const restarting = state === 'restarting';
        const track = document.createElement('div');
        track.style.cssText = 'height:8px;border-radius:6px;background:var(--fnos-ui-input-bg);overflow:hidden;margin:6px 0 8px;';
        const fill = document.createElement('div');
        const indeterminate = pct < 0 && !restarting;
        fill.style.cssText = 'height:100%;border-radius:6px;transition:width .25s;'
            + 'background:var(--fnos-ui-pill-bg)!important;'
            + (restarting ? 'width:100%;' : indeterminate ? 'width:40%;animation:fnosPatchIndet 1.1s infinite ease-in-out;' : `width:${pct}%;`);
        track.appendChild(fill);
        body.appendChild(track);
        const pctText = state === 'downloading'
            ? (pct >= 0 ? `正在下载… ${pct}%` : '正在下载…')
            : state === 'applying' ? '正在应用补丁…'
            : '✓ 已应用，正在重启应用…';
        body.appendChild(fntvCenterText(pctText, '13px', restarting ? 'var(--fnos-ui-accent)' : 'var(--fnos-ui-text)', 'font-weight:600;margin-bottom:4px;'));
        if (indeterminate || pct >= 0) {
            const sub = document.createElement('div');
            sub.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-muted);opacity:.7;';
            if (info && info.total && info.total > 0) {
                const fmt = (n: number) => (n / 1024).toFixed(0) + ' KB';
                sub.textContent = `${fmt(info.loaded || 0)} / ${fmt(info.total)}`;
            } else {
                sub.textContent = state === 'applying' ? '正在写入补丁文件…' : (restarting ? '即将重启应用使补丁生效' : '下载中，请稍候…');
            }
            body.appendChild(sub);
        }
        if (state === 'applying' || state === 'restarting') {
            body.appendChild(fntvCenterText('应用即将重启 / 重载…', '11px', 'var(--fnos-ui-muted)', 'opacity:.7;margin-top:6px;'));
        }
        return;
    }
}

// 进度事件 → 更新下载/应用状态（保留 modal 不被关闭）；done 阶段明确展示「重启中」
function fntvStartPatchApply(): void {
    fntvRenderPatchApply('downloading', { percent: 0, message: '正在下载…' });
    _patchApplyProgHandler = (_e: any, p: any) => {
        if (!p) return;
        if (p.phase === 'downloading' || p.phase === 'applying') {
            fntvRenderPatchApply(p.phase, p);
        } else if (p.phase === 'done') {
            // 主进程 finalizeAfterApply 会按需重载/重启；这里明确展示「重启中」给用户看
            fntvRenderPatchApply('restarting', p);
        } else if (p.phase === 'error') {
            fntvRenderPatchApply('error', { message: p.message || '应用失败' });
        }
    };
    ipcRenderer.on('settings:patch-progress', _patchApplyProgHandler);
    ipcRenderer.invoke('settings:apply-patch').then((res: any) => {
        if (_patchApplyProgHandler) { ipcRenderer.removeListener('settings:patch-progress', _patchApplyProgHandler); _patchApplyProgHandler = null; }
        if (res && res.ok) {
            fntvRenderPatchApply('restarting', res); // 应用进程随后会重载/重启，无需手动关闭
        } else {
            fntvRenderPatchApply('error', { message: (res && res.message) || '应用失败' });
        }
    }).catch((err: any) => {
        if (_patchApplyProgHandler) { ipcRenderer.removeListener('settings:patch-progress', _patchApplyProgHandler); _patchApplyProgHandler = null; }
        fntvRenderPatchApply('error', { message: '应用失败: ' + ((err && err.message) || err) });
    });
}

// 启动时拉取「关闭详情页背景框」偏好，使已保存设置无需打开设置面板即生效
try {
  ipcRenderer.invoke('settings:get').then((s: any) => {
    if (s && typeof s.detailBoxless === 'boolean') {
      _detailBoxless = s.detailBoxless;
      if (isDetailPage()) applyDetailLiquidGlass();
    }
    // 鼠标滚轮横向滚动开关：false=关闭(恢复飞牛原生上下滚)，缺失/true=开启
    if (s && typeof s.wheelHScroll === 'boolean') {
      _wheelHScrollEnabled = s.wheelHScroll;
    }
    // 轮播图标题替换为 Logo 开关：缺失/true=开启(替换)，false=保留文字标题
    if (s && typeof s.carouselLogoEnabled === 'boolean') {
      _carouselLogoEnabled = s.carouselLogoEnabled;
    }
    // 立即按开关状态应用/清除横向滚动劫持（偏好可能与默认值不同）
    wheelToScroll();
    // 回填「热门剧更新」数据源（供设置面板 TMDB 区块初始显隐 TMDB 设置）
    if (s && (s.hotSource === 'tmdb' || s.hotSource === 'douban')) _hotSource = s.hotSource;
    // [lc-120] 自定义登录页背景图：启动时即应用（含登录页），无需打开设置面板
    if (s && s.loginBg) applyLoginBgVar(s.loginBg);
  });
} catch (e) {}

function log(...a: any[]) {
  if (!_embyWallLogEnabled) return; // 独立开关关闭 → 完全静默
  const msg = LOG + ' ' + a.join(' ');
  try { require('electron').ipcRenderer.invoke('log-message', 'info', msg); } catch(e) {}
}

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
function applyLoginBgVar(p: string): void {
  if (p) {
    document.documentElement.style.setProperty('--fnos-login-bg', 'url("' + toFileUrl(p) + '")');
  } else {
    document.documentElement.style.setProperty('--fnos-login-bg', '');
  }
}

/* ========== logo(base64内嵌) ========== */
const LOGO_DATA_URI = 'data:image/png;base64,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';


/* ========== 通过IPC主进程签名→自主调用API获取剧集(全自动) ========== */
const _apiShows: any[] = [];
let _apiLoaded = false;
let _apiLoading = false;

/**
 * [lc-408] 从 fnOS item 数据中多字段兜底提取 TMDB id（用于拉取 TMDB 透明 logo）。
 * 优先级：显式 tmdb 字段 → trimId 剥前缀（tm/tt + 数字）。
 * 注意：trimId 形如 tt325158 / tm63578，fnOS 不透明令牌；剥前缀取数字作 tmdb id 候选。
 */
function extractTmdbId(data: any): string | undefined {
  if (!data) return undefined;
  const direct = [
    data.tmdbId, data.tmdb_id,
    data.ProviderIds && (data.ProviderIds.Tmdb || data.ProviderIds.tmdb),
    data.externalIds && (data.externalIds.tmdb_id || data.externalIds.tmdb),
  ];
  for (const c of direct) {
    if (c != null && /^\d+$/.test(String(c).trim())) return String(c).trim();
  }
  const trimId = data.trimId || data.trim_id;
  if (typeof trimId === 'string') {
    const m = trimId.match(/^(?:tt|tm)(\d+)$/i);
    if (m) return m[1];
  }
  return undefined;
}

async function fetchShowsViaIPC(base: string): Promise<any[]> {
  // [lc-211] 本地登录页(file://)不需要也不应跑轮播取海报: 此时 location.origin 为 "file://",
  // 会拼出 file:///v/list/all 触发 ERR_FILE_NOT_FOUND 噪音(且永远拉不到数据).
  // 直接返回空数组, 首屏仍用硬编码数据兜底, 避免创建 file:// iframe.
  if (location.protocol === 'file:') return _apiShows;
  if (_apiLoaded) return _apiShows;
  if (_apiLoading) return _apiShows;
  _apiLoading = true;

  // 注意：不再在此处清空 _apiShows。
  // 旧数据保留到新数据确实拉到之后才替换(见末尾赋值)，
  // 避免"清空→异步拉取期间→injectCarousel读到空→显示loading占位→_carouselInited被锁死"的竞态。

  try {
    // [lc-546] 复用 hotUpdates 的全量库索引（ensureLibraryIndex），
    // 替代原来的隐藏 iframe 抓 /v/list/all（首屏不滚动→只拿到部分库的条目）。
    // 库索引通过全屏 iframe + 滚动到底触发懒加载，能拿到所有媒体库的全量条目。
    // 按媒体库全部顺序从头到尾，取最前面（列表顶部）的 10 个条目，再逐个拉 API 取封面。
    const libItems: LibItem[] = await ensureLibraryIndex();
    log('library index:', libItems.length, 'items total');

    // 从全量索引头部依次扫描，取前 N 个有 tv/movie href 的条目作为候选。
    // [lc-546-fix] 前面可能有大量 M3U8 直播频道（如 CCTV 新闻/财经等），
    // 它们的 href 也是 /v/tv/{guid} 格式会进入候选，但在后续并行 API 阶段被 is_m3u8 过滤掉。
    // 故多取候选（50 个）确保直播被过滤后仍能剩 10 个有效作品进入轮播。
    const candidates: any[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < libItems.length && candidates.length < 50; i++) {
      const item = libItems[i];
      const hrefMatch = item.href.match(/\/v\/(tv|movie)\/([a-f0-9]{32})/);
      if (!hrefMatch || seen.has(hrefMatch[2])) continue;
      seen.add(hrefMatch[2]);
      candidates.push({
        id: hrefMatch[2],
        title: item.title,
        poster: '',
        mediaType: hrefMatch[1],
      });
    }
    log('selected', candidates.length, 'candidates from index (first:', candidates[0]?.title?.substring(0, 20), ')');

    if (candidates.length === 0) { _apiLoading = false; return _apiShows; }

    // 用局部变量收集新数据, 成功后整体替换 _apiShows(避免重拉期间旧数据被清空导致竞态)
    const newShows: any[] = [];

    // 步骤2: 并行用item/{guid}获取每个候选的poster+overview（5s 短超时），一次性拿全部结果后过滤
    // [lc-546-fix] 改为并行而非串行：串行时每个直播电视候选占 8s 超时，30 个候选最坏 240s → 轮播一直卡「加载中」白屏。
    // 并行后无论多少候选，总时间≈单条超时(5s)，且 is_m3u8/类型/无封面 三道过滤直接剔掉直播电视，取前 10 个有效项。
    const pickImg = (v: any): string => {
      let s = '';
      if (typeof v === 'string') s = v;
      else if (Array.isArray(v) && v.length) { const it = v[0]; s = typeof it === 'string' ? it : (it?.url || it?.path || it?.image || it?.src || ''); }
      if (!s) return '';
      if (s.startsWith('http') || s.includes('sys/img')) return s;
      return 'sys/img' + (s.startsWith('/') ? s : '/' + s); // "/a9/06/x.webp" → "sys/img/a9/06/x.webp"
    };
    const fetchOne = async (show: any): Promise<any | null> => {
      try {
        const { ipcRenderer } = require('electron');
        const path = `/v/api/v1/item/${show.id}`;
        const authx = await ipcRenderer.invoke('fnos-gen-authx', path);
        const ctrl = new AbortController();
        const to = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 5000);
        let resp: Response;
        try {
          resp = await fetch(`${base}${path}`, { credentials: 'include', headers: { 'Authx': authx }, signal: ctrl.signal });
        } finally { clearTimeout(to); }
        if (!resp.ok) return null;
        const json = await resp.json();
        const data = json?.data || {};
        const itemType = (data.type || data.item?.type) as string | undefined;
        // 类型白名单：仅电影/电视节目/混合影片(作品类)进入轮播
        if (itemType && !isSyncableItemType(itemType)) {
          log('skip non-syncable carousel item:', show.id, 'type=', itemType);
          return null;
        }
        // [lc-545] M3U8/电视直播剔除：is_m3u8=true 的项无封面图，直接剔掉
        if (data.is_m3u8) {
          log('skip m3u8/live-tv carousel item:', show.id, 'is_m3u8=true');
          return null;
        }
        const poster = pickImg(data.posters) || (show as any).poster || '';
        const backdrop = pickImg(data.backdrops) || poster;
        // 无封面图防御：poster 和 backdrop 都为空的项无法渲染轮播，跳过
        if (!backdrop) {
          log('skip no-image carousel item:', show.id, 'no poster/backdrop');
          return null;
        }
        const tmdbId = extractTmdbId(data);
        const totalEps = (data.number_of_episodes as number) || 0;
        const localEps = (data.local_number_of_episodes as number) || 0;
        const rawYear = (data.production_year as any) || ((data.premiere_date as string) || (data.air_date as string) || '').slice(0, 4);
        const year = Number(rawYear) || 0;
        return {
          id: show.id, title: show.title,
          poster, backdrop,
          desc: data.overview || '',
          mediaType: show.mediaType || (itemType === 'Movie' ? 'movie' : 'tv'),
          tmdbId, totalEps, localEps, year
        };
      } catch (e) { return null; }
    };
    // 并行拉取全部候选（保留顺序），再过滤掉 null（直播/非作品类/无封面），取前 10 个
    log('fetching', candidates.length, 'candidate details in parallel...');
    const results = await Promise.all(candidates.map((c) => fetchOne(c)));
    const valid = results.filter((x: any) => x);
    newShows.push(...valid.slice(0, 10));
    log('parallel fetch done:', results.length, 'fetched,', valid.length, 'valid, took first', newShows.length);

    // 仅在新数据确实拉到内容时才替换(空数据保留旧的不变)
    if (newShows.length > 0) {
      _apiShows.length = 0;
      Array.prototype.push.apply(_apiShows, newShows);
    } else if (candidates.length > 0) {
      // [lc-181] iframe 提取到条目, 但全部因「非3类型」被过滤 → 首页没有其他作品类内容可展示。
      // 记一条诊断, 便于区分「白屏是卡死」还是「确实没有可展示的作品类」。
      log('all extracted items filtered out as non-syncable (', candidates.length, 'extracted, 0 kept) — 首页无可展示的作品类轮播');
    }
    _apiLoaded = true;
    log('final 1st title:', _apiShows[0]?.title?.substring(0,15), 'poster:', (_apiShows[0]?.poster||'NONE').substring(0,100));
    log('total', _apiShows.length, 'shows from iframe+API (new=' + newShows.length + ')');
  } catch (e) { log('iframe error:', e); }
  _apiLoading = false;
  return _apiShows;
}

/* ========== 拦截matchMedia ========== */
(function narrowMode(): void {
  try {
    const orig = window.matchMedia;
    const origFn = orig.bind(window);
    window.matchMedia = (query: string): MediaQueryList => {
      const mql = origFn(query);
      if (query.includes('1024')) {
        Object.defineProperty(mql, 'matches', { get: () => false, configurable: true });
      }
      return mql;
    };
  } catch (e) { /* ignore */ }
})();

/* ========== 横滑滚轮 ========== */
// 记录每个元素已绑定的 wheel 处理器，便于关闭开关时精确移除（removeEventListener 需同一引用）
const _wtsBound = new WeakMap<HTMLElement, (ev: WheelEvent) => void>();

function wheelToScroll(): void {
  // 关闭开关 → 解绑所有劫持监听，并清除我们附加在飞牛原生横滑箭头上的样式，
  // 把 display/opacity/pointer-events 全部交还 fnOS 原生逻辑（箭头照常显示）。
  if (!_wheelHScrollEnabled) {
    document.querySelectorAll('[data-ws="1"]').forEach((e) => {
      const he = e as HTMLElement;
      const h = _wtsBound.get(he);
      if (h) { he.removeEventListener('wheel', h as EventListener); _wtsBound.delete(he); }
      delete he.dataset.ws;
    });
    // 同时清掉旧版(wheelHScroll=display:none)可能残留的内联样式，确保原生箭头恢复
    document.querySelectorAll('[class*="semi-color-bg-arrow-mask"]').forEach((e) => {
      const el = e as HTMLElement;
      el.style.display = '';
      el.style.opacity = '';
      el.style.pointerEvents = '';
    });
    return;
  }
  // 开启开关 → 竖向滚轮在横向溢出容器内转为左右滑动。
  // 关键：飞牛(Semi ScrollList)横向箭头的可见性由其原生激活逻辑控制，
  // 一旦用 display:none 隐藏就会破坏该逻辑、且关闭后无法自行恢复。
  // 因此只以 opacity:0 + pointer-events:none 做「视觉隐藏」，**绝不碰 display**，
  // 这样关闭时清除上述样式即可让 fnOS 原生箭头完整恢复。
  document.querySelectorAll('[class*="semi-color-bg-arrow-mask"]').forEach((e) => {
    const el = e as HTMLElement;
    el.style.opacity = '0';
    el.style.pointerEvents = 'none';
  });
  document.querySelectorAll('div,section,main').forEach((e) => {
    const he = e as HTMLElement;
    if (he.dataset.ws === '1') return;
    const cs = getComputedStyle(he);
    if ((cs.overflowX === 'scroll' || cs.overflowX === 'auto') && he.scrollWidth > he.clientWidth + 2) {
      he.dataset.ws = '1';
      const handler = (ev: WheelEvent): void => {
        const r = he.getBoundingClientRect();
        if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return;
        if (Math.abs(ev.deltaY) < Math.abs(ev.deltaX) * 2) return;
        ev.preventDefault();
        he.scrollLeft += ev.deltaY * 1.5;
      };
      _wtsBound.set(he, handler);
      he.addEventListener('wheel', handler as EventListener, { passive: false });
    }
  });
}

/* ========== 轮播图(硬编码+API双数据源) ========== */
const RECENT_SHOWS: {id:string;title:string;poster:string;backdrop:string;logo?:string;desc?:string}[] = [
  {id:"600e702357d6422f99570302a557c179",title:"无职转生：到了异世界就拿出真本事",poster:"sys/img/6d/20/RXFg9YOlYYTNwMynBkZifbn3VpVnzd401lk1CjS099E0CKLryIhtiEh0kUa5C9ALsxThuxVJHAuAsMr9AqShrEtMmd.webp",backdrop:"sys/img/b5/09/RXFg9YOlYYTNwMynBkZifbn3VpVnzd401lk1CjS099E0CKLrxY8oi8MB7PGRxO9uahSFWEogko18H7l5d0vFKgNjCZ.webp",logo:"sys/img/36/19/RXFg9YOlYYTNwMynBkZifbn3VpVnzd401lk1CjS099E0CKLrufzkvII9rBvj5Zncvfx8X9omwarNU6AHS1wMD3y0oR.webp",desc:"我要在这个异世界拿出真本事！34岁童贞且无职的家里蹲男子，在父母的葬礼当天被赶出家门后，在路上被一辆卡车所撞死。意识清醒后，他发现自己居然作为一个刚出生的婴儿转生到了剑与魔法的异世界！像废物一样活过了前世的男子，发誓要作为少年·鲁迪乌斯在异世界以认真的态度好好活下去！"},
  {id:"f0489bd203224933a4346d899967cb3c",title:"黑猫与魔女的教室",poster:"sys/img/6e/10/RXFg9YOlYYTNwMynBkZifbn3VpVnzd401lk1CjS099E0CKLry0pfI5ZmtCQVddZ3eD8kMb2trAbSWnam4na8Ya5KPn.webp",backdrop:"sys/img/05/14/RXFg9YOlYYTNwMynBkZifbn3VpVnzd401lk1CjS099E0CKLry85pmDsiFggSDzRP7T1O9odmC4rdcZw5H6dmxoCS0N.webp",desc:"见习魔女丝碧卡·瓦戈以考上王立戴安娜魔法学校并成为一等魔法师为目标，却一直无法成功使用魔法。某天，一只会讲人话还会操纵魔法的神秘黑猫出现在她的面前！想要学习魔法的丝碧卡和想要解除诅咒的黑猫想法完全一致！他们就此结成了秘密的师徒关系！"},
  {id:"5c6608e53f804cc3adfb7f8dbafa742d",title:"石纪元",poster:"sys/img/2a/06/RXFg9YOlYYTNwMynBkZifbn3VpVnzd401lk1CjS099E0CKLrucjx8YQ2wvgwN09d2clhpz20SO6PG7phAQaU6Vb8eF.webp",backdrop:"sys/img/86/11/RXFg9YOlYYTNwMynBkZifbn3VpVnzd401lk1CjS099E0CKLrxfYGnuuP36Ph0e7k357DOXckP3SyMAmmM1ZrBEOnsF.webp",desc:"全人类被神奇的现象一瞬间石化后过了几千年——拥有超人般头脑、天生的科学少年·千空苏醒了。在文明遭到毁灭的石之世界里，千空决定用科学的力量夺回世界。集结伙伴的力量，不断创造出从石器时代到现代文明的科学发明，一部前所未闻的创世冒险故事就此展开！"},
  {id:"25463bef86494794b71bcbcdd3907bae",title:"最强王者的第二人生",poster:"sys/img/cb/12/RXFg9YOlYYTNwMynBkZifbn3VpVnzd401lk1CjS099E0CKLruLZsV5Ro61WX9XbEeaYoqknr82WIpePXGRg5OnHIHv.webp",backdrop:"sys/img/cf/18/RXFg9YOlYYTNwMynBkZifbn3VpVnzd401lk1CjS099E0CKLrxH6MjA3f8iD4PPxqPAD9N8iMlQWwCt2aa0mJcXfWH1.webp",desc:"曾经的一国之君意外身亡，穿越到魔法世界却成为手无缚鸡之力的婴儿？好吧，在壮阔而神秘的世界从零开始！比修炼更重要的是，他要先学会如何自己上厕所…离开襁褓成为强者，失去了尊贵王冠的他，用利剑为自己加冕！"},
  {id:"d1c6fbc986af40528fe47ddee80ecf75",title:"朱音落语",poster:"sys/img/fc/14/RXFg9YOlYYTNwMynBkZifbn3VpVnzd401lk1CjS099E0CKLrxmNkSdSojZJ693vP4raUPda0ea0wEV569rrrHxJJUV.webp",backdrop:"sys/img/9b/20/RXFg9YOlYYTNwMynBkZifbn3VpVnzd401lk1CjS099E0CKLruZJymtMoWXrbWw9guuVbLQ4ymKMWKIirTco9fydX55.webp",desc:"以其身及文字来诠释故事的一切，说话艺术的极致——落语。被这究极的表演方法迷住的是落语家·阿良川志太及其女儿·朱音。见证父亲在落语晋级考试的努力后，朱音将踏上自己的落语家之道——落语家的故事正式开幕！"},
  {id:"6b046b0ebf1f4f76a0c8a1cc8d6564dd",title:"杖与剑的魔剑谭",poster:"sys/img/45/19/RXFg9YOlYYTNwMynBkZifbn3VpVnzd401lk1CjS099E0CKLrucxlCydGCPNrTWzk3V04WDDCrsvMFO2sqTd5dslY4V.webp",backdrop:"sys/img/0f/19/RXFg9YOlYYTNwMynBkZifbn3VpVnzd401lk1CjS099E0CKLrxmJUsf2r2SMcZv8D2Kxg3CcWVB0oaT0tgaHr8rYlyZ.webp"},
  {id:"4920d43f6eea4426b0d5f3c1f8196f3f",title:"异世界悠闲农家",poster:"sys/img/2d/01/RXFg9YOlYYTNwMynBkZifbn3VpVnzd401lk1CjS099E0CKLruKw9X99lQ8WfBlogbl8DPexx7i74MaQK6n6dr0tVAN.webp",backdrop:"sys/img/04/20/RXFg9YOlYYTNwMynBkZifbn3VpVnzd401lk1CjS099E0CKLryTVusVIAsfc4IIwdtPA8zMrgI4smAYirgltrlzzzJH.webp",desc:"在黑企业过度使用身体，与疾病斗争后丧命的青年街尾火乐，拿着神赐予的万能农具，在异世界与吸血鬼、天使、精灵等相遇，度过第二人生的异世界种田流奇幻故事。"},
  {id:"39d134b62ed1430a8574b04d63d5bb3f",title:"双人独自露营",poster:"sys/img/2d/06/RXFg9YOlYYTNwMynBkZifbn3VpVnzd401lk1CjS099E0CKLruZAGStvLFD2kMNgqOTfuU1uPW0TmO63BECEFRNopkt.webp",backdrop:"sys/img/da/04/RXFg9YOlYYTNwMynBkZifbn3VpVnzd401lk1CjS099E0CKLrxfaCue7v3Cdfe5EMA9ByLudVwpWLLifRVFTGebitGx.webp",desc:"树乃仓严，34岁。这位独爱孤独的露营高手，正像往常一样享受着单人露营的宁静。然而，一次意外让他遇见了超级露营新手——草野雫。尽管不情愿，严还是和雫开始了两人的单人露营！严平静的露营生活将会如何发展？"},
  {id:"6e5f44da0b9d45ad9f2cbb28e2b06a29",title:"弱弱老师",poster:"sys/img/81/17/RXFg9YOlYYTNwMynBkZifbn3VpVnzd401lk1CjS099E0CKLrx6GZ5Zmae9ZLLSilFowqVvZUn4WVOc7KyfAf5tn7aB.webp",backdrop:"sys/img/2b/13/RXFg9YOlYYTNwMynBkZifbn3VpVnzd401lk1CjS099E0CKLrxD1e7HXIfJtLPn71QSzbxjFUySekMujr90V8vjjNsl.webp",desc:"新学期，成为升上高二的男高中生阿比仓同学他们班主任的是，传言一旦心情不佳就会诅咒人的俗称咒恨老师的，鶸村日和老师！在一天放学后，目击了这样的咒恨老师背后一面的阿比仓同学他……意想不到的反差让人扭成蛆！挑起你的保护欲的弱弱恋爱喜剧开幕！"},
  {id:"65a0c386f4aa4de18ddfd4e44d55e7fe",title:"不良少女",poster:"sys/img/a1/13/RXFg9YOlYYTNwMynBkZifbn3VpVnzd401lk1CjS099E0CKLrxKBiEBCHGfr2gG8AuKgcw6whYyVXbYx0eszkTz5Zqx.webp",backdrop:"sys/img/dd/08/RXFg9YOlYYTNwMynBkZifbn3VpVnzd401lk1CjS099E0CKLrxqb4QO0xItzvJrBxw8AxccXYEDsJ6SYqZCvm9IhYZz.webp",desc:"锐利的眼神、显眼的耳环，再加上一头超吸睛的双色头发——高一学生·优谷优。她是出了名的不良少女，连路人见了都会自动让路……才不是那样！本性其实是超级好孩子的优，脑袋里总是塞满了校园女神——水鸟亚鸟的身影。为了引起担任风纪委员长的她的注意，优每天都在努力奋斗！"},
];

/* ========== 鉴权拉取图片→blob URL(绕开<img>无法带Authx头的问题) ========== */
async function fetchImageAuth(fullUrl: string): Promise<string | null> {
  if (!fullUrl) return null;
  try {
    const { ipcRenderer } = require('electron');
    // 提取path(含query)用于签名, 必须与fetch的URL完全一致
    let path = fullUrl;
    const m = fullUrl.match(/^https?:\/\/[^/]+(\/.*)$/);
    if (m) path = m[1];
    const authx = await ipcRenderer.invoke('fnos-gen-authx', path);
    const resp = await fetch(fullUrl, { credentials: 'include', headers: { 'Authx': authx } });
    const ct = resp.headers.get('content-type') || '';
    log('fetchImg', path.substring(0, 46), 'status', resp.status, 'ct', ct.substring(0, 24));
    if (!resp.ok || !ct.startsWith('image/')) {
      try { const t = await resp.text(); log('fetchImg body:', t.substring(0, 90)); } catch (e) {}
      return null;
    }
    const blob = await resp.blob();
    return URL.createObjectURL(blob);
  } catch (e) { log('fetchImg err', String(e).substring(0, 90)); return null; }
}

let _carouselInited = false;
let _carouselContainer: HTMLElement | null = null;
let _carouselUpdatedAt = 0; // 最近更新板块数据就绪(轮播注入)时间戳, 用于标题旁显示更新时间
let _carouselWrapper: HTMLElement | null = null;
let _carouselPosterStrip: HTMLElement | null = null; // [lc-439] 右侧竖向海报条
// 占位只需构建一次: 否则下方 MutationObserver 会在每次占位 DOM 变更后再次调用
// injectCarousel → 反复清空重建占位 → 渲染线程死循环 → 白屏卡死(见 lc-100)
let _placeholderInited = false;

// [B 项] 健壮查找"媒体库"section: 原逻辑写死 Tailwind 类名(.relative.flex.flex-col.gap-6 > div)
// 且要求 strong 含"媒体库", 一旦目标 fnOS 布局的 class/文案不同就 sections found:0 → no target(轮播缺失)。
// 这里做多级兜底, 尽量在各类布局/语言下都能定位到正确的媒体库区块。
function findMediaLibrarySection(): HTMLElement | null {
  // [lc-183] 兜底: 弹窗打开时绝不把弹窗内的"媒体库"当目标(弹窗守卫已在 injectCarousel 拦截, 此处双保险)
  if (isModalOpen()) return null;
  const labelRe = /媒体库|片库|影视库|library|my\s*media/i;
  // 1) 原已知布局: .relative.flex.flex-col.gap-6 的直接子 div 且含媒体库标题
  const known = document.querySelectorAll('.relative.flex.flex-col.gap-6 > div');
  for (const s of Array.from(known) as HTMLElement[]) {
    const strong = s.querySelector('strong');
    if (strong && labelRe.test(strong.textContent || '')) return s;
  }
  // 2) 宽匹配: 含 flex-col 的容器, 且内部标题含媒体库字样(确保定位到区块级)
  const flexCols = document.querySelectorAll('div[class*="flex-col"]');
  for (const s of Array.from(flexCols) as HTMLElement[]) {
    const head = s.querySelector('strong,h2,h3');
    if (head && labelRe.test(head.textContent || '')) return s;
  }
  // 3) 终极兜底: 找媒体库标题, 向上取到含子节点且具布局类的祖先作为 section
  const heads = document.querySelectorAll('strong,h2,h3');
  for (const h of Array.from(heads) as HTMLElement[]) {
    if (!labelRe.test(h.textContent || '')) continue;
    let el: HTMLElement | null = h.parentElement;
    while (el && el !== document.body && el.parentElement) {
      const cls = (el.className || '') as string;
      if (el.children.length >= 1 && /flex|grid|relative|section/i.test(cls)) return el;
      el = el.parentElement;
    }
  }
  return null;
}

// [lc-183] 判断当前是否有 fnOS 弹窗/对话框打开。
// 这些弹窗是 SPA 模态框(打开时 URL 仍是 /v, lc-182 路径守卫拦不住),
// 且弹窗内(如"创建媒体库"标题)也含"媒体库"文字 → findMediaLibrarySection 会误匹配到弹窗内部
// → target.innerHTML='' 把弹窗内容(含确认/确定/选择按钮)整个清空 → 按钮"消失"。
// 因此: 只要页面上有任意弹窗, 一律不注入轮播(弹窗关闭后 Observer 会自然重新触发注入)。
function isModalOpen(): boolean {
  return !!document.querySelector(
    '[role="dialog"], .semi-modal-mask, .semi-modal-wrapper, .semi-modal, [aria-modal="true"]'
  );
}

/** 轮播「最近更新」标签内的日期: M/D（不带时间） */
function fmtCarouselUpdated(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return (d.getMonth() + 1) + '/' + d.getDate();
}

function injectCarousel(): void {
  log('injectCarousel called, _carouselInited=', _carouselInited, '_apiShows.length=', _apiShows.length);
  if (_carouselInited) return;

  // [lc-182] 路径守卫: 轮播仅注入首页(/v 或 /v/)。
  const p = location.pathname;
  if (p !== '/v' && p !== '/v/') {
    return; // 静默跳过, 不打日志(避免非首页页面刷屏)
  }

  // [lc-183] 弹窗守卫: 任意 fnOS 弹窗打开时绝不注入(弹窗内"媒体库"文字会误导匹配)。
  if (isModalOpen()) {
    return; // 弹窗关闭后 DOM 变化会触发 Observer 重新注入
  }

  // 找"媒体库"section: 首屏用DOM搜索, 重建复用已有wrapper的parent(避免wrapper嵌套)
  let target: HTMLElement | null = null;
  let rebuild = false;
  if (_carouselWrapper && document.body.contains(_carouselWrapper)) {
    target = _carouselWrapper.parentElement; // section
    rebuild = true;
    log('rebuild: reusing section(parent of existing wrapper)');
  } else {
    target = findMediaLibrarySection();
    if (target) log('media-library section found via robust search');
  }
  if (!target) { log('no target'); return; }
  log('target found on', location.href, rebuild ? '(rebuild)' : '(first)');

  // 预加载占位: 真实片库「仍在加载中」时, 显示优雅占位(不再用硬编码 demo 无职转生)
  // 注意: 此处不设 _carouselInited=true, 让数据到位后 injectCarousel() 能重新进入并重建真实轮播
  if (_apiShows.length === 0) {
    log('api not ready, showing loading placeholder');
    // [lc-100 修复] 占位只构建一次: 下方 MutationObserver 监听 document.body 任意变更,
    // 若每次都重建占位(清空+追加会触发 DOM 变更), 会再次唤醒 observer → 无限重建 → 渲染线程卡死白屏。
    if (_placeholderInited) return;
    buildLoadingPlaceholder(target);
    _placeholderInited = true;
    return;
  }
  // 真实数据到达: 复位占位守卫, 以便将来数据清空时可再次显示占位
  _placeholderInited = false;

  _carouselInited = true; // 仅在真实数据注入后才标记(避免 loading 占位锁死重建)
  _carouselUpdatedAt = Date.now(); // 记录"最近更新"板块数据就绪时刻, 供标题旁更新时间显示
  log('carousel data ready at', new Date(_carouselUpdatedAt).toLocaleString('zh-CN'));

  // 数据: API优先(动态/自动/最新排序); 仅当真实片库为空才兜底(上面已拦截空数据)
  // 注意: 只要真实片库 >0 条就只用真实内容, 不再回退硬编码 demo(避免无职转生兜底出现)
  const shows = _apiShows.length > 0 ? _apiShows : RECENT_SHOWS;
  log('injecting', shows.length, 'shows (api:', _apiShows.length, 'hardcoded:', RECENT_SHOWS.length, ')');

  const base = location.origin;
  let currentIdx = 0;
  const infos: HTMLElement[] = [];

  // 统一容器: 重建时复用已有wrapper(保留padding:0 44px), 避免嵌套叠加导致宽度变宽
  let wrapper: HTMLElement;
  if (rebuild && _carouselWrapper) {
    wrapper = _carouselWrapper;
    wrapper.innerHTML = ''; // 清空旧container(我们自己的节点, 不影响飞牛DOM), 内部重建
  } else {
    target.innerHTML = ''; // 首屏清空section原内容(媒体库标题+卡片)
    // [lc-444] 清掉飞牛section自身顶部边框/阴影/上边距, 避免与顶部导航栏之间出现细黑线
    target.style.borderTop = 'none';
    target.style.boxShadow = 'none';
    target.style.marginTop = '0';
    target.style.background = 'transparent';
    wrapper = document.createElement('div');
    wrapper.style.cssText = 'padding:0 44px;margin-top:0;margin-bottom:-8px';
    _carouselWrapper = wrapper;
  }
  const container = document.createElement('div');
  container.style.cssText = 'position:relative;overflow:hidden;width:100%;max-height:calc(100vh - 380px);aspect-ratio:16/9;border-radius:24px;background:var(--fnos-hero-container);backdrop-filter:blur(24px) saturate(140%);-webkit-backdrop-filter:blur(24px) saturate(140%);margin:0 auto;box-shadow:none';
  wrapper.appendChild(container);
  _carouselContainer = container;

  // [lc-442] wrapper 改为 flex 并排：左轮播容器 + 右侧独立海报条容器
  wrapper.style.display = 'flex';
  wrapper.style.alignItems = 'flex-start';
  wrapper.style.gap = '12px';

  // Slide track (纵向: 上→下切换)
  const track = document.createElement('div');
  track.style.cssText = 'display:flex;flex-direction:column;position:absolute;top:0;left:0;width:100%;height:100%;transition:transform .8s ease-in-out';
  track.style.transform = 'translateX(0)';
  container.appendChild(track);

  // 右侧独立竖向海报条容器（与轮播容器并列）
  const posterStrip = document.createElement('div');
  posterStrip.className = 'fnos-poster-strip';
  posterStrip.style.cssText = 'width:150px;flex-shrink:0;height:100%;max-height:calc(100vh - 380px);overflow:hidden;display:block;padding:0 8px;background:rgba(255,255,255,.12);backdrop-filter:blur(14px) saturate(120%);-webkit-backdrop-filter:blur(14px) saturate(120%);border-radius:24px;border:none';
  wrapper.appendChild(posterStrip);
  _carouselPosterStrip = posterStrip;

  // 轮播点已移除(lc-441, 用户不需要)

  // URL规范化: 硬编码用相对路径, API返回完整URL
  const imgUrl = (p: string, w?: number) => {
    if (!p) return '';
    if (p.startsWith('http') || p.startsWith('/v/api/')) return p + (w ? '?w=' + w : '');
    return `${base}/v/api/v1/${p}` + (w ? '?w=' + w : '');
  };

  shows.forEach((show, i) => {
    const slide = document.createElement('div');
    slide.style.cssText = 'width:100%;height:100%;position:relative;flex-shrink:0;display:flex;background:transparent;overflow:hidden;border-radius:inherit';
    slide.className = 'fnos-slide';

    // 左: 图片面板(占 ~80%, 撑满无白边)
    const leftEl = document.createElement('div');
    leftEl.style.cssText = 'position:relative;width:80%;height:100%;overflow:hidden;flex-shrink:0;background:transparent';
    const imgEl = document.createElement('img');
    // [v337] 改 cover 撑满左面板(上下无白边); 仅裁左右一点点, 左对齐保持(替代 v336 的 contain+22px白边)
    imgEl.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;object-position:left center';
    leftEl.appendChild(imgEl);
    const pic = imgUrl(show.backdrop); // 不带?w, 避免与签名path不一致
    if (shows === _apiShows && i === 0) log('SLIDE0 img src:', pic.substring(0, 80));
    fetchImageAuth(pic).then((b) => { if (b) imgEl.src = b; });
    // 右边缘渐隐, 与右侧文字面板自然融合
    const edgeFade = document.createElement('div');
    edgeFade.style.cssText = 'position:absolute;inset:0;background:var(--fnos-hero-edge)';
    leftEl.appendChild(edgeFade);
    // [lc-436] logo 移到整个海报(左侧图片)左下角, 叠在背景图上, z-index 高于渐隐
    const cornerLogo = document.createElement('img');
    cornerLogo.className = 'fnos-logo';
    cornerLogo.alt = '';
    cornerLogo.style.cssText = 'position:absolute;left:28px;bottom:24px;max-width:36%;max-height:88px;width:auto;height:auto;object-fit:contain;object-position:left bottom;filter:drop-shadow(0 3px 14px rgba(0,0,0,.55));display:none;z-index:3';
    leftEl.appendChild(cornerLogo);
    slide.appendChild(leftEl);

    // 右: 文字面板 — [lc-439] 收窄为30%, 为右侧海报条让空间
    const rightPanel = document.createElement('div');
    rightPanel.style.cssText = 'position:relative;width:20%;height:100%;flex-shrink:0;display:flex;flex-direction:column;padding:24px 22px 24px 22px;background:var(--fnos-hero-panel);backdrop-filter:blur(26px);-webkit-backdrop-filter:blur(26px);border-left:var(--fnos-hero-panel-border);overflow:hidden';

    // 信息卡: 占满面板高度, 自顶向下分层(徽标→标题/logo→细分隔→弹性简介→锚底按钮); 字体整体放大
    const info = document.createElement('div');
    info.style.cssText = 'position:relative;z-index:2;display:flex;flex-direction:column;gap:14px;width:100%;height:100%;overflow:hidden;opacity:0;transform:translateY(28px);transition:all .7s cubic-bezier(.16,1,.3,1) .15s';
    // [lc-451] 徽标：剧集「全N集·更新至M集」(完整版仅「全N集」)；电影「年份 · 电影」
    const totalEps = (show as any).totalEps || 0;
    const localEps = (show as any).localEps || 0;
    const year = (show as any).year || 0;
    let pillText: string;
    if (show.mediaType === 'movie') {
      pillText = (year ? year + ' · ' : '') + '电影';
    } else if (localEps > 0) {
      const total = totalEps > 0 ? totalEps : localEps;
      const isComplete = totalEps > 0 ? (totalEps === localEps) : (localEps > 0);
      pillText = isComplete ? `全${total}集` : `全${total}集 · 更新至${localEps}集`;
    } else {
      pillText = '✨ 最近更新';
    }
    info.innerHTML = `
      <div class="fnos-pill" style="display:inline-flex;align-items:center;gap:5px;padding:6px 14px;background:rgba(150,120,200,.16);border:1px solid rgba(170,150,220,.30);border-radius:20px;color:#c4b6e3;font-size:11.5px;font-weight:600;letter-spacing:1px;align-self:flex-start;flex-shrink:0;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)">${pillText}</div>
      <div class="fnos-title-wrap" style="display:flex;flex-direction:column;gap:12px;flex-shrink:0;justify-content:flex-start;margin-top:2px">
        <div class="fnos-title" style="font-size:clamp(28px,3.4vh,40px);font-weight:800;color:var(--fnos-hero-title);line-height:1.2;letter-spacing:.5px;word-break:break-word;text-shadow:var(--fnos-hero-shadow)">${show.title}</div>
      </div>
      <div style="width:100%;height:1px;background:var(--fnos-hero-divider);margin:16px 0 14px;flex-shrink:0;border-radius:1px;opacity:.85"></div>
      <div class="fnos-desc" style="flex:1 1 auto;min-height:0;-webkit-line-clamp:5;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;font-size:14.5px;line-height:1.75;color:var(--fnos-hero-desc);letter-spacing:.4px;font-weight:500;text-indent:2em;mask-image:linear-gradient(180deg,rgba(0,0,0,1) 80%,rgba(0,0,0,0) 100%);-webkit-mask-image:linear-gradient(180deg,rgba(0,0,0,1) 80%,rgba(0,0,0,0) 100%)">${show.desc||''}</div>
      <div class="fnos-action" style="flex-shrink:0;margin-top:auto;display:flex;align-items:center;gap:14px;padding-top:6px">
        <a class="fnos-play" href="/v/tv/${show.id}" style="display:inline-flex;align-items:center;justify-content:center;gap:11px;padding:15px 34px;background:var(--fnos-hero-play-bg);backdrop-filter:blur(14px) saturate(130%);-webkit-backdrop-filter:blur(14px) saturate(130%);border:1px solid var(--fnos-hero-play-border);border-radius:14px;color:var(--fnos-hero-play-text);font-size:16.5px;font-weight:600;text-decoration:none;letter-spacing:1.5px;box-shadow:0 6px 22px rgba(80,60,140,.22),inset 0 .5px 0 rgba(255,255,255,.25);transition:all .22s ease">
          <svg width="19" height="19" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>
          开始观看
        </a>
      </div>`;
    rightPanel.appendChild(info);
    slide.appendChild(rightPanel);

    // [v323] 让"开始观看"走飞牛原生SPA路由(与列表项<a>一致), 避免整页导航导致详情页侧栏按钮失效
    // 轮播<a>不在飞牛React树内, 原生点击会触发整页导航(full page load) → 详情页头部重建 → 我们的click hook丢失
    // 改为手动pushState+popstate(飞牛history模式SPA基于此), 保留头部DOM, 与列表点击同路径
    const playBtn = info.querySelector('a');
    if (playBtn) {
      playBtn.addEventListener('click', (e: Event) => {
        e.preventDefault();
        const href = '/v/tv/' + show.id;
        log('PLAY btn -> SPA navigate', href);
        history.pushState({}, '', href);
        window.dispatchEvent(new PopStateEvent('popstate'));
        // [v323兜底] 若飞牛未响应popstate(详情页未渲染), 600ms后退化整页导航;
        //   详情页加载后 MutationObserver 会兜底重绑汉堡键 hook
        setTimeout(() => {
          const detailReady = !!document.querySelector('button[aria-label="返回"]');
          if (!detailReady) {
            log('PLAY fallback -> full page nav (popstate not handled)', href);
            location.href = href;
          }
        }, 600);
      });
      // 悬停效果: 主题色提亮 + 轻微上浮
      playBtn.addEventListener('mouseenter', () => {
        (playBtn as HTMLElement).style.background = 'var(--fnos-hero-play-hover)';
        (playBtn as HTMLElement).style.boxShadow = '0 6px 24px rgba(100,80,180,.28),inset 0 .5px 0 rgba(255,255,255,.35)';
        (playBtn as HTMLElement).style.transform = 'translateY(-1px)';
      });
      playBtn.addEventListener('mouseleave', () => {
        (playBtn as HTMLElement).style.background = 'var(--fnos-hero-play-bg)';
        (playBtn as HTMLElement).style.boxShadow = '0 4px 20px rgba(80,60,140,.20),inset 0 .5px 0 rgba(255,255,255,.25)';
        (playBtn as HTMLElement).style.transform = '';
      });
    }
    track.appendChild(slide);
    infos.push(info);

    // [lc-408] 重建轮播时若已缓存过 logo(tmdbLogo/本地 logo), 立即复用, 避免重渲后退回文字标题
    if (show.tmdbLogo) {
      swapTitleToLogo(info, show.tmdbLogo);
    }

    // dot removed (lc-441)
  });

  // [lc-439] 填充右侧竖向海报条：全部10个剧的竖向poster，自动滚动+点击跳转
  if (_carouselPosterStrip && shows.length > 0) {
    _carouselPosterStrip.innerHTML = '';
    const pInner = document.createElement('div');
    pInner.className = 'fnos-ps-inner';
    pInner.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;width:100%;padding:20px 0;position:relative;transition:transform .4s ease';
    // 每个海报项：竖向封面 + 标题截断
    shows.forEach((show, pi) => {
      const item = document.createElement('div');
      item.style.cssText = 'cursor:pointer;transition:all .3s ease;opacity:.65;transform:scale(.92)';
      item.dataset.idx = String(pi);
      const pImg = document.createElement('img');
      pImg.alt = show.title;
      pImg.style.cssText = 'width:120px;height:170px;object-fit:cover;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,.18);display:block;background:rgba(200,190,220,.25)';
      const pUrl = imgUrl(show.poster);
      fetchImageAuth(pUrl).then((b) => { if (b) pImg.src = b; });
      const pTitle = document.createElement('div');
      pTitle.style.cssText = 'font-size:11px;color:rgba(20,35,70,.7);text-align:center;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px;line-height:1.3';
      pTitle.textContent = show.title;
      item.appendChild(pImg);
      item.appendChild(pTitle);
      item.addEventListener('click', () => goTo(pi));
      // [lc-440] 悬停联动：鼠标放到右侧某海报, 主轮播切到该集
      item.addEventListener('mouseenter', () => {
        goTo(pi);
        item.style.opacity='1'; item.style.transform='scale(1)';
      });
      item.addEventListener('mouseleave', () => {
        if (pi !== currentIdx) { item.style.opacity='.65'; item.style.transform='scale(.92)'; }
      });
      pInner.appendChild(item);
    });
    _carouselPosterStrip.appendChild(pInner);

    // [lc-448] 右侧海报不自滚动：选中项自动居中并放大, 与左侧主轮播联动
    function centerPoster(idx: number) {
      const strip = _carouselPosterStrip;
      if (!strip) return;
      const target = pInner.children[idx] as HTMLElement | undefined;
      if (!target) return;
      const stripH = strip.clientHeight;
      const desired = target.offsetTop + target.offsetHeight / 2 - stripH / 2;
      const maxScroll = Math.max(0, pInner.scrollHeight - stripH);
      const clamped = Math.min(Math.max(desired, 0), maxScroll);
      pInner.style.transform = `translateY(-${clamped}px)`;
    }

    // 高亮当前slide对应的海报：选中项放大+不透明并居中, 其余缩小+半透明（goTo 里同步调用）
    (_carouselPosterStrip as any)._highlight = (idx: number) => {
      const items = pInner.children;
      for (let k = 0; k < items.length; k++) {
        const el = items[k] as HTMLElement;
        if (k === idx) { el.style.opacity = '1'; el.style.transform = 'scale(1.12)'; el.style.zIndex = '2'; }
        else { el.style.opacity = '.5'; el.style.transform = 'scale(.9)'; el.style.zIndex = '1'; }
      }
      centerPoster(idx);
    };
  }

  if (infos.length > 0) {
    infos[0].style.opacity = '1';
    infos[0].style.transform = 'translateY(0)';
    if (_carouselPosterStrip && (_carouselPosterStrip as any)._highlight) (_carouselPosterStrip as any)._highlight(0);
  }

  function goTo(idx: number) {
    currentIdx = idx;
    track.style.transform = `translateY(-${idx * 100}%)`;
    infos.forEach((el, j) => { el.style.opacity = j === idx ? '1' : '0'; el.style.transform = j === idx ? 'translateY(0)' : 'translateY(20px)'; });
    // [lc-439] 同步高亮右侧海报条
    if (_carouselPosterStrip && (_carouselPosterStrip as any)._highlight) (_carouselPosterStrip as any)._highlight(idx);
  }

  let timer = setInterval(() => goTo((currentIdx + 1) % shows.length), 6000);
  container.addEventListener('mouseenter', () => clearInterval(timer));
  container.addEventListener('mouseleave', () => { timer = setInterval(() => goTo((currentIdx + 1) % shows.length), 6000); });
  // [lc-442] 海报条独立容器，悬停也暂停主轮播
  posterStrip.addEventListener('mouseenter', () => clearInterval(timer));
  posterStrip.addEventListener('mouseleave', () => { timer = setInterval(() => goTo((currentIdx + 1) % shows.length), 6000); });

  let startY = 0, dragging = false;
  container.addEventListener('mousedown', (e) => { startY = e.clientY; dragging = true; });
  container.addEventListener('mouseup', (e) => {
    if (!dragging) return; dragging = false;
    const dy = e.clientY - startY;
    if (dy < -50) goTo((currentIdx + 1) % shows.length);
    else if (dy > 50) goTo((currentIdx - 1 + shows.length) % shows.length);
  });

  if (!rebuild) target.appendChild(wrapper);

  /* 异步补齐缺失的简介(从详情页提取,未来新增自动获取) */
  autoFetchDescs(base, shows, infos);

  /* [lc-408] 异步把右侧文字标题替换为 TMDB 透明 logo（获取成功才替换，否则保留文字） */
  // [lc-409] 记录当前轮播引用，供设置开关即时生效
  _carouselInfos = infos;
  _carouselShows = shows;
  _carouselBase = base;
  applyTitleLogo(base, shows, infos);

  log('carousel injected');
}

/* ========== 预加载优雅占位(替代硬编码 demo 无职转生) ========== */
// 真实片库未就绪时显示; 一旦 fetchShowsViaIPC 拉到数据, 上层 rebuild 机制会自动替换为真实轮播
function buildLoadingPlaceholder(target: HTMLElement): void {
  // shimmer 动画样式只注入一次
  if (!document.getElementById('fnos-ph-style')) {
    const st = document.createElement('style');
    st.id = 'fnos-ph-style';
    st.textContent = `
@keyframes fnos-ph-shimmer{0%{transform:translateX(-120%)}100%{transform:translateX(120%)}}
.fnos-ph-skel{position:relative;overflow:hidden;background:var(--fnos-skel-bg)}
.fnos-ph-skel::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,var(--fnos-skel-shine),transparent);transform:translateX(-120%);animation:fnos-ph-shimmer 1.5s infinite}
`;
    (document.head || document.documentElement).appendChild(st);
  }

  target.innerHTML = '';
  // [lc-444] 同上: 清掉section自身顶部边框/阴影/上边距, 避免细黑线
  target.style.borderTop = 'none';
  target.style.boxShadow = 'none';
  target.style.marginTop = '0';
  target.style.background = 'transparent';
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'padding:0 44px;margin-top:0;margin-bottom:-8px';
  _carouselWrapper = wrapper;

  const container = document.createElement('div');
  container.style.cssText = 'position:relative;overflow:hidden;width:100%;max-height:calc(100vh - 380px);aspect-ratio:16/9;border-radius:24px;background:var(--fnos-hero-container);backdrop-filter:blur(24px) saturate(140%);-webkit-backdrop-filter:blur(24px) saturate(140%);margin:0 auto;box-shadow:none;display:flex;align-items:center;justify-content:center;gap:30px';
  _carouselContainer = container;

  // 左侧: 海报骨架(粉紫流光)
  const poster = document.createElement('div');
  poster.className = 'fnos-ph-skel';
  poster.style.cssText = 'width:118px;height:168px;border-radius:14px';
  container.appendChild(poster);

  // 右侧: 文字骨架 + 提示
  const box = document.createElement('div');
  box.style.cssText = 'display:flex;flex-direction:column;gap:14px;max-width:300px';
  box.innerHTML = `
    <div class="fnos-ph-skel" style="width:200px;height:26px;border-radius:8px"></div>
    <div class="fnos-ph-skel" style="width:262px;height:14px;border-radius:6px"></div>
    <div class="fnos-ph-skel" style="width:230px;height:14px;border-radius:6px"></div>
    <div class="fnos-ph-tip" style="margin-top:8px;font-size:15px;color:rgba(70,55,95,.72);letter-spacing:1px">正在加载精彩内容…</div>
  `;
  container.appendChild(box);

  wrapper.appendChild(container);
  target.appendChild(wrapper);

  // 若真实片库始终未加载(如 NAS 未连接/接口超时), 一段时间后温和提示, 避免"正在加载"永久卡住
  const phTimer = window.setTimeout(() => {
    if (_apiShows.length === 0 && _carouselContainer === container && document.body.contains(container)) {
      const tip = container.querySelector('.fnos-ph-tip') as HTMLElement | null;
      if (tip) tip.textContent = '加载较慢，请确认 NAS 已连接';
    }
  }, 16000);
  // 占位被重建替换后, 该定时器留在原地无害(条件判断已失效)
  void phTimer;
}

/* 自动从API获取缺失的简介(IPC主进程签名→渲染进程fetch→带cookie鉴权) */
function autoFetchDescs(base: string, shows: any[], infos: HTMLElement[]): void {
  shows.forEach((show, i) => {
    if (show.desc) return;
    setTimeout(async () => {
      try {
        const { ipcRenderer } = require('electron');
        const path = `/v/api/v1/item/${show.id}`;
        // 主进程生成Authx签名(需要crypto)，渲染进程fetch(带cookie)
        const authx = await ipcRenderer.invoke('fnos-gen-authx', path);
        const resp = await fetch(`${base}${path}`, {
          credentials: 'include',
          headers: { 'Authx': authx }
        });
        const json = await resp.json();
        const desc = (json?.data?.overview || json?.data?.tv_overview || json?.data?.parent_overview || '').trim();
        log('desc API:', show.title, desc ? 'OK(' + desc.length + ')' : 'FAIL', 'code=' + json?.code);
        if (!desc) return;
        show.desc = desc;
        const info = infos[i];
        if (!info) return;
        const btn = info.querySelector('a');
        const descEl = info.querySelector('.fnos-desc') as HTMLElement | null;
        if (descEl) {
          descEl.textContent = desc;
        } else if (btn) {
          const d = document.createElement('div');
          d.className = 'fnos-desc';
          d.style.cssText = 'flex:1 1 auto;min-height:0;-webkit-line-clamp:4;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;font-size:14px;line-height:1.72;color:var(--fnos-hero-desc);letter-spacing:.35px;font-weight:500;text-indent:2em;mask-image:linear-gradient(180deg,rgba(0,0,0,1) 75%,rgba(0,0,0,0) 100%);-webkit-mask-image:linear-gradient(180deg,rgba(0,0,0,1) 75%,rgba(0,0,0,0) 100%)';
          d.textContent = desc;
          info.insertBefore(d, btn);
        }
      } catch (e) { log('desc error:', show.title, e); }
    }, i * 800);
  });
}

/* [lc-408] 把轮播右侧文字标题替换为透明 logo：
 * - API 真实条目：优先用 show.tmdbId 查 logo；无 tmdbId 时退用 show.title 标题匹配查 TMDB → tmdb:image 代理转 base64
 * - 硬编码兜底条目（show.logo 本地 sys/img）：经 fetchImageAuth 取本地 logo
 * 获取成功才在左侧海报左下角显示 logo；右侧文字标题始终保留不隐藏；任一环节失败则保留文字标题（静默降级）。 */
function applyTitleLogo(base: string, shows: any[], infos: HTMLElement[]): void {
  // [lc-409] 开关关闭时完全跳过（既不拉取也不替换），保留文字标题
  if (!_carouselLogoEnabled) return;
  shows.forEach((show, i) => {
    const info = infos[i];
    if (!info) return;
    if (show.tmdbId || show.title) {
      // API 真实条目 → TMDB 透明 logo（主进程已按「横屏」筛选并返回候选列表；此处再排除纯白 PNG）
      setTimeout(async () => {
        try {
          const { ipcRenderer } = require('electron');
          const logoArg: any = { mediaType: show.mediaType || 'tv' };
          if (show.tmdbId) logoArg.id = show.tmdbId; else logoArg.title = show.title;
          const r = await ipcRenderer.invoke('tmdb:logo', logoArg);
          if (!r || !r.ok) {
            log('tmdb logo none:', show.title, (r && r.error) || '无 logo');
            return;
          }
          // [lc-437] 优先用横屏候选列表逐个尝试；不再以「纯白」硬性排除（logo 已移至左侧深色海报，纯白可见）
          const paths = (r.logoPaths && r.logoPaths.length) ? r.logoPaths : (r.logoPath ? [r.logoPath] : []);
          let whiteFallback: string | null = null; // [lc-437] 纯白 logo 留作最后兜底
          for (const p of paths) {
            try {
              const url = 'https://image.tmdb.org/t/p/w500' + p;
              const img = await ipcRenderer.invoke('tmdb:image', url);
              if (!img || !img.ok || !img.dataUrl) continue;
              // [lc-437] 纯白检测不再立即跳过：先收藏为兜底，优先用非纯白
              if (await isPureWhitePng(img.dataUrl)) {
                if (!whiteFallback) whiteFallback = img.dataUrl;
                log('tmdb logo 纯白候选(留作兜底):', show.title, p);
                continue;
              }
              show.tmdbLogo = img.dataUrl;
              swapTitleToLogo(info, img.dataUrl);
              log('tmdb logo applied:', show.title);
              return;
            } catch (e) { log('tmdb logo candidate err:', show.title, e); }
          }
          // [lc-437] 兜底：无任何非纯白可用时，才选用纯白 logo
          if (whiteFallback) {
            show.tmdbLogo = whiteFallback;
            swapTitleToLogo(info, whiteFallback);
            log('tmdb logo applied(纯白兜底):', show.title);
            return;
          }
          log('tmdb logo 全部候选不可用:', show.title);
        } catch (e) { log('tmdb logo err:', show.title, e); }
      }, i * 600);
    } else if (show.logo) {
      // 硬编码兜底条目 → 本地 sys/img logo 替换标题
      setTimeout(async () => {
        try {
          const full = show.logo.startsWith('http') ? show.logo : `${base}/v/api/v1/${show.logo}`;
          const b = await fetchImageAuth(full);
          if (b) swapTitleToLogo(info, b);
        } catch (e) { log('local logo err:', show.title, e); }
      }, i * 600);
    }
  });
}

/* [lc-425] 详情页 Logo 回填飞牛元数据（真实写回）：取到 TMDB 透明 logo(zh→ja→en) 后，
 * 经飞牛「临时图床上传 + 保存详情」两个接口写回 item 的 logos 字段，实现本地持久化。
 * 安全策略：仅当该 item 当前「无 logo」时才回填，绝不覆盖飞牛自带/用户已设的 logo；
 * 写回采用「读 getEditDetail 全量 → 仅改 logos+logos_locked → 原样回写 saveEditDetail」，
 * 避免字段缺失被飞牛清空其他元数据。
 * 签名：fnOS 的 POST 必须按 {request.go/request.ts} 约定——把 nonce 写进 JSON body，且 Authx
 *   用「含 nonce 的 body」签名后再发同一个含 nonce 的 body（服务端按原始 body 字节验签，否则
 *   invalid sign）。端点形状 + 字段取自用户在运行 app 中实测抓包（2026-08-11）。 */
const _backfilledGuids = new Set<string>();

/** 生成 fnOS 防重放随机数（与 GenerateRandomDigits(100000,1000000) 同区间） */
function fnNonce(): string {
  return String(Math.floor(Math.random() * 900000) + 100000);
}

/** base64 dataURL → Blob（用于把 TMDB logo 作为二进制图上传到飞牛临时图床） */
function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(0, comma);
  const b64 = dataUrl.slice(comma + 1);
  const mime = /:(.*?);/.exec(meta)?.[1] || 'image/png';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

/** 读取 item 当前完整可编辑元数据（POST 带 nonce，按 fnOS 约定签名） */
async function fnosGetEditDetail(origin: string, guid: string): Promise<any | null> {
  try {
    const { ipcRenderer } = require('electron');
    const body = { item_guid: guid, nonce: fnNonce() };
    const authx = await ipcRenderer.invoke('fnos-gen-authx', '/v/api/v1/item/getEditDetail', body).catch(() => '');
    const resp = await fetch(`${origin}/v/api/v1/item/getEditDetail`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(authx ? { Authx: authx } : {}) },
      body: JSON.stringify(body),
    });
    if (!resp.ok) { log('[回填] getEditDetail HTTP', resp.status, guid); return null; }
    const j = await resp.json().catch(() => null);
    if (!j || j.code !== 0) { log('[回填] getEditDetail 业务失败', JSON.stringify(j).substring(0, 200)); return null; }
    return j.data || null;
  } catch (e) { log('[回填] getEditDetail 异常', String(e).substring(0, 120)); return null; }
}

/** 上传 logo 到飞牛临时图床，返回 hash_path（如 /f5/04/upload_logo_xxx.webp）或 null。
 *  签名 data 取非文件表单字段 {image_type, nonce}（与 fnOS 前端 multipart 约定一致）。 */
async function uploadLogoToFnos(origin: string, dataUrl: string): Promise<string | null> {
  try {
    const { ipcRenderer } = require('electron');
    const blob = dataUrlToBlob(dataUrl);
    const fd = new FormData();
    fd.append('file', blob, 'logo.png');
    fd.append('image_type', 'logo');
    const signData = { image_type: 'logo', nonce: fnNonce() };
    const authx = await ipcRenderer.invoke('fnos-gen-authx', '/v/api/v1/image/temp/upload', signData).catch(() => '');
    const resp = await fetch(`${origin}/v/api/v1/image/temp/upload`, {
      method: 'POST', credentials: 'include',
      headers: { ...(authx ? { Authx: authx } : {}) }, body: fd,
    });
    if (!resp.ok) { log('[回填] upload HTTP', resp.status); return null; }
    const j = await resp.json().catch(() => null);
    if (!j || j.code !== 0 || !j.data?.hash_path) {
      log('[回填] upload 业务失败', JSON.stringify(j).substring(0, 200)); return null;
    }
    return j.data.hash_path as string;
  } catch (e) { log('[回填] upload 异常', String(e).substring(0, 120)); return null; }
}

/** 把完整详情对象回写飞牛（仅改 logos + logos_locked，带 nonce 签名），成功返回 true */
async function saveEditDetail(origin: string, data: any, logoHashPath: string): Promise<boolean> {
  try {
    const { ipcRenderer } = require('electron');
    const body = { ...data, logos: logoHashPath, logos_locked: true, nonce: fnNonce() };
    const authx = await ipcRenderer.invoke('fnos-gen-authx', '/v/api/v1/item/saveEditDetail', body).catch(() => '');
    const resp = await fetch(`${origin}/v/api/v1/item/saveEditDetail`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(authx ? { Authx: authx } : {}) },
      body: JSON.stringify(body),
    });
    if (!resp.ok) { log('[回填] saveEditDetail HTTP', resp.status); return false; }
    const j = await resp.json().catch(() => null);
    if (!j || j.code !== 0) { log('[回填] saveEditDetail 业务失败', JSON.stringify(j).substring(0, 200)); return false; }
    return true;
  } catch (e) { log('[回填] saveEditDetail 异常', String(e).substring(0, 120)); return false; }
}

function backfillDetailLogo(): void {
  if (!_carouselLogoEnabled) return;            // 复用「轮播 Logo」开关
  if (!isDetailPage()) return;
  const m = location.href.match(/\/v\/(tv|movie)\/([a-f0-9]{32})/);
  if (!m) return;
  const guid = m[2];
  const mediaType = m[1] === 'tv' ? 'tv' : 'movie';
  if (_backfilledGuids.has(guid)) return;
  _backfilledGuids.add(guid);
  const origin = location.origin;
  setTimeout(async () => {
    try {
      const { ipcRenderer } = require('electron');
      // 1) 读取 item 当前完整可编辑元数据（与保存接口同构，避免字段缺失被清空）
      const data = await fnosGetEditDetail(origin, guid);
      if (!data) return;
      // 2) 已有 logo → 绝不覆盖（飞牛自带/用户已设）
      if (data.logos && String(data.logos).trim()) {
        log('[回填] 已有 logo, 跳过', guid, String(data.logos).substring(0, 80)); return;
      }
      // 3) 取 TMDB id（优先 trim_id；Bangumi 源 bg 前缀无 TMDB id，则用标题搜索兜底）
      const tmdbId = extractTmdbId(data);
      const title = (data.title || '').trim();
      if (!tmdbId && !title) { log('[回填] 无 tmdbId 且无标题, 跳过', guid); return; }
      const logoArg: any = { mediaType };
      if (tmdbId) logoArg.id = tmdbId; else logoArg.title = title;
      const r = await ipcRenderer.invoke('tmdb:logo', logoArg);
      if (!r || !r.ok) { log('[回填] TMDB 无 logo', tmdbId || title); return; }
      // 4) 逐个候选：下载 → 排除纯白 → 上传 → 保存，首个成功即止
      const paths = (r.logoPaths && r.logoPaths.length) ? r.logoPaths : (r.logoPath ? [r.logoPath] : []);
      for (const p of paths) {
        try {
          const url = 'https://image.tmdb.org/t/p/w500' + p;
          const img = await ipcRenderer.invoke('tmdb:image', url);
          if (!img || !img.ok || !img.dataUrl) continue;
          if (await isPureWhitePng(img.dataUrl)) { log('[回填] 纯白跳过', p); continue; }
          const hashPath = await uploadLogoToFnos(origin, img.dataUrl);
          if (!hashPath) { log('[回填] 上传失败', p); continue; }
          const saved = await saveEditDetail(origin, data, hashPath);
          if (saved) {
            log('[回填] ✅ 已写回 logo → guid=' + guid + ' path=' + hashPath);
            return;
          }
          log('[回填] 保存失败', p);
        } catch (e) { log('[回填] 候选失败', p, String(e).substring(0, 80)); }
      }
      log('[回填] 无可用 logo', guid);
    } catch (e) { log('[回填] err', String(e).substring(0, 120)); }
  }, 800);
}

/** [lc-436] 在左侧海报左下角显示 logo 图片；右侧文字标题保留不隐藏 */
function swapTitleToLogo(info: HTMLElement, src: string): void {
  const slide = info.closest('.fnos-slide') as HTMLElement | null;
  const logoEl = slide?.querySelector('.fnos-logo') as HTMLImageElement | null;
  if (!logoEl) return;
  logoEl.src = src;
  logoEl.style.display = 'block';
}

/** [lc-413] 判断 base64/blob PNG 是否为「纯白 logo」：可见(非透明)像素几乎全部接近纯白 → 视为纯白，
 *  在浅色面板上不可见，应跳过；完全透明(无可见内容)同样视为不可用。渲染端 canvas 像素分析。 */
function isPureWhitePng(dataUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) { resolve(true); return; } // 无尺寸 → 不可用（跳过）
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        if (!ctx) { resolve(false); return; } // 取不到上下文不误杀
        ctx.drawImage(img, 0, 0);
        const px = ctx.getImageData(0, 0, w, h).data;
        let visible = 0, white = 0;
        for (let i = 0; i < px.length; i += 4) {
          const a = px[i + 3];
          if (a < 16) continue; // 透明像素跳过
          visible++;
          if (px[i] >= 245 && px[i + 1] >= 245 && px[i + 2] >= 245) white++;
        }
        if (visible < 25) { resolve(true); return; } // 实质无可见内容 → 跳过
        resolve(white / visible >= 0.9); // 可见像素 90% 以上为白 → 判为纯白
      } catch (e) { resolve(false); } // 解析异常不误杀（保留原图）
    };
    img.onerror = () => resolve(false); // 加载失败不误杀
    img.src = dataUrl;
  });
}

/** 设置开关变更后即时作用于当前已渲染的轮播：开→拉取 logo 替换；关→还原文字标题 */
function applyCarouselLogoNow(): void {
  if (!_carouselInfos.length) return;
  if (_carouselLogoEnabled) {
    applyTitleLogo(_carouselBase, _carouselShows, _carouselInfos);
  } else {
    _carouselInfos.forEach((info) => {
      const slide = info.closest('.fnos-slide') as HTMLElement | null;
      const l = slide?.querySelector('.fnos-logo') as HTMLImageElement | null;
      if (l) { l.style.display = 'none'; l.src = ''; }
    });
  }
}

/* ========== 详情页苹果液态玻璃 (TV详情 / Season详情) ========== */
let _detailGlassInited = false;

/** 检测当前URL是否为需要液态玻璃的详情页 */
function isDetailPage(): boolean {
  return /\/v\/(tv|movie)\/[a-f0-9]{32}($|\/)/.test(location.href)
    || /\/v\/(tv|movie)\/season\/[a-f0-9]{32}/.test(location.href);
}

/** 对 TV/Movie 详情页 (/v/tv/:id, /v/movie/:id) 应用液态玻璃 — 通透轻量版 */
function applyTvDetailGlass(): void {
  const header = document.querySelector('.trim-mc__details--key-version') as HTMLElement | null;
  if (!header) return;
  log('applyTvDetailGlass: header found');

  // ₀ 原生导航栏沉浸: 全透明+无模糊, 不遮挡背景剧照
  //   选择器对应 mainwin.ts ⑦ 的 fnOS 原生导航栏(div.relative.z-20.flex...px-11.py-5)
  const nativeNav = document.querySelector('div.relative.z-20.flex.items-center.justify-between.px-11.py-5') as HTMLElement | null;
  if (nativeNav) {
    nativeNav.style.setProperty('background', 'transparent', 'important');
    nativeNav.style.setProperty('backdrop-filter', 'none', 'important');
    nativeNav.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
    nativeNav.style.setProperty('box-shadow', 'none', 'important');
    nativeNav.style.setProperty('border', 'none', 'important');
    log('detail -> native nav immersive (transparent)');
  }

  // ① 头部渐变遮罩: 极轻量 — 保持背景图清晰可见,仅底部做淡淡过渡
  const gradient = header.querySelector('.gradient') as HTMLElement | null;
  if (gradient) {
    // 关键改动: 从"厚重白雾"改为"几乎透明的微妙融合"
    // 上方完全透出原图,底部仅极淡淡的暗→亮过渡(用于文字可读性)
    gradient.style.setProperty('background',
      'var(--fnos-detail-grad)', 'important');
    gradient.style.setProperty('height', '100%', 'important');       // 恢复全高
    gradient.style.setProperty('backdrop-filter', 'blur(1px) saturate(105%)', 'important');
    gradient.style.setProperty('-webkit-backdrop-filter', 'blur(1px) saturate(105%)', 'important');
  }

  // ② 标题: 文字清晰可读 — 柔和投影确保在任何背景色上都能看清
  const h2 = header.querySelector('h2') as HTMLElement | null;
  if (h2) {
    h2.style.setProperty('text-shadow',
      '0 1px 3px rgba(0,0,0,.35),0 0 1px rgba(0,0,0,.2)', 'important');
    h2.style.setProperty('color', '#fff', 'important');
    h2.style.setProperty('font-weight', '700', 'important');
  }

  // ③ 简介/描述: 轻玻璃卡片 — 低不透明度+模糊=真·通透
  const descArea = findDescArea(header);
  if (descArea) {
    descArea.style.setProperty('background',
      'var(--fnos-detail-desc)', 'important');
    descArea.style.setProperty('backdrop-filter', 'blur(20px) saturate(140%) brightness(1.02)', 'important');
    descArea.style.setProperty('-webkit-backdrop-filter', 'blur(20px) saturate(140%) brightness(1.02)', 'important');
    descArea.style.setProperty('border-radius', '14px', 'important');
    descArea.style.setProperty('border', '1px solid var(--fnos-detail-desc-border)', 'important');
    descArea.style.setProperty('box-shadow',
      '0 4px 24px rgba(31,41,90,.04),inset 0 .5px 0 rgba(255,255,255,.4)',
      'important');
    descArea.style.setProperty('padding', '18px 24px', 'important');
    descArea.style.setProperty('margin-top', '8px', 'important');
  }

  // ④ 季/集卡片: 轻量液态玻璃（可由「关闭背景框」开关禁用，恢复 fnOS 原生外观）
  const cards = header.parentElement?.querySelectorAll('.card-root');
  cards?.forEach((card) => {
    const el = card as HTMLElement;
    if (_detailBoxless) {
      // 关闭背景框：移除全部注入的玻璃样式，回退到 fnOS 原生外观
      el.style.removeProperty('background');
      el.style.removeProperty('backdrop-filter');
      el.style.removeProperty('-webkit-backdrop-filter');
      el.style.removeProperty('border-radius');
      el.style.removeProperty('border');
      el.style.removeProperty('box-shadow');
      el.style.removeProperty('transition');
      el.style.removeProperty('transform');
      return;
    }
    el.style.setProperty('background',
      'var(--fnos-detail-card)', 'important');
    el.style.setProperty('backdrop-filter', 'blur(16px) saturate(135%)', 'important');
    el.style.setProperty('-webkit-backdrop-filter', 'blur(16px) saturate(135%)', 'important');
    el.style.setProperty('border-radius', '14px', 'important');
    el.style.setProperty('border', '1px solid var(--fnos-detail-card-border)', 'important');
    el.style.setProperty('box-shadow',
      'var(--fnos-detail-shadow-1)',
      'important');
    el.style.setProperty('transition', 'transform .25s ease, box-shadow .25s ease', 'important');

    el.addEventListener('mouseenter', () => {
      if (_detailBoxless) return; // 关闭背景框时悬停不再加玻璃阴影
      el.style.setProperty('transform', 'translateY(-3px) scale(1.015)', 'important');
      el.style.setProperty('box-shadow',
        '0 10px 32px rgba(91,140,255,.12),0 1px 0 rgba(255,255,255,.6)',
        'important');
    });
    el.addEventListener('mouseleave', () => {
      if (_detailBoxless) return;
      el.style.removeProperty('transform');
      el.style.setProperty('box-shadow',
        'var(--fnos-detail-shadow-1)',
        'important');
    });
  });

  // ⑤ 操作按钮行: 极简玻璃条
  const actionBar = header.parentElement?.querySelector('.flex.min-h-\\[54px\\]') as HTMLElement | null;
  if (actionBar && actionBar.parentElement) {
    const barWrap = actionBar.parentElement as HTMLElement;
    barWrap.style.setProperty('background',
      'var(--fnos-detail-bar)', 'important');
    barWrap.style.setProperty('backdrop-filter', 'blur(18px) saturate(135%)', 'important');
    barWrap.style.setProperty('-webkit-backdrop-filter', 'blur(18px) saturate(135%)', 'important');
    barWrap.style.setProperty('border-radius', '14px', 'important');
    barWrap.style.setProperty('border', '1px solid var(--fnos-detail-bar-border)', 'important');
    barWrap.style.setProperty('box-shadow',
      '0 3px 18px rgba(31,41,90,.04),inset 0 .5px 0 rgba(255,255,255,.4)',
      'important');
    barWrap.style.setProperty('padding', '12px 18px', 'important');
  }

  // ⑥ 原生播放按钮: 半透明白底(适配浅色/透明详情页背景, 保证可辨识度)
  const nativePlayBtns = header.parentElement?.querySelectorAll('button[class*="primary"], .semi-button--primary, [class*="btn-primary"], a[class*="play"]') ?? [];
  for (const btn of Array.from(nativePlayBtns)) {
    const el = btn as HTMLElement;
    if (el.classList.contains('fnos-play')) continue; // 跳过我们自己的按钮
    el.style.setProperty('background', 'rgba(255,255,255,.55)', 'important');
    el.style.setProperty('border', '1px solid rgba(255,255,255,.35)', 'important');
    el.style.setProperty('border-radius', '10px', 'important');
    el.style.setProperty('color', '#333', 'important');
    el.style.setProperty('box-shadow', '0 1px 6px rgba(0,0,0,.08)', 'important');
    el.style.setProperty('font-weight', '500', 'important');
    el.addEventListener('mouseenter', () => {
      if (!el.dataset.glassHover) { el.dataset.glassHover = '1';
        el.style.setProperty('background', 'rgba(255,255,255,.75)', 'important');
        el.style.setProperty('border-color', 'rgba(255,255,255,.5)', 'important');
        el.style.setProperty('box-shadow', '0 2px 10px rgba(0,0,0,.12)', 'important');
      }
    }, { once: false });
    el.addEventListener('mouseleave', () => {
      delete el.dataset.glassHover;
      el.style.setProperty('background', 'rgba(255,255,255,.55)', 'important');
      el.style.setProperty('border-color', 'rgba(255,255,255,.35)', 'important');
      el.style.setProperty('box-shadow', '0 1px 6px rgba(0,0,0,.08)', 'important');
    }, { once: false });
  }
}

/** 查找简介区域的辅助函数 */
function findDescArea(header: HTMLElement): HTMLElement | null {
  let desc = document.querySelector('.text-justify.text-\\[15px\\]') as HTMLElement | null;
  if (desc) return desc;
  desc = header.parentElement?.querySelector('.px-\\[44px\\]') as HTMLElement | null;
  if (desc) return desc;
  const allDivs = header.parentElement?.querySelectorAll('div');
  if (allDivs) {
    for (const d of Array.from(allDivs)) {
      if ((d.textContent || '').length > 80 && d.children.length < 4 && !d.querySelector('img')) {
        return d as HTMLElement;
      }
    }
  }
  return null;
}

/** 对 Season 详情页 (/v/tv/season/:id) 应用液态玻璃 */
function applySeasonDetailGlass(): void {
  // ₀ 原生导航栏沉浸: 全透明+无模糊, 不遮挡背景剧照
  const seasonNav = document.querySelector('div.relative.z-20.flex.items-center.justify-between.px-11.py-5') as HTMLElement | null;
  if (seasonNav) {
    seasonNav.style.setProperty('background', 'transparent', 'important');
    seasonNav.style.setProperty('backdrop-filter', 'none', 'important');
    seasonNav.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
    seasonNav.style.setProperty('box-shadow', 'none', 'important');
    seasonNav.style.setProperty('border', 'none', 'important');
  }

  // ① 头部信息区 (470px高, 含模糊背景+海报+标题)
  const header = document.querySelector('.semi-always-dark.relative.box-border.flex.h-\\[470px\\]') as HTMLElement | null;
  if (!header) {
    // fallback: 用高度和模糊背景图来定位
    const headers = document.querySelectorAll('.semi-always-dark');
    for (const h of Array.from(headers)) {
      const el = h as HTMLElement;
      if (el.offsetHeight > 350 && el.querySelector('img[alt][style*="blur"]')) {
        return applySeasonGlassToHeader(el);
      }
    }
    return;
  }
  applySeasonGlassToHeader(header);
}

function applySeasonGlassToHeader(header: HTMLElement): void {
  log('applySeasonDetailGlass: header found, height=', header.offsetHeight);

  // 背景模糊图增强: 更柔和的液态感
  const blurImg = header.querySelector('img[style*="blur"]') as HTMLImageElement | null;
  if (blurImg) {
    blurImg.style.setProperty('filter', 'blur(18px) saturate(120%) brightness(.85)', 'important');
    blurImg.style.setProperty('transform', 'scale(1.08)', 'important');
  }

  // 海报卡片: 液态玻璃立体效果
  const poster = header.querySelector('.rounded-xl.overflow-hidden, .overflow-hidden.rounded-xl') as HTMLElement | null;
  if (poster) {
    poster.style.setProperty('border-radius', '18px', 'important');
    poster.style.setProperty('box-shadow',
      '0 10px 40px rgba(0,0,0,.25),0 0 0 1px rgba(255,255,255,.2),inset 0 0 0 1px rgba(255,255,255,.1)',
      'important');
    poster.style.setProperty('transition', 'transform .35s cubic-bezier(.16,1,.3,1), box-shadow .35s ease', 'important');
    poster.addEventListener('mouseenter', () => {
      poster.style.setProperty('transform', 'translateY(-6px) scale(1.03)', 'important');
      poster.style.setProperty('box-shadow',
        '0 20px 56px rgba(0,0,0,.32),0 0 0 1px rgba(255,255,255,.3),inset 0 0 0 1px rgba(255,255,255,.15)',
        'important');
    });
    poster.addEventListener('mouseleave', () => {
      poster.style.removeProperty('transform');
      poster.style.setProperty('box-shadow',
        '0 10px 40px rgba(0,0,0,.25),0 0 0 1px rgba(255,255,255,.2),inset 0 0 0 1px rgba(255,255,255,.1)',
        'important');
    });
  }

  // 底部渐变: 液态玻璃融合
  const gradientFull = header.querySelector('.gradient-for-full') as HTMLElement | null;
  if (gradientFull) {
    gradientFull.style.setProperty('background',
      'var(--fnos-detail-season-grad)', 'important');
    gradientFull.style.setProperty('backdrop-filter', 'blur(36px) saturate(170%) brightness(1.04)', 'important');
    gradientFull.style.setProperty('-webkit-backdrop-filter', 'blur(36px) saturate(170%) brightness(1.04)', 'important');
  }

  // 标题文字发光
  const h2 = header.querySelector('h2') as HTMLElement | null;
  if (h2) {
    h2.style.setProperty('text-shadow',
      '0 2px 24px rgba(255,255,255,.35),0 0 48px rgba(91,140,255,.18)', 'important');
  }

  // ② 选集区标题栏: 玻璃标签（可由「关闭背景框」开关禁用，恢复 fnOS 原生外观）
  const sections = document.querySelectorAll('strong');
  sections.forEach(s => {
    if (s.textContent === '选集' || s.textContent === '演职人员') {
      const wrap = s.parentElement;
      if (wrap) {
        const w = wrap as HTMLElement;
        if (_detailBoxless) {
          // 关闭背景框：移除注入的玻璃标签样式，回退到 fnOS 原生标题栏
          w.style.removeProperty('background');
          w.style.removeProperty('backdrop-filter');
          w.style.removeProperty('-webkit-backdrop-filter');
          w.style.removeProperty('border-radius');
          w.style.removeProperty('border');
          w.style.removeProperty('box-shadow');
          w.style.removeProperty('padding');
        } else {
          w.style.setProperty('background',
            'var(--fnos-detail-season-sec)', 'important');
          w.style.setProperty('backdrop-filter', 'blur(8px) saturate(120%)', 'important');
          w.style.setProperty('-webkit-backdrop-filter', 'blur(8px) saturate(120%)', 'important');
          w.style.setProperty('border-radius', '10px', 'important');
          w.style.setProperty('border', '1px solid var(--fnos-detail-season-sec-border)', 'important');
          w.style.setProperty('box-shadow',
            'none',
            'important');
          w.style.setProperty('padding', '6px 16px', 'important');
        }
      }
    }
  });

  // ③ 集数卡片网格: 液态玻璃卡片（可由「关闭背景框」开关禁用，恢复 fnOS 原生外观）
  const episodeCards = document.querySelectorAll('[data-id="details"]');
  episodeCards.forEach((card) => {
    const el = card as HTMLElement;
    if (_detailBoxless) {
      // 关闭背景框：移除注入的玻璃卡片样式，回退到 fnOS 原生卡片
      el.style.removeProperty('background');
      el.style.removeProperty('backdrop-filter');
      el.style.removeProperty('-webkit-backdrop-filter');
      el.style.removeProperty('border-radius');
      el.style.removeProperty('border');
      el.style.removeProperty('box-shadow');
      el.style.removeProperty('transition');
      el.style.removeProperty('transform');
      return;
    }
    el.style.setProperty('background',
      'var(--fnos-detail-ep)', 'important');
    el.style.setProperty('backdrop-filter', 'blur(22px) saturate(145%)', 'important');
    el.style.setProperty('-webkit-backdrop-filter', 'blur(22px) saturate(145%)', 'important');
    el.style.setProperty('border-radius', '16px', 'important');
    el.style.setProperty('border', '1px solid var(--fnos-detail-ep-border)', 'important');
    el.style.setProperty('box-shadow',
      'var(--fnos-detail-shadow-2)',
      'important');
    el.style.setProperty('transition', 'transform .28s ease, box-shadow .28s ease', 'important');

    el.addEventListener('mouseenter', () => {
      if (_detailBoxless) return; // 关闭背景框时悬停不再加玻璃阴影
      el.style.setProperty('transform', 'translateY(-5px) scale(1.025)', 'important');
      el.style.setProperty('box-shadow',
        'var(--fnos-detail-shadow-3)',
        'important');
    });
    el.addEventListener('mouseleave', () => {
      if (_detailBoxless) return;
      el.style.removeProperty('transform');
      el.style.setProperty('box-shadow',
        'var(--fnos-detail-shadow-2)',
        'important');
    });
  });

  // ④ 整体内容滚动区背景: 极淡雾面
  const scrollArea = document.querySelector('.trim-ui__scrollbar--list-specific') as HTMLElement | null;
  if (scrollArea) {
    scrollArea.style.setProperty('background',
      'var(--fnos-detail-scroll)', 'important');
  }

  // ⑤ 原生播放按钮: 半透明白底(适配浅色/透明详情页背景, 保证可辨识度)
  const seasonPlayBtns = document.querySelectorAll('button[class*="primary"], .semi-button--primary, [class*="btn-primary"], a[class*="play"]');
  for (const btn of Array.from(seasonPlayBtns)) {
    const el = btn as HTMLElement;
    if (el.classList.contains('fnos-play')) continue;
    el.style.setProperty('background', 'rgba(255,255,255,.55)', 'important');
    el.style.setProperty('border', '1px solid rgba(255,255,255,.35)', 'important');
    el.style.setProperty('border-radius', '10px', 'important');
    el.style.setProperty('color', '#333', 'important');
    el.style.setProperty('box-shadow', '0 1px 6px rgba(0,0,0,.08)', 'important');
    el.style.setProperty('font-weight', '500', 'important');
    el.addEventListener('mouseenter', () => {
      if (!el.dataset.glassHover) { el.dataset.glassHover = '1';
        el.style.setProperty('background', 'rgba(255,255,255,.75)', 'important');
        el.style.setProperty('border-color', 'rgba(255,255,255,.5)', 'important');
        el.style.setProperty('box-shadow', '0 2px 10px rgba(0,0,0,.12)', 'important');
      }
    }, { once: false });
    el.addEventListener('mouseleave', () => {
      delete el.dataset.glassHover;
      el.style.setProperty('background', 'rgba(255,255,255,.55)', 'important');
      el.style.setProperty('border-color', 'rgba(255,255,255,.35)', 'important');
      el.style.setProperty('box-shadow', '0 1px 6px rgba(0,0,0,.08)', 'important');
    }, { once: false });
  }

  // ⑥ 补齐缺失的集简介（真实数据来源：Bangumi 每集 desc）
  //    飞牛 /episode/list 仅第1集返回 overview（复制自父级简介），第2集起 overview 为空 → 卡片只剩时长。
  //    飞牛单集详情接口 item/{guid} 也无简介数据（已验证）。
  //    改用 Bangumi /v0/episodes 的 desc 字段（每集剧情简介，日文原文，丰富且准确），
  //    通过主进程 bangumiSync.fetchEpisodeDescs 获取，本地 JSON 缓存持久化（重启不丢、不重复请求）。
  fillEpisodeDescsFromBangumi();
}

/** 同 season 只触发一次取数，避免重复网络请求 */
const _epDescDone = new Set<string>();

/**
 * ⑥ 选集卡片缺失简介补齐（Bangumi 真实每集 desc，不伪造）。
 * 数据流：页面番名 → IPC 'bangumi:episode-descs' → 主进程搜 Bangumi subject → 取 episodes desc → 本地缓存 → 回填卡片。
 * 首次网络取后缓存到 userData/bangumi_ep_descs.json（持久化），后续同番直接读缓存。
 */
function fillEpisodeDescsFromBangumi(): void {
  const m = location.href.match(/\/season\/([a-f0-9]{32})/) || location.href.match(/\/tv\/([a-f0-9]{32})/);
  const parentGuid = m && m[1];
  if (!parentGuid) return;
  if (_epDescDone.has(parentGuid)) return;

  const cards = Array.from(document.querySelectorAll('[data-id="details"]')) as HTMLElement[];
  if (cards.length <= 1) return; // 单集/骨架态无需补齐
  _epDescDone.add(parentGuid);

  // 从页面头部提取番剧标题（用于 Bangumi 搜索匹配）
  const pageTitle = (() => {
    // 尝试从 h1 / 标题区提取
    const h1 = document.querySelector('h1, [class*="title"], [class*="header"]');
    if (h1) {
      const t = h1.textContent?.trim() || '';
      // 去掉可能的季数后缀用于搜索（如 "第三季" → 更好匹配 Bangumi 条目）
      return t.replace(/\s*(第?[一二三四五六七八九十\d]+季|Season\s*\d+|S\d+)\s*$/i, '').trim();
    }
    // fallback: 从 <title> 提取
    return (document.title || '').split('-')[0]?.trim() || '';
  })();

  if (!pageTitle) return;

  // 解析卡片标题里的集数（第N集 / ENN / SxxENN / 第N话 / EP.N）
  const parseEp = (text: string): number | null => {
    if (!text) return null;
    let mm = text.match(/第\s*(\d+)\s*[集话話]/);
    if (mm) return parseInt(mm[1], 10);
    mm = text.match(/S\d+E(\d+)/i);
    if (mm) return parseInt(mm[1], 10);
    mm = text.match(/\bE(\d{1,3})\b/i);
    if (mm) return parseInt(mm[1], 10);
    mm = text.match(/EP?\.?\s*(\d{1,3})/i);
    if (mm) return parseInt(mm[1], 10);
    return null;
  };

  // 取卡片内最长的简介文本（排除"第N集"标题与"XX分钟XX秒"时长）
  const walkText = (el: HTMLElement): string => {
    let longest = '';
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = child.textContent?.trim() || '';
        if (t.length > longest.length && t.length > 20 && !/^\d+分钟\d+秒$/.test(t) && !/^第\d+集$/.test(t)) {
          longest = t;
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const sub = walkText(child as HTMLElement);
        if (sub.length > longest.length) longest = sub;
      }
    }
    return longest;
  };

  (async () => {
    try {
      const { ipcRenderer } = require('electron');
      // 调主进程 Bangumi 每集简介接口（带缓存，首次网络取后持久化）
      const result: any = await ipcRenderer.invoke('bangumi:episode-descs', pageTitle, cards.length);
      if (!result || !result.eps || result.eps.length === 0) return;

      const descByEp = new Map<number, string>();
      for (const e of result.eps) {
        if (e.desc) descByEp.set(e.ep, e.desc);
      }
      if (descByEp.size === 0) return; // Bangumi 无该番简介数据

      // 按集数回填到对应缺简介的卡片
      const descStyle = 'font-size:13px;line-height:1.7;color:var(--fnos-text-secondary,#9aa0a6);display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;margin-top:4px;letter-spacing:.25px';
      let filled = 0;
      for (const card of cards) {
        const ep = parseEp(card.textContent || '');
        if (ep == null) continue;
        const desc = descByEp.get(ep);
        if (!desc) continue;
        if (walkText(card).length > 20) continue; // 已有简介
        if (card.querySelector('.fnos-ep-desc-filled')) continue; // 已填过
        const descEl = document.createElement('div');
        descEl.className = 'fnos-ep-desc-filled';
        descEl.style.cssText = descStyle;
        descEl.textContent = desc;
        card.appendChild(descEl);
        filled++;
      }
      if (filled) log('fillEpisodeDescsFromBangumi: 回填 Bangumi 简介', filled, '张卡片 (subject', result.subjectId, ')');
    } catch (e) {
      log('fillEpisodeDescsFromBangumi error', e);
    }
  })();
}

/** 统一入口: 检测URL→分发到对应页面的液态玻璃函数 */
function applyDetailLiquidGlass(): void {
  if (_detailGlassInited && !location.href.includes('/season/')) {
    // TV详情页只做一次; season可能独立导航需重试
    const recheck = document.querySelector('.trim-mc__details--key-version')
      || document.querySelector('.gradient-for-full');
    if (!recheck) return;
  }

  if (/\/v\/(tv|movie)\/season\//.test(location.href)) {
    applySeasonDetailGlass();
  } else if (/\/v\/(tv|movie)\/[a-f0-9]{32}($|\?|#)/.test(location.href)) {
    applyTvDetailGlass();
  }
  _detailGlassInited = true;
  log('detail liquid glass applied for', location.href.substring(location.href.lastIndexOf('/v/')));
}

/** [v400] UI 主题: 浅色 / 深色 / 跟随系统 三态, 持久化到 localStorage, 并同步飞牛原生主题.
 *  用 CSS 变量(--fnos-ui-*) 驱动所有自建设备 UI, html.dark 类切换即整体换肤(含已打开面板实时生效). */
type UiThemeMode = 'light' | 'dark' | 'system';
const UI_THEME_KEY = 'fnos-ui-theme';
let _refreshThemeSeg: (() => void) | null = null; // 设置面板内分段控件的刷新回调

function getUiTheme(): UiThemeMode {
  try {
    const v = localStorage.getItem(UI_THEME_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v as UiThemeMode;
  } catch (e) { /* ignore */ }
  return 'light'; // 默认浅色
}

/** 系统是否偏好深色(跟随系统时用) */
function systemPrefersDark(): boolean {
  try {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  } catch (e) { return false; }
}

/** 解析为实际明暗(跟随系统 → 读系统偏好) */
function getEffectiveDark(): boolean {
  const m = getUiTheme();
  if (m === 'system') return systemPrefersDark();
  return m === 'dark';
}

/** 把目标主题应用到页面, 并同步飞牛原生网页主题(html class / body theme-mode / 飞牛偏好键) */
function applyThemeToFnos(isDark: boolean): void {
  const html = document.documentElement;
  html.classList.toggle('dark', isDark);
  html.classList.toggle('light', !isDark);
  html.style.colorScheme = isDark ? 'dark' : 'light';
  const body = document.body;
  if (body) body.setAttribute('theme-mode', isDark ? 'dark' : 'light');
  // 同步飞牛原生偏好键: 飞牛(React)读取后会渲染对应主题; 不读我们的键, 互不干扰
  try {
    localStorage.setItem('fnos-theme-mode', isDark ? 'dark' : 'light');
    localStorage.setItem('os-theme-mode', isDark ? 'dark' : 'light');
    localStorage.setItem('mc-theme', isDark ? 'dark' : 'light');
  } catch (e) { /* ignore */ }
}

/** 应用当前 UI 主题偏好(含已打开面板分段控件刷新) */
function applyUiTheme(): void {
  applyThemeToFnos(getEffectiveDark());
  if (_refreshThemeSeg) { try { _refreshThemeSeg(); } catch (e) {} }
}

/** 设置并持久化 UI 主题(供开关/分段控件调用) */
function setUiTheme(mode: UiThemeMode): void {
  try { localStorage.setItem(UI_THEME_KEY, mode); } catch (e) {}
  applyThemeToFnos(getEffectiveDark());
}

/** [v400] 注入自建设备 UI 的主题变量(浅色为 :root 默认, 深色由 html.dark 覆盖).
 *  所有面板/弹窗/hover 均引用这些变量 → 切换 html.dark 即整体换肤, 已打开的面板也实时生效. */
function injectUiThemeStyle(): void {
  if (document.getElementById('fnos-ui-theme-style')) return;
  const s = document.createElement('style');
  s.id = 'fnos-ui-theme-style';
  s.textContent = `
:root{
  --fnos-ui-panel-bg:linear-gradient(165deg,rgba(252,247,253,.94),rgba(244,238,251,.96));
  --fnos-ui-text:#4a3d63;
  --fnos-ui-sec:#9575cd;
  --fnos-ui-muted:#6a5a88;
  --fnos-ui-muted2:#8778a5;
  --fnos-ui-btn-text:#5c4d7d;
  --fnos-ui-btn-text2:#7a6a9a;
  --fnos-ui-border:rgba(150,120,200,.14);
  --fnos-ui-border2:rgba(150,120,200,.12);
  --fnos-ui-border3:rgba(150,120,200,.16);
  --fnos-ui-border-strong:rgba(150,120,200,.22);
  --fnos-ui-border-outer:rgba(180,155,220,.35);
  --fnos-ui-btn-bg:rgba(150,120,200,.12);
  --fnos-ui-btn-bg2:rgba(150,120,200,.10);
  --fnos-ui-btn-hover:rgba(183,155,232,.32);
  --fnos-ui-btn-hover2:rgba(183,155,232,.28);
  --fnos-ui-row-hover:rgba(150,120,200,.08);
  --fnos-ui-input-bg:rgba(255,255,255,.5);
  --fnos-ui-accent:#b79be8;
  --fnos-ui-warn:#b06a3a;
  --fnos-ui-ok:#3a8c5a;
  --fnos-ui-pill-bg:rgba(125,95,201,.12);
  --fnos-ui-pill-border:rgba(125,95,201,.3);
  --fnos-ui-pill-hover:rgba(125,95,201,.9);
  --fnos-ui-pill-text:#7d5fc9;
  --fnos-ui-exit-on:rgba(147,117,205,.92);
  --fnos-ui-exit-off:rgba(255,255,255,.55);
  --fnos-hero-container:rgba(245,238,250,.5);
  --fnos-hero-panel:linear-gradient(160deg,rgba(248,240,250,.80),rgba(238,228,246,.86));
  --fnos-hero-dots:rgba(250,244,252,.65);
  --fnos-hero-edge:linear-gradient(90deg,transparent 66%,rgba(243,235,250,.85) 100%);
  --fnos-hero-dot:rgba(0,0,0,.16);
  --fnos-hero-title:#0f1c3f;
  --fnos-hero-desc:rgba(20,35,70,.82);
  --fnos-hero-shadow:0 1px 10px rgba(255,255,255,.5);
  --fnos-hero-divider:linear-gradient(90deg,transparent,rgba(91,140,255,.55),transparent);
  /* 轮播「开始观看」按钮(主题自适应, 高对比) */
  --fnos-hero-play-bg:rgba(108,76,178,.94);
  --fnos-hero-play-text:#ffffff;
  --fnos-hero-play-border:rgba(108,76,178,.9);
  --fnos-hero-play-hover:rgba(124,90,205,1);
  --fnos-ui-veil:linear-gradient(180deg,rgba(245,240,248,.6) 0%,rgba(238,233,246,.55) 100%);
  --fnos-detail-grad:linear-gradient(180deg,transparent 45%,rgba(12,18,35,.08) 72%,rgba(230,240,255,.22) 100%);
  --fnos-detail-desc:linear-gradient(135deg,rgba(255,255,255,.20),rgba(240,248,255,.25));
  --fnos-detail-desc-border:rgba(255,255,255,.30);
  --fnos-detail-card:linear-gradient(145deg,rgba(255,255,255,.18),rgba(232,244,255,.25));
  --fnos-detail-card-border:rgba(255,255,255,.28);
  --fnos-detail-bar:linear-gradient(180deg,rgba(255,255,255,.15),rgba(240,248,255,.20));
  --fnos-detail-bar-border:rgba(255,255,255,.25);
  --fnos-detail-season-grad:linear-gradient(180deg,transparent 30%,rgba(15,22,40,.18) 58%,rgba(235,243,255,.78) 100%);
  --fnos-detail-season-sec:linear-gradient(135deg,rgba(255,255,255,.55),rgba(240,246,255,.6));
  --fnos-detail-season-sec-border:rgba(255,255,255,.5);
  --fnos-detail-ep:linear-gradient(148deg,rgba(255,255,255,.48),rgba(232,242,255,.58));
  --fnos-detail-ep-border:rgba(255,255,255,.48);
  --fnos-detail-scroll:linear-gradient(180deg,rgba(238,244,255,.3),rgba(248,250,255.35));
  --fnos-sidebar-bg:linear-gradient(160deg,rgba(250,244,250,.60),rgba(243,238,247,.64));
  --fnos-sidebar-border:1px solid rgba(255,255,255,.5);
  --fnos-sidebar-shadow:inset 1px 0 0 rgba(255,255,255,.5),-8px 0 32px rgba(140,130,160,.08);
  --fnos-hero-panel-border:1px solid rgba(255,255,255,.5);
  --fnos-detail-shadow-1:0 3px 16px rgba(31,41,90,.04),0 1px 0 rgba(255,255,255,.5);
  --fnos-detail-shadow-2:0 4px 20px rgba(31,41,90,.06),0 1px 0 rgba(255,255,255,.7),inset 0 1px 0 rgba(255,255,255,.5);
  --fnos-detail-shadow-3:0 14px 40px rgba(91,140,255,.14),0 1px 0 rgba(255,255,255,.7),inset 0 1px 0 rgba(255,255,255,.5);
  --fnos-exit-border-on:1px solid rgba(147,117,205,.6);
  --fnos-exit-border-off:1px solid rgba(150,120,200,.18);
  --fnos-skel-bg:rgba(255,255,255,.45);
  --fnos-skel-shine:rgba(255,255,255,.8);
  --fnos-sidebar-btn-bg:rgba(70,52,100,.24);
  --fnos-qr-bg:#fff;
  --fnos-modal-overlay:rgba(40,30,60,.42);
  --fnos-modal-inner-shadow:inset 0 1px 0 rgba(255,255,255,.6);
  --fnos-titlebar-bg:transparent;
  --fnos-titlebar-icon:#444;
  --fnos-titlebar-hover-minmax:rgba(0,0,0,.05);
  --fnos-titlebar-hover-close-bg:rgba(232,17,35,.10);
  --fnos-titlebar-hover-close-icon:#e81123;
}
html.dark{
  --fnos-ui-panel-bg:linear-gradient(165deg,rgba(36,30,52,.94),rgba(28,22,42,.96));
  --fnos-ui-text:#e7def8;
  --fnos-ui-sec:#b9a4ec;
  --fnos-ui-muted:#b3a6d0;
  --fnos-ui-muted2:#9d90bf;
  --fnos-ui-btn-text:#d2c5ee;
  --fnos-ui-btn-text2:#c4b6e3;
  --fnos-ui-border:rgba(170,150,210,.18);
  --fnos-ui-border2:rgba(170,150,210,.14);
  --fnos-ui-border3:rgba(170,150,210,.20);
  --fnos-ui-border-strong:rgba(170,150,210,.28);
  --fnos-ui-border-outer:rgba(170,150,210,.42);
  --fnos-ui-btn-bg:rgba(150,120,200,.18);
  --fnos-ui-btn-bg2:rgba(150,120,200,.15);
  --fnos-ui-btn-hover:rgba(183,155,232,.42);
  --fnos-ui-btn-hover2:rgba(183,155,232,.36);
  --fnos-ui-row-hover:rgba(150,120,200,.14);
  --fnos-ui-input-bg:rgba(64,52,90,.30);
  --fnos-ui-accent:#c9b2f0;
  --fnos-ui-warn:#e3a06a;
  --fnos-ui-ok:#6fcf8e;
  --fnos-ui-pill-bg:rgba(150,120,200,.22);
  --fnos-ui-pill-border:rgba(170,150,210,.34);
  --fnos-ui-pill-hover:rgba(160,130,220,.95);
  --fnos-ui-pill-text:#cbb8ef;
  --fnos-ui-exit-on:rgba(160,130,220,.95);
  --fnos-ui-exit-off:rgba(70,58,98,.30);
  --fnos-hero-container:rgba(40,32,58,.55);
  --fnos-hero-panel:linear-gradient(160deg,rgba(40,32,58,.82),rgba(30,24,46,.88));
  --fnos-hero-dots:rgba(60,50,84,.72);
  --fnos-hero-edge:linear-gradient(90deg,transparent 66%,rgba(60,50,84,.92) 100%);
  --fnos-hero-dot:rgba(200,195,215,.35);
  --fnos-hero-title:#f0ecff;
  --fnos-hero-desc:rgba(225,218,245,.88);
  --fnos-hero-shadow:0 1px 10px rgba(0,0,0,.5);
  --fnos-hero-divider:linear-gradient(90deg,transparent,rgba(140,160,255,.6),transparent);
  /* 轮播「开始观看」按钮(主题自适应, 高对比) */
  --fnos-hero-play-bg:rgba(124,93,255,.95);
  --fnos-hero-play-text:#ffffff;
  --fnos-hero-play-border:rgba(150,120,255,.7);
  --fnos-hero-play-hover:rgba(140,110,255,1);
  --fnos-ui-veil:linear-gradient(180deg,rgba(30,24,46,.6) 0%,rgba(24,18,38,.55) 100%);
  --fnos-detail-grad:linear-gradient(180deg,transparent 45%,rgba(0,0,0,.30) 72%,rgba(18,14,30,.58) 100%);
  --fnos-detail-desc:linear-gradient(135deg,rgba(50,40,72,.45),rgba(34,27,52,.55));
  --fnos-detail-desc-border:rgba(255,255,255,.12);
  --fnos-detail-card:linear-gradient(145deg,rgba(54,44,76,.42),rgba(38,30,56,.52));
  --fnos-detail-card-border:rgba(255,255,255,.10);
  --fnos-detail-bar:linear-gradient(180deg,rgba(48,38,68,.20),rgba(33,26,50,.26));
  --fnos-detail-bar-border:rgba(255,255,255,.10);
  --fnos-detail-season-grad:linear-gradient(180deg,transparent 30%,rgba(0,0,0,.40) 58%,rgba(18,14,30,.72) 100%);
  --fnos-detail-season-sec:linear-gradient(135deg,rgba(60,50,84,.18),rgba(45,36,64,.22));
  --fnos-detail-season-sec-border:rgba(255,255,255,.12);
  --fnos-detail-ep:linear-gradient(148deg,rgba(58,48,82,.40),rgba(40,32,58,.50));
  --fnos-detail-ep-border:rgba(255,255,255,.12);
  --fnos-detail-scroll:linear-gradient(180deg,rgba(20,16,34,.45),rgba(24,18,38,.50));
  --fnos-sidebar-bg:linear-gradient(160deg,rgba(40,32,58,.82),rgba(30,24,46,.88));
  --fnos-sidebar-border:1px solid rgba(255,255,255,.08);
  --fnos-sidebar-shadow:inset 1px 0 0 rgba(255,255,255,.06),-8px 0 32px rgba(0,0,0,.30);
  --fnos-hero-panel-border:1px solid rgba(255,255,255,.10);
  --fnos-detail-shadow-1:0 3px 16px rgba(0,0,0,.25),0 1px 0 rgba(255,255,255,.06);
  --fnos-detail-shadow-2:0 4px 20px rgba(0,0,0,.30),0 1px 0 rgba(255,255,255,.10),inset 0 1px 0 rgba(255,255,255,.06);
  --fnos-detail-shadow-3:0 14px 40px rgba(91,140,255,.18),0 1px 0 rgba(255,255,255,.10),inset 0 1px 0 rgba(255,255,255,.06);
  --fnos-exit-border-on:1px solid rgba(170,150,210,.6);
  --fnos-exit-border-off:1px solid rgba(170,150,210,.18);
  --fnos-skel-bg:rgba(150,140,170,.18);
  --fnos-skel-shine:rgba(200,190,220,.18);
  --fnos-sidebar-btn-bg:rgba(40,30,60,.38);
  --fnos-qr-bg:rgba(220,215,230,.95);
  --fnos-modal-overlay:rgba(0,0,0,.60);
  --fnos-modal-inner-shadow:inset 0 1px 0 rgba(255,255,255,.10);
  --fnos-titlebar-bg:transparent;
  --fnos-titlebar-icon:#c4b6e3;
  --fnos-titlebar-hover-minmax:rgba(255,255,255,.08);
  --fnos-titlebar-hover-close-bg:rgba(232,17,35,.18);
  --fnos-titlebar-hover-close-icon:#ff4d5a;
}`;
  (document.head || document.documentElement).appendChild(s);
}

/** [v358] 删除设置页"主题模式"区块(含 跟随系统/浅色/深色 三个 radio 卡片), 防止切回深色 */
function removeThemeModeSetting(): void {
  // 仅在外观点设置页生效(其它页面无此 DOM, 安全跳过); 用文字精确匹配避免误删"卡片样式"等区块
  const candidates = document.querySelectorAll('strong, p');
  const title = Array.from(candidates).find(el => (el.textContent || '').trim() === '主题模式');
  if (!title) return;
  // 向上找区块容器: div.flex.w-full.flex-col.gap-4 (同时包含标题 <p><strong> 与 <ul> 卡片列表)
  let block: HTMLElement | null = title as HTMLElement;
  while (block && block.parentElement) {
    if (block.classList?.contains('flex') && block.classList.contains('flex-col') && block.classList.contains('gap-4')) {
      block.style.setProperty('display', 'none', 'important');
      return;
    }
    block = block.parentElement as HTMLElement;
  }
}

/* ========== 入口 ========== */
/** [lc-371] 飞牛原生 NAS 系统页下的浮动"返回影视"按钮: 点击切回 TV 模式(/v)。
 *  原生页不注入 Fntv-Plus 侧栏, 故用此浮动按钮提供返回入口, 避免进入原生页后无路可退。 */
function injectNativeReturnButton(): void {
  if (document.getElementById('fnos-native-return')) return;
  const btn = document.createElement('button');
  btn.id = 'fnos-native-return';
  btn.type = 'button';
  btn.textContent = '↩ 返回影视';
  btn.setAttribute('data-fnos-ui', '1');
  // 纯色背景(无 backdrop-filter): 避开 transparent 窗口 GPU 负担历史坑(lc-366/lc-369)
  // [lc-377] 远离窗口 16px 圆角/边缘裁切区: bottom 30px + left 20px 确保完整可见
  btn.style.cssText = 'position:fixed;left:20px;bottom:30px;z-index:2147483647;'
    + 'padding:9px 16px;border-radius:12px;cursor:pointer;'
    + 'background:rgba(40,30,60,.92);color:#fff;font-size:13px;font-weight:600;'
    + 'border:1px solid rgba(255,255,255,.28);box-shadow:0 6px 20px rgba(0,0,0,.35);';
  btn.addEventListener('click', (e: Event) => {
    e.stopPropagation();
    // [lc-473] 清除"主动看系统页"标记 → 回到 /v 后 autoJumpToTv 恢复(本就只在 / 跳, /v 不跳)
    try { sessionStorage.removeItem('fntv-system-intent'); } catch (_) { /* ignore */ }
    // [lc-375] 交主进程清除 _systemPageMode 并跳转 /v(原子操作, 避免守卫竞态)
    ipcRenderer.send('fntv:exit-system-page');
  });
  document.body.appendChild(btn);
  // 兜底: 原生 SPA 若重建 body 子节点, 每 3s 确保按钮仍在(避免被移除后无法返回)
  setInterval(() => {
    if (!document.getElementById('fnos-native-return') && document.body) {
      document.body.appendChild(btn);
    }
  }, 3000);
}

// [lc-385] 系统页(飞牛原生桌面/文件管理器)显式「外部播放」入口：
// 不劫持正常点击，提供浮动按钮 + 小面板，让用户粘贴直链 / 选择本地文件，
// 经主进程 external-play IPC 用 PotPlayer/MPV 打开（fnOS 流类点击拦截另由点击委托实现）。
function injectExternalPlayButton(): void {
  if (document.getElementById('fnos-ext-play')) return;

  const panel = document.createElement('div');
  panel.id = 'fnos-ext-play-panel';
  panel.style.cssText = 'position:fixed;right:20px;bottom:80px;z-index:2147483647;width:260px;padding:12px;'
    + 'border-radius:14px;background:rgba(30,24,44,.94);color:#fff;font-size:12px;box-shadow:0 8px 28px rgba(0,0,0,.45);'
    + 'border:1px solid rgba(255,255,255,.2);display:none;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);';

  panel.innerHTML = ''
    + '<div style="font-weight:700;margin-bottom:8px;">外部播放器打开</div>'
    + '<div style="margin-bottom:8px;">播放器：'
    + '<label style="margin-right:10px;cursor:pointer;"><input type="radio" name="ext-player" value="mpv" checked> MPV</label>'
    + '<label style="cursor:pointer;"><input type="radio" name="ext-player" value="potplayer"> PotPlayer</label>'
    + '</div>'
    + '<div style="margin-bottom:6px;color:rgba(255,255,255,.7);">直链 URL</div>'
    + '<input id="ext-url" type="text" placeholder="https://.../xxx.mp4" style="width:100%;box-sizing:border-box;height:30px;margin-bottom:8px;'
    + 'border-radius:7px;border:1px solid rgba(255,255,255,.25);background:rgba(0,0,0,.3);color:#fff;padding:0 8px;">'
    + '<button id="ext-open-url" style="width:100%;height:30px;margin-bottom:10px;border-radius:7px;border:none;cursor:pointer;'
    + 'background:#6c5ce7;color:#fff;font-weight:600;">用播放器打开直链</button>'
    + '<div style="margin-bottom:6px;color:rgba(255,255,255,.7);">本地文件</div>'
    + '<input id="ext-file" type="file" accept="video/*" style="width:100%;margin-bottom:8px;color:#fff;">'
    + '<button id="ext-open-file" style="width:100%;height:30px;border-radius:7px;border:none;cursor:pointer;'
    + 'background:#00b894;color:#fff;font-weight:600;">用播放器打开本地文件</button>';

  const toggle = document.createElement('button');
  toggle.id = 'fnos-ext-play';
  toggle.type = 'button';
  toggle.textContent = '🎬 外部播放';
  toggle.style.cssText = 'position:fixed;right:20px;bottom:30px;z-index:2147483647;padding:9px 14px;border-radius:12px;cursor:pointer;'
    + 'background:rgba(40,30,60,.92);color:#fff;font-size:13px;font-weight:600;'
    + 'border:1px solid rgba(255,255,255,.28);box-shadow:0 6px 20px rgba(0,0,0,.35);';

  toggle.addEventListener('click', (e: Event) => {
    e.stopPropagation();
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });

  panel.querySelector('#ext-open-url')!.addEventListener('click', (e: Event) => {
    e.stopPropagation();
    const url = (panel.querySelector('#ext-url') as HTMLInputElement).value.trim();
    const player = (panel.querySelector('input[name=ext-player]:checked') as HTMLInputElement)?.value as 'mpv' | 'potplayer';
    if (!url) { alert('请先粘贴视频直链'); return; }
    ipcRenderer.send('external-play', { kind: 'url', url, player });
    panel.style.display = 'none';
  });

  panel.querySelector('#ext-open-file')!.addEventListener('click', (e: Event) => {
    e.stopPropagation();
    const fileInput = panel.querySelector('#ext-file') as HTMLInputElement;
    const f = fileInput.files && fileInput.files[0];
    if (!f) { alert('请先选择本地视频文件'); return; }
    const player = (panel.querySelector('input[name=ext-player]:checked') as HTMLInputElement)?.value as 'mpv' | 'potplayer';
    // Electron 渲染进程里 fileInput.files[0].path 即本地绝对路径
    const p = (f as any).path as string;
    if (!p) { alert('无法读取本地文件路径'); return; }
    ipcRenderer.send('external-play', { kind: 'file', path: p, player });
    panel.style.display = 'none';
  });

  // 点击面板内部不冒泡关闭；点击面板外关闭
  panel.addEventListener('click', (e: Event) => e.stopPropagation());
  document.addEventListener('click', () => { if (panel.style.display === 'block') panel.style.display = 'none'; });

  document.body.appendChild(panel);
  document.body.appendChild(toggle);
  setInterval(() => {
    if (!document.getElementById('fnos-ext-play') && document.body) {
      document.body.appendChild(panel);
      document.body.appendChild(toggle);
    }
  }, 3000);
}

// ─── fnOS 视频预览窗口 → 标题栏「🎬 外部打开」按钮 ───
// 飞牛视频预览以模态窗口(.trim-ui__app-layout--window)内联 xgplayer <video> 播放,
// 其 src 为带签名(sign)的直链 /download/.../file.mp4?t=...&sign=..., 自鉴权,
// 可直接交给外部播放器(PotPlayer/MPV)播放, 无需再走 fnOS 代理或 cookie.
// 策略: 保留原生预览, 仅在模态标题栏注入一个按钮, 点击时取 video 直链 → external-play(url).
function injectVideoPreviewExternalPlay(): void {
  if (document.getElementById('fnos-video-preview-hook')) return;
  const marker = document.createElement('div');
  marker.id = 'fnos-video-preview-hook';
  marker.style.display = 'none';
  document.body.appendChild(marker);

  // [lc-453] 撤销 lc-395/lc-396 的强制黑底: 恢复飞牛视频预览模态原生白色顶栏(用户要求),
  //   不再注入 fntv-video-modal 头部配色规则(连强制白字一并撤掉, 否则白底白字不可见).

  // 冻结/解冻: 在用户选择播放方式之前, 阻止飞牛原生 xgplayer 自动播放(避免"还没选就播了").
  // 原理: capture 阶段拦截 <video> 的 play 事件(prioritize 于 xgplayer 的 listener),
  //       preventDefault + stopImmediatePropagation + 再次 pause, 使任何 play() 企图都被挡住.
  const frozen = new WeakSet<HTMLVideoElement>();
  function freezeVideo(video: HTMLVideoElement | null): void {
    if (!video || frozen.has(video)) return;
    frozen.add(video);
    try { video.pause(); } catch (_) { /* ignore */ }
    const block = (e: Event): void => {
      e.preventDefault();
      e.stopImmediatePropagation();
      try { video.pause(); } catch (_) { /* ignore */ }
    };
    video.addEventListener('play', block, true);
    (video as any).__fntvBlock = block;
  }
  function unfreezeVideo(video: HTMLVideoElement | null): void {
    if (!video) return;
    const block = (video as any).__fntvBlock as EventListener | undefined;
    if (block) { video.removeEventListener('play', block, true); (video as any).__fntvBlock = null; }
    frozen.delete(video);
    try { video.play().catch(() => {}); } catch (_) { /* ignore */ }
  }

  /** 用外部播放器打开: 抓 video 直链 → external-play → 关闭原生预览 */
  function launchExternal(modal: HTMLElement): void {
    const video = modal.querySelector('video') as HTMLVideoElement | null;
    const url = video?.currentSrc || video?.src || '';
    if (!url || !/^https?:\/\//i.test(url)) {
      log('[视频预览外放] 未取到有效直链');
      alert('未能获取视频直链，无法外部打开');
      return;
    }
    const titleEl = modal.querySelector('.trim-ui__app-layout--header-title span');
    const title = (titleEl?.textContent || 'fnOS 视频').trim();
    log('[视频预览外放] 外部打开:', title, url);
    ipcRenderer.send('external-play', { kind: 'url', url, title });
    // 关闭原生预览(轻微延迟, 让外部播放器先启动)
    setTimeout(() => {
      const closeBtn = modal.querySelector('.app-layout-header-close') as HTMLElement | null;
      if (closeBtn) closeBtn.click();
      else modal.style.display = 'none';
    }, 200);
  }

  /** 弹出居中选择弹窗(暂停原生 video 避免双声); 飞牛原生 / 外置播放器 二选一 */
  function showChoiceDialog(modal: HTMLElement): void {
    if (modal.dataset.fntvChoice === '1') return; // 防重复弹出
    modal.dataset.fntvChoice = '1';

    const video = modal.querySelector('video') as HTMLVideoElement | null;

    const overlay = document.createElement('div');
    overlay.className = 'fntv-choice-dialog';
    // z-index 高于飞牛预览窗口(10015), 遮罩盖住预览直到用户选择
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10020;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.45);';

    const card = document.createElement('div');
    card.style.cssText = 'min-width:300px;max-width:90vw;padding:20px 22px;border-radius:14px;background:var(--semi-color-bg-1,#fff);box-shadow:0 8px 30px rgba(0,0,0,0.25);color:var(--semi-color-text-0);';
    card.innerHTML =
      '<div style="font-weight:600;font-size:15px;margin-bottom:4px;">选择播放方式</div>' +
      '<div style="opacity:0.7;font-size:12px;margin-bottom:14px;">要如何播放此视频？</div>';

    const mkBtn = (label: string, primary: boolean, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText =
        'display:block;width:100%;margin-top:10px;padding:10px 14px;border:0;border-radius:10px;cursor:pointer;font-size:14px;font-weight:600;' +
        (primary
          ? 'background:var(--semi-color-primary,#3370ff);color:#fff;'
          : 'background:var(--semi-color-fill-0,#f0f0f0);color:var(--semi-color-text-0);');
      b.onmouseenter = () => { b.style.opacity = '0.85'; };
      b.onmouseleave = () => { b.style.opacity = '1'; };
      b.onclick = onClick;
      return b;
    };

    const closeDialog = (): void => { overlay.remove(); }; // 保留 dataset.fntvChoice='1', 防止 observer 重新弹窗/重新冻结
    const playNative = (): void => { unfreezeVideo(video); }; // 解冻(移除 play 拦截) + 底层 video.play()(用户手势内允许播放; 不再被 observer 重新冻结, 故稳定播放)

    card.appendChild(mkBtn('🎬 外置播放器 (PotPlayer / MPV)', true, () => {
      closeDialog();
      launchExternal(modal);
    }));
    card.appendChild(mkBtn('▶ 飞牛原生播放', false, () => {
      closeDialog();
      playNative();
    }));

    overlay.appendChild(card);
    // 点击遮罩空白处 = 飞牛原生(不打断用户)
    overlay.addEventListener('click', (e: Event) => {
      if (e.target === overlay) { closeDialog(); playNative(); }
    });
    overlay.addEventListener('mousedown', (e: Event) => e.stopPropagation()); // 防穿透到预览窗口

    document.body.appendChild(overlay);
    log('[视频预览外放] 已弹出播放方式选择弹窗');
  }

  function ensureButton(modal: HTMLElement): void {
    if (modal.querySelector('.fntv-ext-open')) return; // 幂等(应对 fnOS 重渲染标题栏)

    // 标题栏右侧按钮容器 = 关闭按钮的父节点(minimize/maximize/close 同容器)
    const closeBtn = modal.querySelector('.app-layout-header-close') as HTMLElement | null;
    const headerBtns = (closeBtn?.parentElement) as HTMLElement | null;
    if (!headerBtns) return;

    const btn = document.createElement('div');
    btn.className = 'fntv-ext-open flex h-full items-center px-[15px] cursor-pointer hover:!bg-[var(--semi-color-fill-0)] active:!bg-[var(--semi-color-fill-0)]';
    btn.style.cssText = 'font-weight:600;font-size:13px;white-space:nowrap;user-select:none;color:var(--semi-color-text-0);';
    btn.textContent = '🎬 外部打开';
    btn.title = '用 PotPlayer / MPV 打开此视频';
    btn.addEventListener('click', (e: Event) => { e.stopPropagation(); launchExternal(modal); });
    btn.addEventListener('mousedown', (e: Event) => e.stopPropagation()); // 避免触发标题栏拖拽

    headerBtns.insertBefore(btn, headerBtns.firstChild);
  }

  // 注意: MutationObserver 在 xgplayer 播放时因进度条等 DOM 变化会反复触发.
  // 已处理过的 modal(dataset.fntvChoice==='1')必须整体跳过, 否则会对已解冻的视频重新 freeze(视频反复被暂停),
  // 且会因 closeDialog 删除 dataset 而重新弹出选择窗(现象: 弹窗关不掉/视频不播).
  const handleModal = (modal: HTMLElement): void => {
    if (modal.dataset.fntvChoice === '1') return; // 已选过播放方式: 不再冻结/弹窗/注入按钮
    if (modal.querySelector('video')) {
      freezeVideo(modal.querySelector('video')); // 选择前冻结原生播放, 避免"还没选就播了"
      showChoiceDialog(modal); // 自动弹窗(主要交互)
      ensureButton(modal);     // 标题栏按钮(弹窗关闭后仍可作为二次入口)
    }
  };

  const observer = new MutationObserver(() => {
    document.querySelectorAll('.trim-ui__app-layout--window').forEach((m) => handleModal(m as HTMLElement));
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // 首次注入时也扫一遍(模态可能已存在)
  document.querySelectorAll('.trim-ui__app-layout--window').forEach((m) => handleModal(m as HTMLElement));

  log('[视频预览外放] 已注入(自动弹窗选择 + 标题栏外部打开按钮)');
}

function handle(): void {
  const base = location.origin;
  log('handle start');

  // [lc-371] 原生系统页守卫: 仅在飞牛影视 TV 页(/v)执行 TV 专属改造(白底清除器/主题/侧栏等);
  //   切到飞牛原生 NAS 系统页(根路径 `/`)时, 这些改造会破坏原生 UI, 故跳过, 仅注入"返回影视"浮动按钮。
  // [lc-389] 视频预览外放按钮须无条件注册: 它只 watch .trim-ui__app-layout--window 内的 <video>,
  //   影视 TV 页(/v)无此窗口故无害; 而若放在 !isFntvTvPage() 分支内, 当 preload 初次即在影视页(/v)
  //   加载时该分支不执行, 飞牛切系统页为 SPA 不重载 webContents → handle() 不再重跑 →
  //   按钮 observer 永不注册 → 文件管理器双击视频"无事发生". 故改无条件调用.
  injectVideoPreviewExternalPlay();

  // [lc-455] SPA 路由同步 <html>.fnos-tv-page 类:
  //   飞牛系统页(/)与影视页(/v)是同一 webContents 内 SPA 切换, 不重载 webContents → handle() 不再重跑。
  //   若初次在影视页加了 .fnos-tv-page, 切到系统页时类残留 → ① body 亚克力(已限定 .fnos-tv-page)仍误伤系统页。
  //   故周期性比对 pathname, 动态 add/remove 类, 确保系统页始终不被亚克力化(避免缩略图变黑框)。
  const syncTvPageClass = () => {
    document.documentElement.classList.toggle('fnos-tv-page', isFntvTvPage());
  };
  syncTvPageClass();
  let _lastPath = location.pathname;
  const _tvClassTimer = window.setInterval(() => {
    if (location.pathname !== _lastPath) {
      _lastPath = location.pathname;
      syncTvPageClass();
      log('[TV类同步]', location.pathname, 'isTv=', isFntvTvPage());
    }
  }, 400);
  window.addEventListener('beforeunload', () => window.clearInterval(_tvClassTimer));

  if (!isFntvTvPage()) {
    injectNativeReturnButton();
    injectExternalPlayButton();
    return;
  }

  // [lc-453] 标记 <html> 为影视TV页: 供 mainwin.ts ACRYLIC_CSS 的白底清除规则(③)限定作用域,
  //   避免文件管理/设置等系统页的缩略图容器背景被误杀变黑框.
  document.documentElement.classList.add('fnos-tv-page');

  // 导航诊断: 记录每次URL变化, 排查"返回落到全部剧集而非首页"
  const logNav = (label: string) => log('NAV', label, location.href);
  logNav('init');

  // [v400] 注入主题变量 + 应用 UI 主题偏好 + 隐藏飞牛自带主题开关
  injectUiThemeStyle();
  applyUiTheme();
  removeThemeModeSetting();
  // MutationObserver 守护: 飞牛路由切换/React重渲染可能改回深色或重建设置页DOM → 持续纠正
  //   observe documentElement: attributes 监听 html 的 class/style 变化(锁浅色), subtree 监听内部所有 DOM 变化(删主题模式区块)
  let _themeTimer = 0;
  const _themeObserver = new MutationObserver(() => {
    clearTimeout(_themeTimer);
    _themeTimer = window.setTimeout(() => { applyUiTheme(); removeThemeModeSetting(); }, 150);
  });
  _themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'], childList: true, subtree: true });
  window.addEventListener('beforeunload', () => _themeObserver.disconnect());
  // [v400] 跟随系统: 系统明暗偏好变化时, 若当前为 system 则实时换肤
  try {
    const _mq = window.matchMedia('(prefers-color-scheme: dark)');
    const _onSys = () => { if (getUiTheme() === 'system') applyUiTheme(); };
    if (typeof _mq.addEventListener === 'function') _mq.addEventListener('change', _onSys);
    else if (typeof (_mq as any).addListener === 'function') (_mq as any).addListener(_onSys);
  } catch (e) { /* ignore */ }

  // ── [v364] 初始化亚克力参数(透明度/模糊): 来自 localStorage, 供侧栏滑块实时调整 ──
  (() => {
    const a = localStorage.getItem('fnos-glass-alpha');
    const b = localStorage.getItem('fnos-glass-blur');
    if (a) document.documentElement.style.setProperty('--fnos-alpha', a);
    if (b) document.documentElement.style.setProperty('--fnos-blur', b + 'px');
  })();

  // ── [v363] 全局白底清除器: JS 核弹级扫描 ──
  // CSS 选择器覆盖不了的内联 style / 动态样式 / CSS 变量 → 全靠这里
  // 原理: 遍历所有元素的计算背景色, 白/近白系(r,g,b≥235 且不透明)→强制透明
  // [v367] 重要修正: 必须排除飞牛原生的交互性浮层(dropdown/menu/popover/modal/tooltip),
  //   否则展开菜单会被误杀成全透, 文字重叠无法阅读.
  const _isOpaqueLight = (bg: string): boolean => {
    if (!bg) return false;
    const m = bg.match(/rgba?\(([^)]+)\)/);
    if (!m) return false;
    const parts = m[1].split(',').map(s => parseFloat(s.trim()));
    const [r, g, b, a = 1] = parts;
    if (a < 0.05) return false; // 已透明
    return r >= 220 && g >= 220 && b >= 220; // 白/浅灰系(阈值从235降到220)
  };

  /** 判断一个元素是否是「应该保留背景的交互性浮层」→ 跳过不清除 */
  const _isProtectedOverlay = (el: HTMLElement): boolean => {
    // ⓪ 自建设置面板及其所有后代 → 永远保护(浅色卡片不被白底清除器误杀)
    if (el.id === 'fnos-settings-panel') return true;
    if (typeof el.closest === 'function' && el.closest('#fnos-settings-panel')) return true;

    // ① ARIA 语义化 UI 组件
    const role = el.getAttribute('role');
    if (role && ['menu', 'menuitem', 'listbox', 'option', 'dialog', 'tooltip', 'combobox', 'select'].includes(role)) return true;

    // ② class 关键字匹配(常见 UI 框架命名)
    const cls = el.className || '';
    if (typeof cls === 'string') {
      const overlayKw = ['dropdown', 'popover', 'menu-', '-menu', 'modal', 'tooltip', 'sheet-', 'select-', 'popup', 'flyout', 'context-menu', 'command-palette'];
      const lower = cls.toLowerCase();
      for (const kw of overlayKw) { if (lower.includes(kw)) return true; }
    }

    // ③ 绝对/固定定位的小型浮层(通常是 dropdown/tooltip, 不是页面容器)
    const cs = getComputedStyle(el);
    const pos = cs.position;
    if (pos === 'absolute' || pos === 'fixed') {
      const rect = el.getBoundingClientRect();
      // 面积 < 150×100 或 宽度 < 200px → 视为小型交互控件, 不清
      if (rect.width * rect.height < 150000 || rect.width < 200) return true;
      // z-index 极高的固定层(> 5000) → 可能是全局浮层
      if (pos === 'fixed') {
        const zi = parseInt(cs.zIndex || '0', 10);
        if (!isNaN(zi) && zi > 5000) return true;
      }
    }

    // ④ 有明显阴影/边框的独立卡片(通常是有意设计的面板)
    const boxShadow = cs.boxShadow || '';
    if (boxShadow !== 'none' && boxShadow.includes('0px') && (boxShadow.includes('rgba(0') || boxShadow.includes('rgb(0'))) {
      // 有非零阴影 → 可能是卡片式浮层, 检查是否是小面积
      const rect = el.getBoundingClientRect();
      if (rect.width < 600 && rect.height < 400) return true;
    }

    return false;
  };

  let _whitewashPasses = 0;
  const _globalWhitewashRemover = () => {
    _whitewashPasses++;
    let fixedCount = 0;
    let skippedCount = 0;
    const skipTags = new Set(['HTML', 'HEAD', 'SCRIPT', 'STYLE', 'LINK', 'META', 'SVG', 'PATH', 'CANVAS', 'IMG', 'VIDEO', 'IFRAME', 'BODY']);
    const all = document.querySelectorAll<HTMLElement>('*');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (skipTags.has(el.tagName)) continue;
      if (el.dataset.fnosClear === '1') continue;
      // [v397] 跳过所有自建设置弹窗(检查更新/关于/反馈/B站登录): 它们标了 data-fnos-ui='1',
      //   且子树内卡片背景为浅粉不透 → 若被白底清除器误清成 transparent!important, 整窗会"全透明"看不见.
      //   用 closest 保护整棵子树(卡片是 position:relative, 自身不会被 fixed 浮层保护规则覆盖).
      if (el.dataset.fnosUi === '1' || (typeof el.closest === 'function' && el.closest('[data-fnos-ui="1"]'))) {
        skippedCount++;
        continue;
      }

      // [v367] 先检查是否受保护的交互浮层
      if (_isProtectedOverlay(el)) {
        skippedCount++;
        continue;
      }

      try {
        const cs = getComputedStyle(el);
        const bg = cs.backgroundColor;
        if (_isOpaqueLight(bg)) {
          el.style.setProperty('background', 'transparent', 'important');
          el.style.setProperty('background-color', 'transparent', 'important');
          el.dataset.fnosClear = '1';
          fixedCount++;
        }
      } catch (_) { /* 跨域等安全异常跳过 */ }
    }
    if (_whitewashPasses % 20 === 1 || fixedCount > 0) {
      log('whitewash pass', _whitewashPasses, 'fixed', fixedCount, 'skipped-overlay', skippedCount);
    }
  };

  // [v382] 全局圆角强制: 飞牛影视 React SPA 路由切换时可能添加 position:fixed 全屏层,
  //        其 Tailwind 类名(如 fixed.top-0.left-0.w-full.h-full)不被 ACRYLIC_CSS
  //        fixed.inset-0 选择器覆盖 → 四个角变方. JS 扫描所有 fixed 元素, 近全屏则强制圆角.
  let _rcPasses = 0;
  const _globalRoundedCornerEnforcer = () => {
    _rcPasses++;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let fixedCount = 0;
    // 只扫描 fixed 元素(数量远少于全 DOM)
    const all = document.querySelectorAll<HTMLElement>('*');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      // body/html 由 mainwin.ts 的 injectAcrylicCSS 统一处理(登录页灰底/主界面亚克力),
      // 此处跳过以免把登录页的 #f5f5f5 灰底误清成 transparent(用户要求登录页不透明).
      if (el === document.body || el === document.documentElement) continue;
      try {
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed') continue;
        const rect = el.getBoundingClientRect();
        // 覆盖 ≥80% 视口的元素才加圆角(避免误伤小弹窗/按钮)
        if (rect.width < vw * 0.8 || rect.height < vh * 0.8) continue;
        // 跳过已标记的
        if (el.dataset.fnosRounded === '1') continue;
        el.style.setProperty('border-radius', '16px', 'important');
        el.style.setProperty('overflow', 'hidden', 'important');
        el.style.setProperty('clip-path', 'inset(0 round 16px)', 'important');
        el.style.setProperty('-webkit-clip-path', 'inset(0 round 16px)', 'important');
        // 同步清除白底: 全屏固定层的白底挡住 body 亚克力玻璃+桌面透出圆角
        // [v384] 同时清除 background-image(渐变/图片): getComputedStyle 的 backgroundColor
        //        对渐变返回 transparent, 导致白底漏网.
        const bgImg = cs.backgroundImage;
        if (bgImg && bgImg !== 'none') {
          el.style.setProperty('background-image', 'none', 'important');
        }
        const bg = cs.backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)') {
          const bm = bg.match(/rgba?\(([^)]+)\)/);
          if (bm) {
            const parts = bm[1].split(',').map(s => parseFloat(s.trim()));
            if (parts[0] > 200 && parts[1] > 200 && parts[2] > 200 && (parts[3] ?? 1) > 0.1) {
              el.style.setProperty('background', 'transparent', 'important');
              el.style.setProperty('background-color', 'transparent', 'important');
            }
          }
        }
        el.dataset.fnosRounded = '1';
        fixedCount++;
      } catch (_) { /* skip */ }
    }
    if (_rcPasses % 20 === 1 || fixedCount > 0) {
      log('rounded-corner pass', _rcPasses, 'fixed-fullscreen', fixedCount);
    }
  };
  // 与白底清除器共用触发机制: 立即+延迟+DOM变化+定时巡检
  setTimeout(_globalRoundedCornerEnforcer, 800);
  setTimeout(_globalRoundedCornerEnforcer, 2500);
  setTimeout(_globalRoundedCornerEnforcer, 4500);
  let _rcTimer = 0;
  const _rcObs = new MutationObserver(() => {
    clearTimeout(_rcTimer);
    _rcTimer = window.setTimeout(_globalRoundedCornerEnforcer, 200);
  });
  _rcObs.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('beforeunload', () => { _rcObs.disconnect(); clearInterval(_rcInterval); });
  const _rcInterval = setInterval(_globalRoundedCornerEnforcer, 6000);

  // 三重触发: 立即一次 + MutationObserver(DOM变化时) + 定时巡检(兜底漏网)
  setTimeout(_globalWhitewashRemover, 500);
  setTimeout(_globalWhitewashRemover, 2000);
  setTimeout(_globalWhitewashRemover, 4000);
  let _wwTimer = 0;
  const _wwObs = new MutationObserver(() => {
    clearTimeout(_wwTimer);
    _wwTimer = window.setTimeout(_globalWhitewashRemover, 200);
  });
  _wwObs.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('beforeunload', () => _wwObs.disconnect());
  setInterval(_globalWhitewashRemover, 6000); // 每6秒兜底扫一次

  // [v374] 窗口拖动已改为原生 -webkit-app-region:drag (见 titlebar.ts / mainwin.ts CSS),
  //   不再用 JS setPosition —— transparent 窗口下 setPosition 会触发 DWM 异常放大.
  //   改变窗口大小仅通过拖拽窗口边缘(resizable:true 原生行为).

  // 汉堡键(所有页面含首页/详情页)的"宽屏常显+抽屉开合"均由 mainwin.ts insertCSS 纯CSS规则控制:
  //   规则1: [class*="lg:!hidden"]:not([class*="inset-0"]){display:flex!important}  → 命中所有页面的汉堡键容器
  //   规则2: [class*="lg:!hidden"][class*="inset-0"]:not([class~="!hidden"]){display:flex!important} → 抽屉跟随飞牛!hidden状态
  // (Playwright 550px窄屏DOM确认: 详情页头部也有完全相同的 lg:!hidden 汉堡键结构, 含🏠首页+≡菜单)
  //
  // [JS兜底] v321~v326: 强制可见 + inline-style 完全接管抽屉开合(不动 !hidden 类!)
  //   mainwin.ts的CSS注入理论上覆盖所有页面, 但SPA路由切换后可能存在时序/优先级边缘情况
  //   导致汉堡键仍被Tailwind @media钉死display:none → ①强制可见兜底.
  //   [v326 关键修正] v325 只管 inline 但不拦截飞牛 → 飞牛原生 onClick 有时仍会触发(宽屏下并非稳定 no-op),
  //     与我们的 inline 切换形成"双重控制", 且遮罩关闭判定(e.target===drawer)过严(背板是子元素),
  //     导致首页抽屉"能开不能收/卡死".
  //   v326 改为: capture 阶段 stopImmediatePropagation 拦截飞牛原生 click handler,
  //     由我们**唯一**用 inline style 控制开合; 因绝不修改 !hidden 类, 飞牛 React state 永远与 DOM 一致,
  //     不会触发 v322 那种 state 同步死锁; 并补③背板点击关闭 + 导航时关闭抽屉, 彻底消除卡死.
  // 抽屉开合动画辅助: 用 display(flex/none) 控制挂载, .drawer-open 类驱动 CSS 过渡;
  // 绝不动 !hidden 类(飞牛 React state 永远与 DOM 一致, 不触发 v322 那种死锁)
  const openDrawer = (d: HTMLElement): void => {
    d.style.setProperty('display', 'flex', 'important');
    // [v351] 直接用 JS 注入面板毛玻璃样式(inline style > 一切 CSS 规则)
    applySidebarGlass(d);
    // 双 rAF: 确保 display:flex 先绘制(opacity:0/translateX(-100%)初始态), 再切 .drawer-open 触发过渡
    requestAnimationFrame(() => requestAnimationFrame(() => d.classList.add('drawer-open')));
  };

  /** 给抽屉内部面板强制注入 Mica 亚克力毛玻璃(通过 inline style 绕过所有 CSS 优先级) */
  function applySidebarGlass(drawer: HTMLElement): void {
    // 抽屉容器内第一个非 absolute 的子元素就是侧栏面板
    const kids = Array.from(drawer.children);
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i] as HTMLElement;
      if (child.classList?.contains('absolute')) continue;
      const panel = child;
      // Mica Acrylic: 粉紫暖调半透 + 高模糊 (透桌面真亚克力)
      panel.style.setProperty('background', 'var(--fnos-sidebar-bg)', 'important');
      panel.style.setProperty('backdrop-filter',
        'blur(56px) saturate(135%) brightness(1.02)', 'important');
      panel.style.setProperty('-webkit-backdrop-filter',
        'blur(56px) saturate(135%) brightness(1.02)', 'important');
      panel.style.setProperty('border-right', 'var(--fnos-sidebar-border)', 'important');
      panel.style.setProperty('box-shadow', 'var(--fnos-sidebar-shadow)', 'important');
      // [v352] 关键: 面板内层嵌套容器常带白底(bg-white/bg-gray), 会盖住浅蓝 → 把它们全部透明化
      // [lc-371-fix] 跳过 #fnos-switch-system-btn 等注入按钮(否则二次调用 applySidebarGlass 时
      //   已存在的按钮背景被透明化 → 在半透明面板上不可见)
      const descendants = panel.querySelectorAll('*');
      for (let j = 0; j < descendants.length; j++) {
        const el = descendants[j] as HTMLElement;
        // 跳过我们注入的侧栏按钮（保持自身背景色）
        if (el.id === 'fnos-switch-system-btn' || el.id === 'fnos-settings-btn'
          || el.id === 'fnos-feedback-choice-btn' || el.closest('#fnos-sidebar-actions')) continue;
        const bg = getComputedStyle(el).backgroundColor;
        // 命中不透明/半透明的白系或浅灰底 → 透明, 让浅蓝透上来
        if (isOpaqueLightBg(bg)) {
          el.style.setProperty('background', 'transparent', 'important');
          el.style.setProperty('background-color', 'transparent', 'important');
        }
      }
      injectSettingsUI(panel); // [lc-360] 侧栏底部只保留"设置/反馈/QQ"按钮(滑块已迁入设置面板"外观"标签页)
      break; // 只处理第一个非 absolute 子元素
    }
    // 遮罩层: 极淡暖灰雾感, 与 Mica 亚克力风格统一
    drawer.style.setProperty('background', 'rgba(200,195,210,.12)', 'important');
    drawer.style.setProperty('backdrop-filter', 'blur(8px) saturate(120%)', 'important');
      drawer.style.setProperty('-webkit-backdrop-filter', 'blur(8px) saturate(120%)', 'important');
  }

  /** [lc-360] 构造"亚克力透明度/模糊"调节滑块组(纯 DOM, 可复用于设置面板"外观"标签页)
   *  - 透明度滑块(0~100): 值越大越透(桌面透出越多). 反向映射到 body 背景 alpha(0.95→0.05)
   *  - 模糊滑块(0~100px): 调节 backdrop-filter 模糊强度
   *  - 写入 localStorage, 重启后仍生效 */
  function buildAppearanceControls(): HTMLElement {
    // [lc-119] 首次登录(无 localStorage)默认: 透明度滑块=30%(对应 alpha 0.68), 背景模糊滑块=30px
    const storedAlpha = parseFloat(localStorage.getItem('fnos-glass-alpha') || '0.68');
    const storedBlur = parseInt(localStorage.getItem('fnos-glass-blur') || '30', 10);
    // 滑块 value=透明度%(0→浓度最高不透明0.95, 100→最透0.05); 与 alpha 反相关
    const alphaPct = Math.max(0, Math.min(100, Math.round((0.95 - storedAlpha) / 0.9 * 100)));
    const wrap = document.createElement('div');
    wrap.id = 'fnos-appearance-ctrl';
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
    wrap.innerHTML = ''
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">'
      +   '<span style="font-weight:600;letter-spacing:.5px;">亚克力透明度</span>'
      +   '<span id="fnos-alpha-val" style="opacity:.85;">' + alphaPct + '%</span></div>'
      + '<input id="fnos-alpha" type="range" min="0" max="100" value="' + alphaPct + '" '
      +   'style="width:100%;accent-color:var(--fnos-ui-accent);cursor:pointer;">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin:12px 0 8px;">'
      +   '<span style="font-weight:600;letter-spacing:.5px;">背景模糊</span>'
      +   '<span id="fnos-blur-val" style="opacity:.85;">' + storedBlur + 'px</span></div>'
      + '<input id="fnos-blur" type="range" min="0" max="100" value="' + storedBlur + '" '
      +   'style="width:100%;accent-color:var(--fnos-ui-accent);cursor:pointer;">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:18px;">'
      +   '<span style="font-weight:600;letter-spacing:.5px;">首页「每日放送」按钮</span>'
      +   '<label style="position:relative;display:inline-block;width:42px;height:23px;cursor:pointer;">'
      +     '<input id="fnos-show-daily" type="checkbox" style="position:absolute;opacity:0;width:0;height:0;">'
      +     '<span id="fnos-show-daily-track" style="position:absolute;inset:0;border-radius:23px;background:rgba(140,140,160,.45);transition:.2s;"></span>'
      +     '<span id="fnos-show-daily-knob" style="position:absolute;top:2.5px;left:2.5px;width:18px;height:18px;border-radius:50%;background:#fff;transition:.2s;box-shadow:0 1px 3px rgba(0,0,0,.3);"></span>'
      +   '</label>'
      + '</div>';

    const alphaInput = wrap.querySelector('#fnos-alpha') as HTMLInputElement;
    const alphaVal = wrap.querySelector('#fnos-alpha-val') as HTMLElement;
    const blurInput = wrap.querySelector('#fnos-blur') as HTMLInputElement;
    const blurVal = wrap.querySelector('#fnos-blur-val') as HTMLElement;

    alphaInput.addEventListener('input', () => {
      const pct = parseInt(alphaInput.value, 10);
      const a = (0.05 + (100 - pct) / 100 * 0.9).toFixed(3); // 0→0.95, 100→0.05
      document.documentElement.style.setProperty('--fnos-alpha', a);
      if (alphaVal) alphaVal.textContent = pct + '%';
      localStorage.setItem('fnos-glass-alpha', a);
    });
    blurInput.addEventListener('input', () => {
      const px = parseInt(blurInput.value, 10);
      document.documentElement.style.setProperty('--fnos-blur', px + 'px');
      if (blurVal) blurVal.textContent = px + 'px';
      localStorage.setItem('fnos-glass-blur', String(px));
    });

    // [lc-363] 首页「每日放送」按钮开关（设置面板"外观"）：写 localStorage + 广播自定义事件给 hotUpdates 实时刷新
    const showDaily = localStorage.getItem('fnos-show-daily') !== '0';
    const dailyInput = wrap.querySelector('#fnos-show-daily') as HTMLInputElement;
    const dailyTrack = wrap.querySelector('#fnos-show-daily-track') as HTMLElement;
    const dailyKnob = wrap.querySelector('#fnos-show-daily-knob') as HTMLElement;
    const paintDaily = (): void => {
      dailyTrack.style.background = dailyInput.checked ? 'var(--fnos-ui-accent)' : 'rgba(140,140,160,.45)';
      dailyKnob.style.left = dailyInput.checked ? '21.5px' : '2.5px';
    };
    dailyInput.checked = showDaily;
    paintDaily();
    dailyInput.addEventListener('change', () => {
      localStorage.setItem('fnos-show-daily', dailyInput.checked ? '1' : '0');
      paintDaily();
      try { window.dispatchEvent(new CustomEvent('fntv:daily-toggle', { detail: { on: dailyInput.checked } })); } catch (_) {}
    });
    return wrap;
  }

  /** [新] 侧栏底部追加"设置"按钮; 点击打开设置面板
   *  注意: 按钮必须 append 到 sticky 底部容器内部(而非 panel 直子),
   *  否则飞牛侧栏面板的 overflow/height 会把按钮裁到可视区域外.
   *  [lc-360] 容器优先复用旧 #fnos-glass-ctrl(兼容), 缺失时自建 #fnos-sidebar-actions
   *  (亚克力滑块已迁入设置面板"外观"标签页, 侧栏容器不再含滑块). */
  function injectSettingsUI(panel: HTMLElement): void {
    // 容器: 兼容旧 #fnos-glass-ctrl, 否则复用/新建 #fnos-sidebar-actions
    let ctrl = panel.querySelector('#fnos-glass-ctrl') as HTMLElement | null;
    if (!ctrl) ctrl = panel.querySelector('#fnos-sidebar-actions') as HTMLElement | null;
    if (!ctrl) {
      ctrl = document.createElement('div');
      ctrl.id = 'fnos-sidebar-actions';
      ctrl.style.cssText = 'position:sticky;bottom:10px;flex-shrink:0;box-sizing:border-box;margin:14px 12px 0;width:calc(100% - 24px);'
        + 'padding:14px 14px 16px;border-radius:14px;display:flex;flex-direction:column;'
        + 'background:var(--fnos-sidebar-btn-bg)!important;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);'
        + 'border:1px solid rgba(255,255,255,.28);box-shadow:0 4px 16px rgba(0,0,0,.18);'
        + 'color:#fff;font-size:12px;user-select:none;';
      panel.appendChild(ctrl);
    }
    // [lc-371] "切换系统页面"按钮: 置于 #fnos-sidebar-actions 容器内部最顶部(设置按钮之上),
    //   点击后整窗导航到飞牛原生 NAS 系统页(根路径 `/`); 原生页由 injectNativeReturnButton 提供返回。
    // [lc-373-fix] 必须放进 ctrl 容器内部(prepend), 不能 insertBefore 到容器外——
    //   容器外的位置可能被面板布局推出可视区/被遮挡导致不可见。
    if (!ctrl.querySelector('#fnos-switch-system-btn')) {
      const swBtn = document.createElement('button');
      swBtn.id = 'fnos-switch-system-btn';
      swBtn.type = 'button';
      swBtn.textContent = '切换系统页面';
      swBtn.style.cssText = 'box-sizing:border-box;margin:0 0 10px;width:100%;padding:10px 12px;border-radius:12px;cursor:pointer;'
        + 'background:rgba(160,140,180,.35)!important;color:#fff;font-size:13px;font-weight:600;'
        + 'border:1px solid rgba(255,255,255,.28);box-shadow:0 4px 16px rgba(0,0,0,.18);text-align:center;'
        + 'backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);';
      swBtn.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        // [lc-473] 标记用户主动切系统页 → 抑制 autoJumpToTv 的桌面纠正(reload /v)
        try { sessionStorage.setItem('fntv-system-intent', '1'); } catch (_) { /* ignore */ }
        // [lc-375] 改由主进程执行跳转: 先置 _systemPageMode 再 loadURL('/'), 避免
        //   主进程导航守卫(lc-203)的 did-navigate 在标记生效前就把 / 纠正回 /v
        ipcRenderer.send('fntv:enter-system-page');
      });
      ctrl.prepend(swBtn);  // 放进容器内部最顶部 → 一定在"设置"按钮上方可见
    }

    if (ctrl.querySelector('#fnos-settings-btn')) return; // 幂等

    const btn = document.createElement('button');
    btn.id = 'fnos-settings-btn';
    btn.type = 'button';
    btn.textContent = '⚙ 设置';
    btn.style.cssText = 'box-sizing:border-box;margin-top:0;width:100%;padding:10px 12px;border-radius:12px;cursor:pointer;'
      + 'background:var(--fnos-sidebar-btn-bg)!important;color:#fff;font-size:13px;font-weight:600;'
      + 'border:1px solid rgba(255,255,255,.28);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);'
      + 'box-shadow:0 4px 16px rgba(0,0,0,.18);';
    btn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      const ov = document.getElementById('fnos-settings-panel');
      if (ov && ov.style.display === 'flex') ov.style.display = 'none'; // 再次点击=收起
      else openSettingsPanel(panel);
    });
    ctrl.appendChild(btn);

    // [lc-361] 合并"问卷反馈"与"Q群反馈"为单个"软件反馈建议"按钮(点击弹出选择弹窗)
    if (!ctrl.querySelector('#fnos-feedback-choice-btn')) {
      const fbChoiceBtn = document.createElement('button');
      fbChoiceBtn.id = 'fnos-feedback-choice-btn';
      fbChoiceBtn.type = 'button';
      fbChoiceBtn.textContent = '软件反馈建议';
      fbChoiceBtn.style.cssText = 'box-sizing:border-box;margin-top:8px;width:100%;padding:10px 12px;border-radius:12px;cursor:pointer;'
        + 'background:var(--fnos-sidebar-btn-bg)!important;color:#fff;font-size:13px;font-weight:600;'
        + 'border:1px solid rgba(255,255,255,.28);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);'
        + 'box-shadow:0 4px 16px rgba(0,0,0,.18);text-align:center;';
      fbChoiceBtn.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        openFeedbackChoiceModal();
      });
      ctrl.appendChild(fbChoiceBtn);
    }

    // [lc-365] 侧栏设置框底部常规显示版本号（像大厂软件：小灰字 + 上分隔线，居中）
    if (!ctrl.querySelector('#fnos-sidebar-version')) {
      const verLine = document.createElement('div');
      verLine.id = 'fnos-sidebar-version';
      verLine.style.cssText = 'margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,.15);'
        + 'text-align:center;font-size:11.5px;letter-spacing:.3px;color:rgba(255,255,255,.5);user-select:none;';
      verLine.textContent = 'v…';
      ctrl.appendChild(verLine);
      // 动态版本号：复用主进程 get-version / version-info（与"关于"标签页同源）
      try {
        ipcRenderer.send('get-version');
        ipcRenderer.once('version-info', (_e: any, info: any) => {
          if (info && info.version) verLine.textContent = 'v' + info.version;
        });
      } catch (_) {}
    }

    buildSettingsPanel();
  }

  /** 打开「历史版本」弹窗：列出 resource/wiki 下的 MD 文件，点击可查看内容 */
  // 轻量 Markdown 渲染（仅依赖 DOM，无第三方库）；内容经 HTML 转义后渲染，避免 XSS
  function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function inlineMd(s: string): string {
    // 入参已是转义后的纯文本
    s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    s = s.replace(/(^|[^\w])_([^_\n]+)_/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, u) => {
      const safe = /^https?:\/\//i.test(u) ? u : '#';
      return `<a href="${safe}" target="_blank" rel="noopener">${t}</a>`;
    });
    return s;
  }
  function renderMarkdown(md: string): string {
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    let html = '';
    let listType: '' | 'ul' | 'ol' = '';
    const closeList = () => { if (listType) { html += `</${listType}>`; listType = ''; } };
    const isBlockStart = (l: string) => /^(#{1,6}\s|>\s?|\s*[-*+]\s|\s*\d+\.\s|```)/.test(l)
      || /^(\-{3,}|\*{3,}|_{3,})$/.test(l.trim());
    let i = 0;
    while (i < lines.length) {
      let line = lines[i];
      // 代码块
      if (/^```/.test(line)) {
        closeList();
        i++;
        const buf: string[] = [];
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        html += `<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`;
        continue;
      }
      // 分隔线
      if (/^(\-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { closeList(); html += '<hr>'; i++; continue; }
      // 标题
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { closeList(); const lvl = h[1].length; html += `<h${lvl}>${inlineMd(escapeHtml(h[2].trim()))}</h${lvl}>`; i++; continue; }
      // 引用
      if (/^>\s?/.test(line)) {
        closeList();
        const buf: string[] = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
        html += `<blockquote>${inlineMd(escapeHtml(buf.join('\n'))).replace(/\n/g, '<br>')}</blockquote>`;
        continue;
      }
      // 表格（| 分隔，且下一行是分隔行）
      if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
        closeList();
        const splitRow = (r: string) => r.replace(/^\s*\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
        const headers = splitRow(line);
        i += 2;
        const rows: string[][] = [];
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== '') { rows.push(splitRow(lines[i])); i++; }
        let t = '<table><thead><tr>';
        headers.forEach(hd => { t += `<th>${inlineMd(escapeHtml(hd))}</th>`; });
        t += '</tr></thead><tbody>';
        rows.forEach(r => { t += '<tr>'; headers.forEach((_hd, idx) => { t += `<td>${inlineMd(escapeHtml(r[idx] || ''))}</td>`; }); t += '</tr>'; });
        t += '</tbody></table>';
        html += t;
        continue;
      }
      // 列表
      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      const ol = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ul || ol) {
        const type = ul ? 'ul' : 'ol';
        if (listType !== type) { closeList(); html += `<${type}>`; listType = type; }
        const content = ul ? ul[1] : ol![1];
        html += `<li>${inlineMd(escapeHtml(content))}</li>`;
        i++; continue;
      }
      // 空行
      if (line.trim() === '') { closeList(); i++; continue; }
      // 段落
      closeList();
      const buf: string[] = [line];
      i++;
      while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) { buf.push(lines[i]); i++; }
      html += `<p>${inlineMd(escapeHtml(buf.join('\n'))).replace(/\n/g, '<br>')}</p>`;
    }
    closeList();
    return `<div class="md-body">${html}</div>`;
  }
  // 注入一次 Markdown 容器样式（全局只注入一次）
  function ensureMdStyle(): void {
    if (document.getElementById('fnos-md-style')) return;
    const st = document.createElement('style');
    st.id = 'fnos-md-style';
    st.textContent = `
.md-body{font-size:13px;line-height:1.7;color:#3a2d4d;}
.md-body h1{font-size:20px;font-weight:700;margin:14px 0 10px;color:#2e2340;border-bottom:1px solid rgba(139,111,209,.22);padding-bottom:6px;}
.md-body h2{font-size:17px;font-weight:700;margin:16px 0 8px;color:#2e2340;}
.md-body h3{font-size:15px;font-weight:600;margin:14px 0 6px;color:#3a2d4d;}
.md-body h4{font-size:13.5px;font-weight:600;margin:12px 0 6px;color:#3a2d4d;}
.md-body p{margin:8px 0;}
.md-body ul,.md-body ol{margin:8px 0;padding-left:22px;}
.md-body li{margin:3px 0;}
.md-body code{background:rgba(139,111,209,.12);padding:1px 5px;border-radius:4px;font-family:Consolas,Menlo,monospace;font-size:12px;color:#5a3ec0;}
.md-body pre{background:rgba(46,35,64,.06);border:1px solid rgba(139,111,209,.18);border-radius:8px;padding:12px 14px;overflow-x:auto;margin:8px 0;}
.md-body pre code{background:none;padding:0;color:#3a2d4d;}
.md-body blockquote{margin:8px 0;padding:6px 12px;border-left:3px solid rgba(139,111,209,.4);background:rgba(139,111,209,.06);color:#5a4d6e;}
.md-body a{color:#7c4dff;text-decoration:underline;}
.md-body hr{border:none;border-top:1px solid rgba(139,111,209,.22);margin:14px 0;}
.md-body strong{font-weight:700;}
.md-body table{border-collapse:collapse;margin:10px 0;width:100%;font-size:12.5px;}
.md-body th,.md-body td{border:1px solid rgba(139,111,209,.25);padding:6px 9px;text-align:left;}
.md-body th{background:rgba(139,111,209,.10);font-weight:700;}
`;
    document.head.appendChild(st);
  }

  function openHistoryModal(): void {
    if (document.getElementById('fnos-history-overlay')) return; // 防重复打开

    const ov = document.createElement('div');
    ov.id = 'fnos-history-overlay';
    ov.setAttribute('data-fnos-ui', '1');
    ov.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483647',
      'display:flex', 'align-items:center', 'justify-content:center',
      'background:rgba(28,20,40,.40)',
      'backdrop-filter:blur(5px)', '-webkit-backdrop-filter:blur(5px)',
      'opacity:0', 'transition:opacity .18s ease',
      'font-family:"Segoe UI Variable","Segoe UI",system-ui,-apple-system,sans-serif',
    ].join(';') + ';';

    const card = document.createElement('div');
    card.setAttribute('data-fnos-ui', '1');
    card.style.cssText = [
      'position:relative', 'display:flex', 'flex-direction:column',
      'width:92%', 'max-width:780px', 'height:82vh', 'max-height:760px',
      'background:rgba(252,247,253,.98)!important',
      'backdrop-filter:blur(30px) saturate(135%)', '-webkit-backdrop-filter:blur(30px) saturate(135%)',
      'border-radius:16px',
      'box-shadow:0 18px 50px rgba(80,60,110,.30), inset 0 1px 0 rgba(255,255,255,.7)',
      'color:#3a2d4d', 'overflow:hidden',
      'transform:scale(.96)', 'transition:transform .18s cubic-bezier(.22,.61,.36,1)',
    ].join(';') + ';';

    // 头部：标题 + 关闭
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid rgba(139,111,209,.18);flex-shrink:0;';
    const hTitle = document.createElement('div');
    hTitle.textContent = '历史版本';
    hTitle.style.cssText = 'font-size:16px;font-weight:700;color:#2e2340;';
    // 历史版本下载链接
    const dlBtn = document.createElement('a');
    dlBtn.textContent = '历史版本下载';
    dlBtn.href = 'https://pan.baidu.com/s/5oy1iYKBLdfxP55pgXO5X1g';
    dlBtn.target = '_blank';
    dlBtn.rel = 'noopener';
    dlBtn.style.cssText = 'display:inline-flex;align-items:center;padding:6px 14px;border-radius:8px;font-size:13px;font-weight:600;color:#fff;background:rgba(108,76,178,.88);text-decoration:none;letter-spacing:.3px;transition:background .18s ease;';
    dlBtn.onmouseenter = () => { dlBtn.style.background = 'rgba(124,93,255,.95)'; };
    dlBtn.onmouseleave = () => { dlBtn.style.background = 'rgba(108,76,178,.88)'; };
    const closeBtn = document.createElement('div');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'width:30px;height:30px;display:flex;align-items:center;justify-content:center;border-radius:8px;cursor:pointer;font-size:15px;color:#6a5e7e;background:rgba(139,111,209,.10);';
    closeBtn.onmouseenter = () => { closeBtn.style.background = 'rgba(139,111,209,.22)'; };
    closeBtn.onmouseleave = () => { closeBtn.style.background = 'rgba(139,111,209,.10)'; };
    closeBtn.onclick = () => closeHistory();
    header.appendChild(hTitle);
    header.appendChild(dlBtn);
    header.appendChild(closeBtn);
    card.appendChild(header);

    // 主体两栏：左列表 + 右内容
    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex:1;min-height:0;';
    const listPane = document.createElement('div');
    listPane.style.cssText = 'width:230px;flex-shrink:0;border-right:1px solid rgba(139,111,209,.18);overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:4px;';
    const contentPane = document.createElement('div');
    contentPane.style.cssText = 'flex:1;min-width:0;overflow-y:auto;padding:18px 22px;color:#3a2d4d;word-break:break-word;';
    contentPane.innerHTML = '<div class="md-body"><p style="color:#9a8eae;font-size:13px;">请选择左侧的历史版本查看更新内容。</p></div>';
    ensureMdStyle();
    body.appendChild(listPane);
    body.appendChild(contentPane);
    card.appendChild(body);
    ov.appendChild(card);
    document.body.appendChild(ov);

    requestAnimationFrame(() => { ov.style.opacity = '1'; card.style.transform = 'scale(1)'; });
    ov.addEventListener('click', (e) => { if (e.target === ov) closeHistory(); });

    function closeHistory(): void {
      ov.style.opacity = '0';
      ov.style.pointerEvents = 'none'; // 淡出期间禁用点击，避免透明层短暂拦截
      card.style.transform = 'scale(.96)';
      setTimeout(() => ov.remove(), 180);
    }

    // 载入文件列表
    ipcRenderer.invoke('settings:list-changelogs').then((list: any[]) => {
      listPane.innerHTML = '';
      if (!list || !list.length) {
        const empty = document.createElement('div');
        empty.textContent = '未找到历史版本文件';
        empty.style.cssText = 'padding:12px;font-size:12px;color:#9a8eae;';
        listPane.appendChild(empty);
        return;
      }
      list.forEach((item) => {
        const row = document.createElement('div');
        row.style.cssText = 'padding:9px 11px;border-radius:9px;cursor:pointer;font-size:13px;color:#4a3d5e;transition:background .12s;';
        row.textContent = item.title || item.name;
        row.onmouseenter = () => { if (row.dataset.active !== '1') row.style.background = 'rgba(139,111,209,.10)'; };
        row.onmouseleave = () => { if (row.dataset.active !== '1') row.style.background = 'transparent'; };
        row.onclick = () => {
          listPane.querySelectorAll('[data-active="1"]').forEach((el) => {
            (el as HTMLElement).style.background = 'transparent';
            (el as HTMLElement).dataset.active = '0';
          });
          row.dataset.active = '1';
          row.style.background = 'rgba(139,111,209,.20)';
          contentPane.innerHTML = '<div class="md-body"><p style="color:#9a8eae;">加载中…</p></div>';
          contentPane.scrollTop = 0;
          ipcRenderer.invoke('settings:read-changelog', item.name).then((res: any) => {
            if (res && res.ok) {
              contentPane.innerHTML = renderMarkdown(res.content);
              contentPane.scrollTop = 0;
            } else {
              contentPane.innerHTML = '<div class="md-body"><p style="color:#c0504d;">读取失败：' + escapeHtml(String((res && res.error) || '未知错误')) + '</p></div>';
            }
          }).catch((err: any) => {
            contentPane.innerHTML = '<div class="md-body"><p style="color:#c0504d;">读取失败：' + escapeHtml(String(err)) + '</p></div>';
          });
        };
        listPane.appendChild(row);
      });
    }).catch((err: any) => {
      listPane.innerHTML = '';
      const e = document.createElement('div');
      e.textContent = '加载失败：' + String(err);
      e.style.cssText = 'padding:12px;font-size:12px;color:#c0504d;';
      listPane.appendChild(e);
    });
  }

  /** [新] 创建设置面板(挂到 body, 打开时定位到侧栏区域)
   *  设计原则: 固定宽度不撑栏(340px)、高对比度文字、紧凑分组、可扩展 */
  function buildSettingsPanel(): void {
    if (document.getElementById('fnos-settings-panel')) return;

    // 通用小按钮(用于操作行/MPV路径等)
    const mkBtn = (text: string, small = false): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      if (small) {
        b.style.cssText = 'padding:7px 12px;border-radius:9px;cursor:pointer;font-size:11.5px;font-weight:600;'
          + 'background:var(--fnos-ui-btn-bg)!important;color:var(--fnos-ui-btn-text);border:1px solid var(--fnos-ui-border-strong);'
          + 'transition:background .15s;';
        b.onmouseenter = () => { b.style.background = 'var(--fnos-ui-btn-hover)!important'; };
        b.onmouseleave = () => { b.style.background = 'var(--fnos-ui-btn-bg)!important'; };
      } else {
        b.style.cssText = 'flex:1;padding:9px 10px;border-radius:9px;cursor:pointer;font-size:12px;font-weight:600;'
          + 'background:var(--fnos-ui-btn-bg2)!important;color:var(--fnos-ui-btn-text);border:1px solid var(--fnos-ui-border3);'
          + 'transition:background .15s;';
        b.onmouseenter = () => { b.style.background = 'var(--fnos-ui-btn-hover2)!important'; };
        b.onmouseleave = () => { b.style.background = 'var(--fnos-ui-btn-bg2)!important'; };
      }
      return b;
    };

    // 分组卡片
    const section = (titleText?: string): { el: HTMLElement; body: HTMLElement } => {
      const d = document.createElement('div');
      let css = 'border-radius:12px;background:var(--fnos-ui-input-bg)!important;'
        + 'border:1px solid var(--fnos-ui-border3);overflow:hidden;display:flex;flex-direction:column;';
      if (titleText !== undefined) {
        css += 'margin-bottom:10px;'; // 带标题的分组有底部间距
      }
      d.style.cssText = css;

      // 可选分组标题
      if (titleText) {
        const t = document.createElement('div');
        t.textContent = titleText;
        t.style.cssText = 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;'
          + 'color:var(--fnos-ui-sec);padding:9px 12px 6px;border-bottom:1px solid var(--fnos-ui-border2);flex:none;';
        d.appendChild(t);
      }

      // 内容容器
      const body = document.createElement('div');
      body.style.cssText = 'padding:10px 12px;flex:1 1 auto;display:flex;flex-direction:column;';
      d.appendChild(body);
      return { el: d, body };
    };

    // ===== 主面板 =====
    const overlay = document.createElement('div');
    overlay.id = 'fnos-settings-panel';
    overlay.setAttribute('data-fnos-ui', '1'); // 保护自建设备 UI 不被白底清除器误清(含内部卡片底色)
    overlay.style.cssText = 'position:fixed;z-index:2147483600;display:none;flex-direction:column;width:min(680px,calc(100vw - 80px));'
      + 'max-height:calc(100vh - 120px);overflow:hidden;color:var(--fnos-ui-text);font-size:12.5px;line-height:1.45;'
      + 'background:var(--fnos-ui-panel-bg)!important;'
      + 'backdrop-filter:blur(30px) saturate(150%);-webkit-backdrop-filter:blur(30px) saturate(150%);'
      + 'box-shadow:0 18px 50px rgba(80,60,120,.28),0 4px 16px rgba(80,60,120,.14),inset 0 1px 0 rgba(255,255,255,.6);'
      + 'border-radius:18px;border:1px solid var(--fnos-ui-border-outer);'
      // 飞牛导航栏带 -webkit-app-region:drag; 若面板不声明 no-drag, 覆盖在导航栏上方时点击会被系统当成拖拽窗口吞掉
      + '-webkit-app-region:no-drag;app-region:no-drag;';
    overlay.addEventListener('click', (e: Event) => e.stopPropagation());

    // 极淡模态遮罩: 点击遮罩任意处即可关闭面板(兜底 —— 即便右上角叉被某层遮挡/事件被吞也能关)
    const mask = document.createElement('div');
    mask.id = 'fnos-settings-mask';
    mask.style.cssText = 'position:fixed;inset:0;z-index:2147483599;display:none;'
      + 'background:rgba(18,14,28,.22);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);'
      + '-webkit-app-region:no-drag;app-region:no-drag;';
    const closeSettingsPanel = (): void => {
      overlay.style.display = 'none';
      mask.style.display = 'none';
    };
    mask.addEventListener('click', () => closeSettingsPanel());
    // ESC 键关闭(兜底)
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && overlay.style.display === 'flex') closeSettingsPanel();
    });

    // 头部(标题+关闭)
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:15px 16px 12px;'
      + 'border-bottom:1px solid var(--fnos-ui-border);flex-shrink:0;';
    const title = document.createElement('span');
    title.textContent = '⚙ 设置';
    title.style.cssText = 'font-size:15px;font-weight:700;color:var(--fnos-ui-text);letter-spacing:.3px;';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    // 放大点击热区(36×36)并加大字号, 解决"关闭按钮难点击"; 抬升 z-index + 强制可点, 防被遮挡
    closeBtn.style.cssText = 'position:relative;z-index:2;width:36px;height:36px;flex-shrink:0;box-sizing:border-box;'
      + 'border-radius:10px;cursor:pointer;pointer-events:auto;font-size:16px;font-weight:700;'
      + 'background:var(--fnos-ui-btn-bg)!important;color:var(--fnos-ui-btn-text2);border:1px solid var(--fnos-ui-border-strong);display:flex;'
      + 'align-items:center;justify-content:center;transition:all .15s;line-height:1;'
      // 防止父层/飞牛导航栏的 drag 区域把点击当窗口拖拽吞掉
      + '-webkit-app-region:no-drag!important;app-region:no-drag!important;';
    // 直接赋值 onclick(最稳) + addEventListener(捕获阶段) + pointerdown 兜底; 命中即关闭面板
    closeBtn.onclick = (e: Event) => { if (e) e.stopPropagation(); closeSettingsPanel(); };
    closeBtn.addEventListener('click', (e: Event) => { e.stopPropagation(); closeSettingsPanel(); }, true);
    closeBtn.addEventListener('pointerdown', (e: Event) => { e.stopPropagation(); closeSettingsPanel(); });
    closeBtn.onmouseenter = () => { closeBtn.style.background = 'rgba(240,90,90,.85)!important'; closeBtn.style.color = '#fff'; closeBtn.style.border = '1px solid rgba(240,90,90,.5)'; };
    closeBtn.onmouseleave = () => { closeBtn.style.background = 'var(--fnos-ui-btn-bg2)!important'; closeBtn.style.color = 'var(--fnos-ui-btn-text2)'; closeBtn.style.border = '1px solid var(--fnos-ui-border-strong)'; };
    header.appendChild(title); header.appendChild(closeBtn);
    overlay.appendChild(header);

    // ===== 主体布局：左侧分类导航(30%) + 右侧内容区(70%) =====
    // 结构: overlay(flex column) -> header / bodyRow(flex:1) -> leftNav(30%) + rightContent(flex:1)
    const bodyRow = document.createElement('div');
    bodyRow.style.cssText = 'display:flex;flex:1 1 auto;min-height:0;';
    const leftNav = document.createElement('div');
    leftNav.style.cssText = 'flex:0 0 30%;max-width:200px;min-width:130px;overflow-y:auto;'
      + 'border-right:1px solid var(--fnos-ui-border);padding:10px 8px;display:flex;flex-direction:column;gap:5px;'
      + 'background:var(--fnos-ui-nav-bg, rgba(125,110,160,.06));';
    const rightContent = document.createElement('div');
    rightContent.style.cssText = 'flex:1 1 auto;min-width:0;overflow-y:auto;padding:14px 16px 16px;';
    bodyRow.appendChild(leftNav);
    bodyRow.appendChild(rightContent);
    overlay.appendChild(bodyRow);

    // 调试日志(独立卡片; 从「退出行为」卡片迁出, 见下方 debug 块)
    const secDebug = section('调试日志');
    const secDebugBody = secDebug.body;

    // ===== 分组1: 开关选项 =====
    const sec1 = section('功能开关');
    const secBody1 = sec1.body;
    secBody1.style.cssText = 'padding:10px 12px;flex:1 1 auto;display:flex;flex-direction:column;';

    const addToggle = (label: string): HTMLInputElement => {
      // 用 label 包裹文字+勾选框：点整行（文字或方框）都能切换，且只触发一次 change，
      // 避免"点了文字但 checkbox 没切换"导致设置看似没保存（lc-140 修复）。
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 6px;'
        + 'cursor:pointer;border-radius:6px;transition:background .12s;';
      row.onmouseenter = () => { row.style.background = 'var(--fnos-ui-row-hover)'; };
      row.onmouseleave = () => { row.style.background = 'transparent'; };
      const span = document.createElement('span');
      span.textContent = label;
      span.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;';
      const sw = document.createElement('input');
      sw.type = 'checkbox';
      sw.style.cssText = 'width:38px;height:21px;cursor:pointer;accent-color:var(--fnos-ui-accent);';
      row.appendChild(span); row.appendChild(sw);
      secBody1.appendChild(row);
      return sw;
    };
    const swProxy = addToggle('下载代理');
    const swHide = addToggle('隐藏原始播放按钮');
    const swNas = addToggle('NAS 本地网盘代理');
    const swBoxless = addToggle('关闭详情页选集/演职人员背景框');
    const swWheel = addToggle('鼠标滚轮横向滚动');
    swProxy.addEventListener('change', () => { log('[开关保存] swProxy=' + swProxy.checked); ipcRenderer.invoke('settings:set-download-proxy', swProxy.checked).catch((e) => log('set-download-proxy failed', e)); });
    swHide.addEventListener('change', () => { log('[开关保存] swHide=' + swHide.checked); ipcRenderer.invoke('settings:set-hide-play', swHide.checked).catch((e) => log('set-hide-play failed', e)); });
    swNas.addEventListener('change', () => { log('[开关保存] swNas=' + swNas.checked); ipcRenderer.invoke('settings:set-nas-proxy', swNas.checked).catch((e) => log('set-nas-proxy failed', e)); });
    swBoxless.addEventListener('change', () => {
      _detailBoxless = swBoxless.checked;
      log('[开关保存] swBoxless=' + swBoxless.checked);
      ipcRenderer.invoke('settings:set-detail-boxless', swBoxless.checked).catch((e) => log('set-detail-boxless failed', e));
      // 立即对当前详情页生效（无需等下次导航/MutationObserver 触发）
      if (isDetailPage()) applyDetailLiquidGlass();
    });
    // 鼠标滚轮横向滚动：开启=竖向滚轮在横向容器内转左右滑动；关闭=恢复飞牛原生（鼠标只上下滚）
    swWheel.checked = _wheelHScrollEnabled;
    swWheel.addEventListener('change', () => {
      _wheelHScrollEnabled = swWheel.checked;
      log('[开关保存] swWheel=' + swWheel.checked);
      ipcRenderer.invoke('settings:set-wheel-hscroll', swWheel.checked).catch((e) => log('set-wheel-hscroll failed', e));
      // 立即应用：开启→重新绑定劫持；关闭→解绑并恢复飞牛原生横滑箭头
      wheelToScroll();
    });
    // [v400] 主题模式: 浅色 / 深色 / 跟随系统 三选一(同步飞牛原生主题 + 持久化)
    const themeRow = document.createElement('div');
    themeRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 6px;gap:10px;';
    const themeLabel = document.createElement('span');
    themeLabel.textContent = '主题模式';
    themeLabel.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;white-space:nowrap;';
    const seg = document.createElement('div');
    seg.style.cssText = 'display:inline-flex;background:var(--fnos-ui-input-bg);border-radius:9px;padding:3px;gap:2px;flex-shrink:0;';
    const themeModes: [UiThemeMode, string][] = [['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']];
    const themeBtns: HTMLButtonElement[] = [];
    themeModes.forEach(([mode, text]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.dataset.mode = mode;
      b.style.cssText = 'border:none;cursor:pointer;font-size:11.5px;font-weight:600;padding:5px 9px;border-radius:7px;'
        + 'background:transparent;color:var(--fnos-ui-btn-text);transition:all .15s;white-space:nowrap;';
      b.addEventListener('click', (e: Event) => { e.stopPropagation(); setUiTheme(mode); if (_refreshThemeSeg) _refreshThemeSeg(); });
      seg.appendChild(b);
      themeBtns.push(b);
    });
    const refreshThemeSeg = (): void => {
      const cur = getUiTheme();
      themeBtns.forEach((b) => {
        const on = b.dataset.mode === cur;
        b.style.background = on ? 'var(--fnos-ui-exit-on)' : 'transparent';
        b.style.color = on ? '#fff' : 'var(--fnos-ui-btn-text)';
      });
    };
    _refreshThemeSeg = refreshThemeSeg;
    refreshThemeSeg();
    themeRow.appendChild(themeLabel);
    themeRow.appendChild(seg);
    secBody1.appendChild(themeRow);

    // ===== 底部操作栏：更新相关操作（2×2 等宽栅格，清晰对齐）=====
    const updFooter = document.createElement('div');
    updFooter.style.cssText = 'padding:12px;flex-shrink:0;';
    const updDivider = document.createElement('div');
    updDivider.style.cssText = 'height:1px;background:var(--fnos-ui-border);margin:0 0 10px;';
    updFooter.appendChild(updDivider);

    const updGrid = document.createElement('div');
    updGrid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;';
    const updBtn = mkBtn('检查更新', true);
    const updHistoryBtn = mkBtn('历史版本', true);
    // [lc-474] 一键应用热补丁：应用内直接拉取并填补小 bug 修复，不跳浏览器手动下载
    const patchBtn = mkBtn('应用补丁', true);
    // [lc-481] 开发者测试更新：点击需输入解锁码，验证通过后从 Gitee 拉取 -test 补丁并应用（普通用户无码，永远拿不到）
    const testBtn = mkBtn('测试更新', true);
    // [lc-511] 回滚补丁：清除已应用补丁覆盖并重启回原版
    const rollbackBtn = mkBtn('回滚补丁', true);
    updGrid.appendChild(updBtn);
    updGrid.appendChild(updHistoryBtn);
    updGrid.appendChild(patchBtn);
    updGrid.appendChild(testBtn);
    updGrid.appendChild(rollbackBtn);
    updFooter.appendChild(updGrid);

    const testHint = document.createElement('div');
    testHint.textContent = '🔧 测试更新：开发者测试通道，需解锁码（普通用户无需操作）';
    testHint.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-muted);opacity:.75;text-align:center;margin-top:9px;line-height:1.5;';
    updFooter.appendChild(testHint);

    sec1.el.appendChild(updFooter);
    updBtn.addEventListener('click', (e: Event) => { e.stopPropagation(); ipcRenderer.invoke('settings:check-update'); });
    updHistoryBtn.addEventListener('click', (e: Event) => { e.stopPropagation(); openHistoryModal(); });
    patchBtn.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        fntvOpenPatchApplyPopup(false);
    });
    // [lc-516] 设置面板「应用补丁」与更新弹窗共用模块级 fntvOpenPatchApplyPopup（不依赖 injectSettingsUI 时机）。
    testBtn.addEventListener('click', async (e: Event) => {
        e.stopPropagation();
        if (testBtn.disabled) return;
        const code = await promptUnlockCode();
        if (code === null) return; // 用户取消
        openTestPatchWizard(code);
    });
    // [lc-511] 回滚补丁：调用主进程清除补丁覆盖并重启回原版
    rollbackBtn.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        ipcRenderer.invoke('settings:rollback-patch');
    });

    // [lc-474] 轻量提示条（应用补丁结果反馈，2.4s 后自动消失）
    function showPatchToast(msg: string): void {
        let t = document.getElementById('fntv-patch-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'fntv-patch-toast';
            t.style.cssText = 'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:99999;'
                + 'max-width:80vw;padding:8px 14px;border-radius:8px;font-size:12px;line-height:1.5;'
                + 'background:rgba(20,22,30,.92);color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.4);'
                + 'pointer-events:none;opacity:0;transition:opacity .25s;white-space:pre-wrap;text-align:center;';
            document.body.appendChild(t);
        }
        t.textContent = msg;
        requestAnimationFrame(() => { if (t) t.style.opacity = '1'; });
        setTimeout(() => { if (t) t.style.opacity = '0'; }, 2400);
    }

    // [lc-481] 解锁码输入弹窗：返回输入的解锁码；用户取消返回 null。复用现有 modal 样式；可重复调用（resolve 用模块级变量避免重复绑定）。
    let _unlockResolve: ((v: string | null) => void) | null = null;
    function promptUnlockCode(): Promise<string | null> {
        return new Promise((resolve) => {
            let modal = document.getElementById('fntv-unlock-modal') as HTMLElement | null;
            if (!modal) {
                modal = document.createElement('div');
                modal.id = 'fntv-unlock-modal';
                modal.setAttribute('data-fnos-ui', '1'); // 免疫白底清除器
                modal.style.cssText = 'position:fixed;z-index:2147483703;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.5);';
                modal.addEventListener('click', (e: Event) => {
                    if (e.target === modal) { modal!.remove(); if (_unlockResolve) { _unlockResolve(null); _unlockResolve = null; } }
                });

                const card = document.createElement('div');
                card.style.cssText = 'width:300px;border-radius:16px;padding:20px;color:var(--fnos-ui-text);'
                    + 'background:var(--fnos-ui-panel-bg)!important;border:1px solid var(--fnos-ui-border-outer);'
                    + 'box-shadow:0 18px 50px rgba(80,60,120,.28),0 4px 16px rgba(80,60,120,.14);'
                    + 'backdrop-filter:blur(30px) saturate(150%);-webkit-backdrop-filter:blur(30px) saturate(150%);text-align:center;';
                card.innerHTML = ''
                    + '<div style="font-size:16px;font-weight:800;color:var(--fnos-ui-pill-text);margin-bottom:4px;">🔧 开发者测试更新</div>'
                    + '<div style="font-size:12px;line-height:1.6;color:var(--fnos-ui-text);opacity:.8;margin-bottom:14px;">请输入解锁码以获取 Gitee 测试补丁</div>';

                const input = document.createElement('input');
                input.type = 'password';
                input.placeholder = '解锁码';
                input.id = 'fntv-unlock-input';
                input.style.cssText = 'width:100%;box-sizing:border-box;padding:9px 12px;border-radius:9px;font-size:13px;'
                    + 'background:var(--fnos-ui-input-bg);color:var(--fnos-ui-text);border:1px solid var(--fnos-ui-border);outline:none;';
                card.appendChild(input);

                const row = document.createElement('div');
                row.style.cssText = 'display:flex;gap:8px;margin-top:16px;';
                const cancelBtn = document.createElement('button');
                cancelBtn.type = 'button';
                cancelBtn.textContent = '取消';
                cancelBtn.style.cssText = 'flex:1;padding:9px 0;border:none;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;'
                    + 'background:var(--fnos-ui-input-bg);color:var(--fnos-ui-btn-text);';
                const okBtn = document.createElement('button');
                okBtn.type = 'button';
                okBtn.textContent = '确定';
                okBtn.style.cssText = 'flex:1;padding:9px 0;border:none;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;'
                    + 'background:var(--fnos-ui-pill-bg)!important;color:var(--fnos-ui-pill-text);border:1px solid var(--fnos-ui-pill-border);';
                row.appendChild(cancelBtn);
                row.appendChild(okBtn);
                card.appendChild(row);
                modal.appendChild(card);
                document.body.appendChild(modal);

                const doClose = (val: string | null) => { modal!.remove(); if (_unlockResolve) { _unlockResolve(val); _unlockResolve = null; } };
                cancelBtn.addEventListener('click', (e: Event) => { e.stopPropagation(); doClose(null); });
                okBtn.addEventListener('click', (e: Event) => { e.stopPropagation(); doClose(input.value); });
                input.addEventListener('keydown', (e: KeyboardEvent) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') doClose(input.value);
                    else if (e.key === 'Escape') doClose(null);
                });
            }
            _unlockResolve = resolve;
            modal.style.display = 'flex';
            const inp = modal.querySelector('#fntv-unlock-input') as HTMLInputElement | null;
            if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 50); }
        });
    }

    // [lc-483] 热补丁「应用补丁」向导弹窗：
    // 打开即实时检查 → 有更新显示版本号+「立即应用」→ 点击后实时下载进度 → 应用完立即重启/重载。
    // 单例 modal，用户关闭即 remove() 并从 DOM 移除（下次打开重建并重新检查），进度事件通过 settings:patch-progress 实时驱动。
    // [lc-485] 分层关闭：关掉本向导只移除自身，回到设置面板这一层（遮罩仍在）；彻底退出由设置面板自身关闭(点遮罩/ESC/关闭按钮)处理。

    // [lc-516] openPatchWizard/closePatchWizard 已提升为模块级 fntvOpenPatchApplyPopup（见文件顶部），此处不再保留嵌套版本。

    // [lc-492] 开发者测试更新「选择 + 应用」向导弹窗：
    // 解锁码验证通过 → 实时列出 Gitee 上所有 -test 测试补丁 → 用户选择版本 → 点「立即应用」实时下载/应用 → 应用完重启/重载。
    // 与 openPatchWizard 同源设计，但走 settings:list-test-patches / settings:apply-test-patch(带版本)。
    // 关闭即退出设置面板（一次性任务流，避免「关了向导还有一层遮罩」）。
    let _testWizardModal: HTMLElement | null = null;
    let _testProgHandler: ((_e: any, p: any) => void) | null = null;
    let _lastTestCode = '';
    let _testSelectedVersion: string | null = null;

    function openTestPatchWizard(code: string): void {
        _lastTestCode = code;
        if (!_testWizardModal) {
            const modal = document.createElement('div');
            modal.id = 'fntv-test-wizard';
            modal.setAttribute('data-fnos-ui', '1'); // 免疫白底清除器
            modal.style.cssText = 'position:fixed;z-index:2147483705;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.5);';
            modal.addEventListener('click', (e: Event) => {
                // 仅非进行中状态允许点遮罩关闭；下载/应用中禁止
                if (e.target === modal && modal.getAttribute('data-closable') === '1') closeTestPatchWizard();
            });
            const card = document.createElement('div');
            card.style.cssText = 'width:360px;border-radius:16px;padding:22px;color:var(--fnos-ui-text);'
                + 'background:var(--fnos-ui-panel-bg)!important;border:1px solid var(--fnos-ui-border-outer);'
                + 'box-shadow:0 18px 50px rgba(80,60,120,.28),0 4px 16px rgba(80,60,120,.14);'
                + 'backdrop-filter:blur(30px) saturate(150%);-webkit-backdrop-filter:blur(30px) saturate(150%);text-align:center;';
            const body = document.createElement('div');
            body.id = 'fntv-test-body';
            card.appendChild(body);
            modal.appendChild(card);
            document.body.appendChild(modal);
            _testWizardModal = modal;
        }
        _testWizardModal.style.display = 'flex';
        _testWizardModal.setAttribute('data-closable', '1');
        renderTestState('listing', null);
        ipcRenderer.invoke('settings:list-test-patches', code).then((res: any) => {
            if (res && res.ok) {
                const patches: any[] = (res.patches || []).filter((p: any) => p && p.hasAsset);
                if (patches.length > 0) renderTestState('select', { patches });
                else renderTestState('empty', { message: 'Gitee 暂无带补丁包的 -test 测试版' });
            } else {
                renderTestState('error', { message: (res && res.message) || '检测失败' });
            }
        }).catch((err: any) => {
            renderTestState('error', { message: '检测失败: ' + ((err && err.message) || err) });
        });
    }

    function closeTestPatchWizard(): void {
        if (_testWizardModal) { _testWizardModal.remove(); _testWizardModal = null; }
        if (_testProgHandler) { ipcRenderer.removeListener('settings:patch-progress', _testProgHandler); _testProgHandler = null; }
        closeSettingsPanel();
    }

    // 测试补丁向导渲染：listing / select / empty / error / downloading / applying / done
    function renderTestState(state: string, info: any): void {
        const modal = _testWizardModal;
        if (!modal) return;
        const body = modal.querySelector('#fntv-test-body') as HTMLElement;
        if (!body) return;
        const closable = (state === 'listing' || state === 'select' || state === 'empty' || state === 'error');
        modal.setAttribute('data-closable', closable ? '1' : '0');
        body.innerHTML = '';

        if (state === 'listing') {
            body.appendChild(spinnerEl());
            body.appendChild(centerText('正在检测测试补丁列表…', '14px', 'var(--fnos-ui-text)', 'margin-top:14px;font-weight:600;'));
            return;
        }
        if (state === 'empty') {
            body.appendChild(centerText('📭', '24px', 'var(--fnos-ui-muted)', 'margin-bottom:6px;'));
            body.appendChild(centerText('暂无可用测试补丁', '15px', 'var(--fnos-ui-text)', 'font-weight:700;margin-bottom:6px;'));
            body.appendChild(centerText((info && info.message) || 'Gitee 上未发布带补丁包的 -test 版本', '11.5px', 'var(--fnos-ui-muted)', 'opacity:.8;margin-bottom:16px;'));
            body.appendChild(actionRow([{ label: '关闭', primary: true, onClick: () => closeTestPatchWizard() }]));
            return;
        }
        if (state === 'error') {
            body.appendChild(centerText('⚠', '24px', '#ff7a7a', 'font-weight:800;margin-bottom:6px;'));
            body.appendChild(centerText('出错了', '15px', 'var(--fnos-ui-text)', 'font-weight:700;margin-bottom:8px;'));
            body.appendChild(centerText((info && info.message) || '未知错误', '12px', 'var(--fnos-ui-muted)', 'opacity:.85;line-height:1.6;margin-bottom:16px;word-break:break-word;'));
            body.appendChild(actionRow([
                { label: '重试', primary: false, onClick: () => { if (_testWizardModal) _testWizardModal.style.display = 'none'; openTestPatchWizard(_lastTestCode); } },
                { label: '关闭', primary: true, onClick: () => closeTestPatchWizard() },
            ]));
            return;
        }
        if (state === 'select') {
            const patches: any[] = (info && info.patches) || [];
            _testSelectedVersion = patches.length ? patches[0].version : null; // 默认选最新
            body.appendChild(centerText('🔧 开发者测试补丁', '16px', 'var(--fnos-ui-pill-text)', 'font-weight:800;margin-bottom:4px;'));
            body.appendChild(centerText('选择要应用的测试版本', '11.5px', 'var(--fnos-ui-muted)', 'opacity:.8;margin-bottom:12px;'));
            const list = document.createElement('div');
            list.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-height:200px;overflow-y:auto;margin-bottom:14px;';
            const btns: HTMLButtonElement[] = [];
            patches.forEach((p: any, idx: number) => {
                const item = document.createElement('button');
                item.type = 'button';
                item.textContent = 'v' + p.version;
                item.style.cssText = 'width:100%;padding:9px 12px;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;text-align:left;'
                    + (idx === 0
                        ? 'background:var(--fnos-ui-pill-bg)!important;color:var(--fnos-ui-pill-text);border:1px solid var(--fnos-ui-pill-border);'
                        : 'background:var(--fnos-ui-input-bg);color:var(--fnos-ui-text);border:1px solid var(--fnos-ui-border);');
                item.addEventListener('click', (e: Event) => {
                    e.stopPropagation();
                    _testSelectedVersion = p.version;
                    btns.forEach((b, i) => {
                        const sel = i === idx;
                        b.style.background = sel ? 'var(--fnos-ui-pill-bg)!important' : 'var(--fnos-ui-input-bg)';
                        b.style.color = sel ? 'var(--fnos-ui-pill-text)' : 'var(--fnos-ui-text)';
                        b.style.border = sel ? '1px solid var(--fnos-ui-pill-border)' : '1px solid var(--fnos-ui-border)';
                    });
                });
                btns.push(item);
                list.appendChild(item);
            });
            body.appendChild(list);
            body.appendChild(actionRow([
                { label: '取消', primary: false, onClick: () => closeTestPatchWizard() },
                { label: '立即应用', primary: true, onClick: () => startTestApply() },
            ]));
            return;
        }
        if (state === 'downloading' || state === 'applying' || state === 'done') {
            const pct = (info && typeof info.percent === 'number') ? info.percent : -1;
            const track = document.createElement('div');
            track.style.cssText = 'height:8px;border-radius:6px;background:var(--fnos-ui-input-bg);overflow:hidden;margin:6px 0 8px;';
            const fill = document.createElement('div');
            const done = state === 'done';
            const indeterminate = pct < 0 && !done;
            fill.style.cssText = 'height:100%;border-radius:6px;transition:width .25s;'
                + 'background:var(--fnos-ui-pill-bg)!important;'
                + (done ? 'width:100%;' : indeterminate ? 'width:40%;animation:fnosPatchIndet 1.1s infinite ease-in-out;' : `width:${pct}%;`);
            track.appendChild(fill);
            body.appendChild(track);
            const pctText = state === 'downloading'
                ? (pct >= 0 ? `正在下载… ${pct}%` : '正在下载…')
                : state === 'applying' ? '正在应用补丁…'
                : '✓ 测试补丁已应用';
            body.appendChild(centerText(pctText, '13px', done ? 'var(--fnos-ui-accent)' : 'var(--fnos-ui-text)', 'font-weight:600;margin-bottom:4px;'));
            if (indeterminate || pct >= 0) {
                const sub = document.createElement('div');
                sub.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-muted);opacity:.7;';
                if (info && info.total && info.total > 0) {
                    const fmt = (n: number) => (n / 1024).toFixed(0) + ' KB';
                    sub.textContent = `${fmt(info.loaded || 0)} / ${fmt(info.total)}`;
                } else {
                    sub.textContent = done ? '即将重启应用使补丁生效' : '下载中，请稍候…';
                }
                body.appendChild(sub);
            }
            if (done) {
                body.appendChild(centerText('应用即将重启 / 重载…', '11px', 'var(--fnos-ui-muted)', 'opacity:.7;margin-top:6px;'));
            }
            return;
        }
    }

    function startTestApply(): void {
        const code = _lastTestCode;
        const version = _testSelectedVersion;
        if (!version) { renderTestState('error', { message: '未选择测试版本' }); return; }
        renderTestState('downloading', { percent: 0, message: '正在下载…' });
        _testProgHandler = (_e: any, p: any) => {
            if (!p) return;
            if (p.phase === 'downloading' || p.phase === 'applying' || p.phase === 'done') {
                renderTestState(p.phase, p);
            } else if (p.phase === 'error') {
                renderTestState('error', { message: p.message || '应用失败' });
            }
        };
        ipcRenderer.on('settings:patch-progress', _testProgHandler);
        ipcRenderer.invoke('settings:apply-test-patch', code, version).then((res: any) => {
            if (_testProgHandler) { ipcRenderer.removeListener('settings:patch-progress', _testProgHandler); _testProgHandler = null; }
            if (res && res.ok) {
                renderTestState('done', res); // 应用进程随后会重载/重启，无需手动关闭
            } else {
                renderTestState('error', { message: (res && res.message) || '应用失败' });
            }
        }).catch((err: any) => {
            if (_testProgHandler) { ipcRenderer.removeListener('settings:patch-progress', _testProgHandler); _testProgHandler = null; }
            renderTestState('error', { message: '应用失败: ' + ((err && err.message) || err) });
        });
    }

    // [lc-516] renderPatchState/startPatchApply 已提升为模块级 fntvRenderPatchApply/fntvStartPatchApply（见文件顶部）。

    // 小工具：居中文字
    function centerText(text: string, size: string, color: string, extra = ''): HTMLElement {
        const d = document.createElement('div');
        d.textContent = text;
        d.style.cssText = `font-size:${size};color:${color};${extra}`;
        return d;
    }
    // 小工具：按钮行
    function actionRow(actions: Array<{ label: string; primary: boolean; onClick: () => void }>): HTMLElement {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;';
        for (const a of actions) {
            const b = mkBtn(a.label, !a.primary);
            if (a.primary) {
                b.style.cssText = 'flex:1;padding:9px 0;border:none;border-radius:9px;font-size:13px;font-weight:700;cursor:pointer;'
                    + 'background:var(--fnos-ui-pill-bg)!important;color:var(--fnos-ui-pill-text);border:1px solid var(--fnos-ui-pill-border);';
            }
            b.addEventListener('click', (e: Event) => { e.stopPropagation(); a.onClick(); });
            row.appendChild(b);
        }
        return row;
    }
    // 小工具：旋转 spinner
    function spinnerEl(): HTMLElement {
        const s = document.createElement('div');
        s.style.cssText = 'width:30px;height:30px;margin:2px auto 0;border-radius:50%;'
            + 'border:3px solid var(--fnos-ui-border);border-top-color:var(--fnos-ui-pill-bg);'
            + 'animation:fnosPatchSpin .8s linear infinite;';
        return s;
    }
    // 注入 keyframes（仅一次）
    if (!document.getElementById('fntv-patch-kf')) {
        const st = document.createElement('style');
        st.id = 'fntv-patch-kf';
        st.textContent = '@keyframes fnosPatchSpin{to{transform:rotate(360deg)}}'
            + '@keyframes fnosPatchIndet{0%{margin-left:0}50%{margin-left:55%}100%{margin-left:0}}';
        document.head.appendChild(st);
    }


    /* 布局统一在末尾 layout 区追加 */

    // ===== 分组2: MPV 路径 =====
    const sec2 = section('播放器');
    const secBody2 = sec2.body;

    // 双栏布局：左=MPV，右=PotPlayer（窄屏自动折叠为单栏）
    const playerCols = document.createElement('div');
    playerCols.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(248px,1fr));gap:16px;margin-top:4px;';
    const colMpv = document.createElement('div');
    colMpv.style.cssText = 'min-width:0;display:flex;flex-direction:column;gap:8px;';
    const colPot = document.createElement('div');
    colPot.style.cssText = 'min-width:0;display:flex;flex-direction:column;gap:8px;padding-left:16px;border-left:1px solid var(--fnos-ui-border2);';
    const subHead = (text: string): HTMLElement => {
        const d = document.createElement('div');
        d.textContent = text;
        d.style.cssText = 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--fnos-ui-sec);margin-bottom:2px;';
        return d;
    };
    colMpv.appendChild(subHead('MPV'));
    colPot.appendChild(subHead('PotPlayer'));
    playerCols.appendChild(colMpv);
    playerCols.appendChild(colPot);
    secBody2.appendChild(playerCols);

    const mpvLabel = document.createElement('div');
    mpvLabel.textContent = 'MPV 路径（留空则使用应用内置）';
    mpvLabel.style.cssText = 'color:var(--fnos-ui-muted);font-size:11.5px;margin:0 0 5px;';
    colMpv.appendChild(mpvLabel);

    const mpvPath = document.createElement('div');
    mpvPath.id = 'fnos-mpv-path';
    mpvPath.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-muted2);word-break:break-all;margin-bottom:7px;min-height:28px;'
      + 'max-height:72px;overflow-y:auto;padding:6px 9px;background:var(--fnos-ui-input-bg);border-radius:7px;'
      + 'border:1px solid var(--fnos-ui-border);line-height:1.5;';
    mpvPath.textContent = '应用内置（已随安装包分发，无需本机安装）'; // 初始占位, 不依赖 _refresh 回填
    colMpv.appendChild(mpvPath);

    const mpvBtns = document.createElement('div');
    mpvBtns.style.cssText = 'display:flex;gap:6px;';
    const pickBtn = mkBtn('选择文件', true);
    const clearBtn = mkBtn('清空', true);
    const iccToggleBtn = mkBtn('ICC 校色：开', true);
    iccToggleBtn.style.fontWeight = '600';
    iccToggleBtn.style.color = 'var(--fnos-ui-accent)';
    mpvBtns.appendChild(pickBtn); mpvBtns.appendChild(clearBtn); mpvBtns.appendChild(iccToggleBtn);
    colMpv.appendChild(mpvBtns);
    pickBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      const p = await ipcRenderer.invoke('settings:pick-mpv-path');
      if (p) mpvPath.textContent = p as string;
    });
    clearBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      await ipcRenderer.invoke('settings:clear-mpv-path');
      mpvPath.textContent = '应用内置（已随安装包分发，无需本机安装）';
    });

    // ===== 默认 MPV 着色器（由应用面板管理 MPV 启动默认，MPV 内 Ctrl+1~9 仍可临时切换）=====
    const shaderLabel = document.createElement('div');
    shaderLabel.textContent = '默认 MPV 着色器';
    shaderLabel.style.cssText = 'color:var(--fnos-ui-muted);font-size:11.5px;margin:12px 0 5px;';
    colMpv.appendChild(shaderLabel);

    const shaderSel = document.createElement('select');
    shaderSel.id = 'fnos-mpv-shader';
    shaderSel.style.cssText = 'width:100%;font-size:12px;color:var(--fnos-ui-text);background:var(--fnos-ui-input-bg);'
      + 'border:1px solid var(--fnos-ui-border);border-radius:7px;padding:6px 8px;cursor:pointer;';
    const shaderOptions: [string, string][] = [
      ['off', '默认不生效任何着色器'],
      ['a', '模式A（大多数1080p动画）'],
      ['b', '模式B（大多数720p动画）'],
      ['aa', '模式A+A（高质量1080p）'],
      ['bb', '模式B+B（高质量720p）'],
      ['lite', '轻量模式（低配置设备）'],
      ['denoise', '仅降噪'],
      ['real', '真实系（真人/纪录片）'],
      ['cinema', '电影感'],
      ['ultra', '全增强（极致画质）']
    ];
    shaderOptions.forEach(([k, label]) => {
      const o = document.createElement('option');
      o.value = k; o.textContent = label;
      shaderSel.appendChild(o);
    });
    colMpv.appendChild(shaderSel);

    const applyShaderConfig = (): void => {
      const iccOn = iccToggleBtn.textContent?.includes('开') ?? false;
      ipcRenderer.invoke('settings:set-mpv-shader-config', { shader: shaderSel.value, icc: iccOn })
        .catch((err) => log('set-mpv-shader-config failed', err));
    };
    const renderIccBtn = (on: boolean): void => {
      iccToggleBtn.textContent = on ? 'ICC 校色：开' : 'ICC 校色：关';
      iccToggleBtn.style.color = on ? 'var(--fnos-ui-accent)' : 'var(--fnos-ui-muted2)';
    };
    shaderSel.addEventListener('change', applyShaderConfig);
    iccToggleBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      const nowOn = !(iccToggleBtn.textContent?.includes('开') ?? false);
      renderIccBtn(nowOn);
      applyShaderConfig();
    });

    // ===== PotPlayer 路径 =====
    const potLabel = document.createElement('div');
    potLabel.textContent = 'PotPlayer 路径（留空则使用应用内置）';
    potLabel.style.cssText = 'color:var(--fnos-ui-muted);font-size:11.5px;margin:0 0 5px;';
    colPot.appendChild(potLabel);

    const potPathEl = document.createElement('div');
    potPathEl.id = 'fnos-pot-path';
    potPathEl.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-muted2);word-break:break-all;margin-bottom:7px;min-height:28px;'
      + 'max-height:72px;overflow-y:auto;padding:6px 9px;background:var(--fnos-ui-input-bg);border-radius:7px;'
      + 'border:1px solid var(--fnos-ui-border);line-height:1.5;';
    potPathEl.textContent = '应用内置（已随安装包分发，无需本机安装）'; // 初始占位, 不依赖 _refresh 回填
    colPot.appendChild(potPathEl);

    const potBtns = document.createElement('div');
    potBtns.style.cssText = 'display:flex;gap:6px;';
    const pickPotBtn = mkBtn('选择文件', true);
    const clearPotBtn = mkBtn('清空', true);
    potBtns.appendChild(pickPotBtn); potBtns.appendChild(clearPotBtn);
    colPot.appendChild(potBtns);
    pickPotBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      const p = await ipcRenderer.invoke('settings:pick-pot-path');
      if (p) potPathEl.textContent = p as string;
    });
    clearPotBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      await ipcRenderer.invoke('settings:clear-pot-path');
      potPathEl.textContent = '应用内置（已随安装包分发，无需本机安装）';
    });

    // ===== 默认播放器（直接播放时使用）=====
    const defLabel = document.createElement('div');
    defLabel.textContent = '默认播放器（直接播放时使用）';
    defLabel.style.cssText = 'color:var(--fnos-ui-muted);font-size:11.5px;margin:10px 0 5px;';
    colPot.appendChild(defLabel);

    const defGrid = document.createElement('div');
    defGrid.style.cssText = 'display:grid;grid-template-columns:repeat(2,1fr);gap:5px;';
    const defModes: [string, string][] = [['mpv', '内置 MPV'], ['potplayer', 'PotPlayer']];
    const defEls: HTMLButtonElement[] = [];
    defModes.forEach(([mode, text]) => {
      const b = mkBtn(text);
      b.dataset.dmode = mode;
      b.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        (overlay as any)._defaultPlayer = mode;
        refreshDefaultPlayer();
        ipcRenderer.invoke('settings:set-default-player', mode).catch((err) => log('set-default-player failed', err));
      });
      defGrid.appendChild(b); defEls.push(b);
    });
    colPot.appendChild(defGrid);

    const refreshDefaultPlayer = (): void => {
      const cur = (overlay as any)._defaultPlayer || 'mpv';
      defEls.forEach((b) => {
        const on = b.dataset.dmode === cur;
        b.style.background = on ? 'var(--fnos-ui-btn-hover2)!important' : 'var(--fnos-ui-btn-bg2)!important';
        b.style.borderColor = on ? 'var(--fnos-ui-accent)!important' : 'var(--fnos-ui-border3)';
      });
    };

    /* 布局统一在末尾 layout 区追加 */

    // ===== 分组3: 退出行为 =====
    const sec3 = section('退出行为');
    const secBody3 = sec3.body;
    secBody3.style.cssText = 'padding:10px 12px;flex:1 1 auto;display:flex;flex-direction:column;';

    const exitModes: [string, string][] = [['direct', '直接退出'], ['minimize', '最小化到托盘'], ['ask', '每次询问']];
    const exitEls: HTMLButtonElement[] = [];
    const exitGrid = document.createElement('div');
    exitGrid.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:5px;';
    exitModes.forEach(([mode, text]) => {
      const b = mkBtn(text);
      b.dataset.mode = mode;
      b.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        // 立即本地更新高亮(乐观), IPC 后台执行不阻塞 UI → 修复"选择后没反应/卡"
        (overlay as any)._exitMode = mode;
        refreshExit();
        ipcRenderer.invoke('settings:set-exit-mode', mode).catch((err) => log('set-exit-mode failed', err));
      });
      exitGrid.appendChild(b); exitEls.push(b);
    });
    secBody3.appendChild(exitGrid);

    // ===== [lc-120] 登录页背景图自定义 =====
    const loginBgWrap = document.createElement('div');
    loginBgWrap.style.cssText = 'margin-top:12px;padding-top:10px;border-top:1px solid var(--fnos-ui-border2);';
    const loginBgLabel = document.createElement('div');
    loginBgLabel.textContent = '登录页背景图';
    loginBgLabel.style.cssText = 'font-size:10.5px;font-weight:600;color:var(--fnos-ui-sec);margin-bottom:8px;';
    loginBgWrap.appendChild(loginBgLabel);

    // 两个按钮：自定义登录页面背景图 / 清空（点选即生效，无需手动输路径）
    const loginBgBtns = document.createElement('div');
    loginBgBtns.style.cssText = 'display:flex;gap:6px;';
    const pickLoginBgBtn = mkBtn('自定义登录页面背景图', true);
    const clearLoginBgBtn = mkBtn('清空', true);
    loginBgBtns.appendChild(pickLoginBgBtn);
    loginBgBtns.appendChild(clearLoginBgBtn);
    loginBgWrap.appendChild(loginBgBtns);

    pickLoginBgBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      const p = await ipcRenderer.invoke('settings:pick-login-bg');
      if (p) applyLoginBgVar(p);
    });
    clearLoginBgBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      await ipcRenderer.invoke('settings:clear-login-bg');
      applyLoginBgVar('');
    });

    secBody3.appendChild(loginBgWrap);
    /* 布局统一在末尾 layout 区追加 */

    // ===== 分组: B站弹幕登录 =====
    const secBili = section('B站弹幕登录');
    const secBodyBili = secBili.body;

    const biliStatus = document.createElement('div');
    biliStatus.style.cssText = 'font-size:11.5px;color:var(--fnos-ui-warn);margin-bottom:8px;';
    secBodyBili.appendChild(biliStatus);

    // 按钮行：扫码登录 / 退出登录 / 保存 Cookie（与豆瓣左半部分按钮行同款样式）
    const biliBtns = document.createElement('div');
    biliBtns.style.cssText = 'display:flex;gap:6px;margin-top:6px;';
    const scanBtn = mkBtn('扫码登录', true);
    const logoutBiliBtn = mkBtn('退出登录', true);
    const saveBiliCookieBtn = mkBtn('保存 Cookie', true);
    biliBtns.appendChild(scanBtn); biliBtns.appendChild(logoutBiliBtn); biliBtns.appendChild(saveBiliCookieBtn);
    secBodyBili.appendChild(biliBtns);

    // 手动粘贴 Cookie（兜底：B站风控/扫码失效时用），与豆瓣左半部分 manualWrap 同款
    const biliManualWrap = document.createElement('div');
    biliManualWrap.style.cssText = 'margin-top:8px;';
    const biliManualLabel = document.createElement('div');
    biliManualLabel.textContent = '手动粘贴 Cookie（B站风控/扫码失效时用）';
    biliManualLabel.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-muted);margin-bottom:4px;';
    biliManualWrap.appendChild(biliManualLabel);
    const biliManualTa = document.createElement('input');
    biliManualTa.type = 'text';
    biliManualTa.placeholder = '粘贴浏览器里 B站的 Cookie 字符串（含 SESSDATA 等）';
    biliManualTa.style.cssText = 'width:100%;height:32px;font-size:10.5px;color:var(--fnos-ui-text);background:var(--fnos-ui-input-bg);'
      + 'border:1px solid var(--fnos-ui-border);border-radius:7px;padding:6px 8px;box-sizing:border-box;';
    biliManualWrap.appendChild(biliManualTa);
    secBodyBili.appendChild(biliManualWrap);

    // MPV B站弹幕搜索开关（联动 MPV uosc_danmaku 的 script-opts/uosc_danmaku.conf）
    const biliSearchRow = document.createElement('div');
    biliSearchRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 6px;margin-top:4px;'
      + 'cursor:pointer;border-radius:6px;transition:background .12s;';
    biliSearchRow.onmouseenter = () => { biliSearchRow.style.background = 'var(--fnos-ui-row-hover)'; };
    biliSearchRow.onmouseleave = () => { biliSearchRow.style.background = 'transparent'; };
    const biliSearchLabel = document.createElement('span');
    biliSearchLabel.textContent = '启用 MPV B站弹幕搜索';
    biliSearchLabel.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;';
    const swMpvBiliSearch = document.createElement('input');
    swMpvBiliSearch.type = 'checkbox';
    swMpvBiliSearch.style.cssText = 'width:38px;height:21px;cursor:pointer;accent-color:var(--fnos-ui-accent);';
    biliSearchRow.appendChild(biliSearchLabel); biliSearchRow.appendChild(swMpvBiliSearch);
    secBodyBili.appendChild(biliSearchRow);
    swMpvBiliSearch.addEventListener('change', () => {
      ipcRenderer.invoke('settings:set-mpv-bili-search-enabled', swMpvBiliSearch.checked).catch((err) => log('set-mpv-bili-search-enabled failed', err));
    });

    // B站弹幕聚合阈值（单个视频弹幕 < 此值时，自动合并多个同类候选的弹幕）
    const aggRow = document.createElement('div');
    aggRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 6px;margin-top:4px;gap:10px;';
    const aggLabel = document.createElement('span');
    aggLabel.textContent = '弹幕聚合阈值（单视频弹幕少于此数则合并多个源）';
    aggLabel.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;font-size:12.5px;flex:1;line-height:1.4;';
    const aggInput = document.createElement('input');
    aggInput.type = 'number';
    aggInput.min = '0';
    aggInput.step = '100';
    aggInput.placeholder = '1500';
    aggInput.style.cssText = 'width:90px;padding:5px 8px;border-radius:7px;border:1px solid var(--fnos-ui-border);'
      + 'background:var(--fnos-input-bg);color:var(--fnos-ui-text);font-size:13px;text-align:center;';
    aggRow.appendChild(aggLabel); aggRow.appendChild(aggInput);
    secBodyBili.appendChild(aggRow);
    aggInput.addEventListener('change', () => {
      const v = parseInt(aggInput.value, 10);
      ipcRenderer.invoke('settings:set-mpv-bili-aggregate-threshold', isNaN(v) ? 0 : v).catch((err) => log('set-mpv-bili-aggregate-threshold failed', err));
    });

    // [lc-301] 「打开弹幕文件夹」按钮已移至下方「弹幕设置」区（secDanmaku），此处不再重复。

    /* 布局统一在末尾 layout 区追加 */

    // ===== 分组: Bangumi 登录（与「B站弹幕登录」并列，容器同尺寸）=====
    const secBangumi = section('Bangumi 登录');
    const secBodyBangumi = secBangumi.body;

    let bangumiReal = ''; // 真实 token（仅存于闭包，界面只显示掩码星号）
    const maskBangumi = (t: string): string => '*'.repeat(Math.max(0, t.length));

    const bangumiHintTop = document.createElement('div');
    bangumiHintTop.style.cssText = 'font-size:11.5px;color:var(--fnos-ui-sub);margin-bottom:8px;line-height:1.5;';
    bangumiHintTop.textContent = '填入你的 Bangumi Access Token 以启用 Bangumi 关联功能。';
    secBodyBangumi.appendChild(bangumiHintTop);

    // 单行 token 输入框
    const bangumiInput = document.createElement('input');
    bangumiInput.type = 'text';
    bangumiInput.placeholder = '粘贴 Bangumi Access Token';
    bangumiInput.style.cssText = 'width:100%;height:32px;font-size:11px;color:var(--fnos-ui-text);'
      + 'background:var(--fnos-ui-input-bg);border:1px solid var(--fnos-ui-border);border-radius:7px;'
      + 'padding:6px 8px;box-sizing:border-box;';
    secBodyBangumi.appendChild(bangumiInput);

    // 已保存时显示星号掩码；点击进入编辑自动清空，便于重新粘贴
    bangumiInput.addEventListener('focus', () => {
      if (bangumiInput.readOnly) { bangumiInput.readOnly = false; bangumiInput.value = ''; }
    });
    bangumiInput.addEventListener('blur', () => {
      if (bangumiInput.value.trim() === '' && bangumiReal) {
        bangumiInput.value = maskBangumi(bangumiReal);
        bangumiInput.readOnly = true;
      }
    });

    const bangumiBtns = document.createElement('div');
    bangumiBtns.style.cssText = 'display:flex;gap:6px;margin-top:8px;';
    const saveBangumiBtn = mkBtn('保存', true);
    const clearBangumiBtn = mkBtn('清除', true);
    bangumiBtns.appendChild(saveBangumiBtn);
    bangumiBtns.appendChild(clearBangumiBtn);
    secBodyBangumi.appendChild(bangumiBtns);

    const bangumiStatus = document.createElement('div');
    bangumiStatus.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);margin-top:6px;min-height:14px;';
    secBodyBangumi.appendChild(bangumiStatus);

    // Bangumi 集数级同步开关
    const bangumiSyncRow = document.createElement('div');
    bangumiSyncRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 6px;margin-top:4px;'
      + 'cursor:pointer;border-radius:6px;transition:background .12s;';
    bangumiSyncRow.onmouseenter = () => { bangumiSyncRow.style.background = 'var(--fnos-ui-row-hover)'; };
    bangumiSyncRow.onmouseleave = () => { bangumiSyncRow.style.background = 'transparent'; };
    const bangumiSyncLabel = document.createElement('span');
    bangumiSyncLabel.textContent = '启用 Bangumi 集数同步';
    bangumiSyncLabel.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;';
    const swBangumiSync = document.createElement('input');
    swBangumiSync.type = 'checkbox';
    swBangumiSync.style.cssText = 'width:38px;height:21px;cursor:pointer;accent-color:var(--fnos-ui-accent);';
    bangumiSyncRow.appendChild(bangumiSyncLabel); bangumiSyncRow.appendChild(swBangumiSync);
    secBodyBangumi.appendChild(bangumiSyncRow);
    swBangumiSync.addEventListener('change', () => {
      ipcRenderer.invoke('settings:set-bangumi-sync-enabled', swBangumiSync.checked).catch((err) => log('set-bangumi-sync-enabled failed', err));
    });

    // 同步阈值（百分比，默认80）
    const bangumiThrRow = document.createElement('div');
    bangumiThrRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 6px;'
      + 'border-radius:6px;transition:background .12s;';
    const bangumiThrLabel = document.createElement('span');
    bangumiThrLabel.textContent = '同步阈值（播放进度 %）';
    bangumiThrLabel.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;font-size:11.5px;';
    const bangumiThresholdInput = document.createElement('input');
    bangumiThresholdInput.type = 'number';
    bangumiThresholdInput.min = '1'; bangumiThresholdInput.max = '100';
    bangumiThresholdInput.style.cssText = 'width:56px;height:26px;font-size:11px;color:var(--fnos-ui-text);'
      + 'background:var(--fnos-ui-input-bg);border:1px solid var(--fnos-ui-border);border-radius:6px;'
      + 'padding:2px 6px;box-sizing:border-box;text-align:center;';
    bangumiThrRow.appendChild(bangumiThrLabel); bangumiThrRow.appendChild(bangumiThresholdInput);
    secBodyBangumi.appendChild(bangumiThrRow);
    bangumiThresholdInput.addEventListener('change', () => {
      const v = Number(bangumiThresholdInput.value) || 80;
      ipcRenderer.invoke('settings:set-bangumi-sync-threshold', v).catch((err) => log('set-bangumi-sync-threshold failed', err));
    });

    // 底部提示：点击链接用系统浏览器打开获取页
    const bangumiHintBottom = document.createElement('div');
    bangumiHintBottom.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-muted);margin-top:10px;line-height:1.5;';
    const bangumiLink = document.createElement('a');
    bangumiLink.textContent = 'https://next.bgm.tv/demo/access-token';
    bangumiLink.href = 'https://next.bgm.tv/demo/access-token';
    bangumiLink.style.cssText = 'color:var(--fnos-ui-sec);text-decoration:underline;cursor:pointer;';
    bangumiLink.addEventListener('click', (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      ipcRenderer.invoke('settings:open-external', 'https://next.bgm.tv/demo/access-token').catch(() => {});
    });
    bangumiHintBottom.appendChild(document.createTextNode('可在 '));
    bangumiHintBottom.appendChild(bangumiLink);
    bangumiHintBottom.appendChild(document.createTextNode(' 获取 Access Token。'));
    secBodyBangumi.appendChild(bangumiHintBottom);

    saveBangumiBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      // 防误清空：掩码态(readOnly)直接保存已存真实 token；若输入框被点击进入编辑态
      // 但并未填入新值（focus 已自动清空掩码），保存应保留已存 token，而不是写空串把
      // 磁盘上的旧 token 抹掉。真正清空请用「清除」按钮。
      let token: string;
      if (bangumiInput.readOnly) {
        token = bangumiReal;
      } else {
        const typed = bangumiInput.value.trim();
        token = (typed === '' && bangumiReal) ? bangumiReal : typed;
      }
      try {
        const r: any = await ipcRenderer.invoke('settings:set-bangumi-token', token);
        if (!r || r.ok !== false) {
          bangumiReal = token;
          if (token) {
            bangumiInput.value = maskBangumi(token);
            bangumiInput.readOnly = true;
            bangumiStatus.textContent = '已保存 Token';
            bangumiStatus.style.color = 'var(--fnos-ui-ok)';
          } else {
            bangumiInput.value = '';
            bangumiInput.readOnly = false;
            bangumiStatus.textContent = '已清除 Token';
            bangumiStatus.style.color = 'var(--fnos-ui-warn)';
          }
        } else {
          bangumiStatus.textContent = '保存失败';
          bangumiStatus.style.color = 'var(--fnos-ui-warn)';
        }
      } catch {
        bangumiStatus.textContent = '保存失败';
        bangumiStatus.style.color = 'var(--fnos-ui-warn)';
      }
    });
    clearBangumiBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      bangumiInput.value = '';
      bangumiInput.readOnly = false;
      bangumiReal = '';
      try {
        await ipcRenderer.invoke('settings:set-bangumi-token', '');
        bangumiStatus.textContent = '已清除 Token';
        bangumiStatus.style.color = 'var(--fnos-ui-warn)';
      } catch {
        bangumiStatus.textContent = '清除失败';
        bangumiStatus.style.color = 'var(--fnos-ui-warn)';
      }
    });
    /* 布局统一在末尾 layout 区追加 */

    // ===== 分组: TMDB API Key（用于「热门剧更新」浮层的 TMDB 电影/剧集数据源）=====
    const secTmdb = section('TMDB API Key');
    const secBodyTmdb = secTmdb.body;

    let tmdbReal = ''; // 真实 key（仅存于闭包，界面只显示掩码星号）
    const maskTmdb = (t: string): string => '*'.repeat(Math.max(0, t.length));

    const tmdbHintTop = document.createElement('div');
    tmdbHintTop.style.cssText = 'font-size:11.5px;color:var(--fnos-ui-sub);margin-bottom:8px;line-height:1.5;';
    tmdbHintTop.textContent = '填入你的 TMDB API Key（或 v4 Read Access Token）以启用「热门剧更新」中的 TMDB 电影/剧集数据源。';
    secBodyTmdb.appendChild(tmdbHintTop);

    // 单行 key 输入框
    const tmdbInput = document.createElement('input');
    tmdbInput.type = 'text';
    tmdbInput.placeholder = '粘贴 TMDB API Key / Read Access Token';
    tmdbInput.style.cssText = 'width:100%;height:32px;font-size:11px;color:var(--fnos-ui-text);'
      + 'background:var(--fnos-ui-input-bg);border:1px solid var(--fnos-ui-border);border-radius:7px;'
      + 'padding:6px 8px;box-sizing:border-box;';
    secBodyTmdb.appendChild(tmdbInput);

    tmdbInput.addEventListener('focus', () => {
      if (tmdbInput.readOnly) { tmdbInput.readOnly = false; tmdbInput.value = ''; }
    });
    tmdbInput.addEventListener('blur', () => {
      if (tmdbInput.value.trim() === '' && tmdbReal) {
        tmdbInput.value = maskTmdb(tmdbReal);
        tmdbInput.readOnly = true;
      }
    });

    const tmdbBtns = document.createElement('div');
    tmdbBtns.style.cssText = 'display:flex;gap:6px;margin-top:8px;';
    const saveTmdbBtn = mkBtn('保存', true);
    const clearTmdbBtn = mkBtn('清除', true);
    tmdbBtns.appendChild(saveTmdbBtn);
    tmdbBtns.appendChild(clearTmdbBtn);
    secBodyTmdb.appendChild(tmdbBtns);

    const tmdbStatus = document.createElement('div');
    tmdbStatus.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);margin-top:6px;min-height:14px;';
    secBodyTmdb.appendChild(tmdbStatus);

    // 底部提示：引导去 TMDB 申请
    const tmdbHintBottom = document.createElement('div');
    tmdbHintBottom.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-muted);margin-top:10px;line-height:1.5;';
    const tmdbLink = document.createElement('a');
    tmdbLink.textContent = 'https://www.themoviedb.org/settings/api';
    tmdbLink.href = 'https://www.themoviedb.org/settings/api';
    tmdbLink.style.cssText = 'color:var(--fnos-ui-sec);text-decoration:underline;cursor:pointer;';
    tmdbLink.addEventListener('click', (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      ipcRenderer.invoke('settings:open-external', 'https://www.themoviedb.org/settings/api').catch(() => {});
    });
    tmdbHintBottom.appendChild(document.createTextNode('可在 '));
    tmdbHintBottom.appendChild(tmdbLink);
    tmdbHintBottom.appendChild(document.createTextNode(' 免费申请 API Key。'));
    secBodyTmdb.appendChild(tmdbHintBottom);

    saveTmdbBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      // 防误清空：同 Bangumi——掩码态保存已存真实 key；编辑态清空未填新值时保留已存 key。
      let key: string;
      if (tmdbInput.readOnly) {
        key = tmdbReal;
      } else {
        const typed = tmdbInput.value.trim();
        key = (typed === '' && tmdbReal) ? tmdbReal : typed;
      }
      try {
        const r: any = await ipcRenderer.invoke('settings:set-tmdb-key', key);
        if (!r || r.ok !== false) {
          tmdbReal = key;
          if (key) {
            tmdbInput.value = maskTmdb(key);
            tmdbInput.readOnly = true;
            tmdbStatus.textContent = '已保存 TMDB Key';
            tmdbStatus.style.color = 'var(--fnos-ui-ok)';
          } else {
            tmdbInput.value = '';
            tmdbInput.readOnly = false;
            tmdbStatus.textContent = '已清除 TMDB Key';
            tmdbStatus.style.color = 'var(--fnos-ui-warn)';
          }
        } else {
          tmdbStatus.textContent = '保存失败';
          tmdbStatus.style.color = 'var(--fnos-ui-warn)';
        }
      } catch {
        tmdbStatus.textContent = '保存失败';
        tmdbStatus.style.color = 'var(--fnos-ui-warn)';
      }
    });
    clearTmdbBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      tmdbInput.value = '';
      tmdbInput.readOnly = false;
      tmdbReal = '';
      try {
        await ipcRenderer.invoke('settings:set-tmdb-key', '');
        tmdbStatus.textContent = '已清除 TMDB Key';
        tmdbStatus.style.color = 'var(--fnos-ui-warn)';
      } catch {
        tmdbStatus.textContent = '清除失败';
        tmdbStatus.style.color = 'var(--fnos-ui-warn)';
      }
    });

    // ===== TMDB 免梯子直连（实验）：用固定 IP 覆盖 DNS 解析，绕过污染直连，无需梯子 =====
    // （此区块整体迁入设置面板「插件」标签页，见下方 secTmdbDirect，故此处不再挂到 TMDB Key 区）
    const dcWrap = document.createElement('div');
    dcWrap.style.cssText = 'margin-top:4px;';

    const dcDesc = document.createElement('div');
    dcDesc.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);line-height:1.5;margin-bottom:8px;';
    dcDesc.textContent = '开启后用固定 IP 覆盖 DNS 解析，绕过污染直连 TMDB（无需梯子）。IP 来自 CheckTMDB 项目，CDN 边缘节点可能变动，可点「更新 IP」拉取最新，或手动填写。';
    dcWrap.appendChild(dcDesc);

    const dcRow = document.createElement('label');
    dcRow.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;color:var(--fnos-ui-text);cursor:pointer;margin-bottom:8px;';
    const dcToggle = document.createElement('input');
    dcToggle.type = 'checkbox';
    dcToggle.style.cssText = 'width:16px;height:16px;cursor:pointer;';
    const dcToggleLabel = document.createElement('span');
    dcToggleLabel.textContent = '启用免梯子直连';
    dcRow.appendChild(dcToggle);
    dcRow.appendChild(dcToggleLabel);
    dcWrap.appendChild(dcRow);

    const dcIpGrid = document.createElement('div');
    dcIpGrid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;';
    const dcApiInput = document.createElement('input');
    dcApiInput.type = 'text';
    dcApiInput.placeholder = 'api IP（如 65.8.20.79）';
    dcApiInput.style.cssText = 'width:100%;height:30px;font-size:11px;color:var(--fnos-ui-text);';
    const dcImgInput = document.createElement('input');
    dcImgInput.type = 'text';
    dcImgInput.placeholder = 'img IP（如 65.8.20.8）';
    dcImgInput.style.cssText = 'width:100%;height:30px;font-size:11px;color:var(--fnos-ui-text);';
    dcIpGrid.appendChild(dcApiInput);
    dcIpGrid.appendChild(dcImgInput);
    dcWrap.appendChild(dcIpGrid);

    const dcBtns = document.createElement('div');
    dcBtns.style.cssText = 'display:flex;gap:6px;';
    const dcSaveBtn = mkBtn('保存', true);
    const dcUpdateBtn = mkBtn('从 CheckTMDB 更新 IP', true);
    dcBtns.appendChild(dcSaveBtn);
    dcBtns.appendChild(dcUpdateBtn);
    dcWrap.appendChild(dcBtns);

    const dcStatus = document.createElement('div');
    dcStatus.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);margin-top:6px;min-height:14px;';
    dcWrap.appendChild(dcStatus);

    dcSaveBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      try {
        const api = dcApiInput.value.trim();
        const img = dcImgInput.value.trim();
        const r: any = await ipcRenderer.invoke('settings:set-tmdb-direct', {
          enabled: dcToggle.checked,
          ip: { api: api || undefined, img: img || undefined },
        });
        if (!r || r.ok !== false) {
          dcStatus.textContent = dcToggle.checked ? '已启用免梯子直连' : '已关闭免梯子直连';
          dcStatus.style.color = 'var(--fnos-ui-ok)';
        } else {
          dcStatus.textContent = '保存失败';
          dcStatus.style.color = 'var(--fnos-ui-warn)';
        }
      } catch {
        dcStatus.textContent = '保存失败';
        dcStatus.style.color = 'var(--fnos-ui-warn)';
      }
    });
    dcUpdateBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      dcStatus.textContent = '正在从 CheckTMDB 拉取最新 IP…';
      dcStatus.style.color = 'var(--fnos-ui-sub)';
      try {
        const r: any = await ipcRenderer.invoke('tmdb:update-ip');
        if (r && r.ok) {
          if (r.api) dcApiInput.value = r.api;
          if (r.img) dcImgInput.value = r.img;
          dcStatus.textContent = '已更新为最新 IP' + (r.api ? `（api ${r.api}）` : '');
          dcStatus.style.color = 'var(--fnos-ui-ok)';
        } else {
          dcStatus.textContent = (r && r.error) || '更新失败';
          dcStatus.style.color = 'var(--fnos-ui-warn)';
        }
      } catch {
        dcStatus.textContent = '更新失败';
        dcStatus.style.color = 'var(--fnos-ui-warn)';
      }
    });

    // ===== 数据源切换：TMDB / 豆瓣（默认豆瓣，国内直连免 Key）=====
    const tmdbSettingsWrap = document.createElement('div');
    tmdbSettingsWrap.appendChild(tmdbHintTop);
    tmdbSettingsWrap.appendChild(tmdbInput);
    tmdbSettingsWrap.appendChild(tmdbBtns);
    tmdbSettingsWrap.appendChild(tmdbStatus);
    tmdbSettingsWrap.appendChild(tmdbHintBottom);

    const dsHint = document.createElement('div');
    dsHint.style.cssText = 'font-size:11.5px;color:var(--fnos-ui-sub);line-height:1.5;margin-bottom:8px;';
    dsHint.textContent = '选择「热门剧更新」浮层的数据源。豆瓣国内直连、免 Key、零配置；TMDB 数据更全但需 Key 且可能被墙（需免梯子直连/代理）。';

    const dsSeg = document.createElement('div');
    dsSeg.style.cssText = 'display:flex;gap:6px;margin-bottom:10px;';
    const mkDsBtn = (label: string, val: 'tmdb' | 'douban'): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.style.cssText = 'flex:1;height:30px;font-size:12px;border-radius:7px;cursor:pointer;border:1px solid var(--fnos-ui-border);background:var(--fnos-ui-input-bg);color:var(--fnos-ui-text);';
      b.addEventListener('click', (e: Event) => { e.stopPropagation(); setDs(val); });
      return b;
    };
    const dsTmdbBtn = mkDsBtn('TMDB', 'tmdb');
    const dsDoubanBtn = mkDsBtn('豆瓣', 'douban');
    dsSeg.appendChild(dsTmdbBtn);
    dsSeg.appendChild(dsDoubanBtn);

    const doubanHint = document.createElement('div');
    doubanHint.style.cssText = 'font-size:11.5px;color:var(--fnos-ui-ok);line-height:1.5;margin-bottom:8px;';
    doubanHint.textContent = '✓ 已选豆瓣：国内直连、免 Key、零配置，无需任何额外设置。「热门剧更新」浮层将展示豆瓣热门影视。';

    // 仅刷新 UI 显示（不写盘）：用于构建/打开时按「磁盘真值」回填，避免用默认/内存旧值覆盖已保存选择
    const reflectDs = (val: 'tmdb' | 'douban'): void => {
      const isDouban = val === 'douban';
      dsDoubanBtn.style.background = isDouban ? 'var(--fnos-ui-sec)' : 'var(--fnos-ui-input-bg)';
      dsDoubanBtn.style.color = isDouban ? '#fff' : 'var(--fnos-ui-text)';
      dsTmdbBtn.style.background = isDouban ? 'var(--fnos-ui-input-bg)' : 'var(--fnos-ui-sec)';
      dsTmdbBtn.style.color = isDouban ? 'var(--fnos-ui-text)' : '#fff';
      tmdbSettingsWrap.style.display = isDouban ? 'none' : '';
      doubanHint.style.display = isDouban ? '' : 'none';
    };

    // 用户点击选择数据源：写盘 + 同步内存 + 刷新 UI
    const setDs = (val: 'tmdb' | 'douban'): void => {
      _hotSource = val;
      try { ipcRenderer.invoke('settings:set-hot-source', val).catch(() => {}); } catch { /* ignore */ }
      reflectDs(val);
    };

    secBodyTmdb.insertBefore(dsHint, secBodyTmdb.firstChild);
    secBodyTmdb.appendChild(dsSeg);
    secBodyTmdb.appendChild(tmdbSettingsWrap);
    secBodyTmdb.appendChild(doubanHint);

    // 初始状态：异步从「磁盘真值」回填 UI（不写盘！）
    // 关键修复：此前这里用同步 setDs(_hotSource)，而 _hotSource 要到 settings:get 异步回填(行55)才就绪，
    // 构建期若早于回填执行，_hotSource 仍是默认 'douban'，会把磁盘上已存的 'tmdb' 错误写回 'douban'，
    // 表现为「选了 TMDB → 关掉设置/导航后变回豆瓣」。改为只读磁盘真值 reflect，杜绝启动期 clobber。
    try {
      ipcRenderer.invoke('settings:get-hot-source').then((s: string) => {
        _hotSource = (s === 'tmdb') ? 'tmdb' : 'douban';
        reflectDs(_hotSource);
      }).catch(() => { reflectDs(_hotSource); });
    } catch { reflectDs(_hotSource); }

    // ===== 分组: TMDB 免梯子直连（实验）（从账号同步的 TMDB API Key 区迁出，独立放入「插件」标签页）=====
    const secTmdbDirect = section('TMDB 免梯子直连（实验）');
    secTmdbDirect.el.style.gridColumn = '1 / -1'; // 内容较多，占满整行
    const secBodyTmdbDirect = secTmdbDirect.body;
    secBodyTmdbDirect.appendChild(dcWrap);

    // ===== 分组: 豆瓣同步 =====
    const secDouban = section('豆瓣同步');
    secDouban.el.style.gridColumn = '1 / -1'; // 豆瓣同步内容多，占满整行
    const secBodyDouban = secDouban.body;

    const doubanStatus = document.createElement('div');
    doubanStatus.style.cssText = 'font-size:11.5px;color:var(--fnos-ui-warn);margin-bottom:8px;';
    secBodyDouban.appendChild(doubanStatus);

    // 双栏布局：左=登录/账号，右=已观看同步（窄屏自动折叠为单栏）
    const doubanCols = document.createElement('div');
    doubanCols.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(248px,1fr));gap:16px;margin-top:8px;';
    const colLogin = document.createElement('div');
    colLogin.style.cssText = 'min-width:0;display:flex;flex-direction:column;gap:8px;';
    const colWatch = document.createElement('div');
    colWatch.style.cssText = 'min-width:0;display:flex;flex-direction:column;gap:8px;padding-left:16px;border-left:1px solid var(--fnos-ui-border2);';
    doubanCols.appendChild(colLogin);
    doubanCols.appendChild(colWatch);
    secBodyDouban.appendChild(doubanCols);

    // 总开关
    const addDoubanToggle = (label: string): HTMLInputElement => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 6px;'
        + 'cursor:pointer;border-radius:6px;transition:background .12s;';
      row.onmouseenter = () => { row.style.background = 'var(--fnos-ui-row-hover)'; };
      row.onmouseleave = () => { row.style.background = 'transparent'; };
      const span = document.createElement('span');
      span.textContent = label;
      span.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;';
      const sw = document.createElement('input');
      sw.type = 'checkbox';
      sw.style.cssText = 'width:38px;height:21px;cursor:pointer;accent-color:var(--fnos-ui-accent);';
      row.appendChild(span); row.appendChild(sw);
      colLogin.appendChild(row);
      return sw;
    };
    const swDouban = addDoubanToggle('启用豆瓣同步');
    swDouban.addEventListener('change', () => {
      ipcRenderer.invoke('settings:set-douban-enabled', swDouban.checked).catch((err) => log('set-douban-enabled failed', err));
    });

    // 登录按钮行
    const doubanBtns = document.createElement('div');
    doubanBtns.style.cssText = 'display:flex;gap:6px;margin-top:6px;';
    const scanDoubanBtn = mkBtn('扫码登录', true);
    const logoutDoubanBtn = mkBtn('退出登录', true);
    const manualBtn = mkBtn('保存 Cookie', true);
    doubanBtns.appendChild(scanDoubanBtn); doubanBtns.appendChild(logoutDoubanBtn); doubanBtns.appendChild(manualBtn);
    colLogin.appendChild(doubanBtns);

    scanDoubanBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      doubanStatus.textContent = '请在弹出的窗口中用豆瓣 App 扫码…';
      doubanStatus.style.color = 'var(--fnos-ui-sec)';
      try {
        const r: any = await ipcRenderer.invoke('douban:open-login');
        if (!r || !r.ok) doubanStatus.textContent = '打开登录窗口失败：' + ((r && r.msg) || '未知');
      } catch {
        doubanStatus.textContent = '打开登录窗口失败';
      }
    });
    logoutDoubanBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      await ipcRenderer.invoke('douban:logout');
      refreshDouban();
    });

    // 手动粘贴 Cookie（兜底）
    const manualWrap = document.createElement('div');
    manualWrap.style.cssText = 'margin-top:8px;';
    const manualLabel = document.createElement('div');
    manualLabel.textContent = '手动粘贴 Cookie（豆瓣风控/扫码失效时用）';
    manualLabel.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-muted);margin-bottom:4px;';
    manualWrap.appendChild(manualLabel);
    const manualTa = document.createElement('input');
    manualTa.type = 'text';
    manualTa.placeholder = '粘贴浏览器里豆瓣的 Cookie 字符串（含 dbcl2 等）';
    manualTa.style.cssText = 'width:100%;height:32px;font-size:10.5px;color:var(--fnos-ui-text);background:var(--fnos-ui-input-bg);'
      + 'border:1px solid var(--fnos-ui-border);border-radius:7px;padding:6px 8px;box-sizing:border-box;';
    manualWrap.appendChild(manualTa);
    manualBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      const r: any = await ipcRenderer.invoke('douban:manual-cookie', manualTa.value);
      if (r && r.ok) { manualTa.value = ''; refreshDouban(); }
      else doubanStatus.textContent = '保存失败：' + ((r && r.msg) || '未知');
    });
    colLogin.appendChild(manualWrap);

    // ===== 已观看列表 → 豆瓣"看过" 同步 =====
    const watchedWrap = document.createElement('div');
    watchedWrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
    const watchedTitle = document.createElement('div');
    watchedTitle.textContent = '已观看列表 → 豆瓣「看过」';
    watchedTitle.style.cssText = 'font-size:11px;font-weight:600;color:var(--fnos-ui-text);margin-bottom:6px;';
    watchedWrap.appendChild(watchedTitle);

    const watchedStatus = document.createElement('div');
    watchedStatus.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-sub);margin-bottom:6px;min-height:14px;line-height:1.5;';
    watchedStatus.textContent = '读取飞牛「已观看」列表，批量标记到豆瓣（已标记的会跳过，不重复打）。';
    watchedWrap.appendChild(watchedStatus);

    const syncBtn = mkBtn('立即同步已观看列表', true);
    syncBtn.addEventListener('click', async (e: Event) => {
        e.stopPropagation();
        syncBtn.setAttribute('disabled', 'true');
        watchedStatus.textContent = '正在扫描飞牛「已观看」列表…（需加载列表页，约 10 秒）';
        watchedStatus.style.color = 'var(--fnos-ui-sec)';
        const r: any = await (window as any).fnosScanWatched();
        syncBtn.removeAttribute('disabled');
        if (r && r.error) {
            watchedStatus.textContent = '同步失败：' + (r.error === 'timeout' ? '扫描超时' : r.error === 'busy' ? '上一次扫描仍在进行' : r.error);
            watchedStatus.style.color = 'var(--fnos-ui-warn)';
        } else if (r) {
            const note = r.note ? '（' + r.note + '）' : '';
            watchedStatus.textContent = `完成：共 ${r.total} 部，标记看过 ${r.marked}，跳过 ${r.skipped}，失败 ${r.failed}${note}`;
            watchedStatus.style.color = r.marked > 0 ? 'var(--fnos-ui-ok)' : 'var(--fnos-ui-sub)';
        }
    });
    watchedWrap.appendChild(syncBtn);

    // 自动同步间隔
    const autoRow = document.createElement('div');
    autoRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const autoLabel = document.createElement('span');
    autoLabel.textContent = '自动同步间隔(分钟, 0=关闭):';
    autoLabel.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-text);';
    const autoInput = document.createElement('input');
    autoInput.type = 'number';
    autoInput.min = '0';
    autoInput.step = '5';
    autoInput.style.cssText = 'width:64px;font-size:11px;color:var(--fnos-ui-text);background:var(--fnos-ui-input-bg);border:1px solid var(--fnos-ui-border);border-radius:6px;padding:4px 6px;';
    const autoSave = mkBtn('保存', true);
    autoSave.style.fontSize = '11px';
    autoRow.appendChild(autoLabel); autoRow.appendChild(autoInput); autoRow.appendChild(autoSave);
    watchedWrap.appendChild(autoRow);
    autoSave.addEventListener('click', async (e: Event) => {
        e.stopPropagation();
        const v = Math.max(0, Math.floor(Number(autoInput.value) || 0));
        const r: any = await ipcRenderer.invoke('douban:set-watched-scan-interval', v).catch(() => ({ ok: false }));
        if (r && r.ok) {
            watchedStatus.textContent = v > 0 ? `已设置每 ${v} 分钟自动同步一次（下限 10 分钟）` : '已关闭自动同步';
            watchedStatus.style.color = 'var(--fnos-ui-ok)';
        }
    });
    // 打开面板时回填当前间隔
    ipcRenderer.invoke('douban:get-watched-scan-interval').then((r: any) => {
        if (r && typeof r.interval === 'number') autoInput.value = String(r.interval);
    }).catch(() => {});
    colWatch.appendChild(watchedWrap);

    /* 布局统一在末尾 layout 区追加 */

    // ===== 通用小工具：滑块行（标签 + range + 实时数值）=====
    const addSlider = (
      labelText: string, min: number, max: number, step: number, value: number,
      fmt: (v: number) => string, onInput: (v: number) => void
    ): { row: HTMLElement; input: HTMLInputElement; valEl: HTMLElement } => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;flex-direction:column;gap:4px;padding:7px 6px;';
      const head = document.createElement('div');
      head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
      const span = document.createElement('span');
      span.textContent = labelText;
      span.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;font-size:11.5px;';
      const valEl = document.createElement('span');
      valEl.textContent = fmt(value);
      valEl.style.cssText = 'color:var(--fnos-ui-sec);font-size:11px;font-variant-numeric:tabular-nums;';
      head.appendChild(span); head.appendChild(valEl);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(min); input.max = String(max); input.step = String(step);
      input.value = String(value);
      input.style.cssText = 'width:100%;accent-color:var(--fnos-ui-accent);cursor:pointer;';
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        valEl.textContent = fmt(v);
        onInput(v);
      });
      row.appendChild(head); row.appendChild(input);
      return { row, input, valEl };
    };
    // 通用：多行文本框行
    const addTextarea = (labelText: string, value: string, placeholder: string, onInput: (v: string) => void): { row: HTMLElement; ta: HTMLTextAreaElement } => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;flex-direction:column;gap:4px;padding:7px 6px;';
      const span = document.createElement('span');
      span.textContent = labelText;
      span.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;font-size:11.5px;';
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.placeholder = placeholder;
      ta.rows = 4;
      ta.style.cssText = 'width:100%;resize:vertical;border-radius:8px;padding:7px 9px;font-size:11.5px;'
        + 'background:var(--fnos-ui-input-bg)!important;color:var(--fnos-ui-text);border:1px solid var(--fnos-ui-border3);'
        + 'font-family:inherit;line-height:1.5;';
      ta.addEventListener('input', () => onInput(ta.value));
      row.appendChild(span); row.appendChild(ta);
      return { row, ta };
    };

    // ===== 弹幕设置（写入 danmaku_block_types.json + 屏蔽词文件 + 弹幕文件夹管理）=====
    // [lc-215] 移除「弹幕样式」控制项（透明度/字号/描边/阴影/显示区域/同屏上限/粗体）——
    // 这些已由 MPV 底部控制栏的弹幕样式按钮管理；此处仅保留/新增「弹幕屏蔽」相关。
    // [lc-301] 标题由「B站弹幕屏蔽」改为「弹幕设置」，并新增「打开弹幕文件夹」入口。
    const secDanmaku = section('弹幕设置');
    secDanmaku.el.id = 'sec-danmaku'; // [lc-199] 供控制栏按钮唤起时滚动定位
    const danBody = secDanmaku.body;
    let _danTimer: any = null;

    // 屏蔽类型定义（key 必须与 bili_danmaku.py 的 danmaku_block_types.json 一致）
    const BLOCK_TYPES: { key: string; label: string }[] = [
      { key: 'top', label: '顶部弹幕' },
      { key: 'bottom', label: '底部弹幕' },
      { key: 'scroll', label: '滚动弹幕' },
      { key: 'reverse', label: '逆向弹幕' },
      { key: 'advanced', label: '高级弹幕' },
      { key: 'color', label: '彩色弹幕' }
    ];
    const blockToggles: { key: string; input: HTMLInputElement }[] = [];

    // 推送：仅传 屏蔽类型 + 屏蔽词（样式由 MPV 控制栏管理，不再经此通道）
    let danBlacklist: { row: HTMLElement; ta: HTMLTextAreaElement };
    function pushDan(): void {
      const blockTypes = blockToggles.filter((b) => b.input.checked).map((b) => b.key);
      const blacklist = danBlacklist ? danBlacklist.ta.value : '';
      const payload = { blockTypes, blacklist };
      if (_danTimer) clearTimeout(_danTimer);
      _danTimer = setTimeout(() => {
        ipcRenderer.invoke('settings:set-bili-danmaku-style', payload).catch((err) => log('set-bili-danmaku-style failed', err));
      }, 300);
    }

    for (const bt of BLOCK_TYPES) {
      const t = addToggle(bt.label);
      t.checked = false;
      t.addEventListener('change', pushDan);
      danBody.appendChild(t.parentElement as HTMLElement);
      blockToggles.push({ key: bt.key, input: t });
    }

    danBlacklist = addTextarea('屏蔽词（每行一条，支持正则）', '', '例如：\n广告\n关注.*', pushDan);
    danBody.appendChild(danBlacklist.row);

    const danHint = document.createElement('div');
    danHint.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-sec);padding:4px 6px 0;line-height:1.5;';
    danHint.textContent = '「弹幕样式」（透明度/字号/描边等）请在播放时通过 MPV 底部控制栏调整；本处仅管理 B站 弹幕的屏蔽。屏蔽类型于下一次 B站 弹幕加载时生效。';
    danBody.appendChild(danHint);

    // 打开已下载弹幕文件夹（方便用户管理/删除；目录与 MPV 弹幕落盘、Node 端弹幕缓存一致：%PUBLIC%\fnos-danmaku）
    const biliFolderBtn = mkBtn('打开弹幕文件夹', true);
    biliFolderBtn.style.marginTop = '10px';
    danBody.appendChild(biliFolderBtn);
    biliFolderBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      ipcRenderer.invoke('bili:open-danmaku-folder').catch((err) => log('bili:open-danmaku-folder failed', err));
    });

    // ===== 插帧（AI 补帧）=====
    // [lc-486] MPV 播放器插帧：uosc 控制栏有「插帧」按钮实时切换；此处提供应用侧默认配置
    // （默认开启 + 引擎选择 + 引擎路径），写入 script-opts/fntv_interp.conf 供 fntv_interp.lua 读取。
    const secInterp = section('插帧（AI 补帧）');
    const interpBody = secInterp.body;

    const interpEnabledToggle = addToggle('默认开启插帧（启动即生效）');
    interpBody.appendChild(interpEnabledToggle.parentElement as HTMLElement);

    const engineLabel = document.createElement('div');
    engineLabel.textContent = '插帧引擎';
    engineLabel.style.cssText = 'color:var(--fnos-ui-muted);font-size:11.5px;margin:10px 0 5px;';
    interpBody.appendChild(engineLabel);

    const engineSel = document.createElement('select');
    engineSel.id = 'fntv-interp-engine';
    engineSel.style.cssText = 'width:100%;font-size:12px;color:var(--fnos-ui-text);background:var(--fnos-ui-input-bg);'
      + 'border:1px solid var(--fnos-ui-border);border-radius:7px;padding:6px 8px;cursor:pointer;';
    ([
      ['auto', '自动（SVP → RIFE → 内置平滑运动）'],
      ['builtin', 'MPV 内置平滑运动（无需额外引擎）'],
      ['svp', 'SVP（需本机安装并运行 SmoothVideo Project）'],
      ['rife', 'RIFE AI 补帧（需 rife-ncnn-vulkan 等运行时）'],
      ['nvidia', 'N 卡 Smooth Motion（RTX50 驱动级，需在 NVIDIA App 开启）']
    ] as [string, string][]).forEach(([k, label]) => {
      const o = document.createElement('option');
      o.value = k; o.textContent = label;
      engineSel.appendChild(o);
    });
    interpBody.appendChild(engineSel);

    const pathLabel = document.createElement('div');
    pathLabel.textContent = '引擎路径（SVP 目录 / RIFE 可执行文件，留空=自动探测）';
    pathLabel.style.cssText = 'color:var(--fnos-ui-muted);font-size:11.5px;margin:10px 0 5px;';
    interpBody.appendChild(pathLabel);

    const pathInput = document.createElement('input');
    pathInput.type = 'text';
    pathInput.placeholder = '例如：C:\\Program Files (x86)\\SVP 4';
    pathInput.style.cssText = 'width:100%;font-size:12px;color:var(--fnos-ui-text);background:var(--fnos-ui-input-bg);'
      + 'border:1px solid var(--fnos-ui-border);border-radius:7px;padding:6px 8px;';
    interpBody.appendChild(pathInput);

    const interpHint = document.createElement('div');
    interpHint.style.cssText = 'font-size:10.5px;color:var(--fnos-ui-sec);padding:8px 0 0;line-height:1.5;';
    interpHint.textContent = '播放时可在 MPV 底部控制栏点「插帧」按钮实时开关。选 SVP/RIFE 需本机已安装对应引擎并配好，未安装时自动回退 MPV 内置平滑运动；选 N 卡需 RTX50+ 并在 NVIDIA App 开启「Smooth Motion（视频）」。';
    interpBody.appendChild(interpHint);

    let _interpTimer: any = null;
    const pushInterp = (): void => {
      const payload = { enabled: interpEnabledToggle.checked, engine: engineSel.value, path: pathInput.value.trim() };
      if (_interpTimer) clearTimeout(_interpTimer);
      _interpTimer = setTimeout(() => {
        ipcRenderer.invoke('settings:set-interp', payload).catch((err) => log('set-interp failed', err));
      }, 300);
    };
    interpEnabledToggle.addEventListener('change', pushInterp);
    engineSel.addEventListener('change', pushInterp);
    pathInput.addEventListener('input', pushInterp);

    ipcRenderer.invoke('settings:get-interp').then((r: any) => {
      if (!r) return;
      interpEnabledToggle.checked = !!r.enabled;
      engineSel.value = r.engine || 'auto';
      pathInput.value = r.path || '';
    }).catch((err) => log('get-interp failed', err));
    /* 布局统一在末尾 layout 区追加 */

    // ===== 诊断信息（汇总运行态，减少"查日志"往返）=====
    const secDiag = section('诊断信息');
    const diagBody = secDiag.body;
    const diagPre = document.createElement('pre');
    diagPre.style.cssText = 'margin:0;padding:10px;background:rgba(0,0,0,.18);border-radius:8px;font-size:10.5px;'
      + 'line-height:1.55;color:var(--fnos-ui-text);white-space:pre-wrap;word-break:break-all;max-height:260px;overflow:auto;';
    diagPre.textContent = '点击「刷新」加载诊断信息…';
    const diagBtns = document.createElement('div');
    diagBtns.style.cssText = 'display:flex;gap:6px;padding:8px 0 0;';
    const diagRefresh = mkBtn('刷新', true);
    const diagCopy = mkBtn('复制', true);
    diagBtns.appendChild(diagRefresh); diagBtns.appendChild(diagCopy);
    const loadDiag = async (): Promise<void> => {
      try {
        const r: any = await ipcRenderer.invoke('settings:diagnostics');
        if (!r || !r.ok) { diagPre.textContent = '诊断失败：' + ((r && r.error) || '未知'); return; }
        const lines: string[] = [];
        lines.push('== 基本信息 ==');
        lines.push(`版本: ${r.version}${r.isPackaged ? ' (打包版)' : ' (dev)'}`);
        lines.push(`App 路径: ${r.appPath}`);
        lines.push('');
        lines.push('== 登录与 NAS ==');
        lines.push(`NAS 地址: ${r.domain}`);
        lines.push(`账号: ${r.account}  登录方式: ${r.loginType}  Token: ${r.hasToken ? '已保存' : '无'}`);
        lines.push(`豆瓣同步: ${r.doubanEnabled ? '开' : '关'}${r.doubanLoggedIn ? '(已登录)' : ''}   Bangumi: ${r.bangumiEnabled ? '开' : '关'}${r.bangumiHasToken ? '(有Token)' : ''}`);
        lines.push('');
        lines.push('== 播放器 ==');
        lines.push(`默认播放器: ${r.defaultPlayer}`);
        lines.push(`MPV 路径: ${r.mpvPath}   PotPlayer 路径: ${r.potPath}`);
        lines.push(`MPV 配置目录: ${r.mpvConfigDir}`);
        lines.push('');
        lines.push('== MPV 渲染 ==');
        lines.push(`默认着色器: ${r.mpvShader || 'off'}   ICC 校色: ${r.mpvIcc ? '开' : '关'}`);
        lines.push('');
        lines.push('--- mpv-user.conf ---');
        lines.push(r.mpvUserConf || '(空)');
        lines.push('');
        lines.push('== B站弹幕 ==');
        lines.push(`搜索: ${r.biliSearchEnabled ? '开' : '关'}  聚合阈值: ${r.biliAggregateThreshold}`);
        const bt = Array.isArray(r.danmakuBlockTypes) ? r.danmakuBlockTypes : [];
        lines.push(`屏蔽类型: ${bt.length ? bt.join(', ') : '(无)'}`);
        lines.push(`屏蔽词: ${r.danmakuBlacklist ? r.danmakuBlacklist : '(无)'}`);
        lines.push('');
        lines.push('--- uosc_danmaku.conf ---');
        lines.push(r.danmakuConf || '(空)');
        lines.push('');
        lines.push('== 界面 / 其它 ==');
        lines.push(`滚轮横滚: ${r.wheelHScroll ? '开' : '关'}   详情页无盒: ${r.detailBoxless ? '是' : '否'}`);
        lines.push(`登录背景: ${r.loginBgPath}`);
        lines.push(`更新打烊时间戳: ${r.updateDismissedAt ? String(r.updateDismissedAt) : '(无)'}`);
        diagPre.textContent = lines.join('\n');
      } catch (err) {
        diagPre.textContent = '诊断加载异常：' + String(err);
      }
    };
    diagRefresh.addEventListener('click', (e: Event) => { e.stopPropagation(); loadDiag(); });
    diagCopy.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      const text = diagPre.textContent || '';
      if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
    });
    diagBody.appendChild(diagPre);
    diagBody.appendChild(diagBtns);
    /* 布局统一在末尾 layout 区追加 */

    // ===== 调试日志（独立卡片, 置于「诊断信息」下方; 从「退出行为」卡片迁出）=====
    // 小标题：纯文字，无背景/边框
    const dbgLabel = document.createElement('div');
    dbgLabel.style.cssText = 'color:var(--fnos-ui-sec);font-size:10px;margin:0 0 8px;'
      + 'font-weight:700;text-transform:uppercase;letter-spacing:1.2px;';
    dbgLabel.textContent = '调试日志';
    secDebugBody.appendChild(dbgLabel);

    // 调试开关动态挂载目标：主开关直接进卡片，组件开关进折叠区
    let debugTarget: HTMLElement = secDebugBody;

    const addDebugToggle = (label: string): HTMLInputElement => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 6px;'
        + 'cursor:pointer;border-radius:6px;transition:background .12s;';
      row.onmouseenter = () => { row.style.background = 'var(--fnos-ui-row-hover)'; };
      row.onmouseleave = () => { row.style.background = 'transparent'; };
      const span = document.createElement('span');
      span.textContent = label;
      span.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;';
      const sw = document.createElement('input');
      sw.type = 'checkbox';
      sw.style.cssText = 'width:38px;height:21px;cursor:pointer;accent-color:var(--fnos-ui-accent);';
      row.appendChild(span); row.appendChild(sw);
      debugTarget.appendChild(row);
      return sw;
    };

    // ===== 主开关（始终可见，置于顶部）=====
    debugTarget = secDebugBody;
    const swDebug = addDebugToggle('启用调试日志（详细模式）');
    swDebug.addEventListener('change', () => {
      ipcRenderer.invoke('settings:set-debug-enabled', swDebug.checked).catch((err) => log('set-debug-enabled failed', err));
    });

    // ===== 组件日志（默认折叠，置于主开关下方）=====
    const dbgFold = document.createElement('div');
    dbgFold.style.cssText = 'margin-top:4px;';
    const dbgFoldHeader = document.createElement('div');
    dbgFoldHeader.style.cssText = 'display:flex;align-items:center;gap:5px;cursor:pointer;color:var(--fnos-ui-muted);'
      + 'font-size:11.5px;padding:4px 6px;border-radius:6px;user-select:none;transition:background .12s;';
    dbgFoldHeader.onmouseenter = () => { dbgFoldHeader.style.background = 'var(--fnos-ui-row-hover)'; };
    dbgFoldHeader.onmouseleave = () => { dbgFoldHeader.style.background = 'transparent'; };
    const dbgCaret = document.createElement('span');
    dbgCaret.textContent = '▸';
    dbgCaret.style.cssText = 'display:inline-block;transition:transform .12s;font-size:10px;';
    const dbgFoldTitle = document.createElement('span');
    dbgFoldTitle.textContent = '组件日志（按组件单独控制）';
    dbgFoldHeader.appendChild(dbgCaret); dbgFoldHeader.appendChild(dbgFoldTitle);

    const dbgFoldBody = document.createElement('div');
    dbgFoldBody.style.cssText = 'display:none;'; // 默认折叠
    dbgFoldHeader.addEventListener('click', () => {
      const collapsed = dbgFoldBody.style.display === 'none';
      dbgFoldBody.style.display = collapsed ? 'block' : 'none';
      dbgCaret.style.transform = collapsed ? 'rotate(90deg)' : 'rotate(0deg)';
    });

    const debugHint = document.createElement('div');
    debugHint.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);margin:6px 0 8px;line-height:1.5;';
    debugHint.textContent = '关闭时控制台仅显示 警告/错误；开启后可单独控制各组件是否输出详细日志(INFO/DEBUG)。';
    dbgFoldBody.appendChild(debugHint);

    // 组件开关进折叠区
    debugTarget = dbgFoldBody;
    const debugComps: [string, string][] = [
      ['douban', '豆瓣同步'],
      ['danmaku', 'B站弹幕'],
      ['mpv', 'MPV 播放器'],
      ['potplayer', 'PotPlayer'],
      ['media', '播放器/媒体'],
      ['embywall', 'EmbyWall 墙']
    ];
    const swDebugComps: Record<string, HTMLInputElement> = {};
    debugComps.forEach(([key, label]) => {
      const sw = addDebugToggle(label);
      swDebugComps[key] = sw;
      sw.addEventListener('change', () => {
        const cur: Record<string, boolean> = {};
        debugComps.forEach(([k]) => { cur[k] = !!swDebugComps[k].checked; });
        ipcRenderer.invoke('settings:set-debug-components', cur).catch((err) => log('set-debug-components failed', err));
      });
    });
    dbgFold.appendChild(dbgFoldHeader);
    dbgFold.appendChild(dbgFoldBody);
    secDebugBody.appendChild(dbgFold);

    // 日志状态文字放在 body 内，避免占用 footer 高度导致左右 footer 不齐
    const logStatus = document.createElement('div');
    logStatus.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);margin-top:6px;min-height:14px;';
    secDebugBody.appendChild(logStatus);

    // ===== 底部操作栏：日志文件（独立 footer，与左侧检查更新按钮对齐）=====
    const logFooter = document.createElement('div');
    logFooter.style.cssText = 'padding:10px 12px;flex-shrink:0;';
    const logDivider = document.createElement('div');
    logDivider.style.cssText = 'height:1px;background:var(--fnos-ui-border);margin:0 0 8px;';
    logFooter.appendChild(logDivider);
    const logRow = document.createElement('div');
    logRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
    const openLogBtn = mkBtn('日志文件', true);
    const openErrLogBtn = mkBtn('报错日志', true);
    const exportLogBtn = mkBtn('导出日志文件', true);
    const openMpvLogBtn = mkBtn('MPV 播放器日志', true);
    logRow.appendChild(openLogBtn);
    logRow.appendChild(openErrLogBtn);
    logRow.appendChild(exportLogBtn);
    logRow.appendChild(openMpvLogBtn);
    logFooter.appendChild(logRow);
    secDebug.el.appendChild(logFooter);

    openLogBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      ipcRenderer.invoke('settings:open-log').then((r: any) => {
        if (!r || !r.ok) {
          logStatus.textContent = '日志文件打开失败：' + ((r && r.error) || '未知');
        } else {
          logStatus.textContent = '';
        }
      }).catch(() => {});
    });
    openErrLogBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      ipcRenderer.invoke('settings:open-error-log').then((r: any) => {
        if (!r || !r.ok) {
          logStatus.textContent = '报错日志打开失败：' + ((r && r.error) || '未知');
        } else {
          logStatus.textContent = '';
        }
      }).catch(() => {});
    });
    exportLogBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      ipcRenderer.invoke('settings:export-log').then((r: any) => {
        if (r && r.ok) {
          logStatus.textContent = '已导出日志：' + (r.savedPath || '');
        } else if (r && r.error && r.error !== '已取消') {
          logStatus.textContent = '导出失败：' + (r.error || '未知');
        } else {
          logStatus.textContent = '';
        }
      }).catch(() => {});
    });
    openMpvLogBtn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      ipcRenderer.invoke('settings:open-mpv-log').then((r: any) => {
        if (!r || !r.ok) {
          logStatus.textContent = 'MPV 日志打开失败：' + ((r && r.error) || '未知');
        } else {
          logStatus.textContent = '';
        }
      }).catch(() => {});
    });

    // ===== 插件面板：跳过片头片尾（smart_skip 插件，控制面从 MPV 菜单抽到此处）=====
    const secSkip = section('跳过片头片尾');
    secSkip.el.id = 'sec-skip';
    const skipBody = secSkip.body;
    const skipDesc = document.createElement('div');
    skipDesc.textContent = '自动加载飞牛/影片库跳过数据；可在播放时显示「跳过片头/片尾」按钮，或开启后自动跳过。';
    skipDesc.style.cssText = 'color:#9aa0a6;font-size:12px;line-height:1.5;margin-bottom:6px;';
    skipBody.appendChild(skipDesc);
    const skipRow = document.createElement('div');
    skipRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 6px;margin-top:4px;'
      + 'cursor:pointer;border-radius:6px;transition:background .12s;';
    skipRow.onmouseenter = () => { skipRow.style.background = 'var(--fnos-ui-row-hover)'; };
    skipRow.onmouseleave = () => { skipRow.style.background = 'transparent'; };
    const skipLabel = document.createElement('span');
    skipLabel.textContent = '自动跳过片头片尾';
    skipLabel.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;';
    const swSkip = document.createElement('input');
    swSkip.type = 'checkbox';
    swSkip.style.cssText = 'width:38px;height:21px;cursor:pointer;accent-color:var(--fnos-ui-accent);';
    skipRow.appendChild(skipLabel); skipRow.appendChild(swSkip);
    skipBody.appendChild(skipRow);
    swSkip.addEventListener('change', () => {
      ipcRenderer.invoke('settings:set-smart-skip-enabled', swSkip.checked).catch((err) => log('set-smart-skip-enabled failed', err));
    });
    // 读取初始值（默认关闭）
    ipcRenderer.invoke('settings:get-smart-skip-enabled').then((v: boolean) => { swSkip.checked = !!v; }).catch(() => { swSkip.checked = false; });

    // ===== 分组: 关于（独立标签页；原侧栏"关于"按钮迁入设置面板）=====
    const secAbout = section();
    const secBodyAbout = secAbout.body;
    secBodyAbout.style.cssText = 'padding:18px 16px;flex:1 1 auto;display:flex;flex-direction:column;align-items:center;text-align:center;gap:10px;';

    const aboutTitle = document.createElement('div');
    aboutTitle.style.cssText = 'font-size:22px;font-weight:800;color:var(--fnos-ui-pill-text);';
    aboutTitle.textContent = '🎬 飞牛影视';
    secBodyAbout.appendChild(aboutTitle);

    const aboutAuthor = document.createElement('div');
    aboutAuthor.style.cssText = 'font-size:13px;font-weight:600;color:var(--fnos-ui-sec);margin-bottom:4px;';
    aboutAuthor.textContent = 'YDMY007';
    secBodyAbout.appendChild(aboutAuthor);

    const aboutDesc = document.createElement('div');
    aboutDesc.style.cssText = 'font-size:13px;line-height:1.9;color:var(--fnos-ui-text);opacity:.82;max-width:440px;';
    aboutDesc.textContent = '基于飞牛影视（fnOS TV）打造的增强桌面客户端，采用 Electron + 亚克力玻璃 UI。支持 MPV 播放器、B站弹幕、自定义透明度与模糊效果。';
    secBodyAbout.appendChild(aboutDesc);

    const aboutVer = document.createElement('div');
    aboutVer.id = 'fnos-about-version';
    aboutVer.style.cssText = 'font-size:12.5px;color:var(--fnos-ui-muted);margin-top:2px;';
    aboutVer.textContent = '版本：获取中…';
    secBodyAbout.appendChild(aboutVer);
    // 动态版本号：复用主进程 get-version / version-info（与旧侧栏关于按钮同源）
    try {
      ipcRenderer.send('get-version');
      ipcRenderer.once('version-info', (_e: any, info: any) => {
        if (info && info.version) aboutVer.textContent = '版本：v' + info.version;
      });
    } catch (_) {}

    const aboutLink = document.createElement('a');
    aboutLink.href = ABOUT_LINK_URL;
    aboutLink.textContent = '🔗 GitHub 项目地址';
    aboutLink.style.cssText = 'display:inline-block;font-size:13px;font-weight:700;color:var(--fnos-ui-pill-text);text-decoration:none;'
      + 'padding:8px 20px;border-radius:10px;background:var(--fnos-ui-pill-bg)!important;border:1px solid var(--fnos-ui-pill-border);'
      + 'transition:background .15s,transform .1s;margin-top:6px;cursor:pointer;';
    aboutLink.addEventListener('click', async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      try { await ipcRenderer.invoke('app:open-external', ABOUT_LINK_URL); } catch (_) {}
    });
    aboutLink.onmouseenter = () => { aboutLink.style.transform = 'scale(1.03)'; aboutLink.style.background = 'var(--fnos-ui-pill-hover)!important'; aboutLink.style.color = '#fff'; };
    aboutLink.onmouseleave = () => { aboutLink.style.transform = ''; aboutLink.style.background = 'var(--fnos-ui-pill-bg)!important'; aboutLink.style.color = 'var(--fnos-ui-pill-text)'; };
    secBodyAbout.appendChild(aboutLink);

    // ===== 分组: 外观（独立标签页；原侧栏"亚克力透明度/背景模糊"滑块迁入设置面板）=====
    const secAppearance = section('亚克力外观');
    const secBodyAppearance = secAppearance.body;
    secBodyAppearance.style.cssText = 'padding:14px 16px;flex:1 1 auto;display:flex;flex-direction:column;';
    secBodyAppearance.appendChild(buildAppearanceControls());

    // ===== 分组: 系统桌面（切换系统页面目标地址，每人 NAS 端口各异）=====
    const secSystem = section('系统桌面');
    const secBodySystem = secSystem.body;
    secBodySystem.style.cssText = 'padding:14px 16px;flex:1 1 auto;display:flex;flex-direction:column;';

    const sysDesc = document.createElement('div');
    sysDesc.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);line-height:1.5;margin-bottom:8px;';
    sysDesc.textContent = '「切换系统页面」会跳到飞牛原生 NAS 系统桌面。每个人的系统 Web 端口可能不同（默认 5666，但都能改），不一定和影视媒体端口一致。留空=自动（用当前影视连接的同端口根路径）；若桌面在别的端口，请填完整地址，如 https://192.168.1.50:5666。';
    secBodySystem.appendChild(sysDesc);

    const sysInput = document.createElement('input');
    sysInput.type = 'text';
    sysInput.placeholder = '留空=自动；或填系统桌面完整地址，如 https://192.168.1.50:5666';
    sysInput.style.cssText = 'width:100%;height:32px;font-size:11px;color:var(--fnos-ui-text);background:var(--fnos-ui-input-bg);'
      + 'border:1px solid var(--fnos-ui-border);border-radius:7px;padding:6px 8px;box-sizing:border-box;margin-bottom:8px;';
    secBodySystem.appendChild(sysInput);

    const sysBtns = document.createElement('div');
    sysBtns.style.cssText = 'display:flex;gap:6px;';
    const sysSaveBtn = mkBtn('保存', true);
    const sysResetBtn = mkBtn('重置为自动', true);
    sysBtns.appendChild(sysSaveBtn);
    sysBtns.appendChild(sysResetBtn);
    secBodySystem.appendChild(sysBtns);

    const sysStatus = document.createElement('div');
    sysStatus.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);margin-top:6px;min-height:14px;';
    secBodySystem.appendChild(sysStatus);

    sysSaveBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      try {
        const val = sysInput.value.trim();
        const r: any = await ipcRenderer.invoke('settings:set-system-page-url', val);
        if (!r || r.ok !== false) {
          sysStatus.textContent = val ? ('已保存：' + val) : '已设为自动（当前影视连接根路径）';
          sysStatus.style.color = 'var(--fnos-ui-ok)';
        } else {
          sysStatus.textContent = '保存失败';
          sysStatus.style.color = 'var(--fnos-ui-warn)';
        }
      } catch {
        sysStatus.textContent = '保存失败';
        sysStatus.style.color = 'var(--fnos-ui-warn)';
      }
    });
    sysResetBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      sysInput.value = '';
      try {
        const r: any = await ipcRenderer.invoke('settings:set-system-page-url', '');
        if (!r || r.ok !== false) {
          sysStatus.textContent = '已重置为自动（当前影视连接根路径）';
          sysStatus.style.color = 'var(--fnos-ui-ok)';
        }
      } catch {
        sysStatus.textContent = '重置失败';
        sysStatus.style.color = 'var(--fnos-ui-warn)';
      }
    });

    // 初始回填：读取已保存地址（留空=自动）
    (async () => {
      try {
        const g: any = await ipcRenderer.invoke('settings:get-system-page-url');
        if (g && typeof g.url === 'string') sysInput.value = g.url;
      } catch { /* ignore */ }
    })();

    // ===== 分组: 自定义代理（让 Bangumi 每日放送、TMDB 等走用户自建代理入口）=====
    const secCustomProxy = section('自定义代理');
    const secBodyCustomProxy = secCustomProxy.body;
    secBodyCustomProxy.style.cssText = 'padding:14px 16px;flex:1 1 auto;display:flex;flex-direction:column;';

    const cpDesc = document.createElement('div');
    cpDesc.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);line-height:1.5;margin-bottom:8px;';
    cpDesc.textContent = '为 Bangumi 每日放送、TMDB（影视发现/海报）等数据源指定代理入口。支持 HTTP / HTTPS / SOCKS5，可填账号密码鉴权。优先级低于环境变量 HTTPS_PROXY（已设环境变量则它先生效）。开启开关并填写地址后才生效。';
    secBodyCustomProxy.appendChild(cpDesc);

    // 开关行（整行可点）
    const cpToggleRow = document.createElement('label');
    cpToggleRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 6px;cursor:pointer;border-radius:6px;margin-bottom:8px;';
    const cpToggleSpan = document.createElement('span');
    cpToggleSpan.textContent = '启用自定义代理';
    cpToggleSpan.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;';
    const cpToggle = document.createElement('input');
    cpToggle.type = 'checkbox';
    cpToggle.style.cssText = 'width:38px;height:21px;cursor:pointer;accent-color:var(--fnos-ui-accent);';
    cpToggleRow.appendChild(cpToggleSpan); cpToggleRow.appendChild(cpToggle);
    secBodyCustomProxy.appendChild(cpToggleRow);

    // 类型 + 主机:端口 行
    const cpRow1 = document.createElement('div');
    cpRow1.style.cssText = 'display:flex;gap:6px;margin-bottom:8px;';
    const cpType = document.createElement('select');
    cpType.style.cssText = 'height:32px;font-size:11px;color:var(--fnos-ui-text);background:var(--fnos-ui-input-bg);border:1px solid var(--fnos-ui-border);border-radius:7px;padding:4px 6px;box-sizing:border-box;';
    const cpTypeOpts: [string, string][] = [['https', 'HTTPS'], ['http', 'HTTP'], ['socks5', 'SOCKS5']];
    cpTypeOpts.forEach(([v, t]) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      cpType.appendChild(o);
    });
    const cpAddr = document.createElement('input');
    cpAddr.type = 'text';
    cpAddr.placeholder = '主机:端口，如 127.0.0.1:7890';
    cpAddr.style.cssText = 'flex:1 1 auto;min-width:0;height:32px;font-size:11px;color:var(--fnos-ui-text);background:var(--fnos-ui-input-bg);border:1px solid var(--fnos-ui-border);border-radius:7px;padding:6px 8px;box-sizing:border-box;';
    cpRow1.appendChild(cpType);
    cpRow1.appendChild(cpAddr);
    secBodyCustomProxy.appendChild(cpRow1);

    // 账号 / 密码 行（可选鉴权）
    const cpRow2 = document.createElement('div');
    cpRow2.style.cssText = 'display:flex;gap:6px;margin-bottom:8px;';
    const cpUser = document.createElement('input');
    cpUser.type = 'text';
    cpUser.placeholder = '账号（可选）';
    cpUser.style.cssText = 'flex:1 1 auto;min-width:0;height:32px;font-size:11px;color:var(--fnos-ui-text);background:var(--fnos-ui-input-bg);border:1px solid var(--fnos-ui-border);border-radius:7px;padding:6px 8px;box-sizing:border-box;';
    const cpPass = document.createElement('input');
    cpPass.type = 'password';
    cpPass.placeholder = '密码（可选）';
    cpPass.style.cssText = 'flex:1 1 auto;min-width:0;height:32px;font-size:11px;color:var(--fnos-ui-text);background:var(--fnos-ui-input-bg);border:1px solid var(--fnos-ui-border);border-radius:7px;padding:6px 8px;box-sizing:border-box;';
    cpRow2.appendChild(cpUser);
    cpRow2.appendChild(cpPass);
    secBodyCustomProxy.appendChild(cpRow2);

    // 根据表单组装代理 URL（类型://[user:pass@]host:port）
    function buildCpUrl(): string {
      const type = cpType.value || 'https';
      const addr = cpAddr.value.trim();
      if (!addr) return '';
      const user = cpUser.value.trim();
      const pass = cpPass.value;
      const auth = (user || pass) ? (encodeURIComponent(user) + ':' + encodeURIComponent(pass) + '@') : '';
      return type + '://' + auth + addr;
    }

    const cpBtns = document.createElement('div');
    cpBtns.style.cssText = 'display:flex;gap:6px;';
    const cpSaveBtn = mkBtn('保存', true);
    const cpTestBtn = mkBtn('测试连接', true);
    const cpResetBtn = mkBtn('关闭代理', true);
    cpBtns.appendChild(cpSaveBtn);
    cpBtns.appendChild(cpTestBtn);
    cpBtns.appendChild(cpResetBtn);
    secBodyCustomProxy.appendChild(cpBtns);

    const cpStatus = document.createElement('div');
    cpStatus.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);margin-top:6px;min-height:14px;';
    secBodyCustomProxy.appendChild(cpStatus);

    function cpSetStatus(msg: string, ok: boolean | null): void {
      cpStatus.textContent = msg;
      cpStatus.style.color = ok === null ? 'var(--fnos-ui-sub)' : (ok ? 'var(--fnos-ui-ok)' : 'var(--fnos-ui-warn)');
    }

    cpSaveBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      try {
        const url = buildCpUrl();
        if (cpToggle.checked && !url) {
          cpSetStatus('已启用但未填写主机:端口（不生效）', false);
          return;
        }
        await ipcRenderer.invoke('settings:set-custom-proxy', cpToggle.checked, url);
        cpSetStatus(cpToggle.checked && url ? ('已保存并启用：' + url) : '已关闭自定义代理', true);
      } catch {
        cpSetStatus('保存失败', false);
      }
    });

    cpTestBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      const url = buildCpUrl();
      if (!url) { cpSetStatus('请先填写主机:端口', false); return; }
      cpSetStatus('测试中…', null);
      cpTestBtn.disabled = true;
      try {
        const r: any = await ipcRenderer.invoke('settings:test-custom-proxy', true, url);
        if (r && r.ok) cpSetStatus('测试' + (r.info ? ('：' + r.info) : '通过'), true);
        else cpSetStatus('测试失败：' + ((r && r.error) || '未知'), false);
      } catch (err: any) {
        cpSetStatus('测试异常：' + String((err && err.message) || err), false);
      } finally {
        cpTestBtn.disabled = false;
      }
    });

    cpResetBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      cpToggle.checked = false;
      cpType.value = 'https';
      cpAddr.value = '';
      cpUser.value = '';
      cpPass.value = '';
      try {
        await ipcRenderer.invoke('settings:set-custom-proxy', false, '');
        cpSetStatus('已关闭自定义代理', true);
      } catch {
        cpSetStatus('重置失败', false);
      }
    });

    // 初始回填：读取已保存的开关与地址，解析出 类型 / 主机:端口 / 账号 / 密码
    (async () => {
      try {
        const g: any = await ipcRenderer.invoke('settings:get-custom-proxy');
        if (g) {
          cpToggle.checked = !!g.enabled;
          const u = (typeof g.proxyUrl === 'string') ? g.proxyUrl.trim() : '';
          if (u) {
            let rest = u;
            const m = rest.match(/^([a-zA-Z0-9]+):\/\/(.*)$/);
            if (m) {
              const scheme = m[1].toLowerCase();
              cpType.value = scheme.indexOf('socks') === 0 ? 'socks5' : (scheme === 'http' ? 'http' : 'https');
              rest = m[2];
            }
            const am = rest.match(/^([^@]+)@(.+)$/);
            if (am) {
              const up = am[1];
              rest = am[2];
              const c = up.indexOf(':');
              if (c >= 0) { cpUser.value = decodeURIComponent(up.slice(0, c)); cpPass.value = decodeURIComponent(up.slice(c + 1)); }
              else { cpUser.value = decodeURIComponent(up); }
            }
            cpAddr.value = rest;
          }
        }
      } catch { /* ignore */ }
    })();

    // ===== [lc-412] 轮播图 Logo 插件：首页轮播图右侧文字标题 ⇄ TMDB 透明 Logo 开关（归入「插件」分类） =====
    const secCarousel = section('轮播图 Logo');
    const secBodyCarousel = secCarousel.body;
    secBodyCarousel.style.cssText = 'padding:14px 16px;flex:1 1 auto;display:flex;flex-direction:column;';

    const carouselLogoDesc = document.createElement('div');
    carouselLogoDesc.style.cssText = 'font-size:11px;color:var(--fnos-ui-sub);line-height:1.5;margin-bottom:8px;';
    carouselLogoDesc.textContent = '开启后，首页轮播图右侧的文字标题会被替换为 TMDB 的透明 Logo 图（仅当该剧集在 TMDB 有透明 Logo 时）。关闭则保留原始文字标题。';
    secBodyCarousel.appendChild(carouselLogoDesc);

    // 开关行（整行可点）：开启=用 logo 图替换右侧文字标题；关闭=保留文字标题
    const swLogo = document.createElement('input');
    swLogo.type = 'checkbox';
    swLogo.style.cssText = 'width:38px;height:21px;cursor:pointer;accent-color:var(--fnos-ui-accent);';
    const swLogoRow = document.createElement('label');
    swLogoRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 6px;cursor:pointer;border-radius:6px;';
    const swLogoSpan = document.createElement('span');
    swLogoSpan.textContent = '轮播图标题替换为 Logo';
    swLogoSpan.style.cssText = 'color:var(--fnos-ui-text);font-weight:500;';
    swLogoRow.appendChild(swLogoSpan); swLogoRow.appendChild(swLogo);
    secBodyCarousel.appendChild(swLogoRow);
    swLogo.checked = _carouselLogoEnabled;
    swLogo.addEventListener('change', () => {
      _carouselLogoEnabled = swLogo.checked;
      ipcRenderer.invoke('settings:set-carousel-logo', swLogo.checked);
      // 立即对当前已渲染轮播生效（开→拉取 logo 替换；关→还原文字标题）
      applyCarouselLogoNow();
    });

    // ===== 统一布局：左侧分类导航 + 右侧按分类切换的卡片 pane =====
    // 分类 -> 卡片映射(聚焦拆分: 通用 / 播放器 / 账号同步 / 弹幕屏蔽 / 诊断与日志)
    type Cat = { id: string; label: string; els: HTMLElement[] };
    const cats: Cat[] = [
      { id: 'general', label: '通用', els: [sec1.el, sec3.el, secSystem.el] },
      { id: 'player', label: '播放器', els: [sec2.el, secInterp.el] },
      { id: 'account', label: '账号同步', els: [secBili.el, secBangumi.el, secTmdb.el, secDouban.el] },
      { id: 'danmaku', label: '弹幕设置', els: [secDanmaku.el] },
      { id: 'diag', label: '诊断与日志', els: [secDiag.el, secDebug.el] },
      { id: 'plugins', label: '插件', els: [secSkip.el, secTmdbDirect.el, secCustomProxy.el, secCarousel.el] },
      { id: 'appearance', label: '外观', els: [secAppearance.el] },
      { id: 'about', label: '关于', els: [secAbout.el] },
    ];
    // 每个分类一个 pane(竖向卡片列); 清掉卡片在旧 grid 里设的 gridColumn(现已不在 grid 内)
    const panes: Record<string, HTMLElement> = {};
    cats.forEach((cat) => {
      const pane = document.createElement('div');
      pane.style.cssText = 'display:none;flex-direction:column;gap:14px;';
      cat.els.forEach((el) => {
        el.style.gridColumn = '';
        pane.appendChild(el);
      });
      pane.dataset.cat = cat.id;
      rightContent.appendChild(pane);
      panes[cat.id] = pane;
    });
    // 左侧导航按钮 + 切换逻辑
    const navBtns: Record<string, HTMLButtonElement> = {};
    const selectCat = (id: string): void => {
      for (const c of cats) {
        const on = c.id === id;
        const pane = panes[c.id];
        if (!pane) continue;
        pane.style.display = on ? 'flex' : 'none';
        const b = navBtns[c.id];
        if (!b) continue;
        if (on) {
          b.style.background = 'var(--fnos-ui-accent)!important';
          b.style.color = '#fff';
          b.style.fontWeight = '700';
          b.style.borderColor = 'var(--fnos-ui-accent)';
        } else {
          b.style.background = 'transparent';
          b.style.color = 'var(--fnos-ui-text)';
          b.style.fontWeight = '500';
          b.style.borderColor = 'transparent';
        }
      }
    };
    // 暴露给 openSettingsPanel, 使 fntv-open-settings(若启用)能直接切到对应分类
    (overlay as any)._selectCat = (id: string): void => selectCat(id);
    cats.forEach((cat) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = cat.label;
      btn.style.cssText = 'text-align:left;padding:10px 12px;border-radius:9px;cursor:pointer;font-size:13px;'
        + 'border:1px solid transparent;background:transparent;color:var(--fnos-ui-text);transition:background .13s;'
        + 'font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
        + '-webkit-app-region:no-drag;app-region:no-drag;';
      btn.onmouseenter = () => { if (btn.style.background.indexOf('accent') === -1) btn.style.background = 'var(--fnos-ui-row-hover)'; };
      btn.onmouseleave = () => { if (btn.style.background.indexOf('accent') === -1) btn.style.background = 'transparent'; };
      btn.onclick = (e: Event) => { e.stopPropagation(); selectCat(cat.id); };
      navBtns[cat.id] = btn;
      leftNav.appendChild(btn);
    });
    selectCat(cats[0].id); // 默认显示第一个分类(通用)

    // 刷新豆瓣登录状态（打开面板时 / 登录变更时调用）
    const refreshDouban = async (): Promise<void> => {
      try {
        const st: any = await ipcRenderer.invoke('douban:login-status');
        if (st && st.loggedIn) {
          doubanStatus.textContent = '已登录豆瓣 ✓';
          doubanStatus.style.color = 'var(--fnos-ui-ok)';
        } else {
          doubanStatus.textContent = '未登录豆瓣（点"扫码登录"）';
          doubanStatus.style.color = 'var(--fnos-ui-warn)';
        }
        swDouban.checked = !!(st && st.enabled);
      } catch {
        doubanStatus.textContent = '状态获取失败';
        doubanStatus.style.color = 'var(--fnos-ui-warn)';
      }
    };
    // 主进程登录成功/退出时主动通知前端刷新
    ipcRenderer.on('douban:login-changed', () => { refreshDouban(); });

    // 刷新 B站登录状态(打开面板时调用)
    const refreshBili = async (): Promise<void> => {
      try {
        const st: any = await ipcRenderer.invoke('bili:cookie-status');
        if (st && st.exists) {
          biliStatus.textContent = '已登录 ✓';
          biliStatus.style.color = 'var(--fnos-ui-ok)';
        } else {
          biliStatus.textContent = '未登录';
          biliStatus.style.color = 'var(--fnos-ui-warn)';
        }
      } catch {
        biliStatus.textContent = '状态获取失败';
        biliStatus.style.color = 'var(--fnos-ui-warn)';
      }
    };

    // 注入 qrcode 库(仅一次)
    let _biliQrTimer = 0;
    let _biliLibReady = false;
    const ensureBiliQrLib = async (): Promise<boolean> => {
      if (_biliLibReady && (window as any).qrcode) return true;
      try {
        const src: string = await ipcRenderer.invoke('bili:qr-lib');
        if (!src) return false;
        const s = document.createElement('script');
        s.textContent = src;
        document.head.appendChild(s);
        _biliLibReady = !!(window as any).qrcode;
        return _biliLibReady;
      } catch { return false; }
    };

    // 打开扫码登录弹窗
    const openBiliLogin = async (): Promise<void> => {
      let modal = document.getElementById('fnos-bili-modal') as HTMLElement | null;
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'fnos-bili-modal';
        modal.style.cssText = 'position:fixed;z-index:2147483700;display:none;align-items:center;justify-content:center;'
          + 'left:0;top:0;width:100%;height:100%;background:var(--fnos-modal-overlay);';
        modal.setAttribute('data-fnos-ui', '1'); // 免疫白底清除
        const box = document.createElement('div');
        box.style.cssText = 'width:300px;padding:22px 20px 18px;border-radius:18px;text-align:center;color:var(--fnos-ui-text);'
          + 'background:var(--fnos-ui-panel-bg)!important;'
          + 'backdrop-filter:blur(30px) saturate(150%);-webkit-backdrop-filter:blur(30px) saturate(150%);'
          + 'box-shadow:0 18px 50px rgba(80,60,120,.3),var(--fnos-modal-inner-shadow);'
          + 'border:1px solid var(--fnos-ui-border-outer);';
        box.innerHTML =
          '<div style="font-size:15px;font-weight:700;margin-bottom:4px;">B站弹幕登录</div>'
          + '<div style="font-size:11px;color:var(--fnos-ui-sec);margin-bottom:14px;">请用 B站 APP 扫码登录</div>'
          + '<div class="fnos-bili-qr" style="width:200px;height:200px;margin:0 auto 12px;display:flex;align-items:center;'
          + 'justify-content:center;background:var(--fnos-qr-bg);border-radius:12px;padding:10px;box-sizing:border-box;overflow:hidden;"></div>'
          + '<div class="fnos-bili-tip" style="font-size:12px;color:var(--fnos-ui-muted);min-height:18px;margin-bottom:14px;">准备中…</div>';
        const closeB = document.createElement('button');
        closeB.type = 'button';
        closeB.textContent = '取消';
        closeB.style.cssText = 'width:100%;padding:9px;border-radius:10px;cursor:pointer;font-size:12px;font-weight:600;'
          + 'background:var(--fnos-ui-btn-bg)!important;color:var(--fnos-ui-btn-text2);border:1px solid var(--fnos-ui-border-strong);';
        box.appendChild(closeB);
        modal.appendChild(box);
        modal.addEventListener('click', (e: Event) => {
          if (e.target === modal) { modal!.style.display = 'none'; clearInterval(_biliQrTimer); }
        });
        closeB.addEventListener('click', (e: Event) => { e.stopPropagation(); modal!.style.display = 'none'; clearInterval(_biliQrTimer); });
        document.body.appendChild(modal);
      }
      const m = modal;
      m.style.display = 'flex';
      const qrWrap = m.querySelector('.fnos-bili-qr') as HTMLElement | null;
      const tip = m.querySelector('.fnos-bili-tip') as HTMLElement | null;
      if (qrWrap) qrWrap.innerHTML = '生成二维码中…';
      if (tip) tip.textContent = '';
      clearInterval(_biliQrTimer);

      const okLib = await ensureBiliQrLib();
      if (!okLib) { if (qrWrap) qrWrap.textContent = '二维码库加载失败'; return; }
      const gen: any = await ipcRenderer.invoke('bili:qr-generate');
      if (!gen || !gen.ok) { if (qrWrap) qrWrap.textContent = '获取失败: ' + ((gen && gen.error) || '未知'); return; }
      try {
        const qr = (window as any).qrcode(0, 'M');
        qr.addData(gen.url);
        qr.make();
        if (qrWrap) { qrWrap.innerHTML = qr.createSvgTag(6, 10); const svg = qrWrap.querySelector('svg'); if (svg) { svg.style.width = '100%'; svg.style.height = '100%'; } }
      } catch (e: any) {
        if (qrWrap) qrWrap.textContent = '渲染失败: ' + (e?.message || e);
      }
      if (tip) tip.textContent = '请用 B站 APP 扫码';
      _biliQrTimer = window.setInterval(async () => {
        const r: any = await ipcRenderer.invoke('bili:qr-poll', gen.key);
        if (r.code === 0) {
          clearInterval(_biliQrTimer);
          if (tip) tip.textContent = '登录成功！';
          refreshBili();
          window.setTimeout(() => { m.style.display = 'none'; }, 900);
        } else if (r.expired) {
          clearInterval(_biliQrTimer);
          if (tip) tip.textContent = '二维码已过期，请重新点击扫码登录';
          if (qrWrap) qrWrap.innerHTML = '二维码已失效';
        } else {
          if (tip) tip.textContent = r.status || '等待扫码…';
        }
      }, 1500);
    };

    scanBtn.addEventListener('click', (e: Event) => { e.stopPropagation(); openBiliLogin(); });
    logoutBiliBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      try {
        const r: any = await ipcRenderer.invoke('bili:clear');
        biliStatus.textContent = (r && r.ok) ? '已清除登录信息' : '清除失败';
        biliStatus.style.color = 'var(--fnos-ui-warn)';
      } catch { biliStatus.textContent = '清除失败'; }
    });
    saveBiliCookieBtn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      const r: any = await ipcRenderer.invoke('bili:manual-cookie', biliManualTa.value);
      if (r && r.ok) { biliManualTa.value = ''; refreshBili(); }
      else biliStatus.textContent = '保存失败：' + ((r && (r.msg || r.error)) || '未知');
    });
    const refreshExit = (): void => {
      const cur = (overlay as any)._exitMode || 'ask';
      exitEls.forEach((b) => {
        const on = b.dataset.mode === cur;
        b.style.background = (on ? 'var(--fnos-ui-exit-on)' : 'var(--fnos-ui-exit-off)') + '!important';
        b.style.color = on ? '#fff' : 'var(--fnos-ui-muted)';
        b.style.fontWeight = on ? '700' : '500';
        b.style.border = (on ? 'var(--fnos-exit-border-on)' : 'var(--fnos-exit-border-off)') + '!important';
      });
    };
    // hover 时不要覆盖选中态背景 → 重写退出按钮的 hover(仅未选中项响应)
    exitEls.forEach((b) => {
      b.onmouseenter = () => { if (b.dataset.mode !== ((overlay as any)._exitMode || 'ask')) b.style.background = 'var(--fnos-ui-btn-hover2)!important'; };
      b.onmouseleave = () => { refreshExit(); };
    });

    // 底部安全区(给滚动留空间)
    const footer = document.createElement('div');
    footer.style.cssText = 'height:6px;flex-shrink:0;';
    overlay.appendChild(footer);

    // 打开时刷新值
    (overlay as any)._refresh = async (): Promise<void> => {
      // [修复] 原实现是一整个 try 块串行回填 40+ 项，任何一项抛错都会静默跳过
      // 其后所有回填（典型症状：Bangumi 同步开关配置里明明是 true，面板却显示未勾选）。
      // 现改为分段隔离：每段独立 try/catch + 记录失败段名，单段失败不殃及其他段。
      let s: any = null;
      try {
        s = await ipcRenderer.invoke('settings:get');
      } catch (err) {
        log('SETTINGS refresh failed: settings:get invoke error', err);
        return;
      }
      if (!s || typeof s !== 'object') {
        log('SETTINGS refresh failed: settings:get returned', s);
        return;
      }
      const seg = (name: string, fn: () => void): void => {
        try { fn(); } catch (err) { log(`SETTINGS refresh segment [${name}] failed`, err); }
      };
      seg('switches', () => {
        const dl = !!(s.downloadProxy && s.downloadProxy.enabled);
        swProxy.checked = dl;
        swHide.checked = !!s.hideOriginalPlayButton;
        swNas.checked = !!s.nasProxyEnabled;
        swBoxless.checked = !!s.detailBoxless;
        _detailBoxless = !!s.detailBoxless;
        // [lc-418] 补回滚轮开关回填：此前只在构建期按 _wheelHScrollEnabled 赋值,
        // 若面板被 SPA 重建且早于启动 seed 完成, 会显示默认态导致"关掉再开变回未勾选"。
        swWheel.checked = !!s.wheelHScroll;
        _wheelHScrollEnabled = !!s.wheelHScroll;
        swLogo.checked = !!s.carouselLogoEnabled;
        _carouselLogoEnabled = !!s.carouselLogoEnabled;
        // [lc-418] 诊断日志：面板每次打开记录开关回填值, 便于核对"配置文件 vs 面板显示"是否一致
        log('[开关回填] swProxy=' + swProxy.checked + ' swHide=' + swHide.checked + ' swNas=' + swNas.checked
          + ' swBoxless=' + swBoxless.checked + ' swWheel=' + swWheel.checked + ' swLogo=' + swLogo.checked);
      });
      seg('players', () => {
        mpvPath.textContent = s.mpvPath || '应用内置（已随安装包分发，无需本机安装）';
        potPathEl.textContent = s.potPath || '应用内置（已随安装包分发，无需本机安装）';
        shaderSel.value = s.mpvDefaultShader || 'off';
        renderIccBtn(s.mpvIccEnabled !== false);
        (overlay as any)._defaultPlayer = s.defaultPlayer || 'mpv';
        refreshDefaultPlayer();
        (overlay as any)._exitMode = s.exitMode || 'ask';
        refreshExit();
      });
      seg('accounts', () => {
        refreshBili();
        refreshDouban();
      });
      seg('debug', () => {
        swDebug.checked = !!s.debugEnabled;
        const dc: Record<string, boolean> = s.debugComponents || {};
        debugComps.forEach(([k]) => {
          if (swDebugComps[k]) swDebugComps[k].checked = dc[k] !== false; // 默认开启
        });
      });
      seg('bangumi', () => {
        // Bangumi Token 回填（已保存则显示星号掩码，不显示明文）
        const bt: string | null = s.bangumiToken || null;
        if (bt) {
          bangumiReal = bt;
          bangumiInput.value = maskBangumi(bt);
          bangumiInput.readOnly = true;
          bangumiStatus.textContent = '已保存 Token';
          bangumiStatus.style.color = 'var(--fnos-ui-ok)';
        } else {
          bangumiReal = '';
          bangumiInput.value = '';
          bangumiInput.readOnly = false;
          bangumiStatus.textContent = '';
        }
        // Bangumi 同步开关 + 阈值回填
        swBangumiSync.checked = !!s.bangumiSyncEnabled;
        bangumiThresholdInput.value = String(s.bangumiSyncThreshold || 80);
      });
      seg('tmdb', () => {
        // TMDB Key 回填（已保存则显示星号掩码，不显示明文）
        const kt: string | null = s.tmdbApiKey || null;
        if (kt) {
          tmdbReal = kt;
          tmdbInput.value = maskTmdb(kt);
          tmdbInput.readOnly = true;
          tmdbStatus.textContent = '已保存 TMDB Key';
          tmdbStatus.style.color = 'var(--fnos-ui-ok)';
        } else {
          tmdbReal = '';
          tmdbInput.value = '';
          tmdbInput.readOnly = false;
          tmdbStatus.textContent = '';
        }
        // TMDB 免梯子直连回填
        dcToggle.checked = !!s.tmdbDirectConnect;
        const dip: any = s.tmdbDirectIp || null;
        dcApiInput.value = (dip && dip.api) || '';
        dcImgInput.value = (dip && dip.img) || '';
      });
      seg('bili-search', () => {
        // MPV B站弹幕搜索开关回填（默认开启）
        swMpvBiliSearch.checked = s.mpvBiliSearchEnabled !== false;
        // B站弹幕聚合阈值回填（默认 1500；<0 视为禁用=0）
        aggInput.value = String(s.mpvBiliAggregateThreshold == null ? 1500 : (s.mpvBiliAggregateThreshold < 0 ? 0 : s.mpvBiliAggregateThreshold));
      });
      seg('danmaku', () => {
        // [lc-215] 弹幕分区已改为「B站弹幕屏蔽」：回填屏蔽类型勾选 + 屏蔽词，不再回填被移除的样式项
        const bt: string[] = Array.isArray(s.biliDanmakuBlockTypes) ? s.biliDanmakuBlockTypes : [];
        for (const b of blockToggles) b.input.checked = bt.includes(b.key);
        if (danBlacklist && danBlacklist.ta) danBlacklist.ta.value = s.biliDanmakuBlacklist || '';
      });
      // 诊断日志：面板每次打开都记录关键回填值，便于核对「配置文件 vs 面板显示」是否一致
      log('SETTINGS refresh done: bangumiSyncEnabled=' + String(s.bangumiSyncEnabled)
        + ' swChecked=' + String(swBangumiSync.checked)
        + ' token=' + (s.bangumiToken ? 'set' : 'none'));
    };

    // 点击面板外部时自动收起
    document.addEventListener('click', (ev: Event) => {
      if (overlay.style.display !== 'flex') return;
      const t = ev.target as Node;
      if (overlay.contains(t)) return;
      const sb = document.getElementById('fnos-settings-btn');
      if (sb && sb.contains(t)) return;
      // 落在其他自建设置弹窗(检查更新 fnosDialog / 反馈 / B站登录)内时,
      // 不连带关闭设置面板, 实现\"一层一层关\"的层级交互。
      if (t instanceof Element) {
        const withinOtherUi = t.closest('#fnos-dialog-overlay')
          || t.closest('#fnos-feedback-modal')
          || t.closest('#fnos-qq-group-modal')
          || t.closest('#fnos-bili-modal')
          || t.closest('#fnos-history-overlay');
        if (withinOtherUi) return;
      }
      overlay.style.display = 'none';
    }, true);

    document.body.appendChild(mask);
    document.body.appendChild(overlay);
  }

  /** [新] 打开设置面板: 固定宽度, 整窗口正中居中显示并刷新数据 */
  function openSettingsPanel(_panel?: HTMLElement, sectionId?: string): void {
    const overlay = document.getElementById('fnos-settings-panel') as HTMLElement | null;
    if (!overlay) return;
    // 整个客户端窗口正中居中(不再贴侧栏)
    overlay.style.top = '50%';
    overlay.style.left = '50%';
    overlay.style.right = 'auto';
    overlay.style.bottom = 'auto';
    overlay.style.transform = 'translate(-50%, -50%)';
    overlay.style.width = 'min(680px, calc(100vw - 80px))';
    overlay.style.height = 'auto'; // 高度自适应内容
    overlay.style.maxHeight = (window.innerHeight - 120) + 'px'; // 超高则内部滚动
    overlay.style.display = 'flex';
    const mask = document.getElementById('fnos-settings-mask');
    if (mask) mask.style.display = 'block';
    const refresh = (overlay as any)._refresh;
    if (typeof refresh === 'function') refresh();
    if (sectionId) {
      // [适配左导航布局] 若 sectionId 对应某个分类, 直接切换显示该分类; 否则回退到滚动定位
      const catMap: Record<string, string> = { danmaku: 'danmaku' };
      const sel = (overlay as any)._selectCat;
      if (catMap[sectionId] && typeof sel === 'function') {
        sel(catMap[sectionId]);
      } else {
        const target = document.getElementById('sec-' + sectionId);
        if (target) requestAnimationFrame(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      }
    }
  }

  // [lc-199] 控制栏「弹幕样式」按钮 → 主进程转发 → 打开设置面板并定位到弹幕分区
  // [lc-518] 首页更新弹窗「应用补丁」→ 主进程发 fntv-open-settings('patch')：
  //   打开设置面板并定位后，自动唤起补丁应用弹窗(autoApply 直接下载显示进度，复用已验证路径)
  ipcRenderer.on('fntv-open-settings', (_e: any, sectionId: string) => {
      if (sectionId === 'patch') {
          openSettingsPanel(undefined, 'patch');
          setTimeout(() => {
              console.log('[EmbyWall][patch] 更新弹窗跳转设置面板后自动应用补丁');
              fntvOpenPatchApplyPopup(true);
          }, 350);
          return;
      }
      openSettingsPanel(undefined, sectionId);
  });

  /** 判断某 background-color 是否为"不透明/半透明的白/浅灰底"(需透明化让浅蓝透出) */
  function isOpaqueLightBg(bg: string): boolean {
    if (!bg) return false;
    const m = bg.match(/rgba?\(([^)]+)\)/);
    if (!m) return false;
    const parts = m[1].split(',').map(s => parseFloat(s.trim()));
    const [r, g, b, a = 1] = parts;
    if (a < 0.05) return false;               // 已透明, 跳过
    return r >= 235 && g >= 235 && b >= 235;  // 白/浅灰系(避免误伤蓝色/深色按钮)
  }
  const animateCloseDrawer = (d: HTMLElement): void => {
    d.classList.remove('drawer-open');
    // 过渡结束后(340ms)才真正移除 display, 期间 opacity→0+pointer-events:none 已不可点, 安全
    window.setTimeout(() => { if (!d.classList.contains('drawer-open')) d.style.removeProperty('display'); }, 340);
  };

  const ensureBurgerVisible = () => {
    // ① 强制可见: 宽屏下汉堡键被Tailwind @media钉死display:none, 强制显示(不影响布局/抽屉)
    const burger = document.querySelector('[class*="lg:!hidden"]:not([class*="inset-0"])') as HTMLElement | null;
    if (!burger) return;
    if (getComputedStyle(burger).display === 'none') {
      burger.style.setProperty('display', 'flex', 'important');
    }
    // [v351] 侧栏毛玻璃: 只要抽屉DOM存在就注入(无论开/关状态, openDrawer也会再调)
    const _dr = document.querySelector('.fixed.inset-0[class*="lg:!hidden"]') as HTMLElement | null;
    if (_dr) applySidebarGlass(_dr);
    // ② 汉堡键点击: 完全接管抽屉开合 (capture 阶段拦截飞牛原生 onClick, 避免双重控制)
    //   [v325/v326 关键修正] 之前用冒泡且不拦截飞牛 → 飞牛原生 toggle 与我们的 inline 切换
    //   双重控制, 宽屏下飞牛 onClick 有时激活、有时 no-op, 导致抽屉"能开不能收/卡死"。
    //   改为: capture 阶段 stopImmediatePropagation 拦截飞牛, 由我们唯一用 inline style 控制显隐。
    //   因从不修改 !hidden 类(飞牛 state 永远不变/与 DOM 一致), 不会触发 state 同步死锁
    //   (与 v322 的 !hidden 类编辑死锁本质不同)。
    //   [v329 动画] 开合不再瞬切 display, 改为 display:flex + 双rAF切 .drawer-open 类驱动 CSS 过渡
    //     (overlay opacity 淡入 + 面板 translateX 滑入); 关闭时移除类、过渡结束(340ms)后再移除 display。
    if (!(burger as any).dataset.burgerHooked) {
      (burger as any).dataset.burgerHooked = '1';
      burger.addEventListener('click', (e: Event) => {
        if ((e.target as HTMLElement).closest('a')) return; // 🏠 首页链接放行(不拦截, 交给飞牛导航)
        e.preventDefault();
        e.stopImmediatePropagation(); // 拦截飞牛原生 onClick, 避免双重控制
        const drawer = document.querySelector('.fixed.inset-0[class*="lg:!hidden"]') as HTMLElement | null;
        if (!drawer) return;
        // 接管抽屉开合(动画版): 不动 !hidden 类, 用 display + .drawer-open 类驱动 CSS 过渡
        if (drawer.classList.contains('drawer-open')) { animateCloseDrawer(drawer); log('BURGER -> CLOSE (anim)'); }
        else { openDrawer(drawer); log('BURGER -> OPEN (anim)'); }
      }, true); // capture 阶段, 抢在 React 之前拦截
      log('BURGER click-hook installed (capture+stop)');
    }
    // ③ 遮罩/背板点击关闭: 点抽屉背板(非侧栏面板)即关闭
    //    [v326 修正] 之前用 `e.target === drawer` 太严格 —— 实际暗色背板是 drawer 的子元素(.absolute.inset-0),
    //    点背板时 e.target 是背板而非 drawer → 旧逻辑不关 → 宽屏下飞牛无原生 handler → 抽屉卡死不收回。
    //    改为: 点 drawer 本身或其背板子元素(非面板)即关闭; capture 拦截飞牛, 由我们唯一控制。
    const drawer = document.querySelector('.fixed.inset-0[class*="lg:!hidden"]') as HTMLElement | null;
    if (drawer && !(drawer as any).dataset.maskHooked) {
      (drawer as any).dataset.maskHooked = '1';
      drawer.addEventListener('click', (e: Event) => {
        const panel = drawer.querySelector('[class*="relative"]');
        const onPanel = panel ? panel.contains(e.target as Node) : false;
        if (onPanel) return; // 点在侧栏面板内(菜单项)不关闭, 交给飞牛处理点击
        const backdrop = drawer.querySelector('.absolute.inset-0') || drawer.querySelector('[class*="absolute"]');
        const onBackdrop = (backdrop && backdrop.contains(e.target as Node)) || e.target === drawer;
        if (!onBackdrop) return;
        e.stopImmediatePropagation(); // 拦截飞牛原生遮罩 handler, 避免双重控制
        if (drawer.classList.contains('drawer-open')) { animateCloseDrawer(drawer); log('MASK -> CLOSED (anim)'); }
      }, true); // capture 阶段
      log('MASK click-close-hook installed (capture+stop)');
    }
  };
  // 立即执行一次 + 定时巡检
  ensureBurgerVisible();
  [800, 2000, 4000].forEach(t => setTimeout(ensureBurgerVisible, t));

  // ═══ 首页导航栏刷新按钮 ═══
  // 在飞牛原生导航栏「首页」标签右侧注入刷新按钮，点击后 reload 页面。
  // 飞牛 SPA 路由切换会重建导航 DOM → 用 MutationObserver 兜底重建按钮。
  const injectRefreshButton = (): void => {
    if (document.getElementById('fnos-refresh-btn')) return; // 幂等

    // ── 以汉堡键 ☰ 为锚点（与 ensureBurgerVisible 同一选择器，已验证可靠）──
    // 顶栏实际布局: [☰] [首页] ... [logo] [搜索] [用户] [设置]
    // 刷新按钮目标位置: 「首页」文字右侧、紧邻着
    const burger = document.querySelector('[class*="lg:!hidden"]:not([class*="inset-0"])') as HTMLElement | null;
    if (!burger) return; // 汉堡键还没渲染

    // 排除侧边栏/抽屉内的汉堡键（只要顶栏那个）
    const SIDEBAR_SEL = 'aside, [class*="sidebar"], [class*="drawer"], [class*="offcanvas"], [class*="side-panel"], [role="dialog"][aria-label*="导航"], [id*="sidebar"], [id*="drawer"]';
    if (burger.closest(SIDEBAR_SEL)) return;

    // 在汉堡键的父容器（导航栏）内，找紧挨着汉堡键的「首页」文字元素
    const navBar = burger.parentElement;
    if (!navBar) return;

    let anchorEl: HTMLElement | null = null;
    // 从汉堡键开始向后遍历兄弟节点，找含"首页"文字的元素
    let sibling = burger.nextElementSibling as HTMLElement | null;
    while (sibling) {
      if ((sibling.textContent || '').trim() === '首页' || sibling.querySelector(':scope > *')) {
        // 如果是包含"首页"的容器或"首页"本身
        const textEls = sibling.querySelectorAll('*');
        for (const t of Array.from(textEls) as HTMLElement[]) {
          if (t.children.length === 0 && (t.textContent || '').trim() === '首页') {
            anchorEl = t.parentElement ?? sibling;
            break;
          }
        }
        if (!anchorEl && (sibling.textContent || '').trim() === '首页') {
          anchorEl = sibling;
        }
      }
      if (anchorEl) break;
      sibling = sibling.nextElementSibling as HTMLElement | null;
    }

    // 兜底：找不到「首页」就插在汉堡键紧后面
    if (!anchorEl) anchorEl = burger;

    const btn = document.createElement('button');
    btn.id = 'fnos-refresh-btn';
    btn.title = '刷新页面';
    btn.style.cssText = 'background:none;border:none;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:4px 8px;margin-left:4px;border-radius:6px;transition:background .15s;color:var(--fnos-titlebar-icon,#666);vertical-align:middle;font-size:14px;line-height:1;position:relative;top:2px;';
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13.65 2.35A7.96 7.96 0 0 0 8 0C3.58 0 0 3.58 0 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 8 14 6 6 0 1 1 8 2c1.66 0 3.14.69 4.22 1.78L9 7h7V0l-2.35 2.35z" fill="currentColor"/></svg>';
    btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(0,0,0,.06)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'none'; });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      location.reload();
    });
    // 插入到锚点元素（「首页」或汉堡键）的后面
    anchorEl.parentNode?.insertBefore(btn, anchorEl.nextSibling);
    log('Refresh button injected after anchor (burger/首页)');
  };
  // 立即尝试 + 延迟重试(导航栏可能尚未渲染)
  injectRefreshButton();
  [1000, 3000, 6000].forEach(t => setTimeout(injectRefreshButton, t));
  // MutationObserver 兜底: SPA 切换导航重建时重新注入
  const _refreshObsTimer = 0;
  const _refreshObserver = new MutationObserver(() => {
    window.setTimeout(injectRefreshButton, 200);
  });
  _refreshObserver.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('beforeunload', () => _refreshObserver.disconnect());

  // [v323] MutationObserver兜底: 飞牛SPA路由切换/重渲染头部时, 新汉堡键DOM无hook → 立即重绑
  // (解决: 轮播图整页导航→详情页头部重建→定时重试可能错过新元素 → hook丢失 → 点击失效)
  let _burgerObsTimer = 0;
  const _burgerObserver = new MutationObserver(() => {
    clearTimeout(_burgerObsTimer);
    _burgerObsTimer = window.setTimeout(ensureBurgerVisible, 120); // 幂等: 重绑汉堡键+遮罩hook(飞牛SPA重渲染新元素时兜底)
  });
  _burgerObserver.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('beforeunload', () => _burgerObserver.disconnect());

  // 页面切换过渡(防黑屏闪烁): 一层与背景同色的轻纱, 导航瞬间覆盖→淡出, 平滑揭示新页面
  let _veil: HTMLElement | null = null;
  const getVeil = (): HTMLElement => {
    if (_veil && document.body.contains(_veil)) return _veil;
    const v = document.createElement('div');
    v.id = 'fnos-page-veil';
    v.style.cssText = 'position:fixed;top:32px;left:0;right:0;bottom:0;z-index:9000;pointer-events:none;opacity:0;background:var(--fnos-ui-veil);transition:opacity .26s ease;border-radius:0 0 16px 16px;overflow:hidden;';
    document.body.appendChild(v);
    _veil = v;
    return v;
  };
  const pageTransition = (): void => {
    const v = getVeil();
    v.style.transition = 'none';
    v.style.opacity = '0.82';   // 瞬间覆盖, 挡住导航瞬间的黑/白闪
    void v.offsetWidth;          // 强制回流, 让"覆盖"立即生效
    v.style.transition = 'opacity .26s ease';
    requestAnimationFrame(() => { v.style.opacity = '0'; }); // 淡出揭示新页面
  };

  // [lc-153] 修复: 透明窗口下, fnOS 视图栈残留的旧页面透出下层内容(而非桌面)
  // 原理: fnOS(Emby系) SPA 路由切换会把旧页面保留在 DOM 里做"下层页面"(返回手势/转场用).
  //       我们让页面透明后, 上层剧集页的透明区就透出了下层影视页的内容.
  // 修复: 导航后隐藏视图栈里非活跃的下层页面(用非important的 display:none, 允许 fnOS 返回时恢复),
  //       让活跃页的透明区直接落到 body(桌面亚克力).
  // 启发式: 仅针对 position:absolute 且占满视口的直接兄弟(视图通常在 relative 容器内 absolute 堆叠);
  //        排除 fixed 覆盖层(抽屉/遮罩)、我们的 fnos-* 注入、导航栏等.
  const hideStaleViews = (): void => {
    const vw = window.innerWidth, vh = window.innerHeight;

    // [lc-278] 视频播放场景保护: fnOS 播放视频时, <video> 常位于某个全屏 absolute 视图内的 fixed 全屏层。
    // 若此处隐藏该 absolute 视图(残留页), 会整棵子树 display:none → 连带视频被隐藏 → 黑屏但有声音。
    // 故: 只要页面存在 <video>(或视频播放容器), 整个 hideStaleViews 跳过; 视频全屏覆盖无需防透出。
    if (document.querySelector('video')) {
      log('hideStaleViews: SKIP — <video> present, avoid hiding video page');
      return;
    }
    // <video> 标签可能尚未插入(缓冲中): 用播放页容器 class 兜底(Emby/fnOS: .videoPlayer/.playerPage 通常先于 <video> 创建)
    if (document.querySelector('.videoPlayer, .playerPage, #videoPlayer, [data-itemtype="Video"]')) {
      log('hideStaleViews: SKIP — video container present');
      return;
    }

    const candidates: HTMLElement[] = [];
    const all = document.querySelectorAll<HTMLElement>('*');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const cs = getComputedStyle(el);
      if (cs.position !== 'absolute') continue;           // 视图是 absolute 堆叠; fixed 是覆盖层, 跳过
      const rect = el.getBoundingClientRect();
      if (rect.width < vw * 0.8 || rect.height < vh * 0.8) continue;
      if (el.id && el.id.startsWith('fnos-')) continue;    // 我们的注入层跳过
      if (el.classList.contains('absolute')) continue;     // 抽屉遮罩类跳过
      if (el.querySelector('video')) continue;             // [lc-278] 含视频的视图绝不隐藏(双保险)
      candidates.push(el);
    }
    // 按父元素分组, 同容器内多个全屏 absolute 视为视图栈
    const byParent = new Map<HTMLElement, HTMLElement[]>();
    for (const el of candidates) {
      const p = el.parentElement;
      if (!p) continue;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p)!.push(el);
    }
    for (const [parent, views] of byParent) {
      if (views.length < 2) continue;                      // 只有一个视图无需处理
      // DOM 末尾的视图=当前活跃页, 隐藏其余(非important, fnOS 返回可恢复)
      for (let i = 0; i < views.length - 1; i++) {
        if (getComputedStyle(views[i]).display !== 'none') {
          views[i].style.display = 'none';
          log('hideStaleViews: hid stacked view', i + 1, '/', views.length, '| class=', views[i].className.slice(0, 40));
        }
      }
    }
  };

  // 导航时关闭抽屉(菜单项跳转/路由切换后不应残留打开的抽屉)
  const closeDrawer = () => {
    const d = document.querySelector('.fixed.inset-0[class*="lg:!hidden"]') as HTMLElement | null;
    if (d && d.classList.contains('drawer-open')) { animateCloseDrawer(d); log('NAV -> DRAWER CLOSED (anim)'); }
  };
  try {
    const _ps = history.pushState, _rs = history.replaceState;
    (history as any).pushState = function (...a: any[]) { _ps.apply(this, a as any); logNav('pushState'); pageTransition(); setTimeout(ensureBurgerVisible, 300); setTimeout(closeDrawer, 300); setTimeout(hideStaleViews, 400); };
    (history as any).replaceState = function (...a: any[]) { _rs.apply(this, a as any); logNav('replaceState'); pageTransition(); setTimeout(closeDrawer, 300); setTimeout(hideStaleViews, 400); };
    window.addEventListener('popstate', () => { logNav('popstate'); pageTransition(); setTimeout(ensureBurgerVisible, 300); setTimeout(closeDrawer, 300); setTimeout(hideStaleViews, 400); });
    window.addEventListener('hashchange', () => logNav('hashchange'));
    setTimeout(hideStaleViews, 1500); // 初始/深链到详情页时也清理一次
  } catch (e) { log('NAV hook err', String(e).substring(0, 60)); }


  // 详情页液态玻璃: 检测URL→分发到TV详情/Season详情
  if (isDetailPage()) {
    applyDetailLiquidGlass();
    backfillDetailLogo();
    // 延迟重试: SPA渲染可能分批加载DOM
    [600, 1500, 3000].forEach(ms => setTimeout(() => { applyDetailLiquidGlass(); backfillDetailLogo(); }, ms));
    // 导航切换时重新检测
    const _origPush = (history as any).pushState;
    const _origReplace = (history as any).replaceState;
    // 已在上面hook过, 只需添加detail glass重触发
  }
  // MutationObserver 也覆盖详情页DOM变化
  let _detailGlassTimer = 0;
  const _detailObs = new MutationObserver(() => {
    clearTimeout(_detailGlassTimer);
    _detailGlassTimer = window.setTimeout(() => {
      if (isDetailPage()) { applyDetailLiquidGlass(); backfillDetailLogo(); }
    }, 200);
  });
  _detailObs.observe(document.body, { childList: true, subtree: true });

  // 1) 首屏: 硬编码数据立即渲染
  injectCarousel();

  // 2) 异步: 用已知剧集GUID反查库GUID→item/list→动态数据
  fetchShowsViaIPC(base).then(() => {
    if (_apiShows.length === 0) { log('API empty'); return; }
    log('got', _apiShows.length, 'shows from API, rebuilding');
    _carouselInited = false;
    injectCarousel();
  }).catch(e => log('fetch error:', e));

  // 3) 定时自动刷新轮播内容(无需退出重开):
  //    库数据变化(新增/改名/排序)后, 留在首页即可看到最新轮播。
  //    仅在轮播当前可见(处于首页)时重拉, 避免后台无意义 iframe 轮询;
  //    非首页时安全跳过(注入逻辑找不到"媒体库"节点会自动 return)。
  const CAROUSEL_REFRESH_MS = 5 * 60 * 1000;
  setInterval(() => {
    if (_apiLoading) return;
    if (document.hidden) return; // 后台标签页跳过(iframe/fetch 会被浏览器节流, 必然失败/超时)
    if (!_carouselContainer || !document.body.contains(_carouselContainer)) return; // 仅首页可见时刷新
    _apiLoaded = false; // 解除"只拉一次"守卫, 允许重拉
    log('carousel auto-refresh: re-fetching');
    fetchShowsViaIPC(base).then(() => {
      if (_apiShows.length === 0) return;
      log('carousel auto-refresh: got', _apiShows.length, 'shows, rebuilding');
      _carouselInited = false;
      injectCarousel();
    }).catch(e => log('carousel auto-refresh error:', e));
  }, CAROUSEL_REFRESH_MS);

  wheelToScroll();
  [2000, 4000, 8000].forEach(ms => setTimeout(wheelToScroll, ms));

  let _wtsTimer = 0;
  new MutationObserver(() => {
    clearTimeout(_wtsTimer);
    _wtsTimer = window.setTimeout(wheelToScroll, 350);
    if (_carouselContainer && !document.body.contains(_carouselContainer)) {
      log('carousel lost, re-inject');
      _carouselContainer = null;
      _carouselInited = false;
    }
    if (!_carouselInited) injectCarousel();
  }).observe(document.body, { childList: true, subtree: true });

  setInterval(() => {
    wheelToScroll();
    if (_carouselContainer && !document.body.contains(_carouselContainer)) {
      log('watchdog: carousel lost');
      _carouselContainer = null;
      _carouselInited = false;
      injectCarousel();
    }
  }, 5000);

  // [lc-279] 播放页打标: 页面存在 <video> 时给 <html> 加 fnos-video-active,
  // 使 mainwin.ts 注入的 ACRYLIC_CSS 中 lc-179 的 modal 例外规则(白底 #fff/#2b2a33)在播放页整体失效,
  // 恢复 fnOS 播放器浮层原生深色玻璃(根治右下角按钮弹窗全白);
  // 非播放页(系统弹窗如创建媒体库)保留该规则, 继续修复"遮罩透出首页轮播图"。
  const _syncVideoActiveClass = (): void => {
    const hasVideo = !!document.querySelector('video');
    document.documentElement.classList.toggle('fnos-video-active', hasVideo);
  };
  _syncVideoActiveClass();
  setInterval(_syncVideoActiveClass, 1000);

  // [lc-302c] 历史: 弹窗内 .ms-container 曾被布局守护(lc-190 fixDetailLayoutWidth)误强加
  //   min-width:1057px !important(此前误判为 fnOS 滚动库运行时写入)。该布局守护已于 [lc-406] 整体删除,
  //   故此处不再需要对抗式 MutationObserver; mainwin.ts 的 ACRYLIC_CSS ⑭ 仍保留作为 class 级兜底。
}

// [lc-406] 布局守护(fixDetailLayoutWidth 函数及其 IIFE 调用点)已整体删除:
//   列表页居中布局来自用户自有设计(injectCarousel/主题注入), 与该守护无关;
//   且该守护曾因 IIFE 在 document.body 为 null 时 observe() 抛错而中断 preload 初始化(见 lc-404 根因).
//   删除后此处不再有任何模块级副作用代码, registerHook 稳定执行即可.
registerHook(HookType.OnReady, handle);

/* ========== [恢复v381] 反馈弹窗 ========== */
const ABOUT_LINK_URL = 'https://github.com/YDMY007/Fntv-Plus';

const FEEDBACK_LINK_URL = 'https://wj.qq.com/s2/27390788/787a/';
const QQ_GROUP_URL = 'https://qm.qq.com/q/dUnIQVvoIw'; // [lc-361] QQ 交流群(原侧栏"Q群反馈"按钮迁入反馈选择弹窗)
const openFeedbackModal = async (): Promise<void> => {
  let modal = document.getElementById('fnos-feedback-modal') as HTMLElement | null;
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'fnos-feedback-modal';
    modal.setAttribute('data-fnos-ui', '1'); // 免疫白底清除器(否则卡片浅粉底会被清成透明)
    modal.style.cssText = 'position:fixed;z-index:2147483701;inset:0;display:none;align-items:center;justify-content:center;'
      + 'background:rgba(0,0,0,.5);';
    modal.addEventListener('click', (e: Event) => { if (e.target === modal) modal!.style.display = 'none'; });

    const card = document.createElement('div');
    card.style.cssText = 'width:300px;border-radius:18px;padding:24px;color:var(--fnos-ui-text);'
      + 'background:var(--fnos-ui-panel-bg)!important;'
      + 'border:1px solid var(--fnos-ui-border-outer);'
      + 'box-shadow:0 18px 50px rgba(80,60,120,.28),0 4px 16px rgba(80,60,120,.14);'
      + 'backdrop-filter:blur(30px) saturate(150%);-webkit-backdrop-filter:blur(30px) saturate(150%);'
      + 'text-align:center;';

    card.innerHTML = ''
      + '<div id="fnos-feedback-back" style="display:flex;align-items:center;gap:6px;margin-bottom:16px;cursor:pointer;'
      +   'font-size:13px;font-weight:600;color:var(--fnos-ui-pill-text);">'
      +   '<span style="font-size:17px;line-height:1;">←</span><span>返回</span></div>'
      + '<div style="font-size:20px;font-weight:800;color:var(--fnos-ui-pill-text);margin-bottom:6px;">💬 意见反馈</div>'
      + '<div style="font-size:12.5px;line-height:1.7;color:var(--fnos-ui-text);opacity:.82;margin-bottom:16px;">'
      +   '欢迎扫码填写问卷，向我们反馈使用体验与建议。</div>'
      + '<div id="fnos-feedback-qr" style="width:180px;height:180px;margin:0 auto 14px;background:#fff;border-radius:12px;overflow:hidden;'
      +   'display:flex;align-items:center;justify-content:center;"></div>'
      + '<div style="font-size:11px;opacity:.65;margin-bottom:14px;">扫码参与用户调研</div>'
      + '<a id="fnos-feedback-link" href="' + FEEDBACK_LINK_URL + '" style="display:inline-block;font-size:13px;font-weight:700;'
      +   'color:var(--fnos-ui-pill-text);text-decoration:none;padding:8px 20px;border-radius:10px;'
      +   'background:var(--fnos-ui-pill-bg)!important;border:1px solid var(--fnos-ui-pill-border);'
      +   'transition:background .15s,transform .1s;">🔗 用户调研问卷</a>';

    modal.appendChild(card);
    document.body.appendChild(modal);

    (document.getElementById('fnos-feedback-back') as HTMLElement).addEventListener('click', (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      modal!.style.display = 'none';
      const choice = document.getElementById('fnos-feedback-choice-modal');
      if (choice) choice.style.display = 'flex';
    });
    (document.getElementById('fnos-feedback-link') as HTMLElement).addEventListener('click', async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      try { await ipcRenderer.invoke('app:open-external', FEEDBACK_LINK_URL); } catch (_) {}
    });
    const flink = document.getElementById('fnos-feedback-link') as HTMLElement;
    flink.onmouseenter = () => { flink.style.transform = 'scale(1.03)'; flink.style.background = 'var(--fnos-ui-pill-hover)!important'; flink.style.color = '#fff'; };
    flink.onmouseleave = () => { flink.style.transform = ''; flink.style.background = 'var(--fnos-ui-pill-bg)!important'; flink.style.color = 'var(--fnos-ui-pill-text)'; };
  }
  modal.style.display = 'flex';

  // 加载用户给的二维码图片（主进程读取 build/qrcode.png 返回 base64）
  const qrBox = document.getElementById('fnos-feedback-qr') as HTMLElement | null;
  if (qrBox && !qrBox.querySelector('img')) {
    try {
      const res = await ipcRenderer.invoke('app:qr-image') as any;
      if (res && res.ok && res.dataUri) {
        const img = document.createElement('img');
        img.src = res.dataUri;
        img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
        qrBox.appendChild(img);
      } else {
        qrBox.textContent = 'QR';
      }
      } catch (e) { qrBox.textContent = 'QR'; }
  }
};

/* ========== [lc-361] 反馈方式选择弹窗（合并"问卷反馈"与"Q群反馈"为单一入口） ========== */
const openFeedbackChoiceModal = (): void => {
  let modal = document.getElementById('fnos-feedback-choice-modal') as HTMLElement | null;
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'fnos-feedback-choice-modal';
    modal.setAttribute('data-fnos-ui', '1'); // 免疫白底清除器
    modal.style.cssText = 'position:fixed;z-index:2147483702;inset:0;display:none;align-items:center;justify-content:center;'
      + 'background:rgba(0,0,0,.5);';
    modal.addEventListener('click', (e: Event) => { if (e.target === modal) modal!.style.display = 'none'; });

    const card = document.createElement('div');
    card.style.cssText = 'width:320px;border-radius:18px;padding:22px;color:var(--fnos-ui-text);'
      + 'background:var(--fnos-ui-panel-bg)!important;border:1px solid var(--fnos-ui-border-outer);'
      + 'box-shadow:0 18px 50px rgba(80,60,120,.28),0 4px 16px rgba(80,60,120,.14);'
      + 'backdrop-filter:blur(30px) saturate(150%);-webkit-backdrop-filter:blur(30px) saturate(150%);';

    card.innerHTML = ''
      + '<div style="font-size:19px;font-weight:800;color:var(--fnos-ui-pill-text);margin-bottom:4px;">软件反馈建议</div>'
      + '<div style="font-size:12.5px;line-height:1.6;color:var(--fnos-ui-text);opacity:.8;margin-bottom:16px;">请选择反馈方式：</div>';

    // 选项一：用户调研问卷（→ 原问卷反馈弹窗）
    const optSurvey = document.createElement('button');
    optSurvey.type = 'button';
    optSurvey.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:3px;width:100%;box-sizing:border-box;'
      + 'padding:14px 16px;margin-bottom:12px;border-radius:14px;cursor:pointer;text-align:center;'
      + 'background:var(--fnos-ui-input-bg)!important;border:1px solid var(--fnos-ui-border3);color:var(--fnos-ui-text);'
      + 'transition:background .15s,border-color .15s;';
    optSurvey.innerHTML = '<div style="font-size:14px;font-weight:700;">📝 用户调研问卷</div>'
      + '<div style="font-size:11.5px;opacity:.7;">填写问卷，反馈使用体验与建议</div>';
    optSurvey.addEventListener('click', () => {
      if (modal) modal.style.display = 'none';
      openFeedbackModal();
    });

    // 选项二：QQ 交流群（→ 系统浏览器打开群链接）
    const optQQ = document.createElement('button');
    optQQ.type = 'button';
    optQQ.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:3px;width:100%;box-sizing:border-box;'
      + 'padding:14px 16px;border-radius:14px;cursor:pointer;text-align:center;'
      + 'background:var(--fnos-ui-input-bg)!important;border:1px solid var(--fnos-ui-border3);color:var(--fnos-ui-text);'
      + 'transition:background .15s,border-color .15s;';
    optQQ.innerHTML = '<div style="font-size:14px;font-weight:700;">💬 QQ 交流群</div>'
      + '<div style="font-size:11.5px;opacity:.7;">加入 QQ 群，实时交流反馈</div>';
    optQQ.addEventListener('click', () => {
      if (modal) modal.style.display = 'none';
      openQQGroupModal();
    });

    // 悬停高亮
    [optSurvey, optQQ].forEach((b) => {
      b.addEventListener('mouseenter', () => { b.style.background = 'var(--fnos-ui-pill-hover)!important'; b.style.borderColor = 'var(--fnos-ui-pill-border)'; });
      b.addEventListener('mouseleave', () => { b.style.background = 'var(--fnos-ui-input-bg)!important'; b.style.borderColor = 'var(--fnos-ui-border3)'; });
    });

    card.appendChild(optSurvey);
    card.appendChild(optQQ);
    modal.appendChild(card);
    document.body.appendChild(modal);
  }
  modal.style.display = 'flex';
};

/* ========== [lc-362] QQ 交流群弹窗（带返回按钮，一层一层返回） ========== */
const openQQGroupModal = (): void => {
  let modal = document.getElementById('fnos-qq-group-modal') as HTMLElement | null;
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'fnos-qq-group-modal';
    modal.setAttribute('data-fnos-ui', '1'); // 免疫白底清除器
    modal.style.cssText = 'position:fixed;z-index:2147483703;inset:0;display:none;align-items:center;justify-content:center;'
      + 'background:rgba(0,0,0,.5);';
    modal.addEventListener('click', (e: Event) => { if (e.target === modal) modal!.style.display = 'none'; });

    const card = document.createElement('div');
    card.style.cssText = 'width:320px;border-radius:18px;padding:22px;color:var(--fnos-ui-text);'
      + 'background:var(--fnos-ui-panel-bg)!important;border:1px solid var(--fnos-ui-border-outer);'
      + 'box-shadow:0 18px 50px rgba(80,60,120,.28),0 4px 16px rgba(80,60,120,.14);'
      + 'backdrop-filter:blur(30px) saturate(150%);-webkit-backdrop-filter:blur(30px) saturate(150%);';

    card.innerHTML = ''
      + '<div id="fnos-qq-back" style="display:flex;align-items:center;gap:6px;margin-bottom:16px;cursor:pointer;'
      +   'font-size:13px;font-weight:600;color:var(--fnos-ui-pill-text);">'
      +   '<span style="font-size:17px;line-height:1;">←</span><span>返回</span></div>'
      + '<div style="font-size:20px;font-weight:800;color:var(--fnos-ui-pill-text);margin-bottom:6px;">💬 QQ 交流群</div>'
      + '<div style="font-size:12.5px;line-height:1.7;color:var(--fnos-ui-text);opacity:.82;margin-bottom:18px;">'
      +   '点击下方按钮加入 QQ 群，实时交流使用体验与建议。</div>'
      + '<a id="fnos-qq-join" href="' + QQ_GROUP_URL + '" style="display:inline-block;font-size:13px;font-weight:700;'
      +   'color:var(--fnos-ui-pill-text);text-decoration:none;padding:9px 22px;border-radius:10px;'
      +   'background:var(--fnos-ui-pill-bg)!important;border:1px solid var(--fnos-ui-pill-border);'
      +   'transition:background .15s,transform .1s;">➕ 加入 QQ 群</a>';

    modal.appendChild(card);
    document.body.appendChild(modal);

    (document.getElementById('fnos-qq-back') as HTMLElement).addEventListener('click', (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      modal!.style.display = 'none';
      const choice = document.getElementById('fnos-feedback-choice-modal');
      if (choice) choice.style.display = 'flex';
    });
    (document.getElementById('fnos-qq-join') as HTMLElement).addEventListener('click', async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      try { await ipcRenderer.invoke('app:open-external', QQ_GROUP_URL); } catch (_) {}
    });
    const qjoin = document.getElementById('fnos-qq-join') as HTMLElement;
    qjoin.onmouseenter = () => { qjoin.style.transform = 'scale(1.03)'; qjoin.style.background = 'var(--fnos-ui-pill-hover)!important'; qjoin.style.color = '#fff'; };
    qjoin.onmouseleave = () => { qjoin.style.transform = ''; qjoin.style.background = 'var(--fnos-ui-pill-bg)!important'; qjoin.style.color = 'var(--fnos-ui-pill-text)'; };
  }
  modal.style.display = 'flex';
};

