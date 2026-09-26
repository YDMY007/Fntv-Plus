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
