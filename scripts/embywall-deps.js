#!/usr/bin/env node
/**
 * embyWall 拆分辅助：分析「某段行号区间」对外部的依赖。
 *
 * 用法：
 *   node scripts/embywall-deps.js --file=src/preload/plugins/embyWall.ts --range=461-736
 *
 * 输出两部分：
 *   1. 内部依赖：区间内用到、但在区间外定义的标识符（= 新模块需要 import 的东西）
 *   2. 外部引用：区间内定义、但在区间外被引用的标识符（= 新模块需要 export 的东西）
 *
 * 这样抽一个模块之前就能精确知道 import/export 面，不用靠猜。
 */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const get = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};

const relFile = get('file', 'src/preload/plugins/embyWall.ts');
const range = get('range', '');
if (!range) {
  console.error('需要 --range=a-b');
  process.exit(1);
}

const root = path.resolve(__dirname, '..');
const file = path.join(root, relFile);
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
const [a, b] = range.split('-').map(Number);

const inside = lines.slice(a - 1, b);     // 1-based inclusive
const outside = [...lines.slice(0, a - 1), ...lines.slice(b)];

// ---- 收集区间内定义的顶层标识符（函数/const/let/class/type/interface） ----
const DECL_RE = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;
const defined = new Set();
for (const ln of inside) {
  const m = ln.match(DECL_RE);
  if (m) defined.add(m[1]);
}

// ---- 标识符扫描（排除注释与字符串里的噪声：简单起见只排除整行注释） ----
const isCommentLine = (s) => /^\s*(\/\/|\*|\/\*)/.test(s);
const ID_RE = /[A-Za-z_$][\w$]*/g;

function countRefs(src) {
  const map = new Map();
  src.forEach((ln) => {
    if (isCommentLine(ln)) return;
    let m;
    ID_RE.lastIndex = 0;
    while ((m = ID_RE.exec(ln))) {
      const id = m[0];
      map.set(id, (map.get(id) || 0) + 1);
    }
    // 共享状态容器 S.xxx：合并统计到 `S` 名下，免得几十个字段各算一项
    const sm = ln.match(/\bS\.([A-Za-z_$][\w$]*)/g);
    if (sm) map.set('S', (map.get('S') || 0) + sm.length);
  });
  return map;
}

const insideRefs = countRefs(inside);
const outsideRefs = countRefs(outside);

// ---- 1. 内部依赖：区间内用到、且不是区间内定义、且在区间外有定义迹象 ----
// 判定「区间外定义」：外部出现 `function x` / `const x` / `let x` / `S.x` 等形态
const outsideDefined = new Set();
for (const ln of outside) {
  let m;
  if ((m = ln.match(DECL_RE))) outsideDefined.add(m[1]);
  // import 进来的名字也是「外部定义」：import { log, dlog } from '...'
  const im = ln.match(/^import\s+(?:\{([^}]*)\}|(\w+)|\*\s+as\s+(\w+))\s+from/);
  if (im) {
    const names = (im[1] || im[3] || im[2] || '').split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean);
    names.forEach((n) => outsideDefined.add(n));
  }
  // state.ts 容器字段：S.xxx
  const sm = ln.match(/\bS\.([A-Za-z_$][\w$]*)\s*=/);
  if (sm) outsideDefined.add('S.' + sm[1]);
}

const KEYWORDS = new Set([
  'function', 'const', 'let', 'var', 'class', 'type', 'interface', 'enum', 'return', 'if', 'else',
  'for', 'while', 'switch', 'case', 'break', 'continue', 'new', 'try', 'catch', 'finally', 'throw',
  'typeof', 'instanceof', 'in', 'of', 'await', 'async', 'void', 'null', 'undefined', 'true', 'false',
  'this', 'import', 'export', 'from', 'as', 'default', 'extends', 'implements', 'public', 'private',
  'protected', 'static', 'readonly', 'declare', 'namespace', 'module', 'require', 'delete', 'do',
  'get', 'set', 'yield', 'super', 'with', 'debugger',
]);

const internalDeps = [];
for (const [id, n] of insideRefs) {
  if (defined.has(id)) continue;
  if (KEYWORDS.has(id)) continue;
  if (!outsideDefined.has(id)) continue;
  internalDeps.push({ id, n });
}
internalDeps.sort((x, y) => y.n - x.n);

// ---- 2. 外部引用：区间内定义、区间外被用到 ----
const externalUses = [];
for (const id of defined) {
  const n = outsideRefs.get(id) || 0;
  if (n > 0) externalUses.push({ id, n });
}
externalUses.sort((x, y) => y.n - x.n);

console.log(`# 区间 L${a}-L${b} (${inside.length} 行)  ${relFile}`);
console.log('');
console.log('## 区间内定义（需 export 的，括号=区间外引用次数）');
for (const { id, n } of externalUses) console.log(`  export ${id}   (外部引用 ${n} 次)`);
const unusedOutside = [...defined].filter((d) => !externalUses.some((e) => e.id === d));
if (unusedOutside.length) {
  console.log('  -- 仅区间内使用（可保持私有）--');
  console.log('  ' + unusedOutside.join(', '));
}
console.log('');
console.log('## 需要 import 的外部依赖（括号=区间内引用次数）');
for (const { id, n } of internalDeps) console.log(`  ${id}   (${n})`);
