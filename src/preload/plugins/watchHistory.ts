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
    ratings: { tmdb: number; tmdbVotes: number; douban: number; doubanVotes: number }; // 多平台评分：TMDB(飞牛缓存) / 豆瓣(现取)
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
      fn: { year: 2024, genres: ['科幻', '冒险'], cast: ['提莫西·查拉梅', '赞达亚'], ratings: { tmdb: 8.0, tmdbVotes: 4321, douban: 8.0, doubanVotes: 350000 },
        overview: '保罗·厄崔迪联合契妮与弗雷曼人，踏上复仇与拯救宇宙之路，在沙漠星球的权谋与信仰间抉择。' },
      myRating: 4, myReview: '视效封神，沙丘美学拉满，中段节奏偏慢但收尾有力。',
      sessions: [['08-21 22:14', '01:02:11 / 01:46:00'], ['08-19 21:40', '00:38:00 / 01:46:00']] },
    { name: '繁花', type: '剧集', last: '5 天前', prog: 0.34, art: grad('#3a1a2a', '#140810'),
      fn: { year: 2023, genres: ['剧情', '年代'], cast: ['胡歌', '马伊琍', '唐嫣'], ratings: { tmdb: 8.4, tmdbVotes: 3098, douban: 8.4, doubanVotes: 120000 },
        overview: '上世纪九十年代的上海，阿宝从街头小贩成长为商界巨擘，在时代浪潮与儿女情长中沉浮。' },
      myRating: 5, myReview: '沪语版味道绝了，王家卫的腔调扑面而来。',
      sessions: [['08-19 20:50', '00:14:20 / 00:45:00'], ['08-18 21:10', '00:00:00 / 00:45:00']] },
    { name: '周处除三害', type: '电影', last: '4 天前', prog: 0.91, art: grad('#1a2a3a', '#081018'),
      fn: { year: 2023, genres: ['动作', '犯罪'], cast: ['阮经天'], ratings: { tmdb: 8.1, tmdbVotes: 2765, douban: 8.2, doubanVotes: 600000 },
        overview: '通缉犯陈桂林在生命尽头决定铲除排在自己之前的两名头号罪犯，完成一场血色救赎。' },
      myRating: 5, myReview: '爽。高潮戏段落堪称年度名场面。',
      sessions: [['08-20 23:30', '01:45:00 / 01:54:00']] },
    { name: '葬送的芙莉莲', type: '动漫', last: '上周', prog: 0.45, art: grad('#2a1a3a', '#100818'),
      fn: { year: 2023, genres: ['奇幻', '冒险'], cast: ['原菜乃羽', '小林亲弘'], ratings: { tmdb: 9.0, tmdbVotes: 5120, douban: 9.3, doubanVotes: 200000 },
        overview: '人类魔法使与精灵战士芙莉莲踏上重温已故勇者足迹的旅程，追问生命与遗忘的意义。' },
      myRating: 4, myReview: '把"时间"讲得这么温柔的冒险番不多见。',
      sessions: [['08-14 19:00', '00:13:00 / 00:24:00']] },
    { name: '奥本海默', type: '电影', last: '上周', prog: 0.12, art: grad('#2a2a1a', '#101008'),
      fn: { year: 2023, genres: ['传记', '历史'], cast: ['基里安·墨菲'], ratings: { tmdb: 8.8, tmdbVotes: 6410, douban: 8.9, doubanVotes: 500000 },
        overview: '原子弹之父奥本海默在荣耀与良知、政治与科学之间被撕扯的一生。' },
      myRating: 0, myReview: '',
      sessions: [['08-13 21:00', '00:14:00 / 03:00:00']] },
    { name: '流浪地球 2', type: '电影', last: '2 周前', prog: 1, art: grad('#10283a', '#04101c'),
      fn: { year: 2023, genres: ['科幻', '灾难'], cast: ['吴京', '刘德华', '李雪健'], ratings: { tmdb: 8.3, tmdbVotes: 8844, douban: 8.3, doubanVotes: 800000 },
        overview: '太阳危机来临前，人类启动带着地球逃离的方舟计划，在分裂与团结间赌上文明存续。' },
      myRating: 5, myReview: '中国科幻的天花板，太空电梯那段值回票价。',
      sessions: [['08-08 20:00', '03:00:00 / 03:00:00']] },
    { name: '庆余年', type: '剧集', last: '2 周前', prog: 0.78, art: grad('#2a2410', '#100c04'),
      fn: { year: 2019, genres: ['古装', '权谋'], cast: ['张若昀', '李沁'], ratings: { tmdb: 7.9, tmdbVotes: 1533, douban: 7.9, doubanVotes: 400000 },
        overview: '现代青年魂穿架空王朝，以才学与机变在波谲云诡的朝堂中走出自己的人生。' },
      myRating: 4, myReview: '轻松又带脑，二刷依旧上头。',
      sessions: [['08-07 21:30', '00:35:00 / 00:45:00']] },
    { name: '间谍过家家', type: '动漫', last: '3 周前', prog: 0.56, art: grad('#3a2010', '#140a04'),
      fn: { year: 2022, genres: ['搞笑', '日常'], cast: ['江口拓也', '种崎敦美'], ratings: { tmdb: 9.0, tmdbVotes: 5120, douban: 9.0, doubanVotes: 150000 },
        overview: '间谍、杀手与读心超能力少女，为各自任务伪装成一家人，却意外收获真正的温暖。' },
      myRating: 5, myReview: '阿尼亚表情包本包，全家最萌。',
      sessions: [['08-01 18:00', '00:13:00 / 00:24:00']] },
    { name: '满江红', type: '电影', last: '上月', prog: 1, art: grad('#3a1010', '#140404'),
      fn: { year: 2023, genres: ['剧情', '悬疑'], cast: ['沈腾', '易烊千玺'], ratings: { tmdb: 7.0, tmdbVotes: 2207, douban: 7.0, doubanVotes: 450000 },
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
  --wh-card-bg:#1a1a1d;--wh-radius:18px;--wh-hm-0:rgba(255,255,255,.1);
  --wh-hm-1:#0e4429;--wh-hm-2:#006d32;--wh-hm-3:#26a641;--wh-hm-4:#39d353;
  --wh-cell-border:rgba(255,255,255,.14)}
#${PANEL_ID}.light{--wh-bg:#f5f5f7;--wh-surface:rgba(0,0,0,.04);--wh-surface2:rgba(0,0,0,.07);
  --wh-text:#1d1d1f;--wh-text2:#515154;--wh-text3:#86868b;--wh-line:rgba(0,0,0,.1);
  --wh-bar-empty:linear-gradient(180deg,#e3e3e8,#d2d2d7);--wh-track:rgba(0,0,0,.1);--wh-tip:#fff;
  --wh-detail:#fff;--wh-star-empty:#d2d2d7;--wh-card-bg:#e9e9ee;--wh-hm-0:#ebedf0;--wh-hm-1:#9be9a8;--wh-hm-2:#40c463;--wh-hm-3:#30a14e;--wh-hm-4:#216e39;
  --wh-cell-border:rgba(27,31,35,.12)}

#${PANEL_ID} .wh-main{position:absolute;inset:0;top:70px;overflow-y:auto;padding:0 0 60px;z-index:10}
#${PANEL_ID} .wh-topbar{display:flex;align-items:flex-start;justify-content:flex-start;gap:24px;
  padding:26px 40px 14px;position:sticky;top:0;z-index:60;pointer-events:auto;
  background:inherit;transition:opacity .12s}
#${PANEL_ID} .wh-tb-left{display:flex;flex-direction:column;gap:2px}
#${PANEL_ID} .wh-title-row{display:flex;align-items:center;gap:14px}
#${PANEL_ID} .wh-title{font-size:38px;font-weight:700;letter-spacing:.3px;display:flex;align-items:center;gap:12px}
#${PANEL_ID} .wh-title::before{content:'';display:inline-block;width:10px;height:10px;border-radius:3px;
  background:linear-gradient(135deg,var(--wh-accent),#7b5bff);flex-shrink:0}
#${PANEL_ID} .wh-active-badge{font-size:13px;font-weight:500;color:var(--wh-accent);
  background:rgba(41,151,255,.1);border:1px solid rgba(41,151,255,.25);
  padding:3px 12px;border-radius:20px;white-space:nowrap;align-self:center;margin-top:6px}
#${PANEL_ID} .wh-subtitle{font-size:13px;color:var(--wh-text2);margin-top:4px;
  display:flex;flex-wrap:wrap;align-items:center;gap:4px 14px;line-height:1.6}
#${PANEL_ID} .wh-stat-item{display:inline-flex;align-items:baseline;gap:2px;white-space:nowrap}
#${PANEL_ID} .wh-stat-item b{font-size:17px;font-weight:700;color:var(--wh-text);font-variant-numeric:tabular-nums}
#${PANEL_ID} .wh-stat-item i{font-size:12px;font-style:normal;color:var(--wh-text3)}
#${PANEL_ID} .wh-stat-sep{color:var(--wh-line);font-size:12px;margin:0 2px}

/* 右上角操作按钮栏（独立层，直接挂载在 #fntv-wh 下、z-index 最高，杜绝被内容/浮层盖住导致点不动）
   含：全部/电影/剧集/动漫 筛选 + 立即同步 + 关闭 ✕，共 6 个按钮，全部原生 <button> 直接绑定 click */
#${PANEL_ID} .wh-topbtns{position:absolute;top:22px;right:28px;z-index:300;
  display:flex;align-items:center;gap:9px;pointer-events:auto}
#${PANEL_ID} .wh-topbtns .wh-pill{padding:8px 16px;border-radius:20px;font-size:13px;color:var(--wh-text2);
  background:var(--wh-surface);border:1px solid transparent;cursor:pointer;transition:.15s;white-space:nowrap;font-family:inherit}
#${PANEL_ID} .wh-topbtns .wh-pill:hover{background:var(--wh-surface2);color:var(--wh-text)}
#${PANEL_ID} .wh-topbtns .wh-pill.active{background:var(--wh-accent);color:#fff;font-weight:600}
#${PANEL_ID} .wh-topbtns .wh-close{position:relative;z-index:5;flex:none;cursor:pointer;padding:6px 10px;
  font-size:20px;line-height:1;color:var(--wh-text2);
  display:flex;align-items:center;justify-content:center;
  user-select:none;-webkit-user-select:none;pointer-events:auto;transition:color .15s;background:none;border:none;font-family:inherit}
#${PANEL_ID} .wh-topbtns .wh-close:hover{color:var(--wh-text)}
#${PANEL_ID} .wh-topbtns .wh-sync{padding:8px 16px;border-radius:20px;font-size:13px;font-weight:600;cursor:pointer;
  background:rgba(41,151,255,.12);border:1px solid var(--wh-accent);color:var(--wh-accent);white-space:nowrap;transition:.15s;font-family:inherit}
#${PANEL_ID} .wh-topbtns .wh-sync:hover{background:var(--wh-accent);color:#fff}
#${PANEL_ID} .wh-topbtns .wh-sync.busy{opacity:.6;pointer-events:none}
/* 详情为模态浮层：打开(wh-detail-open)时隐藏右上角操作栏，避免浮在详情页最上层遮挡内容 */
#${PANEL_ID}.wh-detail-open .wh-topbtns{opacity:0;visibility:hidden;pointer-events:none}
/* 骨架屏：拉取飞牛+TMDB 数据期间在海报墙占位，避免空白闪烁 */
#${PANEL_ID} .wh-skel{position:relative;flex:none;width:100%;aspect-ratio:2/3;height:auto;border-radius:var(--wh-radius);
  overflow:hidden;background:var(--wh-card-bg)}
#${PANEL_ID} .wh-skel::after{content:'';position:absolute;inset:0;
  background:linear-gradient(90deg,transparent 0%,rgba(255,255,255,.08) 50%,transparent 100%);
  transform:translateX(-100%);animation:wh-shimmer 1.2s infinite}
#${PANEL_ID}.light .wh-skel::after{background:linear-gradient(90deg,transparent 0%,rgba(0,0,0,.06) 50%,transparent 100%)}
@keyframes wh-shimmer{100%{transform:translateX(100%)}}

#${PANEL_ID} .wh-section{margin-top:20px;padding:0 40px}
#${PANEL_ID} .wh-section-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:16px}
#${PANEL_ID} .wh-section-title{font-size:22px;font-weight:600}
#${PANEL_ID} .wh-section-hint{font-size:12px;color:var(--wh-text3)}

#${PANEL_ID} .wh-chart-card{background:var(--wh-surface);border:1px solid var(--wh-line);
  border-radius:22px;padding:26px 28px 20px}
#${PANEL_ID} .wh-chart-top{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:16px}
#${PANEL_ID} .wh-chart-top .ct{font-size:14px;font-weight:600;color:var(--wh-text)}
#${PANEL_ID} .wh-chart-top .cs{font-size:12px;color:var(--wh-text3);margin-top:2px}
#${PANEL_ID} .wh-stat{display:flex;gap:30px}
#${PANEL_ID} .wh-stat b{font-size:22px;font-weight:700}
#${PANEL_ID} .wh-stat span{font-size:12px;color:var(--wh-text2);margin-left:3px}
#${PANEL_ID} .wh-chart-wrap{position:relative}
/* GitHub 风格观影活跃度贡献热力图：列=周、行=星期，颜色深浅=当天观看作品数 */
#${PANEL_ID} .wh-heat{margin-top:8px}
#${PANEL_ID} .wh-heat-head{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:14px}
#${PANEL_ID} .wh-heat-total{font-size:13px;color:var(--wh-text2)}
#${PANEL_ID} .wh-heat-total b{color:var(--wh-text);font-weight:700;font-variant-numeric:tabular-nums}
#${PANEL_ID} .wh-heat-legend{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--wh-text3);flex:none}
#${PANEL_ID} .wh-heat-legend .wh-cell{width:12px;height:12px;border-radius:2px}
#${PANEL_ID} .wh-heat-body{display:flex;gap:10px;align-items:flex-start}
#${PANEL_ID} .wh-heat-days{display:grid;grid-template-rows:repeat(7,12px);gap:4px;font-size:10px;color:var(--wh-text3);flex:none;margin-top:18px}
#${PANEL_ID} .wh-heat-days span{line-height:11px;height:11px;visibility:hidden}
#${PANEL_ID} .wh-heat-days span.show{visibility:visible}
#${PANEL_ID} .wh-heat-scroll{overflow-x:auto;flex:1;padding-bottom:6px}
#${PANEL_ID} .wh-heat-months{position:relative;height:16px;margin-bottom:6px;white-space:nowrap;overflow:hidden}
#${PANEL_ID} .wh-heat-month{position:absolute;top:0;left:0;font-size:10px;color:var(--wh-text3);white-space:nowrap;padding-right:8px}
#${PANEL_ID} .wh-heat-cols{display:flex;gap:4px}
#${PANEL_ID} .wh-heat-week{display:grid;grid-template-rows:repeat(7,12px);gap:4px}
#${PANEL_ID} .wh-cell{width:12px;height:12px;border-radius:2px;background:var(--wh-hm-0);cursor:pointer;transition:transform .1s;flex-shrink:0;
  box-shadow:inset 0 0 0 1px var(--wh-cell-border)}
#${PANEL_ID} .wh-cell.l1{background:var(--wh-hm-1)}
#${PANEL_ID} .wh-cell.l2{background:var(--wh-hm-2)}
#${PANEL_ID} .wh-cell.l3{background:var(--wh-hm-3)}
#${PANEL_ID} .wh-cell.l4{background:var(--wh-hm-4)}
/* 未来日期：与空格同色（有清晰描边），明显可见但不响应 hover/tooltip */
#${PANEL_ID} .wh-cell.future{background:var(--wh-hm-0);cursor:default}
#${PANEL_ID} .wh-cell:hover{transform:scale(1.3);outline:1px solid var(--wh-line);outline-offset:1px}
#${PANEL_ID} .wh-cell.future:hover{transform:none;outline:none}
#${PANEL_ID} .wh-chart-tip{position:absolute;transform:translate(-50%,-100%);background:var(--wh-tip);
  border:1px solid var(--wh-line);padding:7px 11px;border-radius:10px;font-size:12px;pointer-events:none;
  opacity:0;transition:.12s;white-space:nowrap;z-index:20}
#${PANEL_ID} .wh-chart-tip.show{opacity:1}
#${PANEL_ID} .wh-chart-tip b{color:var(--wh-accent)}

/* 影视清单：已看完 / 在观看 双栏等宽拆分（各占一半空间）。
   每列内部由"横向滚动条"改为自适应换行网格：海报随列宽等比缩放、多行自动换行，
   整个面板只走纵向滚动（单一滚动轴，规避嵌套横向滚动的体验问题）。 */
#${PANEL_ID} .wh-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));
  gap:16px 14px;padding:4px 4px 10px;align-content:start}
/* 影视清单：已看完 / 在观看 双栏等宽拆分（各占一半空间） */
#${PANEL_ID} .wh-split{display:flex;gap:26px}
#${PANEL_ID} .wh-col{flex:1 1 0;min-width:0;display:flex;flex-direction:column}
#${PANEL_ID} .wh-col-head{display:flex;align-items:center;gap:10px;margin-bottom:14px;padding-left:4px}
#${PANEL_ID} .wh-col-title{font-size:18px;font-weight:700;display:flex;align-items:center;gap:8px}
#${PANEL_ID} .wh-col-title::before{content:'';width:8px;height:8px;border-radius:3px;flex:none}
#${PANEL_ID} .wh-col.done .wh-col-title::before{background:#34c759}
#${PANEL_ID} .wh-col.watching .wh-col-title::before{background:#ff9f0a}
#${PANEL_ID} .wh-col-count{font-size:12px;color:var(--wh-text3);background:var(--wh-surface);border:1px solid var(--wh-line);padding:2px 10px;border-radius:11px}
#${PANEL_ID} .wh-col-empty{grid-column:1/-1;min-height:200px;flex:1;display:flex;align-items:center;justify-content:center;
  color:var(--wh-text3);font-size:13px;text-align:center;background:var(--wh-surface);
  border:1px dashed var(--wh-line);border-radius:14px;margin:4px}
@media (max-width:900px){#${PANEL_ID} .wh-split{flex-direction:column}}
#${PANEL_ID} .wh-card{position:relative;flex:none;border-radius:var(--wh-radius);overflow:hidden;cursor:pointer;
  background:var(--wh-card-bg);transition:transform .22s cubic-bezier(.2,.8,.2,1),box-shadow .22s;outline:none}
#${PANEL_ID} .wh-card.poster{width:100%;aspect-ratio:2/3;height:auto}
#${PANEL_ID} .wh-card:hover{transform:translateY(-4px);box-shadow:0 14px 30px rgba(0,0,0,.55)}
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
#${PANEL_ID} .wh-detail .wh-ratings{display:flex;gap:12px;flex-wrap:wrap;margin-top:14px}
#${PANEL_ID} .wh-detail .wh-rating{flex:1 1 130px;min-width:130px;background:var(--wh-surface2);border:1px solid var(--wh-line);
  border-radius:14px;padding:12px 14px;display:flex;flex-direction:column;gap:3px}
#${PANEL_ID} .wh-detail .wh-rating .rl{font-size:12px;color:var(--wh-text3);letter-spacing:.5px}
#${PANEL_ID} .wh-detail .wh-rating .rs{font-size:24px;font-weight:700;color:#ffcc00;
  font-variant-numeric:tabular-nums;line-height:1.2}
#${PANEL_ID} .wh-detail .wh-rating .rc{font-size:11px;color:var(--wh-text3)}
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
  opacity:0;transition:.25s;z-index:80;pointer-events:none}
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
      <!-- 顶部栏：仅左半标题区；打开详情(wh-detail-open)时隐藏，避免浮在详情页上遮挡 -->
      <div class="wh-topbar">
        <div class="wh-tb-left">
          <div class="wh-title-row">
            <div class="wh-title">Fntv-Plus · 观影记录</div>
            <span class="wh-active-badge">观影活跃度</span>
          </div>
          <div class="wh-subtitle" id="wh-sub"></div>
        </div>
      </div>

      <!-- 右上角操作栏：6 个按钮（筛选×4 + 立即同步 + 关闭 ✕），独立层 z-index 最高，原生 button 直接绑定 click -->
      <div class="wh-topbtns" id="wh-topbtns">
        <button class="wh-pill active" data-f="全部" type="button">全部</button>
        <button class="wh-pill" data-f="电影" type="button">电影</button>
        <button class="wh-pill" data-f="剧集" type="button">剧集</button>
        <button class="wh-pill" data-f="动漫" type="button">动漫</button>
        <button class="wh-sync" id="wh-sync" type="button" title="立即从飞牛影视拉取最新观看数据">立即同步</button>
        <button class="wh-close" id="wh-close" type="button" title="关闭（Esc）">✕</button>
      </div>

      <div class="wh-main">
        <section class="wh-section">
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
              <div class="wh-heat" id="wh-heat"></div>
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
              <div class="wh-grid" id="wh-row-done"></div>
            </div>
            <div class="wh-col watching">
              <div class="wh-col-head">
                <span class="wh-col-title">在观看</span>
                <span class="wh-col-count" id="wh-partial-count">0</span>
              </div>
              <div class="wh-grid" id="wh-row-partial"></div>
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
            <div class="wh-ratings" id="wh-d-ratings"></div>
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
    // 右上角 6 个按钮（筛选×4 + 立即同步 + 关闭）采用原生 <button> + buildPanel 内【直接绑定 click】，
    // 不再依赖全局 document 委托（委托在 fnOS 捕获拦截 / 面板 DOM 重建时易整体失效，导致"全部点没反应"）。
    // 详见下方「右上角按钮直接绑定」段落。空白背景点击关闭仍由 bindGlobalPanelClicks 统一处理。

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

    // ── 关闭：详情浮层背景点击关闭 + Esc（三路关闭；空白背景关闭在 bindGlobalPanelClicks 委托里处理）──
    const detailOverlay = root.querySelector('#wh-detail') as HTMLElement | null;
    if (detailOverlay) {
        detailOverlay.addEventListener('click', (e: MouseEvent) => {
            if ((e.target as HTMLElement).id === 'wh-detail') closeDetail();
        });
    }

    // ── 右上角按钮直接绑定（原生 <button>，buildPanel 仅执行一次，节点静态不重建，监听永不丢失）──
    //   彻底抛弃全局 document 委托，专治"全部点没反应"。每个按钮各自独立处理，互不干扰。
    const topBtns = root.querySelectorAll('.wh-topbtns button');
    topBtns.forEach((b) => {
        const el = b as HTMLButtonElement;
        el.addEventListener('click', (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (el.id === 'wh-close') { closePanel(); return; }
            if (el.id === 'wh-sync') { syncFnos(); return; }
            if (el.classList.contains('wh-pill')) {
                root.querySelectorAll('.wh-pill').forEach((x) => x.classList.remove('active'));
                el.classList.add('active');
                curFilter = el.dataset.f || '全部';
                renderWall();
            }
        });
    });

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
        if (detail && detail.classList.contains('show')) { closeDetail(); return; }
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

/** 参评人数格式化：>=1万显示「x.x万」(中文习惯)，否则原数字。 */
function fmtVotes(v: number): string {
    if (!v || v <= 0) return '';
    return v >= 10000 ? (v / 10000).toFixed(1) + '万' : String(v);
}

/** 顶部统计条：把散落的库存/看完/在看/活跃天数整合为一行紧凑横排统计项。
 *  数字高亮(b 17px bold)、单位/标签收敛(i 12px dimmed)、分隔符细点。 */
function buildSubtitleHTML(total: number, done: number, partial: number, activeDays: number, monthCount: number, isSample: boolean): string {
    if (isSample) {
        return `<span class="wh-stat-item">示例数据 <b>${total}</b><i>部</i></span>
            <span class="wh-stat-sep">·</span>
            <span class="wh-stat-item" style="color:var(--wh-text3)">点击「立即同步」拉取真实记录</span>`;
    }
    return `<span class="wh-stat-item"><b>${total}</b><i>部</i> 库存</span>
        <span class="wh-stat-sep">·</span>
        <span class="wh-stat-item"><b>${done}</b><i>部</i> 已看完</span>
        <span class="wh-stat-sep">·</span>
        <span class="wh-stat-item"><b>${partial}</b><i>部</i> 在看</span>
        <span class="wh-stat-sep">·</span>
        <span class="wh-stat-item"><b>${activeDays}</b><i>天</i>/30天活跃</span>
        <span class="wh-stat-sep">·</span>
        <span class="wh-stat-item">本月 <b>${monthCount}</b><i>部</i></span>`;
}

/** 多平台评分条：TMDB（飞牛刮削缓存）+ 豆瓣（主进程现取），各自一格。
 *  TMDB 卡=飞牛影视已刮削缓存的 vote_average（直接可用，源自 TMDB）；
 *  豆瓣卡=飞牛不提供，主进程现取豆瓣评分。两卡始终同时展示，无值显示「暂无」。 */
function renderRatings(r: { tmdb: number; tmdbVotes: number; douban: number; doubanVotes: number }): string {
    const cell = (label: string, score: number, sub?: string) =>
        `<div class="wh-rating"><div class="rl">${label}</div>` +
        `<div class="rs">${score > 0 ? score.toFixed(1) : '暂无'}</div>` +
        (sub ? `<div class="rc">${sub}</div>` : '') + `</div>`;
    // 飞牛有的直接用：TMDB 卡取 fnOS 缓存的 vote_average；豆瓣卡取主进程现拉的真实豆瓣评分
    const tv = fmtVotes(r.tmdbVotes);
    const dv = fmtVotes(r.doubanVotes);
    let h = cell('TMDB', r.tmdb, r.tmdb > 0 ? (tv ? `${tv} 人评` : '飞牛缓存') : '');
    h += cell('豆瓣', r.douban, r.douban > 0 ? (dv ? `${dv} 人评` : '实时') : '');
    return h;
}

function filteredData(): ShowItem[] {
    if (curFilter === '全部') return curData;
    return curData.filter((i) => i.type === curFilter);
}

/** 全局点击委托（只绑一次，capture 阶段挂 document）。
 *  现仅负责「点击面板空白背景关闭」这一条。
 *  右上角 6 个按钮（筛选×4 / 立即同步 / 关闭）已改为原生 <button> + buildPanel 内【直接绑定 click】
 *  （见 buildPanel 的「右上角按钮直接绑定」段落），不再依赖此委托——
 *  彻底根治此前委托被 fnOS 捕获拦截 / 面板 DOM 重建导致的「全部点没反应」。
 *  范围保护（closest(#fntv-wh)）确保面板外点击不干扰 fnOS 页面自身交互。 */
let _globalClickBound = false;
function bindGlobalPanelClicks(): void {
    if (_globalClickBound) return;
    _globalClickBound = true;
    document.addEventListener('click', (e: MouseEvent) => {
        const tgt = e.target as HTMLElement | null;
        if (!tgt) return;
        // 范围保护：仅处理面板内的点击（面板外点击全部忽略，不影响 fnOS 页面自身交互）
        if (!tgt.closest('#' + PANEL_ID)) return;
        const root = $(PANEL_ID) as HTMLElement | null;
        if (!root) return;
        // 点击面板主内容区空白背景（非交互元素、非右上角按钮栏）关闭面板
        if (tgt === root || tgt.classList.contains('wh-main') || tgt.classList.contains('wh-topbar')) {
            if (tgt.closest('.wh-topbtns')) return; // 按钮栏内（含按钮/间隙）不触发关闭
            closePanel();
        }
    }, true);
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

let _heatTipBound = false;
function renderChart(): void {
    const wrap = $('wh-chart-wrap');
    const tip = $('wh-chart-tip');
    const heat = $('wh-heat');
    const ct = $('wh-chart-ct'); const cs = $('wh-chart-cs');
    if (!wrap || !tip || !heat) return;

    const dayMs = 86400000;
    const today = new Date(); today.setHours(0, 0, 0, 0);

    // ① 每部作品按"最近一次播放"分桶到天（真实 lastPlayedAt 优先，否则解析 sessions 日期）
    const dayCount = new Map<string, number>(); // key = `${年}-${月}-${日}`
    for (const it of curData) {
        const ts = lastPlayedTs(it);
        if (!ts) continue;
        const d = new Date(ts); d.setHours(0, 0, 0, 0);
        const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        dayCount.set(key, (dayCount.get(key) || 0) + 1);
    }

    // ② 近 30 天活跃天数（顶部统计条沿用旧口径）
    const buckets30 = new Array(30).fill(0);
    for (const it of curData) {
        const ts = lastPlayedTs(it); if (!ts) continue;
        const d = new Date(ts); d.setHours(0, 0, 0, 0);
        const diff = Math.round((today.getTime() - d.getTime()) / dayMs);
        if (diff >= 0 && diff < 30) buckets30[29 - diff] += 1;
    }
    const activeDays = buckets30.filter((c) => c > 0).length;

    // ③ GitHub 风格热力图：过去 53 周（≈一年），列=周、行=星期(日→六)
    const NUM_WEEKS = 53;
    const start = new Date(today.getTime() - (NUM_WEEKS - 1) * 7 * dayMs);
    start.setDate(start.getDate() - start.getDay()); // 对齐到周日(行 0)
    const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
    const STEP = 16; // 单元格 12px + 间距 4px（月份标签 left 偏移以此对齐）
    const weeks: { date: Date; count: number; future: boolean }[][] = [];
    const cursor = new Date(start);
    let yearTotal = 0, yearActive = 0;
    while (cursor <= today) {
        const col: { date: Date; count: number; future: boolean }[] = [];
        for (let dow = 0; dow < 7; dow++) {
            const future = cursor > today;
            const key = `${cursor.getFullYear()}-${cursor.getMonth()}-${cursor.getDate()}`;
            const count = dayCount.get(key) || 0;
            if (!future && count > 0) { yearTotal += count; yearActive++; }
            col.push({ date: new Date(cursor), count: future ? 0 : count, future });
            cursor.setDate(cursor.getDate() + 1);
        }
        weeks.push(col);
    }

    // 颜色档位：0=空 1=1部 2=2~3部 3=4~5部 4=6部+
    const level = (c: number) => (c <= 0 ? 0 : c === 1 ? 1 : c <= 3 ? 2 : c <= 5 ? 3 : 4);

    // 月份标签：每 2 个月打一个（避免 53 周挤在一起），格式简化为「X月」
    const monthLabels: { left: number; text: string }[] = [];
    let lastMonth = -1;
    let monthSkip = 0;
    weeks.forEach((wk, wi) => {
        const m = wk[0].date.getMonth();
        if (m !== lastMonth) {
            if (monthSkip % 2 === 0) { // 每 2 个月打一个标签
                monthLabels.push({ left: wi * STEP, text: `${m + 1}月` });
            }
            lastMonth = m;
            monthSkip++;
        }
    });

    // 单元格 HTML（列=周）
    let cellsHTML = '';
    weeks.forEach((wk) => {
        let colHTML = '<div class="wh-heat-week">';
        for (const cell of wk) {
            const lv = cell.future ? -1 : level(cell.count);
            const cls = 'wh-cell' + (cell.future ? ' future' : (lv > 0 ? ' l' + lv : ''));
            const ds = `${cell.date.getFullYear()}-${cell.date.getMonth() + 1}-${cell.date.getDate()}`;
            colHTML += `<div class="${cls}" data-date="${ds}" data-cnt="${cell.future ? 0 : cell.count}"></div>`;
        }
        cellsHTML += colHTML + '</div>';
    });
    const monthsHTML = monthLabels.map((m) => `<span class="wh-heat-month" style="left:${m.left}px">${m.text}</span>`).join('');
    let daysHTML = '';
    for (let i = 0; i < 7; i++) {
        const show = (i === 1 || i === 3 || i === 5); // 仅显示 一/三/五
        daysHTML += `<span class="${show ? 'show' : ''}" style="line-height:12px;height:12px">${WEEKDAYS[i]}</span>`;
    }

    heat.innerHTML = `
      <div class="wh-heat-head">
        <div class="wh-heat-total">过去一年 共观看 <b>${yearTotal}</b> 部 · 活跃 <b>${yearActive}</b> 天</div>
        <div class="wh-heat-legend">少
          <span class="wh-cell l1" style="pointer-events:none"></span>
          <span class="wh-cell l2" style="pointer-events:none"></span>
          <span class="wh-cell l3" style="pointer-events:none"></span>
          <span class="wh-cell l4" style="pointer-events:none"></span>
          多
        </div>
      </div>
      <div class="wh-heat-body">
        <div class="wh-heat-days">${daysHTML}</div>
        <div class="wh-heat-scroll">
          <div class="wh-heat-months">${monthsHTML}</div>
          <div class="wh-heat-cols">${cellsHTML}</div>
        </div>
      </div>`;

    // tooltip：事件委托挂在 heat 容器上，仅绑定一次（免疫 innerHTML 重建）
    if (!_heatTipBound) {
        _heatTipBound = true;
        heat.addEventListener('mouseover', (e: Event) => {
            const t = (e.target as HTMLElement);
            if (!t.classList || !t.classList.contains('wh-cell') || t.classList.contains('future')) return;
            const cnt = parseInt(t.dataset.cnt || '0', 10);
            const ds = t.dataset.date || '';
            tip.innerHTML = cnt > 0 ? `${ds} · <b>${cnt} 部作品</b>` : `${ds} · 未观看`;
            const r = t.getBoundingClientRect();
            const wr = (wrap as HTMLElement).getBoundingClientRect();
            tip.style.left = (r.left - wr.left + r.width / 2) + 'px';
            tip.style.top = (r.top - wr.top - 6) + 'px';
            tip.classList.add('show');
        });
        heat.addEventListener('mouseout', () => tip.classList.remove('show'));
    }

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

    if (ct) ct.textContent = '观影活跃度';
    if (cs) cs.textContent = `过去一年 · 活跃 ${yearActive} 天`;
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
    setH('wh-d-ratings', renderRatings(it.fn.ratings));
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
    // 详情为模态浮层：隐藏顶栏（全部/电影/剧集/动漫/立即同步/✕），避免其浮在详情页最上层遮挡内容
    const pr = $(PANEL_ID) as HTMLElement | null;
    if (pr) pr.classList.add('wh-detail-open');
}

/** 关闭详情浮层：移除 .show 并清除 wh-detail-open（恢复顶栏显示）。所有关闭路径统一走这里。 */
function closeDetail(): void {
    const detail = $('wh-detail');
    if (detail) detail.classList.remove('show');
    const pr = $(PANEL_ID) as HTMLElement | null;
    if (pr) pr.classList.remove('wh-detail-open');
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

// ───────────────────────── 真实海报+简介拉取（与首页轮播图同款机制）─────────────────────────
// 复用 embyWall.fetchItemDetail 的取图逻辑：经主进程生成 Authx 头 → GET /v/api/v1/item/${guid}
//   （credentials:'include'）→ 取 data.posters（竖版，选最大尺寸）+ overview（简介）
//   → 拼 base + '/v/api/v1/' + rel。
// 这样观看记录的竖版海报与首页轮播图来源完全一致（飞牛 item API 权威竖版源），不再用假渐变占位；
// 同时顺手拿到 overview 解决剧集详情页"暂无简介"问题。
const _posterCache = new Map<string, { poster: string; overview: string }>();
// 海报+简介跨重启持久化：落 localStorage（同 fnOS 网页 origin，electron 自动落盘），
// 避免每次重启 dev.cmd 都重新拉取 /v/api/v1/item/{guid}。仅存小字符串 URL/简介，体积可忽略。
const _POSTER_LS_KEY = 'fntv_wh_poster_cache_v1';
let _posterCacheLoaded = false;
function loadPosterCache(): void {
    if (_posterCacheLoaded) return;
    _posterCacheLoaded = true;
    try {
        const raw = localStorage.getItem(_POSTER_LS_KEY);
        if (!raw) return;
        const obj = JSON.parse(raw) as Record<string, { poster: string; overview: string }>;
        for (const k in obj) _posterCache.set(k, obj[k]);
    } catch { /* 解析失败则忽略，走实时拉取 */ }
}
function savePosterCache(): void {
    try {
        const obj: Record<string, { poster: string; overview: string }> = {};
        _posterCache.forEach((v, k) => { obj[k] = v; });
        localStorage.setItem(_POSTER_LS_KEY, JSON.stringify(obj));
    } catch { /* 配额/隐私模式失败时忽略，下次实时拉取 */ }
}

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

/** 取某飞牛 item 的竖版海报 URL + 简介（与首页右侧海报条同源）。失败返回 { poster:'', overview:'' }。 */
async function fetchItemPoster(guid: string): Promise<{ poster: string; overview: string }> {
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
        if (!resp.ok) return { poster: '', overview: '' };
        const json: any = await resp.json();
        const d = (json && json.data) || {};
        const rel = pickImg(d.posters, true);
        const poster = rel ? (rel.startsWith('http') ? rel : base + '/v/api/v1/' + rel) : '';
        // 与首页轮播图一致：overview > tv_overview > parent_overview
        const overview = (d.overview || d.tv_overview || d.parent_overview || '') as string;
        return { poster, overview };
    } catch { return { poster: '', overview: '' }; }
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
                ratings: {
                    tmdb: typeof it.fnos_rating === 'number' ? it.fnos_rating : 0,
                    tmdbVotes: typeof it.tmdb_votes === 'number' ? it.tmdb_votes : 0,
                    douban: typeof it.douban_rating === 'number' ? it.douban_rating : 0,
                    doubanVotes: typeof it.douban_votes === 'number' ? it.douban_votes : 0,
                },
                overview: it.overview || '暂无简介（来自飞牛影视）',
            },
            myRating: 0,
            myReview: '',
            sessions: lpMs ? [[formatDate(lpMs), '']] : [],
            };
        });
        // 并发拉取真实竖版海报（与首页轮播图同款 item API 机制），按 guid 取 data.posters
        loadPosterCache(); // 重启后从 localStorage 恢复海报+简介，避免重复拉取
        const CHUNK = 4;
        for (let i = 0; i < mapped.length; i += CHUNK) {
            const slice = mapped.slice(i, i + CHUNK);
            await Promise.all(slice.map(async (m) => {
                if (!m.guid) return;
                // 海报+简介（总时长已由主进程 getWatchedItems 计算并随数据下发，前端不再单独拉取）
                const cached = _posterCache.get(m.guid);
                if (cached) { m.poster = cached.poster; if (cached.overview && !m.fn.overview) m.fn.overview = cached.overview; }
                else {
                    const res = await fetchItemPoster(m.guid);
                    m.poster = res.poster;
                    if (res.overview) m.fn.overview = res.overview;
                    if (res.poster || res.overview) _posterCache.set(m.guid, res);
                }
            }));
        }
        savePosterCache(); // 落盘持久化（含本次新拉取的海报+简介）
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
    const sb = $('wh-sync') as HTMLElement | null;
    if (sb) sb.classList.add('busy'); // 加载中禁用，防止重复点击
    try {
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
            const activeDaysEl = $('wh-stat-days');
            const activeDays = activeDaysEl ? parseInt(activeDaysEl.textContent || '0', 10) : 0;
            const monthCountEl = $('wh-stat-month');
            const monthCount = monthCountEl ? parseInt(monthCountEl.textContent || '0', 10) : 0;
            if (sub) sub.innerHTML = buildSubtitleHTML(total, done, partial, activeDays, monthCount, false);
            toast(`已同步 ${result.count} 部观看记录（含部分看）`);
        } else {
            toast('同步失败：未能获取飞牛数据（可能未登录或网络问题）');
        }
    } finally {
        if (sb) sb.classList.remove('busy');
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
        // 右上角 6 个按钮在 buildPanel 内已直接绑定 click（原生 <button>），
        // 此处无需再绑；空白背景关闭由 bindGlobalPanelClicks 的 document 委托统一处理。
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
            const activeDaysEl = $('wh-stat-days');
            const activeDays = activeDaysEl ? parseInt(activeDaysEl.textContent || '0', 10) : 0;
            const monthCountEl = $('wh-stat-month');
            const monthCount = monthCountEl ? parseInt(monthCountEl.textContent || '0', 10) : 0;
            if (sub) sub.innerHTML = buildSubtitleHTML(total, done, partial, activeDays, monthCount, result.from !== 'real');
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
    root.classList.remove('wh-detail-open');
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
        bindGlobalPanelClicks(); // ✅ 只绑一次的全局点击委托（筛选/同步/关闭），免疫面板 DOM 重建
        log.info(LOG, '插件已加载');
    } catch (err) {
        log.error(LOG, 'handle failed', err);
    }
}

registerHook(HookType.OnReady, handle);

export {};
