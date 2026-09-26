// preload/core/pageMode.ts
// 判断当前是否在飞牛影视 TV 页(/v)。Fntv-Plus 的 TV 改造仅应在该路径下运行；
// 切到飞牛原生 NAS 系统页(根路径 `/`)时须跳过，避免白底清除器/主题/侧栏等破坏原生 UI。
export function isFntvTvPage(): boolean {
  const p = (location.pathname || '');
  return p === '/v' || p.startsWith('/v/');
}
