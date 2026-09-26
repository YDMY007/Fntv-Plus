// Package gateway —— 飞牛统一网关身份中间件。
//
// fnOS 统一网关把 /app/<appname>/* 请求转发到应用的 Unix socket 前会校验 NAS
// 登录态，并在转发头中注入用户身份（官方文档约定）：
//
//	X-Trim-Userid: 1000
//	X-Trim-Isadmin: true
//	X-Trim-Username: admin
//
// 本包提供 RequireGatewayUser 中间件：没有网关身份头的请求一律 401。
// 走网关的流量必然带头；伪造头需先攻破同机网关，回环 TCP（仅 127.0.0.1）
// 上直连的未授权请求则被挡在门外。
package gateway

import (
	"net/http"
	"strings"
)

// User 是网关注入的请求方身份。
type User struct {
	UID     string
	IsAdmin bool
	Name    string
}

// FromContext-free 提取：直接从请求头读取（本应用无跨中间件传递需求）。
func FromRequest(r *http.Request) User {
	return User{
		UID:     r.Header.Get("X-Trim-Userid"),
		IsAdmin: strings.EqualFold(r.Header.Get("X-Trim-Isadmin"), "true"),
		Name:    r.Header.Get("X-Trim-Username"),
	}
}

// Authenticated 判断身份是否可信（网关转发必带 Userid；Username 兜底）。
func (u User) Authenticated() bool {
	return strings.TrimSpace(u.UID) != "" || strings.TrimSpace(u.Name) != ""
}

// RequireGatewayUser 要求请求携带统一网关注入的身份头，否则 401。
func RequireGatewayUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !FromRequest(r).Authenticated() {
			http.Error(w, "unauthorized: gateway identity required", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
