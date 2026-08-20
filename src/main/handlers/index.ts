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

    // [lc-474][fix] 主进程热补丁文件位于 userData/patches，无 node_modules 与相对依赖上下文，
    // 导致其内部 require 无法解析裸模块(axios 等)与正确相对的 ../modules/*.
    // 做法：当请求来自「被补文件」时，把该文件在 asar 中的原始同名路径作为解析上下文(parent)，
    // 这样裸模块会沿 asar 的 node_modules 向上找到 axios，相对 require 也按原文件位置解析。
    // 此前仅对「相对 require」做了回退，裸模块名被漏掉，导致 media.js 等依赖 axios 的 main 补丁全部加载失败。
    const Module = require('module');
    const _origResolve = Module._resolveFilename;
    // patchesDir/main 与 app.asar/dest/main 互为镜像，被补文件相对 main 的路径一致，便于映射回 asar 原始位置
    const patchMainRoot = mainPatchDir ? path.dirname(path.dirname(mainPatchDir)) : ''; // .../patches/main
    const asarMainRoot = path.dirname(path.dirname(bundledDir)); // .../dest/main
    function requireMainPatch(file: string): Plugin {
        Module._resolveFilename = function (request: string, parent: any, ...rest: any[]): string {
            if (mainPatchDir && patchMainRoot && parent && typeof parent.filename === 'string'
                && parent.filename.startsWith(mainPatchDir)) {
                // 还原该补丁文件在 asar 中的原始路径，作为 require 解析起点（文件不必真实存在，仅取其目录用于解析）
                const relPath = parent.filename.slice(patchMainRoot.length).replace(/^[\\/]/, '');
                const asarOriginal = path.join(asarMainRoot, relPath);
                const stubParent = {
                    filename: asarOriginal,
                    id: asarOriginal,
                    paths: [],
                };
                try {
                    return _origResolve.call(this, request, stubParent as any, ...rest);
                } catch {
                    // 原上下文也缺失该依赖，回退到默认 parent 解析（保留原始错误）
                }
            }
            return _origResolve.call(this, request, parent, ...rest);
        };
        try {
            return require(path.join(mainPatchDir, (file))) as Plugin;
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
