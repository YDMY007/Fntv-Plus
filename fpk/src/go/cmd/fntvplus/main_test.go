package main

import (
	"os"
	"path/filepath"
	"testing"
)

// resolveGatewaySocketName 是网关接入的关键路径：读错会让 socket 落到错误位置、
// 网关连不上，整个应用不可用。这里用与 app/ui/config 相同的结构做覆盖。
func TestResolveGatewaySocketName(t *testing.T) {
	// 与真实 app/ui/config 逐字同构（注意 .url 前导点 + gatewaySocket）。
	const realConfig = `{
  ".url": {
    "fntvplus.Application": {
      "title": "Fntv-Plus",
      "icon": "images/fntv_v10_{0}.png",
      "type": "url",
      "protocol": "",
      "port": "",
      "gatewayPrefix": "/app/fntvplus",
      "gatewaySocket": "fntvplus.sock",
      "url": "/app/fntvplus/v/",
      "allUsers": true,
      "control": { "accessPerm": "editable" }
    }
  }
}`

	t.Run("标准配置", func(t *testing.T) {
		d := t.TempDir()
		if err := os.MkdirAll(filepath.Join(d, "ui"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(d, "ui", "config"), []byte(realConfig), 0o644); err != nil {
			t.Fatal(err)
		}
		if got := resolveGatewaySocketName(d); got != "fntvplus.sock" {
			t.Fatalf("got %q, want %q", got, "fntvplus.sock")
		}
	})

	t.Run("desktop_uidir 非 ui 时按 manifest 取", func(t *testing.T) {
		d := t.TempDir()
		if err := os.MkdirAll(filepath.Join(d, "custom_ui"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(d, "custom_ui", "config"), []byte(realConfig), 0o644); err != nil {
			t.Fatal(err)
		}
		manifest := "appname=fntvplus\ndesktop_uidir=custom_ui\n"
		if err := os.WriteFile(filepath.Join(d, "manifest"), []byte(manifest), 0o644); err != nil {
			t.Fatal(err)
		}
		if got := resolveGatewaySocketName(d); got != "fntvplus.sock" {
			t.Fatalf("got %q, want %q", got, "fntvplus.sock")
		}
	})

	t.Run("配置被塞入 ../ 时只取文件名（防路径逃逸）", func(t *testing.T) {
		d := t.TempDir()
		if err := os.MkdirAll(filepath.Join(d, "ui"), 0o755); err != nil {
			t.Fatal(err)
		}
		evil := `{".url":{"a":{"gatewaySocket":"../../etc/passwd"}}}`
		if err := os.WriteFile(filepath.Join(d, "ui", "config"), []byte(evil), 0o644); err != nil {
			t.Fatal(err)
		}
		got := resolveGatewaySocketName(d)
		if got != "passwd" {
			t.Fatalf("应只保留文件名，得到 %q", got)
		}
		if got != filepath.Base(got) {
			t.Fatalf("结果必须是纯文件名，得到 %q", got)
		}
	})

	t.Run("配置缺失/损坏返回空（不猜路径）", func(t *testing.T) {
		if got := resolveGatewaySocketName(t.TempDir()); got != "" {
			t.Fatalf("无 config 时应返回空，得到 %q", got)
		}
		d := t.TempDir()
		if err := os.MkdirAll(filepath.Join(d, "ui"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(d, "ui", "config"), []byte("{broken"), 0o644); err != nil {
			t.Fatal(err)
		}
		if got := resolveGatewaySocketName(d); got != "" {
			t.Fatalf("损坏 JSON 应返回空，得到 %q", got)
		}
	})

	t.Run("空 destDir", func(t *testing.T) {
		if got := resolveGatewaySocketName(""); got != "" {
			t.Fatalf("空 destDir 应返回空，得到 %q", got)
		}
	})
}

func TestReadManifestField(t *testing.T) {
	d := t.TempDir()
	manifest := "appname=fntvplus\ndesktop_uidir=ui\nversion=1.1.0\n"
	if err := os.WriteFile(filepath.Join(d, "manifest"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := readManifestField(d, "desktop_uidir"); got != "ui" {
		t.Fatalf("desktop_uidir got %q", got)
	}
	if got := readManifestField(d, "version"); got != "1.1.0" {
		t.Fatalf("version got %q", got)
	}
	if got := readManifestField(d, "not_exist"); got != "" {
		t.Fatalf("缺失键应返回空，得到 %q", got)
	}
	if got := readManifestField("", "version"); got != "" {
		t.Fatalf("空目录应返回空，得到 %q", got)
	}
}
