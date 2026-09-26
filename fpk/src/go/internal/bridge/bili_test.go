package bridge

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestProxyTestValidation 覆盖 proxyTest 的入参校验分支（不发真实请求，无网络依赖）：
// 空地址 / 非法格式 / 不支持的 socks5 协议 都应被拒（ok=false 且带 error），
// 用于回归「删 socks5 后前端下拉框只给 http/https，但后端仍要兜底拒绝非法协议」。
func TestProxyTestValidation(t *testing.T) {
	b := &Bridge{}
	cases := []struct {
		name    string
		body    string
		wantOK  bool
		wantErr bool
	}{
		{"空地址", `{"proxyUrl":""}`, false, true},
		{"非法格式", `{"proxyUrl":"not-a-url"}`, false, true},
		{"不支持的 socks5", `{"proxyUrl":"socks5://127.0.0.1:1080"}`, false, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/app/fntvplus/api/bridge/proxy/test", bytes.NewBufferString(c.body))
			rec := httptest.NewRecorder()
			b.proxyTest(rec, req)
			var out struct {
				OK    bool   `json:"ok"`
				Error string `json:"error"`
			}
			if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
				t.Fatalf("decode %q: %v", c.body, err)
			}
			if out.OK != c.wantOK {
				t.Errorf("proxyTest(%s) ok=%v want %v", c.name, out.OK, c.wantOK)
			}
			if (out.Error != "") != c.wantErr {
				t.Errorf("proxyTest(%s) error=%q wantErr=%v", c.name, out.Error, c.wantErr)
			}
		})
	}
}
