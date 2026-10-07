#!/usr/bin/env node
// scripts/build-setup-ui.cjs — 编译自绘安装器 UI 进程(WPF+WebView2, csc 直编)
// 产物 → build/setup-ui/:
//   FntvSetupUi.exe     UI 进程(WPF+WebView2 宿主)
//   WebView2Loader.dll  WebView2 原生加载器
//   icon.ico            窗口/任务栏图标
//   www.zip             安装器页面(index.html/app.css/app.js/license.txt)
//   app-meta.json       {version, exeName}
//   totalsize.txt       预期安装后字节数(进度分母, 以 dest/ 实测近似)
// dev: node scripts/build-setup-ui.cjs --dev  → 额外把 meta/许可/icon 就地写进
//   scripts/setup-ui/www/, 并以 --dev 模式启动 UI(演示进度, 不跑真安装器)。
'use strict';
const Fs = require('fs');
const Path = require('path');
const { execFileSync } = require('child_process');

const ROOT = Path.resolve(__dirname, '..');
const SRC = Path.join(ROOT, 'scripts', 'setup-ui');
const OUT = Path.join(ROOT, 'build', 'setup-ui');
const PKG = JSON.parse(Fs.readFileSync(Path.join(ROOT, 'package.json'), 'utf8'));
const DEV = process.argv.includes('--dev');
const RUN = process.argv.includes('--run');

const FRAMEWORK = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319';
const GAC = 'C:/Windows/Microsoft.NET/assembly';
const VENDOR = Path.join(SRC, 'vendor', 'extracted');

function findCsc() {
  const vsRoots = ['C:/Program Files/Microsoft Visual Studio', 'C:/Program Files (x86)/Microsoft Visual Studio'];
  for (const vs of vsRoots) {
    if (!Fs.existsSync(vs)) continue;
    for (const year of Fs.readdirSync(vs)) {
      const yearDir = Path.join(vs, year);
      if (!Fs.statSync(yearDir).isDirectory()) continue;
      for (const ed of Fs.readdirSync(yearDir)) {
        const p = Path.join(yearDir, ed, 'MSBuild', 'Current', 'Bin', 'Roslyn', 'csc.exe');
        if (Fs.existsSync(p)) return p;
      }
    }
  }
  const inbox = FRAMEWORK + '/csc.exe';
  if (Fs.existsSync(inbox)) return inbox;
  throw new Error('找不到 csc.exe (需要 VS2022 或 .NET Framework 4.x)');
}

function refList() {
  const refs = [
    Path.join(GAC, 'GAC_MSIL/PresentationFramework/v4.0_4.0.0.0__31bf3856ad364e35/PresentationFramework.dll'),
    Path.join(GAC, 'GAC_64/PresentationCore/v4.0_4.0.0.0__31bf3856ad364e35/PresentationCore.dll'),
    Path.join(GAC, 'GAC_MSIL/WindowsBase/v4.0_4.0.0.0__31bf3856ad364e35/WindowsBase.dll'),
    Path.join(GAC, 'GAC_MSIL/System.Xaml/v4.0_4.0.0.0__b77a5c561934e089/System.Xaml.dll'),
    FRAMEWORK + '/System.Windows.Forms.dll',
    FRAMEWORK + '/System.Drawing.dll',
    FRAMEWORK + '/System.dll',
    FRAMEWORK + '/System.Core.dll',
    FRAMEWORK + '/System.IO.Compression.dll',
    FRAMEWORK + '/System.IO.Compression.FileSystem.dll',
    Path.join(VENDOR, 'lib/net462/Microsoft.Web.WebView2.Core.dll'),
    Path.join(VENDOR, 'lib/net462/Microsoft.Web.WebView2.Wpf.dll'),
  ];
  for (const r of refs) if (!Fs.existsSync(r)) throw new Error('缺引用: ' + r);
  return refs;
}

function dirSize(dir) {
  let total = 0;
  for (const e of Fs.readdirSync(dir, { withFileTypes: true })) {
    const p = Path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else total += Fs.statSync(p).size;
  }
  return total;
}

function makeWwwZip() {
  const www = Path.join(SRC, 'www');
  const stage = Path.join(OUT, '_www');
  Fs.rmSync(stage, { recursive: true, force: true });
  Fs.mkdirSync(stage, { recursive: true });
  const files = ['index.html', 'app.css', 'app.js', 'license.html', 'logo.png'];
  for (const f of files) {
    Fs.copyFileSync(Path.join(www, f), Path.join(stage, f));
  }
  // Compress-Archive 的分隔符兼容 .NET ZipFile 读取
  execFileSync('powershell.exe', [
    '-NoProfile', '-Command',
    `Compress-Archive -Path '${stage}\\*' -DestinationPath '${Path.join(OUT, 'www.zip')}' -Force`
  ], { stdio: 'inherit' });
  Fs.rmSync(stage, { recursive: true, force: true });
}

function writeMeta(targetDir) {
  const exeName = (PKG.productName || 'Fntv-Plus') + '.exe';
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const releaseDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  Fs.writeFileSync(Path.join(targetDir, 'app-meta.json'),
    JSON.stringify({ version: PKG.version, exeName, releaseDate }));
  // 进度分母 = 预期安装后体积: 优先上一版 win-unpacked 实测, 次选 dest 估算, 最后保守常数
  const unpacked = Path.join(ROOT, 'release', 'win-unpacked');
  const destDir = Path.join(ROOT, 'dest');
  let approx;
  if (Fs.existsSync(unpacked)) approx = dirSize(unpacked);
  else if (Fs.existsSync(destDir)) approx = Math.round(dirSize(destDir) * 0.94);
  else approx = 400 * 1024 * 1024;
  Fs.writeFileSync(Path.join(targetDir, 'totalsize.txt'), String(approx));
}

function makeLicense() {
  // 协议排版化: 中文要点导语块 + GPL 原文按段落/条款标题结构化(纯文本墙 → 可读版式)
  const raw = Fs.readFileSync(Path.join(ROOT, 'LICENSE'), 'utf8').replace(/\r\n/g, '\n');
  const isGpl = /GNU GENERAL PUBLIC LICENSE/i.test(raw);
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const paras = raw.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const body = paras.map((p, i) => {
    if (i === 0 && isGpl) {
      // 文档头: GNU GENERAL PUBLIC LICENSE / Version 3, 29 June 2007...
      return '<div class="lic-doc-head">' + esc(p).replace(/\n/g, '<br>') + '</div>';
    }
    const num = p.match(/^(\d+)\.\s/);
    if (num) {
      return '<h4><span class="ln">' + num[1] + '</span>' +
        esc(p.replace(/^\d+\.\s*/, '')).replace(/\n/g, ' ') + '</h4>';
    }
    if (/^[A-Z0-9 ,.\'()\-]+$/.test(p) && p.length < 80) {
      return '<h3>' + esc(p) + '</h3>';   // TERMS AND CONDITIONS 等全大写节标题
    }
    if (/^Preamble$/i.test(p)) return '<h3>Preamble(前言)</h3>';
    return '<p>' + esc(p).replace(/\n/g, ' ') + '</p>';
  }).join('\n');

  const html = `<div class="lic-intro">
  <h2>Fntv-Plus 用户许可协议</h2>
  <p>本软件是飞牛影视(fnOS)的第三方增强客户端, 按 ${isGpl ? 'GNU General Public License v3' : '仓库所附开源协议'} 开源发布。点击「同意并继续」即表示你已阅读并同意以下要点与所附协议原文。</p>
  <ul>
    <li>本软件是自由软件, 可在协议条款下自由使用、修改与再分发, 须保留版权与许可声明;</li>
    <li>本软件按「现状」提供, 不附带任何担保, 作者不对直接或间接损失承担责任;</li>
    <li>本软件与飞牛/fnOS 官方无隶属关系, 相关商标归各自权利人所有。</li>
  </ul>
</div>
${body}`;
  Fs.writeFileSync(Path.join(SRC, 'www', 'license.html'), html);
  Fs.rmSync(Path.join(SRC, 'www', 'license.txt'), { force: true });
}

// ── 主流程 ──
Fs.mkdirSync(OUT, { recursive: true });
makeLicense();
// 品牌行 logo 用方形 App 图标(icon.png); iconfntv.png 是 2100×600 横版组合标,
// 塞进 40px 角落后图形仅 ~10px 高, 肉眼不可辨(lc-1276 用户反馈)。
Fs.copyFileSync(Path.join(ROOT, 'build/icon.png'), Path.join(SRC, 'www', 'logo.png'));

const csc = findCsc();
const rsp = [
  '-nologo',
  '-target:winexe',
  '-platform:anycpu',
  '-optimize+',
  `-out:${Path.join(OUT, 'FntvSetupUi.exe')}`,
  `-win32manifest:${Path.join(SRC, 'app.manifest')}`,
  `-win32icon:${Path.join(ROOT, 'build', 'icon.ico')}`,
  ...refList().map((r) => `-r:"${r}"`),
  `"${Path.join(SRC, 'SetupUi.cs')}"`,
].join('\r\n');
const rspPath = Path.join(SRC, 'setup-ui.rsp');
Fs.writeFileSync(rspPath, rsp);
console.log('[build-setup-ui] csc =', csc);
execFileSync(csc, ['@' + rspPath], { stdio: 'inherit' });

Fs.copyFileSync(Path.join(VENDOR, 'runtimes/win-x64/native/WebView2Loader.dll'), Path.join(OUT, 'WebView2Loader.dll'));
Fs.copyFileSync(Path.join(VENDOR, 'lib/net462/Microsoft.Web.WebView2.Core.dll'), Path.join(OUT, 'Microsoft.Web.WebView2.Core.dll'));
Fs.copyFileSync(Path.join(VENDOR, 'lib/net462/Microsoft.Web.WebView2.Wpf.dll'), Path.join(OUT, 'Microsoft.Web.WebView2.Wpf.dll'));
Fs.copyFileSync(Path.join(ROOT, 'build/icon.ico'), Path.join(OUT, 'icon.ico'));
makeWwwZip();
writeMeta(OUT);
console.log('[build-setup-ui] done → build/setup-ui/');

// ── dev 模式: 就地准备 www 开发资材并可拉起 UI ──
if (DEV) {
  writeMeta(Path.join(SRC, 'www'));
  console.log('[build-setup-ui] dev 资材就绪');
}
if (RUN) {
  const args = ['--dev', '--www', Path.join(SRC, 'www')];
  const exe = Path.join(OUT, 'FntvSetupUi.exe');
  console.log('[build-setup-ui] run:', exe, args.join(' '));
  execFileSync(exe, args, { stdio: 'ignore', detached: false });
}
