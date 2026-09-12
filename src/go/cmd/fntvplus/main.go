// Command fntvplus —— Fntv-Plus 影视网页端增强后端（FPK 常驻服务）。
//
// 监听 127.0.0.1:<port>，经官方网关接收 /app/fntvplus/* 请求，回环反代影视网页并注入增强脚本。
//
// 启动（本地调试）：
//
//	fntvplus --port 22350 --upstream http://127.0.0.1:5666
//
// 在 fnOS 上由 cmd/main 经环境变量拉起：
//
//	fntvplus --port $TRIM_SERVICE_PORT --etc $TRIM_PKGETC --var $TRIM_PKGVAR --dest $TRIM_APPDEST
//
// 上游地址优先级：--upstream > 环境变量 FNTV_UPSTREAM > 环境变量 TRIM_SYS_WEB_PORT
// （拼成 http://127.0.0.1:<port>）> 默认 http://127.0.0.1:5666。
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"fntvplus/internal/config"
	"fntvplus/internal/inject"
	"fntvplus/internal/proxy"
)

func main() {
	port := flag.String("port", envOr("TRIM_SERVICE_PORT", "22350"), "监听端口")
	etcDir := flag.String("etc", envOr("TRIM_PKGETC", "."), "配置目录（config.json 所在）")
	varDir := flag.String("var", envOr("TRIM_PKGVAR", "."), "运行时数据目录")
	destDir := flag.String("dest", envOr("TRIM_APPDEST", "."), "应用安装目录（payload 来源）")
	upstreamFlag := flag.String("upstream", "", "回环上游地址覆盖（如 http://127.0.0.1:5666）")
	flag.Parse()

	// [v1.8.0] 版本号直接读 manifest（打包器每次打包自动维护），废除两处同步的常量
	appVersion := readManifestVersion(*destDir)
	if appVersion == "" {
		appVersion = "dev"
	}

	cfgPath := filepath.Join(*etcDir, "config.json")
	cfg, err := config.Load(cfgPath)
	if err != nil {
		log.Fatalf("load config %s: %v", cfgPath, err)
	}

	// [v0.19.0] 前端诊断日志（client.log）按次清零：日志只保留本次运行的会话，
	// 避免旧版本残留条目跨启动累积、在实时日志里"阴魂不散"。
	_ = os.Remove(filepath.Join(*varDir, "client.log"))

	inj, err := inject.New()
	if err != nil {
		log.Fatalf("init injector: %v", err)
	}
	log.Printf("[fntvplus] payload ready: %d bytes, hash=%s", inj.Len(), inj.Hash())

	upstream, err := resolveUpstream(*upstreamFlag)
	if err != nil {
		log.Fatalf("resolve upstream: %v", err)
	}
	log.Printf("[fntvplus] upstream = %s", upstream.String())

	// 把解析到的上游写回配置（仅当用户未在管理页自定义时），便于管理页/调试查看。
	if cfg.Get().Upstream == "" {
		_ = cfg.Update(map[string]any{"upstream": upstream.String()})
	} else {
		log.Printf("[fntvplus] using config upstream override: %s", cfg.Get().Upstream)
	}

	srv := proxy.NewServer(proxy.Deps{
		Upstream: upstream,
		Config:   cfg,
		Injector: inj,
		VarDir:   *varDir,
		Version:  appVersion,
	})

	// 端口服务模式：桌面入口直连 http://<NAS>:port，必须绑 0.0.0.0（绑 127.0.0.1 浏览器连不上）。
	addr := "0.0.0.0:" + *port
	log.Printf("[fntvplus] v%s listening on %s (etc=%s var=%s dest=%s)", appVersion, addr, *etcDir, *varDir, *destDir)
	if err := http.ListenAndServe(addr, srv); err != nil {
		log.Fatalf("listen %s: %v", addr, err)
	}
}

// resolveUpstream 按优先级推导回环上游地址。
func resolveUpstream(flagVal string) (*url.URL, error) {
	candidates := []string{
		flagVal,
		os.Getenv("FNTV_UPSTREAM"),
	}
	if p := os.Getenv("TRIM_SYS_WEB_PORT"); p != "" {
		candidates = append(candidates, "http://127.0.0.1:"+p)
	}
	candidates = append(candidates, "http://127.0.0.1:5666") // 本地兜底

	for _, c := range candidates {
		if c == "" {
			continue
		}
		u, err := url.Parse(c)
		if err == nil && u.Scheme != "" && u.Host != "" {
			return u, nil
		}
	}
	return nil, fmt.Errorf("no valid upstream address")
}

// readManifestVersion 从 TRIM_APPDEST/manifest 读 version= 值（打包器自动维护）。
func readManifestVersion(destDir string) string {
	data, err := os.ReadFile(filepath.Join(destDir, "manifest"))
	if err != nil {
		return ""
	}
	m := regexp.MustCompile(`(?m)^\s*version\s*=\s*(\S+)`).FindStringSubmatch(string(data))
	if len(m) < 2 {
		return ""
	}
	return strings.TrimSpace(m[1])
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
