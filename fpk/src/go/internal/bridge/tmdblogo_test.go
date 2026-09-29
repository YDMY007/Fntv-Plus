package bridge

import (
	"os"
	"strings"
	"testing"
)

// [lc-1274] fpk 桥 tmdb:logo 此前 include_image_language 只带 zh,en,null——动漫条目在
// TMDB 上常只有日语 logo，用户动漫库大面积「轮播获取不到 logo」。语言集必须包含 ja。
func TestTmdbLogoLanguageSetIncludesJa(t *testing.T) {
	data, err := os.ReadFile("bridge.go")
	if err != nil {
		t.Fatalf("读取 bridge.go 失败: %v", err)
	}
	if !strings.Contains(string(data), `"include_image_language": "zh,ja,en,null"`) {
		t.Errorf("tmdbLogo 的 include_image_language 应为 \"zh,ja,en,null\"（补 ja——动漫 logo 缺失根因），实际源码中未找到")
	}
}

// [lc-1274 对齐桌面 lc-413] logo 候选：横屏筛选 + 语言优先级（zh>ja>en>其他）+ 同语言票数降序。
func TestTmdbRankLogoPaths(t *testing.T) {
	logos := []any{
		map[string]any{"file_path": "/en.json", "iso_639_1": "en", "vote_average": 9.0, "width": 1000, "height": 500},
		map[string]any{"file_path": "/ja.json", "iso_639_1": "ja", "vote_average": 1.0, "width": 800, "height": 300},
		map[string]any{"file_path": "/zh.json", "iso_639_1": "zh", "vote_average": 1.0, "width": 900, "height": 400},
		map[string]any{"file_path": "/portrait.json", "iso_639_1": "zh", "vote_average": 10.0, "width": 300, "height": 900}, // 竖版应被筛掉
		map[string]any{"file_path": "/null.json", "vote_average": 5.0, "aspect_ratio": 1.77},                                // 无宽高退用 ar
		map[string]any{"file_path": "/unknown.json"},                                                                        // 全缺保守保留
	}
	got := tmdbRankLogoPaths(logos)
	want := []string{"/zh.json", "/ja.json", "/en.json", "/null.json", "/unknown.json"}
	if len(got) != len(want) {
		t.Fatalf("候选数 = %d, 期望 %d: %v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("排序[%d] = %s, 期望 %s（zh>ja>en>其他, 竖版筛除）", i, got[i], want[i])
		}
	}
}

// [lc-947 对齐] 全角标点归一：修「X，Y」vs TMDB「X,Y」整句匹配失败。
func TestTmdbNormPunct(t *testing.T) {
	cases := map[string]string{
		"败犬女主太多了！":  "败犬女主太多了!",
		"小书痴的下克上：":  "小书痴的下克上:",
		"夏目・友人帐":    "夏目·友人帐",
		"全角，逗号与　空格": "全角,逗号与 空格",
	}
	for in, want := range cases {
		if got := tmdbNormPunct(in); got != want {
			t.Errorf("tmdbNormPunct(%q) = %q, 期望 %q", in, got, want)
		}
	}
}

// [lc-947 对齐] 递进放宽标题：首段 / 首两段 / 16/12/8 字截断。
func TestTmdbRelaxedTitles(t *testing.T) {
	got := tmdbRelaxedTitles("小书痴的下克上：为了成为图书管理员不择手段")
	// 首段（冒号前）必须在候选里
	if got[0] != "小书痴的下克上" {
		t.Errorf("首段候选 = %q, 期望 %q", got[0], "小书痴的下克上")
	}
	for _, q := range got {
		if q == "" {
			t.Fatalf("候选含空串: %v", got)
		}
	}
	// 短标题（无分隔、长度≤8）不产生截断候选
	if got := tmdbRelaxedTitles("败犬女主"); len(got) != 0 {
		t.Errorf("短标题不应产生放宽候选, 实际 %v", got)
	}
}
