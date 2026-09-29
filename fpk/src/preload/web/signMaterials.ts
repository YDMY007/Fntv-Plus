// src/preload/web/signMaterials.ts — 网页端 Authx 签名材料的运行时提取（仅 web 用）。
//
// 背景：影视 SPA 在浏览器内计算 Authx 签名，因此 API_KEY/SECRET 必然存在于它自己的
// chunk 里（实测：KEY 明文内嵌在签名函数的 join 数组里；SECRET 是一段自包含的
// Uint8Array 解码 IIFE）。桌面客户端把常量写死在主进程（fnosAuth.ts），而 fpk 网页端
// 的审核红线是「官方密钥不得随包分发」——本模块的做法是运行时从**用户自己 NAS 的**
// 前端资源中提取，只存在于页面内存，不写包、不落盘、不外发。
//
// 提取特征（对 2026-09 实测 bundle 有效，minify 变量名变化不影响结构匹配）：
//   1) KEY：签名 join 数组的首元素模板字面量  [`<KEY>`,v,v,v,v,v].join(`_`)
//   2) SECRET：拦截器入参 {apiKey:<var>} → <var>=(()=>{...})() 自执行 IIFE → 求值
//
// 任一步失败即返回 null，调用方回退旧的「页面捕获回放」路径，行为与 v229 前一致。

let cached: { key: string; secret: string } | null = null;
let pending: Promise<{ key: string; secret: string } | null> | null = null;

/** 从 chunk 文本提取 KEY 与 SECRET；提取不到返回 null。 */
function extractFromChunk(txt: string): { key: string; secret: string } | null {
  try {
    // ① KEY：`[...].join(`_`)` 六元 join，首元素是模板字面量长常量
    const joinRe = /\[`([A-Za-z0-9_]{16,64})`,\w+,\w+,\w+,\w+,\w+\]\.join\(`_`\)/;
    const mj = joinRe.exec(txt);
    if (!mj) return null;
    const key = mj[1];

    // ② SECRET：join 第六元是变量名 → 找 {apiKey:<var>,…} 拦截器入参 → 变量的 IIFE 定义
    const tailStart = mj.index + mj[0].length;
    const tail = txt.slice(Math.max(0, tailStart - 400), tailStart + 900);
    const mv = /\{apiKey:(\w+)/.exec(tail) || /\{apiKey:(\w+)/.exec(txt);
    if (!mv) return null;
    const varName = mv[1];

    // 变量定义形如 <var>=(()=>{let x=new Uint8Array([...]); …})() —— 自包含自执行解码器
    const defRe = new RegExp(varName.replace(/\$/g, '\\$&') + '=\\(\\(\\)=>\\{[\\s\\S]{0,1200}?\\}\\)\\(\\)');
    const md = defRe.exec(txt);
    if (!md) return null;
    const iife = md[0].slice(varName.length + 1); // 去掉 "<var>="，留 "(()=>{…})()"
    // 自包含校验：不允许引用外部标识符的特征（粗检：只允许 Uint8Array/String/Math/fromCharCode 等）
    // 这里交给 Function 求值 + try/catch 兜底，求值失败即放弃（回退旧路径）。
    const secret = window.eval('(' + iife + ')');
    if (typeof secret !== 'string' || secret.length < 8 || secret.length > 128) return null;
    return { key, secret };
  } catch (e) {
    return null;
  }
}

/** 搜集候选 chunk 文本（已加载的 /v/assets/*.js + 入口脚本），逐个尝试提取。 */
async function extract(): Promise<{ key: string; secret: string } | null> {
  const urls = new Set<string>();
  try {
    for (const s of Array.from(document.querySelectorAll('script[src]'))) {
      const u = (s as HTMLScriptElement).src || '';
      if (u.includes('/v/assets/') && u.endsWith('.js')) urls.add(u);
    }
    for (const r of performance.getEntriesByType('resource')) {
      const n = r.name;
      if (n.includes('/v/assets/') && n.endsWith('.js') && n.startsWith(location.origin)) urls.add(n);
    }
  } catch (e) { /* ignore */ }

  for (const u of urls) {
    try {
      const resp = await fetch(u, { credentials: 'omit' });
      if (!resp.ok) continue;
      const txt = await resp.text();
      const found = extractFromChunk(txt);
      if (found) return found;
    } catch (e) { /* 下一个 */ }
  }
  return null;
}

// [lc-1287] ⚠ 失败记忆必须有「冷却期」，绝不能一次失败就永久放弃。
//   回归根因（lc-1282 引入、lc-1286 沿用）：增强脚本在页面 OnReady 极早期就发起轮播取数，
//   那一刻影视页的 JS chunk 尚未加载完 → extract() 扫不到签名 chunk 返回 null →
//   原实现置 triedFailed 后本会话永不再试 → 之后所有 fnOS 请求全部 invalid sign，
//   轮播海报全数加载失败（用户日志实证：item/list code=5000 + item/{guid} 的 Authx 全空）。
//   修复：失败只记「时间戳」，超过冷却期（1.5s）后允许重试；chunk 加载完成后即可自愈。
//   同时若已连续失败多次仍拿不到，退化为「每次调用都重试」但做节流（避免请求风暴）。
const RETRY_COOLDOWN_MS = 1500;
let lastFailAt = 0;

/** 取签名材料（带缓存与失败冷却；失败返回 null，调用方走 oracle / 捕获回放）。 */
export function ensureSignMaterials(): Promise<{ key: string; secret: string } | null> {
  if (cached) return Promise.resolve(cached);
  // 冷却期内不重复扫描（节流）；超过冷却期允许重试，chunk 到位后自然成功
  if (lastFailAt && Date.now() - lastFailAt < RETRY_COOLDOWN_MS) return Promise.resolve(null);
  if (!pending) {
    pending = extract()
      .then((m) => {
        cached = m;
        if (!m) lastFailAt = Date.now(); // 只记时间，不永久放弃
        else lastFailAt = 0;
        pending = null; // 允许冷却期后重新提取（成功后 cached 已命中，不会重跑）
        return m;
      })
      .catch(() => { lastFailAt = Date.now(); pending = null; return null; });
  }
  return pending;
}
