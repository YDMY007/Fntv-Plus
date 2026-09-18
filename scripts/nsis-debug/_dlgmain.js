// scripts/nsis-debug/_dlgmain.js — 真实 Electron 下实测 appDialog 的点击→IPC→resolve 全链路
// 跑法: npx tsc && electron scripts/nsis-debug/_dlgmain.js   (结果写 _dlgres.txt, 不写 stdout)
// 埋点层次: ①页面环境(require/ipcRenderer 有无) ②patch ipcRenderer.send 记录是否真被调用
//          ③按钮是否真正注册了 click 监听(用 DOM dispatch 触发) ④主进程是否收到
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { appDialog } = require(path.join(__dirname, '../../dest/main/common/appDialog.js'));

const OUT = path.join(__dirname, '_dlgres.txt');
const log = (s) => fs.appendFileSync(OUT, s + '\n');
try { fs.writeFileSync(OUT, ''); } catch { /* ignore */ }
const t0 = Date.now();

// 主进程侧旁听: 看 result 通道到底有没有消息进来
ipcMain.on('fntv-app-dialog:result', (_e, id, index) => log(`[main] 收到 result 通道: id=${id} index=${index}`));

app.whenReady().then(async () => {
    const w0 = () => BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());

    setTimeout(async () => {
        const w = w0();
        if (!w) { log('[probe] 没有窗口'); return; }
        w.webContents.on('console-message', (_e, _l, msg) => log('[page] ' + msg));
        w.webContents.on('render-process-gone', (_e, d) => log('[probe] 渲染进程没了: ' + JSON.stringify(d)));
        try {
            // ① 环境
            log('[probe] 环境: ' + await w.webContents.executeJavaScript(`JSON.stringify({
                require: typeof require, ipcRenderer: (()=>{try{return typeof require('electron').ipcRenderer}catch(e){return 'ERR:'+e.message}})(),
                buttonCount: document.querySelectorAll('button').length,
                xBtn: !!document.getElementById('fntv-ad-x')
            })`));
            // ② patch send 记录调用
            log('[probe] patch: ' + await w.webContents.executeJavaScript(`(() => {
                window.__calls = [];
                try {
                    const { ipcRenderer } = require('electron');
                    const orig = ipcRenderer.send.bind(ipcRenderer);
                    ipcRenderer.send = (...a) => { window.__calls.push(a.map(x => String(x))); return orig(...a); };
                    return 'ok';
                } catch (e) { return 'ERR: ' + e.message; }
            })()`));
        } catch (e) { log('[probe] 埋点失败: ' + e.message); }
    }, 700);

    // ③ 2.5s 后真实触发按钮点击(用 DOM click, 会走注册的监听)
    const clickTimer = setTimeout(async () => {
        const w = w0();
        if (!w) { log('[probe] 点击时没有窗口'); return; }
        try {
            log('[probe] 点击结果: ' + await w.webContents.executeJavaScript(`(() => {
                const b = document.querySelector('button[data-index="0"]');
                if (!b) return 'no-button';
                b.click();
                return 'clicked';
            })()`));
            // ④ 读回记录
            log('[probe] send 调用记录: ' + await w.webContents.executeJavaScript(`JSON.stringify(window.__calls || 'undefined')`));
        } catch (e) { log('[probe] 点击失败: ' + e.message); }
    }, 2500);

    // 保险: 20s 强制收尾(正常应远早于此)
    const bail = setTimeout(() => {
        log('[probe] 20s 兜底退出(说明 resolve 一直没发生)');
        app.quit();
    }, 20000);

    const result = await appDialog({
        type: 'warn',
        title: '安装路径不兼容',
        message: '检测到程序安装目录或系统用户目录包含中文 / 非英文字符（实测脚本）',
        buttons: ['退出并重装到英文路径', '仍要继续运行（风险自担）'],
        defaultId: 0,
        cancelId: 1,
    });

    clearTimeout(clickTimer);
    clearTimeout(bail);
    log(`[probe] RESULT = ${result}  (耗时 ${Date.now() - t0}ms)`);
    log(`[probe] 判定: ${result === 0 ? 'OK 链路通' : 'FAIL 没走到「点按钮 → resolve」这条路'}`);
    app.quit();
}).catch((e) => { log('[probe] ERR ' + e.message); app.quit(); });
