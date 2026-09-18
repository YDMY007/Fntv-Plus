// 临时复现 v2: 结果写文件(规避 shell 管道 EPIPE), 验证 appDialog HTML 里 require/ipcRenderer 可用性
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const OUT = path.join(process.env.TEMP, 'ad-repro-result.txt');
fs.writeFileSync(OUT, 'start\n');

ipcMain.on('fntv-app-dialog:result', (_e, id, index) => {
  fs.appendFileSync(OUT, 'RECV result id=' + id + ' index=' + index + '\n');
  app.exit(0);
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 470, height: 420, frame: false, show: false, center: true,
    backgroundColor: '#00000000',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  await win.loadFile(path.join(process.env.TEMP, 'ad-test.html'));
  const probe = await win.webContents.executeJavaScript(
    `(typeof require !== 'undefined') + '|' + (typeof ipcRenderer) + '|' + document.querySelectorAll('button[data-index]').length`,
  ).catch((e) => 'probe-err: ' + e.message);
  fs.appendFileSync(OUT, 'probe: ' + probe + '\n');
  win.show();
  setTimeout(async () => {
    try {
      const r = await win.webContents.executeJavaScript(`document.querySelector('button[data-index="0"]').click(); 'clicked'`);
      fs.appendFileSync(OUT, 'click: ' + r + '\n');
    } catch (e) { fs.appendFileSync(OUT, 'click-err: ' + e.message + '\n'); }
    setTimeout(() => { fs.appendFileSync(OUT, 'TIMEOUT no ipc in 3s\n'); app.exit(1); }, 3000);
  }, 800);
});
