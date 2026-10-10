package bridge

import (
	"testing"
	"time"
)

// [lc-1341] 自建源没被采用时，缓存的重探 TTL 必须缩短（10 分钟），而不是默认 6 小时。
//
// 真机现场：ep5 那次自建源失败 → 源链退到 B站 拿到一条宣传视频 → 结果连同「6 小时内不再
// 探测」一起落盘 → 之后每次播放都吃这份缓存，自建源再也没被问过；用户手动清记忆后才恢复
// （同一集自建源 10720 条）。这组用例把「哪些情况算没被采用」钉死。
func TestDanmuSelfSourceFailedDetection(t *testing.T) {
	cases := []struct {
		name string
		meta map[string]any
		want bool
	}{
		{"sources 里没有自建源", map[string]any{"sources": []any{}}, false},
		{"自建源被采用", map[string]any{"sources": []any{
			map[string]any{"key": "danmu_api", "used": true},
		}}, false},
		{"自建源未启用", map[string]any{"sources": []any{
			map[string]any{"key": "danmu_api", "note": "未启用"},
		}}, false},
		{"自建源搜索无匹配", map[string]any{"sources": []any{
			map[string]any{"key": "danmu_api", "note": "搜索无精确匹配条目"},
		}}, true},
		{"自建源条数不足未采用", map[string]any{"sources": []any{
			map[string]any{"key": "danmu_api", "note": "命中 40 条，低于下限 100，未采用"},
		}}, true},
		{"只作候选未采用（used 缺失）", map[string]any{"sources": []any{
			map[string]any{"key": "danmu_api", "count": 40},
		}}, true},
		{"B站 被采用而自建源没参与", map[string]any{"sources": []any{
			map[string]any{"key": "bilibili", "used": true},
		}}, false},
	}
	for _, c := range cases {
		if got := danmuSelfSourceFailed(c.meta); got != c.want {
			t.Fatalf("%s：got=%v want=%v", c.name, got, c.want)
		}
	}
}

func TestDanmuCacheTTLShortensWhenSelfFailed(t *testing.T) {
	failed := map[string]any{
		"checkedAt": float64(time.Now().Add(-30 * time.Minute).Unix()),
		"sources": []any{
			map[string]any{"key": "danmu_api", "note": "搜索无精确匹配条目"},
			map[string]any{"key": "bilibili", "used": true},
		},
	}
	if danmuCacheCheckedRecently(failed) {
		t.Fatal("自建源没被采用且已过 30 分钟 → 应判为需要重探（短 TTL 生效）")
	}

	fresh := map[string]any{
		"checkedAt": float64(time.Now().Add(-5 * time.Minute).Unix()),
		"sources":   []any{map[string]any{"key": "danmu_api", "note": "搜索无精确匹配条目"}},
	}
	if !danmuCacheCheckedRecently(fresh) {
		t.Fatal("自建源没被采用但只过了 5 分钟 → 仍在短 TTL 内，不该重探")
	}

	used := map[string]any{
		"checkedAt": float64(time.Now().Add(-30 * time.Minute).Unix()),
		"sources":   []any{map[string]any{"key": "danmu_api", "used": true}},
	}
	if !danmuCacheCheckedRecently(used) {
		t.Fatal("自建源已采用 → 走默认 6 小时 TTL，30 分钟内不该重探")
	}

	disabled := map[string]any{
		"checkedAt": float64(time.Now().Add(-30 * time.Minute).Unix()),
		"sources":   []any{map[string]any{"key": "danmu_api", "note": "未启用"}},
	}
	if !danmuCacheCheckedRecently(disabled) {
		t.Fatal("没启用自建源 → 不该因为它缩短 TTL")
	}
}