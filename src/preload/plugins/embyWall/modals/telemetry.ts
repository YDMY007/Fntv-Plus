import { ipcRenderer } from 'electron';
import { t } from '../../../core/i18n';

// embyWall/modals/telemetry.ts — [lc-1196] 匿名使用统计卡 + [lc-1197] Bug 反馈/日志上传卡
// 两张卡都挂在设置面板里（统计卡→「关于」页；反馈卡→「诊断与日志」分类），
// 均由用户显式操作，没有任何自动上传路径。

const SUB = 'var(--fnos-ui-sub,#888)';
const MUTED = 'var(--fnos-ui-muted,#999)';

/** 小开关（与「外观」页同款：隐藏 input + 轨道 + 滑块） */
function mkToggle(on: boolean, onChange: (v: boolean) => void): { el: HTMLElement; set: (v: boolean) => void } {
  const label = document.createElement('label');
  label.style.cssText = 'position:relative;display:inline-block;width:42px;height:23px;cursor:pointer;flex:none;';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = on;
  input.style.cssText = 'position:absolute;opacity:0;width:0;height:0;';
  const track = document.createElement('span');
  track.style.cssText = 'position:absolute;inset:0;border-radius:23px;background:rgba(140,140,160,.45);transition:.2s;';
  const knob = document.createElement('span');
  knob.style.cssText = 'position:absolute;top:2.5px;left:2.5px;width:18px;height:18px;border-radius:50%;'
    + 'background:#fff;transition:.2s;box-shadow:0 1px 3px rgba(0,0,0,.3);';
  label.appendChild(input);
  label.appendChild(track);
  label.appendChild(knob);
  const paint = (): void => {
    track.style.background = input.checked ? 'var(--fnos-ui-accent)' : 'rgba(140,140,160,.45)';
    knob.style.left = input.checked ? '21.5px' : '2.5px';
  };
  paint();
  input.addEventListener('change', () => { paint(); onChange(input.checked); });
  return { el: label, set: (v: boolean) => { input.checked = v; paint(); } };
}

function mkRow(title: string, right?: HTMLElement): HTMLElement {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:10px;';
  const span = document.createElement('span');
  span.style.cssText = 'font-weight:600;letter-spacing:.5px;';
  span.textContent = t(title);
  row.appendChild(span);
  if (right) row.appendChild(right);
  return row;
}

function mkNote(text: string): HTMLElement {
  const d = document.createElement('div');
  d.style.cssText = 'font-size:11px;color:' + MUTED + ';line-height:1.6;margin-top:6px;';
  d.textContent = t(text);
  return d;
}

function mkBtn(text: string, primary: boolean): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = t(text);
  b.style.cssText = 'padding:7px 12px;border-radius:9px;cursor:pointer;font-size:11.5px;font-weight:600;border:none;'
    + (primary ? 'background:var(--fnos-ui-btn-bg2)!important;' : 'background:var(--fnos-ui-btn-bg)!important;')
    + 'color:var(--fnos-ui-btn-text);transition:background .15s;';
  b.onmouseenter = () => { b.style.background = (primary ? 'var(--fnos-ui-btn-hover2)' : 'var(--fnos-ui-btn-hover)') + '!important'; };
  b.onmouseleave = () => { b.style.background = (primary ? 'var(--fnos-ui-btn-bg2)' : 'var(--fnos-ui-btn-bg)') + '!important'; };
  return b;
}

/**
 * [lc-1196] 匿名使用统计卡（「关于」页）
 * 只显示/控制：开关、上次上报结果、重置匿名 ID、手动上报一次。
 */
export function buildStatsCard(): HTMLElement {
  const card = document.createElement('div');
  card.style.cssText = 'width:100%;max-width:440px;text-align:left;margin-top:14px;padding:12px 14px;border-radius:12px;'
    + 'background:var(--fnos-ui-input-bg)!important;border:1px solid var(--fnos-ui-border3);';

  const wrap = document.createElement('div');
  const status = document.createElement('div');
  status.style.cssText = 'font-size:11px;color:' + SUB + ';margin-top:8px;min-height:14px;';
  status.textContent = t('读取中…');

  const toggle = mkToggle(true, (v) => {
    ipcRenderer.invoke('stats:set-enabled', v).catch(() => {});
    status.textContent = v ? t('已开启，明天起每天上报一次。') : t('已关闭，不会再发送任何数据。');
  });

  const title = document.createElement('div');
  title.style.cssText = 'font-size:12.5px;font-weight:700;color:var(--fnos-ui-pill-text);';
  title.textContent = t('📊 匿名使用统计');
  wrap.appendChild(title);
  wrap.appendChild(mkRow('参与匿名统计', toggle.el));
  wrap.appendChild(mkNote('每天最多上报一次，内容只有：随机匿名 ID + 版本号 + 系统类型。'
    + '不采集账号、IP、媒体库与文件路径，服务端也不存 IP。'));
  wrap.appendChild(status);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;';
  const pingBtn = mkBtn('立即上报一次', true);
  const resetBtn = mkBtn('重置匿名 ID', false);
  btnRow.appendChild(pingBtn);
  btnRow.appendChild(resetBtn);
  wrap.appendChild(btnRow);

  pingBtn.addEventListener('click', () => {
    pingBtn.disabled = true;
    status.textContent = t('上报中…');
    ipcRenderer.invoke('stats:ping-now').then((r: any) => {
      if (r && r.ok) status.textContent = t('上报成功 ✅');
      else status.textContent = t('未上报：') + ((r && (r.skipped || r.error)) || t('未知原因'));
    }).catch((e: any) => {
      status.textContent = t('上报失败：') + String((e && e.message) || e);
    }).finally(() => { pingBtn.disabled = false; });
  });

  resetBtn.addEventListener('click', () => {
    ipcRenderer.invoke('stats:reset-id').then(() => {
      status.textContent = t('已生成新的匿名 ID，与历史数据不再关联。');
    }).catch(() => {});
  });

  // 初值回填
  ipcRenderer.invoke('stats:get-info').then((s: any) => {
    if (!s) return;
    toggle.set(s.enabled !== false);
    if (!s.configured) {
      status.textContent = t('服务端未配置，当前不会发送任何数据。');
      pingBtn.disabled = true;
      return;
    }
    if (s.devMode) status.textContent = t('开发模式默认不上报（可用「立即上报一次」测试）。');
    else if (s.lastDay) status.textContent = t('上次上报：') + s.lastDay + (s.lastOk ? t('（成功）') : t('（失败，稍后自动重试）'));
    else status.textContent = t('尚未上报过。');
  }).catch(() => { status.textContent = ''; });

  card.appendChild(wrap);
  return card;
}

/**
 * [lc-1197] Bug 反馈 + 日志上传卡（「诊断与日志」分类）
 * 全部由用户手动触发：写描述 → 点提交；或点「选择日志文件上传」直接上传某个 .log。
 */
export function buildFeedbackBody(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;';

  const tip = mkNote('遇到问题？在这里直接提交。日志在上传前会脱敏（账号、令牌、密钥、手机号、邮箱一律打码），'
    + '但会保留 NAS 地址与域名以便排查网络问题。');
  wrap.appendChild(tip);

  const area = document.createElement('textarea');
  area.placeholder = t('描述你遇到的问题 / 复现步骤（必填）…');
  area.style.cssText = 'width:100%;box-sizing:border-box;min-height:88px;margin-top:8px;padding:10px 12px;'
    + 'border-radius:10px;font-size:12.5px;line-height:1.6;font-family:inherit;resize:vertical;'
    + 'background:var(--fnos-ui-input-bg)!important;color:var(--fnos-ui-text);'
    + 'border:1px solid var(--fnos-ui-border3);outline:none;';
  wrap.appendChild(area);

  const contact = document.createElement('input');
  contact.type = 'text';
  contact.placeholder = t('联系方式（选填，方便回复你：QQ / 邮箱）');
  contact.style.cssText = 'width:100%;box-sizing:border-box;margin-top:8px;padding:9px 12px;border-radius:10px;'
    + 'font-size:12.5px;font-family:inherit;background:var(--fnos-ui-input-bg)!important;'
    + 'color:var(--fnos-ui-text);border:1px solid var(--fnos-ui-border3);outline:none;';
  wrap.appendChild(contact);

  let includeLog = true;
  const logToggle = mkToggle(true, (v) => { includeLog = v; });
  wrap.appendChild(mkRow('附上最近应用日志（已脱敏）', logToggle.el));

  const logInfo = document.createElement('div');
  logInfo.style.cssText = 'font-size:11px;color:' + SUB + ';margin-top:4px;';
  wrap.appendChild(logInfo);

  const status = document.createElement('div');
  status.style.cssText = 'font-size:11px;color:' + SUB + ';margin-top:8px;min-height:14px;';
  wrap.appendChild(status);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;';
  const submitBtn = mkBtn('提交反馈', true);
  const uploadBtn = mkBtn('选择日志文件上传', false);
  const openLogBtn = mkBtn('打开日志目录', false);
  btnRow.appendChild(submitBtn);
  btnRow.appendChild(uploadBtn);
  btnRow.appendChild(openLogBtn);
  wrap.appendChild(btnRow);

  const setBusy = (busy: boolean, btn: HTMLButtonElement, label: string): void => {
    btn.disabled = busy;
    if (busy) status.textContent = label;
  };

  submitBtn.addEventListener('click', () => {
    const msg = area.value.trim();
    if (!msg) { status.textContent = t('请先填写问题描述。'); area.focus(); return; }
    setBusy(true, submitBtn, t('提交中…'));
    ipcRenderer.invoke('feedback:submit', { message: msg, contact: contact.value.trim(), includeLog })
      .then((r: any) => {
        if (r && r.ok) {
          status.textContent = t('提交成功，感谢反馈！编号：') + (r.id ? String(r.id).slice(0, 8) : '—');
          area.value = '';
        } else {
          status.textContent = t('提交失败：') + ((r && r.error) || t('未知错误'));
        }
      })
      .catch((e: any) => { status.textContent = t('提交失败：') + String((e && e.message) || e); })
      .finally(() => { submitBtn.disabled = false; });
  });

  uploadBtn.addEventListener('click', () => {
    setBusy(true, uploadBtn, t('选择文件…'));
    ipcRenderer.invoke('feedback:upload-log')
      .then((r: any) => {
        if (r && r.canceled) status.textContent = '';
        else if (r && r.ok) status.textContent = t('日志上传成功，编号：') + (r.id ? String(r.id).slice(0, 8) : '—');
        else status.textContent = t('上传失败：') + ((r && r.error) || t('未知错误'));
      })
      .catch((e: any) => { status.textContent = t('上传失败：') + String((e && e.message) || e); })
      .finally(() => { uploadBtn.disabled = false; });
  });

  openLogBtn.addEventListener('click', () => {
    ipcRenderer.invoke('settings:open-log').then((r: any) => {
      if (r && !r.ok) status.textContent = t('打开日志失败：') + ((r && r.error) || '');
    }).catch(() => {});
  });

  // 日志体积提示 + 未配置服务端时禁用上传
  ipcRenderer.invoke('feedback:log-info').then((info: any) => {
    if (!info) return;
    const kb = Math.max(0, Math.round((info.size || 0) / 1024));
    logInfo.textContent = info.configured
      ? t('当前日志：') + (kb > 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB') + t('（最多上传最近 512KB）')
      : t('服务端未配置，反馈与日志上传暂不可用。');
    if (!info.configured) {
      submitBtn.disabled = true;
      uploadBtn.disabled = true;
    }
  }).catch(() => {});

  return wrap;
}
