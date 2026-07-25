# fntv-electron 美化版海报墙版桌面客户端

飞牛影视第三方桌面客户端，基于 Electron 封装飞牛影视（fnOS TV）Web 端，提供更好的桌面体验与增强功能。

<img src="resource/docs/simple.png" width="90%">

---

## 🍴 Fork 声明

> **本项目是 [QiaoKes/fntv-electron](https://github.com/QiaoKes/fntv-electron) 的 Fork 修改版。**
>
> - **上游项目**：基于飞牛影视（fnOS TV）Web 端封装的 Electron 桌面客户端。
> - **原项目版权**：归原作者 [QiaoKes](https://github.com/QiaoKes) 所有，遵循 [GPL-3.0](LICENSE) 许可证。
> - **本仓库（[YDMY007/Fntv-Plus](https://github.com/YDMY007/Fntv-Plus)）**：在上游基础上叠加了**桌面亚克力风格、原生窗口交互、侧栏设置面板、托盘精简、弹幕切集修复**等大量 UI / 体验增强，**已改动上游核心代码**（preload 注入与 main 主进程均有修改）。
> - **许可证继承**：本仓库沿用原项目的 GPL-3.0 许可证，完整条款见 [LICENSE](LICENSE) 文件。

> ⚠️ **免责声明**：本项目为第三方客户端，与飞牛影视官方无关。使用前请确保遵守相关服务条款与版权规定。

---

## ✨ 本仓库主要更新（相对上游的增强）

以下为在本仓库中新增 / 重构的功能，上游原版不包含：

- **🏠 首页轮播重构（核心改动）** — 用自绘轮播替换飞牛原生首页大图区，重点打磨视觉与交互：
  - **左图右文分区**：左侧 64% 大图 `object-fit:cover` 撑满无白边，右边缘渐隐与文字区自然融合，左上角浮动剧集 Logo 水印；右侧 36% 为浅蓝玻璃文字面板（`blur` + 左边框高光）。
  - **文字层级**：`✨ 最近更新` 标签徽章 → 标题（超大字重、完整不截断、防溢出换行）→ **两端渐隐淡蓝细线**（透明 → 蓝 → 透明）→ 简介（`-webkit-line-clamp` 多行截断省略号、首行缩进 2em）→ 沉底「开始观看」蓝色渐变按钮（带播放图标）。
  - **纵向轮播**：上→下纵向切换动画；右侧纵向药丸指示点（点击可跳转、当前点高亮）；6 秒自动轮播、鼠标悬停暂停、支持上下拖拽切换。
  - **原生 SPA 路由**：「开始观看」走飞牛 `pushState + popstate` 路由，避免整页刷新导致详情页侧栏交互丢失。
  - **简介异步鉴权补齐**：主进程生成 Authx 签名 → 渲染进程带 cookie 拉取详情 API，自动补全缺失的剧集简介。
  - 容器 16:9 圆角亚克力，整体融入「透桌面」风格。

- **🌈 全网透明亚克力风格** — 整个客户端改为透桌面粉紫半透亚克力（重构 Electron 主窗口为 `transparent` 透明窗口，让桌面背景透出）。
- **⚙ 侧栏「设置」面板** — 侧栏底部新增「⚙ 设置」按钮，点击弹出**居中浅色半透面板**。
- **📋 托盘菜单精简** — 托盘右键菜单只保留「退出」，其余功能全部收进侧栏设置面板。
- **🌗 锁死浅色主题** — 删除设置页主题模式切换，固定浅色，避免飞牛暗色模式与本客户端亚克力风格冲突。
- **🔧 侧栏实时调节** — 侧栏内透明 / 模糊滑块，实时调节客户端亚克力强度（写入 localStorage 持久化）。

---

## 📦 安装方法

### 方式一：预编译版本

前往本仓库 [Releases 页面](https://github.com/YDMY007/Fntv-Plus/releases) 下载最新版本：

- 文件名：`FNMedia_${version}_${os}_${arch}.${ext}`
  - `version`：版本号
  - `os`：操作系统
  - `arch`：系统架构
  - `ext`：文件扩展名（Windows 为 `.exe`）

Windows 直接安装即可使用；macOS / Linux 自行参考 MPV 安装说明。

### 方式二：本地打包

```bash
# 1. 安装依赖（含 Go 1.21+，用于编译本地代理）
npm install

# 2. 打包 Windows 安装包（会先 tsc 编译 + 编译代理）
npm run build:win
```

> **调试运行**：`npm start`（等价于 `clean && build:proxy:win && tsc && electron .`）。
> ⚠️ 本客户端使用单实例锁 + 系统托盘，**关窗口 ≠ 关进程**。重新调试前请先结束残留的 `electron.exe`：
> ```powershell
> taskkill /f /im electron.exe
> ```

---

## 🎯 主要功能（继承自上游）

- **原生桌面体验** — 基于飞牛影视 Web 端构建的桌面应用，提供类原生体验。
- **多账户管理** — 支持自动登录，支持多账户管理，自由切换账户和服务器。
- **远程访问** — 支持使用 FN Connect，通过 FN ID 登录实现远程访问。
- **硬解播放** — 使用 MPV 播放器，支持 H264 / HEVC / VP9 / AV1 等编码格式。
- **直链播放** — 适配官方直链 / STRM 播放，默认使用 302 重定向，可在侧栏「设置」调整为 NAS 代理模式。
- **进度回传** — MPV 播放器支持实时将进度回传到飞牛服务器。
- **弹幕支持** — MPV 播放器支持弹幕自动匹配加载，无法匹配时支持手动搜索。
- **视频增强** — 内置 anime4K 着色器以及对应预设模式。
- **智能跳过** — 可在 MPV 播放器界面设置，支持三种跳过片头片尾模式：章节检查、手动设置片头片尾、快捷键跳过固定时长。
- **跨平台支持** — 支持 Windows、macOS 和 Linux。

---

## ⌨️ MPV 播放器

1. **快捷键**

```text
部分快捷键兼容 PotPlayer
查看安装目录下：
third_party\fntv-mpv\portable_config\input.conf
```

2. **MPV 配置**由以下仓库单独管理：[fntv-mpv-config](https://github.com/QiaoKes/fntv-mpv-config)
3. **预设着色器方案**：[mpv.conf](https://github.com/QiaoKes/fntv-mpv-config/blob/release/custom_config/mpv/mpv.conf)

---

## 🙏 特别感谢

本项目的上游与依赖参考以下开源项目：

- [QiaoKes/fntv-electron](https://github.com/QiaoKes/fntv-electron) - 上游项目（本仓库 Fork 来源）
- [enable-chromium-hevc-hardware-decoding](https://github.com/StaZhu/enable-chromium-hevc-hardware-decoding) - Chromium HEVC 硬解码支持
- [electron-media-patch](https://github.com/5rahim/electron-media-patch) - Electron 硬解码补丁
- [fnToPotplayer](https://github.com/gudqs7/fnToPotplayer) - 飞牛影视调用 PotPlayer
- [fnos-tv](https://github.com/thshu/fnos-tv) - fnos-tv 支持弹幕的飞牛影视
- [mpv 弹幕插件](https://github.com/Tony15246/uosc_danmaku) - uosc_danmaku 基于 uosc 的弹幕插件

---

## 📄 许可证

本项目采用 [GPL-3.0 许可证](LICENSE)。

- **原项目版权**：Copyright (c) 原作者 [QiaoKes/fntv-electron](https://github.com/QiaoKes/fntv-electron)
- **本仓库修改署名**：YDMY007（Fork 修改版，含桌面亚克力风格 / 原生窗口交互 / 侧栏设置面板 / 托盘精简 / 弹幕切集修复等增强）
