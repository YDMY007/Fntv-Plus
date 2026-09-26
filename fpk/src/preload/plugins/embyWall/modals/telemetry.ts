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
    + '不采集账号、IP、媒体库与文件路径，服务端也不存 IP。仅在有人打开增强页面时计数。'));
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
    ipcRenderer.invoke('stats:reset-id').then((r: any) => {
      const short = (r && r.anonIdShort) ? String(r.anonIdShort) : '';
      status.textContent = short
        ? t('已生成新的匿名 ID：') + short + t('…（与历史数据不再关联）')
        : t('已生成新的匿名 ID，与历史数据不再关联。');
    }).catch(() => {});
  });

  // 初值回填（状态全在后端：网页端没有主进程配置可读）
  ipcRenderer.invoke('stats:get-info').then((s: any) => {
    if (!s) return;
    toggle.set(s.enabled !== false);
    if (!s.configured) {
      status.textContent = t('服务端未配置，当前不会发送任何数据。');
      pingBtn.disabled = true;
      return;
    }
    if (s.devMode) {
      status.textContent = t('开发版默认不上报（可用「立即上报一次」测试）。');
    } else if (s.lastDay) {
      status.textContent = t('上次上报：') + s.lastDay + (s.lastOk ? t('（成功）') : t('（失败，稍后自动重试）'));
    } else if (s.usedToday) {
      status.textContent = t('今天已记录使用，将在数小时内上报。');
    } else {
      status.textContent = t('尚未上报过（打开一次增强页面后开始计数）。');
    }
  }).catch(() => { status.textContent = ''; });

  card.appendChild(wrap);
  return card;
}
