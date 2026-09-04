package utils

import (
	"bytes"
	"crypto/sha1"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"proxy/pkg/logger"

	"github.com/gin-gonic/gin"
)

func JsonPrintBytes(v any) []byte {
	if v == nil {
		return []byte("{}")
	}

	b, err := json.Marshal(v)
	if err != nil {
		return []byte("{}")
	}

	return b
}

// JsonPrint 打印JSON
func JsonPrint(v any) string {
	return string(JsonPrintBytes(v))
}

// StringToUUID 将字符串转换为UUID格式
func StringToUUID(s string) string {
	if len(s) == 0 {
		return "00000000-0000-0000-0000-000000000000"
	}

	hash := sha1.Sum([]byte(s))
	hexStr := hex.EncodeToString(hash[:16])

	return hexStr[:8] + "-" + hexStr[8:12] + "-" + hexStr[12:16] + "-" + hexStr[16:20] + "-" + hexStr[20:]
}

// PassthroughHeaders 从HTTP请求中提取需要传递的头信息
func PassthroughHeaders(req *http.Request) map[string]string {
	headers := make(map[string]string)

	// 需要传递的头列表
	passHeaders := []string{
		"User-Agent",
		"Accept",
		"Accept-Language",
		"Accept-Encoding",
		"Cache-Control",
		"Pragma",
		"Range",
		"If-Range",
		"If-Modified-Since",
		"If-None-Match",
	}

	for _, header := range passHeaders {
		if value := req.Header.Get(header); value != "" {
			headers[header] = value
		}
	}

	return headers
}

// DynamicProxy 透明代理
func DynamicProxy(c *gin.Context, targetURL string, extraHeaders map[string]string, skipVerify bool) {
	// 使用recover来捕获可能的panic
	defer func() {
		if err := recover(); err != nil {
		// 检查是否是http.ErrAbortHandler错误
		if err == http.ErrAbortHandler {
			// logger.Debugf("客户端断开连接，忽略错误: %v", err)
			return
		}
		// 其他panic: 切勿重新抛出! 否则单个坏请求会拖垮整个代理进程(exit 1,
		// 表现为 Proxy 反复崩溃重启)。改为记录日志并返回 502, 让客户端自行处理。
		logger.Errorf("DynamicProxy recovered panic: %v", err)
		if c != nil && !c.Writer.Written() {
			c.AbortWithStatusJSON(502, gin.H{"error": "proxy internal error"})
		}
		}
	}()

	// 解析目标URL
	target, err := url.Parse(targetURL)
	if err != nil {
		c.JSON(500, gin.H{"error": "Invalid target URL"})
		return
	}

	// 兼容webdav 取出 userinfo（如果有）
	var (
		uName   string
		uPass   string
		hasUser bool
	)
	if target.User != nil {
		uName = target.User.Username()
		if p, ok := target.User.Password(); ok {
			uPass = p
		}
		hasUser = (uName != "")
	}

	// 清除URL中的用户信息，避免泄露
	targetNoUser := *target
	targetNoUser.User = nil

	// 构建上游请求。复制客户端头 + extraHeaders（网盘 UA 等签名相关头必须保留，
	// 因为云盘签名 URL 与 User-Agent 绑定，跟随重定向时也不能丢）。
	buildUpstream := func(rawURL string, body io.Reader) (*http.Request, error) {
		req, err := http.NewRequest(c.Request.Method, rawURL, body)
		if err != nil {
			return nil, err
		}
		for key, values := range c.Request.Header {
			for _, value := range values {
				req.Header.Add(key, value)
			}
		}
		for key, value := range extraHeaders {
			req.Header.Set(key, value)
		}
		// 如果客户端没带 Authorization，但 URL 有 userinfo，就补上 BasicAuth
		if req.Header.Get("Authorization") == "" && hasUser {
			req.SetBasicAuth(uName, uPass)
		}
		req.Host = target.Host
		return req, nil
	}

	// 首个请求：若有请求体先缓冲（播放场景为 GET/HEAD 通常无 body；缓冲是为了
	// 跟随重定向时能重放 body）
	var bodyReader io.Reader
	if c.Request.Body != nil && c.Request.Method != http.MethodGet && c.Request.Method != http.MethodHead {
		bodyBytes, err := io.ReadAll(io.LimitReader(c.Request.Body, 8<<20))
		if err == nil && len(bodyBytes) > 0 {
			bodyReader = bytes.NewReader(bodyBytes)
		}
	}

	// [lc-1000] 旁路小范围请求（弹幕脚本 curl --range 0-16777215 算文件 hash）优先走
	// 文件头缓存：视频流转发时已把前 16MB 存进内存，这里直接返回，**零网络开销**。
	// 否则它会与视频流抢带宽 —— 网盘经隧道时带宽≈码率，抢一点就让 MPV 缓冲净流失
	// 触发 --cache-pause 暂停（表现为"卡加载一直转圈"）。
	rangeStart, rangeEnd, hasEnd, rangeOK := parseRangeHeader(c.Request.Header.Get("Range"))
	if rangeOK && hasEnd && (c.Request.Method == http.MethodGet || c.Request.Method == http.MethodHead) {
		if tryServeHeadFromCache(c, targetNoUser.String(), rangeStart, rangeEnd) {
			return
		}
	}

	upstream, err := buildUpstream(targetNoUser.String(), bodyReader)
	if err != nil {
		c.JSON(500, gin.H{"error": "Invalid target URL"})
		return
	}

	// [lc-999] 手动跟随 3xx 重定向（原 httputil.ReverseProxy 会把 302 原样透传给播放器）。
	// 场景：百度网盘对 bytes=0- 返回 302 做 CDN 调度(Location 指向 *.jomodns.com 签名 URL)，
	// MPV 收到 302 后用自己的默认 UA 去跟 → UA 与签名不匹配 → 仍 302 → 重试耗尽报
	// "Unable to load file or stream"。必须在代理侧用**原始 UA + Range** 跟随重定向，
	// 把最终的 200/206 视频流交给播放器。
	const maxRedirects = 5
	client := &http.Client{
		Transport: &http.Transport{
			ResponseHeaderTimeout: 120 * time.Second,
			// 视频流不做自动 gzip（避免 Transport 偷偷解压破坏 Range/Content-Length 语义）
			DisableCompression: true,
			TLSClientConfig: &tls.Config{
				InsecureSkipVerify: skipVerify,
			},
		},
		// 不设整体 Timeout：长视频流式响应不能被整体超时切断
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= maxRedirects {
				return fmt.Errorf("stopped after %d redirects", maxRedirects)
			}
			// Go 跨主机重定向默认剥离 Authorization；网盘/反代场景签名可能在头里，
			// 这里恢复首跳的值（内部代理，泄漏面可控）
			if auth := via[0].Header.Get("Authorization"); auth != "" && req.Header.Get("Authorization") == "" {
				req.Header.Set("Authorization", auth)
			}
			return nil
		},
	}

	resp, err := client.Do(upstream)
	if err != nil {
		// client.Do 在超过重定向次数等情况下也会返回错误
		if c.Writer.Written() {
			logger.Debugf("代理错误，但响应已开始写入: %v", err)
			return
		}
		logger.Errorf("代理上游请求失败: %v", err)
		c.JSON(502, gin.H{"error": "Proxy error", "details": err.Error()})
		return
	}
	defer resp.Body.Close()

	// 打印响应头
	logger.Infof("响应状态: %s, 头部: %v", resp.Status, resp.Header)

	// [lc-652] STRM/网盘直链 HLS：m3u8 分片常为相对路径（如 media-xxx-549.ts?auth_key=...）。
	// 若不重写，播放器会基于「本地 playvideo 代理 URL」拼接分片 → 请求打回本地代理、
	// 却只有网盘签名参数(缺 domain/token/account) → Go 侧 parseQueryParam 400 → 整集跳过。
	// 故把相对分片/URI 重写为基于上游 m3u8 地址(target)的绝对 URL，让播放器直连网盘 CDN。
	if isM3U8Response(resp) {
		body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
		if err == nil {
			rewritten, nChanged := rewriteM3U8(string(body), target)
			if nChanged > 0 {
				resp.Body = io.NopCloser(bytes.NewReader(rewritten))
				resp.ContentLength = int64(len(rewritten))
				resp.Header.Set("Content-Length", strconv.Itoa(len(rewritten)))
				logger.Infof("[m3u8] 已重写 %d 行相对分片/URI 为绝对 URL(基于 %s)", nChanged, target.Host+target.Path)
			}
		}
	}

	// 把上游响应头拷回客户端（剔除 hop-by-hop 头，ReverseProxy 原本会处理）
	for key, values := range resp.Header {
		if isHopByHopHeader(key) {
			continue
		}
		for _, value := range values {
			c.Writer.Header().Add(key, value)
		}
	}

	// [lc-1000] 本次响应若从文件头附近开始（<=16MB），转发时顺带把前 16MB 灌进文件头缓存，
	// 供后续弹幕 hash 的旁路请求复用（零网络开销）。200 时数据从 0 开始；206 时从 Range 起点。
	var headT *headTee
	if (resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusPartialContent) && rangeStart < headCacheBytes {
		hb := getHeadBuffer(targetNoUser.String())
		if !hb.isFull() {
			if cr := resp.Header.Get("Content-Range"); cr != "" {
				hb.setTotal(parseTotalFromContentRange(cr))
			}
			startOff := int64(0)
			if resp.StatusCode == http.StatusPartialContent && hasEnd { // 206：数据从 Range 起点开始
				startOff = rangeStart
			}
			headT = &headTee{hb: hb, offset: startOff}
		}
	}

	c.Writer.WriteHeader(resp.StatusCode)

	// HEAD 请求无响应体；其余流式拷贝（边读边 flush，保证 MPV 秒开首帧）
	if c.Request.Method != http.MethodHead {
		copyStreaming(c.Writer, resp.Body, headT)
	}
}

// copyStreaming 流式拷贝响应体，每 100ms 主动 flush 一次，
// 避免大视频流被 Go 的写缓冲攒住导致播放器起播慢。tee 非 nil 时同步写入文件头缓存。
func copyStreaming(dst http.ResponseWriter, src io.Reader, tee *headTee) error {
	buf := make([]byte, 32*1024)
	lastFlush := time.Now()
	for {
		nr, er := src.Read(buf)
		if nr > 0 {
			if _, ew := dst.Write(buf[:nr]); ew != nil {
				return ew
			}
			if tee != nil {
				_, _ = tee.Write(buf[:nr])
			}
			if time.Since(lastFlush) > 100*time.Millisecond {
				if f, ok := dst.(http.Flusher); ok {
					f.Flush()
				}
			lastFlush = time.Now()
		}
		}
		if er != nil {
			if er == io.EOF {
				return nil
			}
			// 客户端断开（播放器停止/拖动）是常态，不算错误
			return er
		}
	}
}

// isHopByHopHeader 判断 RFC 2616 hop-by-hop 头（代理不转发）
func isHopByHopHeader(key string) bool {
	switch strings.ToLower(key) {
	case "connection", "proxy-connection", "keep-alive", "proxy-authenticate",
		"proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade":
		return true
	}
	return false
}

// isM3U8Response 判断上游响应是否为 HLS 播放列表(m3u8)
func isM3U8Response(resp *http.Response) bool {
	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	if strings.Contains(ct, "mpegurl") || strings.Contains(ct, "mpeg-url") {
		return true
	}
	// 有些网盘不返回标准 Content-Type，通过 body 前缀兜底判断
	if ct == "" || strings.Contains(ct, "text/plain") || strings.Contains(ct, "application/octet-stream") || strings.Contains(ct, "binary") {
		// 只读一小段探测（注意：不能消费 Body，需恢复）
		probe, err := io.ReadAll(io.LimitReader(resp.Body, 64))
		if err == nil {
			// [lc-666] 恢复 body 用 io.MultiReader（探测字节 + 剩余流），只消费 64 字节！
			//   旧实现 `rest, _ := io.ReadAll(resp.Body)` 会把剩余流整块读进内存：
			//   视频流 Content-Type 恰为 application/octet-stream → 整个视频文件(如 378MB)
			//   被缓冲完才发给播放器 → 外部播放黑屏 3.8 秒（lc-652 引入，3.4.0 之前秒开）。
			//   MultiReader 下 ContentLength 保持不变（未消费任何字节），勿覆盖。
			resp.Body = io.NopCloser(io.MultiReader(bytes.NewReader(probe), resp.Body))
			return bytes.HasPrefix(probe, []byte("#EXTM3U"))
		}
	}
	return false
}

// rewriteM3U8 将 m3u8 播放列表中的相对分片/URI 重写为基于 base 的绝对 URL。
// 支持三种形态：
//  1. 纯相对路径行（如 media-xxx-549.ts?auth_key=...）
//  2. #EXT-X-KEY / #EXT-X-MAP 等标签中的 URI="..."（可能是相对路径）
//  3. 绝对 URL 行（http(s)://...）—— 保持不变
// 返回重写后的内容与发生变化的行数。
func rewriteM3U8(content string, base *url.URL) ([]byte, int) {
	if base == nil {
		return []byte(content), 0
	}
	lines := strings.Split(content, "\n")
	changed := 0
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		// 注释行：检查是否含 URI="..."（EXT-X-KEY / EXT-X-MAP 等）
		if strings.HasPrefix(trimmed, "#") {
			if strings.Contains(trimmed, `URI="`) {
				newLine := rewriteURIInTag(trimmed, base)
				if newLine != line {
					lines[i] = newLine
					changed++
				}
			}
			continue
		}
		// 普通分片行：绝对 URL 跳过；相对路径则基于 base 解析
		if isAbsoluteURL(trimmed) {
			continue
		}
		abs := resolveRelative(trimmed, base)
		if abs != "" && abs != trimmed {
			lines[i] = abs
			changed++
		}
	}
	return []byte(strings.Join(lines, "\n")), changed
}

// rewriteURIInTag 重写标签行内 URI="..." 的相对路径（仅当相对时）
func rewriteURIInTag(line string, base *url.URL) string {
	return regexReplaceURIAttr(line, func(uri string) string {
		if isAbsoluteURL(uri) {
			return uri
		}
		abs := resolveRelative(uri, base)
		if abs != "" {
			return abs
		}
		return uri
	})
}

// regexReplaceURIAttr 替换行内 URI="..." 的值（保留引号）
func regexReplaceURIAttr(line string, fn func(string) string) string {
	var sb strings.Builder
	rest := line
	for {
		idx := strings.Index(rest, `URI="`)
		if idx < 0 {
			sb.WriteString(rest)
			break
		}
		sb.WriteString(rest[:idx+5]) // 含 URI="
		rest = rest[idx+5:]
		end := strings.IndexByte(rest, '"')
		if end < 0 {
			sb.WriteString(rest)
			break
		}
		uri := rest[:end]
		sb.WriteString(fn(uri))
		sb.WriteString(`"`)
		rest = rest[end+1:]
	}
	return sb.String()
}

// isAbsoluteURL 判断是否为绝对 URL
func isAbsoluteURL(s string) bool {
	lower := strings.ToLower(strings.TrimSpace(s))
	return strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://")
}

// resolveRelative 将相对 URL 基于 base 解析为绝对 URL；解析失败返回空串
func resolveRelative(ref string, base *url.URL) string {
	u, err := url.Parse(strings.TrimSpace(ref))
	if err != nil {
		return ""
	}
	return base.ResolveReference(u).String()
}
