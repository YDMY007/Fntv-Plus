import { ipcRenderer } from 'electron';
import { t } from '../../../core/i18n';

// embyWall/modals/telemetry.ts — [v1.12.0] 匿名使用统计卡（设置面板「关于」页）。
//
// 桌面版（Fntv-Plus 的 modals/telemetry.ts）同款卡片的网页端移植：开关 / 上次上报结果 /
// 重置匿名 ID / 手动上报一次。全部动作由用户显式触发，没有任何自动上传路径 ——
// 自动心跳只在「今天确实有人打开过增强页面」且开关开着时发生一次。
//
// 与桌面版的差异（都是网页端架构决定的）：
//  - 上报由 NAS 后端（Go）发出，不走浏览器：所以面板状态必须读后端 /api/stats，
//    浏览器拿不到也无需拿到完整匿名 ID（后端只回前 8 位）。
//  - 触发点从「应用启动」改成「反代注入成功」：装了却没人用的 NAS 不算活跃。

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
 * [v1.12.0] 匿名使用统计卡（「关于」页）。
 * 只显示/控制：开关、上次上报结果、重置匿名 ID、手动上报一次。
 */
export function buildStatsCard(): HTMLElement {
  const card = document.createElement('div');
  card.style.cssText = 'width:100%;max-width:440px;text-align:left;margin-top:14px;padding:12px 14px;border-radius:12px;'
    + 'background:var(--fnos-ui-input-bg)!important;border:1px solid var(--fnos-ui-border3);';

  const wrap = document.createElement('div');

  const toggle = mkToggle(true, (v) => {
    ipcRenderer.invoke('stats:set-enabled', v).catch(() => {});
  });

  const title = document.createElement('div');
  title.style.cssText = 'font-size:12.5px;font-weight:700;color:var(--fnos-ui-pill-text);';
  title.textContent = t('📊 匿名使用统计');
  wrap.appendChild(title);
  wrap.appendChild(mkRow('参与匿名统计', toggle.el));
  wrap.appendChild(mkNote('开启后收集必须的应用版本 + 系统类型，用于日志反馈收集需要的系统信息，方便排查故障 Bug。'
    + '不涉及账号、IP、媒体库及文件路径等隐私数据，服务端亦不做 IP 存储，可随时在这里关闭。'));

  // [lc-1250] 精简：移除「立即上报一次」「重置匿名 ID」按钮（匿名 ID 已是机器级固定, 重置无意义）
  // [lc-1250-web] 状态行整行不显示（读取中/上报结果/计划提示等一律不展示），仅保留开关同步
  ipcRenderer.invoke('stats:get-info').then((s: any) => {
    if (!s) return;
    toggle.set(s.enabled !== false);
  }).catch(() => {});

  card.appendChild(wrap);
  return card;
}

/**
 * [lc-1197→web] Bug 反馈 + 日志上传卡（「诊断与日志」分类）。
 * 网页端适配：日志全部在 NAS 后端（fntvplus.log + client.log，提交时自动打包脱敏），
 * 无需桌面版的「选择日志文件上传 / 打开日志目录」——填描述点提交即完成一键反馈。
 */
export function buildFeedbackBody(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;';

  const tip = mkNote('遇到问题？在这里直接提交。提交会自动附带最近的前后端日志（账号、令牌、密钥、手机号、邮箱一律打码；保留 NAS 地址与域名便于排查网络问题）与设备环境信息（应用版本 / fnOS 版本 / 时间 / 当前页面）。');
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

  const status = document.createElement('div');
  status.style.cssText = 'font-size:11px;color:' + SUB + ';margin-top:8px;min-height:14px;';
  wrap.appendChild(status);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;';
  const submitBtn = mkBtn('提交反馈', true);
  btnRow.appendChild(submitBtn);
  wrap.appendChild(btnRow);

  submitBtn.addEventListener('click', () => {
    const msg = area.value.trim();
    if (!msg) { status.textContent = t('请先填写问题描述。'); area.focus(); return; }
    submitBtn.disabled = true;
    status.textContent = t('提交中…');
    ipcRenderer.invoke('feedback:submit', { message: msg, contact: contact.value.trim(), page: location.href })
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

  return wrap;
}
