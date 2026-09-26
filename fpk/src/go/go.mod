module fntvplus

go 1.23

// 纯标准库实现，零外部依赖 —— 交叉编译为单二进制即可在 fnOS 上运行。
// 交叉编译：
//   GOOS=linux GOARCH=amd64 go build -o app/server/fntvplus ./cmd/fntvplus
//   GOOS=linux GOARCH=arm64 go build -o app/server/fntvplus-arm64 ./cmd/fntvplus
