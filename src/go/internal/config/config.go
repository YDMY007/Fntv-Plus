// Package config —— Fntv-Plus 影视增强后端的运行时配置。
//
// 配置文件存于 TRIM_PKGETC（安装目录 etc），由后端读写；前端管理页通过
// /app/fntvplus/api/settings 读写同一份文件。所有配置均为「增强总开关」级别，
// 单用户 NAS 场景足够；多用户细粒度权限由 fnOS 桌面入口的 accessPerm 控制。
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"fntvplus/internal/secret"
)

// Config 是后端的全部可持久化配置。
// 已知字段显式声明；其余键（账号 token / 服务开关等由设置面板写入的任意项）
// 收进 Extra 平铺持久化（自定义 Marshal/Unmarshal 保持 JSON 顶层扁平，
// 与桌面版 config.json 字段名对齐，面板 settings:get 直接可用）。
type Config struct {
	mu sync.RWMutex

	// EnhancementEnabled 增强总开关。false 时反代完全透传、不注入 payload（等价于原版影视）。
	EnhancementEnabled bool `json:"enhancement_enabled"`

	// Upstream 回环上游地址（飞牛影视网页服务）。为空时由启动参数/环境变量推导。
	Upstream string `json:"upstream"`

	// InjectCSS 是否额外注入内联 CSS（预留，当前 payload 自带样式，默认 false）。
	InjectCSS bool `json:"inject_css"`

	// Extra 承载所有未显式声明的设置键（平铺进 JSON 顶层）。
	Extra map[string]any `json:"-"`

	path string
}

var knownKeys = map[string]bool{
	"enhancement_enabled": true,
	"upstream":            true,
	"inject_css":          true,
}

// secretAtRest 落盘前必须加密的配置键。
//
// 写入：Update 收到明文即加密，Extra 里始终只存密文（config.json 被拷走也读不出凭证）。
// 读取：GetSetting 透明解密（业务代码拿明文，无感知）；Get()/GetMap 见下面的脱敏规则。
var secretAtRest = map[string]bool{
	"dandanplayAppId":     true,
	"dandanplayAppSecret": true,
}

// redactedKeys 经设置 API 下发时必须遮蔽的键。
//
// 两类：
//  1. 纯密钥项——AppId 是标识符（每个请求头都带、面板要按长度渲染掩码），下发明文不增加
//     暴露面；Secret 一旦下发就等于把凭证明文放进浏览器内存。
//  2. 匿名统计 ID——面板只展示前 8 位供核对（经 /api/stats 的 anonIdShort），完整 ID 没有任何
//     下发理由：它是本机随机生成的假名，完整值被复制走就能对上服务端里的记录。
//
// 遮蔽后另发 <键名>Set 布尔标记，面板据此显示「已配置」而不需要拿到明文。
var redactedKeys = map[string]bool{
	"dandanplayAppSecret": true,
	"statsAnonId":         true,
}

// decryptSetting 密文则解密；明文（历史遗留值）原样返回。
func decryptSetting(v any) any {
	s, ok := v.(string)
	if !ok || !secret.IsEncrypted(s) {
		return v
	}
	plain, err := secret.DecryptStored(s)
	if err != nil {
		// 解密失败（换机拷贝 / 盐文件丢失）：记日志并按空值处理，不阻断启动。
		logSecretIssue(err)
		return ""
	}
	return plain
}

// MarshalJSON 平铺输出：已知字段 + Extra。（指针接收者：避免按值拷贝内嵌 sync.RWMutex，go vet 报锁拷贝）
func (c *Config) MarshalJSON() ([]byte, error) {
	type known struct {
		EnhancementEnabled bool   `json:"enhancement_enabled"`
		Upstream           string `json:"upstream"`
		InjectCSS          bool   `json:"inject_css"`
	}
	k := known{c.EnhancementEnabled, c.Upstream, c.InjectCSS}
	out, err := json.Marshal(k)
	if err != nil {
		return nil, err
	}
	if len(c.Extra) == 0 {
		return out, nil
	}
	m := map[string]any{}
	_ = json.Unmarshal(out, &m)
	for kk, vv := range c.Extra {
		if !knownKeys[kk] {
			m[kk] = vv
		}
	}
	return json.Marshal(m)
}

// UnmarshalJSON 平铺解析：已知键入字段，其余进 Extra。
func (c *Config) UnmarshalJSON(data []byte) error {
	type known struct {
		EnhancementEnabled bool   `json:"enhancement_enabled"`
		Upstream           string `json:"upstream"`
		InjectCSS          bool   `json:"inject_css"`
	}
	var k known
	if err := json.Unmarshal(data, &k); err != nil {
		return err
	}
	c.EnhancementEnabled = k.EnhancementEnabled
	c.Upstream = k.Upstream
	c.InjectCSS = k.InjectCSS
	c.Extra = map[string]any{}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		return err
	}
	for kk, vv := range m {
		if !knownKeys[kk] {
			c.Extra[kk] = vv
		}
	}
	return nil
}

// Default 返回出厂配置：增强默认开启。
func Default() *Config {
	return &Config{
		EnhancementEnabled: true,
		InjectCSS:          false,
		Extra:              map[string]any{},
	}
}

// Load 从 path 读取配置；文件不存在或解析失败时回退到 Default() 并写入默认文件。
func Load(path string) (*Config, error) {
	c := Default()
	c.path = path
	// 绑定每安装盐文件（同目录）：自定义凭证的落盘密钥由此派生。
	// 必须在任何 GetSetting/Update 之前完成，否则密文将按内置域密钥解不开。
	secret.BindStoreDir(filepath.Dir(path))
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			// 首次运行：把默认配置落盘，保证后续读取一致。
			_ = c.Save()
			return c, nil
		}
		return nil, err
	}
	if err := json.Unmarshal(data, c); err != nil {
		return nil, err
	}
	c.path = path
	return c, nil
}

// logSecretIssue 记录敏感值处理异常。不引 log 包也避免 import 环：直接写标准错误，
// 由上层（fntvplus 进程 log 重定向）统一收进 fntvplus.log。
func logSecretIssue(err error) {
	if err != nil {
		fmt.Fprintf(os.Stderr, "[fntvplus-config] 敏感配置解密/加密异常: %v\n", err)
	}
}

// Save 将当前配置写回磁盘（原子写：临时文件 + rename）。外部调用，内部加写锁。
func (c *Config) Save() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.save()
}

// save 实际落盘（调用者须已持有锁）。拆出来是为了让 Update 在持锁状态下调用而不重入死锁。
func (c *Config) save() error {
	if c.path == "" {
		return nil
	}
	if dir := filepath.Dir(c.path); dir != "" {
		_ = os.MkdirAll(dir, 0o755)
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := c.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, c.path)
}

// Dir 返回配置文件所在目录（即 TRIM_PKGETC），供派生持久化子目录（如 TMDB 详情缓存）；
// 配置路径未知时返回空串。
func (c *Config) Dir() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.path == "" {
		return ""
	}
	return filepath.Dir(c.path)
}

// Get 返回配置快照（线程安全）。敏感键同样按脱敏规则处理（见 redactedKeys）。
func (c *Config) Get() Config {
	c.mu.RLock()
	defer c.mu.RUnlock()
	extra := map[string]any{}
	for kk, vv := range c.Extra {
		extra[kk] = redactValue(kk, vv)
	}
	return Config{
		EnhancementEnabled: c.EnhancementEnabled,
		Upstream:           c.Upstream,
		InjectCSS:          c.InjectCSS,
		Extra:              extra,
	}
}

// GetMap 返回平铺配置快照（供 settings API / bridge 使用）。
// 敏感键在此脱敏：只回布尔标记，明文永不出后端。
func (c *Config) GetMap() map[string]any {
	c.mu.RLock()
	defer c.mu.RUnlock()
	m := map[string]any{
		"enhancement_enabled": c.EnhancementEnabled,
		"upstream":            c.Upstream,
		"inject_css":          c.InjectCSS,
	}
	for kk, vv := range c.Extra {
		if knownKeys[kk] {
			continue
		}
		if redactedKeys[kk] {
			m[kk] = ""
			m[kk+"Set"] = hasSecretValue(vv)
			continue
		}
		m[kk] = redactValue(kk, vv)
	}
	return m
}

// redactValue 单值脱敏（非敏感键解密后原样返回；敏感键→空）。
func redactValue(key string, v any) any {
	if redactedKeys[key] {
		return ""
	}
	return decryptSetting(v)
}

// hasSecretValue 判断某敏感键是否已配置（密文非空、或历史明文非空）。
func hasSecretValue(v any) bool {
	s, ok := v.(string)
	return ok && strings.TrimSpace(s) != ""
}

// GetSetting 取单个设置值（不存在返回 "", false）。
// 落盘为密文的键在此透明解密：调用方拿到的始终是明文，无需关心存储形态。
func (c *Config) GetSetting(key string) (string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if key == "upstream" && c.Upstream != "" {
		return c.Upstream, true
	}
	v, ok := c.Extra[key]
	if !ok {
		return "", false
	}
	v = decryptSetting(v)
	switch tv := v.(type) {
	case string:
		return tv, true
	case bool:
		if tv {
			return "1", true
		}
		return "0", true
	case float64:
		return strconv.FormatFloat(tv, 'f', -1, 64), true
	default:
		b, _ := json.Marshal(v)
		return string(b), true
	}
}

// SetSetting 写单个设置值并落盘（线程安全）。
func (c *Config) SetSetting(key string, value any) error {
	return c.Update(map[string]any{key: value})
}

// Update 用部分字段覆盖并落盘（线程安全）。仅覆盖显式传入的字段，避免清空未传字段。
// 注意：在持写锁状态下直接调无锁的 save()，避免 RWMutex 重入死锁。
func (c *Config) Update(patch map[string]any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if v, ok := patch["enhancement_enabled"]; ok {
		if b, ok := v.(bool); ok {
			c.EnhancementEnabled = b
		}
	}
	if v, ok := patch["inject_css"]; ok {
		if b, ok := v.(bool); ok {
			c.InjectCSS = b
		}
	}
	if v, ok := patch["upstream"]; ok {
		if s, ok := v.(string); ok {
			c.Upstream = s
		}
	}
	// 其余键进 Extra 平铺持久化（账号 token / 服务开关等任意设置项）
	for kk, vv := range patch {
		if knownKeys[kk] {
			continue
		}
		if vv == nil {
			delete(c.Extra, kk)
			continue
		}
		if c.Extra == nil {
			c.Extra = map[string]any{}
		}
		// 敏感键落盘前加密（明文只存在于内存与本次请求体）。已是密文则原样存，
		// 避免「读→写」往返把密文二次加密。
		if secretAtRest[kk] {
			if s, ok := vv.(string); ok {
				if s = strings.TrimSpace(s); s == "" {
					delete(c.Extra, kk)
					continue
				}
				if !secret.IsEncrypted(s) {
					enc, err := secret.EncryptStored(s)
					if err == nil {
						c.Extra[kk] = enc
						continue
					}
					logSecretIssue(err)
				}
				c.Extra[kk] = s
				continue
			}
		}
		c.Extra[kk] = vv
	}
	return c.save()
}
