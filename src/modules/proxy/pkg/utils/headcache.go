package utils

import (
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
	headCacheMaxItems = 4        // 最多缓存的文件数（16MB × 4 = 64MB 内存上限）
	headCacheTTL      = 30 * time.Minute
	headCacheWait     = 10 * time.Second // 旁路请求等待文件头填满的最长时间
)

type headBuffer struct {
	mu      sync.Mutex
	buf     []byte
	filled  int64     // 高水位：buf[:filled] 有效
	total   int64     // 上游文件总大小（用于回 Content-Range），未知为 -1
	updated time.Time
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
// 只推进高水位；返回是否因本次写入而填满。
func (h *headBuffer) write(offset int64, p []byte) {
	if offset >= headCacheBytes || len(p) == 0 {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
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

// waitFull 等待文件头填满；超时返回 false（调用方回退到正常代理）
func (h *headBuffer) waitFull(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		if h.isFull() {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(100 * time.Millisecond)
	}
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

// tryServeHeadFromCache 命中文件头缓存则直接写回响应并返回 true。
// 仅处理「起点 0 且长度 ≤ 16MB」的小范围请求（弹幕 hash 的特征：bytes=0-16777215），
// 其余请求一律返回 false 走正常代理，行为零变化。
func tryServeHeadFromCache(c *gin.Context, key string, start, end int64) bool {
	if start != 0 || end <= 0 || end-start+1 > headCacheBytes {
		return false
	}
	hb := getHeadBuffer(key)
	if !hb.waitFull(headCacheWait) {
		logger.Debugf("[head-cache] 文件头尚未填满(等待 %v 超时)，回退正常代理", headCacheWait)
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
