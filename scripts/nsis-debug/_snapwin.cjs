// _snapwin.cjs — 列出窗口源 / 按标题抓取指定窗口(仅供 NSIS 向导调试)
// 用法: npx electron scripts/nsis-debug/_snapwin.cjs list
//       npx electron scripts/nsis-debug/_snapwin.cjs snap <titleRegex> <out.png> [width]
const { app, desktopCapturer, screen } = require('electron');
const Fs = require('fs');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const mode = process.argv[2] || 'list';
  // 尺寸参数: argv[3] 可能是宽(数字)或标题正则; 传小尺寸可得 1:1 清晰窗口图
  const sizeArg = Number(process.argv[3]);
  const hasSize = Number.isFinite(sizeArg) && sizeArg > 0;
  const dw = hasSize ? sizeArg : screen.getPrimaryDisplay().size.width * 2;
  const dh = hasSize ? Math.round(sizeArg * 0.75) : screen.getPrimaryDisplay().size.height * 2;
  if (hasSize) process.argv.splice(3, 1);
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: dw, height: dh },
  });
  if (mode === 'list') {
    sources.forEach((s) => console.log(`${s.id}  |  ${s.name}`));
    app.quit();
    return;
  }
  const re = new RegExp(process.argv[3] || 'Fntv', 'i');
  const hit = sources.find((s) => re.test(s.name));
  if (!hit) {
    console.error('no window matched ' + re);
    sources.forEach((s) => console.error('  ' + s.name));
    app.quit();
    return;
  }
  const out = process.argv[4] || 'snapwin.png';
  const buf = hit.thumbnail.toPNG();
  Fs.writeFileSync(out, buf);
  const sz = hit.thumbnail.getSize();
  console.log(`[snapwin] ${hit.name} ${sz.width}x${sz.height} -> ${out}`);
  app.quit();
});
