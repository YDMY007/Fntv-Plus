// src/shim/node_path.js — Node path 浏览器垫片（纯 JS 实现 join/resolve/dirname/basename/extname）。
// 网页端只用于拼本地缓存路径（本地 fs 垫片恒不存在），结果不落盘，仅保证调用不抛错。

function normalize(p) {
  const parts = String(p).split(/[\\/]+/).filter(Boolean);
  const out = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else out.push('..');
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

export function join(...parts) {
  return normalize(parts.filter(Boolean).join('/'));
}

export function resolve(...parts) {
  return join(...parts);
}

export function dirname(p) {
  const n = normalize(p);
  const i = n.lastIndexOf('/');
  return i <= 0 ? '.' : n.slice(0, i);
}

export function basename(p, ext) {
  const n = normalize(p);
  let b = n.slice(n.lastIndexOf('/') + 1);
  if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length);
  return b;
}

export function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i);
}

export default { join, resolve, dirname, basename, extname };
