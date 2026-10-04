# 更新日志

## v3.3.5（2026-08-04）

> 本次更新大幅增强原生播放体验：原生网页播放器正式支持 B 站弹幕；接入 The Intro Database 实现片头片尾自动跳过；右下角新增「每日放送」实时影视浮层；同时引入插件机制为后续自定义化铺路。

### 🐛 问题修复（5 项）

- **修复 Go proxy 未就绪导致 PotPlayer 播放失败**（lc-324）：新增 Node 主进程兜底代理（fallbackProxy），彻底解决启动时序竞争导致的 PotPlayer 无法启动播放的问题。
- **修复原生网页弹幕不可见 / 控制栏按钮缺失 / 渲染卡死**（lc-327~329）：修复弹幕阈值不生效、控制栏开关按钮缺失、全透明导致页面卡死等问题，弹幕现在可正常显示，并新增「详情」弹窗按钮查看来源与登录态。
- **修复弹幕跨季错配**（lc-332）：弹幕匹配优先「季数 + 集数」精确匹配，根治不同季弹幕串台导致的错位。
- **修复 Cookie 过期无法识别导致弹幕数量受限**（lc-336/337）：拉取弹幕前校验 B 站登录态（nav isLogin），并在详情弹窗新增 Cookie 登录态标红提示（已登录绿 / 过期红 / 未登录红），一眼定位过期问题。
- **修复剧集模式下「同目录同名外挂字幕」被误杀**（lc-339）：字幕评分新增「同集信号」（SxxExx / 第 N 集），兼容季名表述差异（如「无职转生Ⅲ」vs「无职转生」），避免相关字幕被错误剔除。


### ⚡ 体验优化（4 项）

- **日志文件重复合并**（lc-325）：短时间内同一错误不再反复刷屏写入日志文件。
- **原生网页弹幕拉取提速**（lc-331）：根治约 1 分钟延迟，响应速度对齐 MPV 弹幕。
- **原生网页弹幕样式可调**（lc-333）：对齐 MPV 弹幕旋钮，支持字号 / 透明度 / 速度等参数调整。
- **主界面液态玻璃视觉**（mainwin.ts）：叠加液态玻璃质感，导航栏镜面高光、卡片湿润浮起、深色同步，界面更通透。

### ✨ 新增功能（4 项）

- **飞牛原生播放器支持显示 B 站弹幕**（lc-322~326）：原生网页播放器（飞牛原声）接入 B 站弹幕，控制栏新增弹幕开关，详情弹窗展示弹幕来源与 Cookie 状态。**弹幕脚本由 Python 改为纯 JS 实现**（`third_party/fntv-mpv/.../uosc_danmaku/bili_danmaku.js`，主进程 `biliRunner.ts` 以 `require` 方式运行），彻底移除 Python 运行时依赖，部署更轻、启动更快。
- **引入插件功能为后续自定义化添加配置**：新增 preload / 主进程 handler 插件自动注册机制（registerHook / registerHandler），为后续自定义插件与配置开放统一接入能力。
- **片头片尾跳过接入 The Intro Database 数据自动填充**（lc-313~318 / 338）：自动从 The Intro Database 获取片头片尾时间点并填充，免去手动设置；支持 v3 接口与多路兜底。
- **右下角每日放送接入 Bangumi /  TMDB / 豆瓣 实时热门影视数据**（hotUpdates / bangumiSync / tmdbSync）：右下角悬浮「🔥 每日放送」按钮，展示每日放送与热门影视；支持 Bangumi / TMDB / 豆瓣 多数据源切换，可按星期 / 热度 / 最新 / 剧集 / 电影排序，并支持「不感兴趣」屏蔽持久化。TMDB 需在设置面板填写自有 API Key（默认空，不内置密钥）。
- **TMDB 免梯子直连（实验）**（tmdbSync / config / embyWall）：针对 `api.themoviedb.org` 在部分网络环境被 DNS 污染、Electron/Node 默认不读系统代理导致无法直连的问题，新增「免梯子直连」开关——内置 CheckTMDB 每日更新的可用 IP 快照，通过自定义 DNS `lookup` 将 `api / image.tmdb.org` 解析到真实边缘 IP 直连（TLS 仍用原域名，证书不受影响）；海报同步经主进程代理拉取，图片一并打通。支持设置面板手动填写 IP 与一键「从 CheckTMDB 更新 IP」，并**自动每日（24h）跟进仓库最新可用 IP**，无需开启梯子即可使用 TMDB 数据源。与 `HTTPS_PROXY` 代理方案互斥、互不干扰。

---

## 💻 支持平台
- ✅ Windows (x64)
- ✅ macOS (Intel & Apple Silicon)
- ✅ Linux (x64 & ARM64)

### 📥 下载指南
| 平台 | 文件类型 | 说明 |
|------|----------|------|
| 💻 Windows | `.exe` | **由维护者手动上传至本 Release**（不通过自动构建） |
| 🍎 macOS | `.dmg` | 磁盘镜像，安装后执行: `sudo find "/Applications/Fntv-Plus.app" -exec xattr -d com.apple.quarantine {} \; 2>/dev/null` |
| 🐧 Linux | `.AppImage` | 便携应用，添加执行权限后直接运行。弹幕与播放器配置已内置，仅需自行安装 mpv（要求版本 > 0.37.0） |

> 💡 **Windows 版本由维护者手动上传**，本 Release 的 macOS / Linux 安装包由 GitHub Actions 自动构建并发布。

---
*自动构建于 GitHub Actions* 🤖
