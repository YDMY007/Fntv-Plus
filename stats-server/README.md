# Fntv-Plus 匿名统计 / 反馈服务端

> 两套后端任选其一，接口完全一致，客户端只换 endpoint：
> **A. Cloudflare Workers + D1 + R2**（本文件，¥0，国内连通性需自测）
> **B. 腾讯云开发 CloudBase**（[cloudbase/README.md](./cloudbase/README.md)，国内直连，¥0 起步）

一个 Cloudflare Worker 单文件，负责两件事：

1. **`/ping`** —— 客户端每天上报一次「今天我在用」，用来统计**有多少人在用**（总人数 / 日活 / 周活 / 月活 / 版本分布）。
2. **`/feedback`** —— 应用内 Bug 反馈 + 日志上传（用户手动触发，日志存 R2）。

免费额度完全够用：Workers 10 万请求/天、D1 500 万行读/天、R2 10GB。

## 常见问题：需要个人网站 / 域名吗？

**不需要。**

- Cloudflare 账号只要邮箱注册，不需要你有网站、不需要买域名、不需要服务器、不需要备案。
- 创建 Worker 时会自动分配一个 `https://fntv-stats.你的子域.workers.dev` 的地址，直接能用。
- 只有「想换成自己的域名」时才需要买域名（也只是做一条 DNS 解析，依然不需要搭网站）；见文末《国内访问与自定义域名》。

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

## 二、部署方式 A：网页操作（零命令行，推荐）

全程在浏览器点，不需要装 Node、不需要敲命令。

1. **注册/登录**：打开 <https://dash.cloudflare.com>，用邮箱注册（不用域名、不用绑卡）。
2. **建 Worker**：左侧 **Compute (Workers)** → **Workers & Pages** → **Create** → 选 **Create Worker** → 名字填 `fntv-stats` → **Deploy**。
   - 第一次用会让你起一个账户子域（随便填，比如你的 ID），之后地址就是 `https://fntv-stats.你的子域.workers.dev`。
3. **贴代码**：进这个 Worker → 右上角 **Edit Code**（在线编辑器）→ 把 `worker.js` 里的内容**全选删掉原模板、整段粘贴**进去 → 右上角 **Deploy**。
4. **建 D1 数据库**：左侧 **Storage & Databases** → **D1 SQL Database** → **Create** → 名字 `fntv-stats` → 建好后点进去 → **Console** 标签 → 把 `schema.sql` 内容粘进去 → **Execute**（建两张表）。
5. **建 R2 桶**：左侧 **R2** → **Create bucket** → 名字 `fntv-stats-logs`（部分地区首次开通会要求验证一下账户，免费额度不用付费）。
6. **绑定（关键，变量名必须一字不差）**：回到 Worker → **Settings** → **Bindings** → **+ Add**：
   - **D1 database**：Variable name 填 `DB`，数据库选 `fntv-stats`
   - **R2 bucket**：Variable name 填 `LOGS`，桶选 `fntv-stats-logs`
   - 再点 **+ Add** → **Secret**（或 Environment variable）：名字 `STATS_TOKEN`，值随便设一个长一点的口令（这是你看数据的钥匙，自己记好）
   - 每次加绑定后记得 **Deploy** 生效。
7. **拿到地址**：Worker 详情页 **Domains & Routes** 里那条 `*.workers.dev` 就是你的服务端地址，复制下来。

> 变量名必须是 `DB`、`LOGS`、`STATS_TOKEN` —— worker.js 里就是按这三个名字读的，写错会报 `db error`。

## 二、部署方式 B：命令行（wrangler）

熟悉命令行的话更快：

```bash
cd stats-server

npx wrangler login                                   # 1. 浏览器授权
npx wrangler d1 create fntv-stats                    # 2. 建库，把输出的 database_id 填进 wrangler.toml
npx wrangler d1 execute fntv-stats --remote --file=schema.sql   # 3. 建表
npx wrangler r2 bucket create fntv-stats-logs        # 4. 建桶
npx wrangler secret put STATS_TOKEN                  # 5. 设看数据的口令
npx wrangler deploy                                  # 6. 部署，输出地址
```

---

## 三、客户端接入（两步）

1. 打开 `src/main/handlers/plugins/usageStats.ts`，把顶部 `DEFAULT_ENDPOINT` 改成你的地址：

   ```ts
   const DEFAULT_ENDPOINT = 'https://fntv-stats.你的子域.workers.dev';
   ```

   （本地调试也可以不入库：`set FNTV_STATS_ENDPOINT=https://...` 再启动。）

2. `npx tsc` 重新编译，或照常 `dev.cmd` 启动。留空 = 功能静默关闭，一个字节都不会往外发。

> 开发模式（`dev.cmd`）**自动上报是关的**，避免作者自测把数据灌水；但你在「关于」页手动点
> 「立即上报一次」不受此限制，可以直接验证链路是否打通（想让自动上报也在 dev 下跑，设 `FNTV_STATS_FORCE=1`）。

### 接入自检

先直接 curl 一下服务端（把地址换成你的）：

```bash
curl -X POST https://fntv-stats.你的子域.workers.dev/ping ^
  -H "content-type: application/json" ^
  -d "{\"aid\":\"test-test-test-test\",\"v\":\"3.7.0\",\"os\":\"Windows\",\"arch\":\"x64\",\"d\":\"2026-09-18\"}"
```

返回 `{"ok":true}` 就是通了（注意日期要填今天）。然后在软件里 **设置 → 关于 → 匿名使用统计 → 立即上报一次**，看状态行是不是「上报成功 ✅」；再打开 `/stats?token=你的口令` 就能看到人数 +1。

---

## 四、看数据

浏览器直接打开（把 token 换成第 6 步设的口令）：

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

---

## 六、本地自测（不部署也能验证逻辑）

Node 22+ 即可，用内存 SQLite 模拟 D1：

```bash
cd stats-server
node --experimental-sqlite _smoke.mjs
```

覆盖：同 ID 同日去重、非法 payload 拒绝、stats token 鉴权、反馈入库、日志进 R2 并可取回。

---

## 七、国内访问与自定义域名（重要）

`*.workers.dev` 这个免费域名在国内网络下**可能时好时坏**（Cloudflare 的 IP 与 SNI 偶发被干扰），表现是：客户端上报失败 → 但代码是静默失败，用户完全无感，只是你看到的数字偏低。

判断方法：用手机流量 + 不同宽带各 curl 一次上面的 `/ping`，看是不是都返回 `{"ok":true}`。

三条路：

1. **都能通**：直接这么用，不用管。
2. **时通时不通**：把统计当「趋势参考」看（比例、版本分布、日活走势依然可信），不要当精确值。
3. **基本不通**：绑一个自己的域名 —— 买个便宜域名（.top/.xyz 一年十几块）托管到 Cloudflare（改 NS 即可，不需要建站），然后在 Worker → **Settings → Domains & Routes → Custom domains → Add** 填上你的二级域名（如 `stats.你的域名.com`），把客户端地址换成它。仍然免费，且国内连通性通常好于 `workers.dev`。

> 如果连自定义域都不理想，可以迁到腾讯云函数 / 阿里云函数计算（国内直连稳定）。代码结构不用动，只要把 worker 的 `fetch(request, env)` 入口换成云函数的事件入口 —— 需要时说一声，我加一版适配。

---

## 八、备选：迁到腾讯云函数（2026-09 核实，价格以控制台为准）

如果 Cloudflare 在国内确实连不上，可迁到腾讯云。构成与资费：

| 组成 | 选型 | 资费 |
| --- | --- | --- |
| 计算 | 云函数 SCF（128MB / 单次 0.1s 估算） | 调用 **0.0133 元/万次** + 资源 **0.00011108 元/GBs** + 外网出流量 0.8 元/GB |
| HTTP 入口 | **函数 URL**（免费送 `https://xxx.<地域>.tencentscf.com`） | 无单独计价项 |
| 存储 | 对象存储 COS（替代 D1） | 标准存储 **0.099~0.13 元/GB/月** + 请求 0.01 元/万次 + 外网下行 0.5 元/GB |
| ~~API 网关~~ | **已于 2025-06-30 停服**，老教程里的 API 网关方案已不适用 | — |

要点与坑：

- **免费额度不是永久的**：SCF 仅新用户**前 3 个月**每月 100 万次调用 + 100 万 GBs + 2GB 出流量，第 4 个月起纯按量。（旧博客说的"每月 100 万次免费"是 2022-06-01 调整前的口径，已失效。）
- **别用数据库**：TDSQL-C Serverless 按 CCU 计费，**0.000049 元/CCU/秒 ≈ 127 元/CCU/月**，且 Serverless 实例不支持完全停机；基础版 MySQL 也是几十元/月。这个量级用它纯属浪费 —— 用 **COS 存 JSON** 即可（每天一个文件，或按天追加）。
- **关掉 CLS 日志投递**：SCF 运行日志默认投递到日志服务 CLS，CLS 免费额度同样只给新用户 3 个月，之后按量计费 —— 这是最容易出现的"隐形账单"。
- **自定义域名需备案**：函数 URL 的默认域名国内直连没问题；要绑自己的域名需已完成 ICP 备案。

按量估算（SCF + COS，不含免费额度）：

| 日活 | 月请求 | 估算月费 |
| --- | --- | --- |
| 1,000 | 约 3 万次 | **约 0.1~0.3 元** |
| 10,000 | 约 30 万次 | **约 1~2 元** |

结论：腾讯云方案**钱不是问题（几毛到几块一个月），麻烦在于改造**——D1 换成 COS 读写、入口从 `fetch(request, env)` 换成 SCF 事件签名。需要时说一声，我加一版 `scf-handler.js`（业务校验逻辑完全复用）。
