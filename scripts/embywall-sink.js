#!/usr/bin/env node
/**
 * 把一个「被跨模块读写的 let 变量」下沉到 state.ts 容器 S。
 *
 * 为什么需要这一步：TypeScript 禁止对 import 绑定赋值（TS2540），所以
 * `export let x` + `import { x }` 之后，**写** x 会编译失败，只有读可以。
 * 凡是被 ≥2 个模块读写的状态，必须走 S.xxx。
 *
 * 用法：
 *   node scripts/embywall-sink.js --names=_lastDetailHref,_detailGlassInited
 *
 * 做的事情：
 *   1. 在 embyWall/**\/*.ts 与 embyWall.ts 里整词替换 _xxx -> S.xxx
 *   2. 删掉原来的 `export let _xxx = ...` 声明行（已由 state.ts 承载）
 *   3. 在引用了 S 但还没 import 的文件里补上 `import { S } from '<相对路径>';`
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PLUGINS = path.join(ROOT, 'src/preload/plugins');

const argv = process.argv.slice(2);
const namesArg = argv.find((a) => a.startsWith('--names='));
if (!namesArg) { console.error('need --names=a,b'); process.exit(1); }
const NAMES = namesArg.slice('--names='.length).split(',').map((s) => s.trim()).filter(Boolean);

/** 递归收集 embyWall 目录下所有 .ts（含入口 embyWall.ts） */
function collectTs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectTs(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const files = [...collectTs(path.join(PLUGINS, 'embyWall')), path.join(PLUGINS, 'embyWall.ts')];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let total = 0;
for (const file of files) {
  const rel = path.relative(PLUGINS, file).replace(/\\/g, '/');
  if (rel === 'embyWall/state.ts') continue; // 容器本身不参与替换
  let src = fs.readFileSync(file, 'utf8');
  const eol = /\r\n/.test(src) ? '\r\n' : '\n';
  let changed = 0;

  for (const n of NAMES) {
    const field = n.replace(/^_+/, '');
    const re = new RegExp('(?<![A-Za-z0-9_$.])' + esc(n) + '(?![A-Za-z0-9_$])', 'g');
    const hits = src.match(re) || [];
    if (!hits.length) continue;
    src = src.replace(re, 'S.' + field);
    changed += hits.length;
  }

  if (!changed) continue;

  // 删掉被搬走的声明行：export let S.xxx = ... （替换产生的非法语法）
  const lines = src.split(eol);
  const kept = lines.filter((ln) => !/^\s*export\s+(let|var|const)\s+S\.[A-Za-z_$][\w$]*\s*=/.test(ln));
  const dropped = lines.length - kept.length;

  // 补 import { S }
  let out = kept.join(eol);
  if (!/^import\s*\{[^}]*\bS\b[^}]*\}\s*from/m.test(out)) {
    const outDir = path.dirname(rel);
    const relToState = path.relative(outDir, path.join('embyWall', 'state')).replace(/\\/g, '/');
    out = `import { S } from '${relToState.startsWith('.') ? relToState : './' + relToState}';${eol}${out}`;
  }

  fs.writeFileSync(file, out, 'utf8');
  total += changed;
  console.log(`${rel}: ${changed} 处替换${dropped ? `，删除 ${dropped} 行旧声明` : ''}`);
}
console.log(`\n共 ${total} 处替换。记得确认 state.ts 里已存在对应字段。`);
