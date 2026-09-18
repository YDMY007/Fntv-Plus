// lc-1158 验证: 编译产物 appDialog 弹窗 + Esc/关闭拦截/超时
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const OUT = path.join(process.env.TEMP, 'ad-verify-result.txt');
fs.writeFileSync(OUT, 'start\n');
const { appDialog } = require(path.join(__dirname, '..', 'dest', 'main', 'common', 'appDialog.js'));

app.whenReady().then(async () => {
  const p = appDialog({
    type: 'warn', title: '安装路径不兼容',
    message: '测试逃生口（120s 超时兜底已启用）',
    buttons: ['退出并重装到英文路径', '仍要继续运行（风险自担）'],
    defaultId: 0, cancelId: 1,
  }).then((idx) => { fs.appendFileSync(OUT, 'RESOLVED index=' + idx + '\n'); return idx; });
  // 5s 后主进程直接对弹窗窗口发原生关闭消息(模拟 Alt+F4/任务栏关闭) → 应回 cancelId=1
  setTimeout(async () => {
    const wins = BrowserWindow.getAllWindows();
    fs.appendFileSync(OUT, 'windows=' + wins.length + '\n');
    if (wins.length) {
      // 模拟系统关闭: win.close()(走 'close' 拦截链, 与 Alt+F4 同路)
      wins[0].close();
      fs.appendFileSync(OUT, 'close-sent\n');
    }
  }, 5000);
  const idx = await p;
  fs.appendFileSync(OUT, idx === 1 ? 'PASS: cancelId 兜底生效\n' : 'UNEXPECTED idx=' + idx + '\n');
  app.exit(0);
});
