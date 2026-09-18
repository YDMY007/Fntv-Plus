// scripts/nsis-debug/_dlgfit.js — 判定「按钮是否落在窗口可视区内」(真实鼠标点不到的真因候选)
// 跑法: npx tsc && electron scripts/nsis-debug/_dlgfit.js   结果写 _dlgres2.txt
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { appDialog } = require(path.join(__dirname, '../../dest/main/common/appDialog.js'));

const OUT = path.join(__dirname, '_dlgres2.txt');
const log = (s) => fs.appendFileSync(OUT, s + '\n');
try { fs.writeFileSync(OUT, ''); } catch { /* ignore */ }

app.whenReady().then(async () => {
    // 用与线上完全一致的长文案(中文路径阻断提示)
    const longMsg = '检测到程序安装目录或系统用户目录包含中文 / 非英文字符：\n\n' +
        'D:\\贴图测试\\Fntv-Plus\\Fntv-Plus.exe\n\n' +
        '这会导致内置代理服务或外部播放器（MPV / PotPlayer）无法启动，表现为「程序打不开」「闪退」或「无弹幕」。\n' +
        '您的登录配置存放在系统用户目录(AppData/Roaming/fntv)，与安装位置无关——重装到英文路径不会丢失登录状态。\n\n' +
        '建议：卸载后重新安装到纯英文路径（例如 D:\\Fntv-Plus 或 C:\\Program Files\\Fntv-Plus），即可彻底解决。';

    setTimeout(async () => {
        const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
        if (!w) { log('[probe] 没有窗口'); return; }
        try {
            const info = await w.webContents.executeJavaScript(`(() => {
                const card = document.querySelector('.card');
                const foot = document.querySelector('.foot');
                const b0 = document.querySelector('button[data-index="0"]');
                const x  = document.getElementById('fntv-ad-x');
                const rc = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
                    return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) }; };
                return JSON.stringify({
                    innerH: window.innerHeight, innerW: window.innerWidth,
                    scrollH: document.documentElement.scrollHeight,
                    bodyOverflow: getComputedStyle(document.body).overflowY,
                    card: rc(card), foot: rc(foot), btn0: rc(b0), xBtn: rc(x)
                }, null, 1);
            })()`);
            const [cw, ch] = w.getContentSize();
            log(`[probe] 窗口内容区 = ${cw} x ${ch}`);
            log('[probe] 页面内几何:');
            log(info);
            const f = JSON.parse(info);
            const btnVisible = f.btn0 && f.btn0.bottom <= f.innerH;
            log(`[probe] 第一个按钮 bottom=${f.btn0 ? f.btn0.bottom : 'n/a'} vs 可视高=${f.innerH} → ${btnVisible ? '在可视区内(能点到)' : '★被裁到窗口外(真实鼠标点不到!)'}`);
        } catch (e) { log('[probe] ERR ' + e.message); }
        app.quit();
    }, 3000);

    await appDialog({ type: 'warn', title: '安装路径不兼容', message: longMsg,
        buttons: ['退出并重装到英文路径', '仍要继续运行（风险自担）'], defaultId: 0, cancelId: 1 });
    log('[probe] (对话框已返回, 说明 3s 后被外部关掉了)');
    app.quit();
}).catch((e) => { log('[probe] ERR ' + e.message); app.quit(); });
