// Package stats —— 匿名使用统计（NAS 端心跳）。
//
// 目标：知道「有多少台 NAS 在用 Web 版」，同时尽可能少地知道「是谁」。
// 与桌面客户端（Fntv-Plus 的 usageStats.ts）同源的四条隐私硬约束：
//
//  1. [lc-1250] 匿名 ID 改为机器级固定唯一：取操作系统机器标识（fnOS 为
//     /etc/machine-id）做 SHA-256 哈希（不可逆，上报值不含明文硬件标识）——
//     重装应用/清空配置都不会变，「每台设备」的统计口径因此稳定。
//     （设计变更：初版用 crypto/rand 随机生成，重装即换号导致台数虚高；
//     面板的「重置匿名 ID」按钮已随之移除，/api/stats/reset 端点保留做兼容。）
//  2. 上报字段只有五个：匿名 ID、应用版本号、操作系统、CPU 架构、日期。
//     不含 IP（服务端代码里连对端地址都不读）、不含 NAS 账号、不含媒体库 /
//     文件路径 / 设备名 / 观看了什么等任何其它信息。
//  3. 每台 NAS 每天最多上报一次；服务端按 (匿名 ID, 日期) 主键去重 ——
//     只能聚合成「台数」，反推不出「某台 NAS 某天干了什么」。
//  4. 服务端地址未配置时不发任何请求；用户关闭开关后立即停止；开发版（版号为 dev）
//     默认不上报，避免作者自测把数据灌水。
//
// 与桌面版的**关键差异（有意为之）**：桌面版以「应用启动」为触发，NAS 端以
// 「今天确实有人打开了增强页面」（反代注入成功）为触发 —— 装了但没人用的 NAS
// 不会被算作活跃，数字更诚实。上报失败一律静默（只记日志），绝不影响观影。
package stats

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"fntvplus/internal/config"
)

// 统计服务端地址：与桌面版同一接收端（Fntv-Plus 仓库的 stats-server/），
// 走**同一个 /ping 路由**，靠 os 字段区分端 —— 桌面版发 Windows/macOS/Linux，
// 本端发 "fnOS"，作者在 /stats 的 systems 分布里就能单独读出 NAS 台数。
//
// 为什么复用 /ping 而不是新开一条路由：服务端（Cloudflare Worker）早已部署，
// 复用现成路由意味着**本次改造零服务端变更、零重新部署**，装上就能用；
// 新开路由则要先改 worker 再部署，否则客户端永远发不出去。
// 服务端按 (aid, day) 去重、接受 ±7 天补报、aid 形态校验，本端协议完全对齐。
//
// 多个地址用逗号分隔，**主地址不通时自动回退到下一个**（自有域名在国内通常比
// workers.dev 稳，后者留作兜底）。
const defaultEndpoint = "https://stats.690075.xyz,https://fntv-stats.122983191.workers.dev"

const (
	pingPath      = "/ping"
	timeout       = 8 * time.Second
	bootDelay     = 60 * time.Second // 启动后先等服务就绪，再补发欠报
	checkInterval = 6 * time.Hour    // 之后每 6 小时检查一次（成功一次即静默）
	maxPending    = 7                // 欠报最多留 7 天（服务端也只接受 ±7 天）
	maxSendDays   = 8                // 服务端单次最多接收 8 天（含今天）
)

// reDay 日期形态校验（YYYY-MM-DD），挡住配置文件里被手改脏的值。
var reDay = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// 配置键（落在 config.json 顶层，与桌面版 config.json 字段名一致）。
const (
	keyEnabled     = "statsEnabled"
	keyAnonID      = "statsAnonId"
	keyLastPingDay = "statsLastPingDay"
	keyLastPingOK  = "statsLastPingOk"
	keyPendingDays = "statsPendingDays"
)

// Stats 持有配置句柄与当日使用标记。
type Stats struct {
	cfg     *config.Config
	version string

	// mu 保护以下全部可变状态。两条 goroutine 会碰它：反代注入成功时的 MarkUsed
	// （每天第一次，来自任意 HTTP 请求协程）与后台心跳 tick（可能同时清算欠报）。
	// 欠报队列是「读-改-写」，不加锁会互相覆盖、静默丢天。
	mu            sync.Mutex
	lastMarked    string   // 内存态：最后一次 MarkUsed 的日期（同日重复调用直接短路，不碰磁盘）
	pending       []string // 欠报日期的内存权威副本（首次访问时从配置载入一次）
	pendingLoaded bool
	anonIDCache   string // 匿名 ID 内存副本（懒生成 + 懒载入）
	anonIDLoaded  bool

	// client 每台 NAS 一个（复用连接无所谓：一天一个请求）；代理与超时在 Do 时决定。
	client *http.Client
}

// New 构造统计器。version 为当前应用版本（dev 视为开发模式）。
func New(cfg *config.Config, version string) *Stats {
	v := strings.TrimSpace(version)
	if v == "" {
		v = "dev"
	}
	return &Stats{cfg: cfg, version: v, client: &http.Client{Timeout: timeout}}
}

/* ========== 配置读写 ========== */

// Enabled 统计开关（缺省开启；只有显式关闭才算关）。
func (s *Stats) Enabled() bool {
	v, ok := s.cfg.GetSetting(keyEnabled)
	if !ok {
		return true
	}
	v = strings.TrimSpace(v)
	return v != "0" && !strings.EqualFold(v, "false")
}

// SetEnabled 写入开关。
func (s *Stats) SetEnabled(enabled bool) error {
	return s.cfg.SetSetting(keyEnabled, !!enabled)
}

// DevMode 版号解析不出（本地源码直跑）时视为开发模式，默认不自动上报。
func (s *Stats) DevMode() bool { return s.version == "dev" }

// anonID 取匿名 ID，没有则本地生成并落盘（懒生成：从未上报过的用户不写配置文件）。
func (s *Stats) anonID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.anonIDLocked()
}

// anonIDLocked 取/生成匿名 ID（调用者须已持有锁）。配置始终是权威来源，不做内存缓存。
func (s *Stats) anonIDLocked() string {
	if v, ok := s.cfg.GetSetting(keyAnonID); ok {
		if id := strings.TrimSpace(v); machineAnonIDRe.MatchString(id) {
			return id // [lc-1250] 已是机器派生 ID → 直接用
		}
	}
	// [lc-1250] 尝试机器派生（旧随机 ID 自动迁移覆盖，保证每台机固定唯一不变）
	if mid := machineAnonID(); mid != "" {
		_ = s.cfg.SetSetting(keyAnonID, mid)
		return mid
	}
	// 回退：拿不到机器标识的异常环境 → 沿用已存的随机 ID；没有才生成
	if v, ok := s.cfg.GetSetting(keyAnonID); ok {
		if id := strings.TrimSpace(v); id != "" {
			return id
		}
	}
	id := newAnonID()
	_ = s.cfg.SetSetting(keyAnonID, id)
	return id
}

// machineAnonIDRe 机器派生 ID 形态：M + 31 位小写 hex（sha256 截取）。
var machineAnonIDRe = regexp.MustCompile(`^M[0-9a-f]{31}$`)

// machineIDRaw 取操作系统机器标识原文（可被测试替换以获得确定性）。
var machineIDRaw = func() string {
	if b, err := os.ReadFile("/etc/machine-id"); err == nil {
		if v := strings.TrimSpace(string(b)); v != "" {
			return v
		}
	}
	if b, err := os.ReadFile("/var/lib/dbus/machine-id"); err == nil {
		if v := strings.TrimSpace(string(b)); v != "" {
			return v
		}
	}
	if runtime.GOOS == "windows" {
		if out, err := exec.Command("reg", "query", `HKLM\SOFTWARE\Microsoft\Cryptography`, "/v", "MachineGuid").Output(); err == nil {
			if m := regexp.MustCompile(`MachineGuid\s+REG_SZ\s+(\S+)`).FindSubmatch(out); m != nil {
				return string(m[1])
			}
		}
	}
	if runtime.GOOS == "darwin" {
		if out, err := exec.Command("ioreg", "-rd1", "-c", "IOPlatformExpertDevice").Output(); err == nil {
			if m := regexp.MustCompile(`"IOPlatformUUID"\s*=\s*"([^"]+)"`).FindSubmatch(out); m != nil {
				return string(m[1])
			}
		}
	}
	return ""
}

// machineAnonID 机器标识原文 → SHA-256 → "M"+31 位 hex（不可逆）。
// 原文拿不到（异常环境）返回空串，由调用方回退 crypto/rand 随机 ID。
func machineAnonID() string {
	raw := strings.TrimSpace(machineIDRaw())
	if raw == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(raw))
	return "M" + hex.EncodeToString(sum[:])[:31]
}

// ResetID 换一个新匿名 ID（面板「重置匿名 ID」），与历史数据彻底断开：
// 连同上次上报状态与欠报日期一起清空，新身份从零开始。
func (s *Stats) ResetID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := newAnonID()
	s.lastMarked = ""
	_ = s.cfg.Update(map[string]any{
		keyAnonID:      id,
		keyLastPingDay: "",
		keyLastPingOK:  false,
		keyPendingDays: []string{},
	})
	return id
}

// Endpoints 取服务端根地址列表（已去掉结尾斜杠）；空数组表示未部署。
// 优先级：环境变量 FNTV_STATS_ENDPOINT > 配置 statsEndpoint > 内置默认。
func (s *Stats) Endpoints() []string {
	raw := strings.TrimSpace(os.Getenv("FNTV_STATS_ENDPOINT"))
	if raw == "" {
		if v, ok := s.cfg.GetSetting("statsEndpoint"); ok {
			raw = strings.TrimSpace(v)
		}
	}
	if raw == "" {
		raw = defaultEndpoint
	}
	out := []string{}
	for _, part := range strings.Split(raw, ",") {
		if p := strings.TrimRight(strings.TrimSpace(part), "/"); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// Configured 是否配置了可用的服务端地址。
func (s *Stats) Configured() bool { return len(s.Endpoints()) > 0 }

/* ========== 使用标记与上报 ========== */

// MarkUsed 记一次「今天真的被用过」（由反代注入成功后调用）。
// 同日重复调用在内存里短路，页面反复刷新不会反复写配置文件。
func (s *Stats) MarkUsed() {
	if !s.Enabled() {
		return
	}
	today := todayStr()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.lastMarked == today {
		return
	}
	days := s.loadPendingLocked()
	if !contains(days, today) {
		days = append(days, today)
		if len(days) > maxPending {
			days = days[len(days)-maxPending:]
		}
		s.savePendingLocked(days)
	}
	// 只有确实落盘（或已在队列里）后才置位，避免写失败被"记住已上报"而永久丢天。
	s.lastMarked = today
}

// UsedToday 今天是否已记过使用（供诊断/测试断言）。
func (s *Stats) UsedToday() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return contains(s.loadPendingLocked(), todayStr())
}

// Result 是一次上报的结果（skipped 与 error 互斥，供面板显示）。
type Result struct {
	OK      bool   `json:"ok"`
	Days    int    `json:"days,omitempty"`
	Skipped string `json:"skipped,omitempty"`
	Error   string `json:"error,omitempty"`
}

// Send 发一次心跳。force=true（面板「立即上报一次」）忽略开发模式限制，
// 并把「今天」一并计入 payload —— 用于验证链路，不写入本地使用记录。
//
// 网络调用在锁外进行：快照待报日期 → 发请求 → 回到锁内清算。
func (s *Stats) Send(force bool) Result {
	if !s.Enabled() {
		return Result{Skipped: "匿名统计已关闭"}
	}
	endpoints := s.Endpoints()
	if len(endpoints) == 0 {
		return Result{Skipped: "未配置统计服务端地址"}
	}
	if !force && s.DevMode() && os.Getenv("FNTV_STATS_FORCE") != "1" {
		return Result{Skipped: "开发模式默认不上报（设 FNTV_STATS_FORCE=1 可强制）"}
	}

	today := todayStr()

	// 快照：待报日期 + 匿名 ID（都在锁内取，取完就放锁）。
	s.mu.Lock()
	days := append([]string(nil), s.loadPendingLocked()...)
	if force && !contains(days, today) {
		days = append([]string{today}, days...)
	}
	anon := s.anonIDLocked()
	s.mu.Unlock()

	if len(days) == 0 {
		return Result{Skipped: "今天还没有使用记录"}
	}
	if len(days) > maxSendDays {
		days = days[:maxSendDays]
	}

	// ⚠ 这里是全部会被送出本机的内容，新增字段前请先想清楚是否必要。
	payload := map[string]any{
		"aid":  anon,
		"v":    s.version,
		"os":   "fnOS",
		"arch": runtime.GOARCH,
		"d":    today, // 兼容只认单日字段的老服务端
		"days": days,  // 新服务端按数组逐条去重入库
	}

	lastErr := ""
	for _, base := range endpoints {
		if err := s.post(base+pingPath, payload); err == nil {
			s.mu.Lock()
			// 只清算本次确已送达的日期（期间新记下的日期留着下次发）
			s.clearPendingLocked(days)
			// 今天若已送达，就不再重复记 —— 免得当天后续的页面打开又把它排进队列
			if contains(days, today) {
				s.lastMarked = today
			}
			s.mu.Unlock()
			_ = s.cfg.Update(map[string]any{keyLastPingDay: today, keyLastPingOK: true})
			log.Printf("[stats] 匿名心跳上报成功（%s，%d 天）", base, len(days))
			return Result{OK: true, Days: len(days)}
		} else {
			lastErr = err.Error()
			log.Printf("[stats] 端点 %s 上报失败，尝试下一个: %v", base, err)
		}
	}

	// 所有端点都不通：欠报日期留在本地，等网络恢复后由下一次 tick 补发。
	// 不弹窗、不重试风暴（最快也要 6 小时后才再试一次）。
	_ = s.cfg.Update(map[string]any{keyLastPingDay: today, keyLastPingOK: false})
	log.Printf("[stats] 匿名心跳上报失败（静默忽略，%d 天待补报）: %s", len(days), lastErr)
	return Result{Error: lastErr}
}

// Start 启动后台心跳循环：启动 60s 后先补一次欠报，之后每 6 小时检查。
// 未配置服务端地址时不启动（一个字节都不会往外发）。
func (s *Stats) Start() {
	if !s.Configured() {
		log.Printf("[stats] 未配置统计服务端地址（FNTV_STATS_ENDPOINT / statsEndpoint），匿名统计处于关闭状态")
		return
	}
	go func() {
		time.Sleep(bootDelay)
		s.tick()
		t := time.NewTicker(checkInterval)
		defer t.Stop()
		for range t.C {
			s.tick()
		}
	}()
}

// tick 一次后台检查：有待报日期就发，没有就什么都不做（不走网络）。
func (s *Stats) tick() {
	if !s.Enabled() || !s.hasPending() {
		return
	}
	s.Send(false)
}

// Info 面板读取的当前状态（匿名 ID 只回前 8 位：够用户核对，又不至于被复制滥用）。
func (s *Stats) Info() map[string]any {
	id := s.anonID()
	short := id
	if len(id) >= 8 {
		short = id[:8]
	}
	endpoint := ""
	if eps := s.Endpoints(); len(eps) > 0 {
		endpoint = eps[0]
	}
	lastDay, _ := s.cfg.GetSetting(keyLastPingDay)
	lastOK, _ := s.cfg.GetSetting(keyLastPingOK)
	s.mu.Lock()
	pending := len(s.loadPendingLocked())
	usedToday := contains(s.loadPendingLocked(), todayStr())
	s.mu.Unlock()
	return map[string]any{
		"enabled":     s.Enabled(),
		"configured":  s.Configured(),
		"endpoint":    endpoint,
		"lastDay":     lastDay,
		"lastOk":      lastOK == "1",
		"pendingDays": pending,
		"usedToday":   usedToday,
		"anonIdShort": short,
		"version":     s.version,
		"devMode":     s.DevMode(),
	}
}

/* ========== 面板接口（由 proxy 挂到 /app/fntvplus/api/stats*，统一过网关鉴权） ========== */

// InfoHandler GET → 当前统计状态（面板「关于」页读取）。
func (s *Stats) InfoHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		writeJSON(w, http.StatusOK, s.Info())
	}
}

// EnabledHandler POST {"enabled":bool} → 开关匿名统计。
func (s *Stats) EnabledHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			Enabled *bool `json:"enabled"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&body); err != nil || body.Enabled == nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "bad json"})
			return
		}
		if err := s.SetEnabled(*body.Enabled); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		log.Printf("[stats] 匿名使用统计开关: %v", *body.Enabled)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "enabled": *body.Enabled})
	}
}

// PingHandler POST → 立即上报一次（面板手动验证链路；忽略开发模式限制）。
func (s *Stats) PingHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		writeJSON(w, http.StatusOK, s.Send(true))
	}
}

// ResetHandler POST → 重置匿名 ID（与历史数据断开）。
func (s *Stats) ResetHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		id := s.ResetID()
		log.Printf("[stats] 匿名 ID 已重置")
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "anonIdShort": id[:8]})
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

/* ========== 内部工具 ========== */

// pendingDays 读欠报日期快照（线程安全；供测试与诊断）。
func (s *Stats) pendingDays() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.loadPendingLocked()...)
}

// hasPending 是否还有待报日期。
func (s *Stats) hasPending() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.loadPendingLocked()) > 0
}

// loadPendingLocked 从配置读欠报日期（调用者须已持有锁）。
// 配置始终是权威来源（不另做内存缓存）：重启后欠报不丢，面板手改也即刻生效。
// 非法条目（手改脏数据 / 非数组类型）一律丢弃，不让坏值进到 payload。
func (s *Stats) loadPendingLocked() []string {
	v, ok := s.cfg.GetSetting(keyPendingDays)
	if !ok || strings.TrimSpace(v) == "" {
		return nil
	}
	var days []string
	if err := json.Unmarshal([]byte(v), &days); err != nil {
		return nil
	}
	out := make([]string, 0, len(days))
	for _, d := range days {
		if d = strings.TrimSpace(d); reDay.MatchString(d) {
			out = append(out, d)
		}
	}
	return out
}

// savePendingLocked 落盘欠报日期（调用者须已持有锁）。
func (s *Stats) savePendingLocked(days []string) {
	_ = s.cfg.SetSetting(keyPendingDays, days)
}

// clearPendingLocked 只清算本次成功送达的日期（期间新记下的日期留给下一次发送）。
func (s *Stats) clearPendingLocked(sent []string) {
	rest := []string{}
	for _, d := range s.loadPendingLocked() {
		if !contains(sent, d) {
			rest = append(rest, d)
		}
	}
	s.savePendingLocked(rest)
}

// post 发一个 JSON POST（带可选自定义代理）。
func (s *Stats) post(rawURL string, payload map[string]any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, rawURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	client := s.client
	if proxy := s.proxyURL(); proxy != "" {
		pu, err := url.Parse(proxy)
		if err == nil {
			client = &http.Client{
				Timeout:   timeout,
				Transport: &http.Transport{Proxy: http.ProxyURL(pu)},
			}
		}
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64*1024))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}

// proxyURL 生效中的自定义代理（与 bridge.customProxyURL 同语义）：
// 环境变量优先；否则须 customProxyEnabled=true 且 customProxy 为合法 http(s):// 地址。
// NAS 在国内直连统计域名可能不稳，用户配了代理就跟着走。
func (s *Stats) proxyURL() string {
	for _, k := range []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"} {
		if v := strings.TrimSpace(os.Getenv(k)); v != "" {
			return v
		}
	}
	if v, _ := s.cfg.GetSetting("customProxyEnabled"); v != "1" {
		return ""
	}
	raw, _ := s.cfg.GetSetting("customProxy")
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return ""
	}
	return raw
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// newAnonID 生成随机匿名 ID（UUID v4 形态，纯 16 进制 + 连字符）。
// crypto/rand 不可用时退化为「时间戳 + 进程号」的十六进制（仍与用户身份无关）。
func newAnonID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%x-%x", time.Now().UnixNano(), os.Getpid())
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// todayStr 本地日期 YYYY-MM-DD（按 NAS 所在时区算「一天」，比 UTC 更贴近真实活跃）。
func todayStr() string {
	d := time.Now()
	return fmt.Sprintf("%04d-%02d-%02d", d.Year(), int(d.Month()), d.Day())
}
