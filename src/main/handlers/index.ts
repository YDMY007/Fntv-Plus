import * as fs from 'fs';
import * as path from 'path';
import { getInstance as getInterceptor } from './core/interceptor';
import { initAppHooks } from './core/appHook';
import * as log from '../../modules/logger';

/**
 * 处理器管理器主入口
 * 自动加载所有插件并初始化应用钩子
 */

interface Plugin {
    init?: () => void;
}

// 自动加载所有插件（含 [lc-474] 热补丁覆盖）
function loadPlugins(): void {
    const bundledDir = path.join(__dirname, 'plugins');
    const patchesDir = process.env.FNTV_PATCHES_DIR || '';
    const mainPatchDir = patchesDir ? path.join(patchesDir, 'main', 'handlers', 'plugins') : '';

    // [lc-474] 主进程热补丁文件的同级 require 回退到原 bundled 目录（仅需覆盖被修文件）
    const Module = require('module');
    const _origResolve = Module._resolveFilename;
    function requireMainPatch(file: string): Plugin {
        Module._resolveFilename = function (request: string, parent: any, ...rest: any[]): string {
            try {
                return _origResolve.call(this, request, parent, ...rest);
            } catch (e) {
                if (mainPatchDir && parent && typeof parent.filename === 'string'
                    && parent.filename.startsWith(mainPatchDir)
                    && typeof request === 'string' && request.startsWith('.')) {
                    // [fix] 同 preload/index.ts：用 stub-parent 走 _origResolve 自动补扩展名，
                    //   旧 path.resolve + fs.existsSync(无扩展名) 必为 false，导致 main/* 补丁依赖回退失效。
                    const stubParent = {
                        filename: path.join(bundledDir, '_patch_stub_.js'),
                        id: path.join(bundledDir, '_patch_stub_.js'),
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
            return require(path.join(mainPatchDir, file)) as Plugin;
        } finally {
            Module._resolveFilename = _origResolve;
        }
    }

    const patched = new Set<string>();
    if (mainPatchDir && fs.existsSync(mainPatchDir)) {
        fs.readdirSync(mainPatchDir).forEach((file: string) => {
            if (file.endsWith('.js')) {
                try {
                    const plugin = requireMainPatch(file);
                    if (typeof plugin.init === 'function') {
                        log.info(`正在初始化热补丁插件: ${file}`);
                        plugin.init();
                    }
                    patched.add(file);
                } catch (error) {
                    log.error(`加载热补丁插件 ${file} 失败:`, error);
                }
            }
        });
        if (patched.size) log.info(`[patch] 已应用主进程热补丁 ${patched.size} 个`);
    }

    try {
        const files = fs.readdirSync(bundledDir);
        files.forEach((file: string) => {
            if (file.endsWith('.js') && !patched.has(file)) { // 被热补丁覆盖的跳过
                try {
                    const plugin: Plugin = require(path.join(bundledDir, file));

                    // 直接调用 init 函数
                    if (typeof plugin.init === 'function') {
                        log.info(`正在初始化插件: ${file}`);
                        plugin.init();
                    } else {
                        log.warn(`插件 ${file} 没有导出 init 函数`);
                    }
                } catch (error) {
                    log.error(`加载插件 ${file} 失败:`, error);
                }
            }
        });
    } catch (error) {
        log.error('加载插件目录失败:', error);
    }
}

/**
 * 注册所有插件
 */
function registerAllPlugins(): void {
    const interceptor = getInterceptor();
    interceptor.init('persist:fntv');
    // 加载所有插件
    loadPlugins();

    // 初始化 session 拦截器
    interceptor.run();
    
    // 初始化应用钩子
    initAppHooks();
}

export {
    registerAllPlugins,
};
