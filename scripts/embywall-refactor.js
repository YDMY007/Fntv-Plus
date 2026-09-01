/**
 * embyWall.ts 拆分工具：机械重命名 + 区块抽取
 *
 * 为什么用脚本而不是手改：12.5k 行里要改 30+ 个共享状态标识符、上千处引用，
 * 手改必漏。脚本只做「整词替换」这一件事，改完由 tsc 全量验证——
 * 少改一处 = 编译报错（未定义），多改一处 = 编译报错（属性不存在），
 * 所以「编译通过」等价于「替换完整且正确」。
 *
 * 用法：
 *   node scripts/embywall-refactor.js rename   # 共享状态 _xxx -> S.xxx
 *   node scripts/embywall-refactor.js strip    # 删除已迁走的声明（按行号）
 */
const fs = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, '../src/preload/plugins/embyWall.ts');

// 共享状态映射：原模块级变量 -> state.ts 容器字段
// （仅列「耦合分析确认被 >=2 个功能区引用」的，单区变量留在各自模块内保持内聚）
const RENAME = {
  _embyWallLogEnabled: 'S.logEnabled',
  _detailBoxless: 'S.detailBoxless',
  _wheelHScrollEnabled: 'S.wheelHScrollEnabled',
  _hotSource: 'S.hotSource',
  _carouselLogoEnabled: 'S.carouselLogoEnabled',
  _carouselInfos: 'S.carouselInfos',
  _carouselShows: 'S.carouselShows',
  _carouselBase: 'S.carouselBase',
  _apiShows: 'S.apiShows',
  _apiLoaded: 'S.apiLoaded',
  _apiLoading: 'S.apiLoading',
  _carouselInited: 'S.carouselInited',
  _carouselRevealed: 'S.carouselRevealed',
  _leftHome: 'S.leftHome',
  _carouselContainer: 'S.carouselContainer',
  _carouselUpdatedAt: 'S.carouselUpdatedAt',
  _carouselWrapper: 'S.carouselWrapper',
  _carouselPosterStrip: 'S.carouselPosterStrip',
  _placeholderInited: 'S.placeholderInited',
  _carouselProgressEl: 'S.carouselProgressEl',
  _carouselProgressCount: 'S.carouselProgressCount',
  _carouselProgressTimer: 'S.carouselProgressTimer',
  _carouselBarFill: 'S.carouselBarFill',
  _carouselPctEl: 'S.carouselPctEl',
  _carouselStatusEl: 'S.carouselStatusEl',
  _carouselProgressPct: 'S.carouselProgressPct',
  _carouselLoadedButNone: 'S.carouselLoadedButNone',
  _carouselCleanup: 'S.carouselCleanup',
  _carouselResume: 'S.carouselResume',
  _diagStuckTicks: 'S.diagStuckTicks',
  _diagStuckSince: 'S.diagStuckSince',
  _diagStuckLogged: 'S.diagStuckLogged',
  _diagLastShows: 'S.diagLastShows',
  _refreshThemeSeg: 'S.refreshThemeSeg',
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 保持原文件行尾：整个仓库是 CRLF，若脚本按 LF 重写会让 diff 变成「全文改动」，
// 淹没真正的重构内容，也让 git blame 失效。
let EOL = '\n';
function detectEol() {
  const head = fs.readFileSync(FILE, 'utf8').slice(0, 65536);
  const crlf = (head.match(/\r\n/g) || []).length;
  const lf = (head.match(/(?<!\r)\n/g) || []).length;
  if (crlf > lf) EOL = '\r\n';
}

function cmdRename() {
  detectEol();
  let src = fs.readFileSync(FILE, 'utf8');
  const report = [];
  for (const [from, to] of Object.entries(RENAME)) {
    // 整词匹配：前面不能是 字母/数字/_/$/.  （避免误伤 _carouselXxx 的前缀、obj._xxx）
    //          后面不能是 字母/数字/_/$
    const re = new RegExp('(?<![A-Za-z0-9_$.])' + esc(from) + '(?![A-Za-z0-9_$])', 'g');
    const hits = src.match(re) || [];
    src = src.replace(re, to);
    report.push([from.padEnd(24), to.padEnd(24), String(hits.length).padStart(5)]);
  }
  fs.writeFileSync(FILE, src, 'utf8');
  console.log('renamed (old -> new -> occurrences):');
  for (const r of report) console.log('  ' + r[0] + ' -> ' + r[1] + ' ' + r[2]);
  console.log('\ntotal:', report.reduce((a, r) => a + Number(r[2]), 0), 'replacements');
}

/**
 * 按行号删除已迁走的声明行。
 * ranges 为 [start, end] 闭区间（1-based，与原文件行号一致），从后往前删以免行号漂移。
 */
function cmdStrip(ranges) {
  detectEol();
  const lines = fs.readFileSync(FILE, 'utf8').split(EOL === '\r\n' ? '\r\n' : '\n');
  const kill = new Set();
  for (const [a, b] of ranges) for (let i = a; i <= b; i++) kill.add(i);
  const out = [];
  for (let i = 1; i <= lines.length; i++) {
    if (kill.has(i)) continue;
    out.push(lines[i - 1]);
  }
  fs.writeFileSync(FILE, out.join(EOL), 'utf8');
  console.log('stripped', kill.size, 'lines;', lines.length, '->', out.length, '(EOL=' + JSON.stringify(EOL) + ')');
}

/**
 * 把一个连续行区间搬到新模块文件，并在原位置留下指向注释。
 * 参数：--range=a-b --out=<相对 src/preload/plugins 的路径> --header=<头文件内容文件>
 * 原位置统一替换成一行「已迁移」注释，保证读者能立刻知道代码去哪了。
 */
function cmdExtract(opts) {
  detectEol();
  const raw = fs.readFileSync(FILE, 'utf8');
  const lines = raw.split(EOL === '\r\n' ? '\r\n' : '\n');
  const [a, b] = opts.range;
  const body = lines.slice(a - 1, b);
  const header = opts.headerFile ? fs.readFileSync(opts.headerFile, 'utf8') : '';
  const outPath = path.resolve(__dirname, '../src/preload/plugins', opts.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, header + body.join('\n'), 'utf8');

  // 原位置留注释（保留首行的分节标题，方便对照）
  const titleRaw = (body.find((l) => /^\s*(\/\*\s*=|\/\/\s*=)/.test(l)) || '').trim();
  const title = titleRaw.replace(/^[/*\s=]+|[=*\/\s]+$/g, '').slice(0, 50);
  const marker = `// ===== 已迁移到 ./${opts.out} ${title ? '（' + title + '）' : ''} =====`;
  lines.splice(a - 1, b - a + 1, marker);
  fs.writeFileSync(FILE, lines.join(EOL), 'utf8');
  console.log(`extracted L${a}-L${b} (${b - a + 1} lines) -> ${opts.out}`);
  console.log(`embyWall.ts: ${lines.length + (b - a + 1) - 1} -> ${lines.length} lines`);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
if (cmd === 'rename') {
  cmdRename();
} else if (cmd === 'extract') {
  const get = (k) => { const m = argv.find((a) => a.startsWith('--' + k + '=')); return m ? m.slice(k.length + 3) : undefined; };
  const range = get('range').split('-').map(Number);
  cmdExtract({ range, out: get('out'), headerFile: get('header') });
} else if (cmd === 'strip') {
  // 行号由调用方给出，格式: --ranges 10-14,28-33
  const arg = argv.find((a) => a.startsWith('--ranges='));
  if (!arg) { console.error('need --ranges=1-5,10-12'); process.exit(1); }
  const ranges = arg.slice('--ranges='.length).split(',').map((s) => s.split('-').map(Number));
  cmdStrip(ranges);
} else {
  console.log('usage: node scripts/embywall-refactor.js rename | strip --ranges=a-b,c-d');
}
