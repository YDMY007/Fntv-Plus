package utils

import (
	"bytes"
	"crypto/sha1"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httputil"
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

	// 创建反向代理
	proxy := httputil.NewSingleHostReverseProxy(&targetNoUser)

	// 设置超时时间
	proxy.Transport = &http.Transport{
		ResponseHeaderTimeout: 120 * time.Second,
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: skipVerify,
		},
	}

	// 修改请求前的处理
	proxy.Director = func(req *http.Request) {
		// 设置原始请求信息
		req.URL.Scheme = target.Scheme
		req.URL.Host = target.Host
		req.URL.Path = target.Path
		req.URL.RawQuery = target.RawQuery
		req.Host = target.Host

		// 复制原始请求的头部
		for key, values := range c.Request.Header {
			for _, value := range values {
				req.Header.Set(key, value)
			}
		}

		// 添加额外的头部信息
		for key, value := range extraHeaders {
			req.Header.Set(key, value)
		}

		logger.Infof("method:%s path:%s query:%s, header:%v", req.Method, req.URL.Path, req.URL.RawQuery, req.Header)

		// 如果客户端没带 Authorization，但 URL 有 userinfo，就补上 BasicAuth
		if req.Header.Get("Authorization") == "" && hasUser {
			req.SetBasicAuth(uName, uPass)
		}

		// 设置请求方法
		req.Method = c.Request.Method

		// 如果有请求体，复制它
		if c.Request.Body != nil {
			bodyBytes, err := io.ReadAll(c.Request.Body)
			if err == nil {
				req.Body = io.NopCloser(bytes.NewReader(bodyBytes))
				req.ContentLength = int64(len(bodyBytes))
			}
		}
	}

	// 修改响应后的处理
	proxy.ModifyResponse = func(resp *http.Response) error {
		// 打印相应头
		logger.Infof("响应状态: %s, 头部: %v", resp.Status, resp.Header)
		// [lc-652] STRM/网盘直链 HLS：m3u8 分片常为相对路径（如 media-xxx-549.ts?auth_key=...）。
		// 若不重写，播放器会基于「本地 playvideo 代理 URL」拼接分片 → 请求打回本地代理、
		// 却只有网盘签名参数(缺 domain/token/account) → Go 侧 parseQueryParam 400 → 整集跳过。
		// 故把相对分片/URI 重写为基于上游 m3u8 地址(target)的绝对 URL，让播放器直连网盘 CDN。
		if resp != nil && isM3U8Response(resp) {
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
		return nil
	}

	// 处理错误 - 修复：避免重复写入响应头
	proxy.ErrorHandler = func(w http.ResponseWriter, req *http.Request, err error) {
		// 检查响应是否已经开始写入
		if c.Writer.Written() {
			logger.Debugf("代理错误，但响应已开始写入: %v", err)
			return
		}
		logger.Debugf("代理错误: %v", err)
		c.JSON(500, gin.H{"error": "Proxy error", "details": err.Error()})
	}

	// 执行代理
	proxy.ServeHTTP(c.Writer, c.Request)
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
			// 恢复 body（探测字节 + 剩余流）
			rest, _ := io.ReadAll(resp.Body)
			combined := append(probe, rest...)
			resp.Body = io.NopCloser(bytes.NewReader(combined))
			resp.ContentLength = int64(len(combined))
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
