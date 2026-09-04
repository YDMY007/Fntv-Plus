package logger

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

// 日志级别
type LogLevel int

const (
	DEBUG LogLevel = iota
	INFO
	WARN
	ERROR
	FATAL
)

// 日志级别字符串映射
var levelStrings = map[LogLevel]string{
	DEBUG: "DEBUG",
	INFO:  "INFO",
	WARN:  "WARN",
	ERROR: "ERROR",
	FATAL: "FATAL",
}

// 日志级别颜色映射 (ANSI 颜色代码)
var levelColors = map[LogLevel]string{
	DEBUG: "\033[36m", // 青色
	INFO:  "\033[32m", // 绿色
	WARN:  "\033[33m", // 黄色
	ERROR: "\033[31m", // 红色
	FATAL: "\033[35m", // 紫色
}

const resetColor = "\033[0m"

// asyncQueueCap 后台日志队列容量。
const asyncQueueCap = 4096

// asyncWriter 把实际写入转移到单个后台 goroutine；队列满时**丢弃该行**而不是阻塞调用方。
//
// [lc-1004] 为什么必须异步：本进程的 stdout 是被 Electron 主进程用管道读取的。主进程忙时
// （启动阶段插件初始化、渲染进程日志洪水、日志文件轮转）管道消费停滞，libuv 管道缓冲
// （Windows 默认 64KB）填满后，Go 的同步写会一直阻塞。原先的实现在 l.mu 锁内同步写，
// 于是**所有 goroutine 全部卡在日志锁上** —— 整个代理停止服务，且因为主进程要等事件循环
// 空闲才消费管道而**永不自愈**。实测：连续请求到第 43 发（累积 116KB 日志）起全部 hang，
// 客户端读到 0 字节，而端口仍在监听、进程仍活着；一旦开始排空管道，立刻恢复 ~300ms。
// 日志属于可丢弃的诊断信息，绝不能反过来阻塞视频流转发。
type asyncWriter struct {
	dstMu   sync.Mutex
	dst     io.Writer
	ch      chan []byte
	dropped uint64
}

func newAsyncWriter(dst io.Writer) *asyncWriter {
	w := &asyncWriter{dst: dst, ch: make(chan []byte, asyncQueueCap)}
	go w.run()
	return w
}

func (w *asyncWriter) run() {
	var lastNotice time.Time
	for b := range w.ch {
		w.dstMu.Lock()
		d := w.dst
		w.dstMu.Unlock()
		_, _ = d.Write(b)

		// 丢弃过就告知一次（限频 5s），便于事后判断日志是否完整
		if n := atomic.SwapUint64(&w.dropped, 0); n > 0 && time.Since(lastNotice) > 5*time.Second {
			lastNotice = time.Now()
			_, _ = d.Write([]byte(fmt.Sprintf(
				"[logger] 日志队列已满，丢弃了约 %d 行（消费端过慢，已自动降级为丢弃而非阻塞业务）\n", n)))
		}
	}
}

// Write 实现 io.Writer：拷贝一份后投递到后台队列，队列满立即丢弃并返回成功。
// log.Logger 会复用内部 buffer，故必须拷贝。
func (w *asyncWriter) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	b := make([]byte, len(p))
	copy(b, p)
	select {
	case w.ch <- b:
	default:
		atomic.AddUint64(&w.dropped, 1)
	}
	return len(p), nil
}

func (w *asyncWriter) setDst(d io.Writer) {
	w.dstMu.Lock()
	w.dst = d
	w.dstMu.Unlock()
}

// flush 尽力排空队列（FATAL 退出、进程收尾时用）。写端若被管道堵住则到点放弃。
func (w *asyncWriter) flush(timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for len(w.ch) > 0 {
		if time.Now().After(deadline) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	// 队尾那条可能刚被取出、仍在写
	time.Sleep(20 * time.Millisecond)
}

// Logger 结构体
type Logger struct {
	minLevel   LogLevel
	logger     *log.Logger
	file       *os.File
	color      bool
	callerInfo bool
	mu         sync.Mutex // 保护以上配置字段
	out        *asyncWriter
}

// 全局默认日志实例
var std = NewLogger(INFO, os.Stdout)

// 创建新日志实例
func NewLogger(level LogLevel, out io.Writer) *Logger {
	aw := newAsyncWriter(out)
	return &Logger{
		minLevel:   level,
		logger:     log.New(aw, "", 0),
		color:      false,
		callerInfo: true,
		out:        aw,
	}
}

// Stdout 返回全局日志的异步写入口。
// gin 的 Logger/Recovery 中间件默认同步写 os.Stdout（gin.DefaultWriter），同样会被管道背压
// 卡死，必须改接到这个异步管道上（见 register.go）。
func Stdout() io.Writer {
	return std.out
}

// Flush 尽力把队列里的日志写完。
func Flush() {
	std.out.flush(2 * time.Second)
}

// 设置全局日志级别
func SetLevel(level LogLevel) {
	std.mu.Lock()
	defer std.mu.Unlock()
	std.minLevel = level
}

// 获取当前日志级别
func GetLevel() LogLevel {
	std.mu.Lock()
	defer std.mu.Unlock()
	return std.minLevel
}

// 启用/禁用颜色输出
func SetColor(enabled bool) {
	std.mu.Lock()
	defer std.mu.Unlock()
	std.color = enabled
}

// 启用/禁用调用者信息
func SetCallerInfo(enabled bool) {
	std.mu.Lock()
	defer std.mu.Unlock()
	std.callerInfo = enabled
}

// 设置日志输出文件
func SetLogFile(filename string) error {
	std.mu.Lock()
	defer std.mu.Unlock()

	// 关闭旧文件
	if std.file != nil {
		std.file.Close()
	}

	// 创建目录
	dir := filepath.Dir(filename)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	// 打开文件
	file, err := os.OpenFile(filename, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0666)
	if err != nil {
		return err
	}

	// 设置输出到文件和控制台
	std.out.setDst(io.MultiWriter(os.Stdout, file))
	std.file = file
	return nil
}

// 关闭日志文件
func CloseLogFile() {
	std.mu.Lock()
	defer std.mu.Unlock()
	if std.file != nil {
		std.file.Close()
		std.file = nil
		std.out.setDst(os.Stdout)
	}
}

// 获取调用者信息
func (l *Logger) getCallerInfo() string {
	if !l.callerInfo {
		return ""
	}

	_, file, line, ok := runtime.Caller(3) // 跳过3层调用栈
	if !ok {
		return ""
	}

	// 只保留文件名
	return fmt.Sprintf("%s:%d", filepath.Base(file), line)
}

// 日志输出核心方法
func (l *Logger) log(level LogLevel, format string, args ...interface{}) {
	if level < l.minLevel {
		return
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	// 构建日志前缀
	now := time.Now().Format("2006-01-02 15:04:05.000")
	levelStr := levelStrings[level]
	callerInfo := l.getCallerInfo()

	// 构建日志消息
	message := fmt.Sprintf(format, args...)

	// 添加颜色
	if l.color && (os.Getenv("TERM") != "dumb") {
		color := levelColors[level]
		if callerInfo != "" {
			l.logger.Printf("%s %s%-5s%s [%s] %s",
				now, color, levelStr, resetColor, callerInfo, message)
		} else {
			l.logger.Printf("%s %s%-5s%s %s",
				now, color, levelStr, resetColor, message)
		}
	} else {
		if callerInfo != "" {
			l.logger.Printf("%s %-5s [%s] %s",
				now, levelStr, callerInfo, message)
		} else {
			l.logger.Printf("%s %-5s %s",
				now, levelStr, message)
		}
	}

	// FATAL 级别退出程序（先把日志排空，否则退出原因会丢在队列里）
	if level == FATAL {
		l.out.flush(2 * time.Second)
		os.Exit(1)
	}
}

// =============== 全局日志函数 ===============

func Debugf(format string, args ...interface{}) {
	std.log(DEBUG, format, args...)
}

func Infof(format string, args ...interface{}) {
	std.log(INFO, format, args...)
}

func Warnf(format string, args ...interface{}) {
	std.log(WARN, format, args...)
}

func Errorf(format string, args ...interface{}) {
	std.log(ERROR, format, args...)
}

func Fatalf(format string, args ...interface{}) {
	std.log(FATAL, format, args...)
}

// 简单日志函数 (无格式化)
func Debug(args ...interface{}) {
	std.log(DEBUG, "%s", fmt.Sprint(args...))
}

func Info(args ...interface{}) {
	std.log(INFO, "%s", fmt.Sprint(args...))
}

func Warn(args ...interface{}) {
	std.log(WARN, "%s", fmt.Sprint(args...))
}

func Error(args ...interface{}) {
	std.log(ERROR, "%s", fmt.Sprint(args...))
}

func Fatal(args ...interface{}) {
	std.log(FATAL, "%s", fmt.Sprint(args...))
}
