package utils

import (
	"bytes"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"proxy/pkg/logger"

	"github.com/gin-gonic/gin"
)

// [lc-1000] 文件头缓存：让"只读前 16MB"的旁路请求（弹幕 hash）复用视频流已经转发过的
// 文件头字节，做到**零额外网络开销**。
//
// 背景（百度网盘 / Tailscale 隧道实测）：17GB 片子 5397s ≈ 3.15MB/s 带宽，与视频码率基本持平。
// 弹幕脚本用 curl --range 0-16777215 另拉一份文件头算 hash，即便限速 1MB/s 也会吃掉约 1/3
// 带宽 → 视频剩余带宽低于码率 → 缓冲净流失 → MPV 的 --cache-pause 触发暂停 →
// 用户看到"卡加载一直转圈"（12:59:00 开拉，12:59:05 即 pause=true）。
// 播放时 MPV 必然会先探测文件头（bytes=0-），代理转发时顺手把前 16MB 存进内存，
// 弹幕请求到来时直接从内存返回，彻底消除这次带宽竞争。

const (
	headCacheBytes    = 16 << 20 // 文件头缓存大小（与弹幕脚本 --range 0-16777215 对齐）
	headCacheMaxItems = 2        // 最多缓存的文件数（16MB × 2 = 32MB 内存上限）
	headCacheTTL      = 30 * time.Minute
)

type headBuffer struct {
	mu      sync.Mutex
	buf     []byte
	filled  int64     // 高水位：buf[:filled] 有效
	total   int64     // 上游文件总大小（用于回 Content-Range），未知为 -1
	updated time.Time
	// [lc-1004] 离线直供需要的元信息：不联系云盘就得能自己把响应头回对，
	// 并且只有上游明确声明支持 Range 时，「先回缓存前缀、再从末尾续拉」才安全。
	ctype        string
	acceptRanges bool
}

// setMeta 记录上游响应元信息。ctype 为空时不覆盖，避免用一次异常响应把已有值抹掉。
func (h *headBuffer) setMeta(ctype string, acceptRanges bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if ctype != "" {
		h.ctype = ctype
	}
	h.acceptRanges = h.acceptRanges || acceptRanges
	h.updated = time.Now()
}

// prefixSnapshot 返回已缓存的文件头前缀副本，以及离线直供所需的元信息。
func (h *headBuffer) prefixSnapshot() (data []byte, total int64, ctype string, canSplice bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.filled > 0 {
		data = append([]byte(nil), h.buf[:h.filled]...)
	}
	return data, h.total, h.ctype, h.acceptRanges
}

var headCache = struct {
	mu    sync.Mutex
	items map[string]*headBuffer
	order []string // LRU：末尾为最近使用
}{items: make(map[string]*headBuffer)}

func getHeadBuffer(key string) *headBuffer {
	headCache.mu.Lock()
	defer headCache.mu.Unlock()

	if hb, ok := headCache.items[key]; ok {
		for i, k := range headCache.order {
			if k == key {
				headCache.order = append(headCache.order[:i], headCache.order[i+1:]...)
				break
			}
		}
		headCache.order = append(headCache.order, key)
		return hb
	}

	hb := &headBuffer{buf: make([]byte, headCacheBytes), total: -1, updated: time.Now()}
	headCache.items[key] = hb
	headCache.order = append(headCache.order, key)

	// 超容量淘汰
	for len(headCache.order) > headCacheMaxItems {
		victim := headCache.order[0]
		headCache.order = headCache.order[1:]
		delete(headCache.items, victim)
	}
	// 过期淘汰
	now := time.Now()
	for i := 0; i < len(headCache.order); i++ {
		k := headCache.order[i]
		if hb2, ok := headCache.items[k]; ok && now.Sub(hb2.updated) > headCacheTTL {
			headCache.order = append(headCache.order[:i], headCache.order[i+1:]...)
			delete(headCache.items, k)
			i--
		}
	}
	return hb
}

// write 把流偏移 offset 处的这段数据写入缓存。重复区间直接覆盖（内容相同，无害），
// 只推进高水位。
//
// [lc-1004] 只接受与已有前缀**连续**的写入（offset <= filled）。offset > filled 说明中间有
// 空洞 —— 例如播放器 seek 到文件头范围内某偏移发 `Range: bytes=8000000-9000000`，
// 转发时会以 offset=8000000 建 headTee，而 0..8MB 从未被写过（全是零字节）。
// 若无条件推进 filled，这 8MB 零字节就会被当成有效容器头直供给播放器 → 静默损坏。
// 宁可丢掉这一段，也不能污染高水位。
func (h *headBuffer) write(offset int64, p []byte) {
	if offset >= headCacheBytes || len(p) == 0 {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if offset > h.filled {
		return
	}
	if offset+int64(len(p)) > headCacheBytes {
		p = p[:headCacheBytes-offset]
	}
	copy(h.buf[offset:], p)
	if end := offset + int64(len(p)); end > h.filled {
		h.filled = end
	}
	h.updated = time.Now()
}

func (h *headBuffer) setTotal(total int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.total = total
}

func (h *headBuffer) isFull() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.filled >= headCacheBytes
}

// lookupHeadBuffer 只查不建：读路径（弹幕 hash）用它，避免为一个可能根本不会被填充的
// key 白分配 16MB，也避免把「等待填满」这种阻塞语义带进请求处理。
func lookupHeadBuffer(key string) *headBuffer {
	headCache.mu.Lock()
	defer headCache.mu.Unlock()
	return headCache.items[key]
}

// snapshot 返回 [start, end]（闭区间）数据副本；数据不足返回 nil
func (h *headBuffer) snapshot(start, end int64) ([]byte, int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if start < 0 || end >= h.filled || end < start {
		return nil, -1
	}
	return append([]byte(nil), h.buf[start:end+1]...), h.total
}

// headTee 在流式转发的同时把文件头写入缓存（只写前 16MB，之后退化为直通）
type headTee struct {
	hb     *headBuffer
	offset int64
}

func (t *headTee) Write(p []byte) (int, error) {
	if t == nil || t.hb == nil || t.offset >= headCacheBytes {
		return len(p), nil
	}
	t.hb.write(t.offset, p)
	t.offset += int64(len(p))
	return len(p), nil
}

// parseRangeHeader 解析 "bytes=start-end"。
// 无 Range 视为 start=0、hasEnd=false；多段 Range 不支持（ok=false）。
func parseRangeHeader(v string) (start, end int64, hasEnd, ok bool) {
	if strings.TrimSpace(v) == "" {
		return 0, -1, false, true
	}
	if !strings.HasPrefix(v, "bytes=") {
		return 0, 0, false, false
	}
	body := strings.TrimPrefix(v, "bytes=")
	if strings.Contains(body, ",") {
		return 0, 0, false, false
	}
	parts := strings.SplitN(body, "-", 2)
	if len(parts) != 2 {
		return 0, 0, false, false
	}
	if parts[0] != "" {
		s, err := strconv.ParseInt(strings.TrimSpace(parts[0]), 10, 64)
		if err != nil {
			return 0, 0, false, false
		}
		start = s
	}
	if parts[1] != "" {
		e, err := strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64)
		if err != nil {
			return 0, 0, false, false
		}
		end, hasEnd = e, true
	} else {
		end = -1
	}
	if hasEnd && end < start {
		return 0, 0, false, false
	}
	return start, end, hasEnd, true
}

// parseTotalFromContentRange 从 "bytes s-e/total" 取 total；解析失败返回 -1
func parseTotalFromContentRange(v string) int64 {
	idx := strings.LastIndex(v, "/")
	if idx < 0 {
		return -1
	}
	total, err := strconv.ParseInt(strings.TrimSpace(v[idx+1:]), 10, 64)
	if err != nil {
		return -1
	}
	return total
}

// parseStartFromContentRange 从 "bytes s-e/total" 取起点 s。
//
// [lc-1090] 上游的 Content-Range 才是「这段正文从文件哪个偏移开始」的权威答案：
// 写文件头缓存时必须用它定位，否则中段字节会被当成文件头存进去（详见 utils.go 的 headTee）。
func parseStartFromContentRange(v string) (int64, bool) {
	body := strings.TrimSpace(v)
	if !strings.HasPrefix(body, "bytes ") {
		return 0, false
	}
	body = strings.TrimPrefix(body, "bytes ")
	if idx := strings.IndexAny(body, "-/"); idx >= 0 {
		body = body[:idx]
	}
	start, err := strconv.ParseInt(strings.TrimSpace(body), 10, 64)
	if err != nil || start < 0 {
		return 0, false
	}
	return start, true
}

// tryServeHeadFromCache 命中文件头缓存则直接写回响应并返回 true。
//
// [lc-1004] 只认弹幕脚本 hash 的**精确特征**请求（dandanplay.lua:782-783 的
// `--range 0-16777215`，即 start==0 且长度恰好 16MB），并且**绝不阻塞**：
//   - 原门禁是 `start==0 && end-start+1 <= 16MB`，把播放器起播必然先发的容器头探测
//     （如 bytes=0-1048575）也拦了进来；
//   - 原实现还要 `waitFull(10s)` 等缓存填满，而填充靠的是本请求被放行后的流式转发 ——
//     典型的自死锁。实测该请求耗时 10333ms / 10352ms（对照：普通 Range 仅 322ms），
//     且播放器读几百 KB 就断开、filled 永远填不满，于是**永不自愈**，每次起播都白等 10s。
//
// 现在缓存未满（含缓存不存在）就立即返回 false 走正常代理，行为与 lc-1000 之前一致；
// 只有视频流已经把前 16MB 灌满时才享受零网络开销的命中。
func tryServeHeadFromCache(c *gin.Context, key string, start, end int64) bool {
	if start != 0 || end != headCacheBytes-1 {
		return false
	}
	hb := lookupHeadBuffer(key)
	if hb == nil || !hb.isFull() {
		return false
	}
	data, total := hb.snapshot(start, end)
	if data == nil {
		return false
	}
	hdr := c.Writer.Header()
	hdr.Set("Content-Type", "application/octet-stream")
	hdr.Set("Accept-Ranges", "bytes")
	hdr.Set("Content-Length", strconv.FormatInt(int64(len(data)), 10))
	if total > 0 {
		hdr.Set("Content-Range", "bytes 0-"+strconv.FormatInt(int64(len(data))-1, 10)+"/"+strconv.FormatInt(total, 10))
	}
	c.Status(http.StatusPartialContent)
	if c.Request.Method != http.MethodHead {
		_, _ = c.Writer.Write(data)
	}
	logger.Infof("[head-cache] ✅ 命中文件头缓存: 返回 %d 字节(0-%d)，零网络开销", len(data), len(data)-1)
	return true
}

// headSpliceMinBytes 缓存里至少要有这么多前缀才值得直供。
//
// [lc-1004] 取 64KB 而不是 1MB：探针实测（dest/_verify/lc1004/urlstab.cjs，不带预热）
// PotPlayer 式的探测每发只读 ~310KB 就断开，1MB 门槛下 filled 永远卡在 310KB，
// 13/13 发全部 miss splice（各 312~444ms）—— 机制无法自举，只有预热跑过才有用。
// 64KB 让第一发探测就足以把缓存填到能用的量，后续每发都从内存拿首字节。
//
// 前缀小并不会更慢：splice 的上游请求是在写完并 flush 前缀**之后**才发的，
// 客户端首字节从 ~270ms 变成 ~0，而那次上游往返的代价与普通代理路径完全相同。
// 整份内容都已缓存时（见 serveHeadThenSplice）更是连这一次都省掉。
const headSpliceMinBytes = 64 << 10

// serveHeadThenSplice 处理「起点为 0、不限终点的完整流请求」（无 Range 与 `bytes=0-` 两种）：
// 先把文件头缓存里已有的前缀**立刻**写给客户端并 flush，再从缓存末尾向上游发 Range 续拉，
// 拼成一份完整响应。若整份内容都已在缓存里（HLS 播放列表就是这种），则完全不发上游请求。
//
// wantPartial 表示客户端带了 Range 头（即 `bytes=0-`），此时必须回
// `206 + Content-Range: bytes 0-(total-1)/total` —— 与 CDN 的应答逐字节等价，
// 播放器据此判定该流可 seek；没带 Range 则回 `200 + Content-Length`。
//
// [lc-1004] 为什么值得这么做（Go 日志实测）：
//
//	PotPlayer × 夸克直链，单次起播（PotPlayer 发无 Range 的 GET）：
//	  15:38:29.046 → 29.321  200 OK len=863461181
//	  ... 共 7 发，每发间隔 ~270ms ...  ← 时长信息直到第 7 发才出来(t_meta=3.9s)
//	PotPlayer × 夸克 HLS，单次起播：
//	  同一个 79215B 的 m3u8 被串行拉了 8 次，每次 ~290ms，合计 2.9s(t_meta=4.7s)
//	MPV × 夸克 HLS：MPV 一律发 `bytes=0-`，3 次播放列表请求全部回源(02.619/02.864/03.858)
//
// 每发都要 Go 重新与云盘 CDN 建连（上一发被播放器读几百 KB 就掐断 → 连接无法回池），
// 付一次 TCP+TLS+TTFB ≈270ms。缓存里已有内容就先写出去，首字节从 ~270ms 降到 ~0。
//
// 安全边界：
//   - 只接 start==0 且不限终点的请求。带终点的（如 `bytes=0-1048575`）交给
//     tryServeHeadFromCache / 正常代理，因为那里的应答长度与本函数的「整份」语义不符。
//   - 播放列表只在 VOD（正文含 #EXT-X-ENDLIST）时才用缓存回：直播列表每次都在变，
//     回一份旧的就是回一份已经不再更新的片单。
//   - 一旦写了响应头就只能一路走到底（返回 true），绝不能回退到正常代理路径再写一次头。
//   - 上游不认 Range（没回 206）时宁可掐断本次响应让播放器重试，也绝不把从 0 开始的
//     整份文件接在已写出的前缀后面 —— 数据错位不可恢复，而截断是可重试的。
func serveHeadThenSplice(c *gin.Context, key string, build func(string, io.Reader) (*http.Request, error), skipVerify, wantPartial bool) bool {
	hb := lookupHeadBuffer(key)
	if hb == nil {
		return false
	}
	head, total, ctype, canSplice := hb.prefixSnapshot()
	if len(head) == 0 || total <= 0 || ctype == "" {
		return false
	}
	filled := int64(len(head))
	if filled >= total {
		// 整份都在缓存里：只有 VOD 播放列表会走到这（视频文件远大于 16MB 缓存）
		if isPlaylistType(ctype) && !bytes.Contains(head, []byte("#EXT-X-ENDLIST")) {
			return false
		}
	} else if filled < headSpliceMinBytes || !canSplice {
		return false
	}

	hdr := c.Writer.Header()
	hdr.Set("Content-Type", ctype)
	hdr.Set("Accept-Ranges", "bytes")
	hdr.Set("Content-Length", strconv.FormatInt(total, 10))
	st := http.StatusOK
	stLabel := "200"
	if wantPartial {
		hdr.Set("Content-Range", "bytes 0-"+strconv.FormatInt(total-1, 10)+"/"+strconv.FormatInt(total, 10))
		st, stLabel = http.StatusPartialContent, "206"
	}
	c.Writer.WriteHeader(st)

	if _, err := c.Writer.Write(head); err != nil {
		return true // 客户端已断开（播放器读几百 KB 就掐是常态）
	}
	if f, ok := c.Writer.(http.Flusher); ok {
		f.Flush()
	}

	if filled >= total {
		logger.Infof("[head-splice] ✅ 整份命中缓存直供 %d 字节(type=%s, %s)，零上游请求", filled, ctype, stLabel)
		return true
	}

	req, err := build(key, nil)
	if err != nil {
		logger.Errorf("[head-splice] 构造续拉请求失败: %v", err)
		return true
	}
	req.Header.Set("Range", "bytes="+strconv.FormatInt(filled, 10)+"-")

	resp, err := upstreamClient(skipVerify).Do(req)
	if err != nil {
		logger.Errorf("[head-splice] 续拉失败: %v", err)
		return true
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusPartialContent {
		logger.Warnf("[head-splice] 上游未按 Range 续拉(status=%s)，掐断本次响应让播放器重试", resp.Status)
		return true
	}

	logger.Infof("[head-splice] ✅ 文件头直供 %d 字节(%s)，续拉自 %d/%d", filled, stLabel, filled, total)
	_ = copyStreaming(c.Writer, resp.Body, &headTee{hb: hb, offset: filled})
	return true
}

// isPlaylistType 判断 Content-Type 是否为 HLS 播放列表
func isPlaylistType(ctype string) bool {
	return strings.Contains(strings.ToLower(ctype), "mpegurl")
}
