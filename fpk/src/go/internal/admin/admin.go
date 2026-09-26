// Package admin —— Fntv-Plus 影视增强的管理页与设置 API。
//
// 管理页运行在 /app/fntvplus/admin/（fnOS 微应用环境，可加载官方 JS SDK 读系统语言/主题），
// 但本后端不依赖 SDK：管理页通过我们自己的 /app/fntvplus/api/* 读写配置/状态/日志。
// 配置存于 TRIM_PKGETC/config.json（见 internal/config），反代注入逻辑实时读取总开关。
package admin

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"fntvplus/internal/config"
	"fntvplus/internal/inject"
)

// Info 是状态/日志 API 所需的运行时信息（由 cmd 装配层注入）。
type Info struct {
	Version   string    // 应用版本（与 manifest version 保持一致）
	VarDir    string    // TRIM_PKGVAR，运行时目录（fntvplus.log 所在）
	Upstream  string    // 回环上游地址（如 http://127.0.0.1:5666）
	Injector  *inject.Injector
	StartTime time.Time // 进程启动时刻：日志 API 只显示该时刻之后的行（当前版本会话）
}

// SettingsAPI 处理 GET（读配置）/ POST（改配置）。
// 配置支持任意键（账号 token / 服务开关等平铺持久化，见 config.Extra）。
func SettingsAPI(cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, cfg.GetMap())
		case http.MethodPost:
			var patch map[string]any
			if err := json.NewDecoder(io.LimitReader(r.Body, 1024*1024)).Decode(&patch); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
				return
			}
			if err := cfg.Update(patch); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, cfg.GetMap())
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	}
}

// StatusAPI 返回运行自检信息：版本 / 上游连通性 / payload 哈希 / 增强开关 / 日志路径。
// 上游取「配置生效值」（管理页可热改），info.Upstream 仅作为回退默认值。
func StatusAPI(cfg *config.Config, info Info) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		effective := strings.TrimSpace(cfg.Get().Upstream)
		if effective == "" {
			effective = info.Upstream
		}
		upstreamOK := false
		if effective != "" {
			client := &http.Client{Timeout: 2 * time.Second}
			if resp, err := client.Get(strings.TrimRight(effective, "/") + "/v/"); err == nil {
				upstreamOK = resp.StatusCode < 500
				_ = resp.Body.Close()
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"version":             info.Version,
			"upstream":            effective,
			"upstream_default":    info.Upstream,
			"upstream_ok":         upstreamOK,
			"enhancement_enabled": cfg.Get().EnhancementEnabled,
			"payload_hash":        info.Injector.Hash(),
			"payload_bytes":       info.Injector.Len(),
			"log_file":            filepath.Join(info.VarDir, "fntvplus.log"),
			"now":                 time.Now().Format(time.RFC3339),
		})
	}
}

// LogsAPI 返回日志尾部（?lines=N，默认 300，最大 2000；?src=backend|web|all，默认 all）。
// [v0.54.0] 后端日志只显示本次启动（当前版本）之后的行——按 Info.StartTime 过滤，
// 历史版本启动段（跨版本追加的 fntvplus.log）不再出现。
func LogsAPI(info Info) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		lines := 300
		if v := r.URL.Query().Get("lines"); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				lines = n
			}
		}
		if lines > 2000 {
			lines = 2000
		}
		src := r.URL.Query().Get("src")
		if src == "" {
			src = "all"
		}

		var sb strings.Builder
		if src == "backend" || src == "all" {
			if src == "all" {
				sb.WriteString("===== 后端日志 =====\n")
			}
			sb.WriteString(tailStrSince(filepath.Join(info.VarDir, "fntvplus.log"), lines, info.StartTime))
			sb.WriteString("\n")
		}
		if src == "web" || src == "all" {
			if src == "all" {
				sb.WriteString("\n===== 前端日志（payload console 回传）=====\n")
			}
			sb.WriteString(tailStr(filepath.Join(info.VarDir, "client.log"), lines))
		}

		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(sb.String()))
	}
}

// tailStr 读文件末尾 maxBytes 并只保留最后 lines 行；文件不存在返回提示。
func tailStr(path string, lines int) string {
	data, err := tailFile(path, 512*1024)
	if err != nil {
		return "(暂无日志: " + err.Error() + ")"
	}
	all := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
	if len(all) > lines {
		all = all[len(all)-lines:]
	}
	return strings.Join(all, "\n")
}

// fntvplus.log 行首时间戳的两种写法：Go log 标准前缀（2026/09/08 00:45:23）与
// cmd/main 启动脚本 date +"%F %T"（2026-09-08 00:58:57）。
var (
	reLogTS1 = regexp.MustCompile(`^(\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2})`)
	reLogTS2 = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})`)
)

// parseLogTS 解析行首时间戳（两种格式都试）；解析失败返回零值。
func parseLogTS(line string) time.Time {
	m := reLogTS1.FindStringSubmatch(line)
	if m == nil {
		m = reLogTS2.FindStringSubmatch(line)
	}
	if m == nil {
		return time.Time{}
	}
	for _, layout := range []string{"2006/01/02 15:04:05", "2006-01-02 15:04:05"} {
		if t, err := time.ParseInLocation(layout, m[1], time.Local); err == nil {
			return t
		}
	}
	return time.Time{}
}

// tailStrSince 读文件末尾 maxBytes，只保留「本次启动时刻之后」的日志行：
// 有时间戳的行与 StartTime 比较切换归属；无时间戳的行（多行堆栈等）跟随前一行归属，
// 在遇到首个达标时间戳之前的残留尾行（旧版本内容被 512KB 截断进来的）一律丢弃。
func tailStrSince(path string, lines int, start time.Time) string {
	data, err := tailFile(path, 512*1024)
	if err != nil {
		return "(暂无日志: " + err.Error() + ")"
	}
	all := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
	kept := make([]string, 0, len(all))
	inRange := start.IsZero() // 零值不过滤（兼容）
	for _, ln := range all {
		if ts := parseLogTS(ln); !ts.IsZero() {
			inRange = !ts.Before(start)
		}
		if inRange {
			kept = append(kept, ln)
		}
	}
	if len(kept) > lines {
		kept = kept[len(kept)-lines:]
	}
	if len(kept) == 0 {
		return "(本次启动暂无日志)"
	}
	return strings.Join(kept, "\n")
}

// ClientLogAPI 接收 payload 回传的前端诊断日志（POST 纯文本，按行落 client.log）。
// client.log 超过 5MB 时截断保留末尾 1MB，防止无限增长。
func ClientLogAPI(info Info) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 256*1024))
		if err != nil {
			http.Error(w, "read body: "+err.Error(), http.StatusBadRequest)
			return
		}
		path := filepath.Join(info.VarDir, "client.log")
		if st, err := os.Stat(path); err == nil && st.Size() > 5*1024*1024 {
			// 简易轮转：保留末尾 1MB
			if keep, err := tailFile(path, 1024*1024); err == nil {
				_ = os.WriteFile(path, keep, 0o644)
			}
		}
		f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err != nil {
			http.Error(w, "open log: "+err.Error(), http.StatusInternalServerError)
			return
		}
		defer f.Close()
		text := strings.TrimRight(string(body), "\n")
		if text == "" {
			text = "(empty)"
		}
		_, _ = f.WriteString(text + "\n")
		w.WriteHeader(http.StatusNoContent)
	}
}

// tailFile 读取文件末尾 maxBytes 字节（丢弃被截断的首行残段）。
func tailFile(path string, maxBytes int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	offset := int64(0)
	if st.Size() > maxBytes {
		offset = st.Size() - maxBytes
	}
	buf := make([]byte, st.Size()-offset)
	if _, err := f.ReadAt(buf, offset); err != nil {
		return nil, err
	}
	if offset > 0 {
		// 丢弃首行残段
		if i := strings.IndexByte(string(buf), '\n'); i >= 0 {
			buf = buf[i+1:]
		}
	}
	return buf, nil
}

// Page 返回极简管理页（增强总开关 + 运行状态 + 实时日志）。
func Page(cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(adminHTML))
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// adminHTML 是管理页（纯前端，调用 /app/fntvplus/api/*）。
const adminHTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>影视 Plus 设置</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "PingFang SC", sans-serif; max-width: 760px; margin: 32px auto; padding: 0 16px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .sub { color: #888; font-size: 13px; }
  .card { border: 1px solid #8884; border-radius: 12px; padding: 16px 20px; margin-top: 16px; }
  label { display: flex; align-items: center; gap: 10px; cursor: pointer; }
  input[type=checkbox] { width: 18px; height: 18px; }
  .hint { color: #888; font-size: 13px; margin-top: 8px; }
  .status { margin-left: auto; font-size: 13px; color: #2a8; }
  table { width: 100%; font-size: 13px; border-collapse: collapse; }
  td { padding: 4px 0; }
  td.k { color: #888; width: 110px; vertical-align: top; }
  .ok { color: #2a8; font-weight: 600; }
  .bad { color: #c44; font-weight: 600; }
  pre { background: #8881; border-radius: 8px; padding: 12px; font-size: 12px; line-height: 1.5;
        max-height: 380px; overflow: auto; white-space: pre-wrap; word-break: break-all; margin: 8px 0 0; }
  .row { display: flex; align-items: center; gap: 10px; font-size: 13px; flex-wrap: wrap; }
  button { padding: 4px 12px; border-radius: 8px; border: 1px solid #8886; background: transparent; cursor: pointer; }
  button.on { border-color: #2a8; color: #2a8; }
  select { padding: 3px 6px; }
</style>
</head>
<body>
  <h1>影视 Plus · 设置</h1>
  <div class="sub">版本 <span id="v">-</span> · payload <span id="ph">-</span></div>

  <div class="card">
    <label>
      <input type="checkbox" id="enh">
      <span>启用网页端增强（海报墙 / 轮播 / 沉浸式美化）</span>
      <span class="status" id="status"></span>
    </label>
    <div class="hint">关闭后反代完全透传，等价于原版飞牛影视。设置保存在 NAS 上，多设备共享。</div>
  </div>

  <div class="card">
    <b style="font-size:14px">运行状态</b> <span style="font-size:12px;color:#888">每 5 秒自动刷新</span>
    <table style="margin-top:8px">
      <tr><td class="k">影视上游</td><td><span id="up">-</span></td></tr>
      <tr><td class="k">上游地址</td>
        <td><div class="row" style="margin:0">
          <input id="upin" style="flex:1;min-width:220px;padding:4px 8px;border-radius:6px;border:1px solid #8886;background:transparent;color:inherit" placeholder="http://127.0.0.1:端口">
          <button id="ups">保存</button>
        </div></td></tr>
      <tr><td class="k">日志文件</td><td id="logfile">-</td></tr>
    </table>
    <div class="hint">改完上游点「保存」，看「影视上游」是否变「连通 ✓」。不知道端口？SSH 到 NAS 跑 <code>ss -tlnp</code>，找飞牛影视/nginx 监听的端口；或直接填你浏览器打开飞牛影视用的地址（如 http://127.0.0.1:5666）。留空 = 用启动自动推导值。</div>
  </div>

  <div class="card">
    <div class="row">
      <b style="font-size:14px">实时日志</b>
      <button id="tabBackend" class="on">后端日志</button>
      <button id="tabWeb">前端日志</button>
      <select id="lines"><option>100</option><option selected>300</option><option>1000</option></select>
      <label style="gap:4px"><input type="checkbox" id="auto" checked> 自动刷新</label>
      <button id="refresh">刷新</button>
      <button id="copy">复制</button>
    </div>
    <div class="hint">仅显示本次启动（当前版本）的日志 · 每次刷新自动滚动到底部 · 后端=反代/桥接/同步，前端=payload console 回传（轮播墙问题看 [EmbyWall][CAROUSEL] 与 [error] 行）</div>
    <pre id="log">加载中…</pre>
  </div>

  <script>
    const $ = (s) => document.querySelector(s);
    const API = '/app/fntvplus/api';

    async function loadSettings() {
      try {
        const c = await (await fetch(API + '/settings')).json();
        $('#enh').checked = !!c.enhancement_enabled;
      } catch (e) { $('#status').textContent = '读取失败'; }
    }
    $('#enh').addEventListener('change', async (e) => {
      $('#status').textContent = '保存中…';
      try {
        await fetch(API + '/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enhancement_enabled: e.target.checked })
        });
        $('#status').textContent = '已保存';
      } catch (err) { $('#status').textContent = '保存失败'; }
    });

    async function loadStatus() {
      try {
        const s = await (await fetch(API + '/status')).json();
        $('#v').textContent = s.version || '-';
        $('#ph').textContent = (s.payload_hash || '-') + ' (' + Math.round((s.payload_bytes||0)/1024) + 'KB)';
        $('#up').innerHTML = s.upstream_ok ? '<span class="ok">连通 ✓</span>' : '<span class="bad">不通 ✗</span>';
        const inp = $('#upin');
        if (document.activeElement !== inp) inp.value = s.upstream || '';
        $('#logfile').textContent = s.log_file || '-';
      } catch (e) { $('#up').innerHTML = '<span class="bad">状态读取失败</span>'; }
    }

    $('#ups').addEventListener('click', async () => {
      $('#ups').textContent = '保存中…';
      try {
        await fetch(API + '/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ upstream: $('#upin').value.trim() })
        });
        $('#ups').textContent = '已保存';
      } catch (e) { $('#ups').textContent = '保存失败'; }
      loadStatus();
      setTimeout(() => { $('#ups').textContent = '保存'; }, 1500);
    });

    let logSrc = 'backend';
    async function loadLogs() {
      try {
        const t = await (await fetch(API + '/logs?lines=' + $('#lines').value + '&src=' + logSrc)).text();
        const pre = $('#log');
        pre.textContent = t;
        pre.scrollTop = pre.scrollHeight; // [v0.54.0] 每次刷新都自动滚动到底部
      } catch (e) { $('#log').textContent = '日志读取失败: ' + e; }
    }
    function setLogTab(src) {
      logSrc = src;
      $('#tabBackend').classList.toggle('on', src === 'backend');
      $('#tabWeb').classList.toggle('on', src === 'web');
      loadLogs();
    }
    $('#tabBackend').addEventListener('click', () => setLogTab('backend'));
    $('#tabWeb').addEventListener('click', () => setLogTab('web'));
    $('#copy').addEventListener('click', async () => {
      const btn = $('#copy');
      const text = $('#log').textContent || '';
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = '已复制 ✓';
      } catch (e) {
        // 非安全上下文（http://IP）下 clipboard API 不可用 → 选中文本走 execCommand 兜底
        try {
          const range = document.createRange();
          range.selectNodeContents($('#log'));
          const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
          const ok = document.execCommand('copy');
          sel.removeAllRanges();
          btn.textContent = ok ? '已复制 ✓' : '复制失败';
        } catch (e2) { btn.textContent = '复制失败'; }
      }
      setTimeout(() => { btn.textContent = '复制'; }, 1500);
    });

    $('#refresh').addEventListener('click', () => { loadStatus(); loadLogs(); });
    $('#lines').addEventListener('change', loadLogs);

    loadSettings(); loadStatus(); loadLogs();
    setInterval(loadStatus, 5000);
    setInterval(() => { if ($('#auto').checked) loadLogs(); }, 5000);
  </script>
</body>
</html>`
