/**
 * [lc-patchfix] 主进程热补丁 require 兜底（原型级，兼容旧 base）。
 *
 * 背景：主进程热补丁文件落在 userData/patches/main/... ，其 require 不以 asar 为上下文，
 * 找不到 axios 等裸模块、相对 ../modules/* 也会错位，导致依赖它们的 main 补丁（如 media.js）全部加载失败。
 *
 * 此前本垫片试图安装「永久」的 Module._resolveFilename 修正，但基础版加载器在每次加载插件后
 * (requireMainPatch 的 finally) 会把 _resolveFilename 复位回原始值，导致垫片当场被冲掉、形同虚设。
 *
 * 本实现改为拦截 Module.prototype.require（原型级，不会被加载器复位影响）：
 *   - 仅当调用方是「补丁文件」(filename 位于 patch 目录) 时生效；
 *   - 裸模块(request 不以 . 开头)：重定向到 base 的 dest/node_modules 解析；
 *   - 相对 require：先按补丁目录解析（兄弟文件），失败再按 asar 原始上下文解析（跨目录如 ../../../modules）。
 *
 * 说明：新版 base(lc-648) 的加载器已自带正确解析，本垫片在那时是冗余但无害的安全网；
 * 对于尚未更新到 lc-648 的旧基础版，本垫片可让其直接通过热补丁修复 main 进程问题，无需重编译。
 */
import * as path from 'path';

export function init(): void {
    try {
        const Module: any = require('module');
        const OrigRequire: (req: string) => any = Module.prototype.require;
        const electron = require('electron');
        const appPath: string =
            (electron && electron.app && typeof electron.app.getAppPath === 'function'
                ? electron.app.getAppPath()
                : '') || '';
        const pluginPatchDir = __dirname; // .../patches/main/handlers/plugins
        const patchMainRoot = path.dirname(path.dirname(pluginPatchDir)); // .../patches/main
        const destNodeModules = appPath ? path.join(appPath, 'dest', 'node_modules') : '';
        const asarMainRoot = appPath ? path.join(appPath, 'dest', 'main') : '';

        Module.prototype.require = function (this: any, request: string): any {
            const parentFile: string | undefined = this && this.filename;
            if (parentFile && parentFile.startsWith(patchMainRoot) && typeof request === 'string') {
                if (!request.startsWith('.')) {
                    // 裸模块：补丁目录无 node_modules，重定向到 base 的 dest/node_modules
                    if (destNodeModules) {
                        const candidate = path.join(destNodeModules, request);
                        try {
                            return OrigRequire.call(this, candidate);
                        } catch {
                            /* 回退到默认解析（保留原始错误） */
                        }
                    }
                } else {
                    // 相对 require：先按补丁目录解析（兄弟文件），失败再按 asar 原始上下文（跨目录如 ../../../modules）
                    try {
                        return OrigRequire.call(this, request);
                    } catch {
                        if (asarMainRoot) {
                            try {
                                const relPath = parentFile.slice(patchMainRoot.length).replace(/^[\\/]/, '');
                                const asarOriginal = path.join(asarMainRoot, relPath);
                                const resolved = path.resolve(path.dirname(asarOriginal), request);
                                return OrigRequire.call(this, resolved);
                            } catch {
                                /* 回退到默认解析（保留原始错误） */
                            }
                        }
                    }
                }
            }
            return OrigRequire.call(this, request);
        };
        // eslint-disable-next-line no-console
        console.log('[patchfix] 已安装主进程热补丁 require 兜底（兼容旧 base，原型级）');
    } catch (e: any) {
        // eslint-disable-next-line no-console
        console.warn('[patchfix] 安装 require 兜底失败:', e?.message || e);
    }
}
