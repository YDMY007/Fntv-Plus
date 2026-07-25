#!/usr/bin/env node
/**
 * 将本机已安装的 PotPlayer 目录复制到 third_party/potplayer，
 * 使其随 electron-builder 的 extraFiles 打进安装包（与 MPV 的打包方式一致）。
 *
 * 仅在 Windows 上生效（PotPlayer 仅支持 Windows）。
 * 若本机未找到 PotPlayer，则仅创建空目录占位，不阻断打包；
 * 打包后的安装包在缺少内置 PotPlayer 时会回退探测本机安装。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const DEST = path.join(ROOT, 'third_party', 'potplayer');

function ensureDest() {
    if (!fs.existsSync(DEST)) {
        fs.mkdirSync(DEST, { recursive: true });
    }
}

if (os.platform() !== 'win32') {
    console.log('[copy-potplayer] 非 Windows 平台，跳过 PotPlayer 复制（PotPlayer 仅支持 Windows）。');
    ensureDest();
    process.exit(0);
}

const LOCAL = process.env.LOCALAPPDATA || '';
const sources = [
    'C:\\Program Files\\DAUM\\PotPlayer',
    'C:\\Program Files (x86)\\DAUM\\PotPlayer',
    LOCAL ? path.join(LOCAL, 'PotPlayer') : ''
].filter(Boolean);

let src = null;
for (const s of sources) {
    if (s && fs.existsSync(s) && fs.existsSync(path.join(s, 'PotPlayerMini64.exe'))) {
        src = s;
        break;
    }
}

if (!src) {
    console.warn('[copy-potplayer] 未在本机找到 PotPlayer 安装目录，跳过复制。\n' +
        '  -> 打包后的安装包将不含内置 PotPlayer（播放时会回退探测本机安装）。\n' +
        '  -> 若需内置，请先安装 PotPlayer 后再执行 build:win。');
    ensureDest();
    process.exit(0);
}

// 跳过的个人数据子目录（避免把用户的观看记录/截图/缩略图打进包里）
// 注意：必须跳过 PotPlayerMini64.ini —— 它是 PotPlayer 的配置文件。
// 若把本机 ini 带进包，内置版就会沿用本机配置，违背「与本机隔离」的设计。
// 内置版改为在 userData 隔离副本里用空 ini 触发便携模式，自动生成独立配置。
const SKIP = new Set(['capture', 'thumbnails', 'playlist', 'log', 'logs', 'pplive', 'skin-user', 'history', 'potplayermini64.ini']);

console.log(`[copy-potplayer] 复制 PotPlayer: ${src} -> ${DEST}`);
fs.cpSync(src, DEST, {
    recursive: true,
    filter: (srcPath) => {
        const base = path.basename(srcPath).toLowerCase();
        return !SKIP.has(base);
    }
});
console.log('[copy-potplayer] 完成：PotPlayer 已就绪，将随安装包自带。');
