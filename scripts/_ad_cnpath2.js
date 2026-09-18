const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const OUT = 'C:\Users\24305\AppData\Local\Temp\ad-cn-result.txt';
fs.writeFileSync(OUT, 'start\n');
const { appDialog } = require(path.join(__dirname, '..', 'dest', 'main', 'common', 'appDialog.js'));
app.whenReady().then(async () => {
  fs.appendFileSync(OUT, 'ready\n');
  const p = appDialog({
    type: 'warn', title: '安装路径不兼容',
    message: '检测到程序安装目录或系统用户目录包含中文 / 非英文字符：\n\nD:\贴图测试\Fntv-Plus\Fntv-Plus.exe\n\n这会导致内置代理服务或外部播放器（MPV / PotPlayer）无法启动，表现为「程序打不开」「闪退」或「无弹幕」。\n您的登录配置存放在系统用户目录(AppData/Roaming/fntv)，与安装位置无关——重装到英文路径不会丢失登录状态。\n\n建议：卸载后重新安装到纯英文路径（例如 D:\Fntv-Plus 或 C:\Program Files\Fntv-Plus），即可彻底解决。',
    buttons: ['退出并重装到英文路径', '仍要继续运行（风险自担）'],
    defaultId: 0, cancelId: 1,
  });
  await new Promise(r => setTimeout(r, 4000));
  const wins = BrowserWindow.getAllWindows();
  fs.appendFileSync(OUT, 'wins=' + wins.length + '\n');
  if (wins.length) {
    const w = wins[0];
    const b = await w.webContents.capturePage();
    fs.writeFileSync('C:\Users\24305\AppData\Local\Temp\ad-cn-shot.png', b.toPNG());
    const m = await w.webContents.executeJavaScript(`JSON.stringify({
      scrollH: document.documentElement.scrollHeight, winH: window.innerHeight,
      btn1: (() => { const b = document.querySelector('button[data-index=\"1\"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), visible: r.bottom <= window.innerHeight && r.top >= 0 }; })(),
    })`).catch(e => 'measure-err ' + e.message);
    fs.appendFileSync(OUT, 'measure=' + m + '\n');
    // 自动点第二个按钮验证响应
    const clickR = await w.webContents.executeJavaScript(`document.querySelector('button[data-index=\"1\"]').click(); 'clicked'`).catch(e => 'click-err ' + e.message);
    fs.appendFileSync(OUT, 'click=' + clickR + '\n');
  }
  const idx = await p;
  fs.appendFileSync(OUT, 'RESOLVED idx=' + idx + '\n');
  app.exit(0);
});
