package inject

import "testing"

// patchViewport 是移动端适配的地基：env(safe-area-inset-*) 在没有 viewport-fit=cover
// 时恒等于 0（飞牛影视原 meta 缺该属性，上游全站 safe-area 出现 0 次）。
// 用例里的 meta 形态取自测试 NAS 上飞牛影视的真实 HTML（自闭合 <meta ... />）。
func TestPatchViewport(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string // 非空=必须包含；空=必须原样返回
	}{
		{
			name: "上游真实形态（自闭合）",
			in:   `<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>x</title>`,
			want: `content="width=device-width,initial-scale=1,viewport-fit=cover"`,
		},
		{
			name: "非自闭合形态",
			in:   `<meta name="viewport" content="width=device-width, initial-scale=1">`,
			want: `content="width=device-width, initial-scale=1,viewport-fit=cover"`,
		},
		{
			name: "已有 viewport-fit 不重复追加",
			in:   `<meta name="viewport" content="width=device-width,viewport-fit=cover">`,
			want: "",
		},
		{
			name: "不误伤 apple-mobile-web-app 等其它 meta",
			in:   `<meta name="apple-mobile-web-app-capable" content="yes"><meta name="viewport" content="width=device-width">`,
			want: `content="width=device-width,viewport-fit=cover"`,
		},
		{
			name: "文档无 viewport meta 时不改动",
			in:   `<html><head><title>x</title></head><body></body></html>`,
			want: "",
		},
	}
	for _, c := range cases {
		got := patchViewport(c.in)
		if c.want == "" {
			if got != c.in {
				t.Errorf("%s: 不应改动\n got: %s\nwant: %s", c.name, got, c.in)
			}
			continue
		}
		if !contains(got, c.want) {
			t.Errorf("%s: 未补上 viewport-fit\n got: %s\nwant 含: %s", c.name, got, c.want)
		}
		// 幂等：重复调用不得二次追加。
		if again := patchViewport(got); again != got {
			t.Errorf("%s: 不幂等\n首次: %s\n二次: %s", c.name, got, again)
		}
	}
}

// Inject 全链路：viewport 修正必须与 payload 注入同时生效，且幂等标记各自独立。
func TestInjectPatchesViewport(t *testing.T) {
	inj, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	const upstream = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body><div id="root"></div></body></html>`

	out, ok := inj.Inject(upstream, false)
	if !ok {
		t.Fatal("首次 Inject 应返回 ok=true")
	}
	if !contains(out, "viewport-fit=cover") {
		t.Error("Inject 后应带上 viewport-fit=cover")
	}
	if !contains(out, markerBegin) {
		t.Error("Inject 后应带 payload 脚本标记")
	}
	// 幂等：已注入的 HTML 再次进入不应改变。
	if _, ok2 := inj.Inject(out, false); ok2 {
		t.Error("已注入的 HTML 不应重复注入")
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
