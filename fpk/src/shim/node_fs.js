// src/shim/node_fs.js — Node fs 浏览器垫片：网页端无本地文件系统，全部安全降级。
// 调用方（customLogo/titlebar/animeLib 的本地缓存读取）均有 existsSync/try-catch 包裹，
// 返回 false/null 即走"无缓存/无文件"降级分支，不影响网络侧功能。

export function existsSync() {
  return false;
}

export function readFileSync() {
  return null;
}

export function writeFileSync() {
  /* no-op：网页端写不了本地文件 */
}

export default { existsSync, readFileSync, writeFileSync };
