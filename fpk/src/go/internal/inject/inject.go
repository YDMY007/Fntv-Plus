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

// Inject 在 HTML 的 </body> 前插入 payload 脚本引用。
// 返回 (处理后的 HTML, 是否真的做了注入)。
// 找不到 </body> 时追加到末尾；已注入则原样返回。
func (i *Injector) Inject(html string) (string, bool) {
	if i.AlreadyInjected(html) {
		return html, false
	}
	tag := i.ScriptTag()
	idx := strings.LastIndex(strings.ToLower(html), "</body>")
	if idx < 0 {
		return html + tag, true
	}
	return html[:idx] + tag + html[idx:], true
}

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
