#!/usr/bin/env node
// scripts/stamp-meta.cjs — 在 makensis 编译安装包时打点构建时间(被 installer.nsh
// 的 !system 于编译期调用): 刷新 build/setup-ui/app-meta.json 的 releaseDate,
// 使封面页「安装包发布」= 真正的安装包构建时刻, 而非 UI 编译时刻。
// 尽力而为: 任何失败都退出 0, 不阻塞出包。
'use strict';
const Fs = require('fs');
const Path = require('path');

try {
  const p = Path.resolve(__dirname, '..', 'build', 'setup-ui', 'app-meta.json');
  const meta = JSON.parse(Fs.readFileSync(p, 'utf8'));
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  meta.releaseDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  Fs.writeFileSync(p, JSON.stringify(meta));
  console.log('[stamp-meta] releaseDate =', meta.releaseDate);
} catch (e) {
  console.warn('[stamp-meta] skipped:', e.message);
}
process.exit(0);
