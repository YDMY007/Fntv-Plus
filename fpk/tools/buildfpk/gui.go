// tools/buildfpk/gui.go — 网页 GUI 打包模式（build-fpk.exe --serve）。
//
// 用户需求：网页界面控制 ①应用显示名（飞牛应用商店真实展示名，写 manifest display_name）
// ②应用正式版号（写 manifest version），点「打包」执行完整流程，产物重命名为
// Fntv-Plus-V<版号去点>.fpk（大写 V，如 1.5.2 → Fntv-Plus-V152.fpk），版号由用户填写
//（每次打一次加一点），网页实时回显打包日志。
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

var buildMu chan struct{} // 打包互斥（页面重复点击防护）

func manifestGetString(key, def string) string {
	data, err := os.ReadFile(filepath.Join(root, "manifest"))
	if err != nil {
		return def
	}
	re := regexp.MustCompile(`(?m)^\s*` + key + `\s*=\s*(.*)$`)
	m := re.FindStringSubmatch(string(data))
	if len(m) < 2 {
		return def
	}
	return strings.TrimSpace(m[1])
}

func manifestSetString(key, value string) error {
	path := filepath.Join(root, "manifest")
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	re := regexp.MustCompile(`(?m)^(\s*` + key + `\s*=\s*).*$`)
	updated := re.ReplaceAllString(string(data), "${1}"+value)
	return os.WriteFile(path, []byte(updated), 0o644)
}

// packNamed 网页模式完整打包：写 display_name/version → payload → 后端 → fnpack
// → 产物重命名 Fntv-Plus-VXYZ.fpk（大写 V）。版号完全由用户在网页上控制。
func packNamed(displayName, version string) (string, error) {
	if displayName == "" {
		return "", fmt.Errorf("显示名不能为空")
	}
	if !regexp.MustCompile(`^\d+\.\d+\.\d+$`).MatchString(version) {
		return "", fmt.Errorf("版号须为 x.y.z 三段数字（当前输入: %s）", version)
	}
	if err := manifestSetString("display_name", displayName); err != nil {
		return "", err
	}
	// [v1.6.3] 双轨版号: release_version = 正式版号(用户填写, 测试版号基号);
	//            version = 本次安装包实际版本号(发布=正式版号本身)。
	if err := manifestSetString("release_version", version); err != nil {
		return "", err
	}
	if err := manifestSetString("version", version); err != nil {
		return "", err
	}
	syncPayload()
	bin := filepath.Join(root, "app", "server", "fntvplus")
	if err := buildBackend(bin); err != nil {
		return "", err
	}
	out, err := pack()
	if err != nil {
		return "", err
	}
	compact := strings.ReplaceAll(version, ".", "")
	named := filepath.Join(root, "Fntv-Plus-V"+compact+".fpk")  // 发布版大写 V（用户要求区分测试版小 v）
	if err := os.Rename(out, named); err != nil {
		return out, nil // 重命名失败不致命，返回原名
	}
	// [v1.6.0] 发布版号完全由用户在网页上控制（写 manifest version），不再自动 +1——
	// 自动 +1 属于开发版流程（git commit 数版号），两套版本号互不相干。
	return named, nil
}

func htmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace(s)
}

const guiPageTpl = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>Fntv-Plus 打包器</title>
<style>
  body{margin:0;font:14px/1.7 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;background:#0f1115;color:#e8eaee;
       display:flex;justify-content:center;padding:40px 16px;}
  .card{width:520px;background:#181b21;border:1px solid #2a2f3a;border-radius:16px;padding:28px 30px;box-sizing:border-box;}
  h1{font-size:17px;margin:0 0 4px;} .sub{font-size:11.5px;color:#8b93a3;margin-bottom:20px;}
  label{display:block;font-size:12px;color:#aab2c0;margin:14px 0 5px;}
  input{width:100%;box-sizing:border-box;height:36px;font-size:13px;color:#e8eaee;
        background:#0f1115;border:1px solid #2a2f3a;border-radius:8px;padding:6px 10px;}
  input:focus{outline:none;border-color:#5a7cd6;}
  .hint{font-size:10.5px;color:#6b7383;margin-top:4px;line-height:1.5;}
  button{width:100%;margin-top:22px;height:40px;border:none;border-radius:9px;cursor:pointer;
         font-size:14px;font-weight:700;background:#5a7cd6;color:#fff;transition:background .15s;}
  button:hover{background:#6b8ce6;} button:disabled{background:#3a4150;cursor:wait;}
  #log{margin-top:18px;padding:12px;background:#0b0d10;border:1px solid #232833;border-radius:10px;
       font:11px/1.6 ui-monospace,Consolas,monospace;color:#9fd48a;white-space:pre-wrap;
       max-height:340px;overflow:auto;display:none;}
  .done{color:#7ee08a;font-size:12.5px;margin-top:12px;min-height:18px;}
</style></head><body>
<div class="card">
  <h1>Fntv-Plus 应用打包</h1>
  <div class="sub">显示名与版号都会写入应用清单——飞牛应用商店与应用详情按此显示。本页为正式发布版，与开发测试版（commit 数版号）互不相干。</div>
  <label>应用显示名（飞牛商店展示名）</label>
  <input id="dn" value="__NAME__">
  <label>正式版号（x.y.z）</label>
  <input id="ver" value="__VER__">
  <div class="hint">产物：Fntv-Plus-V&lt;版号去点&gt;.fpk（大写 V=正式发布版；小写 v=开发测试版，按 commit 数自动命名）。版号完全由你填写。</div>
  <button id="go" onclick="pack()">打 包</button>
  <div class="done" id="done"></div>
  <pre id="log"></pre>
</div>
<script>
async function refresh() {
  const r = await fetch('/api/state'); const j = await r.json();
  const dn = document.getElementById('dn'), ver = document.getElementById('ver');
  if (document.activeElement !== dn) dn.value = j.displayName;
  if (document.activeElement !== ver) ver.value = j.version;
}
async function pack() {
  const btn = document.getElementById('go');
  btn.disabled = true; document.getElementById('done').textContent = '';
  const logEl = document.getElementById('log'); logEl.style.display = 'block'; logEl.textContent = '';
  try {
    const r = await fetch('/api/pack', {method:'POST',
      headers:{'content-type':'application/json'},
      body: JSON.stringify({displayName: document.getElementById('dn').value.trim(),
                            version: document.getElementById('ver').value.trim()})});
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const {done, value} = await reader.read(); if (done) break;
      buf += dec.decode(value, {stream:true});
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        try { const j = JSON.parse(l);
          if (j.log) { logEl.textContent += j.log + '\n'; logEl.scrollTop = logEl.scrollHeight; }
          if (j.event === 'done') {
            document.getElementById('done').textContent = '✓ 打包完成: ' + j.file;
            document.getElementById('ver').value = j.nextVersion;
          }
          if (j.event === 'error') { document.getElementById('done').textContent = '✗ ' + j.msg; }
        } catch {}
      }
    }
  } catch (e) { document.getElementById('done').textContent = '✗ ' + e.message; }
  btn.disabled = false;
  refresh();
}
refresh();
</script></body></html>`

func serveGUI() {
	exe, err := os.Executable()
	if err != nil {
		fmt.Printf("[X] %v\n", err)
		os.Exit(1)
	}
	root = filepath.Dir(exe)
	if _, err := os.Stat(filepath.Join(root, "manifest")); err != nil {
		fmt.Printf("[X] 在 %s 找不到 manifest，请把 build-fpk.exe 放在 fntvplus 仓库根目录\n", root)
		os.Exit(1)
	}
	buildMu = make(chan struct{}, 1)
	addr := "127.0.0.1:8199"

	page := strings.ReplaceAll(guiPageTpl, "__NAME__", htmlEscape(manifestGetString("display_name", "Fntv-Plus")))
	page = strings.ReplaceAll(page, "__VER__", htmlEscape(manifestGetString("release_version", "1.0.0")))

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("content-type", "text/html; charset=utf-8")
		w.Write([]byte(page))
	})
	http.HandleFunc("/api/state", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(map[string]string{
			"displayName": manifestGetString("display_name", "Fntv-Plus"),
			"version":     manifestGetString("release_version", "1.0.0"),
		})
	})
	http.HandleFunc("/api/pack", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			DisplayName string `json:"displayName"`
			Version     string `json:"version"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		w.Header().Set("content-type", "application/json; charset=utf-8")
		w.Header().Set("x-accel-buffering", "no")
		flusher := w.(http.Flusher)
		select {
		case buildMu <- struct{}{}:
			defer func() { <-buildMu }()
		default:
			json.NewEncoder(w).Encode(map[string]any{"event": "error", "msg": "已有打包在进行中"})
			return
		}
		// 子进程 stdout 同时写控制台与响应流（NDJSON 行流）
		pipeR, pipeW, pipeErr := os.Pipe()
		if pipeErr != nil {
			json.NewEncoder(w).Encode(map[string]any{"event": "error", "msg": pipeErr.Error()})
			return
		}
		oldStd := os.Stdout
		os.Stdout = pipeW
		done := make(chan struct{})
		go func() {
			sc := bufio.NewScanner(pipeR)
			sc.Buffer(make([]byte, 64*1024), 1024*1024)
			for sc.Scan() {
				line := sc.Text()
				fmt.Println(line)
				json.NewEncoder(w).Encode(map[string]string{"log": line})
				flusher.Flush()
			}
			close(done)
		}()
		file, err := packNamed(req.DisplayName, req.Version)
		pipeW.Close()
		<-done
		os.Stdout = oldStd
		if err != nil {
			json.NewEncoder(w).Encode(map[string]any{"event": "error", "msg": err.Error()})
			return
		}
		json.NewEncoder(w).Encode(map[string]any{
			"event":       "done",
			"file":        filepath.Base(file),
			"nextVersion": manifestGetString("release_version", "1.0.0"),
		})
	})
	fmt.Printf("Fntv-Plus 网页打包器: http://%s  (显示名=%s 版号=%s)\n",
		addr, manifestGetString("display_name", "Fntv-Plus"), manifestGetString("release_version", "1.0.0"))
	_ = exec.Command("cmd", "/c", "start", "http://"+addr).Start()
	if err := http.ListenAndServe(addr, nil); err != nil {
		fmt.Printf("[X] 监听失败(端口可能被占用): %v\n", err)
		os.Exit(1)
	}
}
