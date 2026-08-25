// preload/plugins/watchHistory.ts
//
// [lc-???] 观看记录（Watch History）入口 + 面板
// =============================================================================
// 目标：把此前设计的「观看记录」功能接入软件。
//   1) 侧边栏入口：在 embyWall 创建的 #fnos-sidebar-actions 容器内（⚙设置 / 切换系统页面 /
//      软件反馈建议 所在的圆角卡片），用完全相同的按钮样式创建「观影记录」入口，
//      插入到「设置」(#fnos-settings-btn) 正下方。首页/影视等 fnOS 导航不受影响；
//      用 MutationObserver + keepAlive 兜底，应对 fnOS SPA（React）重渲染 / 抽屉重建丢失。
//   2) 点击打开一个 Fntv-Plus 自有的全屏面板（fixed / 最高 z-index / 毛玻璃遮罩），
//      渲染此前设计的 UI：观影活跃度 30 天柱状图 + 看过的剧海报墙（SVG 星评分）+ 详情浮层
//      （飞牛影视刮削数据 + 我的评分/评语 + 同步飞牛）。
//   3) 主题：检测 fnOS 当前深/浅色，面板同步切换（不另设切换按钮，跟随系统）。
//
// 数据策略（v1）：面板内置示例数据集（标注「示例」），保证 UI 完整可演示；「立即同步」
//   按钮已接真实 IPC `douban:get-watched-items`（主进程走 fnOS item/list 拉已观看，带 token），
//   作为首个真实数据接入点。后续把播放进度/分段/刮削元数据接入同一 loadWatchData() 即可。
//
// 接入方式：preload/index.ts 自动 require plugins 目录下所有 .js → 编译后即自动挂入。
//   模块顶层 registerHook(OnReady) 注册（遵循 preload 模块级铁律：注册须在可能抛错代码之前）。

import { registerHook, HookType } from '../core/hooks';
import { ipcRenderer } from 'electron';
import log from '../core/logger';
import { isFntvTvPage } from '../core/pageMode';

const LOG = '[WatchHistory]';
const ENTRY_ID = 'fntv-wh-entry';
const PANEL_ID = 'fntv-wh';

// ───────────────────────── 类型 ─────────────────────────
interface FnMeta {
    year: number;
    genres: string[];
    cast: string[];
    douban: number;
    overview: string;
}
interface ShowItem {
    guid?: string;      // 飞牛 item guid（用于拉取真实海报）
    name: string;
    type: string;
    last: string;
    prog: number;
    started?: boolean;  // 有观看痕迹但未看完（"在观看"标记；电影无精确百分比时 prog=0）
    art: string;        // 渐变兜底背景（无真实海报时显示）
    poster?: string;    // 真实竖版海报 URL（飞牛 item API data.posters，空/缺=用渐变兜底）
    lastPlayedAt?: number; // 真实"最近一次播放"时间戳(ms)；用于活跃度按天分桶（真实数据经 loadWatchData 填充，SAMPLE 由 sessions 解析兜底）
    totalRuntimeMs?: number; // 作品总时长(ms)：剧集=各集 runtime 之和，电影/单集=自身 runtime；用于替代"未记录时间"与详情页展示
    fn: FnMeta;
    myRating: number;
    myReview: string;
    sessions: [string, string][];
}

// ───────────────────────── 工具 ─────────────────────────
const grad = (a: string, b: string): string => `linear-gradient(145deg,${a},${b})`;
const $ = (id: string): HTMLElement | null => document.getElementById(id);

function detectLight(): boolean {
    try {
        // 策略①：fnOS 主题标记（最可靠）
        const html = document.documentElement;
        // Semi Design 暗色模式会给 <html> 加 semi-mode="dark" 或 class 含 dark
        if (html.getAttribute('semi-mode') === 'dark' || html.className.includes('dark')) return false;
        if (html.getAttribute('semi-mode') === 'light' || html.className.includes('light')) return true;

        // 策略②：fnOS 页面容器背景亮度
        const el = document.querySelector('.fnos-tv-page') || document.body;
        if (el) {
            const cs = getComputedStyle(el);
            const m = cs.backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            if (m) {
                const r = parseInt(m[1], 10) / 255, g = parseInt(m[2], 10) / 255, b = parseInt(m[3], 10) / 255;
                const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                if (lum > 0.5) return true;
                if (lum < 0.35) return false;
            }
        }

        // 策略③：<body> 或 <html> 背景色兜底
        for (const target of [document.body, document.documentElement]) {
            if (!target) continue;
            const cs = getComputedStyle(target);
            const bg = cs.backgroundColor;
            if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') continue;
            const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            if (m) {
                const r = parseInt(m[1], 10) / 255, g = parseInt(m[2], 10) / 255, b = parseInt(m[3], 10) / 255;
                return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 0.5;
            }
        }
    } catch { /* ignore */ }
    return false; // 默认暗色（fnOS TV 默认深色）
}

const STAR_PATH = 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z';
function starsSVG(r: number): string {
    let h = '';
    for (let i = 1; i <= 5; i++) h += `<svg viewBox="0 0 24 24" class="${i <= r ? '' : 'off'}"><path d="${STAR_PATH}"/></svg>`;
    return h;
}

// ───────────────────────── 示例数据 ─────────────────────────
// 标注：v1 为示例数据，真实数据后续由 loadWatchData() 接入 fnOS。
const SAMPLE: ShowItem[] = [
    { name: '沙丘 2', type: '电影', last: '3 天前', prog: 0.68, art: grad('#3a2a1a', '#120c08'),
      fn: { year: 2024, genres: ['科幻', '冒险'], cast: ['提莫西·查拉梅', '赞达亚'], douban: 8.0,
        overview: '保罗·厄崔迪联合契妮与弗雷曼人，踏上复仇与拯救宇宙之路，在沙漠星球的权谋与信仰间抉择。' },
      myRating: 4, myReview: '视效封神，沙丘美学拉满，中段节奏偏慢但收尾有力。',
      sessions: [['08-21 22:14', '01:02:11 / 01:46:00'], ['08-19 21:40', '00:38:00 / 01:46:00']] },
    { name: '繁花', type: '剧集', last: '5 天前', prog: 0.34, art: grad('#3a1a2a', '#140810'),
      fn: { year: 2023, genres: ['剧情', '年代'], cast: ['胡歌', '马伊琍', '唐嫣'], douban: 8.4,
        overview: '上世纪九十年代的上海，阿宝从街头小贩成长为商界巨擘，在时代浪潮与儿女情长中沉浮。' },
      myRating: 5, myReview: '沪语版味道绝了，王家卫的腔调扑面而来。',
      sessions: [['08-19 20:50', '00:14:20 / 00:45:00'], ['08-18 21:10', '00:00:00 / 00:45:00']] },
    { name: '周处除三害', type: '电影', last: '4 天前', prog: 0.91, art: grad('#1a2a3a', '#081018'),
      fn: { year: 2023, genres: ['动作', '犯罪'], cast: ['阮经天'], douban: 8.1,
        overview: '通缉犯陈桂林在生命尽头决定铲除排在自己之前的两名头号罪犯，完成一场血色救赎。' },
      myRating: 5, myReview: '爽。高潮戏段落堪称年度名场面。',
      sessions: [['08-20 23:30', '01:45:00 / 01:54:00']] },
    { name: '葬送的芙莉莲', type: '动漫', last: '上周', prog: 0.45, art: grad('#2a1a3a', '#100818'),
      fn: { year: 2023, genres: ['奇幻', '冒险'], cast: ['原菜乃羽', '小林亲弘'], douban: 9.0,
        overview: '人类魔法使与精灵战士芙莉莲踏上重温已故勇者足迹的旅程，追问生命与遗忘的意义。' },
      myRating: 4, myReview: '把"时间"讲得这么温柔的冒险番不多见。',
      sessions: [['08-14 19:00', '00:13:00 / 00:24:00']] },
    { name: '奥本海默', type: '电影', last: '上周', prog: 0.12, art: grad('#2a2a1a', '#101008'),
      fn: { year: 2023, genres: ['传记', '历史'], cast: ['基里安·墨菲'], douban: 8.8,
        overview: '原子弹之父奥本海默在荣耀与良知、政治与科学之间被撕扯的一生。' },
      myRating: 0, myReview: '',
      sessions: [['08-13 21:00', '00:14:00 / 03:00:00']] },
    { name: '流浪地球 2', type: '电影', last: '2 周前', prog: 1, art: grad('#10283a', '#04101c'),
      fn: { year: 2023, genres: ['科幻', '灾难'], cast: ['吴京', '刘德华', '李雪健'], douban: 8.3,
        overview: '太阳危机来临前，人类启动带着地球逃离的方舟计划，在分裂与团结间赌上文明存续。' },
      myRating: 5, myReview: '中国科幻的天花板，太空电梯那段值回票价。',
      sessions: [['08-08 20:00', '03:00:00 / 03:00:00']] },
    { name: '庆余年', type: '剧集', last: '2 周前', prog: 0.78, art: grad('#2a2410', '#100c04'),
      fn: { year: 2019, genres: ['古装', '权谋'], cast: ['张若昀', '李沁'], douban: 7.9,
        overview: '现代青年魂穿架空王朝，以才学与机变在波谲云诡的朝堂中走出自己的人生。' },
      myRating: 4, myReview: '轻松又带脑，二刷依旧上头。',
      sessions: [['08-07 21:30', '00:35:00 / 00:45:00']] },
    { name: '间谍过家家', type: '动漫', last: '3 周前', prog: 0.56, art: grad('#3a2010', '#140a04'),
      fn: { year: 2022, genres: ['搞笑', '日常'], cast: ['江口拓也', '种崎敦美'], douban: 9.0,
        overview: '间谍、杀手与读心超能力少女，为各自任务伪装成一家人，却意外收获真正的温暖。' },
      myRating: 5, myReview: '阿尼亚表情包本包，全家最萌。',
      sessions: [['08-01 18:00', '00:13:00 / 00:24:00']] },
    { name: '满江红', type: '电影', last: '上月', prog: 1, art: grad('#3a1010', '#140404'),
      fn: { year: 2023, genres: ['剧情', '悬疑'], cast: ['沈腾', '易烊千玺'], douban: 7.0,
        overview: '南宋绍兴年间，一场刺杀引爆层层阴谋，小兵与宰相在封闭宅院里上演生死博弈。' },
      myRating: 4, myReview: '反转密集，最后全军诵词那刻鸡皮疙瘩起来了。',
      sessions: [['07-20 19:00', '02:40:00 / 02:40:00']] },
];

// ───────────────────────── 侧边栏入口注入 ─────────────────────────
// 目标容器：embyWall.ts 的 injectSettingsUI() 创建的 #fnos-sidebar-actions（圆角卡片，
//   内含 #fnos-settings-btn / #fnos-switch-system-btn / #fnos-feedback-choice-btn）。
// 按钮样式与 embyWall 创建的按钮完全一致（同款圆角、毛玻璃、边框、阴影），确保视觉统一。

/** 同款按钮 CSS（抄自 embyWall.ts injectSettingsUI 内的 btn.style.cssText） */
const SIDEBAR_BTN_CSS =
    'box-sizing:border-box;width:100%;padding:10px 12px;border-radius:12px;cursor:pointer;'
    + 'background:var(--fnos-sidebar-btn-bg)!important;color:#fff;font-size:13px;font-weight:600;'
    + 'border:1px solid rgba(255,255,255,.28);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);'
    + 'box-shadow:0 4px 16px rgba(0,0,0,.18);text-align:center;';

function injectEntry(): boolean {
    if ($(ENTRY_ID)) return true; // 已存在，幂等

    // ① 找 embyWall 创建的侧栏按钮容器
    const ctrl = document.getElementById('fnos-sidebar-actions') as HTMLElement | null;
    if (!ctrl) return false;

    // ② 找「设置」按钮作为插入参考点（插在它后面 → 设置 → 观影记录 → 切换系统页面 …）
    const settingsBtn = document.getElementById('fnos-settings-btn') as HTMLElement | null;

    // ③ 创建「观影记录」按钮（同款样式）
    const btn = document.createElement('button');
    btn.id = ENTRY_ID;
    btn.type = 'button';
    btn.textContent = '🕐 观影记录';
    btn.style.cssText = SIDEBAR_BTN_CSS;
    btn.addEventListener('click', (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        openPanel();
        // [lc-705] 复刻飞牛原生类目按钮：点击后自动收起 fnOS 抽屉侧栏（观影记录面板挂在 body，不受影响）
        const closeSb = (window as any).fntvCloseSidebar;
        if (typeof closeSb === 'function') closeSb();
    });

    // ④ 插入：有设置按钮就插在它后面，否则 prepend 到容器顶部
    if (settingsBtn && settingsBtn.parentElement === ctrl) {
        ctrl.insertBefore(btn, settingsBtn.nextSibling);
    } else {
        ctrl.prepend(btn);
    }

    log.info(LOG, '侧边栏入口已注入到 #fnos-sidebar-actions（位于「设置」下方）');
    return true;
}

function startKeepAlive(): void {
    setInterval(() => {
        try { if (!$(ENTRY_ID)) injectEntry(); } catch { /* ignore */ }
    }, 3000);
}

// ───────────────────────── 面板 ─────────────────────────
let panelBuilt = false;
let _onFiltersClick: ((e: MouseEvent) => void) | null = null; // 筛选点击处理：每次打开面板重绑前先移除旧监听，杜绝重复绑定
let curData: ShowItem[] = SAMPLE.slice();
let curFilter = '全部';
let curIdx = 0;
let curRating = 0;

const WH_CSS = `
#${PANEL_ID}{position:fixed;inset:0;z-index:2147483640;display:none;overflow:hidden;
  font-family:-apple-system,"SF Pro Display","PingFang SC","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;color:var(--wh-text);
  background:#1c1c1e!important;background-color:#1c1c1e!important;
  backdrop-filter:none!important;-webkit-backdrop-filter:none!important}
#${PANEL_ID}.show{display:block}
#${PANEL_ID} *{box-sizing:border-box}
#${PANEL_ID}{--wh-accent:#2997ff;--wh-bg:#1c1c1e;--wh-surface:rgba(255,255,255,.06);
  --wh-surface2:rgba(255,255,255,.1);--wh-text:#f5f5f7;--wh-text2:#a1a1a6;--wh-text3:#6e6e73;
  --wh-line:rgba(255,255,255,.1);--wh-bar-empty:linear-gradient(180deg,#3a3a3e,#2a2a2e);
  --wh-track:rgba(255,255,255,.16);--wh-tip:#1c1c1e;--wh-detail:#161618;--wh-star-empty:#3a3a3e;
  --wh-card-bg:#1a1a1d;--wh-radius:18px}
#${PANEL_ID}.light{--wh-bg:#f5f5f7;--wh-surface:rgba(0,0,0,.04);--wh-surface2:rgba(0,0,0,.07);
  --wh-text:#1d1d1f;--wh-text2:#515154;--wh-text3:#86868b;--wh-line:rgba(0,0,0,.1);
  --wh-bar-empty:linear-gradient(180deg,#e3e3e8,#d2d2d7);--wh-track:rgba(0,0,0,.1);--wh-tip:#fff;
  --wh-detail:#fff;--wh-star-empty:#d2d2d7;--wh-card-bg:#e9e9ee}

#${PANEL_ID} .wh-main{position:absolute;inset:0;overflow-y:auto;padding:0 0 60px}
#${PANEL_ID} .wh-topbar{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;
  padding:26px 40px 8px}
#${PANEL_ID} .wh-title{font-size:38px;font-weight:700;letter-spacing:.3px;display:flex;align-items:center;gap:12px}
#${PANEL_ID} .wh-title::before{content:'';display:inline-block;width:10px;height:10px;border-radius:3px;
  background:linear-gradient(135deg,var(--wh-accent),#7b5bff);flex-shrink:0}
#${PANEL_ID} .wh-subtitle{font-size:13px;color:var(--wh-text2);margin-top:6px}
#${PANEL_ID} .wh-filters{display:flex;gap:9px;align-items:center}
#${PANEL_ID} .wh-pill{padding:8px 16px;border-radius:20px;font-size:13px;color:var(--wh-text2);
  background:var(--wh-surface);border:1px solid transparent;cursor:pointer;transition:.15s;white-space:nowrap}
#${PANEL_ID} .wh-pill:hover{background:var(--wh-surface2);color:var(--wh-text)}
#${PANEL_ID} .wh-pill.active{background:var(--wh-accent);color:#fff;font-weight:600}
#${PANEL_ID} .wh-close{position:relative;z-index:5;flex:none;cursor:pointer;padding:6px 8px;
  font-size:20px;line-height:1;color:var(--wh-text2);
  display:flex;align-items:center;justify-content:center;
  user-select:none;-webkit-user-select:none;pointer-events:auto;transition:color .15s}
#${PANEL_ID} .wh-close:hover{color:var(--wh-text)}
/* 立即同步按钮（原"已看完"筛选位）：强调蓝，点击即重拉飞牛数据 */
#${PANEL_ID} .wh-sync{padding:8px 16px;border-radius:20px;font-size:13px;font-weight:600;cursor:pointer;
  background:rgba(41,151,255,.12);border:1px solid var(--wh-accent);color:var(--wh-accent);white-space:nowrap;transition:.15s}
#${PANEL_ID} .wh-sync:hover{background:var(--wh-accent);color:#fff}
/* 骨架屏：拉取飞牛+TMDB 数据期间在海报墙占位，避免空白闪烁 */
#${PANEL_ID} .wh-skel{position:relative;flex:none;width:180px;height:270px;border-radius:var(--wh-radius);
  overflow:hidden;background:var(--wh-card-bg)}
#${PANEL_ID} .wh-skel::after{content:'';position:absolute;inset:0;
  background:linear-gradient(90deg,transparent 0%,rgba(255,255,255,.08) 50%,transparent 100%);
  transform:translateX(-100%);animation:wh-shimmer 1.2s infinite}
#${PANEL_ID}.light .wh-skel::after{background:linear-gradient(90deg,transparent 0%,rgba(0,0,0,.06) 50%,transparent 100%)}
@keyframes wh-shimmer{100%{transform:translateX(100%)}}

#${PANEL_ID} .wh-section{margin-top:30px;padding:0 40px}
#${PANEL_ID} .wh-section-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:16px}
#${PANEL_ID} .wh-section-title{font-size:22px;font-weight:600}
#${PANEL_ID} .wh-section-hint{font-size:12px;color:var(--wh-text3)}

#${PANEL_ID} .wh-chart-card{background:var(--wh-surface);border:1px solid var(--wh-line);
  border-radius:22px;padding:24px 26px 18px}
#${PANEL_ID} .wh-chart-top{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:18px}
#${PANEL_ID} .wh-chart-top .ct{font-size:16px;font-weight:600}
#${PANEL_ID} .wh-chart-top .cs{font-size:12px;color:var(--wh-text3)}
#${PANEL_ID} .wh-stat{display:flex;gap:26px}
#${PANEL_ID} .wh-stat b{font-size:22px;font-weight:700}
#${PANEL_ID} .wh-stat span{font-size:12px;color:var(--wh-text2);margin-left:3px}
#${PANEL_ID} .wh-chart-wrap{position:relative}
#${PANEL_ID} .wh-chart-bars{display:flex;align-items:flex-end;gap:5px;height:170px;padding-top:6px}
#${PANEL_ID} .wh-bar{flex:1;border-radius:6px 6px 2px 2px;background:var(--wh-bar-empty);
  min-height:4px;transition:.15s;cursor:pointer;position:relative}
#${PANEL_ID} .wh-bar.has{background:linear-gradient(180deg,var(--wh-accent),#1d5fa8)}
#${PANEL_ID} .wh-bar.today{background:linear-gradient(180deg,#7bbcff,#2997ff);box-shadow:0 0 14px rgba(41,151,255,.5)}
#${PANEL_ID} .wh-bar:hover{filter:brightness(1.2)}
#${PANEL_ID} .wh-chart-axis{display:flex;justify-content:space-between;margin-top:8px;font-size:11px;color:var(--wh-text3)}
#${PANEL_ID} .wh-chart-tip{position:absolute;transform:translate(-50%,-100%);background:var(--wh-tip);
  border:1px solid var(--wh-line);padding:7px 11px;border-radius:10px;font-size:12px;pointer-events:none;
  opacity:0;transition:.12s;white-space:nowrap;z-index:20}
#${PANEL_ID} .wh-chart-tip.show{opacity:1}
#${PANEL_ID} .wh-chart-tip b{color:var(--wh-accent)}

#${PANEL_ID} .wh-row{display:flex;gap:20px;overflow-x:auto;padding:14px 4px 24px;scrollbar-width:none}
#${PANEL_ID} .wh-row::-webkit-scrollbar{display:none}
/* 影视清单：已看完 / 在观看 双栏等宽拆分（各占一半空间） */
#${PANEL_ID} .wh-split{display:flex;gap:26px}
#${PANEL_ID} .wh-col{flex:1 1 0;min-width:0;display:flex;flex-direction:column}
#${PANEL_ID} .wh-col-head{display:flex;align-items:center;gap:10px;margin-bottom:14px;padding-left:4px}
#${PANEL_ID} .wh-col-title{font-size:18px;font-weight:700;display:flex;align-items:center;gap:8px}
#${PANEL_ID} .wh-col-title::before{content:'';width:8px;height:8px;border-radius:3px;flex:none}
#${PANEL_ID} .wh-col.done .wh-col-title::before{background:#34c759}
#${PANEL_ID} .wh-col.watching .wh-col-title::before{background:#ff9f0a}
#${PANEL_ID} .wh-col-count{font-size:12px;color:var(--wh-text3);background:var(--wh-surface);border:1px solid var(--wh-line);padding:2px 10px;border-radius:11px}
#${PANEL_ID} .wh-col-empty{min-height:270px;flex:1;display:flex;align-items:center;justify-content:center;
  color:var(--wh-text3);font-size:13px;text-align:center;background:var(--wh-surface);
  border:1px dashed var(--wh-line);border-radius:14px;margin:4px}
@media (max-width:900px){#${PANEL_ID} .wh-split{flex-direction:column}}
#${PANEL_ID} .wh-card{position:relative;flex:none;border-radius:var(--wh-radius);overflow:hidden;cursor:pointer;
  background:var(--wh-card-bg);transition:transform .22s cubic-bezier(.2,.8,.2,1),box-shadow .22s;outline:none}
#${PANEL_ID} .wh-card.poster{width:180px;height:270px}
#${PANEL_ID} .wh-card .art{position:absolute;inset:0}
#${PANEL_ID} .wh-card .scrim{position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.85) 6%,rgba(0,0,0,0) 50%)}
#${PANEL_ID} .wh-card .meta{position:absolute;left:13px;right:13px;bottom:11px}
#${PANEL_ID} .wh-card .name{font-size:15px;font-weight:600;line-height:1.25;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#${PANEL_ID} .wh-card .sub{font-size:12px;color:rgba(255,255,255,.75);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#${PANEL_ID} .wh-card .stars{display:flex;gap:2px;margin-top:6px}
#${PANEL_ID} .wh-card .stars svg{width:13px;height:13px;fill:#ffd60a}
#${PANEL_ID} .wh-card .stars svg.off{fill:var(--wh-star-empty)}
#${PANEL_ID} .wh-card .pbar{position:absolute;left:13px;right:13px;bottom:0;height:4px;border-radius:2px;background:rgba(255,255,255,.22)}
#${PANEL_ID} .wh-card .pfill{height:100%;border-radius:2px;background:var(--wh-accent)}
#${PANEL_ID} .wh-card .badge{position:absolute;top:10px;left:10px;font-size:11px;font-weight:600;padding:3px 8px;
  border-radius:8px;background:rgba(0,0,0,.55);backdrop-filter:blur(6px);color:#fff;border:1px solid rgba(255,255,255,.15)}
#${PANEL_ID} .wh-card .badge.watching{background:rgba(255,149,0,.22);border-color:rgba(255,149,0,.55);color:#ffb340}
#${PANEL_ID} .wh-card.focused{transform:scale(1.09);transform-origin:center bottom;
  box-shadow:0 0 0 3px var(--wh-accent),0 26px 50px rgba(0,0,0,.6),0 0 38px rgba(41,151,255,.35);z-index:3}

#${PANEL_ID} .wh-detail-overlay{position:absolute;inset:0;background:rgba(0,0,0,.65);backdrop-filter:blur(12px);
  display:none;align-items:center;justify-content:center;z-index:50}
#${PANEL_ID} .wh-detail-overlay.show{display:flex}
#${PANEL_ID} .wh-detail{width:1000px;max-width:94vw;height:82vh;max-height:82vh;overflow:hidden;
  background:#161618;border:1px solid var(--wh-line);border-radius:24px;
  display:grid;grid-template-columns:6fr 4fr;align-items:stretch;
  box-shadow:0 40px 100px rgba(0,0,0,.75),0 0 0 1px rgba(255,255,255,.06) inset}
#${PANEL_ID}.light .wh-detail{background:#fff}
#${PANEL_ID} .wh-detail .hero{position:relative;height:100%;background:#1a1a1c;
  border-radius:24px 0 0 24px;overflow:hidden}
/* 海报用 <img> + object-fit:cover：浏览器原生等比裁切，无拉伸、无黑边（优于 CSS background-size） */
#${PANEL_ID} .wh-detail .hero .poster{position:absolute;inset:0;
  width:100%;height:100%;object-fit:cover;object-position:center;display:block}
#${PANEL_ID} .wh-detail .hero .scrim{position:absolute;inset:0;
  background:linear-gradient(to top,#161618 0%,rgba(0,0,0,0) 55%);
  pointer-events:none}
#${PANEL_ID}.light .wh-detail .hero .scrim{background:linear-gradient(to top,#fff 0%,rgba(0,0,0,0) 55%)}
#${PANEL_ID} .wh-detail .body{padding:28px 32px;overflow-y:auto;height:100%;
  background:#161618}
#${PANEL_ID}.light .wh-detail .body{background:#fff}
#${PANEL_ID} .wh-detail .d-name{font-size:25px;font-weight:700;line-height:1.25}
#${PANEL_ID} .wh-detail .d-meta{font-size:13px;color:var(--wh-text2);margin-top:8px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
#${PANEL_ID} .wh-detail .fn-badge{font-size:11px;padding:3px 9px;border-radius:8px;background:rgba(41,151,255,.16);color:var(--wh-accent);border:1px solid rgba(41,151,255,.3)}
#${PANEL_ID} .wh-detail .chips{display:flex;gap:7px;flex-wrap:wrap;margin-top:12px}
#${PANEL_ID} .wh-detail .chip{font-size:12px;padding:4px 11px;border-radius:14px;background:var(--wh-surface2);color:var(--wh-text)}
#${PANEL_ID} .wh-detail .douban{margin-top:14px;font-size:14px;color:var(--wh-text2)}
#${PANEL_ID} .wh-detail .douban b{color:#ffcc00;font-size:18px;margin-right:4px}
#${PANEL_ID} .wh-detail .overview{margin-top:12px;font-size:13px;line-height:1.7;color:var(--wh-text2)}
#${PANEL_ID} .wh-detail .cast{margin-top:10px;font-size:12px;color:var(--wh-text3)}
#${PANEL_ID} .wh-divider{height:1px;background:var(--wh-line);margin:20px 0}
#${PANEL_ID} .wh-mylabel{font-size:13px;color:var(--wh-text3);margin-bottom:10px;display:flex;align-items:center;gap:8px}
#${PANEL_ID} .wh-rate{display:flex;gap:8px;cursor:pointer;user-select:none}
#${PANEL_ID} .wh-rate svg{width:34px;height:34px;fill:var(--wh-star-empty);
  transition:transform .12s ease,fill .12s ease;transform-origin:center;transform-box:fill-box}
#${PANEL_ID} .wh-rate svg.on{fill:url(#fntv-wh-gold)}
#${PANEL_ID} .wh-rate svg:hover{transform:scale(1.18)}
#${PANEL_ID} .wh-review{width:100%;margin-top:12px;background:var(--wh-surface);border:1px solid var(--wh-line);
  border-radius:14px;padding:12px 14px;color:var(--wh-text);font-size:13px;font-family:inherit;resize:vertical;min-height:80px;outline:none}
#${PANEL_ID} .wh-review:focus{border-color:var(--wh-accent)}
#${PANEL_ID} .wh-actions{display:flex;gap:10px;margin-top:14px}
#${PANEL_ID} .wh-btn{border:none;padding:11px 20px;border-radius:13px;font-size:14px;font-weight:600;cursor:pointer}
#${PANEL_ID} .wh-btn.primary{background:var(--wh-accent);color:#fff}
#${PANEL_ID} .wh-btn.ghost{background:var(--wh-surface2);color:var(--wh-text)}
#${PANEL_ID} .wh-sessions{margin-top:8px}
#${PANEL_ID} .wh-sessions h4{font-size:13px;color:var(--wh-text3);font-weight:500;margin-bottom:10px}
#${PANEL_ID} .wh-sess{display:flex;justify-content:space-between;font-size:13px;color:var(--wh-text2);
  padding:6px 0;border-bottom:1px solid var(--wh-line)}
#${PANEL_ID} .wh-sess .pos{color:var(--wh-text)}
#${PANEL_ID} .wh-toast{position:absolute;bottom:30px;left:50%;transform:translateX(-50%) translateY(20px);
  background:var(--wh-tip);border:1px solid var(--wh-line);padding:12px 22px;border-radius:14px;font-size:14px;
  opacity:0;transition:.25s;z-index:80}
#${PANEL_ID} .wh-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
#${PANEL_ID} .wh-sample{font-size:11px;color:var(--wh-text3);margin-top:8px}
`;

function buildPanel(): void {
    if (panelBuilt) return;
    const style = document.createElement('style');
    style.id = 'fntv-wh-style';
    style.textContent = WH_CSS;
    (document.head || document.documentElement).appendChild(style);

    const root = document.createElement('div');
    root.id = PANEL_ID;
    root.innerHTML = `
      <div class="wh-main">
        <div class="wh-topbar">
          <div>
            <div class="wh-title">Fntv-Plus · 观影记录</div>
            <div class="wh-subtitle" id="wh-sub"></div>
          </div>
          <div class="wh-filters">
            <div class="wh-pill active" data-f="全部">全部</div>
            <div class="wh-pill" data-f="电影">电影</div>
            <div class="wh-pill" data-f="剧集">剧集</div>
            <div class="wh-pill" data-f="动漫">动漫</div>
            <div class="wh-sync" id="wh-sync" title="立即从飞牛影视拉取最新观看数据">立即同步</div>
            <div class="wh-close" id="wh-close" title="关闭（Esc）">✕</div>
          </div>
        </div>

        <section class="wh-section">
          <div class="wh-section-head">
            <div class="wh-section-title">观影活跃度</div>
            <div class="wh-section-hint">近 30 天 · 有播放记录的天数</div>
          </div>
          <div class="wh-chart-card">
            <div class="wh-chart-top">
              <div>
                <div class="ct" id="wh-chart-ct"></div>
                <div class="cs" id="wh-chart-cs"></div>
              </div>
              <div class="wh-stat">
                <div><b id="wh-stat-days">0</b><span>天·近30天</span></div>
                <div><b id="wh-stat-month">0</b><span>部·本月</span></div>
                <div><b id="wh-stat-total">0</b><span>小时·累计时长</span></div>
                <div><b id="wh-stat-rate">0%</b><span>看完率</span></div>
              </div>
            </div>
            <div class="wh-chart-wrap" id="wh-chart-wrap">
              <div class="wh-chart-bars" id="wh-chart-bars"></div>
              <div class="wh-chart-axis" id="wh-chart-axis"></div>
              <div class="wh-chart-tip" id="wh-chart-tip"></div>
            </div>
          </div>
        </section>

        <section class="wh-section">
          <div class="wh-section-head">
            <div class="wh-section-title">影视清单</div>
            <div class="wh-section-hint">点击查看详情并评分</div>
          </div>
          <div class="wh-split">
            <div class="wh-col done">
              <div class="wh-col-head">
                <span class="wh-col-title">已看完</span>
                <span class="wh-col-count" id="wh-done-count">0</span>
              </div>
              <div class="wh-row" id="wh-row-done"></div>
            </div>
            <div class="wh-col watching">
              <div class="wh-col-head">
                <span class="wh-col-title">在观看</span>
                <span class="wh-col-count" id="wh-partial-count">0</span>
              </div>
              <div class="wh-row" id="wh-row-partial"></div>
            </div>
          </div>
          <div class="wh-sample">* 当前为示例数据；点击「立即同步」可拉取真实已观看记录</div>
        </section>
      </div>

      <div class="wh-detail-overlay" id="wh-detail">
        <div class="wh-detail">
          <div class="hero">
            <img class="poster" id="wh-d-poster" alt="" />
            <div class="scrim"></div>
          </div>
          <div class="body">
            <div class="d-name" id="wh-d-name"></div>
            <div class="d-meta">
              <span id="wh-d-year"></span>
              <span class="fn-badge">数据来自飞牛影视</span>
            </div>
            <div class="chips" id="wh-d-chips"></div>
            <div class="douban" id="wh-d-douban"></div>
            <div class="overview" id="wh-d-overview"></div>
            <div class="cast" id="wh-d-cast"></div>
            <div class="wh-divider"></div>
            <div class="wh-mylabel">我的评分</div>
            <div class="wh-rate" id="wh-d-rate">
              <svg class="star" data-v="1" viewBox="0 0 24 24"><path d="${STAR_PATH}"/></svg>
              <svg class="star" data-v="2" viewBox="0 0 24 24"><path d="${STAR_PATH}"/></svg>
              <svg class="star" data-v="3" viewBox="0 0 24 24"><path d="${STAR_PATH}"/></svg>
              <svg class="star" data-v="4" viewBox="0 0 24 24"><path d="${STAR_PATH}"/></svg>
              <svg class="star" data-v="5" viewBox="0 0 24 24"><path d="${STAR_PATH}"/></svg>
            </div>
            <div class="wh-mylabel" style="margin-top:16px">我的评语</div>
            <textarea class="wh-review" id="wh-d-review" placeholder="写下你对这部剧的看法…"></textarea>
            <div class="wh-actions">
              <button class="wh-btn primary" id="wh-d-save">保存我的评价</button>
              <button class="wh-btn ghost" id="wh-d-sync">立即同步</button>
            </div>
            <div class="wh-divider"></div>
            <div class="wh-sessions">
              <h4>播放记录</h4>
              <div id="wh-d-sessions"></div>
            </div>
          </div>
        </div>
      </div>

      <div class="wh-toast" id="wh-toast"></div>
      <svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
        <linearGradient id="fntv-wh-gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#ffe27a"/><stop offset="1" stop-color="#ffb300"/>
        </linearGradient>
      </defs></svg>
    `;
    document.body.appendChild(root);
    panelBuilt = true;

    // ── 玻璃豁免：整面板所有元素打 data-fntv-glass-exclude（与设置面板/顶栏同款排除机制）。
    //    Glass UI 规则 ② 命中 [class*="card"]（含 .wh-card / .wh-chart-card）并加亚克力，
    //    必须逐个打标记，否则透明亚克力会渗进面板。动态生成的卡片在 cardHTML 里也加了此属性。 ──
    root.setAttribute('data-fntv-glass-exclude', '');
    root.querySelectorAll('*').forEach((e) => e.setAttribute('data-fntv-glass-exclude', ''));

    // ── 背景不透明（与 dialogUI.ts 弹窗 / embyWall 设置面板同款：行内 !important + 具体色值，不用 var()）──
    //    Glass UI 规则①b: html[data-fntv-glass] .fnos-tv-page body > div { background:transparent!important }
    //    #fntv-wh 是 body > div → 被强制透明。行内 style !important（具体色值，非 var）优先级 > 样式表 !important，彻底封死。
    //    底色取 fnOS 标准深灰面板色 #1c1c1e（非纯黑），浅色模式在 openPanel 里切 #f5f5f7。
    root.style.setProperty('background', '#1c1c1e', 'important');
    root.style.setProperty('background-color', '#1c1c1e', 'important');
    root.style.setProperty('backdrop-filter', 'none', 'important');
    root.style.setProperty('-webkit-backdrop-filter', 'none', 'important');

    // ── 关闭：✕ 按钮（事件委托，避免绑定到失效节点导致偶发需点两次）+ 背景点击 + Esc（三路关闭）──
    const detailOverlay = root.querySelector('#wh-detail') as HTMLElement | null;
    if (detailOverlay) {
        detailOverlay.addEventListener('click', (e: MouseEvent) => {
            if ((e.target as HTMLElement).id === 'wh-detail') detailOverlay.classList.remove('show');
        });
    }
    // 点击面板主内容区背景（非交互元素）也可关闭
    root.addEventListener('click', (e: MouseEvent) => {
        const tgt = e.target as HTMLElement;
        // ✕ 关闭按钮：委托判定（命中 .wh-close 或其内部）即关，且不依赖具体元素引用，杜绝偶发需点两次
        if (tgt.closest('#wh-close')) { e.stopPropagation(); closePanel(); return; }
        // 只有点到 .wh-main 本身或其直接空白子元素才关（不误杀卡片/按钮点击）
        if (tgt === root || tgt.classList.contains('wh-main')) closePanel();
    });

    // 筛选 + 立即同步的事件委托改由 openPanel 调 bindFilters() 在「每次打开面板」时重新绑定
    // （见 bindFilters）。原因：fnOS 是 SPA，路由切换可能重建 .wh-filters 节点，若只在 buildPanel
    // 绑一次，旧监听会绑到失效节点 → 电影/剧集/动漫"点不动"。改为每次打开自愈式重绑，杜绝该问题。

    // 评分交互
    const rate = $('wh-d-rate') as HTMLElement;
    rate.querySelectorAll('.star').forEach((s) => {
        s.addEventListener('click', () => { curRating = parseInt((s as HTMLElement).dataset.v || '0', 10); renderStars(curRating); });
        s.addEventListener('mouseenter', () => renderStars(parseInt((s as HTMLElement).dataset.v || '0', 10)));
    });
    rate.addEventListener('mouseleave', () => renderStars(curRating));

    // 保存 / 同步
    ($('wh-d-save') as HTMLElement).addEventListener('click', () => {
        curData[curIdx].myRating = curRating;
        curData[curIdx].myReview = (($('wh-d-review') as HTMLTextAreaElement).value || '').trim();
        renderWall();
        toast('已保存你的评价');
    });
    ($('wh-d-sync') as HTMLElement).addEventListener('click', syncFnos);

    // 键盘：Esc 先关详情，再关面板（关面板统一走 closePanel，确保彻底复位）
    document.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key !== 'Escape') return;
        const detail = $('wh-detail');
        if (detail && detail.classList.contains('show')) { detail.classList.remove('show'); return; }
        if ($(PANEL_ID) && ($(PANEL_ID) as HTMLElement).classList.contains('show')) closePanel();
    });
}

function renderStars(r: number): void {
    const rate = $('wh-d-rate');
    if (!rate) return;
    rate.querySelectorAll('.star').forEach((s) => {
        const v = parseInt((s as HTMLElement).dataset.v || '0', 10);
        s.classList.toggle('on', v <= r);
    });
}

function filteredData(): ShowItem[] {
    if (curFilter === '全部') return curData;
    return curData.filter((i) => i.type === curFilter);
}

/** 每次打开面板时（重新）绑定筛选 + 立即同步的点击事件委托。
 *  重绑前先 removeEventListener 移除旧监听（同一函数引用，幂等 → 整生命周期「恰好一个」），
 *  且绑定到「当前存活」的 .wh-filters 节点——彻底免疫 fnOS 路由切换导致的 DOM 重建 /
 *  旧节点监听失效（电影/剧集/动漫"点不动"的根因）。 */
function bindFilters(root: HTMLElement): void {
    const filtersEl = root.querySelector('.wh-filters') as HTMLElement | null;
    if (!filtersEl) return;
    if (_onFiltersClick) filtersEl.removeEventListener('click', _onFiltersClick);
    _onFiltersClick = (e: MouseEvent) => {
        const tgt = e.target as HTMLElement;
        // 立即同步按钮：立刻重拉飞牛观看数据（含 TMDB 标签）
        if (tgt.closest('#wh-sync')) { syncFnos(); return; }
        const pill = tgt.closest('.wh-pill') as HTMLElement | null;
        if (!pill) return;
        root.querySelectorAll('.wh-pill').forEach((x) => x.classList.remove('active'));
        pill.classList.add('active');
        curFilter = (pill as HTMLElement).dataset.f || '全部';
        renderWall();
    };
    filtersEl.addEventListener('click', _onFiltersClick);
}

// mode: 'done' = 已看完列（干净无徽标，列头已说明状态）；'partial' = 在观看列（有进度则显示进度条，无精确进度则显示"在观看"徽标）
function cardHTML(item: ShowItem, idx: number, mode: 'done' | 'partial'): string {
    const pct = Math.round(item.prog * 100);
    let sub: string;
    if (item.myRating) sub = `${item.type} · 我的评分 ${item.myRating}/5`;
    else if (item.last && item.last !== '未记录时间') sub = `${item.type} · ${item.last}`;
    else if (item.totalRuntimeMs) sub = `${item.type} · 总时长 ${fmtDur(item.totalRuntimeMs)}`;
    else sub = `${item.type} · 未记录时间`;
    // 状态徽标/进度条：已看完列不放（列头已说明）；在观看列用进度条或"在观看"徽标表达
    let bar = '';
    if (mode === 'partial') {
        bar = item.prog > 0
            ? `<div class="pbar"><div class="pfill" style="width:${pct}%"></div></div>`
            : `<div class="badge watching">在观看</div>`;
    }
    const stars = item.myRating ? `<div class="stars">${starsSVG(item.myRating)}</div>` : '';
    // 有真实海报用缩略图铺满；否则用按名称生成的渐变兜底（与首页轮播图缺图时的兜底同源）
    const artStyle = item.poster
        ? `background:${item.art};background-image:url('${item.poster}');background-size:cover;background-position:center;`
        : `background:${item.art};`;
    return `<div class="wh-card poster" data-fntv-glass-exclude="" data-idx="${idx}" data-name="${item.name}" data-sub="${sub}" data-prog="${item.prog}">
        <div class="art" style="${artStyle}"></div>
        <div class="scrim"></div>${bar}
        <div class="meta"><div class="name">${item.name}</div><div class="sub">${sub}</div>${stars}</div>
      </div>`;
}

function renderWall(): void {
    const doneRow = $('wh-row-done');
    const partialRow = $('wh-row-partial');
    if (!doneRow || !partialRow) return;
    const list = filteredData();
    // 按状态拆分：已看完(prog>=1) / 在观看(prog<1，含观看痕迹但未完结)
    const done = list.filter((i) => i.prog >= 1);
    const partial = list.filter((i) => i.prog < 1);
    doneRow.innerHTML = done.length
        ? done.map((i) => cardHTML(i, curData.indexOf(i), 'done')).join('')
        : '<div class="wh-col-empty">暂无已看完的作品</div>';
    partialRow.innerHTML = partial.length
        ? partial.map((i) => cardHTML(i, curData.indexOf(i), 'partial')).join('')
        : '<div class="wh-col-empty">暂无在观看的作品</div>';
    // 列头计数
    const dc = $('wh-done-count'); if (dc) dc.textContent = String(done.length);
    const pc = $('wh-partial-count'); if (pc) pc.textContent = String(partial.length);
    // 卡片点击 → 详情（用 curData 全局索引，与 openDetail 约定一致）
    [doneRow, partialRow].forEach((row) => {
        row.querySelectorAll('.wh-card').forEach((c) => {
            c.addEventListener('click', () => openDetail(parseInt((c as HTMLElement).dataset.idx || '0', 10)));
        });
    });
}

/** 数据加载占位：在双栏 #wh-row-done / #wh-row-partial 各填充若干骨架卡片，避免飞牛+TMDB 拉取期间海报墙空白闪烁。 */
function showSkeleton(n: number = 8): void {
    const doneRow = $('wh-row-done');
    const partialRow = $('wh-row-partial');
    let h = '';
    for (let i = 0; i < n; i++) h += '<div class="wh-skel"></div>';
    if (doneRow) doneRow.innerHTML = h;
    if (partialRow) partialRow.innerHTML = h;
}

/** 真实分类计数：把 全部/电影/剧集/动漫 各 pill 文案改写为「名称 (数量)」，
 *  让筛选按钮"做成真实的"——既点得动、也能一眼看出每类到底有几部（0 部时点击后墙为空也说得通）。 */
function updatePillCounts(): void {
    const root = $(PANEL_ID) as HTMLElement | null;
    if (!root) return;
    const counts: Record<string, number> = { '全部': curData.length, '电影': 0, '剧集': 0, '动漫': 0 };
    for (const it of curData) {
        if (it.type === '电影' || it.type === '剧集' || it.type === '动漫') counts[it.type]++;
    }
    root.querySelectorAll('.wh-pill').forEach((p) => {
        const f = (p as HTMLElement).dataset.f || '';
        if (counts[f] !== undefined) p.textContent = `${f} (${counts[f]})`;
    });
}

function renderChart(): void {
    const barsEl = $('wh-chart-bars');
    const axisEl = $('wh-chart-axis');
    const tip = $('wh-chart-tip');
    const wrap = $('wh-chart-wrap');
    if (!barsEl || !axisEl || !tip || !wrap) return;

    // 真实分桶：近 30 天，每天统计"当天有播放记录的作品数"（基于各作品最近一次播放日）
    const dayMs = 86400000;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const buckets = new Array(30).fill(0); // 索引 0=最旧(29天前) … 29=今天
    for (const it of curData) {
        const ts = lastPlayedTs(it);
        if (!ts) continue;
        const d = new Date(ts); d.setHours(0, 0, 0, 0);
        const diff = Math.round((today.getTime() - d.getTime()) / dayMs);
        if (diff >= 0 && diff < 30) buckets[29 - diff] += 1;
    }
    const activeDays = buckets.filter((c) => c > 0).length;
    const maxC = Math.max(1, ...buckets);

    barsEl.innerHTML = '';
    axisEl.innerHTML = '';
    buckets.forEach((c, i) => {
        const isToday = i === 29;
        const bar = document.createElement('div');
        bar.className = 'wh-bar' + (c > 0 ? ' has' : '') + (isToday ? ' today' : '');
        bar.style.height = Math.max(4, (c / maxC) * 100) + '%';
        const d = new Date(today.getTime() + (i - 29) * dayMs);
        const lbl = isToday ? '今天' : `${d.getMonth() + 1}/${d.getDate()}`;
        bar.addEventListener('mouseenter', (e: MouseEvent) => {
            const r = (e.target as HTMLElement).getBoundingClientRect();
            const wr = wrap.getBoundingClientRect();
            tip.innerHTML = c > 0 ? `${lbl} · <b>${c} 部作品</b>` : `${lbl} · 未观看`;
            tip.style.left = (r.left - wr.left + r.width / 2) + 'px';
            tip.style.top = (r.top - wr.top - 8) + 'px';
            tip.classList.add('show');
        });
        bar.addEventListener('mouseleave', () => tip.classList.remove('show'));
        barsEl.appendChild(bar);
        const ax = document.createElement('span');
        ax.textContent = (i % 5 === 0 || i === 29) ? lbl : '';
        axisEl.appendChild(ax);
    });

    // 顶部统计（真实可算指标）
    const total = curData.length;
    const done = curData.filter((i) => i.prog >= 1).length;
    const doneRate = total ? Math.round((done / total) * 100) : 0;
    const now = new Date();
    const monthCount = curData.filter((it) => {
        const ts = lastPlayedTs(it); if (!ts) return false;
        const d = new Date(ts);
        return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    }).length;

    const ct = $('wh-chart-ct'); const cs = $('wh-chart-cs');
    if (ct) ct.textContent = `近 30 天在 ${activeDays} 天里有过观看`;
    if (cs) cs.textContent = `共 ${total} 部 · 本月 ${monthCount} 部`;
    const totalMs = curData.reduce((s, i) => s + (i.totalRuntimeMs || 0), 0);
    const totalH = Math.round(totalMs / 3600000);
    const elDays = $('wh-stat-days'); if (elDays) elDays.textContent = String(activeDays);
    const elMonth = $('wh-stat-month'); if (elMonth) elMonth.textContent = String(monthCount);
    const elTotal = $('wh-stat-total'); if (elTotal) elTotal.textContent = String(totalH);
    const elRate = $('wh-stat-rate'); if (elRate) elRate.textContent = doneRate + '%';
}

function openDetail(idx: number): void {
    curIdx = idx;
    const it = curData[idx];
    const set = (id: string, v: string) => { const e = $(id); if (e) e.textContent = v; };
    const setH = (id: string, v: string) => { const e = $(id); if (e) e.innerHTML = v; };
    const poster = $('wh-d-poster') as HTMLImageElement | null;
    if (poster) {
        if (it.poster) {
            poster.src = it.poster;
            poster.style.display = 'block';
            poster.onerror = () => { poster.style.display = 'none'; }; // 图像加载失败→隐藏，露出 hero 渐变兜底
        } else {
            poster.src = '';
            poster.style.display = 'none'; // 无真实海报→隐藏，hero 背景渐变兜底
        }
    }
    set('wh-d-name', it.name);
    set('wh-d-year', `${it.fn.year} · ${it.type}${it.totalRuntimeMs ? ' · 总时长 ' + fmtDur(it.totalRuntimeMs) : ''}`);
    setH('wh-d-chips', it.fn.genres.map((g) => `<span class="chip">${g}</span>`).join(''));
    setH('wh-d-douban', `飞牛影视评分 <b>${it.fn.douban.toFixed(1)}</b> · 豆瓣`);
    set('wh-d-overview', it.fn.overview);
    set('wh-d-cast', '主演：' + it.fn.cast.join(' / '));
    curRating = it.myRating;
    renderStars(curRating);
    const rv = $('wh-d-review') as HTMLTextAreaElement | null;
    if (rv) rv.value = it.myReview || '';
    const sess = (it.sessions || []).map((s) => `<div class="wh-sess"><span>${s[0]}</span><span class="pos">${s[1]}</span></div>`).join('')
        || '<div class="wh-sess"><span>暂无分段记录</span></div>';
    setH('wh-d-sessions', sess);
    // 行内 !important 封死详情卡片底色（同 lc-686 铁律：具体色值 + !important，杜绝 Glass UI / 优先级覆盖导致右半边变透）
    const panelRoot = $(PANEL_ID) as HTMLElement | null;
    if (panelRoot) {
        const detailCard = panelRoot.querySelector('.wh-detail') as HTMLElement | null;
        if (detailCard) {
            const isLight = panelRoot.classList.contains('light');
            detailCard.style.setProperty('background', isLight ? '#fff' : '#161618', 'important');
            const body = detailCard.querySelector('.body') as HTMLElement | null;
            if (body) body.style.setProperty('background', isLight ? '#fff' : '#161618', 'important');
        }
    }
    ($('wh-detail') as HTMLElement).classList.add('show');
}

/** 预设渐变色盘（按名称 hash 稳定取色，避免每次随机） */
const ART_PALETTE = [
    '#3a2a1a,#120c08', '#3a1a2a,#140810', '#1a2a3a,#081018',
    '#2a1a3a,#100818', '#2a2a1a,#101008', '#10283a,#04101c',
    '#2a2410,#100c04', '#3a2010,#140a04', '#3a1010,#140404',
    '#1a2a2a,#080810', '#2a1a1a,#100808', '#102a2a,#04100c',
];
function artForName(name: string): string {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
    const idx = Math.abs(h) % ART_PALETTE.length;
    const [a, b] = ART_PALETTE[idx].split(',');
    return grad(a, b);
}

// ───────────────────────── 真实海报拉取（与首页轮播图同款机制）─────────────────────────
// 复用 embyWall.fetchItemDetail 的取图逻辑：经主进程生成 Authx 头 → GET /v/api/v1/item/${guid}
//   （credentials:'include'）→ 取 data.posters（竖版，选最大尺寸）→ 拼 base + '/v/api/v1/' + rel。
// 这样观看记录的竖版海报与首页轮播图来源完全一致（飞牛 item API 权威竖版源），不再用假渐变占位。
const _posterCache = new Map<string, string>();

function pickImg(v: any, preferLargest = false): string {
    let s = '';
    const extract = (it: any): string => {
        if (typeof it === 'string') return it;
        if (!it || typeof it !== 'object') return '';
        return it.file_path || it.url || it.path || it.image || it.src || '';
    };
    if (typeof v === 'string') s = v;
    else if (Array.isArray(v) && v.length) {
        let best = v[0];
        if (preferLargest) {
            let bestSize = 0;
            for (const it of v) {
                const w = (it && (it.width || it.w)) || 0;
                const h = (it && (it.height || it.h)) || 0;
                const sz = w * h;
                if (sz > bestSize) { bestSize = sz; best = it; }
            }
        }
        s = extract(best);
    }
    if (!s) return '';
    if (s.startsWith('http') || s.includes('sys/img')) return s;
    return 'sys/img' + (s.startsWith('/') ? s : '/' + s);
}

/** 取某飞牛 item 的竖版海报 URL（与首页右侧海报条同源）。失败/无图返回 ''。 */
async function fetchItemPoster(guid: string): Promise<string> {
    try {
        const base = location.origin;
        const path = `/v/api/v1/item/${guid}`;
        const authx = await ipcRenderer.invoke('fnos-gen-authx', path);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        let resp: Response;
        try {
            resp = await fetch(`${base}${path}`, { credentials: 'include', headers: { 'Authx': authx }, signal: ctrl.signal });
        } finally { clearTimeout(timer); }
        if (!resp.ok) return '';
        const json: any = await resp.json();
        const d = (json && json.data) || {};
        const rel = pickImg(d.posters, true);
        if (!rel) return '';
        return rel.startsWith('http') ? rel : base + '/v/api/v1/' + rel;
    } catch { return ''; }
}

/** 时长(ms) → 人类可读，如 "2小时15分" / "45分" / "1小时"。 */
function fmtDur(ms: number): string {
    if (!ms || ms < 60000) return '';
    const totalMin = Math.round(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h > 0) return m > 0 ? `${h}小时${m}分` : `${h}小时`;
    return `${m}分`;
}

/** 类型映射：fnOS item type → 显示用中文 */
function mapType(t: string | number | undefined): string {
    if (!t) return '其他';
    const s = String(t).toLowerCase();
    if (s.includes('movie') || s === '1') return '电影';
    if (s.includes('series') || s === '2') return '剧集';
    if (s.includes('anime') || s.includes('cartoon')) return '动漫';
    return '其他';
}

/**
 * 从飞牛影视拉取真实已观看数据，转为 ShowItem[] 替换 curData。
 * IPC：douban:get-watched-items → 主进程调 fnOS /v/api/v1/item/list（带 token）
 *   过滤 watched===1 → 返回 [{guid,title,type,thumbnail_url,overview,year,genres,cast,
 *          douban_id,douban_rating,watched,progress,last_played}, ...]
 */
async function loadWatchData(force = false): Promise<{ count: number; from: 'real' | 'sample'; libraryTotal: number }> {
    try {
        const resp = await ipcRenderer.invoke('douban:get-watched-items', force).catch(() => null);
        // 兼容两种返回形态：旧版直接返回数组；新版返回 { items, libraryTotal }
        const items = (resp && Array.isArray(resp.items)) ? resp.items : (Array.isArray(resp) ? resp : null);
        const libraryTotal = (resp && typeof resp.libraryTotal === 'number') ? resp.libraryTotal : 0;
        if (!items || items.length === 0) {
            log.info(LOG, '飞牛返回空/失败，保留示例数据');
            return { count: 0, from: 'sample', libraryTotal: 0 };
        }
        const mapped: ShowItem[] = items.map((it: any, i: number) => {
            // 真实"最近播放"时间戳（ms）：兼容 ISO 字符串与秒级/毫秒级数字
            let lpMs = 0;
            const lp = it.last_played;
            if (lp) {
                if (typeof lp === 'number') lpMs = lp < 1e12 ? lp * 1000 : lp;
                else { const p = Date.parse(lp); if (!Number.isNaN(p)) lpMs = p; }
            }
            return {
            guid: it.guid || '',
            name: it.title || '未知作品',
            // 分类标签：主进程已按 fnOS 类型给出 电影/剧集（TV 基分类），TMDB 命中时可升级为 动漫；
            // 缺字段时回退到 mapType（仍可能落到"其他"，仅极罕见未知类型）。
            type: (typeof it.category === 'string' && it.category) ? it.category : mapType(it.type),
            last: lpMs ? formatAgo(lpMs) : '未记录时间',
            lastPlayedAt: lpMs,
            totalRuntimeMs: (typeof it.total_runtime_ms === 'number' && it.total_runtime_ms > 0) ? it.total_runtime_ms : 0,
            prog: typeof it.progress === 'number' ? Math.min(1, Math.max(0, it.progress)) : (it.watched ? 1 : 0),
            started: it.started ? true : false,
            art: artForName(it.title || `item-${i}`),
            poster: '',
            fn: {
                year: it.year || new Date().getFullYear(),
                // TMDB 中文类型标签；主进程已尽力获取，空则回退"未分类"（满足"获取不到显示未分类"）。
                genres: (Array.isArray(it.genres) && it.genres.length) ? it.genres
                    : (typeof it.genre === 'string' ? [it.genre] : ['未分类']),
                cast: Array.isArray(it.cast) ? it.cast : [],
                douban: typeof it.douban_rating === 'number' ? it.douban_rating :
                    (typeof it.douban_score === 'number' ? it.douban_score : 0),
                overview: it.overview || '暂无简介（来自飞牛影视）',
            },
            myRating: 0,
            myReview: '',
            sessions: lpMs ? [[formatDate(lpMs), '']] : [],
            };
        });
        // 并发拉取真实竖版海报（与首页轮播图同款 item API 机制），按 guid 取 data.posters
        const CHUNK = 4;
        for (let i = 0; i < mapped.length; i += CHUNK) {
            const slice = mapped.slice(i, i + CHUNK);
            await Promise.all(slice.map(async (m) => {
                if (!m.guid) return;
                // 海报（总时长已由主进程 getWatchedItems 计算并随数据下发，前端不再单独拉取）
                const cached = _posterCache.get(m.guid);
                if (cached) { m.poster = cached; }
                else {
                    const url = await fetchItemPoster(m.guid);
                    m.poster = url;
                    if (url) _posterCache.set(m.guid, url);
                }
            }));
        }
        // 合并用户已有的评分/评语（按 name 匹配旧数据）
        for (const m of mapped) {
            const old = curData.find((o) => o.name === m.name);
            if (old && old.myRating > 0) { m.myRating = old.myRating; m.myReview = old.myReview; }
        }
        curData = mapped;
        log.info(LOG, `已加载 ${mapped.length} 条飞牛真实观看记录`);
        return { count: mapped.length, from: 'real', libraryTotal };
    } catch (e: any) {
        log.warn(LOG, 'loadWatchData 失败:', e && e.message);
        return { count: 0, from: 'sample', libraryTotal: 0 };
    }
}

function formatAgo(ts: string | number): string {
    try {
        const d = new Date(ts);
        const diff = Date.now() - d.getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 60) return `${mins} 分钟前`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs} 小时前`;
        const days = Math.floor(hrs / 24);
        if (days < 30) return `${days} 天前`;
        const months = Math.floor(days / 30);
        return `${months} 个月前`;
    } catch { return ''; }
}

function formatDate(ts: string | number): string {
    try {
        const d = new Date(ts);
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        const mi = String(d.getMinutes()).padStart(2, '0');
        return `${mm}-${dd} ${hh}:${mi}`;
    } catch { return ''; }
}

/** 解析播放会话日期字符串为时间戳（ms）。
 *  支持：ISO 字符串（飞牛/真实，含完整年份）与 SAMPLE 的 "MM-DD HH:MM"（缺年份→用当前年）。 */
function parseSessionDate(s: string): number {
    if (!s) return 0;
    // 先尝试标准 ISO / 完整日期解析
    const direct = Date.parse(s);
    if (!Number.isNaN(direct)) {
        const d = new Date(direct);
        if (d.getFullYear() > 2000) return direct; // 年份合理，直接采用
    }
    // 退路：解析 "MM-DD HH:MM"（SAMPLE 格式，补当前年）
    const m = s.match(/(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})/);
    if (m) {
        const d = new Date();
        d.setMonth(parseInt(m[1], 10) - 1, parseInt(m[2], 10));
        d.setHours(parseInt(m[3], 10), parseInt(m[4], 10), 0, 0);
        return d.getTime();
    }
    return 0;
}

/** 取某作品的真实"最近一次播放"时间戳（ms）。
 *  优先用显式 lastPlayedAt（真实数据），否则从 sessions 解析（SAMPLE 亦可用）。无→0。 */
function lastPlayedTs(it: ShowItem): number {
    if (it.lastPlayedAt) return it.lastPlayedAt;
    let best = 0;
    for (const s of it.sessions || []) {
        const t = parseSessionDate(s[0]);
        if (t > best) best = t;
    }
    return best;
}

async function syncFnos(): Promise<void> {
    toast('正在从飞牛影视同步最新观看数据…');
    showSkeleton(); // 重拉前先铺骨架占位，避免卡片瞬间清空/空白
    const result = await loadWatchData(true); // 立即同步：绕过 10 分钟缓存，即时拉取最新观看数据
    if (result.from === 'real') {
        renderWall();
        renderChart(); // 真实数据到位后刷新活跃度（统计数字 + 柱状图均基于真实播放日期）
        updatePillCounts(); // 刷新筛选按钮上的真实分类计数
        const sub = $('wh-sub');
        const total = result.libraryTotal || curData.length; // 库内真实作品总数（用户要求）
        const done = curData.filter(i => i.prog >= 1).length;
        const partial = curData.length - done;
        if (sub) sub.textContent = `库内 ${total} 部 · 已看完 ${done} · 看到一半 ${partial}`;
        toast(`已同步 ${result.count} 部观看记录（含部分看）`);
    } else {
        toast('同步失败：未能获取飞牛数据（可能未登录或网络问题）');
    }
}

function toast(msg: string): void {
    const t = $('wh-toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 1800);
}

/** 强制不透明底色（与 dialogUI.ts 弹窗 / embyWall 设置面板同款：具体色值 + 行内 !important，不用 var()）。
 *  fnOS 标准面板色：深 #1c1c1e / 浅 #f5f5f7；并强制 backdrop-filter:none 杜绝玻璃渗透。
 *  多处调用（开面板 / 显示后 rAF / 数据加载后）以抵御 Glass UI 异步重注入导致的偶发透明。 */
function paintBg(root: HTMLElement): void {
    const light = root.classList.contains('light');
    root.style.setProperty('background', light ? '#f5f5f7' : '#1c1c1e', 'important');
    root.style.setProperty('background-color', light ? '#f5f5f7' : '#1c1c1e', 'important');
    root.style.setProperty('backdrop-filter', 'none', 'important');
    root.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
}

// 玻璃 UI 可能在面板显示后异步重注入 body>div{background:transparent!important}，
// 一次性重涂会被覆盖 → 偶发透明。故在面板可见期间用 rAF 循环持续兜底重涂，关闭时取消。
let _paintRAF = 0;
function paintLoop(root: HTMLElement): void {
    paintBg(root);
    _paintRAF = requestAnimationFrame(() => paintLoop(root));
}

function openPanel(): void {
    try {
        // 若面板元素曾被 fnOS 路由切换清掉（DOM 重建），重置标记让其重新创建
        if (!$(PANEL_ID)) panelBuilt = false;
        buildPanel();
        const root = $(PANEL_ID) as HTMLElement;
        const light = detectLight();
        root.classList.toggle('light', light);
        paintBg(root);
        root.classList.add('show');
        // 每次打开自愈式重绑筛选监听（免疫 fnOS 路由切换导致的旧节点监听失效 → 电影/剧集/动漫"点不动"）
        bindFilters(root);
        // 持续兜底：面板可见期间每帧重涂，彻底封死玻璃 UI 异步重注入导致的偶发透明
        cancelAnimationFrame(_paintRAF);
        _paintRAF = requestAnimationFrame(() => paintLoop(root));
        renderChart();

        // 自动加载飞牛真实数据（异步，不阻塞 UI 渲染）；用缓存（force=false）加速开面板
        showSkeleton(); // 拉取期间先铺骨架占位，避免海报墙空白闪烁
        loadWatchData(false).then((result) => {
            renderWall();
            renderChart(); // 真实数据到位后刷新活跃度（统计数字 + 柱状图均基于真实播放日期）
            // 数据刷新后再次兜底重涂底色（renderWall 重写 innerHTML 可能触发重排）
            requestAnimationFrame(() => paintBg(root));
            updatePillCounts(); // 刷新筛选按钮上的真实分类计数
            const sub = $('wh-sub');
            const done = curData.filter((i) => i.prog >= 1).length;
            const partial = curData.length - done;
            // 顶部用库内真实总数（libraryTotal）；示例数据回落到 curData.length
            const total = result.from === 'real' ? (result.libraryTotal || curData.length) : curData.length;
            if (sub) sub.textContent = result.from === 'real'
                ? `库内 ${total} 部 · 已看完 ${done} · 看到一半 ${partial}`
                : `示例数据 · ${curData.length} 部（点击「立即同步」拉取真实记录）`;
            // 隐藏/更新示例提示
            const sampleHint = root.querySelector('.wh-sample') as HTMLElement | null;
            if (sampleHint) {
                sampleHint.textContent = result.from === 'real'
                    ? '* 数据来自飞牛影视 · 点击「立即同步」可刷新'
                    : '* 当前为示例数据；点击「立即同步」可拉取真实记录';
                if (result.from === 'real') sampleHint.style.opacity = '0.6';
            }
        });
    } catch (err) {
        log.error(LOG, 'openPanel failed', err);
    }
}

function closePanel(): void {
    const root = $(PANEL_ID);
    if (!root) return;
    // 取消持续重涂循环，避免面板隐藏后仍空转
    cancelAnimationFrame(_paintRAF);
    _paintRAF = 0;
    // 收起整面板
    root.classList.remove('show');
    // 顺便清掉详情浮层（若曾点开详情再点 ✕ 关闭，否则下次重开详情浮层会残留 .show 变成「难展开」）
    const detail = root.querySelector('#wh-detail') as HTMLElement | null;
    if (detail) detail.classList.remove('show');
    // 复位可能的卡片选中态
    root.querySelectorAll('.wh-card.focused').forEach((c) => c.classList.remove('focused'));
    // 关闭后是否"回影视首页"：仅当用户当前处于【影视 App】(isFntvTvPage: /v 及其子页) 内才回首页；
    // 飞牛原生 NAS 页 / 仪表盘 / 其他 fnOS 系统页一律【不导航】，保留用户当前所在页，
    // 避免关闭时把正在用 NAS 的用户强行拽到影视首页（呼应"非首页守卫不影响 NAS 用户"）。
    if (isFntvTvPage()) {
        const p = (location.pathname || '').replace(/\/+$/, '');
        if (p === '/v') {
            // 已在影视首页：直接关闭面板即可，不再整页刷新（避免关闭观影记录时首页闪烁重排）
        } else {
            // 影视子页（/v/movie|tv|...）：回影视首页
            try { location.href = location.origin + '/v'; } catch { /* ignore */ }
        }
    }
    // 非影视 App（原生 NAS 页等）：不导航，仅收起面板，用户停留在原页面
}

// ───────────────────────── OnReady 入口 ─────────────────────────
function handle(): void {
    try {
        // ① 先尝试直接注入（embyWall 可能已先于本插件执行 OnReady）
        if (!injectEntry()) {
            // ② 兜底：监听 DOM 变化，等 embyWall 创建 #fnos-sidebar-actions 后注入
            const obs = new MutationObserver(() => { if (injectEntry()) obs.disconnect(); });
            obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
        }
        startKeepAlive();
        log.info(LOG, '插件已加载');
    } catch (err) {
        log.error(LOG, 'handle failed', err);
    }
}

registerHook(HookType.OnReady, handle);

export {};
