// bridge/danmaku_decompress_test.go — [v1.4.4] list.so 弹幕体解压回归。
// 实测背景：B站 /x/v1/dm/list.so 无视 Accept-Encoding 回 raw deflate 压缩 XML，
// Go http.Transport 只自动解 gzip → 旧版解析 0 条 →「该条目没有弹幕」。
package bridge

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"testing"
)

var dmSampleXML = []byte(`<?xml version="1.0" encoding="UTF-8"?><i><chatserver>chat.bilibili.com</chatserver><d p="1.5,1,25,16777215,0,0,0,0">你好</d><d p="9.9,1,25,16777215,0,0,0,0">世界</d></i>`)

func deflateRaw(b []byte) []byte {
	var buf bytes.Buffer
	w, _ := flate.NewWriter(&buf, flate.DefaultCompression)
	w.Write(b)
	w.Close()
	return buf.Bytes()
}

func TestDecompressRawDeflate(t *testing.T) { // 实测 list.so 形态
	got := decompressDanmakuBody(deflateRaw(dmSampleXML))
	if !bytes.Contains(got, []byte("你好")) {
		t.Fatalf("raw deflate 解压失败: %q", got[:minInt(len(got), 60)])
	}
}

func TestDecompressGzip(t *testing.T) {
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	w.Write(dmSampleXML)
	w.Close()
	got := decompressDanmakuBody(buf.Bytes())
	if !bytes.Contains(got, []byte("你好")) {
		t.Fatalf("gzip 解压失败")
	}
}

func TestDecompressZlib(t *testing.T) {
	var buf bytes.Buffer
	w := zlib.NewWriter(&buf)
	w.Write(dmSampleXML)
	w.Close()
	got := decompressDanmakuBody(buf.Bytes())
	if !bytes.Contains(got, []byte("你好")) {
		t.Fatalf("zlib 解压失败")
	}
}

func TestDecompressPlainPassthrough(t *testing.T) { // 明文 XML 原样
	got := decompressDanmakuBody(dmSampleXML)
	if !bytes.Equal(got, dmSampleXML) {
		t.Fatalf("明文应原样返回")
	}
}

func TestParseDanmakuAfterDeflate(t *testing.T) { // 端到端：解压→解析→条目
	items := parseDanmakuXML(decompressDanmakuBody(deflateRaw(dmSampleXML)))
	if len(items) != 2 || items[0]["text"] != "你好" || items[0]["time"] != 1.5 {
		t.Fatalf("解析异常: %v", items)
	}
}
