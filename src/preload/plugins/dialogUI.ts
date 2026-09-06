import { ipcRenderer } from 'electron';
import { registerHook, HookType } from '../core/hooks';
import { renderMarkdown, MD_BODY_CSS } from '../markdown';

// 自定义对话框（磨砂玻璃浮层，材质对齐侧边栏设置面板 #fnos-settings-panel），
// 替代 Electron 原生 dialog.showMessageBox。
// 主进程通过 webContents.send('fnos-dialog:open', payload) 唤起，
// 渲染进程点击按钮后 ipcRenderer.send('fnos-dialog:result', id, index, checkboxChecked) 回传。
//
// [lc-1071] 旧版「粉紫亚克力」近不透明卡（.97/.98 渐变）→ 与设置面板 lc-1043 流光玻璃同配方：
//   blur(30px) saturate(150%) + 165deg 顶缘受光光泽渐变 + 三层玻璃环阴影 + 18px 圆角；
//   文字/按钮色全部走 --fnos-ui-* 主题变量（亮暗主题自适应，与面板同源 theme.ts）。
//   遮罩对齐 #fnos-settings-mask（.22 暗色）但刻意不挂 backdrop-filter —— 透明窗口 +
//   --disable-features=VizDisplayCompositor 下，全屏 blur 层的出现/消失会引发整窗闪一帧；
//   磨砂观感由卡片自身的 backdrop-filter 承担，遮罩只做压暗。
// [lc-1074] 出场时序防「整窗闪白」（用户报障）：双 rAF + 强制 reflow 先画 opacity:0 的
//   完整一帧（遮罩/卡片/blur 表面在不可见帧分配就绪），再开始 180ms 淡入；样式表在
//   OnReady 预注入，避免首次打开时全文档样式重算的顿挫。

interface FnosDialogPayload {
    id: string;
    title: string;
    message?: string;
    detail?: string;
    /** Markdown 更新日志；存在时渲染为富文本（.md-body），优于纯文本 detail */
    markdown?: string;
    type?: 'none' | 'info' | 'question' | 'error';
    buttons?: string[];
    defaultId?: number;
    cancelId?: number;
    checkboxLabel?: string;
    checkboxChecked?: boolean;
}

const ICON: Record<string, { chr: string; color: string }> = {
    info: { chr: 'ℹ', color: '#5b8def' },
    question: { chr: '?', color: '#6d7ff2' },
    error: { chr: '⚠', color: '#e06a5b' },
    none: { chr: '', color: '#6d7ff2' },
};

ipcRenderer.on('fnos-dialog:open', (_event: any, payload: FnosDialogPayload) => {
    if (typeof document === 'undefined' || !document.body) return;
    document.body.appendChild(buildDialog(payload));
});

// [lc-1074] 样式表 OnReady 预注入（幂等）：首次打开弹窗时不再向 head 插样式表 ——
//   插表会触发全文档样式重算，与浮层插入/表面分配叠在同一个帧会放大闪烁。
registerHook(HookType.OnReady, (): void => {
    try { if (typeof document !== 'undefined' && document.documentElement) ensureDialogStyle(); } catch { /* ignore */ }
});

// [lc-1071] 卡片流光高光带（设置面板 #fnos-settings-panel::before 同款，keyframes 独立命名
// 不依赖面板样式是否已注入；reduced-motion 下整段不注入）
function ensureDialogStyle(): void {
    if (document.getElementById('fnos-dialog-style')) return;
    const style = document.createElement('style');
    style.id = 'fnos-dialog-style';
    style.textContent =
        '@media (prefers-reduced-motion: no-preference){'
        + '@keyframes fnos-dlg-sheen{0%{transform:translateX(-160%) skewX(-14deg)}55%,100%{transform:translateX(310%) skewX(-14deg)}}'
        + '#fnos-dialog-overlay [data-fnos-dialog-card="1"]::before{content:"";position:absolute;top:-12%;bottom:-12%;left:0;width:55%;'
        + 'pointer-events:none;z-index:-1;'
        + 'background:linear-gradient(105deg,rgba(255,255,255,0) 0%,rgba(255,255,255,.05) 35%,'
        + 'rgba(255,255,255,.13) 50%,rgba(255,255,255,.05) 65%,rgba(255,255,255,0) 100%);'
        + 'transform:translateX(-160%) skewX(-14deg);animation:fnos-dlg-sheen 7s ease-in-out infinite;}'
        + '}'
        // [lc-1071] 主题 tint 底(glassUI ② 组件磨砂同配方: tint 低透 + blur + 光泽)。弹窗可能
        //   浮在任意页面(含播放页)上，纯磨砂无底色时背后亮度与主题相反会导致文字对比度不足 ——
        //   面板只开在首页无此问题，弹窗必须有主题底色兜底。内联只钉 background-image(不占
        //   background-color)，让本规则以 !important 接管底色。
        + '#fnos-dialog-overlay [data-fnos-dialog-card="1"]{background-color:rgba(255,255,255,.32)!important}'
        + 'html.dark #fnos-dialog-overlay [data-fnos-dialog-card="1"]{background-color:rgba(24,27,40,.45)!important}';
    (document.head || document.documentElement).appendChild(style);
}

function buildDialog(payload: FnosDialogPayload): HTMLElement {
    const type = payload.type || 'none';
    const icon = ICON[type] || ICON.none;

    // 注入 markdown 渲染样式（.md-body），本浮层独立生效，不依赖 embyWall 的全局 CSS
    if (payload.markdown) {
        const style = document.createElement('style');
        style.setAttribute('data-fnos-md', '1');
        style.textContent = MD_BODY_CSS;
        (document.head || document.documentElement).appendChild(style);
    }
    ensureDialogStyle();

    // 遮罩：对齐设置面板 #fnos-settings-mask 的暗色压暗；不挂全屏 backdrop-filter（见文件头注释）。
    //   [lc-1074] !important 必须带 —— 云母增强(glassUI ①b)的 body>div {background:transparent!important}
    //   会把无 important 的行内遮罩压成全透明，弹窗失去压暗对比。
    const overlay = document.createElement('div');
    overlay.id = 'fnos-dialog-overlay';
    overlay.setAttribute('data-fnos-ui', '1');
    overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:2147483647',
        'display:flex', 'align-items:center', 'justify-content:center',
        'background:rgba(18,14,28,.22)!important',
        'opacity:0', 'transition:opacity .18s ease',
        'font-family:"Segoe UI Variable","Segoe UI",system-ui,-apple-system,sans-serif',
    ].join(';') + ';';

    const card = document.createElement('div');
    card.setAttribute('data-fnos-ui', '1');
    card.setAttribute('data-fnos-dialog-card', '1');
    // [lc-1071] 材质 = #fnos-settings-panel 的计算材质：面板原生写法是
    //   background:var(--fnos-ui-panel-bg) 后紧跟 background-image:光泽渐变，后者覆盖前者，
    //   故面板实际表面 = 165deg 光泽渐变（近透明）+ blur(30px) saturate(150%) 磨砂。
    //   此处直接落同一条渐变；主题 tint 底色由 ensureDialogStyle 的样式表接管
    //   （内联只钉 background-image，不占 background-color 长手位）。
    card.style.cssText = [
        'position:relative', 'overflow:hidden',
        'min-width:420px', 'max-width:600px', 'width:90%',
        'background-image:linear-gradient(165deg,rgba(255,255,255,.06) 0%,rgba(255,255,255,.015) 45%,rgba(255,255,255,.005) 100%)!important',
        'backdrop-filter:blur(30px) saturate(150%)', '-webkit-backdrop-filter:blur(30px) saturate(150%)',
        'border-radius:18px',
        'box-shadow:inset 0 0 0 1px rgba(255,255,255,.22),inset 0 1px 0 rgba(255,255,255,.5),0 18px 50px rgba(80,60,120,.28),0 4px 16px rgba(80,60,120,.14)',
        'padding:24px 24px 18px', 'color:var(--fnos-ui-text,#2f3550)',
        'transform:scale(.96)', 'transition:transform .18s cubic-bezier(.22,.61,.36,1)',
    ].join(';') + ';';

    // 头部：图标 + 标题
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:12px;margin-bottom:14px;';
    if (icon.chr) {
        const ic = document.createElement('div');
        ic.style.cssText = [
            'flex:0 0 auto', 'width:34px', 'height:34px', 'border-radius:50%',
            'display:flex', 'align-items:center', 'justify-content:center',
            'font-size:20px', 'font-weight:700', 'color:#fff',
            `background:${icon.color}`, `box-shadow:0 4px 12px ${icon.color}55`,
        ].join(';') + ';';
        ic.textContent = icon.chr;
        header.appendChild(ic);
    }
    const title = document.createElement('div');
    title.style.cssText = 'font-size:17px;font-weight:700;color:var(--fnos-ui-text,#262c44);line-height:1.3;';
    title.textContent = payload.title || '';
    header.appendChild(title);
    card.appendChild(header);

    // 主体
    if (payload.message) {
        const msg = document.createElement('div');
        msg.style.cssText = 'font-size:14px;color:var(--fnos-ui-text,#3d445e);line-height:1.55;margin-bottom:6px;white-space:pre-line;';
        msg.textContent = payload.message;
        card.appendChild(msg);
    }
    if (payload.detail) {
        const detail = document.createElement('div');
        detail.style.cssText = [
            'font-size:12.5px', 'color:var(--fnos-ui-muted2,#737d99)', 'line-height:1.6',
            'max-height:180px', 'overflow-y:auto', 'white-space:pre-line',
            'background:var(--fnos-ui-input-bg,rgba(255,255,255,.5))!important',
            'border-radius:10px', 'padding:10px 12px', 'margin-bottom:6px',
        ].join(';') + ';';
        detail.textContent = payload.detail;
        card.appendChild(detail);
    }

    // Markdown 更新日志（富文本渲染，带独立滚动区）
    if (payload.markdown) {
        const mdWrap = document.createElement('div');
        mdWrap.style.cssText = [
            'max-height:380px', 'overflow-y:auto',
            'background:var(--fnos-ui-input-bg,rgba(255,255,255,.5))!important',
            'border-radius:10px', 'padding:6px 12px', 'margin-bottom:6px',
        ].join(';') + ';';
        mdWrap.innerHTML = renderMarkdown(payload.markdown);
        card.appendChild(mdWrap);
    }

    // 可选 checkbox
    let checked = !!payload.checkboxChecked;
    if (payload.checkboxLabel) {
        const wrap = document.createElement('label');
        wrap.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--fnos-ui-btn-text2,#5a6480);margin-top:8px;cursor:pointer;user-select:none;';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = checked;
        cb.style.cssText = 'width:15px;height:15px;accent-color:var(--fnos-ui-accent,#6d7ff2);';
        cb.addEventListener('change', () => { checked = cb.checked; });
        const txt = document.createElement('span');
        txt.textContent = payload.checkboxLabel;
        wrap.appendChild(cb);
        wrap.appendChild(txt);
        card.appendChild(wrap);
    }

    // 按钮区
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;margin-top:18px;';
    const buttons = payload.buttons && payload.buttons.length ? payload.buttons : ['确定'];
    const defaultId = payload.defaultId ?? 0;
    // [lc-1064] cancelId：Esc 关闭语义的落点；未指定取最后一个按钮（对话框惯例）
    const cancelId = payload.cancelId ?? buttons.length - 1;
    let allBtns: HTMLButtonElement[] = [];
    // 统一关闭出口：淡出→移除→回传结果（click/Esc/Enter 三路共用；键盘路移除监听）
    const closeWith = (index: number): void => {
        document.removeEventListener('keydown', onKey, true);
        overlay.style.opacity = '0';
        card.style.transform = 'scale(.96)';
        setTimeout(() => {
            overlay.remove();
            const mdStyle = document.querySelector('style[data-fnos-md="1"]');
            if (mdStyle) mdStyle.remove();
        }, 180);
        ipcRenderer.send('fnos-dialog:result', payload.id, index, checked);
    };
    // [lc-1064] 键盘支持：Esc=取消(cancelId)、Enter=默认按钮（焦点已在按钮上时放行原生
    // click，避免双重触发）。document 捕获监听 —— 焦点可能在 body（未移入弹层）也要能关。
    const onKey = (e: KeyboardEvent): void => {
        if (!overlay.isConnected) { document.removeEventListener('keydown', onKey, true); return; }
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeWith(cancelId);
        } else if (e.key === 'Enter') {
            const ae = document.activeElement;
            if (ae && allBtns.includes(ae as HTMLButtonElement)) return; // 原生 click 已激活
            e.preventDefault();
            closeWith(defaultId);
        }
    };
    buttons.forEach((label, index) => {
        const isDefault = index === defaultId;
        const btn = document.createElement('button');
        if (isDefault) {
            // 主按钮：accent 渐变（随主题 accent 变量，深色 #93a5ff 自适应）
            btn.style.cssText = [
                'border:none',
                'background:linear-gradient(135deg,var(--fnos-ui-accent,#6d7ff2),#8a63e8)',
                'color:#fff',
                'font-size:13px', 'font-weight:600',
                'padding:9px 18px', 'border-radius:10px', 'cursor:pointer',
                'transition:transform .12s ease, box-shadow .12s ease',
                'box-shadow:0 6px 16px rgba(109,127,242,.4)',
            ].join(';') + ';';
        } else {
            // 次按钮：设置面板 mkBtn 同款无边框填充分层（lc-1043 审美：玻璃卡面靠明度不靠描边）
            btn.style.cssText = [
                'border:none',
                'background:var(--fnos-ui-btn-bg,rgba(90,120,200,.12))!important',
                'color:var(--fnos-ui-btn-text,#3d4a6e)',
                'font-size:13px', 'font-weight:600',
                'padding:9px 18px', 'border-radius:10px', 'cursor:pointer',
                'transition:transform .12s ease, box-shadow .12s ease, background .15s',
            ].join(';') + ';';
        }
        // [lc-1064] 去掉旧 inline outline:none —— 键盘焦点环由 a11y 全局规则接管
        btn.textContent = label;
        btn.addEventListener('mouseenter', () => {
            btn.style.transform = 'translateY(-1px)';
            if (!isDefault) btn.style.background = 'var(--fnos-ui-btn-hover,rgba(109,127,242,.30))!important';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.transform = 'translateY(0)';
            if (!isDefault) btn.style.background = 'var(--fnos-ui-btn-bg,rgba(90,120,200,.12))!important';
        });
        btn.addEventListener('click', () => closeWith(index));
        footer.appendChild(btn);
        allBtns.push(btn);
    });
    card.appendChild(footer);

    overlay.appendChild(card);
    // [lc-1064] 打开即聚焦默认按钮：键盘用户可直接 Enter 确认 / Tab 换选项
    document.addEventListener('keydown', onKey, true);
    // [lc-1074] 双 rAF + 强制 reflow —— 防「整窗闪白」。单 rAF 在绘制前执行，opacity:1 的
    //   样式变更会与节点插入合并到同一帧：遮罩层 + 卡片 blur(30px) 渲染表面在同一帧才分配，
    //   透明窗口(VizDisplayCompositor 被禁用的旧合成器)分配瞬间整窗闪白(用户报障)。先让
    //   opacity:0 的完整一帧画出来(表面/blur 纹理在不可见帧就绪)，下一帧才开始 180ms 淡入。
    requestAnimationFrame(() => {
        void overlay.offsetWidth; // 强制同步布局，钉住 opacity:0 帧
        requestAnimationFrame(() => {
            if (allBtns[defaultId]) allBtns[defaultId].focus();
            overlay.style.opacity = '1';
            card.style.transform = 'scale(1)';
        });
    });

    return overlay;
}
