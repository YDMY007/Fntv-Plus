/**
 * [lc-patchfix] 主进程热补丁 require 解析修正垫片。
 *
 * 问题：主进程热补丁文件落在 userData/patches/main/... ，其 require 解析时 Node 不以 asar 为上下文，
 * 找不到 axios 等裸模块、相对 ../modules/* 也错位，导致依赖它们的 main 补丁（如 media.js）全部加载失败。
 *
 * 本垫片在 init 时安装一个「永久」的 Module._resolveFilename 修正：将被补文件的 require 重定向到 asar 中
 * 同名文件的原始路径作为解析上下文，使裸模块与相对 require 都能正确解析。
 *
 * 说明：该修正本应存在于 base 的 handlers/index.js 加载器中（已在 [lc-474] 修复）。此垫片用于让「旧 base +
 * 测试补丁」无需重装即可生效；新版 base 内置修复后，本垫片冗余但无害。
 */
import * as path from 'path';

export function init(): void {
    try {
        const Module = require('module');
        const _origResolve = Module._resolveFilename;
        const pluginPatchDir = __dirname; // .../patches/main/handlers/plugins
        const patchMainRoot = path.dirname(path.dirname(pluginPatchDir)); // .../patches/main
        // 打包版 asar 主目录：resources/app.asar/dest/main
        const resourcesPath = (process as any).resourcesPath as string;
        const asarMainRoot = resourcesPath
            ? path.join(resourcesPath, 'app.asar', 'dest', 'main')
            : path.join(path.dirname(path.dirname(pluginPatchDir)), 'dest', 'main');

        Module._resolveFilename = function (request: string, parent: any, ...rest: any[]): string {
            if (parent && typeof parent.filename === 'string' && parent.filename.startsWith(pluginPatchDir)) {
                const relPath = parent.filename.slice(patchMainRoot.length).replace(/^[\\/]/, '');
                const asarOriginal = path.join(asarMainRoot, relPath);
                const stubParent = { filename: asarOriginal, id: asarOriginal, paths: [] };
                try {
                    return _origResolve.call(this, request, stubParent as any, ...rest);
                } catch {
                    // 原上下文也缺失该依赖，回退默认解析（保留原始错误）
                }
            }
            return _origResolve.call(this, request, parent, ...rest);
        };
        // eslint-disable-next-line no-console
        console.log('[patchfix] 已安装主进程热补丁 require 解析修正（兼容旧 base）');
    } catch (e: any) {
        // eslint-disable-next-line no-console
        console.warn('[patchfix] 安装解析修正失败:', e?.message || e);
    }
}
