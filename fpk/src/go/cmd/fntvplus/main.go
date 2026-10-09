// Command fntvplus —— Fntv-Plus 影视网页端增强后端（FPK 常驻服务）。
//
// 唯一正式入口：监听应用目录下的 Unix socket，经飞牛统一网关接收 /app/fntvplus/* 请求
//（网关校验 NAS 登录态后转发，并注入 X-Trim-Userid 等身份头），回环反代影视网页并注入增强脚本。
// 正式运行不监听任何 TCP 端口（应用中心上架要求：鉴权优先走统一网关、不开放公网端口）。
//
// 启动（本地调试）：
//
//	fntvplus --upstream http://127.0.0.1:5666 --etc ./config --var . --dest .
//	fntvplus --debug-tcp --port 22350 ...   # 额外开回环 TCP，仅本机排查用
//
// 在 fnOS 上由 cmd/main 经环境变量拉起（socket 文件名无需显式传，自动读 ui/config 的
// gatewaySocket 字段，与官方网关注册机制一致）：
//
//	fntvplus --etc $TRIM_PKGETC --var $TRIM_PKGVAR --dest $TRIM_APPDEST
//
// 上游地址优先级：--upstream > 环境变量 FNTV_UPSTREAM > 环境变量 TRIM_SYS_WEB_PORT
// （拼成 http://127.0.0.1:<port>）> 默认 http://127.0.0.1:5666。
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"fntvplus/internal/config"
	"fntvplus/internal/inject"
	"fntvplus/internal/proxy"
	"fntvplus/internal/stats"
)

func main() {
	port := flag.String("port", envOr("TRIM_SERVICE_PORT", "22350"), "调试用回环 TCP 端口（仅 --debug-tcp 时监听）")
	sock := flag.String("socket", "", "统一网关 Unix socket 文件名（置于 destDir 下；空则从 ui/config 的 gatewaySocket 读取）")
	debugTCP := flag.Bool("debug-tcp", false, "仅调试用：额外监听 127.0.0.1 回环 TCP 端口（正式运行不监听任何 TCP）")
	etcDir := flag.String("etc", envOr("TRIM_PKGETC", "."), "配置目录（config.json 所在）")
	varDir := flag.String("var", envOr("TRIM_PKGVAR", "."), "运行时数据目录")
	destDir := flag.String("dest", envOr("TRIM_APPDEST", "."), "应用安装目录（payload 来源）")
	upstreamFlag := flag.String("upstream", "", "回环上游地址覆盖（如 http://127.0.0.1:5666）")
	versionFlag := flag.String("version", "", "应用版本号（缺省时按 TRIM_APPVER → manifest → 编译期注入 依次兜底）")
	flag.Parse()

	// 网关 socket 文件名：官方机制是 app/ui/config 里每个入口的 gatewaySocket 字段
	// （只写文件名，实际路径 = ${TRIM_APPDEST}/<filename>），并非环境变量。
	// 曾依赖过 TRIM_GATEWAY_SOCKET，但该变量查证并非 fnOS 官方注入项（全网仅一处第三方
	// 代码使用且其注释自承为猜测），一旦不注入则 sock 为空 → 网关 socket 不监听 → 应用全瘫。
	// 故改为：显式 --socket > ui/config 的 gatewaySocket > 环境变量（仅作兼容兜底）。
	if *sock == "" {
		*sock = resolveGatewaySocketName(*destDir)
	}
	if *sock == "" {
		*sock = envOr("TRIM_GATEWAY_SOCKET", "")
	}

	// [v1.8.0] 版本号不再写常量，运行时解析（打包器自动维护 manifest）。
	// [lc-167] 旧实现只读 <TRIM_APPDEST>/manifest —— FPK 安装后 manifest 落在「应用根目录」，
	//   解到 TRIM_APPDEST 的只有包内 app.tgz 的内容，故恒读不到 → 一律 fallback "dev"，
	//   侧栏左下角与设置面板「关于」显示 "vdev"（用户报障）。改为多路兜底，见 resolveAppVersion。
	appVersion := resolveAppVersion(*versionFlag, *destDir)

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

	// [v1.12.0] 匿名使用统计：以「今天确实有人打开了增强页面」（反代注入成功）为触发，
	// 每天最多一次心跳；未配置服务端地址 / 用户关闭开关 / 开发版号（dev）都不会往外发。
	// 细节见 internal/stats 包注释与 docs/匿名统计说明.md。
	stat := stats.New(cfg, appVersion)
	stat.Start()

	srv := proxy.NewServer(proxy.Deps{
		Upstream: upstream,
		Config:   cfg,
		Injector: inj,
		Stats:    stat,
		VarDir:   *varDir,
		Version:  appVersion,
	})

	// 统一网关（唯一正式入口）：监听 TRIM_APPDEST 下的 Unix socket，请求经官方网关
	// /app/fntvplus/* 转发进来，网关已校验 NAS 登录态。
	//
	// [lc-1289] 正式运行**不再监听任何 TCP 端口**（此前常驻 127.0.0.1:<port> 的
	// 「调试/健康检查」入口已移除）。原因：manifest 的 checkport=false 只是「启动前不查
	// 端口占用」，并非启动后的存活探测；官方文档明确「不监听固定端口的应用可以省略
	// service_port，或设置 checkport=false」，即当前形态本就是官方认可的网关型应用。
	// 而常驻 TCP 监听会使「伪造 X-Trim-Userid 头直连绕过网关」成为可能——鉴权本身只认
	// 那个可伪造的头，一旦端口可达，局域网内即可免登录调用设置/桥接接口。
	// 现改为仅 --debug-tcp 时按需开启回环监听，本机排查用，不进正式路径。
	log.Printf("[fntvplus] v%s ready (etc=%s var=%s dest=%s)", appVersion, *etcDir, *varDir, *destDir)
	if *sock != "" {
		sockPath := filepath.Join(*destDir, *sock)
		if err := serveSocket(sockPath, srv); err != nil {
			log.Fatalf("gateway socket %s: %v", sockPath, err)
		}
		log.Printf("[fntvplus] gateway socket ready: %s", sockPath)
	} else {
		log.Printf("[fntvplus] WARNING: 未解析到网关 socket 文件名，仅有反代与注入能力，无对外入口")
	}

	if *debugTCP {
		addr := "127.0.0.1:" + *port
		log.Printf("[fntvplus] [debug] 回环 TCP 已开启: %s", addr)
		go func() {
			if err := http.ListenAndServe(addr, srv); err != nil {
				log.Printf("[fntvplus] [debug] 回环 TCP 退出: %v", err)
			}
		}()
	}

	// 常驻：Unix socket（正式）或调试 TCP 已就绪，此处不返回。
	select {}
}

// serveSocket 在 sockPath 创建并监听 Unix socket，随后在后台 goroutine 常驻服务。
// fnOS 统一网关按 gatewaySocket 约定把 /app/<appname>/* 请求转发到该 socket。
func serveSocket(sockPath string, h http.Handler) error {
	if err := os.Remove(sockPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove stale socket: %w", err)
	}
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		return err
	}
	go func() {
		if err := http.Serve(ln, h); err != nil && err != http.ErrServerClosed {
			log.Printf("[fntvplus] gateway socket server exited: %v", err)
		}
	}()
	return nil
}

// resolveGatewaySocketName 从应用目录的 ui/config 里读取网关 socket 文件名。
//
// 官方接入方式（developer.fnnas.com/docs/core-concepts/gateway-registration/）：
// app/ui/config 中每个入口可声明 "gatewaySocket": "<文件名>"，fnOS 网关把
// /app/<appname>/* 转发到 ${TRIM_APPDEST}/<文件名>。该字段只写文件名、不含路径。
//
// 这里解析出文件名后由调用方与 TRIM_APPDEST 拼成绝对路径。解析失败返回空串，
// 由调用方决定兜底（不猜路径——猜错会导致 socket 落在错误位置、网关连不上）。
func resolveGatewaySocketName(destDir string) string {
	if destDir == "" {
		return ""
	}
	// ui 目录名取自 manifest 的 desktop_uidir（默认 "ui"），不硬编码。
	uiDir := readManifestField(destDir, "desktop_uidir")
	if uiDir == "" {
		uiDir = "ui"
	}
	cfgPath := filepath.Join(destDir, uiDir, "config")
	b, err := os.ReadFile(cfgPath)
	if err != nil {
		return ""
	}
	var doc struct {
		URL map[string]struct {
			GatewaySocket string `json:"gatewaySocket"`
		} `json:".url"`
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		return ""
	}
	// 多个入口时取第一个非空值（本应用只有一个入口）。
	for _, entry := range doc.URL {
		if name := strings.TrimSpace(entry.GatewaySocket); name != "" {
			return filepath.Base(name) // 只取文件名，防御配置里被塞入 ../ 的情况
		}
	}
	return ""
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

// buildVersion 由打包器编译时注入（-ldflags "-X main.buildVersion=<manifest version>"），
// 是最后一层兜底：正常安装环境优先取 fnOS 注入的 TRIM_APPVER 或磁盘上的 manifest。
var buildVersion = ""

// resolveAppVersion 解析应用版本号（侧栏 / 设置面板「关于」 / 管理页展示用）。
//
// 取值优先级（逐级兜底，任一命中即返回）：
//  1. --version 参数（cmd/main 由 fnOS 注入的 TRIM_APPVER 透传而来）
//  2. TRIM_APPVER 环境变量（fnOS 生命周期的信息变量，取自 manifest 的 version=）
//  3. manifest 文件：先 <dest>/manifest，再向上最多 3 级目录找
//     （FPK 安装后布局为 /var/apps/<app>/manifest + target/→TRIM_APPDEST，故需上溯）
//  4. 编译期注入的 buildVersion（打包时写进二进制）
//  5. "dev"（本地源码直跑等无法取版号的场景）
func resolveAppVersion(flagVal, destDir string) string {
	if v := strings.TrimSpace(flagVal); v != "" {
		return v
	}
	if v := strings.TrimSpace(os.Getenv("TRIM_APPVER")); v != "" {
		return v
	}
	dir := destDir
	for i := 0; i < 4 && dir != ""; i++ {
		if v := readManifestVersion(dir); v != "" {
			return v
		}
		parent := filepath.Dir(dir)
		if parent == dir { // 已到根
			break
		}
		dir = parent
	}
	if strings.TrimSpace(buildVersion) != "" {
		return strings.TrimSpace(buildVersion)
	}
	return "dev"
}

// readManifestVersion 从 <dir>/manifest 读 version= 值（打包器自动维护）。
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

// readManifestField 从 <dir>/manifest 读某个 key=value 的值（打包器自动维护的字段）。
func readManifestField(destDir, key string) string {
	if destDir == "" || key == "" {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(destDir, "manifest"))
	if err != nil {
		return ""
	}
	re := regexp.MustCompile(`(?m)^\s*` + regexp.QuoteMeta(key) + `\s*=\s*(\S+)`)
	m := re.FindStringSubmatch(string(data))
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
