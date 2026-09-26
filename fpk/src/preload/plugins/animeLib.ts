// preload/plugins/animeLib.ts
// [lc-462] 本地部署的 anime.js (v4.5.0) 注入器：在飞牛页面(window)挂上全局 window.anime，
// 供本项目(hotUpdates / embyWall 等)及其它插件使用 CSS/JS 动画引擎替代纯 CSS transition。
//
// 预加载机已在 index.ts 自动 require 本目录下所有 .js，无需手动 import。
// 注意「模块级代码铁律」：本文件除 import 与 registerHook 外不含任何模块级副作用代码，
// registerHook 必须最先执行，确保 handle() 一定注册（避免 preload 抛错导致注入失败）。
import * as fs from 'fs';
import * as path from 'path';
import { registerHook } from '../core/hooks';
import { HookType } from '../core/hooks';
import logger from '../core/logger';

// 相对 third_party 的路径（与现有 third_party/proxy 等一致）
const ANIME_REL = path.join('third_party', 'anime', 'anime.min.js');

// 跨「开发态 / 打包态」解析 anime.min.js 真实路径。
// 开发态：__dirname = dest/preload/plugins，上三级回到项目根，third_party 在根目录下。
// 打包态：third_party 由 electron-builder extraFiles 复制到 asar 之外（resources 目录 / exe 同级 / macOS Contents），
//          依次尝试这些候选，取第一个存在者。
function resolveAnimePath(): string | null {
  const cands: string[] = [
    path.resolve(__dirname, '..', '..', '..', ANIME_REL),                       // dev: 项目根/third_party
    process.resourcesPath ? path.join(process.resourcesPath, ANIME_REL) : '',   // 打包: resources 目录
    path.dirname(process.execPath) ? path.join(path.dirname(process.execPath), ANIME_REL) : '', // 打包: exe 同级
    // macOS: extraFiles 落在 Contents 目录（execPath 为 .../Contents/MacOS/Fntv-Plus）
    (process.platform === 'darwin' && process.execPath)
      ? path.join(process.execPath, '..', '..', ANIME_REL) : '',
  ].filter(Boolean);
  for (const p of cands) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

registerHook(HookType.OnReady, (): void => {
  try {
    if ((window as any).__fntvAnimeLoaded) return;
    const loc = window.location;
    // 登录页(file://) 与外部页跳过；仅在飞牛主界面注入
    if (!loc || loc.protocol === 'file:') return;
    const file = resolveAnimePath();
    if (!file) {
      logger.warn('[animeLib] 未找到 third_party/anime/anime.min.js，跳过注入（动画降级为 CSS）');
      return;
    }
    const code = fs.readFileSync(file, 'utf-8');
    const s = document.createElement('script');
    s.type = 'text/javascript';
    s.textContent = code; // 内联注入：无论 web 安全策略都能执行，且同步生效
    (document.head || document.documentElement).appendChild(s);
    (window as any).__fntvAnimeLoaded = true;
    logger.info('[animeLib] anime.js 已注入, window.anime 可用 (大小 ' + code.length + ' 字节)');
  } catch (e: any) {
    logger.warn('[animeLib] 注入 anime.js 失败: ' + (e && e.message));
  }
});
