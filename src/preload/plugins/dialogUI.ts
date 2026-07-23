import { ipcRenderer } from 'electron';

// 粉紫亚克力自定义对话框，替代 Electron 原生 dialog.showMessageBox
// 主进程通过 webContents.send('fnos-dialog:open', payload) 唤起，
// 渲染进程点击按钮后 ipcRenderer.send('fnos-dialog:result', id, index, checkboxChecked) 回传。

interface FnosDialogPayload {
    id: string;
    title: string;
    message?: string;
    detail?: string;
    type?: 'none' | 'info' | 'question' | 'error';
    buttons?: string[];
    defaultId?: number;
    cancelId?: number;
    checkboxLabel?: string;
    checkboxChecked?: boolean;
}

const ICON: Record<string, { chr: string; color: string }> = {
    info: { chr: 'ℹ', color: '#5b8def' },
    question: { chr: '?', color: '#8b6fd1' },
    error: { chr: '⚠', color: '#e06a5b' },
    none: { chr: '', color: '#8b6fd1' },
};

ipcRenderer.on('fnos-dialog:open', (_event: any, payload: FnosDialogPayload) => {
    if (typeof document === 'undefined' || !document.body) return;
    document.body.appendChild(buildDialog(payload));
});

function buildDialog(payload: FnosDialogPayload): HTMLElement {
    const type = payload.type || 'none';
    const icon = ICON[type] || ICON.none;

    const overlay = document.createElement('div');
    overlay.setAttribute('data-fnos-ui', '1');
    overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:2147483647',
        'display:flex', 'align-items:center', 'justify-content:center',
        'background:rgba(28,20,40,.38)',
        'backdrop-filter:blur(4px)', '-webkit-backdrop-filter:blur(4px)',
        'opacity:0', 'transition:opacity .18s ease',
        'font-family:"Segoe UI Variable","Segoe UI",system-ui,-apple-system,sans-serif',
    ].join(';') + ';';

    const card = document.createElement('div');
    card.setAttribute('data-fnos-ui', '1');
    card.style.cssText = [
        'position:relative', 'min-width:360px', 'max-width:460px', 'width:88%',
        'background:rgba(252,247,253,.97)!important',
        'backdrop-filter:blur(30px) saturate(135%)', '-webkit-backdrop-filter:blur(30px) saturate(135%)',
        'border-radius:16px',
        'box-shadow:0 18px 50px rgba(80,60,110,.28), inset 0 1px 0 rgba(255,255,255,.7)',
        'padding:24px 24px 18px', 'color:#3a2d4d',
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
    title.style.cssText = 'font-size:17px;font-weight:700;color:#2e2340;line-height:1.3;';
    title.textContent = payload.title || '';
    header.appendChild(title);
    card.appendChild(header);

    // 主体
    if (payload.message) {
        const msg = document.createElement('div');
        msg.style.cssText = 'font-size:14px;color:#4a3d5e;line-height:1.55;margin-bottom:6px;white-space:pre-line;';
        msg.textContent = payload.message;
        card.appendChild(msg);
    }
    if (payload.detail) {
        const detail = document.createElement('div');
        detail.style.cssText = [
            'font-size:12.5px', 'color:#7a6e8e', 'line-height:1.6',
            'max-height:180px', 'overflow-y:auto', 'white-space:pre-line',
            'background:rgba(255,255,255,.5)!important',
            'border-radius:10px', 'padding:10px 12px', 'margin-bottom:6px',
        ].join(';') + ';';
        detail.textContent = payload.detail;
        card.appendChild(detail);
    }

    // 可选 checkbox
    let checked = !!payload.checkboxChecked;
    if (payload.checkboxLabel) {
        const wrap = document.createElement('label');
        wrap.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12.5px;color:#6a5e7e;margin-top:8px;cursor:pointer;user-select:none;';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = checked;
        cb.style.cssText = 'width:15px;height:15px;accent-color:#8b6fd1;';
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
    buttons.forEach((label, index) => {
        const isDefault = index === defaultId;
        const btn = document.createElement('button');
        btn.style.cssText = [
            'border:' + (isDefault ? 'none' : '1px solid rgba(139,111,209,.45)'),
            'background:' + (isDefault ? 'linear-gradient(135deg,#9b7fe0,#7d5fc9)' : 'rgba(255,255,255,.6)'),
            'color:' + (isDefault ? '#fff' : '#5a4a7a'),
            'font-size:13px', 'font-weight:600',
            'padding:9px 18px', 'border-radius:10px', 'cursor:pointer', 'outline:none',
            'transition:transform .12s ease, box-shadow .12s ease',
            'box-shadow:' + (isDefault ? '0 6px 16px rgba(125,95,201,.4)' : 'none'),
        ].join(';') + ';';
        btn.textContent = label;
        btn.addEventListener('mouseenter', () => { btn.style.transform = 'translateY(-1px)'; });
        btn.addEventListener('mouseleave', () => { btn.style.transform = 'translateY(0)'; });
        btn.addEventListener('click', () => {
            overlay.style.opacity = '0';
            card.style.transform = 'scale(.96)';
            setTimeout(() => overlay.remove(), 180);
            ipcRenderer.send('fnos-dialog:result', payload.id, index, checked);
        });
        footer.appendChild(btn);
    });
    card.appendChild(footer);

    overlay.appendChild(card);
    requestAnimationFrame(() => {
        overlay.style.opacity = '1';
        card.style.transform = 'scale(1)';
    });

    return overlay;
}
