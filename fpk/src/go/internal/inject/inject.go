// Package inject —— 把打包好的前端 payload（fntv-plus.user.js）嵌入二进制，
// 并在反代拿到的影视 HTML 里注入一个同源 <script> 引用，从而让增强脚本运行。
//
// 设计要点：
//   - 用 //go:embed 把 payload 打进单二进制（满足「零依赖、单文件」目标）。
//   - 注入的是「外链脚本」而非 795KB 内联：HTML 体积小、payload 可被浏览器独立缓存。
//   - payload URL 带内容哈希（/app/fntvplus/__payload__/fntv-plus.<hash>.user.js），
//     内容一变哈希就变 → 天然缓存失效，无需手动版本号。
//   - 注入带 FNTV_PLUS_INJECT_BEGIN/END 注释标记，便于幂等判断（同一响应不重复注入）。
package inject

import (
	"crypto/sha256"
	"encoding/hex"
	"embed"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

//go:embed payload/fntv-plus.user.js
var payloadFS embed.FS

//go:embed payload/qrcode.png
var qrPNG []byte

const payloadFileName = "payload/fntv-plus.user.js"

// 注入标记：插在 <script> 前后，用于幂等判断。
const (
	markerBegin = "<!-- FNTV_PLUS_INJECT_BEGIN -->"
	markerEnd   = "<!-- FNTV_PLUS_INJECT_END -->"
)

// Injector 持有嵌入的 payload 及其内容哈希。
type Injector struct {
	js   []byte
	hash string
}

// New 构造 Injector，并计算 payload 内容哈希（取 sha256 前 12 位）。
func New() (*Injector, error) {
	data, err := fs.ReadFile(payloadFS, payloadFileName)
	if err != nil {
		return nil, fmt.Errorf("read embedded payload: %w", err)
	}
	sum := sha256.Sum256(data)
	return &Injector{
		js:   data,
		hash: hex.EncodeToString(sum[:])[:12],
	}, nil
}

// Hash 返回 payload 内容哈希（用于 URL 版本化）。
func (i *Injector) Hash() string { return i.hash }

// Len 返回 payload 字节数。
func (i *Injector) Len() int { return len(i.js) }

// ScriptTag 返回要插入 HTML 的 <script> 引用标签（同源、带哈希版本）。
func (i *Injector) ScriptTag() string {
	url := fmt.Sprintf("/app/fntvplus/__payload__/fntv-plus.%s.user.js", i.hash)
	return fmt.Sprintf("%s\n<script src=\"%s\"></script>\n%s", markerBegin, url, markerEnd)
}

// AlreadyInjected 判断 HTML 是否已被本注入器处理过（幂等）。
func (i *Injector) AlreadyInjected(html string) bool {
	return strings.Contains(html, markerBegin)
}

// Inject 在 HTML 的 </body> 前插入 payload 脚本引用；gateway=true（统一网关路径
// /app/fntvplus/v/* 进入）时再在 <head> 最前面注入路径翻译 shim。
// 返回 (处理后的 HTML, 是否真的做了注入)。
// 找不到 </body> 时追加到末尾；已注入则原样返回。
func (i *Injector) Inject(html string, gateway bool) (string, bool) {
	if i.AlreadyInjected(html) {
		return html, false
	}
	if gateway {
		html = injectGatewayShim(html)
	}
	tag := i.ScriptTag()
	idx := strings.LastIndex(strings.ToLower(html), "</body>")
	if idx < 0 {
		return html + tag, true
	}
	return html[:idx] + tag + html[idx:], true
}

// shimMarkers 是网关路径翻译 shim 的注入标记（与 payload 标记分开，便于单独判幂等）。
const (
	shimMarkerBegin = "<!-- FNTV_PLUS_GW_SHIM_BEGIN -->"
	shimMarkerEnd   = "<!-- FNTV_PLUS_GW_SHIM_END -->"
)

// injectGatewayShim 把网关路径翻译 shim 插到 <head> 最前面（先于页面全部脚本执行）。
// 背景：影视 SPA 的路由 basename 写死 `/v`，而网关模式下浏览器地址是
// /app/fntvplus/v/*——路由匹配不到任何页面，#root 空渲染（白屏）。
// shim 在 SPA 启动前把地址翻译回 /v/*，并在 SPA 内部跳转时把地址翻译回网关前缀，
// 保证刷新 / 复制链接 / 深链始终从增强入口进来。
func injectGatewayShim(html string) string {
	if strings.Contains(html, shimMarkerBegin) {
		return html
	}
	shim := shimMarkerBegin + "\n<script>" + gatewayShimJS + "</script>\n" + shimMarkerEnd
	lower := strings.ToLower(html)
	if idx := strings.Index(lower, "<head"); idx >= 0 {
		if end := strings.Index(lower[idx:], ">"); end >= 0 {
			pos := idx + end + 1
			return html[:pos] + shim + html[pos:]
		}
	}
	// 没有 <head>（非常规响应）：整个文档最前面注入，兜底生效。
	return shim + html
}

// gatewayShimJS 是网关路径翻译脚本本体。约定：
//   - 网关前缀 P = /app/fntvplus；影视页真实路径 = 剥掉 P 后的 /v/*。
//   - 启动时：地址带 P 前缀 → replaceState 剥掉（SPA 路由才能匹配）。
//   - pushState/replaceState 包装：SPA 推入的 /v/* 地址 → 加回 P（地址栏保持网关前缀）。
//   - popstate（capture，且本脚本最先注册 → 先于路由监听执行）：网关地址先剥前缀再让路由读。
//   - #root 渲染完成后把地址翻回网关前缀（补上 SPA 启动不改写地址的窗口期）。
//
// 另外挂载启动期 API 捕获（window.__fntvApiCap）：本脚本位于 <head> 最前，必然先于
// 影视 SPA 的所有脚本执行——SPA 自己发出的 item/list（带合法 Authx）请求在此被记录
// （路径→{authx, body, resp}），payload 的轮播/库索引直接取用捕获到的响应，
// 彻底绕开「网页端无签名材料、回放签名因 body 哈希不一致而 invalid sign」的死结。
// 只存 authx 非空的请求，避免 payload 自己的未签名调用覆盖捕获值。
const gatewayShimJS = `(function(){
var P='/app/fntvplus';
function isV(p){return p==='/v'||p.indexOf('/v/')===0;}
function isGw(p){return p===P+'/v'||p.indexOf(P+'/v/')===0;}
function strip(p){return isGw(p)?p.slice(P.length):p;}
try{
  if(isGw(location.pathname)){
    history.replaceState(history.state,'',strip(location.pathname)+location.search+location.hash);
  }
}catch(e){}
var ps=history.pushState,rs=history.replaceState;
function toGw(u){
  if(u==null)return u;
  try{
    var url=new URL(u,location.href);
    if(url.origin!==location.origin)return u;
    if(isV(url.pathname)&&!isGw(url.pathname))return P+url.pathname+url.search+url.hash;
  }catch(e){}
  return u;
}
history.pushState=function(s,t,u){return ps.call(history,s,t,toGw(u));};
history.replaceState=function(s,t,u){return rs.call(history,s,t,toGw(u));};
window.addEventListener('popstate',function(e){
  try{
    if(isGw(location.pathname)){
      rs.call(history,e.state!=null?e.state:history.state,'',strip(location.pathname)+location.search+location.hash);
    }
  }catch(err){}
  // [lc-1296] 前进/后退落到剥离条目（启动时被剥成 /v/* 的那条）后地址是原生形态，
  // 路由渲染完立刻回填，不让地址栏停留在原生路径（停留期间刷新即跳出增强）。
  setTimeout(function(){ if(!readd()) setTimeout(readd,60); },0);
});
function readd(){
  try{
    var root=document.getElementById('root');
    if(root&&root.childElementCount>0&&!isGw(location.pathname)&&isV(location.pathname)){
      history.replaceState(history.state,'',P+location.pathname+location.search+location.hash);
      return true;
    }
  }catch(e){}
  return false;
}
try{
  // [lc-1296] 回填不再「10 秒放弃」：强刷（清缓存）时 SPA 启动可远超 200×50ms，
  // 旧实现到点放弃 → 地址栏永远停在原生 /v/*，此时用户再刷新一次就彻底跳出增强。
  // 现改为三层：MutationObserver 盯 #root 首次渲染立即回填（断开）→ 50ms×1200（60s）兜底
  // → 每秒一次的常驻自愈（覆盖 popstate 回到剥离条目等一切后续漂移，成本=每秒一次路径检查）。
  var mo=new MutationObserver(function(){ if(readd()) mo.disconnect(); });
  mo.observe(document.documentElement,{childList:true,subtree:true});
  var n=0,timer=setInterval(function(){ if(++n>1200||readd()) clearInterval(timer); },50);
  setInterval(function(){ readd(); },1000);
}catch(e){}
/* ── 启动期 API 捕获：item/list / item/{guid}（带合法 Authx 的 SPA 自身请求）── */
try{
  var CAP=window.__fntvApiCap={itemLists:[],itemDetail:{}};
  function pathOf(u){var s=String(u||'');s=s.replace(/^https?:\/\/[^\/]+/,'');var q=s.indexOf('?');if(q>=0)s=s.slice(0,q);return s;}
  function keep(e){
    if(!e||!e.resp)return false;
    try{var j=JSON.parse(e.resp);if(!j||j.code!==0)return false;}catch(err){return false;}
    return true;
  }
  function store(p,e){
    var m=p.match(/^\/v\/api\/v1\/item\/([a-f0-9]{32})$/);
    if(p==='/v/api/v1/item/list'){if(keep(e)&&CAP.itemLists.length<8)CAP.itemLists.push(e);}
    else if(m){if(keep(e))CAP.itemDetail[m[1]]=e;}
  }
  var xo=XMLHttpRequest.prototype.open,xss=XMLHttpRequest.prototype.send,xsr=XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open=function(m,u){this.__capU=String(u||'');this.__capA='';return xo.apply(this,arguments);};
  XMLHttpRequest.prototype.setRequestHeader=function(n,v){if(String(n).toLowerCase()==='authx')this.__capA=String(v);return xsr.apply(this,arguments);};
  XMLHttpRequest.prototype.send=function(body){
    var p=pathOf(this.__capU);
    if(p==='/v/api/v1/item/list'||/^\/v\/api\/v1\/item\/[a-f0-9]{32}$/.test(p)){
      var self=this,e={url:p,authx:self.__capA||'',body:body?String(body):'',resp:''};
      this.addEventListener('load',function(){
        try{var rt=self.responseType;if(rt===''||rt==='text'){e.resp=String(self.responseText||'').slice(0,400000);store(p,e);}}catch(err){}
      });
    }
    return xss.apply(this,arguments);
  };
  var fo=window.fetch;
  if(fo){
    window.fetch=function(input,init){
      var u=(typeof input==='string')?input:((input&&input.url)||'');
      var p=pathOf(u);
      if(p==='/v/api/v1/item/list'||/^\/v\/api\/v1\/item\/[a-f0-9]{32}$/.test(p)){
        var e={url:p,authx:'',body:(init&&typeof init.body==='string')?init.body:'',resp:''};
        try{var hs=init&&init.headers;
          if(hs){if(typeof hs.forEach==='function'){hs.forEach(function(v,k){if(String(k).toLowerCase()==='authx')e.authx=String(v);});}
          else if(Array.isArray(hs)){for(var i=0;i<hs.length;i++)if(String(hs[i][0]).toLowerCase()==='authx')e.authx=String(hs[i][1]);}
          else{for(var k in hs)if(String(k).toLowerCase()==='authx')e.authx=String(hs[k]);}}}catch(err){}
        var f=fo.apply(this,arguments);
        f.then(function(r){try{var c=r.clone();c.text().then(function(t){e.resp=String(t||'').slice(0,400000);store(p,e);}).catch(function(){});}catch(err){}}).catch(function(){});
        return f;
      }
      return fo.apply(this,arguments);
    };
  }
}catch(e){}
})();`

// Handler 返回用于 `/app/fntvplus/__payload__/` 的 http.Handler：
// 不论 URL 中的哈希段是什么，均返回同一份嵌入 payload（哈希仅用于缓存失效）。
// 设置长缓存 + 正确 JS MIME，让浏览器复用。
func (i *Injector) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		// 内容哈希已编码进 URL，内容不变哈希不变 → 可长缓存。
		w.Header().Set("Cache-Control", "public, max-age=86400, immutable")
		w.Header().Set("X-Fntv-Plus", "payload/"+i.hash)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(i.js)
	})
}

// QRHandler 返回用于 `/app/fntvplus/qrcode.png` 的 http.Handler：
// 反馈弹窗二维码（桌面版由主进程读 build/qrcode.png，网页端由后端内嵌直出）。
func QRHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "public, max-age=86400, immutable")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(qrPNG)
	})
}

// WritePayload 把嵌入的 payload 写出到 dest（供安装/debug 用）。
func (i *Injector) WritePayload(dest string) error {
	return writeFileAtomic(dest, i.js, 0o644)
}

// ServePayload 直接把 payload 写到任意 io.Writer（测试用）。
func (i *Injector) ServePayload(w io.Writer) (int, error) {
	return w.Write(i.js)
}

// writeFileAtomic 原子写文件（临时文件 + rename），避免写到一半被读取。
func writeFileAtomic(dest string, data []byte, mode os.FileMode) error {
	if dir := filepath.Dir(dest); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	tmp := dest + ".tmp"
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	return os.Rename(tmp, dest)
}
