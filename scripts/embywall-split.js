#!/usr/bin/env node
/**
 * embyWall 拆分工具（第二批）：批量区块抽取 + 自动加 export + 生成 manifest
 *
 * 和 embywall-refactor.js 的分工：
 *   refactor.js = 原子操作（重命名 / 删行 / 抽单块）
 *   split.js    = 编排：一次把多个区块搬走，自动判定 export 面，记录依赖供下一步生成 import
 *
 * 为什么分两步（先搬、后补 import）：
 *   抽取必须「从后往前」做，否则行号漂移。但模块的依赖目标（例如 theme.ts）可能在它后面才抽出来，
 *   抽的当口还不知道该 import 谁。所以先只搬 + 记账，全部搬完后再按 manifest 统一补 import 头。
 *
 * 用法：
 *   node scripts/embywall-split.js batch --plan=scripts/split-plan.json
 *   node scripts/embywall-split.js genheaders --map=scripts/split-map.json
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'src/preload/plugins/embyWall.ts');
const PLUGIN_DIR = path.join(ROOT, 'src/preload/plugins');
const MANIFEST = path.join(__dirname, '.embywall-manifest.json');

const argv = process.argv.slice(2);
const getArg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};

// ---------- 行尾保持：仓库是 CRLF，重写成 LF 会让 diff 变成全文改动，git blame 全废 ----------
let EOL = '\n';
function detectEol() {
  const head = fs.readFileSync(ENTRY, 'utf8').slice(0, 65536);
  const crlf = (head.match(/\r\n/g) || []).length;
  const lf = (head.match(/(?<!\r)\n/g) || []).length;
  if (crlf > lf) EOL = '\r\n';
}
const splitLines = (s) => s.split(/\r?\n/);

// ---------- 顶层声明识别 ----------
const DECL_RE = /^(export\s+)?(async\s+)?(function|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;
const isCommentLine = (s) => /^\s*(\/\/|\*|\/\*)/.test(s);
const ID_RE = /[A-Za-z_$][\w$]*/g;

const KEYWORDS = new Set([
  'function', 'const', 'let', 'var', 'class', 'type', 'interface', 'enum', 'return', 'if', 'else',
  'for', 'while', 'switch', 'case', 'break', 'continue', 'new', 'try', 'catch', 'finally', 'throw',
  'typeof', 'instanceof', 'in', 'of', 'await', 'async', 'void', 'null', 'undefined', 'true', 'false',
  'this', 'import', 'export', 'from', 'as', 'default', 'extends', 'implements', 'public', 'private',
  'protected', 'static', 'readonly', 'declare', 'namespace', 'module', 'require', 'delete', 'do',
  'get', 'set', 'yield', 'super', 'with', 'debugger',
]);

function collectDefined(src) {
  const out = new Map(); // name -> line index
  src.forEach((ln, i) => {
    const m = ln.match(DECL_RE);
    if (m) out.set(m[4], i);
    const im = ln.match(/^import\s+(?:\{([^}]*)\}|(\w+)|\*\s+as\s+(\w+))\s+from/);
    if (im) {
      (im[1] || im[3] || im[2] || '').split(',')
        .map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean)
        .forEach((n) => out.set(n, i));
    }
  });
  return out;
}

function countRefs(src) {
  const map = new Map();
  src.forEach((ln) => {
    if (isCommentLine(ln)) return;
    let m;
    ID_RE.lastIndex = 0;
    while ((m = ID_RE.exec(ln))) map.set(m[0], (map.get(m[0]) || 0) + 1);
    // 共享状态容器 S.xxx 合并统计到 S 名下
    const sm = ln.match(/\bS\.([A-Za-z_$][\w$]*)/g);
    if (sm) map.set('S', (map.get('S') || 0) + sm.length);
  });
  return map;
}

/** 判断某个声明是否「被外部写入」——若是，说明它是共享可变状态，应下沉到 state.ts 而非 export let */
function detectExternalWrites(declName, outsideLines) {
  const re = new RegExp('(?<![A-Za-z0-9_$.])' + declName.replace(/\$/g, '\\$') + '\\s*(=[^=]|[+*/%-]=|\\+\\+|--|\\.length\\s*=)', 'g');
  let n = 0;
  for (const ln of outsideLines) {
    if (isCommentLine(ln)) continue;
    n += (ln.match(re) || []).length;
  }
  return n;
}

// ---------- batch：批量抽取 ----------
function cmdBatch() {
  detectEol();
  const planPath = path.resolve(ROOT, getArg('plan', 'scripts/split-plan.json'));
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  // 从后往前：先搬行号大的，避免前面的行号漂移
  const jobs = plan.slice().sort((x, y) => y.range[0] - x.range[0]);

  let lines = splitLines(fs.readFileSync(ENTRY, 'utf8'));
  const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {};
  const warnings = [];
  // 已抽走的代码也要计入「区间外」：抽取是从后往前做的，先搬走的模块里对后面模块的引用
  // 如果只看入口剩余部分，会把 export 面算成 0（例如 season 的函数被 immersive 调用，
  // 但 immersive 已经先搬走了）。这里按行累计已搬走的内容。
  const extracted = [];

  for (const job of jobs) {
    const [a, b] = job.range;
    const body = lines.slice(a - 1, b);
    if (!body.length) { console.warn(`skip empty range ${a}-${b}`); continue; }

    const outside = [...lines.slice(0, a - 1), ...lines.slice(b), ...extracted];
    const defined = collectDefined(body);
    const outsideDefined = collectDefined(outside);
    const insideRefs = countRefs(body);
    const outsideRefs = countRefs(outside);
    outsideDefined.set('S', 0); // S 是 import 进来的容器，永远算外部

    // 1) 判定 export 面：区间内定义 且 区间外被引用
    const exports = [];
    for (const [name, idx] of defined) {
      if (KEYWORDS.has(name)) continue;
      const uses = outsideRefs.get(name) || 0;
      if (uses === 0) continue;
      const writes = detectExternalWrites(name, outside);
      const line = body[idx];
      if (writes > 0 && /^\s*(let|var)\s/.test(line)) {
        warnings.push(`⚠ ${job.out}: \`${name}\` 被区间外写入 ${writes} 次（let/var）→ 应下沉到 state.ts，不能用 export let（TS2540）`);
      }
      // 加 export（若已有则跳过）
      if (!/^export\s/.test(line)) body[idx] = line.replace(/^(async\s+)?(function|const|let|var|class|type|interface|enum)\s/, (m) => 'export ' + m);
      exports.push({ name, uses, writes });
    }

    // 2) 判定 import 面：区间内用到 且 在区间外定义
    const deps = [];
    for (const [id, n] of insideRefs) {
      if (defined.has(id)) continue;
      if (KEYWORDS.has(id)) continue;
      if (!outsideDefined.has(id)) continue;
      deps.push({ id, n });
    }
    deps.sort((x, y) => y.n - x.n);

    // 3) 落盘 + 原位留标记
    const outPath = path.join(PLUGIN_DIR, job.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const headerFile = job.header ? path.resolve(ROOT, job.header) : null;
    let header = headerFile && fs.existsSync(headerFile) ? fs.readFileSync(headerFile, 'utf8') : '';
    if (job.doc) {
      header = header
        + `// ${job.out} — ${job.doc}\n`
        + `// 由 scripts/embywall-split.js 从 embyWall.ts 整段抽取；改实现请改这里，不要在入口文件里补。\n\n`;
    }
    fs.writeFileSync(outPath, header + body.join(EOL), 'utf8');

    const titleRaw = (body.find((l) => /^\s*(\/\*\s*=|\/\/\s*=)/.test(l)) || '').trim();
    const title = titleRaw.replace(/^[/*\s=]+|[=*\/\s]+$/g, '').slice(0, 50);
    const marker = `// ===== 已迁移到 ./${job.out}${title ? '（' + title + '）' : ''} =====`;
    lines.splice(a - 1, b - a + 1, marker);

    extracted.push(...body);
    manifest[job.out] = { exports, deps, srcRange: [a, b], title, doc: job.doc || '' };
    console.log(`✓ L${a}-L${b} (${b - a + 1} 行) -> ${job.out}`);
    console.log(`    export(${exports.length}): ${exports.map((e) => e.name).join(', ') || '(无)'}`);
    console.log(`    import(${deps.length}): ${deps.map((d) => d.id).join(', ') || '(无)'}`);
  }

  fs.writeFileSync(ENTRY, lines.join(EOL), 'utf8');
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`\nembyWall.ts 剩余 ${lines.length} 行`);
  if (warnings.length) { console.log('\n' + warnings.join('\n')); }
}

// ---------- move：把任意模块文件里的一段搬到另一个文件（用于打断循环依赖） ----------
// 典型场景：render.ts 与 styles.ts 互相 import（render 要用样式，样式要用 render 里的
// resolveSeasonHref）→ 把 resolveSeasonHref 挪到更底层的 href.ts，环就断了。
function cmdMove() {
  const relSrc = getArg('from');
  const relDst = getArg('to');
  const [a, b] = getArg('range').split('-').map(Number);
  const doc = getArg('doc', '');
  const srcFile = path.join(PLUGIN_DIR, relSrc);
  const raw = fs.readFileSync(srcFile, 'utf8');
  const eol = /\r\n/.test(raw) ? '\r\n' : '\n';
  const lines = raw.split(eol);

  const body = lines.slice(a - 1, b);
  const outPath = path.join(PLUGIN_DIR, relDst);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const head = `// ${relDst}${doc ? ' — ' + doc : ''}\n`
    + `// 由 scripts/embywall-split.js 从 ${relSrc} 抽出，用于打断循环依赖。\n\n`;
  fs.writeFileSync(outPath, head + body.join(eol), 'utf8');

  // 在原位置留标记 + 加一行 re-export 说明（真正的 import 由调用方/tsc 驱动补齐）
  const firstFn = (body.find((l) => /export (async )?function/.test(l)) || '').match(/function\s+([A-Za-z_$][\w$]*)/);
  const marker = `// ===== ${firstFn ? firstFn[1] + ' 等' : '本段'}已迁移到 ./${path.relative(path.dirname(relSrc), relDst).replace(/\\/g, '/')} =====`;
  lines.splice(a - 1, b - a + 1, marker);
  fs.writeFileSync(srcFile, lines.join(eol), 'utf8');
  console.log(`✓ ${relSrc} L${a}-L${b} -> ${relDst} (${b - a + 1} 行)`);
  if (firstFn) console.log(`  注意：${relSrc} 若仍使用 ${firstFn[1]}，需 import 它（跑 tsc 会提示）。`);
}

// ---------- genheaders：按 manifest 统一补 import 头 ----------
function cmdGenHeaders() {
  const mapPath = path.resolve(ROOT, getArg('map', 'scripts/split-map.json'));
  const MODULE_OF = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const missing = new Set();

  for (const [out, info] of Object.entries(manifest)) {
    const file = path.join(PLUGIN_DIR, out);
    if (!fs.existsSync(file)) { console.warn('missing file', out); continue; }
    let src = fs.readFileSync(file, 'utf8');
    const eol = /\r\n/.test(src) ? '\r\n' : '\n';

    // 按目标模块分组
    const groups = new Map(); // modulePath -> Set(name)
    for (const d of info.deps) {
      const mod = MODULE_OF[d.id];
      if (!mod) { missing.add(d.id); continue; }
      if (mod === '<self>') continue;
      if (!groups.has(mod)) groups.set(mod, new Set());
      groups.get(mod).add(d.id);
    }
    if (!groups.size) { console.log(`- ${out}: 无外部依赖`); continue; }

    // 相对路径：从 out 所在目录算起
    const outDir = path.dirname(path.join('plugins', out));
    const stmts = [];
    for (const [mod, names] of groups) {
      if (mod === '<electron>') {
        // 外部 npm 包，直接 import 顶层（preload 环境允许引入 electron）
        stmts.push(`import { ${[...names].sort().join(', ')} } from 'electron';`);
        continue;
      }
      let rel = path.relative(outDir, path.join('plugins', mod)).replace(/\\/g, '/');
      if (!rel.startsWith('.')) rel = './' + rel;
      stmts.push(`import { ${[...names].sort().join(', ')} } from '${rel}';`);
    }
    const block = stmts.sort().join(eol) + eol + eol;
    // 插到文件最前（模块头注释由 genheaders 之后再手工补，避免覆盖）
    src = block + src;
    fs.writeFileSync(file, src, 'utf8');
    console.log(`✓ ${out}: 插入 ${stmts.length} 条 import`);
  }

  if (missing.size) {
    console.log('\n⚠ 以下标识符没有模块归属，需要在 split-map.json 里补映射：');
    console.log('  ' + [...missing].sort().join(', '));
  }
}

const cmd = argv[0];
if (cmd === 'batch') cmdBatch();
else if (cmd === 'move') cmdMove();
else if (cmd === 'genheaders') cmdGenHeaders();
else if (cmd === 'fiximports') cmdFixImports();
else console.log('usage: node scripts/embywall-split.js batch | move | genheaders | fiximports');

// ---------- fiximports：解析 tsc 报错，自动补 import（循环收敛的终极大招） ----------
function cmdFixImports() {
  const mapPath = path.resolve(ROOT, getArg('map', 'scripts/split-map.json'));
  const MODULE_OF = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  detectEol();

  // 1) 抓 tsc 错误：Cannot find name 'X'
  const { execSync } = require('child_process');
  let raw = '';
  try {
    raw = execSync('"node_modules/.bin/tsc" --noEmit', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { raw = e.stdout || ''; }
  const lines = raw.split(/\r?\n/);

  const RE = /^(.+?)\((\d+),\d+\):\s*error TS2304: Cannot find name '([^']+)'/;
  // 每个文件：缺失名集合
  const missingByFile = new Map();
  for (const ln of lines) {
    const m = ln.match(RE);
    if (!m) continue;
    const file = path.resolve(ROOT, m[1].replace(/\//g, path.sep));
    if (!missingByFile.has(file)) missingByFile.set(file, new Set());
    missingByFile.get(file).add(m[3]);
  }

  const unresolved = new Map(); // file -> Set(name 没归属)
  for (const [file, names] of missingByFile) {
    if (!fs.existsSync(file)) continue;
    let src = fs.readFileSync(file, 'utf8');
    const eol = /\r\n/.test(src) ? '\r\n' : '\n';
    const outDir = path.dirname(file);

    const groups = new Map();
    const noMod = new Set();
    for (const n of names) {
      const mod = MODULE_OF[n];
      if (!mod) { noMod.add(n); continue; }
      if (mod === '<self>') continue;
      if (!groups.has(mod)) groups.set(mod, new Set());
      groups.get(mod).add(n);
    }
    if (noMod.size) {
      if (!unresolved.has(file)) unresolved.set(file, new Set());
      noMod.forEach((n) => unresolved.get(file).add(n));
    }
    if (!groups.size) continue;

    const stmts = [];
    for (const [mod, ns] of groups) {
      if (mod === '<electron>') {
        const existing = src.match(/^import\s*\{[^}]*\b(ipcRenderer)\b[^}]*\}\s*from\s*['"]electron['"]/m);
        if (!existing) stmts.push(`import { ${[...ns].sort().join(', ')} } from 'electron';`);
        continue;
      }
      let rel = path.relative(outDir, path.join(PLUGIN_DIR, mod)).replace(/\\/g, '/');
      if (!rel.startsWith('.')) rel = './' + rel;
      const existing = src.match(new RegExp('^import\\s*\\{[^}]*\\b(' + [...ns].join('|') + ')\\b[^}]*\\}\\s*from', 'm'));
      if (existing) continue;
      stmts.push(`import { ${[...ns].sort().join(', ')} } from '${rel}';`);
    }
    if (!stmts.length) continue;
    src = stmts.sort().join(eol) + eol + eol + src;
    fs.writeFileSync(file, src, 'utf8');
    console.log(`✓ ${path.relative(ROOT, file)}: +${stmts.length} import`);
  }

  console.log(`\n解析到 ${missingByFile.size} 个文件有缺失引用`);
  if (unresolved.size) {
    console.log('⚠ 以下无法自动解析（需先抽到对应模块或确认来源）：');
    for (const [f, ns] of unresolved) console.log(`   ${path.relative(ROOT, f)}: ${[...ns].sort().join(', ')}`);
  }
}
