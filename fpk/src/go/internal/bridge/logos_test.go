package bridge

import "testing"

// TestLogoFileWhitelist 白名单必须放行默认兜底图：前端在「默认 / 换设备数据缺失」时
// 请求 fntv_default.png，曾因正则只认 cn_/intl_ 前缀被 404 拒 → 首页 logo 裂图（lc-1295）。
func TestLogoFileWhitelist(t *testing.T) {
	allow := []string{
		"fntv_default.png",
		"cn_bilibili.png",
		"intl_netflix.png",
		"cn_mango.png",
	}
	for _, f := range allow {
		if !logoFileRe.MatchString(f) {
			t.Errorf("白名单应放行 %q", f)
		}
	}
	deny := []string{
		"../secret.png",
		"fntv_default.png/../../etc/passwd",
		"default.png",
		"cn_.png",             // 前缀后必须有字符
		"cn_Bilibili.png",     // 大写不放行
		"logo.png",
		"fntv_default.jpg",
	}
	for _, f := range deny {
		if logoFileRe.MatchString(f) {
			t.Errorf("白名单不应放行 %q", f)
		}
	}
}

// TestLogoDefaultEmbedded 默认图必须真的 embed 在 logos 目录里（白名单放行了但文件缺失
// 同样会 404 裂图）。
func TestLogoDefaultEmbedded(t *testing.T) {
	data, err := logosFS.ReadFile("logos/fntv_default.png")
	if err != nil {
		t.Fatalf("默认 logo 未 embed: %v", err)
	}
	if len(data) < 100 || data[0] != 0x89 || data[1] != 'P' {
		t.Fatalf("默认 logo 不是有效 PNG（len=%d）", len(data))
	}
}
