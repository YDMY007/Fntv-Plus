# Fntv-Plus Wiki

欢迎来到 **Fntv-Plus** 的开发 Wiki。本 Wiki 面向**开发者与贡献者**，介绍项目架构、模块划分、构建调试与发布流程。

> - 普通用户请看 **《用户使用手册》**（仓库根目录 `用户使用手册.md`）。
> - 想快速了解功能与安装，请先看根目录 **`README.md`**。
> - 版本更新日志见本地 `CHANGELOG_vX.Y.Z.md`（由维护者手动上传，不入库）。

---

## 目录

- [1. 架构概览](#1-架构概览)
- [2. 目录结构](#2-目录结构)
- [3. 核心模块](#3-核心模块)
- [4. 构建与开发](#4-构建与开发)
- [5. 配置与持久化](#5-配置与持久化)
- [6. 调试日志](#6-调试日志)
- [7. 自动构建与发布](#7-自动构建与发布)
- [8. 常见问题（开发向）](#8-常见问题开发向)
- [9. 贡献约定](#9-贡献约定)

---

## 1. 架构概览

Fntv-Plus 是基于 **Electron** 封装飞牛影视 Web 端（fnOS TV）的第三方桌面客户端，整体分三层：

| 层 | 位置 | 职责 |
|----|------|------|
| **主进程** | `src/main` | 窗口生命周期、系统托盘、单实例锁、IPC 处理器，调用各业务模块 |
| **预加载** | `src/preload` | 在 `contextIsolation` 隔离上下文里桥接飞牛 Web 页面与 Node/Electron API，注入钩子 |
| **渲染层** | 飞牛影视 React SPA | 通过 preload 注入的桥接与客户端交互（设置面板、弹幕叠层等） |

业务功能以可复用模块形式放在 `src/modules`，各模块通过主进程 IPC 暴露给渲染层调用，避免直接在 Web 上下文里执行敏感逻辑。

---

## 2. 目录结构

完整树见 `README.md` 的「项目结构」一节，此处只列关键入口：

```text
src/
├── main/main.ts              # 程序入口：窗口、生命周期、托盘、单实例锁
├── main/handlers/            # IPC 处理器（core 核心 / plugins 功能）
├── preload/index.ts          # 预加载入口
├── modules/                  # 业务模块（见下节）
└── public/                   # 注入 HTML / CSS 模板

third_party/                  # 仅文本配置入库，二进制由 CI / go build 生成
├── fntv-mpv/                 # MPV 便携配置（uosc 脚本 / 着色器 / mpv.conf）
├── potplayer/                # 内置便携版 PotPlayer
├── proxy/                    # Go 代理源码（proxy.exe 构建时生成）
└── python/                   # 内置 embeddable Python（B站弹幕脚本运行时）

wiki/Home.md                  # 本文件
用户使用手册.md               # 终端用户手册
```

---

## 3. 核心模块

| 模块 | 职责 | 关键文件 |
|------|------|----------|
| `cert_trust` | 信任 NAS 自签 HTTPS 证书 | `index.ts` |
| `danmaku` | B站弹幕：获取 / 合并 / 叠层 / 字幕合并 | `biliDanmaku.ts`、`merge*.ts` |
| `fn_api` | 飞牛影视 API 封装（api / request / types） | `api.ts`、`request.ts` |
| `fn_config` | 配置持久化（AES-256 加密，存 `userData/config.json`） | `config.ts` |
| `logger` | 分级日志 + 敏感信息脱敏 | `index.ts` |
| `players` | 播放器抽象层（factory / index / types） | `players/impl/mpv.ts`、`players/impl/potplayer.ts` |
| `proxy` | NAS 代理服务（Go 编译 `proxy.exe`）+ `potctl` 进度助手 | `*.go`、`potctl` |
| `updater` | 更新检查（GitHub 直连 + 镜像兜底） | `updateChecker.ts` |

**同步类功能**：
- **豆瓣**：两条独立路径——播放进度→「在看」；飞牛「已观看列表」→「看过」。
- **Bangumi**：精确到单集（PUT episode），进度达阈值（默认 80%）自动标该集「看过」+ 条目标「在看」。

---

## 4. 构建与开发

### 环境要求
- Node.js 18+（推荐 22）
- Go（构建 NAS 代理 `proxy.exe` 时需要）
- Python 3（仅旧版弹幕搜索需要；新版已内置 embeddable Python，零配置）

### 常用命令
```bash
npm install            # 安装依赖
npm start              # 编译 TS + 编译 Go 代理 + 启动 Electron（调试）
npm run build:win      # 打包 Windows 安装包
npm run build:mac      # 打包 macOS dmg
npm run build:linux    # 打包 Linux AppImage
```

### ⚠️ 开发注意
- **单实例锁 + 系统托盘**：关闭窗口 ≠ 结束进程。改代码重启前先杀掉残留进程：
  ```powershell
  taskkill /f /im electron.exe
  ```
- **MPV 着色器出厂文件**：打包前务必把 `third_party/fntv-mpv/portable_config/mpv-user.conf` 重置为出厂默认（无 `glsl` 行 + `icc-profile-auto=yes`），否则 dev 模式下选过的画质会污染出厂文件（v3.3.0 曾因此带进非默认画质）。

---

## 5. 配置与持久化

- 所有用户配置（含 **B站 SESSDATA / 豆瓣 cookie / Bangumi token**）存于运行时 `userData/config.json`，使用 **AES-256** 加密。
- `userData` 路径由 `app.setPath('userData', USER_DATA_PATH)` 指向**仓库之外**的目录，因此**这些个人数据永不进 Git 仓库**。
- `config.ts` 中 `ENCRYPTION_KEY` 是本地加解密用的固定密钥（用于 app 自行解密），不是用户的个人凭证，无泄露风险。

---

## 6. 调试日志

- 开关：`config.debugEnabled`（主开关）+ `config.debugComponents`（组件白名单）。
- `logger.ts` 过滤规则（仅影响控制台输出，不影响日志文件）：`WARN` / `ERROR` 始终显示；`INFO` / `DEBUG` 受主开关 + 组件开关共同控制。
- 可过滤的组件：`douban` / `subtitle` / `danmaku` / `mpv` / `potplayer` / `media` / `embywall`。
- 设置面板提供「打开日志文件」与「导出日志文件」快捷操作，便于排查问题。

---

## 7. 自动构建与发布

构建流程定义在 `.github/workflows/release.yml`：

- **触发器**：`on.release.types: [published]` + `workflow_dispatch`（普通 push **不会**触发构建）。
- **维护者发版流程**：
  1. 本地 `npm run build:win` 构建 Windows 包；
  2. 在 GitHub **手动创建并发布 Release**（打 tag 如 `v3.4.0`、上传 Windows exe、填写说明）；
  3. Release 一经发布，CI 自动构建 **macOS dmg + Linux AppImage**，并**追加上传**到该 Release（不新建 Release、不改动标题与说明）。
- ⚠️ tag 必须指向 `release` 分支**已推送**的代码（CI 按 tag 检出来构建），顺序应为：先 push 代码 → 再发 Release。
- 自动构建产物命名统一为 `Fntv-Plus_${version}_${os}_${arch}.${ext}`（Linux x64 在上传前重命名为 `x86_64`，与手动发布的资产名一致）。

---

## 8. 常见问题（开发向）

**Q：修改代码后窗口没更新？**
A：单实例锁导致旧进程未退出。先 `taskkill /f /im electron.exe` 再 `npm start`。

**Q：`npm run build:win` 被拦截？**
A：在某些受限环境会被安全守卫拦截，可设置 `NODE_OPTIONS='--use-system-ca'` 绕过（仅构建期）。

**Q：播放黑屏？**
A：多为 MPV 着色器/滤镜配置非法导致视频链创建失败。打包前确认 `mpv-user.conf` 已重置为出厂默认；用户侧可删除 `userData` 下的 `mpv-user.conf` 恢复。

**Q：弹幕搜索报错 `spawn python ENOENT`？**
A：旧版本依赖系统 Python。新版已内置 embeddable Python 3.13 进安装包，正常零配置；若自行构建，确保 `third_party/python/` 已随包发布。

---

## 9. 贡献约定

- 分支：`release`。**提交不主动 push**（push 交给维护者或等明确指令）。
- 每次改动**自动本地 commit + 回退标识符 `lc-NNN`**，并写入 `本地commit/commits.md`（完整逐次改动记录，只增不删）。
- `本地commit/` 目录**纯本地、绝不推送 GitHub**（`.gitignore` 排除 + `git rm --cached` 双保险）。
- 提交信息不带 WorkBuddy 署名；不主动升版号。
- 版本更新文档（CHANGELOG）由维护者手动维护与上传，不入库。

---

*本 Wiki 随项目演进维护，如发现过时内容欢迎在仓库提出。*
