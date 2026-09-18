// scripts/nsis-debug/_dlgreal.js — 只弹窗并记录窗口几何, 供外部真实鼠标点击验证
// 跑法: npx tsc && electron scripts/nsis-debug/_dlgreal.js   结果写 _dlgres3.txt
// 配合 _clickreal.py: 读窗口位置 → SendInput 真实鼠标点击第一个按钮
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { appDialog } = require(path.join(__dirname, '../../dest/main/common/appDialog.js'));

const OUT = path.join(__dirname, '_dlgres3.txt');
const log = (s) => fs.appendFileSync(OUT, s + '\n');
try { fs.writeFileSync(OUT, ''); } catch { /* ignore */ }
const t0 = Date.now();

app.whenReady().then(async () => {
    setTimeout(async () => {
        const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
        if (!w) { log('[probe] 没有窗口'); return; }
        const [wx, wy] = w.getPosition();
        const [cw, ch] = w.getContentSize();
        log(`[probe] bounds=${JSON.stringify(w.getBounds())} content=${JSON.stringify(w.getContentSize())} ` +
            `focused=${w.isFocused()} visible=${w.isVisible()} alwaysOnTop=${w.isAlwaysOnTop()}`);
        try {
            // 关键埋点: 在页面里记录「真实鼠标事件到底有没有进来」
            await w.webContents.executeJavaScript(`(() => {
                window.__ev = [];
                ['mousedown','mouseup','click','mousemove'].forEach(t =>
                    document.addEventListener(t, (e) => {
                        if (t === 'mousemove' && window.__ev.filter(x=>x[0]==='mousemove').length > 4) return;
                        window.__ev.push([t, Math.round(e.clientX), Math.round(e.clientY),
                            (e.target && e.target.tagName) + (e.target && e.target.dataset ? JSON.stringify(e.target.dataset) : '')]);
                    }, true));
                return 'listening';
            })()`);
            const geo = JSON.parse(await w.webContents.executeJavaScript(`(() => {
                const g = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
                    return {t:Math.round(r.top),b:Math.round(r.bottom),l:Math.round(r.left),r:Math.round(r.right)}; };
                return JSON.stringify({ btn0: g(document.querySelector('button[data-index="0"]')),
                    xBtn: g(document.getElementById('fntv-ad-x')), innerH: window.innerHeight });
            })()`));
            const cx = wx + Math.round((geo.btn0.l + geo.btn0.r) / 2);
            const cy = wy + Math.round((geo.btn0.t + geo.btn0.b) / 2);
            log(`[probe] 窗口=${wx},${wy} 内容=${cw}x${ch} 页面可视高=${geo.innerH}`);
            log(`[probe] btn0=${JSON.stringify(geo.btn0)}  xBtn=${JSON.stringify(geo.xBtn)}`);
            log(`[probe] CLICK_AT=${cx},${cy}`);
        } catch (e) { log('[probe] 几何上报失败: ' + e.message); }
        // 8.5s 时读回事件记录(外部会在 5s 前发真实鼠标点击)
        setTimeout(async () => {
            try {
                const ev = await w.webContents.executeJavaScript(`JSON.stringify(window.__ev || 'none')`);
                log('[probe] 页面收到的事件: ' + ev);
            } catch (e) { log('[probe] 读事件失败: ' + e.message); }
            log('[probe] (窗口仍在等待用户选择 → 说明真实点击没触发 resolve)');
        }, 6000);
    }, 2500);

    const r = await appDialog({
        type: 'warn',
        title: '安装路径不兼容',
        message: '检测到程序安装目录或系统用户目录包含中文 / 非英文字符：\n\n' +
            'D:\\贴图测试\\Fntv-Plus\\Fntv-Plus.exe\n\n' +
            '这会导致内置代理服务或外部播放器（MPV / PotPlayer）无法启动，表现为「程序打不开」「闪退」或「无弹幕」。',
        buttons: ['退出并重装到英文路径', '仍要继续运行（风险自担）'],
        defaultId: 0,
        cancelId: 1,
    });
    log(`[probe] RESULT = ${r}  (耗时 ${Date.now() - t0}ms)`);
    log(`[probe] 判定: ${r === 0 ? 'OK 真实鼠标点击也被收到了' : 'FAIL 真实鼠标点击没落到按钮上(返回的是 cancelId/超时)'}`);
    app.quit();
}).catch((e) => { log('[probe] ERR ' + e.message); app.quit(); });
