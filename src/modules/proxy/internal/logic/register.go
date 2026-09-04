package logic

import (
	"proxy/internal/logic/api"
	"proxy/pkg/logger"

	"github.com/gin-gonic/gin"
)

// RunApiServer 启动 API 服务器
func RunApiServer(addr string) error {
	gin.SetMode(gin.ReleaseMode)
	// [lc-1004] gin 的 Logger/Recovery 中间件默认同步写 os.Stdout，会被 Electron 主进程的
	// 管道背压卡死（主进程忙时 libuv 管道 64KB 填满 → 同步写阻塞 → 全部 goroutine 停摆）。
	// 改接到 logger 的异步非阻塞管道，与本包其它日志共用同一套「满则丢弃」策略。
	gin.DefaultWriter = logger.Stdout()
	gin.DefaultErrorWriter = logger.Stdout()
	r := gin.Default()

	r.GET("/api/v1/playvideo/:itemGuid", api.PlayVideoHandler)
	r.GET("/api/v1/skipinfo/:itemGuid", api.GetSkipInfoHandler)
	r.POST("/api/v1/skipinfo", api.SetSkipInfoHandler)
	r.GET("/api/v1/danmaku/:file", api.ServeDanmakuHandler)

	// 404 路由
	r.NoRoute(func(c *gin.Context) {
		logger.Warnf("收到404请求: %s %s", c.Request.Method, c.Request.URL.Path)
		c.JSON(404, gin.H{"error": "Not Found"})
	})

	logger.Infof("服务器启动在:%s", addr)

	err := r.Run(addr)
	if err != nil {
		return err
	}

	return nil
}
