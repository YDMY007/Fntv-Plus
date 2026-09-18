// 量测: 加载 appDialog HTML, 量 scrollHeight vs 窗口 clientHeight → 溢出量
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.whenReady().then(async () => {
  const { buildAppDialogHtml } = require(path.join(__dirname, '..', 'dest', 'main', 'common', 'appDialog.js'));
  const html = buildAppDialogHtml({
    type: 'warn', title: '安装路径不兼容',
    message: '检测到程序安装目录或系统用户目录包含中文 / 非英文字符：\n\nD:\贴图测试\Fntv-Plus\Fntv-Plus.exe\n\n这会导致内置代理服务或外部播放器（MPV / PotPlayer）无法启动，表现为「程序打不开」「闪退」或「无弹幕」。\n您的登录配置存放在系统用户目录(AppData/Roaming/fntv)，与安装位置无关——重装到英文路径不会丢失登录状态。\n\n建议：卸载后重新安装到纯英文路径（例如 D:\Fntv-Plus 或 C:\Program Files\Fntv-Plus），即可彻底解决。',
    buttons: ['退出并重装到英文路径', '仍要继续运行（风险自担）'],
    defaultId: 0, cancelId: 1,
  }, 'measure');
  const win = new BrowserWindow({ width: 470, height: 565, useContentSize: false, show: false, webPreferences: {} });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const m = await win.webContents.executeJavaScript(`JSON.stringify({
    scrollH: document.documentElement.scrollHeight,
    bodyH: document.body.scrollHeight,
    cardH: document.querySelector('.card').scrollHeight,
    cardRect: document.querySelector('.card').getBoundingClientRect().height,
    footBottom: Math.round(document.querySelector('.foot').getBoundingClientRect().bottom),
    btnCount: document.querySelectorAll('button[data-index]').length,
    lastBtn: (() => { const b = document.querySelector('button[data-index="1"]'); const r = b.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), visible: r.bottom <= window.innerHeight }; })(),
    winH: window.innerHeight
  })`);
  console.log(m);
  app.exit(0);
});
