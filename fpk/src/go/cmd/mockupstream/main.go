// Command mockupstream —— 本地联调用「假影视」服务。
//
// 监听 127.0.0.1:5666，提供：
//   GET /v/                影视首页 HTML（含可被注入的 </body>）
//   GET /v/style.css       一个 CSS（测试非 HTML 透传）
//   GET /v/api/hello       JSON（测试 API 透传）
//   GET /v/video.mp4       1MB 可 Range 文件（测试 206 流式透传）
//
// 配合 fntvplus 反代：先起本服务，再起 fntvplus --upstream http://127.0.0.1:5666，
// 然后访问 http://127.0.0.1:22350/app/fntvplus/v/ 即可看到注入后的页面。
package main

import (
	"bytes"
	"io"
	"log"
	"net/http"
	"os"
	"time"
)

const html = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>飞牛影视（mock）</title>
<link rel="stylesheet" href="/v/style.css"></head>
<body>
  <div id="homeTab"><h1>影视首页（mock）</h1>
  <p>这是一个用于验证反代注入的模拟影视页面。</p>
  <video src="/v/video.mp4" controls></video></div>
</body>
</html>`

func main() {
	port := envOr("MOCK_PORT", "5666")
	mux := http.NewServeMux()

	mux.HandleFunc("/v/", func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v/", "/v/index.html":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusOK)
			io.WriteString(w, html)
		case "/v/style.css":
			w.Header().Set("Content-Type", "text/css")
			w.WriteHeader(http.StatusOK)
			io.WriteString(w, "body{background:#111;color:#eee;font-family:sans-serif}")
		case "/v/api/hello":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			io.WriteString(w, `{"ok":true,"from":"mock-upstream"}`)
		case "/v/video.mp4":
			// 1MB 可 Range 的伪视频，验证 206 透传。
			data := make([]byte, 1<<20)
			http.ServeContent(w, r, "video.mp4", time.Unix(0, 0), bytes.NewReader(data))
		default:
			http.NotFound(w, r)
		}
	})

	addr := "127.0.0.1:" + port
	log.Printf("[mockupstream] listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("listen: %v", err)
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
