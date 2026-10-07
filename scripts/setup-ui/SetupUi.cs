// SetupUi.cs — Fntv-Plus 自绘安装器 UI 进程(WPF + WebView2)
// 架构: NSIS stub 启动本进程 → HTML/CSS 界面 → 选定模式/路径后以 /S 静默参数
// 重新拉起安装器本体(electron-updater/卸载器/EB 安装逻辑零改动), 本进程轮询
// INSTDIR 字节数换算真实进度。
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Threading;
using System.Windows;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace FntvSetupUi {
    static class Args {
        public static string Get(string[] a, string name, string def = null) {
            for (int i = 0; i < a.Length; i++) {
                var k = a[i];
                if (k.StartsWith("--" + name + "=", StringComparison.OrdinalIgnoreCase)) return k.Substring(name.Length + 3);
                if (k.Equals("--" + name, StringComparison.OrdinalIgnoreCase) && i + 1 < a.Length) return a[++i];
            }
            return def;
        }
    }

    // 极简扁平 JSON(本项目 web 消息全是扁平 string/number), 不引第三方依赖
    static class MiniJson {
        public static Dictionary<string, string> Parse(string s) {
            var d = new Dictionary<string, string>();
            if (string.IsNullOrEmpty(s)) return d;
            int i = 0, n = s.Length;
            Func<int, int> skipWs = (p) => { while (p < n && (s[p] == ' ' || s[p] == '\t' || s[p] == '\r' || s[p] == '\n')) p++; return p; };
            i = skipWs(i);
            if (i >= n || s[i] != '{') return d;
            i++;
            while (i < n) {
                i = skipWs(i);
                if (i < n && s[i] == '}') break;
                if (i < n && s[i] == ',') { i++; continue; }
                if (i >= n || s[i] != '"') break;
                int q = s.IndexOf('"', i + 1);
                if (q < 0) break;
                var key = Unescape(s.Substring(i + 1, q - i - 1));
                i = skipWs(q + 1);
                if (i >= n || s[i] != ':') break;
                i = skipWs(i + 1);
                if (i < n && s[i] == '"') {
                    var sb = new System.Text.StringBuilder();
                    i++;
                    while (i < n && s[i] != '"') {
                        if (s[i] == '\\' && i + 1 < n) {
                            char c = s[i + 1];
                            if (c == 'n') sb.Append('\n');
                            else if (c == 't') sb.Append('\t');
                            else if (c == 'r') sb.Append('\r');
                            else if (c == 'u' && i + 5 < n) {
                                sb.Append((char)Convert.ToInt32(s.Substring(i + 2, 4), 16));
                                i += 4;
                            } else sb.Append(c);
                            i += 2;
                        } else { sb.Append(s[i]); i++; }
                    }
                    i++;
                    d[key] = sb.ToString();
                } else {
                    int st = i;
                    while (i < n && s[i] != ',' && s[i] != '}') i++;
                    d[key] = s.Substring(st, i - st).Trim();
                }
            }
            return d;
        }
        static string Unescape(string s) {
            return s.Replace("\\\"", "\"").Replace("\\\\", "\\").Replace("\\n", "\n").Replace("\\t", "\t");
        }
        public static string Esc(string s) {
            if (s == null) return "";
            var sb = new System.Text.StringBuilder();
            foreach (char c in s) {
                switch (c) {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }
        public static string Obj(params string[] kv) {
            var sb = new System.Text.StringBuilder("{");
            for (int i = 0; i + 1 < kv.Length; i += 2) {
                if (i > 0) sb.Append(',');
                sb.Append('"').Append(kv[i]).Append("\":");
                if (kv[i + 1] == "true" || kv[i + 1] == "false" || long.TryParse(kv[i + 1], out _))
                    sb.Append(kv[i + 1]);
                else
                    sb.Append('"').Append(Esc(kv[i + 1])).Append('"');
            }
            return sb.Append('}').ToString();
        }
    }

    public class App : Application {
        Window _win;
        WebView2 _wv;
        string _setupExe, _wwwDir, _wwwBase, _workDir, _instDir = "", _exeName = "Fntv-Plus.exe", _version = "";
        long _totalSize;
        string[] _launchArgs = new string[0];
        bool _dev, _installing, _finished, _launched;
        System.Diagnostics.Process _child;
        DispatcherTimer _poll;
        string _defaultUserPath, _defaultAllPath;

        [STAThread]
        static void Main(string[] args) {
            bool created;
            var mutex = new Mutex(true, "Fntv-Plus.SetupUI", out created);
            if (!created) return;
            Log("launch: " + string.Join(" ", args));
            AppDomain.CurrentDomain.UnhandledException += (s, e) => Log("Unhandled: " + e.ExceptionObject);
            System.Windows.Forms.Application.SetUnhandledExceptionMode(System.Windows.Forms.UnhandledExceptionMode.CatchException);
            System.Windows.Forms.Application.ThreadException += (s, e) => Log("ThreadException: " + e.Exception);
            var app = new App();
            app.DispatcherUnhandledException += (s, e) => { Log("Dispatcher: " + e.Exception); e.Handled = true; };
            try { app.Run(); } catch (Exception ex) { Log("Run: " + ex); } finally { mutex.ReleaseMutex(); }
            Log("exit");
        }

        static void Log(object msg) {
            try {
                File.AppendAllText(
                    Path.Combine(Path.GetTempPath(), "FntvSetupUi.log"),
                    DateTime.Now.ToString("HH:mm:ss.fff ") + msg + Environment.NewLine);
            } catch { }
        }

        protected override void OnStartup(StartupEventArgs e) {
            _launchArgs = e.Args;
            _dev = Args.Get(e.Args, "dev") != null;
            _setupExe = Args.Get(e.Args, "setup", "");
            _wwwDir = Args.Get(e.Args, "www", "");
            _workDir = Path.Combine(Path.GetTempPath(), "fntv-setup-" + Guid.NewGuid().ToString("N").Substring(0, 8));
            Directory.CreateDirectory(_workDir);

            _defaultUserPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Fntv-Plus");
            _defaultAllPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Fntv-Plus");

            if (string.IsNullOrEmpty(_wwwDir)) _wwwDir = AppDomain.CurrentDomain.BaseDirectory;
            _wwwBase = _wwwDir;   // 资材基目录(totalsize/app-meta 所在, zip 解压后 _wwwDir 会切走)

            // 打包态: www.zip 就地解压(开发态直接用 www 目录)
            string zip = Path.Combine(_wwwDir, "www.zip");
            if (!File.Exists(zip)) zip = Path.Combine(_wwwDir, "ui.zip");   // 兼容旧命名
            if (File.Exists(zip)) {
                var ext = Path.Combine(_workDir, "www");
                ZipFile.ExtractToDirectory(zip, ext);
                _wwwDir = ext;
                Log("www extracted -> " + ext);
            }

            LoadMeta();
            _instDir = _defaultUserPath;

            _win = new Window {
                Title = "Fntv-Plus 安装",
                Width = 780,
                Height = 520,
                WindowStartupLocation = WindowStartupLocation.CenterScreen,
                WindowStyle = WindowStyle.None,
                ResizeMode = ResizeMode.NoResize,
                ShowInTaskbar = true,
                Background = System.Windows.Media.Brushes.White,
                Icon = TryLoadIcon()
            };
            _wv = new WebView2 { DefaultBackgroundColor = System.Drawing.Color.Transparent };
            _win.Content = _wv;
            _win.Loaded += async (s, ev) => {
                try {
                    var env = await CoreWebView2Environment.CreateAsync(
                        null, Path.Combine(_workDir, "webview2"), new CoreWebView2EnvironmentOptions());
                    await _wv.EnsureCoreWebView2Async(env);
                    var c = _wv.CoreWebView2;
                    c.WebMessageReceived += OnWebMessage;
                    c.SetVirtualHostNameToFolderMapping("installer.local", _wwwDir, CoreWebView2HostResourceAccessKind.Allow);
                    c.NavigationCompleted += (s2, e2) => Log("nav ok=" + e2.IsSuccess + " err=" + e2.WebErrorStatus);
                    string shotsDir = Args.Get(_launchArgs, "shots", "");
                    bool tour = !string.IsNullOrEmpty(shotsDir);
                    c.Navigate(tour ? "https://installer.local/index.html?tour=1" : "https://installer.local/index.html");
                    if (tour) ScheduleShots(shotsDir);
                } catch (Exception ex) {
                    MessageBox.Show("WebView2 运行时初始化失败: " + ex.Message +
                        "\n\n请安装 Microsoft Edge WebView2 运行时后重试。", "Fntv-Plus 安装",
                        MessageBoxButton.OK, MessageBoxImage.Warning);
                    Shutdown(1);
                }
            };
            MainWindow = _win;
            _win.Show();
        }

        System.Windows.Media.ImageSource TryLoadIcon() {
            try {
                var p = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "icon.ico");
                if (File.Exists(p)) return new System.Windows.Media.Imaging.BitmapImage(new Uri(p));
                var p2 = Path.Combine(Path.GetDirectoryName(_setupExe) ?? "", "icon.ico");
                if (File.Exists(p2)) return new System.Windows.Media.Imaging.BitmapImage(new Uri(p2));
            } catch { }
            return null;
        }

        // --shots=<dir>: 巡演定时截图(WebView2 CapturePreview, 不截屏幕), 含协议弹层
        void ScheduleShots(string dir) {
            Directory.CreateDirectory(dir);
            var beats = new[] {
                new { delay = 800, name = "p1-welcome" },
                new { delay = 1600, name = "p1b-license" },
                new { delay = 3400, name = "p2-options" },
                new { delay = 5400, name = "p3-progress" },
                new { delay = 11500, name = "p4-finish" },
            };
            foreach (var b in beats) {
                var t = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(b.delay) };
                t.Tick += async (s, e) => {
                    t.Stop();
                    try {
                        using (var fs = File.Create(Path.Combine(dir, b.name + ".png")))
                            await _wv.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, fs);
                        Log("shot " + b.name);
                    } catch (Exception ex) { Log("shot fail " + b.name + ": " + ex.Message); }
                    if (b.name == "p4-finish") Shutdown(0);
                };
                t.Start();
            }
        }

        void LoadMeta() {
            try {
                var j = MiniJson.Parse(File.ReadAllText(Path.Combine(_wwwBase, "app-meta.json")));
                _version = j.ContainsKey("version") ? j["version"] : "";
                _exeName = j.ContainsKey("exeName") ? j["exeName"] : _exeName;
            } catch { }
            try {
                _totalSize = long.Parse(File.ReadAllText(Path.Combine(_wwwBase, "totalsize.txt")).Trim());
            } catch { _totalSize = 0; }
            Log("meta: version=" + _version + " exe=" + _exeName + " total=" + _totalSize);
        }

        long TotalSize() {
            return _totalSize;
        }

        void OnWebMessage(object s, CoreWebView2WebMessageReceivedEventArgs e) {
            var m = MiniJson.Parse(e.TryGetWebMessageAsString());
            string type;
            if (!m.TryGetValue("type", out type)) return;
            switch (type) {
                case "ready":
                    Post(MiniJson.Obj("type", "meta", "version", _version, "exeName", _exeName,
                        "mode", "user", "path", _defaultUserPath));
                    // --auto <mode>: E2E 自动化(配合 --auto-path/--auto-exit), 无人值守真机验证
                    string autoMode = Args.Get(_launchArgs, "auto", "");
                    if (autoMode == "user" || autoMode == "all") {
                        string autoPath = Args.Get(_launchArgs, "auto-path", "");
                        if (!string.IsNullOrEmpty(autoPath)) _instDir = autoPath;
                        Post(MiniJson.Obj("type", "folder", "path", _instDir));
                        StartInstall(autoMode);
                    }
                    break;
                case "modeChanged": {
                    string mode = m.ContainsKey("mode") ? m["mode"] : "user";
                    string cur = _instDir;
                    string want = mode == "all" ? _defaultAllPath : _defaultUserPath;
                    // 路径还停留在另一模式的默认值时才跟随切换, 用户自选过则保留
                    if (cur.Equals(mode == "all" ? _defaultUserPath : _defaultAllPath, StringComparison.OrdinalIgnoreCase) || string.IsNullOrEmpty(cur)) {
                        _instDir = want;
                        Post(MiniJson.Obj("type", "folder", "path", want));
                    }
                    break;
                }
                case "pickFolder": {
                    string cur = _instDir;
                    var th = new Thread(() => {
                        string picked = null, warn = null;
                        var dlg = new System.Windows.Forms.FolderBrowserDialog {
                            Description = "选择安装文件夹",
                            ShowNewFolderButton = true
                        };
                        if (Directory.Exists(cur)) dlg.SelectedPath = cur;
                        if (dlg.ShowDialog() == System.Windows.Forms.DialogResult.OK) {
                            picked = dlg.SelectedPath;
                            bool nonAscii = false;
                            foreach (char ch in picked) if (ch > 127) { nonAscii = true; break; }
                            if (nonAscii) warn = "该路径包含中文或非英文字符, 可能导致内置代理服务或外部播放器无法启动。";
                        }
                        Dispatcher.BeginInvoke(new Action(() => {
                            if (picked != null) { _instDir = picked; Post(MiniJson.Obj("type", "folder", "path", picked, "warn", warn ?? "")); }
                        }));
                    });
                    th.SetApartmentState(ApartmentState.STA);
                    th.Start();
                    break;
                }
                case "install": {
                    string mode = m.ContainsKey("mode") ? m["mode"] : "user";
                    string path = m.ContainsKey("path") ? m["path"] : "";
                    if (!string.IsNullOrEmpty(path)) _instDir = path;
                    StartInstall(mode);
                    break;
                }
                case "launch":
                    if (!_launched && _finished) {
                        try {
                            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo {
                                FileName = Path.Combine(_instDir, _exeName),
                                UseShellExecute = true,
                                Arguments = "--updated"
                            });
                            _launched = true;
                        } catch (Exception ex) { Post(MiniJson.Obj("type", "error", "msg", "启动应用失败: " + ex.Message)); }
                    }
                    Post(MiniJson.Obj("type", "close"));
                    break;
                case "minimize":
                    _win.WindowState = WindowState.Minimized;
                    break;
                case "close":
                    if (_installing && !_finished) return;
                    Shutdown(0);
                    break;
                case "drag":
                    try { _win.DragMove(); } catch { }
                    break;
            }
        }

        void Post(string json) {
            _wv?.CoreWebView2?.PostWebMessageAsJson(json);
        }

        void StartInstall(string mode) {
            _installing = true;
            if (_dev || string.IsNullOrEmpty(_setupExe) || !File.Exists(_setupExe)) {
                SimulateInstall();
                return;
            }
            try {
                // NSIS /D= 必须是最后一个参数且不加引号(路径含空格也原样);
                // /_IPC 带引号, 兼容带空格的 TEMP 路径
                string ipcFlag = " /_IPC=\"" + _workDir + "\"";
                string args = "/S" + (mode == "all" ? " /allusers" : " /currentuser") + ipcFlag + " /D=" + _instDir;
                var psi = new System.Diagnostics.ProcessStartInfo {
                    FileName = _setupExe,
                    Arguments = args,
                    UseShellExecute = true,
                    WorkingDirectory = Path.GetDirectoryName(_setupExe) ?? ""
                };
                if (mode == "all") psi.Verb = "runas";   // 点击时弹 UAC
                _child = System.Diagnostics.Process.Start(psi);
                if (_child == null) throw new Exception("安装器进程启动失败");
            } catch (System.ComponentModel.Win32Exception wex) when (wex.NativeErrorCode == 1223) {
                // 用户取消了 UAC
                _installing = false;
                Post(MiniJson.Obj("type", "error", "msg", "已取消管理员授权"));
                return;
            } catch (Exception ex) {
                _installing = false;
                Post(MiniJson.Obj("type", "error", "msg", "无法启动安装器: " + ex.Message));
                return;
            }
            StartPolling();
        }

        void StartPolling() {
            long total = TotalSize();
            _poll = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(400) };
            int tick = 0;
            _poll.Tick += (s, e) => {
                tick++;
                if (_child == null) return;
                _child.Refresh();
                bool exited = _child.HasExited;
                long size = DirSizeSafe(_instDir);
                int pct = total > 0 ? (int)Math.Min(94, size * 94 / total) : Math.Min(94, tick);
                if (!_finished) {
                    if (File.Exists(Path.Combine(_workDir, "done.flag"))) {
                        OnInstallDone();
                    } else if (exited) {
                        if (_child.ExitCode == 0) OnInstallDone();
                        else { _installing = false; Post(MiniJson.Obj("type", "error", "msg", "安装器异常退出 (代码 " + _child.ExitCode + ")")); }
                    } else {
                        string phase = File.Exists(Path.Combine(_workDir, "extract.flag")) ? "extract" : "prepare";
                        Post(MiniJson.Obj("type", "progress", "pct", pct.ToString(),
                            "phase", phase, "file", ""));
                    }
                }
            };
            _poll.Start();
        }

        void OnInstallDone() {
            if (_finished) return;
            _finished = true;
            Post(MiniJson.Obj("type", "progress", "pct", "100", "phase", "done", "file", "安装完成"));
            Post(MiniJson.Obj("type", "installed"));
            _poll?.Stop();
            CleanupWork(false);
            if (Args.Get(_launchArgs, "auto-exit", "") != null)
                BeginInvokeShutdown();
        }

        void BeginInvokeShutdown() {
            var t = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
            t.Tick += (s, e) => { t.Stop(); Shutdown(0); };
            t.Start();
        }

        // --dev 或找不到安装器本体时的演示推进
        void SimulateInstall() {
            int step = 0;
            _poll = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(80) };
            _poll.Tick += (s, e) => {
                step++;
                int pct = Math.Min(100, step * 2);
                string phase = pct < 10 ? "prepare" : pct < 90 ? "extract" : "settle";
                Post(MiniJson.Obj("type", "progress", "pct", pct.ToString(), "phase", phase, "file", ""));
                if (pct >= 100) { _poll.Stop(); _finished = true; Post(MiniJson.Obj("type", "installed")); }
            };
            _poll.Start();
        }

        static long DirSizeSafe(string dir) {
            try { return DirSize(new DirectoryInfo(dir)); } catch { return 0; }
        }
        static long DirSize(DirectoryInfo d) {
            long size = 0;
            var infos = d.EnumerateFileSystemInfos();
            foreach (var fi in infos) {
                if ((fi.Attributes & System.IO.FileAttributes.ReparsePoint) != 0) continue;
                var f = fi as FileInfo;
                if (f != null) size += f.Length;
                else {
                    try { size += DirSize(fi as DirectoryInfo); } catch { }
                }
            }
            return size;
        }

        void CleanupWork(bool deleteAll) {
            try {
                if (deleteAll && Directory.Exists(_workDir)) Directory.Delete(_workDir, true);
            } catch { }
        }

        protected override void OnExit(ExitEventArgs e) {
            try {
                if (_child != null && !_child.HasExited) {
                    // 安装中途退出 UI: 子安装器继续跑完(与抖音式一致, 半途杀安装器易留脏状态)
                }
                CleanupWork(true);
                // 打包态: 清理 stub 留下的 %TEMP%\fntv-setup-<pid> 资材目录。
                // 自身 exe 还锁着该目录, 用延迟 rd 异步删(仅认 fntv-setup- 前缀, dev 模式不命中)。
                if (!string.IsNullOrEmpty(_wwwDir)) {
                    var baseDir = Directory.GetParent(_wwwDir);
                    if (baseDir != null
                        && baseDir.Name.StartsWith("fntv-setup-", StringComparison.OrdinalIgnoreCase)
                        && baseDir.FullName.StartsWith(Path.GetTempPath(), StringComparison.OrdinalIgnoreCase)) {
                        var psi = new System.Diagnostics.ProcessStartInfo(
                            "cmd.exe", "/c ping -n 3 127.0.0.1 >nul & rd /s /q \"" + baseDir.FullName + "\"") {
                            CreateNoWindow = true,
                            UseShellExecute = false
                        };
                        System.Diagnostics.Process.Start(psi);
                    }
                }
            } catch { }
            base.OnExit(e);
        }
    }
}
