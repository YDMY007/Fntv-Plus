// internal/config/config_test.go —— 敏感配置的落盘加密与下发脱敏。
//
// 关键断言：config.json 文件内容里**不出现 Secret 明文**；settings API 下发的
// JSON 里**不出现 Secret 明文**；业务侧 GetSetting 拿到的是明文（透明解密）。
package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"fntvplus/internal/secret"
)

// newTestConfig 在临时目录创建配置（盐文件随之生成）。
func newTestConfig(t *testing.T) *Config {
	t.Helper()
	dir := t.TempDir()
	// 每个用例独立绑定盐目录：secret 包的盐是包级状态，用例间需隔离
	secret.BindStoreDir(dir)
	cfg, err := Load(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	return cfg
}

// TestSecretEncryptedAtRest 敏感键落盘即密文，文件里搜不到明文。
func TestSecretEncryptedAtRest(t *testing.T) {
	cfg := newTestConfig(t)
	const plainSecret = "SUPER-SECRET-VALUE-12345"
	if err := cfg.SetSetting("dandanplayAppSecret", plainSecret); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(cfg.path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), plainSecret) {
		t.Fatal("config.json 里出现了 Secret 明文")
	}
	if !strings.Contains(string(data), secret.EncPrefix) {
		t.Fatal("config.json 里应有密文标记")
	}

	// 业务侧读回明文（透明解密）
	got, ok := cfg.GetSetting("dandanplayAppSecret")
	if !ok || got != plainSecret {
		t.Fatalf("GetSetting 应返回明文: ok=%v got=%q", ok, got)
	}
}

// TestSecretRedactedInGetMap settings API 下发的 map 里不含 Secret 明文。
func TestSecretRedactedInGetMap(t *testing.T) {
	cfg := newTestConfig(t)
	const plainSecret = "SUPER-SECRET-VALUE-12345"
	_ = cfg.SetSetting("dandanplayAppId", "my-app-id")
	_ = cfg.SetSetting("dandanplayAppSecret", plainSecret)

	m := cfg.GetMap()
	if s, _ := m["dandanplayAppSecret"].(string); s != "" {
		t.Errorf("Secret 应脱敏为空串: %q", s)
	}
	if m["dandanplayAppSecretSet"] != true {
		t.Errorf("应下发 *Set 布尔标记: %v", m["dandanplayAppSecretSet"])
	}
	// AppId 非密钥材料：面板要按长度渲染掩码，保持下发
	if m["dandanplayAppId"] != "my-app-id" {
		t.Errorf("AppId 应下发: %v", m["dandanplayAppId"])
	}
	// 序列化后整体不含明文
	blob, _ := json.Marshal(m)
	if strings.Contains(string(blob), plainSecret) {
		t.Fatal("GetMap 序列化结果里出现了 Secret 明文")
	}
}

// TestSecretClearedByEmpty 传空串即清除（面板「清除凭证」路径）。
func TestSecretClearedByEmpty(t *testing.T) {
	cfg := newTestConfig(t)
	_ = cfg.SetSetting("dandanplayAppSecret", "something")
	if m := cfg.GetMap(); m["dandanplayAppSecretSet"] != true {
		t.Fatal("设置后应为已配置")
	}
	_ = cfg.SetSetting("dandanplayAppSecret", "")
	if m := cfg.GetMap(); m["dandanplayAppSecretSet"] == true {
		t.Error("清空后不应仍标记为已配置")
	}
	if _, ok := cfg.GetSetting("dandanplayAppSecret"); ok {
		t.Error("清空后键应不存在")
	}
}

// TestNonSecretRoundTrip 普通键不受加密影响（回归保护）。
func TestNonSecretRoundTrip(t *testing.T) {
	cfg := newTestConfig(t)
	_ = cfg.SetSetting("danmuApiBase", "http://192.168.1.10:9321")
	_ = cfg.SetSetting("danmuMinCount", float64(20))

	if m := cfg.GetMap(); m["danmuApiBase"] != "http://192.168.1.10:9321" {
		t.Errorf("普通键应明文下发: %v", m["danmuApiBase"])
	}
	data, _ := os.ReadFile(cfg.path)
	if !strings.Contains(string(data), "http://192.168.1.10:9321") {
		t.Error("普通键应明文落盘")
	}
}

// TestUpdateTwiceKeepsDecryptable 「读→写」往返不应把密文二次加密或弄坏。
func TestUpdateTwiceKeepsDecryptable(t *testing.T) {
	cfg := newTestConfig(t)
	const plain = "round-trip-secret"
	_ = cfg.SetSetting("dandanplayAppSecret", plain)
	// 再写一个无关键，触发整体落盘
	_ = cfg.SetSetting("otherKey", "x")
	// 模拟前端「原样回传」（settings GET 给空串，这里直接传当前密文形态）
	if raw, ok := cfg.Extra["dandanplayAppSecret"].(string); ok {
		_ = cfg.SetSetting("dandanplayAppSecret", raw)
	}
	got, _ := cfg.GetSetting("dandanplayAppSecret")
	if got != plain {
		t.Fatalf("往返后应仍解得明文: %q", got)
	}
}
