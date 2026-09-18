# Fntv-Plus 匿名统计 / 反馈服务端

一个 Cloudflare Worker 单文件，负责两件事：

1. **`/ping`** —— 客户端每天上报一次「今天我在用」，用来统计**有多少人在用**（总人数 / 日活 / 周活 / 月活 / 版本分布）。
2. **`/feedback`** —— 应用内 Bug 反馈 + 日志上传（用户手动触发，日志存 R2）。

免费额度完全够用：Workers 10 万请求/天、D1 500 万行读/天、R2 10GB。

---

## 一、采集了什么 / 没采集什么

### 采集（`/ping`，每天最多一次）

| 字段 | 说明 |
| --- | --- |
| `aid` | 客户端本地 `crypto.randomUUID()` 随机生成的匿名 ID，与账号、设备、机器码、安装路径**全部无关**；用户可在设置里一键重置 |
| `v` | 应用版本号 |
| `os` / `arch` | 操作系统与 CPU 架构（Windows / macOS / Linux，x64 / arm64） |
| `d` | 本地日期 |

### 不采集

- **不读、不存 IP**（worker 里连 `cf-connecting-ip` 都不碰）
- 不读 User-Agent
- 不采集账号、媒体库、文件路径、设备名、窗口尺寸、使用时长、观看了什么
- 服务端按 `(aid, 日期)` 主键去重 → 只能算出「人数」，**无法还原某个人的行为轨迹**

反馈内容是用户自己写的，日志在上传前已在客户端脱敏（token / cookie / 密码 / 密钥 / 手机号 / 邮箱打码，本机用户名路径打码）；日志里保留 NAS 地址与域名——排查直连/代理问题必须靠它，且不含凭据，UI 上已明确告知用户。

---

## 二、部署（约 5 分钟）

```bash
cd stats-server

# 1. 登录 Cloudflare（浏览器授权）
npx wrangler login

# 2. 建 D1 数据库，把输出的 database_id 填进 wrangler.toml
npx wrangler d1 create fntv-stats

# 3. 建表
npx wrangler d1 execute fntv-stats --remote --file=schema.sql

# 4. 建 R2 桶（存反馈日志）
npx wrangler r2 bucket create fntv-stats-logs

# 5. 设置查看统计用的口令（自己随便想一个，记下来）
npx wrangler secret put STATS_TOKEN

# 6. 部署
npx wrangler deploy
```

部署完会给你一个地址，形如 `https://fntv-stats.<你的子域>.workers.dev`。

---

## 三、客户端接入

把上一步的地址填进 `src/main/handlers/plugins/usageStats.ts` 顶部的 `DEFAULT_ENDPOINT`，
或者本地调试时用环境变量（不入库）：

```bash
set FNTV_STATS_ENDPOINT=https://fntv-stats.xxx.workers.dev
```

留空 = 功能静默关闭，一个字节都不会往外发。

> 开发模式（`dev.cmd`）默认不上报，避免作者自测把数据灌水；
> 需要实测时设 `FNTV_STATS_FORCE=1`。

---

## 四、看数据

浏览器直接打开（把 token 换成第 5 步设的口令）：

```
https://fntv-stats.<你的子域>.workers.dev/stats?token=你的口令
```

返回：

```json
{
  "users": { "total": 1280, "today": 137, "last7": 612, "last30": 1104 },
  "daily":   [{ "day": "2026-09-18", "c": 137 }],
  "versions":[{ "ver": "3.7.0", "c": 900 }],
  "systems": [{ "os": "Windows", "c": 1250 }],
  "feedbackCount": 12,
  "recentFeedback": [{ "id": "...", "ts": "...", "msg": "..." }]
}
```

下载某条反馈附带的日志：

```
https://fntv-stats.<你的子域>.workers.dev/stats/log?id=反馈ID&token=你的口令
```

也可以直接查库：

```bash
npx wrangler d1 execute fntv-stats --remote --command "SELECT COUNT(DISTINCT aid) FROM ping"
```

---

## 五、数据清理

- 只保留最近 90 天心跳：
  ```sql
  DELETE FROM ping WHERE day < date('now', '-90 day');
  ```
- 删掉某个用户（例如有人要求删除其匿名 ID）：
  ```sql
  DELETE FROM ping WHERE aid = '那个ID';
  DELETE FROM feedback WHERE aid = '那个ID';
  ```
- R2 里的日志随反馈一起删：`npx wrangler r2 object delete fntv-stats-logs/logs/<id>.log`
