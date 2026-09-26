package bridge

import (
	"testing"

	"fntvplus/internal/config"
)

// 诊断：cid 已知有弹幕（280610398 实测 600 条）时 biliFetchDanmakuXML 返回什么。
func TestTmpFetchXML(t *testing.T) {
	cfg := config.Default()
	b := New(cfg, "http://127.0.0.1:5666")

	for _, cid := range []int64{280610398, 36029926455, 35418605716} {
		items := b.biliFetchDanmakuXML(cid)
		t.Logf("cid=%d → %d 条", cid, len(items))
	}
}
