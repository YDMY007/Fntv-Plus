package bridge

import (
	"encoding/json"
	"strings"
	"testing"
)

// 回归用例：渲染层 extractTmdbId() 返回的是**字符串型** TMDB id（"66732"），
// 桌面版主进程用 /^\d+$/ 正则接受；Go 端必须同样兼容，否则 id 静默变 0 →
// 退化成「按标题搜索」→ 季页（二级详情页）元数据没有标题 → 报「标题为空」。
func TestFlexInt64AcceptsNumericString(t *testing.T) {
	cases := []struct {
		in   string
		want int64
	}{
		{`66732`, 66732},      // 数字
		{`"66732"`, 66732},    // 数字字符串（真实前端形态）
		{`" 66732 "`, 66732},  // 带空格
		{`null`, 0},           // 缺省
		{`""`, 0},             // 空串
		{`123.0`, 123},        // 浮点写法
		{`"abc"`, 0},          // 非法值宽容归零
	}
	for _, c := range cases {
		var v flexInt64
		if err := json.Unmarshal([]byte(c.in), &v); err != nil {
			t.Fatalf("Unmarshal(%s) 返回错误: %v（宽容解析不应报错）", c.in, err)
		}
		if v.Int64() != c.want {
			t.Errorf("Unmarshal(%s) = %d, 期望 %d", c.in, v.Int64(), c.want)
		}
	}
}

// 整请求体回归：tmdbId 为字符串时，同结构体的 title / seasonNumber 仍必须完整解析，
// 且 tmdbId 必须被吃下（而不是被类型错误吃掉）。
func TestTmdbShowRequestKeepsTitleAndStringId(t *testing.T) {
	body := `{"tmdbId":"66732","title":"庆余年","year":"2019","mediaType":"tv","seasonNumber":1}`
	var req struct {
		TmdbID       flexInt64  `json:"tmdbId"`
		Title        string     `json:"title"`
		Year         string     `json:"year"`
		MediaType    string     `json:"mediaType"`
		SeasonNumber *flexInt64 `json:"seasonNumber"`
	}
	if err := json.NewDecoder(strings.NewReader(body)).Decode(&req); err != nil {
		t.Fatalf("Decode 失败: %v", err)
	}
	if req.TmdbID.Int64() != 66732 {
		t.Errorf("tmdbId 未被正确解析: got %d, 期望 66732", req.TmdbID.Int64())
	}
	if req.Title != "庆余年" {
		t.Errorf("title 解析异常: got %q", req.Title)
	}
	if req.SeasonNumber == nil || req.SeasonNumber.Int64() != 1 {
		t.Errorf("seasonNumber 解析异常: %v", req.SeasonNumber)
	}
}

// 有 tmdbId 时即便标题为空也必须直取（季页元数据常无标题，这正是报障场景）。
func TestResolveShowIDPrefersTmdbID(t *testing.T) {
	b := &Bridge{}
	got, err := b.resolveShowID("tv", 66732, "", "")
	if err != nil {
		t.Fatalf("有 tmdbId 却报错: %v", err)
	}
	if got != 66732 {
		t.Errorf("resolveShowID = %d, 期望 66732", got)
	}
}
