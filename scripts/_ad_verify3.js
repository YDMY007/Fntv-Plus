// lc-1158 终验 v3: 全程只写文件, 不依赖 stdout
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const OUT = 'C:\Users\24305\AppData\Local\Temp\ad-v3-result.txt';
const step = (t) => { try { fs.appendFileSync(OUT, t + '\n'); } catch (e) {} };
step('boot');
const appDialog = require(path.join(__dirname, '..', 'dest', 'main', 'common', 'appDialog.js')).appDialog;
app.whenReady().then(async () => {
  step('ready');
  const p = appDialog({
    type: 'warn', title: '安装路径不兼容',
    message: '检测到程序安装目录或系统用户目录包含中文 / 非英文字符：\n\nD:\贴图测试\Fntv-Plus\Fntv-Plus.exe\n\n这会导致内置代理服务或外部播放器（MPV / PotPlayer）无法启动，表现为「程序打不开」「闪退」或「无弹幕」。\n您的登录配置存放在系统用户目录(AppData/Roaming/fntv)，与安装位置无关——重装到英文路径不会丢失登录状态。\n\n建议：卸载后重新安装到纯英文路径（例如 D:\Fntv-Plus 或 C:\Program Files\Fntv-Plus），即可彻底解决。',
    buttons: ['退出并重装到英文路径', '仍要继续运行（风险自担）'],
    defaultId: 0, cancelId: 1,
  });
  step('dialog-called');
  await new Promise(r => setTimeout(r, 5000));
  const wins = BrowserWindow.getAllWindows();
  step('windows=' + wins.length);
  if (wins.length) {
    const w = wins[0];
    const [cw, ch] = w.getContentSize();
    step('size=' + cw + 'x' + ch);
    const b = await w.webContents.capturePage().catch(() => null);
    if (b) fs.writeFileSync('C:\Users\24305\AppData\Local\Temp\ad-v3-shot.png', b.toPNG());
    const m = await w.webContents.executeJavaScript(
      `(function(){ var b=document.querySelector('button[data-index="1"]'); var r=b.getBoundingClientRect(); return JSON.stringify({winH:window.innerHeight, scrollH:document.documentElement.scrollHeight, btnTop:Math.round(r.top), btnBottom:Math.round(r.bottom), visible:r.bottom<=window.innerHeight&&r.top>=0}); })()`
    ).catch(e => 'm-err:' + e.message);
    step('measure=' + m);
    await w.webContents.executeJavaScript(`document.querySelector('button[data-index="0"]').click()`).catch(e => step('click-err:' + e.message));
    step('clicked-0');
  }
  const idx = await p;
  step('RESOLVED idx=' + idx + (idx === 0 ? ' PASS' : ' FAIL'));
  app.exit(idx === 0 ? 0 : 1);
});
process.on('uncaughtException', (e) => { step('UNCAUGHT ' + e.message); app.exit(2); });
