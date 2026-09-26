import * as fs from 'fs';
import * as path from 'path';

import { HookType, runHooks } from './core/hooks';

// 导入渲染进程日志模块
import preloadLogger from './core/logger';

// 由于 contextIsolation: false，直接在全局对象上暴露日志接口
(global as any).log = preloadLogger;
(global as any).logger = preloadLogger;

// 如果在浏览器环境中，也暴露到window对象
if (typeof window !== 'undefined') {
    window.log = preloadLogger;
    window.logger = preloadLogger;
}

// 自动加载插件（含 [lc-474] 热补丁覆盖）
const bundledPluginsDir = path.join(__dirname, 'plugins');
const patchesDir = process.env.FNTV_PATCHES_DIR || '';

// [lc-474] 让热补丁文件(位于 asar 外 patches 目录)的同级 require 回退到 asar 内原插件目录，
//   如此只需覆盖被修文件，其依赖(如 './core/hooks')仍从原处解析，无需把整个插件树打进补丁。
const Module = require('module');
const _origResolve = Module._resolveFilename;
function requirePatch(patchFile: string): void {
    Module._resolveFilename = function (request: string, parent: any, ...rest: any[]): string {
        try {
            return _origResolve.call(this, request, parent, ...rest);
        } catch (e) {
            if (patchesDir && parent && typeof parent.filename === 'string'
                && parent.filename.startsWith(patchesDir)
                && typeof request === 'string' && request.startsWith('.')) {
                // [fix] 把相对依赖重新相对到 bundled 插件目录解析；
                //   用 stub-parent 走 _origResolve 可自动补 .js/.json 扩展名，
                //   旧写法 path.resolve 不带扩展名、fs.existsSync 必为 false 导致回退失效，
                //   补丁文件(如 embyWall.js)因 require('../core/hooks') 失败而被整体跳过，热补丁永不生效。
                const stubParent = {
                    filename: path.join(bundledPluginsDir, '_patch_stub_.js'),
                    id: path.join(bundledPluginsDir, '_patch_stub_.js'),
                    paths: [],
                };
                try {
                    return _origResolve.call(this, request, stubParent as any, ...rest);
                } catch {
                    // bundled 中也缺失该依赖，保留原错误
                }
            }
            throw e;
        }
    };
    try {
        require(patchFile);
    } finally {
        Module._resolveFilename = _origResolve;
    }
}

const patchedNames = new Set<string>();
// [lc-479] 递归加载 patches/preload 下所有 .js：应用器按 preload/plugins/X.js 子目录写入补丁文件，
//   原「仅扫 patches/ 顶层」会漏掉子目录里的补丁 → 下载后永不生效（asar 旧文件照跑）。
//   仅加载 preload 分支，避免在主进程上下文误加载 main 补丁；basename 纳入 patchedNames 以便跳过 bundled 同名插件。
function loadPatchDir(dir: string): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            loadPatchDir(full);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            try {
                requirePatch(full);
                patchedNames.add(entry.name);
            } catch (err) {
                preloadLogger.error('[patch] 加载热补丁失败:', entry.name, err);
            }
        }
    }
}
if (patchesDir && fs.existsSync(patchesDir)) {
    loadPatchDir(path.join(patchesDir, 'preload'));
    if (patchedNames.size) preloadLogger.info(`[patch] 已加载热补丁 ${patchedNames.size} 个: ${[...patchedNames].join(', ')}`);
}

// 原插件：被热补丁同名的跳过（由补丁覆盖），其余正常加载
fs.readdirSync(bundledPluginsDir).forEach((file: string) => {
    if (file.endsWith('.js') && !patchedNames.has(file)) {
        require(path.join(bundledPluginsDir, file));
    }
});

function initInjector(): void {
    // 由于 contextIsolation: false，在DOM ready时暴露到window对象
    if (typeof window !== 'undefined') {
        window.log = preloadLogger;
        window.logger = preloadLogger;
    }
    
    if (document.readyState !== 'loading') {
        runHooks(HookType.OnReady);
    } else {
        document.addEventListener('DOMContentLoaded', () => {
            runHooks(HookType.OnReady);
            const observer = new MutationObserver(() => runHooks(HookType.OnDomChange));
            observer.observe(document.body, { childList: true, subtree: true });
        });
    }
}

initInjector();
