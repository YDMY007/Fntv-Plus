// preload/core/i18n.ts
// [lc-1064] 轻量 i18n 框架（gettext 风格：中文原文即 key）。
//
// 设计取舍（用户群中文，i18n 为最低优先级 → 只做框架，不搞 key 改造）：
//  - t('中文原文') 直接以中文原文查目标语言词典，未收录时原样返回 —— zh 永不缺翻译，
//    任何调用点零风险接入（不 wrap 也是合法 zh 界面），存量文案可增量迁移；
//  - 动态数值用 {n} 具名占位插值，中英文语序各自独立；
//  - 语言：localStorage 'fntv-lang' 显式选择；无显式选择一律默认中文（lc-1291：不再按
//    navigator.language 探测成英文——英文系统首装也应是中文界面，英文由设置面板手动切换）；
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

    // ── 设置面板：左侧分类导航 ──
    '通用': 'General',
    '外观': 'Appearance',
    '播放': 'Playback',
    '弹幕': 'Danmaku',
    '账号同步': 'Account sync',
    '网络': 'Network',
    '手柄': 'Gamepad',
    '诊断与日志': 'Diagnostics & logs',
    '关于': 'About',

    // ── 设置面板：分组标题 ──
    '调试日志': 'Debug log',
    '网络与代理': 'Network & proxy',
    '界面与浏览': 'Interface & browsing',
    '更新与维护': 'Updates & maintenance',
    '播放器': 'Player',
    '退出行为': 'Exit behavior',
    '语言 / Language': 'Language',
    'B站弹幕': 'Bilibili danmaku',
    'Bangumi 登录': 'Bangumi login',
    'TMDB API Key': 'TMDB API Key',
    'TMDB 免梯子直连（实验）': 'TMDB direct access (experimental)',
    '豆瓣同步': 'Douban sync',
    'Trakt 同步': 'Trakt sync',
    '弹弹play': 'dandanplay',
    '自建弹幕接口（danmu_api）': 'Self-hosted danmaku API (danmu_api)',
    '弹幕屏蔽与样式': 'Danmaku blocking & style',
    '插帧（AI 补帧）': 'Frame interpolation (AI)',
    '渲染画质': 'Render quality',
    '诊断信息': 'Diagnostics',
    '跳过片头片尾': 'Skip intro / outro',
    '手柄设置': 'Gamepad settings',
    '主题与外观': 'Theme & appearance',
    '系统桌面': 'System desktop',
    '自定义代理': 'Custom proxy',
    '轮播图 Logo': 'Carousel logo',

    // ── 播放器内弹幕面板（danmakuWeb.ts 控制栏「弹幕」入口的 hover 弹窗）──
    '弹幕…': 'Danmaku…',
    '来源详情': 'Source details',
    '弹幕样式': 'Danmaku style',
    '弹幕加载中…': 'Loading danmaku…',
    '粗体': 'Bold',
    '字号': 'Font size',
    '描边': 'Outline',
    '阴影': 'Shadow',
    '滚动时长（越大越慢）': 'Scroll duration (larger = slower)',
    '透明度': 'Opacity',
    '显示范围': 'Display area',

    // ── 设置面板：开关 ──
    '下载代理': 'Download proxy',
    '隐藏原始播放按钮': 'Hide original play button',
    'NAS 本地网盘代理': 'NAS local drive proxy',
    '鼠标滚轮横向滚动': 'Wheel horizontal scroll',
    '默认开启插帧（启动即生效）': 'Interpolation on by default (at startup)',
    '启用豆瓣同步': 'Enable Douban sync',
    '启用自定义代理': 'Enable custom proxy',
    '启用免梯子直连': 'Enable direct access (no proxy)',
    '启用 MPV B站弹幕搜索': 'Enable MPV Bilibili danmaku search',
    '启用 Bangumi 集数同步': 'Enable Bangumi episode sync',
    '自动跳过片头片尾': 'Auto-skip intro / outro',
    '启用手柄控制': 'Enable gamepad control',
    '实时同步播放（scrobble）': 'Real-time scrobble',
    '轮播图标题替换为 Logo': 'Replace carousel title with logo',

    // ── 设置面板：按钮 ──
    '检查更新': 'Check for updates',
    '历史版本': 'Version history',
    '应用补丁': 'Apply patch',
    '回滚补丁': 'Roll back patch',
    '测试更新': 'Test update',
    '版号切换': 'Switch version',
    '选择文件': 'Choose file',
    '清空': 'Clear',
    'ICC 校色：开': 'ICC calibration: on',
    '自定义登录页面背景图': 'Custom login background',
    '扫码登录': 'Scan to log in',
    '退出登录': 'Log out',
    '保存 Cookie': 'Save Cookie',
    '保存': 'Save',
    '清除': 'Clear',
    '从 CheckTMDB 更新 IP': 'Update IP from CheckTMDB',
    '保存凭证': 'Save credentials',
    '清除凭证': 'Clear credentials',
    '连接 Trakt': 'Connect Trakt',
    '立即同步观影记录': 'Sync watch history now',
    '断开连接': 'Disconnect',
    '打开弹幕文件夹': 'Open danmaku folder',
    '测试配置': 'Test settings',
    '超时(ms)': 'Timeout (ms)',
    '重复次数': 'Repeats',
    '测试关键词': 'Probe keyword',
    '片名或关键词': 'A title you watch',
    '端到端三跳（条目→分集→弹幕）': 'End-to-end chain (anime → episodes → comments)',
    '试代理旁路': 'Try proxy fallback',
    '运行分层诊断': 'Run layered diagnostics',
    '明细日志（逐层附请求原始信息）': 'Verbose log (per-layer request detail)',
    'B站弹幕搜索': 'Bilibili search',
    '手动搜索': 'Manual search',
    '清除弹幕': 'Clear danmaku',
    '已清除 ✓': 'Cleared ✓',
    '已手动清除（自动匹配记忆已重置；用「手动搜索」重新选定，或重启应用重跑自动匹配）':
        'Cleared manually (auto-match memory reset; re-pick via Manual search, or restart the app to re-run auto matching)',
    '搜索': 'Search',
    '正在搜索…': 'Searching…',
    '展开后自动按当前番名搜索，也可改关键词重搜': 'Searches the current title automatically when opened; edit the keyword to re-search',
    '没有可用的搜索结果': 'No usable results',
    '请输入搜索关键词': 'Enter a keyword to search',
    '搜索异常': 'Search error',
    '选定失败': 'Selection failed',
    '（使用中）': ' (in use)',
    '正在诊断…': 'Diagnosing…',
    '诊断完成': 'Diagnostics done',
    '诊断失败': 'Diagnostics failed',
    '已停止': 'Stopped',
    '（已停止显示：本轮探测仍在后台跑完并写入日志）': '(Display stopped: this run still finishes in the background and is written to the log)',
    '连不上时点「运行分层诊断」，它逐层给出根因。关键词建议填正在看的片名：服务端搜新词要回源多平台，远慢于搜已缓存词 —— 这就是「时好时坏」的来源。':
        'When it fails, run the layered diagnostics below — it attributes the cause layer by layer. Set the keyword to a title you actually watch: a brand-new keyword makes the server fan out to upstream platforms, far slower than a cached one — the usual cause of "it works sometimes".',
    '刷新': 'Refresh',
    '复制': 'Copy',
    '已复制': 'Copied',
    '已选中，请按 Ctrl+C': 'Selected — press Ctrl+C',
    '复制失败': 'Copy failed',
    '日志文件': 'Log file',
    '报错日志': 'Error log',
    '导出日志文件': 'Export log file',
    'MPV 播放器日志': 'MPV player log',
    '检测': 'Detect',
    '恢复默认': 'Restore defaults',
    '重置为自动': 'Reset to auto',
    '测试连接': 'Test connection',
    '关闭代理': 'Disable proxy',
    '立即同步已观看列表': 'Sync watched list now',
    '重试': 'Retry',
    '立即应用': 'Apply now',
    '确定': 'OK',

    // ── 设置面板：分段控件选项 ──
    '浅色': 'Light',
    '深色': 'Dark',
    '跟随系统': 'System',
    '直接退出': 'Quit',
    '最小化到托盘': 'Minimize to tray',
    '每次询问': 'Ask every time',
    '竖向轮播': 'Vertical',
    '横向轮播': 'Horizontal',
    '堆叠切换': 'Stack',
    '立体堆叠': '3D stack',
    '首页轮播图样式': 'Carousel style',
    '主题模式': 'Theme mode',

    // ── 弹幕屏蔽类型 ──
    '顶部弹幕': 'Top',
    '底部弹幕': 'Bottom',
    '滚动弹幕': 'Scrolling',
    '逆向弹幕': 'Reverse',
    '高级弹幕': 'Advanced',
    '彩色弹幕': 'Colored',

    // ── 手柄按键选项 / 行 / 滑杆 ──
    'LB（左肩键）': 'LB (left bumper)',
    'RB（右肩键）': 'RB (right bumper)',
    'LT（左扳机）': 'LT (left trigger)',
    'RT（右扳机）': 'RT (right trigger)',
    '播放 / 暂停（默认 A）': 'Play / pause (default A)',
    '快退 (5s)（默认 LB）': 'Seek back 5s (default LB)',
    '快进 (5s)（默认 RB）': 'Seek forward 5s (default RB)',
    '倍速 -（默认 LT）': 'Speed - (default LT)',
    '倍速 +（默认 RT）': 'Speed + (default RT)',
    '下一集（默认 Y）': 'Next episode (default Y)',
    '返回 / 关闭（默认 B）': 'Back / close (default B)',
    '勾选 / 开关（默认 X）': 'Select / toggle (default X)',
    '摇杆死区（归零阈值）': 'Stick deadzone',
    '方向触发阈值': 'D-pad threshold',
    '长按连跳延迟 (ms)': 'Hold turbo delay (ms)',
    '连跳间隔 (ms)': 'Turbo interval (ms)',
    '高级设置（灵敏度 / 连跳）': 'Advanced (sensitivity / turbo)',
    '▶ 高级设置（灵敏度 / 连跳）': '▶ Advanced (sensitivity / turbo)',
    '播放控制（播放中生效）': 'Playback controls (while playing)',
    '界面导航（未播放时生效）': 'UI navigation (when not playing)',

    // ── 设置面板：标签 / 提示 / 状态 ──
    '⚙ 设置': '⚙ Settings',
    '界面语言 / Interface language': 'Interface language',
    '登录页背景图': 'Login page background',
    'MPV 路径（留空则使用应用内置）': 'MPV path (leave empty to use bundled)',
    'PotPlayer 路径（留空则使用应用内置）': 'PotPlayer path (leave empty to use bundled)',
    '应用内置（已随安装包分发，无需本机安装）': 'Bundled (shipped with the app, no local install needed)',
    '默认 MPV 着色器': 'Default MPV shaders',
    '默认播放器（直接播放时使用）': 'Default player (used for direct play)',
    '解锁码': 'Unlock code',
    '请输入解锁码': 'Enter unlock code',
    '解锁代码错误，请重新输入': 'Wrong unlock code, try again',
    '解锁码验证失败，请重试': 'Unlock code verification failed, retry',
    '例如 9.9.9': 'e.g. 9.9.9',
    '提交中…': 'Submitting…',
    '🔧 测试更新 / 版号切换：开发者测试通道，需解锁码（普通用户无需操作）': '🔧 Test update / version switch: developer channel, needs an unlock code (not for regular users)',
    '手动粘贴 Cookie（B站风控/扫码失效时用）': 'Paste Cookie manually (when Bilibili QR / risk-control fails)',
    '粘贴浏览器里 B站的 Cookie 字符串（含 SESSDATA 等）': 'Paste the Bilibili Cookie string from your browser (incl. SESSDATA)',
    '弹幕聚合阈值（单视频弹幕少于此数则合并多个源）': 'Danmaku merge threshold (merge sources below this count)',
    '填入你的 Bangumi Access Token 以启用 Bangumi 关联功能。': 'Enter your Bangumi Access Token to enable Bangumi features.',
    '粘贴 Bangumi Access Token': 'Paste Bangumi Access Token',
    '同步阈值（播放进度 %）': 'Sync threshold (progress %)',
    '已保存 Token': 'Token saved',
    '已清除 Token': 'Token cleared',
    '保存失败': 'Save failed',
    '清除失败': 'Clear failed',
    '填入你的 TMDB API Key（或 v4 Read Access Token）以启用「热门剧更新」中的 TMDB 电影/剧集数据源。': 'Enter your TMDB API Key (or v4 Read Access Token) to enable TMDB movie/show sources in "Trending".',
    '粘贴 TMDB API Key / Read Access Token': 'Paste TMDB API Key / Read Access Token',
    '已保存 TMDB Key': 'TMDB Key saved',
    '已清除 TMDB Key': 'TMDB Key cleared',
    '开启后用固定 IP 覆盖 DNS 解析，绕过污染直连 TMDB（无需梯子）。IP 来自 CheckTMDB 项目，CDN 边缘节点可能变动，可点「更新 IP」拉取最新，或手动填写。': 'When on, a fixed IP overrides DNS to reach TMDB directly (no proxy). IPs come from CheckTMDB; edge nodes may change — click "Update IP" or fill manually.',
    'api IP（如 65.8.20.79）': 'api IP (e.g. 65.8.20.79)',
    'img IP（如 65.8.20.8）': 'img IP (e.g. 65.8.20.8)',
    '正在从 CheckTMDB 拉取最新 IP…': 'Fetching latest IP from CheckTMDB…',
    '更新失败': 'Update failed',
    '选择「热门剧更新」浮层的数据源。豆瓣国内直连、免 Key、零配置；TMDB 数据更全但需 Key 且可能被墙（需免梯子直连/代理）。': 'Choose the data source for the "Trending" overlay. Douban works in China with no key; TMDB is richer but needs a key and may be blocked.',
    '✓ 已选豆瓣：国内直连、免 Key、零配置，无需任何额外设置。「热门剧更新」浮层将展示豆瓣热门影视。': '✓ Douban selected: direct in China, no key, zero config. "Trending" shows Douban picks.',
    '请在弹出的窗口中用豆瓣 App 扫码…': 'Scan the QR with the Douban app in the popup…',
    '打开登录窗口失败': 'Failed to open login window',
    '手动粘贴 Cookie（豆瓣风控/扫码失效时用）': 'Paste Cookie manually (when Douban QR / risk-control fails)',
    '粘贴浏览器里豆瓣的 Cookie 字符串（含 dbcl2 等）': 'Paste the Douban Cookie string from your browser (incl. dbcl2)',
    '已观看列表 → 豆瓣「看过」': 'Watched list → Douban "seen"',
    '读取飞牛「已观看」列表，批量标记到豆瓣（已标记的会跳过，不重复打）。': 'Read the fnOS "watched" list and batch-mark to Douban (already-marked items are skipped).',
    '正在扫描飞牛「已观看」列表…（需加载列表页，约 10 秒）': 'Scanning fnOS "watched" list… (loads the list page, ~10s)',
    '自动同步间隔(分钟, 0=关闭):': 'Auto-sync interval (min, 0=off):',
    '把观影记录（看完的电影 / 已看的剧集集数）同步到 trakt.tv 历史。需要在 Trakt 应用管理页(trakt.tv/oauth/applications)注册应用，把 Client ID 与 Secret 填到这里，再点「连接 Trakt」完成设备授权。': 'Sync watch history (finished movies / watched episodes) to trakt.tv. Register an app at trakt.tv/oauth/applications, paste Client ID & Secret, then click "Connect Trakt".',
    '凭证已保存，尚未连接。': 'Credentials saved, not connected.',
    '未配置。': 'Not configured.',
    'Client ID 与 Secret 均必填（清除请用「清除凭证」）。': 'Both Client ID and Secret are required (use "Clear credentials" to remove).',
    '播放时实时打点到 Trakt（开始/暂停/看完≥80% 自动记录），需先连接 Trakt。': 'Scrobble to Trakt while playing (start / pause / ≥80% watched). Connect Trakt first.',
    '正在获取设备码…': 'Fetching device code…',
    '1. 打开授权页：': '1. Open the auth page:',
    '2. 输入授权码：': '2. Enter the code:',
    '3. 授权后本窗口自动完成连接（等待中…）': '3. This window connects automatically once approved (waiting…)',
    '等待授权中…': 'Waiting for approval…',
    '已连接 Trakt ✓': 'Connected to Trakt ✓',
    '同步中…（扫描媒体库并写入 Trakt，可能需要一点时间）': 'Syncing… (scanning library and writing to Trakt, may take a while)',
    '「弹幕样式」（透明度/字号/描边等）请在播放时通过 MPV 底部控制栏调整；本卡管理 B站 弹幕的屏蔽。': 'Adjust danmaku style (opacity / size / outline) via the MPV bottom bar during playback; this card handles Bilibili danmaku blocking.',
    '登录与 Cookie、聚合阈值': 'Login, Cookie & merge threshold',
    // [lc-1226] 弹幕来源与优先级（三来源总览卡 + 网页「来源详情」逐源说明）
    '弹幕来源与优先级': 'Danmaku sources & priority',
    '① 弹弹play': '① Dandanplay',
    '② 自建弹幕接口（danmu_api）': '② Self-hosted API (danmu_api)',
    '③ 内置 B站': '③ Built-in Bilibili',
    '① 自建弹幕接口（danmu_api）': '① Self-hosted API (danmu_api)',
    '② 内置 B站': '② Built-in Bilibili',
    '③ 弹弹play': '③ Dandanplay',
    '首选源。开启并填好地址后最先取弹幕，只认精确匹配（番名与季号完全一致），命中即用。': 'Primary source. Fetches danmaku first once enabled with a valid address; accepts exact matches only (title and season must match exactly).',
    '次选源。自建源未命中时用它：按番名+集数匹配 B站 番剧区/视频区，是本应用一直以来的默认链路。': 'Secondary source. Used when the self-hosted API misses: matches the Bilibili bangumi/video sections by title + episode number — the default path this app has always used.',
    '兜底源（仅 MPV）。先用来识别剧集拿到规范番名；其弹幕库只在前两者都拿不到弹幕时才取，避免过度消耗内置共享配额。填了自己的专属凭证则立即参与。': 'Fallback (MPV only). Used first to identify the episode and obtain a canonical title; its danmaku library is fetched only when neither source above finds danmaku, avoiding overuse of the shared built-in quota. With your own credential it participates immediately.',
    '取弹幕按 ① → ② → ③ 依次尝试，命中即停，全部未命中才判定为无弹幕。弹弹play 的剧集识别在最前（它提供规范番名）。播放时可在 MPV「B站弹幕配置」或网页播放器弹幕弹窗的「来源详情」里逐条查看各源的结果。': 'Danmaku is fetched in order ① → ② → ③, stopping at the first hit; only if all miss is it treated as "no danmaku". Dandanplay\'s episode identification runs first (it supplies the canonical title). During playback, see per-source results in MPV\'s "Bilibili danmaku config" or the web player\'s danmaku popup → "Source details".',
    '弹幕按以下顺序依次尝试，命中即停：': 'Danmaku sources are tried in this order, stopping at the first hit:',
    '弹弹play（仅 MPV）': 'Dandanplay (MPV only)',
    '内置 B站': 'Built-in Bilibili',
    'MPV 用于识别剧集并取弹幕；网页播放器不经过它': 'Used by MPV to identify the episode and fetch danmaku; the web player does not use it',
    '首选源：只认精确匹配，命中即用': 'Primary source: exact matches only, used on a hit',
    '次选源：模糊匹配，与 MPV 弹幕同源': 'Secondary source: fuzzy matching, same source as MPV danmaku',
    '兜底源（仅 MPV）：前两者都拿不到弹幕时才启用': 'Fallback (MPV only): used only when neither source above finds danmaku',
    '不适用于网页播放器（弹弹play 由 MPV 侧使用）': 'Not applicable to the web player (dandanplay is used by MPV)',
    '自建源已命中，无需兜底': 'Self-hosted source hit — no fallback needed',
    '本次弹幕即由此源提供': 'This session\'s danmaku came from this source',
    '提供了本次弹幕': 'Provided this session\'s danmaku',
    '尝试过但未命中': 'Tried but did not match',
    '{n} 条': '{n} items',
    '开放 API 凭证（AppId / Secret，可选）': 'Open API credentials (AppId / Secret, optional)',
    '服务地址与连通测试': 'Service address & connection test',
    '屏蔽类型、屏蔽词、弹幕文件夹': 'Block types, keywords & danmaku folder',
    '屏蔽类型与屏蔽词于下一次 B站 弹幕加载时生效。': 'Block types and keywords take effect on the next Bilibili danmaku load.',
    '弹幕默认由「自建弹幕接口」与「内置 B站」提供，通常无需填写。这里填的是可选的弹弹play 专属凭证：未填时弹弹play 仅作兜底（前两者都拿不到弹幕才用它）；填了则弹弹play 立即参与并优先取弹幕库（消耗你自己在弹弹play开放平台的配额）。两项都填才生效，清除后回到兜底状态。下次 MPV 播放时生效。': 'Danmaku is normally provided by the self-hosted API and built-in Bilibili, so this section is usually unnecessary. It holds an optional dandanplay credential: when empty, dandanplay is only a fallback (used solely when neither of the other two can find danmaku); when filled, dandanplay participates immediately and fetches its danmaku library first, using your own dandanplay open-platform quota. Both fields are required to take effect; clearing reverts to fallback mode. Applies on the next MPV playback.',
    'AppId 与 Secret 两项都必填（清除请用「清除凭证」）。': 'Both AppId and Secret are required (use "Clear credentials" to remove).',
    '已保存，下次 MPV 播放时生效。': 'Saved; takes effect on next MPV play.',
    '已清除，回落脚本内置凭证，下次 MPV 播放时生效。': 'Cleared; falls back to the built-in credential on next MPV play.',
    '已保存自定义凭证，下次 MPV 播放时生效。': 'Custom credential saved; takes effect on next MPV play.',
    '已配置专属凭证（弹弹play 立即参与并优先取弹幕库）': 'Personal credential configured (dandanplay participates immediately and fetches its library first)',
    '未配置 —— 弹弹play 仅作兜底（自建源与内置 B站 都拿不到弹幕时才启用）': 'Not configured — dandanplay is only a fallback (used when neither the self-hosted API nor built-in Bilibili finds danmaku)',
    '已开启但未填服务地址 —— 展开「服务地址与连通测试」填写后点保存。': 'Enabled but no service address — open "Service address & connection test", fill it in and save.',
    '填入 NAS 上部署的 danmu_api 服务地址（聚合多平台弹幕，密度高于单源 B站）。开启后作为优选源，未命中自动降级内置 B站；下次 MPV 播放时生效。': 'Enter the danmu_api service address deployed on your NAS (aggregates multiple platforms, denser than Bilibili alone). When on it becomes the preferred danmaku source and falls back to the built-in Bilibili fetch on a miss. Takes effect on next MPV play.',
    '启用自建弹幕接口（优先于 B站弹幕）': 'Use the self-hosted danmaku API (preferred over Bilibili)',
    '已保存并启用，下次 MPV 播放时生效。': 'Saved and enabled; takes effect on next MPV play.',
    '已保存并关闭，回落内置 B站 弹幕获取。': 'Saved and disabled; falls back to the built-in Bilibili fetch.',
    '正在测试连接…': 'Testing connection…',
    '连接正常': 'Connection OK',
    '连接失败': 'Connection failed',
    '已启用自建弹幕接口作为优选源，未命中时自动降级到 B站。': 'Self-hosted danmaku API enabled as the preferred source; falls back to Bilibili on a miss.',
    '插帧引擎': 'Interpolation engine',
    '引擎路径（SVP 目录 / RIFE 可执行文件，留空=自动探测）': 'Engine path (SVP dir / RIFE binary, empty = auto-detect)',
    '播放时可在 MPV 底部控制栏点「插帧」按钮实时开关。选 SVP/RIFE 需本机已安装对应引擎并配好，未安装时自动回退 MPV 内置平滑运动；选 N 卡需 RTX50+ 并在 NVIDIA App 开启「Smooth Motion（视频）」。': 'Toggle interpolation live via the "Interpolation" button on the MPV bottom bar. SVP/RIFE need the engine installed locally (falls back to MPV built-in otherwise); NVIDIA needs RTX50+ with "Smooth Motion" enabled in NVIDIA App.',
    '渲染预设': 'Render preset',
    '渲染管线(vo)变更需重启应用后生效；画质档位亦可被「着色器/ICC」设置叠加。': 'Render pipeline (vo) changes need an app restart; the quality tier can be further adjusted by shader / ICC settings.',
    '点击「刷新」加载诊断信息…': 'Click "Refresh" to load diagnostics…',
    '组件日志（按组件单独控制）': 'Component logs (per-component control)',
    '关闭时控制台仅显示 警告/错误；开启后可单独控制各组件是否输出详细日志(INFO/DEBUG)。': 'When off, the console shows warnings/errors only; when on, control verbose logging (INFO/DEBUG) per component.',
    '自动加载飞牛/影片库跳过数据；可在播放时显示「跳过片头/片尾」按钮，或开启后自动跳过。': 'Auto-load fnOS / library skip data; show "Skip intro/outro" buttons during playback, or auto-skip when enabled.',
    '支持使用手柄（Xbox/PS/通用）遥控：播放中控制播放器（播放暂停/快退快进/倍速/下一集），未播放时在影视界面导航（方向键/确认/返回）。可自定义各功能对应的按键。': 'Use a gamepad (Xbox / PS / generic): control playback (play-pause / seek / speed / next) while playing, navigate the UI otherwise. Buttons are remappable.',
    '未检测到手柄（先按一下手柄任意键激活）': 'No gamepad detected (press any button to activate)',
    '死区越大摇杆需推越大力才响应；方向阈值同理。长按延迟/连跳间隔控制白框连续移动节奏（仅焦点导航时）。保存后立即生效。': 'A larger deadzone needs a stronger stick push; same for the d-pad threshold. Hold delay / turbo interval set the focus-box move rhythm (focus nav only). Applies immediately on save.',
    '已保存 ✓ 立即生效': 'Saved ✓ applied immediately',
    '保存失败：手柄插件未就绪': 'Save failed: gamepad plugin not ready',
    '已恢复默认 ✓': 'Defaults restored ✓',
    '🎬 飞牛影视': '🎬 fnOS TV',
    '基于飞牛影视（fnOS TV）打造的增强桌面客户端，采用 Electron + 亚克力玻璃 UI。支持 MPV 播放器、B站弹幕、自定义透明度与模糊效果。': 'An enhanced desktop client for fnOS TV, built with Electron + an acrylic glass UI. Supports MPV, Bilibili danmaku, custom transparency & blur.',
    '版本：获取中…': 'Version: loading…',
    '🔗 GitHub 项目地址': '🔗 GitHub project',
    '已重置为自动（当前影视连接根路径）': 'Reset to auto (current TV connection root)',
    '重置失败': 'Reset failed',
    '为 Bangumi 每日放送、TMDB（影视发现/海报）等数据源指定代理入口。支持 HTTP / HTTPS / SOCKS5，可填账号密码鉴权。优先级低于环境变量 HTTPS_PROXY（已设环境变量则它先生效）。开启开关并填写地址后才生效。': 'Proxy endpoint for Bangumi daily / TMDB (discovery / posters) sources. HTTP / HTTPS / SOCKS5 with optional auth. Lower priority than the HTTPS_PROXY env var. Takes effect after enabling and filling the address.',
    '主机:端口，如 127.0.0.1:7890': 'host:port, e.g. 127.0.0.1:7890',
    '账号（可选）': 'Username (optional)',
    '密码（可选）': 'Password (optional)',
    '开启后，首页轮播图右侧的文字标题会被替换为 TMDB 的透明 Logo 图（仅当该剧集在 TMDB 有透明 Logo 时）。关闭则保留原始文字标题。': 'When on, the carousel text title is replaced by the TMDB transparent logo (only when available). Off keeps the original text title.',
    '搜索设置…（Ctrl+F）': 'Search settings… (Ctrl+F)',
    '已登录豆瓣 ✓': 'Douban logged in ✓',
    '未登录豆瓣（点"扫码登录"）': 'Douban not logged in (click "Scan to log in")',
    '状态获取失败': 'Failed to get status',
    '已登录 ✓': 'Logged in ✓',
    '未登录': 'Not logged in',
    '二维码库加载失败': 'QR library failed to load',
    '请用 B站 APP 扫码': 'Scan with the Bilibili app',
    '登录成功！': 'Login successful!',
    '二维码已过期，请重新点击扫码登录': 'QR expired, click scan to log in again',
};

let cachedLang: Lang | null = null;

/** 当前语言：localStorage 显式选择；无显式选择一律默认中文（lc-1291：首装不再按
 * navigator.language 探测——英文系统首次安装也直接中文，英文在设置面板手动切换）。 */
export function getLang(): Lang {
    if (cachedLang) return cachedLang;
    try {
        const v = localStorage.getItem(LS_KEY);
        if (v === 'zh' || v === 'en') {
            cachedLang = v;
            return cachedLang;
        }
    } catch { /* 隐私模式等 localStorage 不可用，走默认中文 */ }
    cachedLang = 'zh';
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
