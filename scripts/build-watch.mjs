// 构建可视化监控脚本
// 用法: node scripts/build-watch.mjs
// 启动后浏览器打开 http://localhost:4848 即可实时观看构建进度与日志。
// 脚本会自动设置 NODE_OPTIONS=--use-system-ca(沙箱环境需要，普通机器无害)。
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..'); // scripts/.. = 项目根
const DASHBOARD = path.join(__dirname, 'build-dashboard.html');
const PORT = 4848;

// 读取版本号
let VERSION = 'unknown';
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  VERSION = pkg.version || VERSION;
} catch { /* ignore */ }

// 8 个构建阶段(按顺序). kw = 在 npm 输出中用于识别该阶段开始的字符串。
const STAGES = [
  { id: 'proxy',     label: '编译代理 proxy.exe（Go）',        kw: 'build:proxy:win' },
  { id: 'potctl',    label: '编译 potctl.exe（Go）',           kw: 'build:potctl:win' },
  { id: 'potplayer', label: '复制 PotPlayer 资源',             kw: 'build:potplayer:win' },
  { id: 'compile',   label: 'TypeScript 编译（tsc → dest/）',  kw: 'compile' },
  { id: 'builder',   label: 'electron-builder 初始化',         kw: 'electron-builder  version' },
  { id: 'native',    label: '安装原生依赖（native deps）',      kw: 'installing native dependencies' },
  { id: 'packaging', label: '打包 Electron → win-unpacked',     kw: 'packaging' },
  { id: 'nsis',      label: '生成 NSIS 安装包（.exe）',         kw: 'building' },
];

const state = {
  version: VERSION,
  startTime: Date.now(),
  stages: STAGES.map(s => ({ ...s, status: 'pending', detail: '' })),
  current: -1,
  log: [],
  done: false,
  error: null,
  exePath: null,
};

function setStage(idx, status, detail = '') {
  if (idx < 0 || idx >= state.stages.length) return;
  if (state.stages[idx].status === 'error') return; // 错误不可逆
  state.stages[idx].status = status;
  if (detail) state.stages[idx].detail = detail;
}
function markPriorDone(uptoExclusive) {
  for (let i = 0; i < uptoExclusive; i++) setStage(i, 'done');
}

function logLine(raw) {
  const line = raw.trim();
  if (!line) return;
  state.log.push(line);
  if (state.log.length > 500) state.log.shift();

  STAGES.forEach((s, i) => {
    if (line.includes(s.kw)) {
      markPriorDone(i);
      if (state.stages[i].status === 'pending') {
        setStage(i, 'active');
        state.current = i;
      }
    }
  });
  if (line.includes('completed installing native dependencies')) {
    const i = STAGES.findIndex(s => s.id === 'native');
    setStage(i, 'done', 'completed');
  }
  if (line.includes('downloaded') && line.includes('electron')) {
    const i = STAGES.findIndex(s => s.id === 'packaging');
    if (state.stages[i].status === 'active') state.stages[i].detail = 'electron 下载完成 100%';
  }
  const low = line.toLowerCase();
  if (low.includes('npm error') || /^error:/.test(line) || low.includes('failed with code')) {
    if (state.current >= 0) setStage(state.current, 'error', line.slice(0, 200));
    state.error = state.error || line.slice(0, 300);
  }
}

// 启动构建子进程
const env = { ...process.env };
if (!env.NODE_OPTIONS || !env.NODE_OPTIONS.includes('--use-system-ca')) {
  env.NODE_OPTIONS = (env.NODE_OPTIONS ? env.NODE_OPTIONS + ' ' : '') + '--use-system-ca';
}
const child = spawn('npm', ['run', 'build:win'], { cwd: ROOT, env, shell: true });
child.stdout.on('data', d => String(d).split(/\r?\n/).forEach(logLine));
child.stderr.on('data', d => String(d).split(/\r?\n/).forEach(logLine));
child.on('exit', (code) => {
  if (code === 0) {
    markPriorDone(state.stages.length);
    state.done = true;
    const rel = path.join(ROOT, 'release');
    if (fs.existsSync(rel)) {
      const exes = fs.readdirSync(rel).filter(f => f.toLowerCase().endsWith('.exe'));
      if (exes.length) state.exePath = path.join(rel, exes[0]);
    }
    console.log('✅ 构建完成: ' + (state.exePath || path.join(ROOT, 'release')));
  } else {
    if (state.current >= 0) setStage(state.current, 'error', 'exit code ' + code);
    state.error = state.error || ('构建失败，退出码 ' + code);
    console.log('❌ 构建失败，退出码 ' + code);
  }
});

// HTTP 服务: 提供仪表盘 + /status JSON
const server = http.createServer((req, res) => {
  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(state));
    return;
  }
  try {
    const html = fs.readFileSync(DASHBOARD, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('dashboard not found: ' + e.message);
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 被占用，请先关闭占用进程，或修改脚本中的 PORT。`);
  } else {
    console.error(e);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log('🔧 构建监控已启动: ' + url);
  console.log(`   版本: ${VERSION}    输出目录: ${path.join(ROOT, 'release')}`);
  console.log('   浏览器打开上面的地址即可实时观看进度；构建完成后会显示 exe 路径。');
  // 尽力自动打开浏览器(沙箱/无 GUI 时静默失败)
  try {
    const { exec } = await import('node:child_process');
    exec(`start "" "${url}"`, { windowsHide: true }, () => {});
  } catch { /* ignore */ }
});
