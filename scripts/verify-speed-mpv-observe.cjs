#!/usr/bin/env node
/**
 * [lc-1304] 机制验证：node-mpv-2 的 observeProperty('speed') 是否真能收到属性变化事件
 *
 * 为什么单独验：倍速记忆的「记住」环节完全依赖这件事 —— 应用控制栏/手柄改倍速、uosc 速度菜单、
 * input.conf 的 [ ] 快捷键，三条路都要靠 observe_property 的推送才能接住（node-mpv-2 默认
 * 观察列表里没有 speed，必须显式订阅）。光看依赖源码不够，起一个真 mpv 试一次最省心。
 *
 * 手法：用 --no-config --vo=null --ao=null --idle 起一个无窗口 mpv，订阅 speed，
 *      连改三次倍速，断言事件都到了且值正确。零浏览器、零 GPU、无窗口。
 */
const assert = require('assert');
const path = require('path');
const NodeMpv = require('node-mpv-2');

const MPV = path.resolve(__dirname, '../third_party/fntv-mpv/mpv.exe');

(async () => {
    const mpv = new NodeMpv({ binary: MPV, debug: false, verbose: false, auto_restart: false },
        ['--no-config', '--vo=null', '--ao=null', '--idle=yes']);

    const seen = [];
    mpv.on('status', (st) => {
        if (st && st.property === 'speed') seen.push(Number(st.value));
    });

    const t0 = Date.now();
    await mpv.start();
    console.log('mpv 启动耗时', Date.now() - t0, 'ms');

    await mpv.observeProperty('speed');
    console.log('已订阅 speed');

    await mpv.setProperty('speed', 1.5);
    await new Promise((r) => setTimeout(r, 300));
    await mpv.setProperty('speed', 2.25);
    await new Promise((r) => setTimeout(r, 300));
    await mpv.setProperty('speed', 1);
    await new Promise((r) => setTimeout(r, 400));

    console.log('收到的 speed 事件:', JSON.stringify(seen));
    await mpv.quit().catch(() => {});
    await new Promise((r) => setTimeout(r, 200));

    let code = 0;
    try {
        assert.ok(seen.length >= 3, '至少应收到 3 次 speed 事件，实际 ' + seen.length);
        assert.ok(seen.includes(1.5) && seen.includes(2.25) && seen.includes(1), '三次改值都应被推送');
    } catch (e) {
        console.log('✗ ' + e.message);
        code = 1;
    }
    if (code === 0) console.log('✓ observeProperty(\'speed\') 可用且事件及时到达 → 倍速记忆的「记住」环节成立');
    process.exit(code);
})().catch((e) => { console.error('✗ 异常:', e && e.message); process.exit(1); });
