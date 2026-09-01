/**
 * embyWall.ts 拆分前的耦合分析（一次性工具，分析完可删）
 *
 * 做什么：
 *   1. 抓出 embyWall.ts 里所有「模块级」声明（const/let/function/async function/class）
 *   2. 统计每个标识符在文件的哪些行被引用
 *   3. 按「计划切分的区块」求笛卡尔积：标识符被几个区块引用 = 跨区耦合度
 *
 * 为什么：拆分必须高内聚低耦合。被 >=2 个区块引用的状态就不能留在某个区块里，
 *         必须下沉到共享 state 模块；只被 1 个区块引用的状态应当跟着区块走（内聚）。
 *         靠肉眼猜 12.5k 行文件的耦合关系必错，所以先量化。
 *
 * 用法：node scripts/analyze-embywall-coupling.js
 */
const fs = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, '../src/preload/plugins/embyWall.ts');
const src = fs.readFileSync(FILE, 'utf8');
const lines = src.split(/\r?\n/);
const N = lines.length;

// ---------- 1. 收集「候选区块」（按原文件的分节注释 + 已知大函数边界） ----------
// 说明：这里只用于「粗粒度判断标识符跨越了几个功能区」，区块边界不必 100% 精确，
//       目的是找出 high-fanout 的标识符，精确边界在真正抽取时再定。
const regionMarkers = [];
lines.forEach((l, i) => {
  const t = l.trim();
  // 顶层分节注释：/* ==== xxx ==== */ 或 // ==== xxx ====
  if (/^(\/\*\s*=+|\/\/\s*=+)\s*.*=+\s*\*?\/?\s*$/.test(t) && t.length > 8) {
    regionMarkers.push({ line: i + 1, name: t.replace(/^[/*\s=]+|[=*\/\s]+$/g, '').slice(0, 40) });
  }
});
// 补几个已知大函数边界（handle / buildSettingsPanel 这类巨函数，内部自成一体）
regionMarkers.push({ line: 7514, name: 'handle()' });

// 由 marker 推出区块区间 [start, end)
const bounds = regionMarkers.map((m) => m.line).sort((a, b) => a - b);
const regionOf = (lineNo) => {
  let idx = -1;
  for (let i = 0; i < bounds.length; i++) if (lineNo >= bounds[i]) idx = i;
  return idx < 0 ? -1 : idx;
};
const regionName = (idx) => {
  if (idx < 0) return '<file-head>';
  const gl = bounds[idx];
  const m = regionMarkers.find((x) => x.line === gl);
  return `#${idx} L${gl} ${m ? m.name : ''}`;
};

// ---------- 2. 收集模块级声明 ----------
const declRe = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;
const declReFn = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/;
const decls = new Map(); // name -> { line, kind }
lines.forEach((l, i) => {
  const m = l.match(declRe);
  if (m) decls.set(m[1], { line: i + 1, kind: l.match(declReFn) ? 'fn' : 'val' });
});

// ---------- 3. 统计引用分布（跳过声明行本身、跳过注释行） ----------
const names = [...decls.keys()];
// 长名字优先，避免 _api 误吃 _apiShows
names.sort((a, b) => b.length - a.length);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const refs = new Map(names.map((n) => [n, new Map()])); // name -> regionIdx -> count

lines.forEach((l, i) => {
  const lineNo = i + 1;
  // 粗判注释/纯字符串行：整行以 // 或 * 或 /* 开头则跳过
  const t = l.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
  const reg = regionOf(lineNo);
  for (const n of names) {
    const d = decls.get(n);
    if (d.line === lineNo) continue; // 声明行自身不算「引用」
    const re = new RegExp('(?<![\\w$.])' + esc(n) + '(?![\\w$])', 'g');
    const hits = l.match(re);
    if (hits) {
      const m = refs.get(n);
      m.set(reg, (m.get(reg) || 0) + hits.length);
    }
  }
});

// ---------- 4. 输出：跨区标识符（f fanout >= 2）按引用总量降序 ----------
const rows = [];
for (const [n, m] of refs) {
  const total = [...m.values()].reduce((a, b) => a + b, 0);
  const fanout = m.size;
  if (fanout >= 2) {
    rows.push({
      name: n,
      kind: decls.get(n).kind,
      declLine: decls.get(n).line,
      fanout,
      total,
      regions: [...m.entries()].sort((a, b) => b[1] - a[1]).map(([r, c]) => `${regionName(r)}×${c}`),
    });
  }
}
rows.sort((a, b) => b.fanout - a.fanout || b.total - a.total);

console.log('=== 文件规模 ===');
console.log('lines:', N, '| regions:', bounds.length, '| top-level decls:', decls.size);
console.log('');
console.log('=== 跨区块标识符 (>=2 个区块引用) ===');
console.log('共', rows.length, '个 —— 这些必须下沉到共享 state/公共模块');
console.log('');
console.log('kind  fanout  refs  declLine  name');
for (const r of rows) {
  console.log(
    `${r.kind.padEnd(4)} ${String(r.fanout).padStart(3)}  ${String(r.total).padStart(5)}  L${String(r.declLine).padStart(5)}  ${r.name}`
  );
}
console.log('');
console.log('=== 明细：每个跨区标识符被哪些区块引用 ===');
for (const r of rows.slice(0, 60)) {
  console.log(`\n${r.name}  (${r.kind}, L${r.declLine}, fanout=${r.fanout}, refs=${r.total})`);
  for (const s of r.regions) console.log('    ' + s);
}

// ---------- 5. 顺便输出「只被 1 个区块引用」的规模，验证拆分收益 ----------
let local = 0;
for (const [, m] of refs) if (m.size === 1) local++;
console.log('\n=== 内聚度 ===');
console.log('仅单区块引用的标识符:', local, '/', refs.size, `(${(local / refs.size * 100).toFixed(1)}%)`);
