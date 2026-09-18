# Fntv-Plus 官网（静态站）

## 部署

```bash
# 在项目根目录执行
npx wrangler deploy --config site/wrangler.toml
```

生产域名 `690075.xyz` / `www.690075.xyz` 由 `wrangler.toml` 顶层 `routes` 里的
`custom_domain = true` 自动创建（含 DNS 记录与证书），无需手动配置。

## 为什么是 Workers Static Assets，而不是 Cloudflare Pages

Pages 的自定义域要求 zone 内**已存在**对应 CNAME 记录；而 `wrangler login` 的 OAuth 授权
不含 DNS 写权限，自动建记录会失败，域名永远停在 `pending`（诊断信息：`CNAME record not set`）。

Workers 的自定义域走的是另一条路径 —— 由 Workers 平台代为创建记录并签发证书，
不需要 DNS 写权限。所以官网改用静态资源 Worker 托管。

Pages 项目 `fntv-plus` 仍然保留，作为 `https://fntv-plus.pages.dev` 的备份入口。

## 资源

`assets/*.webp` 由 `scripts/gen-site-assets.mjs` 从 `resource/docs/` 的截图压缩生成
（宽 1280、webp q78，43~89KB/张）：

```bash
node scripts/gen-site-assets.mjs
```

## ⚠ 配置陷阱

`routes` 必须是 `wrangler.toml` 的**顶层键，且写在任何 `[table]` / `[[table]]` 之前**。
TOML 的表头会一直生效到下一个表头 —— 把 `routes` 写在 `[assets]` 或 `[[r2_buckets]]` 之后，
它会被归进那张表，wrangler 只在 Warning 里提一句 `Unexpected fields`，**自定义域静默建不出来**。
（这个坑在 `stats-server/wrangler.toml`、`site/wrangler.toml` 各踩过一次。）
