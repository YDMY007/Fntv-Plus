// Package secret —— Fntv-Plus 敏感凭证的加密存取。
//
// 两类材料的两种保护策略：
//
//  1. 内置凭证（弹弹play 开放平台 AppId/Secret）：密文编译进二进制，解密密钥由
//     编译期常量在运行时异或还原 → 直接对二进制 strings/grep 拿不到明文凭证。
//     内置凭证必须「装完即用」，不能依赖任何运行时文件，故只用根密钥域。
//
//  2. 用户自定义凭证（设置面板填写）：落盘前用 AES-256-GCM 加密写入 config.json，
//     密钥 = 根密钥 + 每安装随机盐（<etc>/.fntvplus-key，0600）。config.json 被拷走
//     也解不开；盐文件丢失（迁移/删目录）时按「未配置」降级，不影响应用启动。
//
// 定位说明（对用户如实）：这不是密码学意义上的不可提取——二进制在用户手里，
// 有足够耐心总能还原逻辑。目标是让凭证不以明文形态出现在二进制、配置文件和
// 日志里：随手 unzip/grep/cat 拿不到可用密钥。
package secret

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// EncPrefix 密文标记。落盘值以此开头即视为密文；无前缀按历史明文兼容读。
const EncPrefix = "enc:v1:"

// rootKeyMasked / rootKeyMasks 内置根密钥的掩码形态：真实根密钥 = masked ^ mask。
// 拆成 4 个 64 位字分别掩码，是不让密钥以连续明文出现在二进制的静态数据里。
var rootKeyMasked = [4]uint64{
	0xf010c23f9eb202e1,
	0x3311f77f2252a875,
	0xcaf704bc597a481c,
	0x4e52e841b1ba19ef,
}

var rootKeyMasks = [4]uint64{
	0xbe42ecd482fcdc0d,
	0x8198532fcd2eb722,
	0x50103fbadc74de64,
	0x3a86a1704516f465,
}

// rootKey 还原根密钥（32 字节）。
func rootKey() []byte {
	out := make([]byte, 32)
	for i := 0; i < 4; i++ {
		binary.BigEndian.PutUint64(out[i*8:], rootKeyMasked[i]^rootKeyMasks[i])
	}
	return out
}

// Derive 由根密钥派生 32 字节子密钥（域分隔：label + 附加材料，各段以 0 分隔避免歧义拼接）。
func Derive(label string, extra ...[]byte) []byte {
	h := sha256.New()
	h.Write([]byte("fntvplus/secret/v1"))
	h.Write([]byte{0})
	h.Write(rootKey())
	h.Write([]byte{0})
	h.Write([]byte(label))
	for _, e := range extra {
		h.Write([]byte{0})
		h.Write(e)
	}
	return h.Sum(nil)
}

// IsEncrypted 判断落盘值是否为密文。
func IsEncrypted(v string) bool { return strings.HasPrefix(v, EncPrefix) }

// Encrypt 用 key 加密明文，返回带 EncPrefix 的落盘字符串。
func Encrypt(key []byte, plain string) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nil, nonce, []byte(plain), nil)
	return EncPrefix + base64.StdEncoding.EncodeToString(append(nonce, sealed...)), nil
}

// Decrypt 解密 Encrypt 产物；非密文原样返回（历史明文兼容）。
func Decrypt(key []byte, token string) (string, error) {
	if !IsEncrypted(token) {
		return token, nil
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(token, EncPrefix))
	if err != nil {
		return "", fmt.Errorf("密文解码失败: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(raw) < gcm.NonceSize() {
		return "", errors.New("密文长度不足")
	}
	plain, err := gcm.Open(nil, raw[:gcm.NonceSize()], raw[gcm.NonceSize():], nil)
	if err != nil {
		return "", fmt.Errorf("解密失败（密钥不匹配或数据损坏）: %w", err)
	}
	return string(plain), nil
}

/* ── 每安装盐：自定义凭证的落盘密钥 ── */

// 盐文件名与长度。存于 config.json 同目录：同目录随配置一起迁移即同步生效，
// 单独拷走 config.json 则解不开。
const (
	saltFileName = ".fntvplus-key"
	saltLen      = 32
)

var (
	saltMu   sync.Mutex
	saltPath string // 已绑定的盐文件路径（空 = 未初始化，用内置域密钥兜底）
	saltKey  []byte
)

// initSalt 绑定盐文件路径。首次调用时读文件；不存在则生成随机盐写入（0600）。
// 目录不可写等异常一律降级为内置域密钥（跨安装同域，仅弱化保护，不阻断功能）。
func initSalt(dir string) {
	if dir == "" {
		return
	}
	saltMu.Lock()
	defer saltMu.Unlock()
	want := filepath.Join(dir, saltFileName)
	if saltPath == want && saltKey != nil {
		return
	}
	saltPath = want
	if data, err := os.ReadFile(want); err == nil && len(data) >= saltLen {
		saltKey = data[:saltLen]
		return
	}
	buf := make([]byte, saltLen)
	if _, err := rand.Read(buf); err != nil {
		saltKey = nil
		return
	}
	_ = os.MkdirAll(dir, 0o755)
	if err := os.WriteFile(want, buf, 0o600); err != nil {
		// 写不进去（只读挂载/权限不足）：本次运行用生成的盐，重启后失效 →
		// 调用方按「解密失败 = 未配置」降级，不会崩溃。
		saltKey = buf
		return
	}
	saltKey = buf
}

// BindStoreDir 由 config 层在装载配置时调用，把盐文件绑到配置目录。
func BindStoreDir(dir string) { initSalt(dir) }

// StoreKey 自定义凭证的落盘密钥（根密钥域 + 每安装盐）。
func StoreKey() []byte {
	saltMu.Lock()
	salt := saltKey
	saltMu.Unlock()
	if salt == nil {
		return Derive("config-fallback-v1")
	}
	return Derive("config-v1", salt)
}

// EncryptStored / DecryptStored 面向落盘字符串的便捷封装（自定义凭证）。
func EncryptStored(plain string) (string, error) { return Encrypt(StoreKey(), plain) }

func DecryptStored(token string) (string, error) { return Decrypt(StoreKey(), token) }

/* ── 内置凭证（密文常量，见 builtin.go） ── */

// BuiltinDandanplay 返回内置弹弹play 凭证（AppId + 若干 Secret，按顺序尝试）。
// 解密失败（常量被改动/版本不匹配）返回 nil，调用方按「无内置凭证」处理。
func BuiltinDandanplay() (appID string, secrets []string) {
	key := Derive("dandanplay-builtin-v1")
	id, err := Decrypt(key, builtinDandanplayAppID)
	if err != nil {
		return "", nil
	}
	for _, ct := range builtinDandanplaySecrets {
		if s, err := Decrypt(key, ct); err == nil && strings.TrimSpace(s) != "" {
			secrets = append(secrets, strings.TrimSpace(s))
		}
	}
	return strings.TrimSpace(id), secrets
}
