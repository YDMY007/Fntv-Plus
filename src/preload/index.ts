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
                const bundled = require('path').resolve(bundledPluginsDir, request);
                if (fs.existsSync(bundled)) return bundled;
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
if (patchesDir && fs.existsSync(patchesDir)) {
    fs.readdirSync(patchesDir).forEach((file: string) => {
        if (file.endsWith('.js')) {
            try {
                requirePatch(path.join(patchesDir, file));
                patchedNames.add(file);
            } catch (err) {
                preloadLogger.error('[patch] 加载热补丁失败:', file, err);
            }
        }
    });
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
