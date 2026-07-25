package api

import (
	"net/http"
	"os"
	"path/filepath"
	"regexp"

	"proxy/pkg/logger"

	"github.com/gin-gonic/gin"
)

// 仅允许 bili_<16位hex>_<集数>.ass 形式的文件名，防止路径遍历攻击
var danmakuFileRe = regexp.MustCompile(`^bili_[a-f0-9]{16}_\d+\.ass$`)

// ServeDanmakuHandler 把缓存在 %TEMP%/fnos-danmaku/ 下的弹幕 ASS 通过 HTTP 吐出，
// 让 PotPlayer 能以「HTTP 字幕」方式挂载——与视频（同为 127.0.0.1:22346 的 HTTP 流）同源，
// 规避「PotPlayer 对 HTTP 流不加载本地 /sub 文件」的已知坑。
func ServeDanmakuHandler(c *gin.Context) {
	file := c.Param("file")
	if !danmakuFileRe.MatchString(file) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid filename"})
		return
	}
	baseDir := filepath.Join(os.TempDir(), "fnos-danmaku")
	full := filepath.Join(baseDir, file)
	// 二次防御：解析后必须仍在目标目录内（path traversal 防护）
	if filepath.Clean(filepath.Dir(full)) != filepath.Clean(baseDir) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid path"})
		return
	}
	data, err := os.ReadFile(full)
	if err != nil {
		logger.Warnf("弹幕文件读取失败: %s, %v", full, err)
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	c.Header("Access-Control-Allow-Origin", "*")
	c.Data(http.StatusOK, "application/octet-stream", data)
}
