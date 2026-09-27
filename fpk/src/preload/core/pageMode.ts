// preload/core/pageMode.ts
// 判断当前是否在飞牛影视 TV 页(/v)。Fntv-Plus 的 TV 改造仅应在该路径下运行；
// 切到飞牛原生 NAS 系统页(根路径 `/`)时须跳过，避免白底清除器/主题/侧栏等破坏原生 UI。
//
// [网关路径兼容] 统一网关模式下浏览器地址是 /app/fntvplus/v/*（影视 SPA 路由 basename
// 写死 /v，由后端注入的 boot shim 在 history 层做双向翻译）。payload 内部所有
// 「读 pathname 做判断」的站点一律走 pagePath()（剥掉网关前缀，拿到影视页真实路径）；
// 所有「整页跳转」一律走 navToTvPage()/tvHref()（网关模式下带上前缀，刷新不丢增强）。

// 统一网关前缀（与 fpk ui/config gatewayPrefix、后端路由保持一致）
export const GW_PREFIX = '/app/fntvplus';

// 当前页面在「影视页命名空间」的真实路径：/app/fntvplus/v/x → /v/x；其余路径原样返回
export function pagePath(): string {
  return pagePathOf(location.pathname || '');
}

// 任意 pathname 的「影视页命名空间」真实路径（剥网关前缀）
export function pagePathOf(p: string): string {
  if (p === GW_PREFIX) return '/';
  return p.startsWith(GW_PREFIX + '/') ? p.slice(GW_PREFIX.length) : p;
}

// 是否处于统一网关路径（地址栏带 /app/fntvplus 前缀的影视页）
export function isGatewayPath(): boolean {
  return (location.pathname || '').startsWith(GW_PREFIX + '/v');
}

export function isFntvTvPage(): boolean {
  const p = pagePath();
  return p === '/v' || p.startsWith('/v/');
}

// 整页跳转到影视页路径（path 以 /v 开头）：网关模式下带上前缀，
// 跳转后的刷新/重载仍从统一网关增强入口进来（裸 /v 会被 fnOS 原生服务，注入丢失）。
export function navToTvPage(path: string): void {
  location.href = isGatewayPath() ? GW_PREFIX + path : path;
}

// 把指向影视页的链接（/v/* 相对路径或同源绝对 URL）转成当前模式下的安全整页跳转地址
export function tvHref(url: string): string {
  if (isGatewayPath()) {
    try {
      const u = new URL(url, location.href);
      const p = u.pathname;
      if (u.origin === location.origin && (p === '/v' || p.startsWith('/v/'))) {
        return GW_PREFIX + p + u.search + u.hash;
      }
    } catch { /* 非法 URL 原样返回 */ }
  }
  return url;
}
