package bridge

import "testing"

// [lc-1338] B站视频区候选的「错集一票否决 + 非正片剔除」排序。
// 用例标题全部取自真机日志（2026-10-10「少女乐队的呐喊」第 5 集截胡现场），
// 防的是「宣传视频弹幕够多就被当正片」这类回归。
func TestOrderBiliCandidatesEpisodeVeto(t *testing.T) {
	cands := []map[string]any{
		{"bvid": "BV1PV", "title": "大家好！我们是《少女乐队的呐喊》的KUZUMIMIZUKU！我们来B站啦~"}, // 日志里截胡的那条
		{"bvid": "BV1EP5", "title": "【少女乐队的呐喊】第 5 话 官方中字"},
		{"bvid": "BV1EP7", "title": "少女乐队的呐喊 第7话"},
		{"bvid": "BV1LIST", "title": "少女乐队的呐喊 01-13 合集"},
		{"bvid": "BV1MV", "title": "少女乐队的呐喊 OP「名的ない何か」MV"},
	}
	got := orderBiliCandidates(cands, 5)
	ids := make([]string, 0, len(got))
	for _, v := range got {
		ids = append(ids, jsStr(v["bvid"]))
	}
	if len(ids) == 0 || ids[0] != "BV1EP5" {
		t.Fatalf("命中本集的候选必须排第一，实际顺序 %v", ids)
	}
	for _, dead := range []string{"BV1PV", "BV1EP7", "BV1MV"} {
		for _, id := range ids {
			if id == dead {
				t.Fatalf("应被剔除的候选 %s 仍在结果里：%v", dead, ids)
			}
		}
	}
	for _, keep := range []string{"BV1EP5", "BV1LIST"} {
		found := false
		for _, id := range ids {
			if id == keep {
				found = true
			}
		}
		if !found {
			t.Fatalf("应保留的候选 %s 丢了：%v", keep, ids)
		}
	}
}

// 电影（ep<=0）不做任何集号判断：候选原序返回，一条都不许丢。
func TestOrderBiliCandidatesMovieUnchanged(t *testing.T) {
	cands := []map[string]any{
		{"bvid": "BVA", "title": "某电影 PV 预告"},
		{"bvid": "BVB", "title": "某电影 第7话（无关标题）"},
	}
	got := orderBiliCandidates(cands, 0)
	if len(got) != len(cands) {
		t.Fatalf("电影请求不应筛除候选：before=%d after=%d", len(cands), len(got))
	}
	for i := range cands {
		if jsStr(got[i]["bvid"]) != jsStr(cands[i]["bvid"]) {
			t.Fatalf("电影请求应保持原序，位置 %d 变了", i)
		}
	}
}

// 集号提取只认结构化写法，裸数字不当集号（避免用年份/清晰度做一票否决误杀正片）。
func TestEpNumbersInTitleStructuredOnly(t *testing.T) {
	cases := []struct {
		title string
		want  []int64
	}{
		{"少女乐队的呐喊 第 5 话", []int64{5}},
		{"某番 EP05", []int64{5}},
		{"某番 #12", []int64{12}},
		{"某番 2024 1080P", nil},
		{"第 5 话 - 1080P 第 6 话", []int64{5, 6}},
	}
	for _, c := range cases {
		got := epNumbersInTitle(c.title)
		if len(got) != len(c.want) {
			t.Fatalf("%q 集号数不符：got=%v want=%v", c.title, got, c.want)
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Fatalf("%q 集号不符：got=%v want=%v", c.title, got, c.want)
			}
		}
	}
}