// internal/secret/secret_test.go —— 凭证加密存取单测。
//
// 覆盖：内置凭证密文可解且**二进制里不出现明文**、AES-GCM 往返、篡改检测、
// 非密文兼容、每安装盐隔离（不同盐解不开彼此的密文）。
package secret

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestBuiltinCredentialsShape 内置凭证密文能解出预期形状。
func TestBuiltinCredentialsShape(t *testing.T) {
	id, secrets := BuiltinDandanplay()
	if id == "" {
		t.Fatal("内置 AppId 解密失败")
	}
	if len(id) != 10 {
		t.Errorf("AppId 长度异常: %d", len(id))
	}
	if len(secrets) != 2 {
		t.Fatalf("应有 2 个内置 Secret: %d", len(secrets))
	}
	for i, s := range secrets {
		if len(s) != 32 {
			t.Errorf("Secret #%d 长度异常: %d", i+1, len(s))
		}
		if strings.HasPrefix(s, EncPrefix) {
			t.Errorf("Secret #%d 解密后不应仍带密文前缀", i+1)
		}
	}
}

// TestBuiltinConstantsAreCiphertext 常量本身必须是密文（防止日后有人图省事贴回明文）。
func TestBuiltinConstantsAreCiphertext(t *testing.T) {
	if !IsEncrypted(builtinDandanplayAppID) {
		t.Error("builtinDandanplayAppID 必须是密文")
	}
	for i, ct := range builtinDandanplaySecrets {
		if !IsEncrypted(ct) {
			t.Errorf("builtinDandanplaySecrets[%d] 必须是密文", i)
		}
	}
}

// TestEncryptDecryptRoundTrip AES-GCM 往返。
func TestEncryptDecryptRoundTrip(t *testing.T) {
	key := Derive("test-domain")
	for _, plain := range []string{"", "a", "短", strings.Repeat("x", 4096)} {
		ct, err := Encrypt(key, plain)
		if err != nil {
			t.Fatalf("加密失败: %v", err)
		}
		if !IsEncrypted(ct) {
			t.Fatalf("密文应带前缀: %q", ct)
		}
		// 只对足够长的明文断言「不出现在密文里」：单字符（如 "a"）在 base64 字母表内，
		// 偶然出现属于正常，不是泄露。
		if len(plain) >= 8 && strings.Contains(ct, plain) {
			t.Error("密文中出现了明文片段")
		}
		got, err := Decrypt(key, ct)
		if err != nil {
			t.Fatalf("解密失败: %v", err)
		}
		if got != plain {
			t.Errorf("往返不符: got %q want %q", got, plain)
		}
	}
}

// TestDecryptWrongKeyFails 换密钥必须解不开（GCM 认证失败而非返回垃圾）。
func TestDecryptWrongKeyFails(t *testing.T) {
	ct, err := Encrypt(Derive("domain-a"), "secret-value")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Decrypt(Derive("domain-b"), ct); err == nil {
		t.Fatal("不同域密钥不应解开密文")
	}
}

// TestDecryptTamperDetected 密文被改动必须报错（GCM 认证标签生效）。
func TestDecryptTamperDetected(t *testing.T) {
	key := Derive("tamper")
	ct, err := Encrypt(key, "secret-value")
	if err != nil {
		t.Fatal(err)
	}
	raw := []byte(ct)
	// 翻转最后一个 base64 字符
	last := raw[len(raw)-1]
	if last == 'A' {
		raw[len(raw)-1] = 'B'
	} else {
		raw[len(raw)-1] = 'A'
	}
	if _, err := Decrypt(key, string(raw)); err == nil {
		t.Fatal("篡改后的密文应解密失败")
	}
}

// TestDecryptPlaintextPassthrough 历史明文值原样返回（兼容升级前的配置）。
func TestDecryptPlaintextPassthrough(t *testing.T) {
	got, err := Decrypt(Derive("any"), "plain-old-value")
	if err != nil {
		t.Fatalf("明文不应报错: %v", err)
	}
	if got != "plain-old-value" {
		t.Errorf("明文应原样返回: %q", got)
	}
}

// TestStoreKeyPerInstall 不同安装目录（不同盐）派生出不同密钥 —— 拷走 config.json 解不开。
func TestStoreKeyPerInstall(t *testing.T) {
	dirA, dirB := t.TempDir(), t.TempDir()

	// 注意：StoreKey 的盐是包级状态，测试内需串行并复位
	BindStoreDir(dirA)
	keyA := StoreKey()
	ctA, err := EncryptStored("shared-secret")
	if err != nil {
		t.Fatal(err)
	}

	BindStoreDir(dirB)
	keyB := StoreKey()
	if string(keyA) == string(keyB) {
		t.Fatal("不同安装目录应派生不同密钥")
	}
	if _, err := DecryptStored(ctA); err == nil {
		t.Fatal("换盐后不应解开另一安装的密文")
	}

	// 回到 A：原密文仍可解（盐文件已落盘复用）
	BindStoreDir(dirA)
	got, err := DecryptStored(ctA)
	if err != nil {
		t.Fatalf("回到原安装应能解开: %v", err)
	}
	if got != "shared-secret" {
		t.Errorf("往返不符: %q", got)
	}
}

// TestSaltFilePermissions 盐文件以 0600 落盘（同机其他用户读不到）。
// Windows 不支持 Unix 权限位，该断言只在部署目标（Linux）上有意义。
func TestSaltFilePermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 不支持 Unix 权限位（部署目标为 linux/amd64）")
	}
	dir := t.TempDir()
	BindStoreDir(dir)
	if _, err := EncryptStored("x"); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(dir, saltFileName))
	if err != nil {
		t.Fatalf("盐文件未落盘: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("盐文件权限应为 0600: %o", perm)
	}
}

// TestDeriveDomainSeparation 不同 label 派生不同密钥（域分隔有效）。
func TestDeriveDomainSeparation(t *testing.T) {
	a := Derive("label-a")
	b := Derive("label-b")
	if string(a) == string(b) {
		t.Fatal("不同 label 应派生不同密钥")
	}
	if len(a) != 32 {
		t.Errorf("派生密钥应为 32 字节: %d", len(a))
	}
	// 同 label 同 extra 稳定
	if string(Derive("label-a")) != string(a) {
		t.Error("同输入应派生同密钥")
	}
}
