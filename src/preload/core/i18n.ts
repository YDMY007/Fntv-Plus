// preload/core/i18n.ts
// [lc-1064] 轻量 i18n 框架（gettext 风格：中文原文即 key）。
//
// 设计取舍（用户群中文，i18n 为最低优先级 → 只做框架，不搞 key 改造）：
//  - t('中文原文') 直接以中文原文查目标语言词典，未收录时原样返回 —— zh 永不缺翻译，
//    任何调用点零风险接入（不 wrap 也是合法 zh 界面），存量文案可增量迁移；
//  - 动态数值用 {n} 具名占位插值，中英文语序各自独立；
//  - 语言：localStorage 'fntv-lang' 显式选择 > navigator.language 探测（en* → en，其余 zh）；
//    切换即写存储 + 派发 fntv:lang-changed，调用方（设置面板）随后整页刷新使全部已渲染文案生效
//    （与轮播样式切换同一「改完重载」机制，不做运行时 DOM 文本替换那套复杂回写）。
//  - 仅影响 Fntv-Plus 注入的界面文案；fnOS 原生 UI 与主进程文案不在渲染进程职责内。

export type Lang = 'zh' | 'en';

const LS_KEY = 'fntv-lang';
const LANG_EVENT = 'fntv:lang-changed';

// en 词典：仅收录已接入 t() 的界面文案（lc-1064：自动连播卡 / 跳过前情 / 播放方式弹窗 /
// 手柄提示 / 设置面板语言行 / a11y aria 标签）。新增接入面时在此补条目即可。
const EN: Record<string, string> = {
    // 自动连播卡（autoplayNext.ts）
    'UP NEXT': 'UP NEXT',
    '即将自动播放': 'Playing next soon',
    '本集剩余 {n}s · 即将自动播放下一集': 'Episode ends in {n}s · Next up soon',
    '{n} 秒后自动播放下一集': 'Auto-playing next in {n}s',
    '下一集': 'Next episode',
    '立即播放': 'Play now',
    '取消': 'Cancel',
    '关闭自动连播': 'Turn off autoplay',
    // 跳过前情（skipInject.ts）
    '跳过前情 ▸': 'Skip recap ▸',
    // 播放方式弹窗（playChoice.ts）
    '选择播放方式': 'Choose how to play',
    '原生播放': 'Native player',
    'MPV播放': 'Play with MPV',
    // 手柄提示（gamepadFocus.ts）
    '手柄导航：摇杆/方向键移动 · A 确认 · B 返回': 'Gamepad: stick/d-pad to move · A to select · B to go back',
    // 设置面板语言行（embyWall.ts，提示语双语内联，此处供 en 场景保持一致）
    '切换后自动刷新页面生效（仅影响 Fntv-Plus 注入的界面文案）': 'Reloads the page to apply (affects Fntv-Plus UI text only)',
    // a11y aria 标签（a11y.ts / embyWall.ts 关闭钮）
    '最小化': 'Minimize',
    '最大化': 'Maximize',
    '关闭': 'Close',
    '关闭设置': 'Close settings',
};

let cachedLang: Lang | null = null;

/** 当前语言：localStorage 显式选择 > navigator.language 探测（en* → en，其余 zh）。 */
export function getLang(): Lang {
    if (cachedLang) return cachedLang;
    try {
        const v = localStorage.getItem(LS_KEY);
        if (v === 'zh' || v === 'en') {
            cachedLang = v;
            return cachedLang;
        }
    } catch { /* 隐私模式等 localStorage 不可用，走探测 */ }
    try {
        cachedLang = /^en/i.test(navigator.language || '') ? 'en' : 'zh';
    } catch {
        cachedLang = 'zh';
    }
    return cachedLang;
}

/** 切换语言：写存储 + 派发事件；已渲染文案由调用方整页刷新生效。 */
export function setLang(lang: Lang): void {
    cachedLang = lang;
    try { localStorage.setItem(LS_KEY, lang); } catch { /* ignore */ }
    try { window.dispatchEvent(new CustomEvent(LANG_EVENT, { detail: lang })); } catch { /* ignore */ }
}

/** {n} 具名占位插值；参数缺失保留占位符原样（便于发现漏传）。 */
function interpolate(tpl: string, params?: Record<string, string | number>): string {
    if (!params) return tpl;
    return tpl.replace(/\{(\w+)\}/g, (m, k: string) =>
        Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m);
}

/** 翻译：以中文原文为 key 查目标语言词典；未收录回退原文（zh 界面永不劣化）。 */
export function t(zh: string, params?: Record<string, string | number>): string {
    const out = getLang() === 'en' ? (EN[zh] ?? zh) : zh;
    return interpolate(out, params);
}

/** 语言变化事件名（供订阅方解耦引用）。 */
export const LANG_CHANGED = LANG_EVENT;
