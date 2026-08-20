/**
 * [lc-653] 主进程「文件级覆盖层」钩子。
 *
 * 背景：原有热补丁只覆盖 preload/plugins 与 main/handlers/plugins 两类「插件文件」，
 * 无法覆盖 modules/（如 logger）与 bin/（如 Go 代理可执行文件）——这两类只能靠全量包。
 * 本模块在主进程启动早期安装通用的 Module._resolveFilename 拦截：
 *   - 任何模块（含非插件，如 modules/logger）require 时，若 userData/patches 下有同名覆盖文件，
 *     则解析到覆盖文件，使 modules/ 模块代码也可通过热补丁更新；
 *   - bin/ 覆盖层由 proxy.ts 的 getProxyExecPath 单独读取（见该文件）。
 *
 * ⚠️ 时序要求（关键）：本模块必须在【任何目标模块被 require 之前】加载并完成安装。
 * 由于 ES import 静态提升，main.ts 中必须把 `import './patchOverlay'` 放在第一行，
 * 且本模块在【模块顶层】立即执行 install（而非导出函数等调用），
 * 否则 logger 等模块会先于钩子被加载，覆盖将不生效。
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

function install(): void {
    try {
        const Module: any = require('module');
        const origResolve = Module._resolveFilename;
        const appPath = app.getAppPath();
        // 打包: app.asar/dest；dev: <repo>/dest
        const destRoot = path.join(appPath, 'dest');
        // 补丁覆盖根（与 patchApplier.getPatchesDir 一致：默认 userData/patches）
        const patchesDir = process.env.FNTV_PATCHES_DIR
            || path.join(app.getPath('userData'), 'patches');
        if (!fs.existsSync(patchesDir)) { return; }

        Module._resolveFilename = function (request: string, parent: any, ...rest: any[]): string {
            // 先走原始解析拿到真实路径，再判断是否命中覆盖层
            const resolved = origResolve.call(this, request, parent, ...rest);
            try {
                if (typeof resolved === 'string' && resolved.startsWith(destRoot + path.sep)) {
                    const rel = resolved.slice(destRoot.length + 1).replace(/\\/g, '/');
                    const patched = path.join(patchesDir, rel);
                    if (fs.existsSync(patched)) {
                        return patched;
                    }
                }
            } catch { /* 覆盖失败不阻断正常 require */ }
            return resolved;
        };
        // eslint-disable-next-line no-console
        console.log('[patchOverlay] 已安装文件级覆盖钩子（支持 modules/ 与 bin/ 热补丁）');
    } catch (e: any) {
        // eslint-disable-next-line no-console
        console.warn('[patchOverlay] 安装覆盖钩子失败:', e?.message || e);
    }
}

// 模块顶层立即安装（见文件头时序说明）
install();
