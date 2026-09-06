// embyWall/log.ts
// ─────────────────────────────────────────────────────────────────────────────
// 职责：EmbyWall 全家桶的日志通道。所有模块都依赖它，它不依赖任何业务模块。
//
// 为什么单独成文件：
//   拆分前 log() 被 23 个功能区引用（全场最高扇出）。不抽出来，每个业务模块都得
//   反向依赖入口文件 → 环形依赖。抽成最底层叶子模块后，依赖图变成单向树。
//
// 依赖方向：log.ts ←（谁都能引）   log.ts 自身只依赖 electron + 本目录 state.ts
// ─────────────────────────────────────────────────────────────────────────────
import { ipcRenderer } from 'electron';
import { getLogEnabled, setLogEnabled } from './state';

const LOG_TAG = '[EmbyWall]';

/**
 * 主进程下发的调试过滤回调。
 * 调试总开关开启 且 EmbyWall 组件未被显式关闭(默认开启) → 本模块日志才输出。
 * 注意：这里只改 state，不持有日志通道本身，避免 state 与 log 循环依赖。
 */
function applyEmbyWallDebugFilter(payload: { enabled?: boolean; components?: Record<string, boolean> } | undefined): void {
  const enabled = !!payload?.enabled;
  const comps = payload?.components || {};
  setLogEnabled(enabled && comps['embywall'] !== false);
}

// 模块顶层注册：补丁应用弹窗、设置面板等任何模块都不需要再各自注册一次。
ipcRenderer.on('debug-filter', (_e: any, payload: any) => applyEmbyWallDebugFilter(payload));
// 页面加载时主动向主进程索取当前调试过滤（异步返回前默认安静）
try { ipcRenderer.send('debug-filter-request'); } catch (e) { /* 上下文不可用时忽略 */ }

/**
 * [lc-914] 日志实际发送: 双通道。
 *  ① IPC(log-message): 主进程按 embywall 组件过滤后写 app.log;
 *  ② console.log: 由主进程 console-message 捕获, 输出为 `[Renderer:INFO] ...`, **不受组件过滤**,
 *     必定出现在 CMD 日志窗口。
 * 原实现只用 require('electron').ipcRenderer.invoke —— require 在本上下文若不可用会抛异常被 catch 吞掉,
 * 叠加 renderer 端日志开关默认 false, 导致「代码在跑但 CMD 一条日志都没有」。
 * 现改用模块顶层已 import 的 ipcRenderer, 并补 console 通道兜底。
 */
function emitLog(msg: string): void {
  try { ipcRenderer.invoke('log-message', 'info', msg); } catch (e) { /* ignore */ }
  try { console.log(msg); } catch (e) { /* ignore */ }
}

/** 业务日志：受调试总开关控制。关闭时完全静默（IPC 与 console 都不发）。 */
export function log(...a: any[]): void {
  if (!getLogEnabled()) return; // 独立开关关闭 → 完全静默
  emitLog(LOG_TAG + ' ' + a.join(' '));
}

/**
 * [lc-914] 强制诊断日志: 完全绕过调试总开关, 专用于「详情页两栏布局」排查。
 * 由 localStorage `fntvSeasonLayoutDebug` 控制(默认开启), 调试结束后设为 '0' 即可静默。
 */
export function isSeasonLayoutDebugOn(): boolean {
  try { return localStorage.getItem('fntvSeasonLayoutDebug') !== '0'; } catch (e) { return true; }
}

/** 布局诊断日志：只看 fntvSeasonLayoutDebug，不看调试总开关。 */
export function dlog(...a: any[]): void {
  if (!isSeasonLayoutDebugOn()) return;
  emitLog(LOG_TAG + '[LAYOUT] ' + a.join(' '));
}

/**
 * [lc-1089] 轮播/库索引诊断日志开关（默认开启，localStorage `fntvCarouselDebug` 设 '0' 即静默）。
 * 为什么必须绕过调试总开关（实测钉死，不是推测）：
 *   ① release 包里 [EmbyWall] 渲染日志能进 app.log 的**唯一**通道是 main.ts 的 webContents
 *      'console-message' 捕获（无条件 log.info 落盘，报告者 v3.6.0 日志里 25 条 [LAYOUT] 就是这么进去的）；
 *   ② emitLog 的另一半 ipcRenderer.invoke('log-message') 对 [EmbyWall] 前缀消息**从不落盘**——
 *      handleLogMessage 把字符串 'info' 原样传给 logC(level)，emit() 里 `level >= this.logLevel`
 *      变成 'info' >= 1 → NaN 比较恒 false（dev 实测：console 格式 141 行 / IPC 格式 0 行）；
 *   ③ 而 log() 在总开关关闭时连 console.log 都不发 → 装到用户机器上的包，轮播一条诊断都看不到，
 *      「卡 99 / 白屏 / 无数据」这类只能靠用户复现的问题就永远缺证据。
 * 所以关键诊断行走本函数：不受总开关影响，量控制在每次启动十几行，需要静音时设 '0' 即可。
 */
export function isCarouselDebugOn(): boolean {
  try { return localStorage.getItem('fntvCarouselDebug') !== '0'; } catch (e) { return true; }
}

/** 轮播诊断日志：只看 fntvCarouselDebug，不看调试总开关。 */
export function clog(...a: any[]): void {
  if (!isCarouselDebugOn()) return;
  emitLog(LOG_TAG + '[CAROUSEL] ' + a.join(' '));
}
