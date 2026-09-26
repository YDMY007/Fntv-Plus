package bridge

import (
	"strings"
	"testing"

	"fntvplus/internal/config"
)

// TestEffectiveUpstreamFollowsConfig [lc-080 回归]：管理页热改上游后，bridge 的 fnOS
// 调用必须跟随（effectiveUpstream 实时读取 config 覆盖值）；未配置时回退启动推导值。
// 背景：bridge 此前固定用启动推导值（5666），用户配置的上游覆盖（18888）只作用于反代
// 主链路 → 演员 TMDB 作品/跳过片头/同步等 fnOS 桥连错端口被拒（connection refused）。
func TestEffectiveUpstreamFollowsConfig(t *testing.T) {
	cfg := config.Default()
	b := New(cfg, "http://127.0.0.1:5666")

	// 未配置覆盖 → 回退启动推导值
	if got := b.effectiveUpstream(); got != "http://127.0.0.1:5666" {
		t.Fatalf("未配置时应回退推导值: got %q want %q", got, "http://127.0.0.1:5666")
	}

	// 管理页热改上游 → 立即生效
	if err := cfg.Update(map[string]any{"upstream": "http://127.0.0.1:18888"}); err != nil {
		t.Fatalf("Update: %v", err)
	}
	if got := b.effectiveUpstream(); got != "http://127.0.0.1:18888" {
		t.Fatalf("热改后应跟随 config 覆盖值: got %q want %q", got, "http://127.0.0.1:18888")
	}

	// 尾斜杠归一（防双斜杠拼路径）
	if err := cfg.Update(map[string]any{"upstream": "http://127.0.0.1:18888/"}); err != nil {
		t.Fatalf("Update: %v", err)
	}
	if got := b.effectiveUpstream(); strings.HasSuffix(got, "/") {
		t.Fatalf("尾斜杠应被归一: got %q", got)
	}

	// 清空覆盖 → 回退推导值
	if err := cfg.Update(map[string]any{"upstream": ""}); err != nil {
		t.Fatalf("Update: %v", err)
	}
	if got := b.effectiveUpstream(); got != "http://127.0.0.1:5666" {
		t.Fatalf("清空覆盖后应回退推导值: got %q", got)
	}
}
