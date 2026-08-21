/**
 * [lc-653][fix lc-658] 主进程「文件级覆盖层」钩子。
 *
 * 背景：原有热补丁只覆盖 preload/plugins 与 main/handlers/plugins 两类「插件文件」，
 * 无法覆盖 modules/（如 logger）与 bin/（如 Go 代理可执行文件）——这两类只能靠全量包。
 * 本模块在主进程启动早期安装通用的 Module._resolveFilename 拦截：
 *   - 任何模块（含非插件，如 modules/logger）require 时，若 userData/patches 下有同名覆盖文件，
 *     则解析到覆盖文件，使 modules/ 模块代码也可通过热补丁更新；
 *   - bin/ 覆盖层由 proxy.ts 的 getProxyExecPath 单独读取（见该文件）。
 *
 * ⚠️ 时序要求（关键）：
 *   1. 本模块必须在【任何目标模块被 require 之前】加载并完成安装。由于 ES import 静态提升，
 *      main.ts 中必须把 `import './patchOverlay'` 放在第一行，且本模块在【模块顶层】立即执行
 *      install（而非导出函数等调用），否则 logger 等模块会先于钩子被加载，覆盖将不生效。
 *   2. [lc-658 修复] patchesDir 必须【惰性实时获取】，不能缓存在模块顶层：
 *      main.ts 第一行执行本模块时，config.ts 的 app.setPath('userData', DEV_USER_DATA) 尚未执行，
 *      此刻 app.getPath('userData') 仍返回生产路径(%APPDATA%/fntv) → 若缓存下来，dev 版会错误地
 *      加载生产版(打包版)的旧补丁覆盖层，导致 plugins 全部加载失败(No handler registered)。
 *      改为每次拦截时实时读取，此时 config.ts 已切好 userData(dev=.fntv-dev / prod=默认)。
 *   3. [lc-658 修复] 被覆盖的补丁文件 require 裸模块(如 axios)时，需像 handlers/index.ts 的
 *      requireMainPatch 一样做 asar 上下文回退：把补丁文件的 require 解析到 asar 内同名文件位置，
 *      使裸模块沿 asar 的 node_modules 解析成功；否则补丁文件(位于 patches 目录，无 node_modules)
 *      require('axios') 会抛 Cannot find module → 插件全灭。
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

        Module._resolveFilename = function (request: string, parent: any, ...rest: any[]): string {
            // [lc-658] 惰性实时获取 patchesDir（config.ts 的 userData 切换已生效）
            const patchesDir = process.env.FNTV_PATCHES_DIR
                || path.join(app.getPath('userData'), 'patches');

            // 先走原始解析拿到真实路径，再判断是否命中覆盖层
            let resolved: string;
            try {
                resolved = origResolve.call(this, request, parent, ...rest);
            } catch (e) {
                // 原始解析失败：若调用方是补丁文件(位于 patches 下)，按 asar 原始上下文重试，
                // 使裸模块(axios 等)沿 asar 的 node_modules 解析成功（与 handlers/index.ts 一致）。
                if (parent && typeof parent.filename === 'string' && parent.filename.startsWith(patchesDir)) {
                    try {
                        const stubParent = {
                            filename: parent.filename.replace(patchesDir, destRoot),
                            id: parent.filename.replace(patchesDir, destRoot),
                            paths: [],
                        };
                        return origResolve.call(this, request, stubParent as any, ...rest);
                    } catch { /* 保留原始错误 */ }
                }
                throw e;
            }
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
