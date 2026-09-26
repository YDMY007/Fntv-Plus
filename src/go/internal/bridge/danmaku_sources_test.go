// bridge/danmaku_sources_test.go —— [v1.11.0] 三源明细（meta.sources）契约测试。
//
// 网页播放器「来源详情」按 自建源 → 弹弹play → B站 分列展示每个源的匹配详情。
// 这里钉住后端契约：顺序固定、标记 used、各源专属字段齐全、未参与的源也占位。
package bridge

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"fntvplus/internal/config"
)

// TestDanmuSortSourcesFixedOrder 展示顺序固定为 自建源 → B站 → 弹弹play（与源链优先级一致）。
func TestDanmuSortSourcesFixedOrder(t *testing.T) {
	in := []danmuSourceDetail{
		{Key: "bilibili", Label: "B站"},
		{Key: "danmu_api", Label: "自建源(danmu_api)"},
		{Key: "dandanplay", Label: "弹弹play"},
	}
	got := danmuSortSources(in)
	want := []string{"danmu_api", "bilibili", "dandanplay"}
	for i, k := range want {
		if got[i].Key != k {
			t.Fatalf("第 %d 位应为 %s，实际 %s（全序：%v）", i+1, k, got[i].Key, keysOf(got))
		}
	}
	// 不修改入参（返回值是副本）
	if in[0].Key != "bilibili" {
		t.Error("danmuSortSources 不应改动入参切片")
	}
}

func keysOf(list []danmuSourceDetail) []string {
	out := make([]string, 0, len(list))
	for _, d := range list {
		out = append(out, d.Key)
	}
	return out
}

// TestDanmuMarkUsedOnlyTarget 只标记目标源为 used，并写入条数与屏蔽数。
func TestDanmuMarkUsedOnlyTarget(t *testing.T) {
	list := []danmuSourceDetail{
		{Key: "danmu_api", Label: "自建源(danmu_api)", Enabled: true},
		{Key: "dandanplay", Label: "弹弹play", Enabled: true},
		{Key: "bilibili", Label: "B站", Enabled: true},
	}
	got := danmuMarkUsed(list, "dandanplay", 100, 87)
	used := 0
	for _, d := range got {
		if d.Used {
			used++
			if d.Key != "dandanplay" {
				t.Errorf("used 标在了错误的源上: %s", d.Key)
			}
			if d.RawCount != 100 || d.Count != 87 || d.Blocked != 13 {
				t.Errorf("条数未写入: raw=%d count=%d blocked=%d", d.RawCount, d.Count, d.Blocked)
			}
		}
	}
	if used != 1 {
		t.Errorf("应恰有一个源标记 used，实际 %d", used)
	}
}

// TestDanmuUpsertSourceReplacesPlaceholder 占位项被实际明细替换，且保留原 note（若无新 note）。
func TestDanmuUpsertSourceReplacesPlaceholder(t *testing.T) {
	list := []danmuSourceDetail{
		{Key: "danmu_api", Label: "自建源(danmu_api)", Note: "未启用"},
		{Key: "bilibili", Label: "B站"},
	}
	got := upsertSource(list, danmuSourceDetail{
		Key: "danmu_api", Label: "自建源(danmu_api)", Enabled: true, EpisodeID: 12345, MatchedTitle: "某番",
	})
	if len(got) != 2 {
		t.Fatalf("应替换而非追加: %d", len(got))
	}
	d, _ := danmuSourceOf(got, "danmu_api")
	if !d.Enabled || d.EpisodeID != 12345 || d.MatchedTitle != "某番" {
		t.Errorf("明细未替换成功: %+v", d)
	}
	if d.Note != "未启用" {
		t.Errorf("新明细未带 note 时应保留占位 note: %q", d.Note)
	}
}

// TestDanmuUpsertSourceAppendsWhenMissing 不存在时追加。
func TestDanmuUpsertSourceAppendsWhenMissing(t *testing.T) {
	got := upsertSource(nil, danmuSourceDetail{Key: "bilibili", Label: "B站", Count: 5})
	if len(got) != 1 || got[0].Key != "bilibili" {
		t.Fatalf("应追加: %+v", got)
	}
}

// TestDanmuSourceOf 按 key 取值。
func TestDanmuSourceOf(t *testing.T) {
	list := []danmuSourceDetail{{Key: "bilibili", Count: 7}}
	if d, ok := danmuSourceOf(list, "bilibili"); !ok || d.Count != 7 {
		t.Errorf("应取到 bilibili: ok=%v %+v", ok, d)
	}
	if _, ok := danmuSourceOf(list, "dandanplay"); ok {
		t.Error("不存在的 key 应返回 false")
	}
}

// TestDanmuServeResultCarriesThreeSources 优选源命中时响应必须带三个源的明细。
func TestDanmuServeResultCarriesThreeSources(t *testing.T) {
	cfg := config.Default()
	b := New(cfg, "http://127.0.0.1:5666")

	items := []map[string]any{{"time": 1.0, "type": 1.0, "color": 16777215.0, "text": "x"}}
	kept := b.biliFilterDanmaku(items)
	sources := []danmuSourceDetail{
		{Key: "bilibili", Label: "B站", Enabled: true, Credential: "未登录（匿名）"},
		{Key: "danmu_api", Label: danmuSourceLabel, Enabled: false, Note: "未启用"},
		{Key: "dandanplay", Label: ddpSourceLabel, Enabled: true,
			MatchedTitle: "某番", EpisodeTitle: "第1话", EpisodeID: 777, Credential: "内置凭证"},
	}

	rec := httptest.NewRecorder()
	b.danmuServeResult(rec, "某番", 1, 1, false, "dandanplay", ddpSourceLabel, items, kept, "", sources)

	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	meta, _ := out["meta"].(map[string]any)
	if meta == nil {
		t.Fatal("缺少 meta")
	}
	raw, ok := meta["sources"].([]any)
	if !ok || len(raw) != 3 {
		t.Fatalf("sources 应有 3 个源，实际 %d", len(raw))
	}
	// 顺序固定
	wantOrder := []string{"danmu_api", "bilibili", "dandanplay"}
	for i, w := range wantOrder {
		m, _ := raw[i].(map[string]any)
		if m["key"] != w {
			t.Errorf("第 %d 位应为 %s，实际 %v", i+1, w, m["key"])
		}
	}
	// 只有弹弹play 标 used，且带集 id 与凭证
	used := 0
	for _, r := range raw {
		m, _ := r.(map[string]any)
		if m["used"] == true {
			used++
			if m["key"] != "dandanplay" {
				t.Errorf("used 应在 dandanplay: %v", m["key"])
			}
			if int64(m["episodeId"].(float64)) != 777 {
				t.Errorf("episodeId 未下发: %v", m["episodeId"])
			}
			if m["credential"] != "内置凭证" {
				t.Errorf("credential 未下发: %v", m["credential"])
			}
		}
	}
	if used != 1 {
		t.Errorf("应恰有一个 used，实际 %d", used)
	}
	// 未参与的源自建源保留说明
	api, _ := danmuSourceOf(sources, "danmu_api")
	if api.Note != "未启用" {
		t.Errorf("未参与的源应带原因: %+v", api)
	}
}

// TestLoginLabel / TestBiliNote 小工具文案（网页端直接展示，不能为空）。
func TestLoginLabelAndBiliNote(t *testing.T) {
	if loginLabel(true) == "" || loginLabel(false) == "" {
		t.Error("登录态标签不应为空")
	}
	if loginLabel(true) == loginLabel(false) {
		t.Error("登录/未登录标签应不同")
	}
	if biliNote(false) == "" {
		t.Error("B站 关闭时应有原因文案")
	}
	if biliNote(true) != "" {
		t.Error("B站 启用时不应有原因文案")
	}
}

// TestDanmuMinCountDefault 弹幕下限默认值 = 100（v1.11.1 由 20 提高）。
//
// 该阈值决定「拿到多少条算够用、不必再往下探更全的源」，也直接决定弹弹play 兜底的调用频率。
// 钉住它避免日后被无意改回小值（会让薄弹幕集过早停止找源）。
func TestDanmuMinCountDefault(t *testing.T) {
	if danmuMinCountDefault != 100 {
		t.Errorf("默认下限应为 100，实际 %d", danmuMinCountDefault)
	}
	cfg := config.Default()
	b := New(cfg, "http://127.0.0.1:5666")

	// 未设置 → 用默认值
	if got := b.danmuMinCount(); got != 100 {
		t.Errorf("未设置时应返回默认 100，实际 %d", got)
	}
	// 显式设置覆盖默认
	_ = cfg.SetSetting("danmuMinCount", float64(30))
	if got := b.danmuMinCount(); got != 30 {
		t.Errorf("显式设置应生效，实际 %d", got)
	}
	// 0 = 不启用（拿到多少算多少）
	_ = cfg.SetSetting("danmuMinCount", float64(0))
	if got := b.danmuMinCount(); got != 0 {
		t.Errorf("0 应被接受为「不启用」，实际 %d", got)
	}
	// 非法值回落默认
	_ = cfg.SetSetting("danmuMinCount", "abc")
	if got := b.danmuMinCount(); got != 100 {
		t.Errorf("非法值应回落默认 100，实际 %d", got)
	}
	// 负值回落默认（负数无意义）
	_ = cfg.SetSetting("danmuMinCount", float64(-5))
	if got := b.danmuMinCount(); got != 100 {
		t.Errorf("负值应回落默认 100，实际 %d", got)
	}
}
