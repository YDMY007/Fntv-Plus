// bridge/sync_bangumi_test.go — [v1.4.2] bangumiReq 传输多路化的单测。
// dnsQueryAFrom 的报文组包/应答解析是手写二进制逻辑，必须用固定报文回归；
// 网络相关路径（UDP 查询真服务器）在 CI 不可依赖，只测「应答解析」与「坏报文容错」。
package bridge

import (
	"encoding/binary"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"fntvplus/internal/config"
)

// buildDNSResponse 构造一条 DNS 应答：question=name A IN，answers 为 A 记录 IP 列表
// （首条用压缩指针偏移 12 指向 question 名字，与真实服务器行为一致）。
func buildDNSResponse(t *testing.T, id uint16, name string, ips ...string) []byte {
	t.Helper()
	// question 编码
	var q []byte
	for _, part := range strings.Split(name, ".") {
		q = append(q, byte(len(part)))
		q = append(q, part...)
	}
	q = append(q, 0, 0, 1, 0, 1) // 结尾 + QTYPE=A + QCLASS=IN

	msg := make([]byte, 12)
	binary.BigEndian.PutUint16(msg[0:], id)
	binary.BigEndian.PutUint16(msg[2:], 0x8180) // QR+RD+RA
	binary.BigEndian.PutUint16(msg[4:], 1)      // QDCOUNT
	binary.BigEndian.PutUint16(msg[6:], uint16(len(ips)))
	msg = append(msg, q...)

	for range ips {
		msg = append(msg, 0xC0, 0x0C) // NAME = 指针到 offset 12（question 名）
		msg = append(msg, 0, 1)       // TYPE=A
		msg = append(msg, 0, 1)       // CLASS=IN
		msg = append(msg, 0, 0, 0, 60)
		msg = append(msg, 0, 4)
		msg = append(msg, net.ParseIP(ips[0]).To4()...)
	}
	return msg
}

func TestDNSQueryAFromParsesCompressedAnswer(t *testing.T) {
	// 起一个假 UDP DNS 服务器回固定报文
	resp := buildDNSResponse(t, 0, "api.bgm.tv", "108.128.94.121")
	srv, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer srv.Close()
	go func() {
		buf := make([]byte, 512)
		for {
			n, addr, err := srv.ReadFrom(buf)
			if err != nil {
				return
			}
			if n >= 2 {
				resp[0], resp[1] = buf[0], buf[1] // 回显事务 ID
			}
			_, _ = srv.WriteTo(resp, addr)
		}
	}()

	port := srv.LocalAddr().(*net.UDPAddr).Port
	got := dnsQueryAFrom("api.bgm.tv", "127.0.0.1:"+fmt.Sprint(port), 2*time.Second)
	if got != "108.128.94.121" {
		t.Fatalf("dnsQueryAFrom = %q, want 108.128.94.121", got)
	}
}

func TestDNSQueryAFromBadIDRejected(t *testing.T) {
	// 服务器回固定错误 ID → 客户端必须拒收（防串包），返回 ""
	resp := buildDNSResponse(t, 0x9999, "api.bgm.tv", "1.2.3.4")
	srv, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer srv.Close()
	go func() {
		buf := make([]byte, 512)
		for {
			_, addr, err := srv.ReadFrom(buf)
			if err != nil {
				return
			}
			_, _ = srv.WriteTo(resp, addr) // ID 不回显（恒 0x9999）
		}
	}()
	got := dnsQueryAFrom("api.bgm.tv", srv.LocalAddr().String(), 2*time.Second)
	if got != "" {
		t.Fatalf("mismatched DNS id 应拒收, got %q", got)
	}
}

func TestDNSQueryAFromTimeout(t *testing.T) {
	// 无服务器应答 → 超时返回 ""（不 panic、不阻塞超过 timeout+余量）
	start := time.Now()
	got := dnsQueryAFrom("api.bgm.tv", "127.0.0.1:1", 1*time.Second) // port 1 = discard, 无应答必超时
	if got != "" {
		t.Fatalf("超时应返回空, got %q", got)
	}
	if time.Since(start) > 3*time.Second {
		t.Fatalf("超时未按 deadline 返回: %v", time.Since(start))
	}
}

func TestBangumiClientPriorityProxyOverDirect(t *testing.T) {
	b := &Bridge{cfg: config.Default()} // 无 env 代理、默认配置 → 走公共 DNS 或系统直连
	// 无代理无缓存 → 系统直连（nil client）或公共 DNS 直连（能解析时），二者皆合法；
	// 此处只验证不 panic 且 via 标签合法。
	_, via := b.bangumiClient()
	if via != "系统直连" && via != "公共DNS直连" {
		t.Fatalf("via = %q", via)
	}
}

func TestBangumiErrLabelClassification(t *testing.T) {
	// [2026-10-03] 失败归类：面板与日志据此区分「网络被墙 / Token 失效 / 限流 / 服务端」——
	// 此前只打原始 error，用户分不清该修网络还是换 Token。
	cases := []struct {
		st    int
		err   error
		label string
	}{
		{0, fmt.Errorf("context deadline exceeded"), "网络"},
		{0, fmt.Errorf("dial tcp: connection reset by peer"), "网络"},
		{0, fmt.Errorf("dial udp: lookup api.bgm.tv: no such host"), "网络"},
		{401, nil, "密钥"},
		{403, nil, "密钥"},
		{429, nil, "限流"},
		{502, nil, "服务"},
		{400, nil, "请求"},
	}
	for _, c := range cases {
		label, brief := bangumiErrLabel(c.st, c.err)
		if label != c.label {
			t.Fatalf("bangumiErrLabel(%d, %v) label = %q, want %q", c.st, c.err, label, c.label)
		}
		if brief == "" {
			t.Fatalf("bangumiErrLabel(%d, %v) brief 为空", c.st, c.err)
		}
	}
}

func TestFindBangumiEpisodeIDMatchesV0Fields(t *testing.T) {
	// 现行 v0 API 分集对象只有 ep/sort（旧 API 的 number 字段已不存在），必须按 ep→sort 匹配
	resp := map[string]any{
		"data": []any{
			map[string]any{"id": 101, "ep": 1, "sort": 1.0},
			map[string]any{"id": 102, "ep": 2, "sort": 2.0},
			map[string]any{"id": 103, "ep": float64(0), "sort": 3.0}, // SP：ep=0，按 sort 命中第 3 集
		},
	}
	if got := findBangumiEpisodeID(resp, 2); got != 102 {
		t.Fatalf("ep 精确匹配: got %d, want 102", got)
	}
	if got := findBangumiEpisodeID(resp, 3); got != 103 {
		t.Fatalf("sort 兜底匹配: got %d, want 103", got)
	}
	if got := findBangumiEpisodeID(map[string]any{"data": []any{}}, 1); got != 0 {
		t.Fatalf("空列表应返回 0, got %d", got)
	}
}

func TestFindBangumiSubjectIDTakesFirstHit(t *testing.T) {
	resp := map[string]any{
		"data": []any{map[string]any{"id": 425}, map[string]any{"id": 999}},
	}
	if got := findBangumiSubjectID(resp); got != 425 {
		t.Fatalf("got %d, want 425", got)
	}
	if got := findBangumiSubjectID(map[string]any{"data": []any{}}); got != 0 {
		t.Fatalf("无结果应返回 0, got %d", got)
	}
}

func TestSetBgmStatusShape(t *testing.T) {
	setBgmStatus(false, "search", "网络", "连接被重置(疑似 SNI 阻断)")
	bgmStatusMu.Lock()
	s := bgmLastStatus
	bgmStatusMu.Unlock()
	if s == nil || s["ok"] != false || s["label"] != "网络" || s["stage"] != "search" {
		t.Fatalf("状态记录形状不对: %v", s)
	}
	if _, ok := s["ts"].(int64); !ok {
		t.Fatalf("ts 应为毫秒时间戳 int64: %v", s["ts"])
	}
}
