import { ipcRenderer } from 'electron';

// embyWall/modals/feedback.ts — 反馈弹窗组：问卷反馈 / 反馈方式选择 / QQ 交流群（三层可返回的模态框）
// 由 scripts/embywall-split.js 从 embyWall.ts 整段抽取；改实现请改这里，不要在入口文件里补。

/* ========== [恢复v381] 反馈弹窗 ========== */
// [v1.8.0] Web 版(fpk)仓库——关于页/反馈弹窗的 GitHub 入口（桌面版仓库在关于页描述中另附）
export const ABOUT_LINK_URL = 'https://github.com/YDMY007/Fntv-Plus-fpk';

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
export const openFeedbackChoiceModal = (): void => {
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

    // [lc-1250] 选项首：一键上传日志反馈（描述 + 自动附前后端日志与环境信息 → NAS 后端转发统计服务端）
    const optUpload = document.createElement('button');
    optUpload.type = 'button';
    optUpload.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:3px;width:100%;box-sizing:border-box;'
      + 'padding:14px 16px;margin-bottom:12px;border-radius:14px;cursor:pointer;text-align:center;'
      + 'background:var(--fnos-ui-input-bg)!important;border:1px solid var(--fnos-ui-border3);color:var(--fnos-ui-text);'
      + 'transition:background .15s,border-color .15s;';
    optUpload.innerHTML = '<div style="font-size:14px;font-weight:700;">📮 一键上传日志反馈</div>'
      + '<div style="font-size:11.5px;opacity:.7;">写一句问题描述即可，自动附带前后端日志（已脱敏）与环境信息</div>';
    optUpload.addEventListener('click', () => {
      if (modal) modal.style.display = 'none';
      openFeedbackUploadModal();
    });
    card.insertBefore(optUpload, optSurvey);

    // [lc-1250] 复制设备环境信息 —— 问卷/QQ 反馈时粘贴，便于远程排查
    const optEnv = document.createElement('button');
    optEnv.type = 'button';
    optEnv.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:3px;width:100%;box-sizing:border-box;'
      + 'padding:12px 16px;margin-bottom:12px;border-radius:14px;cursor:pointer;text-align:center;'
      + 'background:var(--fnos-ui-input-bg)!important;border:1px solid var(--fnos-ui-border3);color:var(--fnos-ui-text);'
      + 'transition:background .15s,border-color .15s;';
    optEnv.innerHTML = '<div style="font-size:14px;font-weight:700;">📋 复制设备环境信息</div>'
      + '<div style="font-size:11.5px;opacity:.7;">应用版本 / 页面 / 时间 / 浏览器，粘贴到问卷或群里便于排查</div>';
    optEnv.addEventListener('click', async () => {
      let ver = '';
      try {
        const info: any = await ipcRenderer.invoke('stats:get-info');
        if (info && info.version) ver = String(info.version);
      } catch { /* ignore */ }
      const lines = [
        '===== Fntv-Plus Web 版设备环境 =====',
        '应用版本: ' + (ver || '未知'),
        '页面: ' + location.href,
        '时间: ' + new Date().toString(),
        '屏幕: ' + window.screen.width + 'x' + window.screen.height + ' @' + (window.devicePixelRatio || 1) + 'x',
        '浏览器: ' + navigator.userAgent,
      ];
      const text = lines.join('\n');
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch { /* 非 https 降级 execCommand */ }
      if (!ok) {
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
          document.body.appendChild(ta);
          ta.select();
          ok = document.execCommand('copy');
          document.body.removeChild(ta);
        } catch { ok = false; }
      }
      optEnv.innerHTML = ok
        ? '<div style="font-size:14px;font-weight:700;">✓ 已复制到剪贴板</div><div style="font-size:11.5px;opacity:.7;">粘贴到问卷或 QQ 群即可</div>'
        : '<div style="font-size:14px;font-weight:700;">⚠ 复制失败</div><div style="font-size:11.5px;opacity:.7;">请手动截图本页版本信息</div>';
      window.setTimeout(() => {
        optEnv.innerHTML = '<div style="font-size:14px;font-weight:700;">📋 复制设备环境信息</div>'
          + '<div style="font-size:11.5px;opacity:.7;">应用版本 / 页面 / 时间 / 浏览器，粘贴到问卷或群里便于排查</div>';
      }, 4000);
    });
    card.insertBefore(optEnv, optSurvey);

    // 悬停高亮
    [optUpload, optSurvey, optQQ, optEnv].forEach((b) => {
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


/* ========== [lc-1250] 一键上传日志反馈表单（NAS 后端转发统计服务端） ========== */
const openFeedbackUploadModal = (): void => {
  let modal = document.getElementById('fnos-feedback-upload-modal') as HTMLElement | null;
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'fnos-feedback-upload-modal';
    modal.setAttribute('data-fnos-ui', '1');
    modal.style.cssText = 'position:fixed;z-index:2147483702;inset:0;display:none;align-items:center;justify-content:center;'
      + 'background:rgba(0,0,0,.5);';
    modal.addEventListener('click', (e: Event) => { if (e.target === modal) modal!.style.display = 'none'; });

    const card = document.createElement('div');
    card.style.cssText = 'width:420px;max-width:92vw;border-radius:18px;padding:22px;color:var(--fnos-ui-text);'
      + 'background:var(--fnos-ui-panel-bg)!important;border:1px solid var(--fnos-ui-border-outer);'
      + 'box-shadow:0 18px 50px rgba(80,60,120,.28),0 4px 16px rgba(80,60,120,.14);'
      + 'backdrop-filter:blur(30px) saturate(150%);-webkit-backdrop-filter:blur(30px) saturate(150%);';

    card.innerHTML = ''
      + '<div style="font-size:19px;font-weight:800;color:var(--fnos-ui-pill-text);margin-bottom:4px;">📮 一键上传日志反馈</div>'
      + '<div style="font-size:11.5px;line-height:1.6;color:var(--fnos-ui-text);opacity:.75;margin-bottom:12px;">'
      + '提交后会自动附带：设备环境（应用版本 / fnOS 版本 / 时间 / 页面）+ 前后端日志（最近片段，凭据类信息已打码；保留 NAS 地址便于排查网络问题）。仅在你点击「上传」时才发送。</div>';

    const area = document.createElement('textarea');
    area.placeholder = '描述你遇到的问题 / 复现步骤（必填）…';
    area.style.cssText = 'width:100%;box-sizing:border-box;min-height:88px;padding:10px 12px;border-radius:10px;'
      + 'font-size:12.5px;line-height:1.6;font-family:inherit;resize:vertical;'
      + 'background:var(--fnos-ui-input-bg)!important;color:var(--fnos-ui-text);'
      + 'border:1px solid var(--fnos-ui-border3);outline:none;';
    card.appendChild(area);

    const contact = document.createElement('input');
    contact.type = 'text';
    contact.placeholder = '联系方式（选填，方便回复你：QQ / 邮箱）';
    contact.style.cssText = 'width:100%;box-sizing:border-box;margin-top:8px;padding:9px 12px;border-radius:10px;'
      + 'font-size:12.5px;font-family:inherit;background:var(--fnos-ui-input-bg)!important;'
      + 'color:var(--fnos-ui-text);border:1px solid var(--fnos-ui-border3);outline:none;';
    card.appendChild(contact);

    const status = document.createElement('div');
    status.style.cssText = 'font-size:11.5px;color:var(--fnos-ui-text);opacity:.75;margin-top:8px;min-height:16px;';
    card.appendChild(status);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:10px;';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = '取消';
    cancelBtn.style.cssText = 'padding:8px 18px;border-radius:10px;cursor:pointer;font-size:12.5px;'
      + 'background:var(--fnos-ui-input-bg)!important;border:1px solid var(--fnos-ui-border3);color:var(--fnos-ui-text);';
    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.textContent = '上传';
    submitBtn.style.cssText = 'padding:8px 22px;border-radius:10px;cursor:pointer;font-size:12.5px;font-weight:700;'
      + 'background:var(--fnos-ui-accent)!important;border:none;color:#fff;';
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(submitBtn);
    card.appendChild(btnRow);

    cancelBtn.addEventListener('click', () => { if (modal) modal.style.display = 'none'; });

    submitBtn.addEventListener('click', () => {
      const msg = area.value.trim();
      if (!msg) { status.textContent = '请先填写问题描述。'; area.focus(); return; }
      submitBtn.disabled = true;
      status.textContent = '上传中…（正在打包前后端日志与环境信息）';
      ipcRenderer.invoke('feedback:submit', { message: msg, contact: contact.value.trim(), page: location.href })
        .then((r: any) => {
          if (r && r.ok) {
            status.textContent = '✓ 上传成功，感谢反馈！（环境与日志已附带）';
            area.value = '';
            window.setTimeout(() => { if (modal) modal.style.display = 'none'; }, 1600);
          } else {
            status.textContent = '上传失败：' + ((r && r.error) || '未知错误');
          }
        })
        .catch((e: any) => { status.textContent = '上传失败：' + String((e && e.message) || e); })
        .finally(() => { submitBtn.disabled = false; });
    });

    modal.appendChild(card);
    document.body.appendChild(modal);
  }
  modal.style.display = 'flex';
};
