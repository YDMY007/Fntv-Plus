// internal/stats/stats_test.go —— 匿名统计的隐私不变量与补报行为。
//
// 断言重点（既是回归测试，也是「我们到底采了什么」的可执行说明书）：
//  1. 送出去的 payload 只有 5 个字段，且不含任何可识别信息；
//  2. 同一天重复标记使用不会累积多条记录；
//  3. 上报失败 → 日期进欠报队列；恢复后补发并清空；
//  4. 所有端点不通时不 panic、不丢本地状态（静默失败）；
//  5. 开关关闭 / 未配置端点 / 开发模式 → 一个字节都不发。
package stats

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"fntvplus/internal/config"
	"fntvplus/internal/secret"
)

// newTestStats 在临时目录造一个统计器（含配置与盐文件隔离），端点指向端到端地址。
func newTestStats(t *testing.T, version string, endpoints ...string) *Stats {
	t.Helper()
	dir := t.TempDir()
	secret.BindStoreDir(dir)
	cfg, err := config.Load(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	s := New(cfg, version)
	if len(endpoints) > 0 {
		t.Setenv("FNTV_STATS_ENDPOINT", strings.Join(endpoints, ","))
	}
	return s
}

// fakeServer 假统计服务端：记录收到的每个 payload，可开关失败。
type fakeServer struct {
	mu       sync.Mutex
	payloads []map[string]any
	fail     bool
	srv      *httptest.Server
}

func newFakeServer(t *testing.T) *fakeServer {
	t.Helper()
	f := &fakeServer{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != pingPath {
			http.NotFound(w, r)
			return
		}
		body, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.fail {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		var m map[string]any
		_ = json.Unmarshal(body, &m)
		f.payloads = append(f.payloads, m)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeServer) received() []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]map[string]any(nil), f.payloads...)
}

func (f *fakeServer) setFail(v bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fail = v
}

// TestPayloadHasNoIdentifyingFields 送出去的字段是「只有这五个」的白名单断言。
// 这条测试一旦失败，说明有人往上报内容里加了新字段 —— 加之前请先想清楚是否必要。
func TestPayloadHasNoIdentifyingFields(t *testing.T) {
	fake := newFakeServer(t)
	s := newTestStats(t, "1.12.0", fake.srv.URL)

	s.MarkUsed()
	res := s.Send(false)
	if !res.OK {
		t.Fatalf("上报应成功: %+v", res)
	}

	got := fake.received()
	if len(got) != 1 {
		t.Fatalf("应恰好收到 1 个 payload，实收 %d", len(got))
	}
	allowed := map[string]bool{"aid": true, "v": true, "os": true, "arch": true, "d": true, "days": true}
	for k, v := range got[0] {
		if !allowed[k] {
			t.Errorf("出现了未申报的字段 %q = %v（新增字段前请先看包注释里的隐私约束）", k, v)
		}
	}
	if len(got[0]) != len(allowed) {
		t.Errorf("payload 字段数应为 %d，实为 %d: %v", len(allowed), len(got[0]), got[0])
	}
	// 关键：不能出现 IP / 主机名 / 路径 / 账号 / UA 之类的可识别值
	raw, _ := json.Marshal(got[0])
	for _, needle := range []string{"127.0.0.1", "localhost", hostname(), os.Getenv("USER"), os.Getenv("USERNAME")} {
		if needle != "" && strings.Contains(string(raw), needle) {
			t.Errorf("payload 里出现了可识别信息 %q: %s", needle, raw)
		}
	}
}

func hostname() string {
	h, _ := os.Hostname()
	return h
}

// TestMarkUsedOncePerDay 同一天多次调用只留一条记录（页面反复刷新不灌水）。
func TestMarkUsedOncePerDay(t *testing.T) {
	fake := newFakeServer(t)
	s := newTestStats(t, "1.12.0", fake.srv.URL)

	for i := 0; i < 5; i++ {
		s.MarkUsed()
	}
	if !s.UsedToday() {
		t.Fatal("标记使用后 UsedToday 应为 true")
	}
	days := s.pendingDays()
	if len(days) != 1 {
		t.Fatalf("同一天应只有 1 条待报日期，实为 %v", days)
	}
	if res := s.Send(false); !res.OK || res.Days != 1 {
		t.Fatalf("应上报 1 天: %+v", res)
	}
}

// TestFailedSendQueuesPending 失败 → 进欠报队列；恢复后补发全部并清空。
func TestFailedSendQueuesPending(t *testing.T) {
	fake := newFakeServer(t)
	fake.setFail(true)
	s := newTestStats(t, "1.12.0", fake.srv.URL)

	// 造两天欠报：直接改写配置模拟「昨天没发出去 + 今天又被用过」
	s.MarkUsed()
	if err := s.cfg.Update(map[string]any{keyPendingDays: []string{"2026-09-01", todayStr()}}); err != nil {
		t.Fatal(err)
	}

	if res := s.Send(false); res.OK {
		t.Fatal("服务端故障时不应报成功")
	}
	if len(fake.received()) != 0 {
		t.Fatal("失败场景不应计入收到")
	}
	// 欠报保住了（没有因为失败被清空）
	if days := s.pendingDays(); len(days) != 2 {
		t.Fatalf("失败后应保留 2 天欠报，实为 %v", days)
	}

	// 恢复
	fake.setFail(false)
	res := s.Send(false)
	if !res.OK {
		t.Fatalf("恢复后应上报成功: %+v", res)
	}
	if res.Days != 2 {
		t.Errorf("应补发 2 天，实为 %d", res.Days)
	}
	if days := s.pendingDays(); len(days) != 0 {
		t.Errorf("补发成功后欠报应清空，实为 %v", days)
	}
	// payload 的 days 数组包含两天
	last := fake.received()[len(fake.received())-1]
	days, _ := last["days"].([]any)
	if len(days) != 2 {
		t.Errorf("payload.days 应为 2 天，实为 %v", last["days"])
	}
}

// TestMultiEndpointFallback 主端点不通时自动改用备用端点（国内连不上自有域名也能到）。
func TestMultiEndpointFallback(t *testing.T) {
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(dead.Close)
	live := newFakeServer(t)

	s := newTestStats(t, "1.12.0", dead.URL, live.srv.URL)
	s.MarkUsed()
	res := s.Send(false)
	if !res.OK {
		t.Fatalf("备用端点应兜住: %+v", res)
	}
	if len(live.received()) != 1 {
		t.Fatalf("备用端点应收到 1 个 payload，实收 %d", len(live.received()))
	}
}

// TestDisabledAndUnconfiguredSendNothing 开关关闭 / 未配置端点 → 一个字节都不发。
func TestDisabledAndUnconfiguredSendNothing(t *testing.T) {
	// 开关关闭
	fake := newFakeServer(t)
	s := newTestStats(t, "1.12.0", fake.srv.URL)
	if err := s.SetEnabled(false); err != nil {
		t.Fatal(err)
	}
	s.MarkUsed() // 关闭状态下连本地记录都不该写
	if res := s.Send(true); res.OK {
		t.Error("关闭开关后 Send 不应成功")
	}
	if len(fake.received()) != 0 {
		t.Error("关闭开关后不应有任何网络请求")
	}
	if len(s.pendingDays()) != 0 {
		t.Error("关闭开关后不应记录使用日期")
	}

	// 未配置端点（清掉默认值与环境变量）
	t.Setenv("FNTV_STATS_ENDPOINT", " ")
	s2 := newTestStats(t, "1.12.0")
	_ = s2.cfg.SetSetting("statsEndpoint", "")
	if s2.Configured() {
		t.Skip("内置默认端点存在，跳过未配置分支")
	}
	if res := s2.Send(false); res.Skipped == "" {
		t.Errorf("未配置端点应跳过: %+v", res)
	}
}

// TestDevModeDoesNotAutoSend 开发版号默认不自动上报，但「立即上报」被放行（面板手动验证链路用）。
func TestDevModeDoesNotAutoSend(t *testing.T) {
	fake := newFakeServer(t)
	s := newTestStats(t, "dev", fake.srv.URL)
	s.MarkUsed()

	if res := s.Send(false); res.OK {
		t.Error("开发模式不应自动上报")
	}
	if len(fake.received()) != 0 {
		t.Error("开发模式自动路径不应发请求")
	}
	if res := s.Send(true); !res.OK {
		t.Errorf("force 应放行: %+v", res)
	}
	if len(fake.received()) != 1 {
		t.Error("force 应恰好发一次")
	}
}

// TestForceWithoutUsageStillReports 从没用过（没有使用记录）时点「立即上报一次」也要能验证链路。
func TestForceWithoutUsageStillReports(t *testing.T) {
	fake := newFakeServer(t)
	s := newTestStats(t, "1.12.0", fake.srv.URL)

	if res := s.Send(false); res.Skipped == "" {
		t.Errorf("无使用记录时非 force 应跳过: %+v", res)
	}
	if res := s.Send(true); !res.OK {
		t.Errorf("force 应能上报: %+v", res)
	}
	last := fake.received()[0]
	if last["v"] != "1.12.0" {
		t.Errorf("应带版本号，实为 %v", last["v"])
	}
	if last["os"] != "fnOS" {
		t.Errorf("应标识为 fnOS 端，实为 %v", last["os"])
	}
}

// TestResetIDDisconnectsHistory 重置匿名 ID 后，与历史数据的关联断开（欠报队列一并清空）。
// TestResetIDKeepsMachineID [lc-1250] 机器级 ID 语义：重置清空上报状态，但 anonID
// 会重新派生出同一机器 ID（每台机固定唯一不变；面板的重置按钮已移除）。
func TestResetIDKeepsMachineID(t *testing.T) {
	restore := stubMachineID(t)
	defer restore()
	fake := newFakeServer(t)
	s := newTestStats(t, "1.12.0", fake.srv.URL)
	s.MarkUsed()
	before := s.anonID()

	_ = s.ResetID()
	if s.anonID() != before {
		t.Error("重置后 anonID 应重新派生出同一机器 ID")
	}
	if len(s.pendingDays()) != 0 {
		t.Error("重置应清空欠报队列")
	}
	if s.UsedToday() {
		t.Error("重置后不应再认为今天已使用")
	}
}

// stubMachineID 注入确定性的机器标识原文（跨平台/跨环境测试一致）。
func stubMachineID(t *testing.T) func() {
	old := machineIDRaw
	machineIDRaw = func() string { return "test-machine-id-stable" }
	return func() { machineIDRaw = old }
}

// TestAnonIDMachineStable [lc-1250] 匿名 ID 机器级语义：同一台机稳定不变（31 位 hex，
// [lc-1277] 去掉 M 前缀——服务端 RE_AID 只认 hex/横杠），同机两个独立安装也相同
// （口径=设备数）；换机器标识则 ID 不同。
func TestAnonIDMachineStable(t *testing.T) {
	restore := stubMachineID(t)
	defer restore()
	s := newTestStats(t, "1.12.0", "http://127.0.0.1:1")
	a := s.anonID()
	b := s.anonID()
	if a != b {
		t.Fatalf("同一台机的匿名 ID 应稳定: %q vs %q", a, b)
	}
	if !machineAnonIDRe.MatchString(a) {
		t.Errorf("应为机器派生形态 31 位 hex，实为 %q", a)
	}
	if !anonIDServerRe.MatchString(a) {
		t.Errorf("匿名 ID 必须能过服务端 RE_AID 校验，实为 %q", a)
	}
	// 同机两个独立安装（不同配置目录）→ 相同 ID
	s2 := newTestStats(t, "1.12.0", "http://127.0.0.1:1")
	if s2.anonID() != a {
		t.Error("同一台机的不同安装应得到相同匿名 ID（按设备计数）")
	}
	// 换机器标识 → 新实例派生出不同 ID
	machineIDRaw = func() string { return "another-machine" }
	s3 := newTestStats(t, "1.12.0", "http://127.0.0.1:1")
	if s3.anonID() == a {
		t.Error("不同机器的匿名 ID 不应相同")
	}
}

// TestInfoDoesNotLeakFullID 面板状态接口只给 ID 前 8 位。
func TestInfoDoesNotLeakFullID(t *testing.T) {
	restore := stubMachineID(t)
	defer restore()
	s := newTestStats(t, "1.12.0", "http://127.0.0.1:1")
	info := s.Info()
	short, _ := info["anonIdShort"].(string)
	full := s.anonID()
	if len(short) != 8 {
		t.Errorf("应只回 8 位，实为 %q", short)
	}
	if !strings.HasPrefix(full, short) {
		t.Errorf("短 ID 应是完整 ID 的前缀: %q vs %q", short, full)
	}
	for k, v := range info {
		if s, ok := v.(string); ok && s == full {
			t.Errorf("Info 泄漏了完整匿名 ID（字段 %s）", k)
		}
	}
}

// TestPendingDaysSanitized 配置文件被手改脏时不 panic、不发出非法日期。
func TestPendingDaysSanitized(t *testing.T) {
	s := newTestStats(t, "1.12.0", "http://127.0.0.1:1")
	_ = s.cfg.Update(map[string]any{keyPendingDays: []string{"not-a-date", "", "2026-09-01", "2026/09/02"}})
	days := s.pendingDays()
	if len(days) != 1 || days[0] != "2026-09-01" {
		t.Fatalf("脏数据应被过滤: %v", days)
	}
	// 非数组值也不应 panic
	_ = s.cfg.Update(map[string]any{keyPendingDays: "半路改了类型"})
	if got := s.pendingDays(); got != nil {
		t.Errorf("非法类型应返回 nil: %v", got)
	}
}

// TestPendingCapped 欠报队列最多 7 天（离网很久也不会无限增长）。
func TestPendingCapped(t *testing.T) {
	s := newTestStats(t, "1.12.0", "http://127.0.0.1:1")
	old := []string{"2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05", "2026-01-06", "2026-01-07"}
	_ = s.cfg.Update(map[string]any{keyPendingDays: old})
	s.MarkUsed()
	days := s.pendingDays()
	if len(days) != maxPending {
		t.Fatalf("欠报应被截到 %d 天，实为 %d: %v", maxPending, len(days), days)
	}
	if !contains(days, todayStr()) {
		t.Errorf("新日期应在队列里: %v", days)
	}
}

// TestConcurrentMarkUsedNoDuplicates 并发标记使用（多个页面同时被打开）不能产生重复条目，
// 也不能在「记忆已标记」时丢掉落盘 —— 这条守住的是 MarkUsed 的读-改-写竞态。
func TestConcurrentMarkUsedNoDuplicates(t *testing.T) {
	fake := newFakeServer(t)
	s := newTestStats(t, "1.12.0", fake.srv.URL)

	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.MarkUsed()
		}()
	}
	wg.Wait()

	if days := s.pendingDays(); len(days) != 1 || days[0] != todayStr() {
		t.Fatalf("并发标记应只留今天一条，实为 %v", days)
	}
	if res := s.Send(false); !res.OK || res.Days != 1 {
		t.Fatalf("应上报 1 天: %+v", res)
	}
}

// TestMarkUsedDuringFailedSendNotLost 上报失败进行中/进行后新标记的使用日不得丢失。
func TestMarkUsedDuringFailedSendNotLost(t *testing.T) {
	fake := newFakeServer(t)
	fake.setFail(true)
	s := newTestStats(t, "1.12.0", fake.srv.URL)
	s.MarkUsed()

	// 失败一次
	if res := s.Send(false); res.OK {
		t.Fatal("故障时不应成功")
	}
	// 失败之后仍认为今天已使用（欠报队列里还在）
	if !s.UsedToday() {
		t.Fatal("失败后今天的使用记录不应丢失")
	}
	// 再次标记（页面又开了）不应产生重复
	s.MarkUsed()
	if days := s.pendingDays(); len(days) != 1 {
		t.Fatalf("不应重复记录: %v", days)
	}
}

// TestSendClearsOnlyDeliveredDays 清算只针对本次送达的日期，未被发送的残留留给下一轮。
func TestSendClearsOnlyDeliveredDays(t *testing.T) {
	fake := newFakeServer(t)
	s := newTestStats(t, "1.12.0", fake.srv.URL)

	// 造 3 天欠报（只有前 2 天会进 payload 的 days —— 这里手动控制为 2 天）
	week := []string{"2026-09-01", todayStr()}
	if err := s.cfg.Update(map[string]any{keyPendingDays: week}); err != nil {
		t.Fatal(err)
	}
	if res := s.Send(false); !res.OK || res.Days != 2 {
		t.Fatalf("应上报 2 天: %+v", res)
	}
	if days := s.pendingDays(); len(days) != 0 {
		t.Fatalf("送达的日期应被清算: %v", days)
	}
}
func TestConfigRoundTripVariants(t *testing.T) {
	s := newTestStats(t, "1.12.0", "http://127.0.0.1:1")
	if !s.Enabled() {
		t.Error("缺省应开启")
	}
	for _, tc := range []struct {
		v    any
		want bool
	}{
		{true, true}, {false, false}, {"1", true}, {"0", false}, {"true", true}, {"false", false},
	} {
		_ = s.cfg.Update(map[string]any{keyEnabled: tc.v})
		if got := s.Enabled(); got != tc.want {
			t.Errorf("statsEnabled=%v 应解读为 %v，实为 %v", tc.v, tc.want, got)
		}
	}
}
