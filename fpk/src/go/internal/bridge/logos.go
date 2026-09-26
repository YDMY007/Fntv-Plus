// Package bridge —— logos.go：首页 Logo 自定义的预设图服务。
// [lc-1046 复刻] 24 个流媒体平台透明底 PNG（长边≈1024px）embed 进二进制，
// 经 /app/fntvplus/api/bridge/logos/<file> 提供（文件名白名单校验，防目录穿越）。
// 自定义上传图不经后端（前端 localStorage dataURL，≤1.5MB 原图）。
package bridge

import (
	"net/http"
	"regexp"
	"strings"
	"embed"
)

//go:embed logos
var logosFS embed.FS

var logoFileRe = regexp.MustCompile(`^(cn|intl)_[a-z0-9_]+\.png$`)

func (b *Bridge) handleLogoFile(w http.ResponseWriter, r *http.Request) {
	file := strings.TrimPrefix(r.URL.Path, "/app/fntvplus/api/bridge/logos/")
	if !logoFileRe.MatchString(file) {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "unknown logo"})
		return
	}
	data, err := logosFS.ReadFile("logos/" + file)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "logo not found"})
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=604800") // 预设图不变，7 天缓存
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
