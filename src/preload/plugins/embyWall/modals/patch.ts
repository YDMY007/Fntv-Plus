import { S } from '../state';
import { applyLoginBgVar } from '../login';
import { ipcRenderer } from 'electron';
import { wheelToScroll } from '../nav/scroll';
import { applyDetailBeautify } from '../detail/immersive';

// embyWall/modals/patch.ts — 补丁应用向导弹窗（lc-516）：自包含的进度展示与用户确认流程
// 由 scripts/embywall-split.js 从 embyWall.ts 整段抽取；改实现请改这里，不要在入口文件里补。

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

export function fntvOpenPatchApplyPopup(autoApply: boolean): void {
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

/** [lc-1086] 把 DOM 触达推迟到 <html> 存在。
 *  本文件的 settings:get 回调可能落在 document_start 窗口里(documentElement 仍为 null),
 *  实测: 重载后 193ms 抛 Uncaught (in promise) TypeError: Cannot read properties of null (reading 'classList')
 *  @ dest/preload/plugins/embyWall/modals/patch.js:252。抛在 .then 里 → 外层 try/catch 接不住,
 *  同一回调后面的 applyLoginBgVar 等被整体跳过。
 *  状态回填(S.*)与 localStorage 镜像不碰 DOM, 照旧同步执行; <html> 还不存在时页面什么都画不出来,
 *  推迟这两个 DOM 动作没有任何闪烁风险。 */
function whenRootReady(fn: () => void): void {
  if (document.documentElement) { fn(); return; }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { fn(); }, { once: true });
  } else {
    window.setTimeout(() => { fn(); }, 0);
  }
}

// 启动时拉取「详情页美化」偏好(detailBoxless)并 reconcile。
// [lc-980] 此处 .then 异步解析, 晚于入口文件同步执行的初始 applyDetailBeautify(那时用的是默认值)。
//   拿到持久化真值后必须再调一次 applyDetailBeautify: boxless=true → teardown 入口按默认误套的美化;
//   boxless=false 且正在详情页 → 幂等套用/arm。applyDetailBeautify 幂等, 值与默认相同也无副作用。
try {
  ipcRenderer.invoke('settings:get').then((s: any) => {
    if (s && typeof s.detailBoxless === 'boolean') {
      S.detailBoxless = s.detailBoxless;
    }
    applyDetailBeautify();
    // 鼠标滚轮横向滚动开关：false=关闭(恢复飞牛原生上下滚)，缺失/true=开启
    if (s && typeof s.wheelHScroll === 'boolean') {
      S.wheelHScrollEnabled = s.wheelHScroll;
    }
    // 轮播图标题替换为 Logo 开关：缺失/true=开启(替换)，false=保留文字标题
    if (s && typeof s.carouselLogoEnabled === 'boolean') {
      S.carouselLogoEnabled = s.carouselLogoEnabled;
    }
    // 立即按开关状态应用/清除横向滚动劫持（偏好可能与默认值不同）
    wheelToScroll();
    // 回填「热门剧更新」数据源（供设置面板 TMDB 区块初始显隐 TMDB 设置）
    if (s && (s.hotSource === 'tmdb' || s.hotSource === 'douban')) S.hotSource = s.hotSource;
    // [lc-1014] 性能模式：config 真值回填 S + html.fnos-perf 总闸类 + localStorage 镜像
    // （embyWall handle() 在本异步回填前用镜像同步预读，故镜像必须在此保持最新）
    if (s && typeof s.perfModeEnabled === 'boolean') {
      S.perfModeEnabled = s.perfModeEnabled;
      // 镜像必须立刻写: embyWall handle() 在本异步回填前就同步预读它(lc-1014)
      try { localStorage.setItem('fntv-perf-mode', s.perfModeEnabled ? '1' : '0'); } catch (_) {}
      const perf = s.perfModeEnabled;
      whenRootReady(() => { document.documentElement.classList.toggle('fnos-perf', perf); });
    }
    // [lc-120] 自定义登录页背景图：启动时即应用（含登录页），无需打开设置面板
    if (s && s.loginBg) whenRootReady(() => applyLoginBgVar(s.loginBg));
  });
} catch (e) {}

