// Package secret —— builtin.go：内置第三方凭证的密文常量。
//
// 明文由 cmd/secrettmp 生成（密钥 = Derive("dandanplay-builtin-v1")，与运行时一致），
// 生成后只提交密文，明文不进仓库、不进二进制、不进日志。
//
// 弹弹play 开放平台（https://doc.dandanplay.com/open/）签名模式：
//
//	X-Signature = base64(sha256(AppId + Timestamp + Path + AppSecret))
//
// 两个 Secret 均可用：主 Secret 失效（轮换/封禁）时自动尝试备用，无需重新打包。
package secret

// builtinDandanplayAppID 内置弹弹play AppId（密文）。
var builtinDandanplayAppID = "enc:v1:yOyM32FRf8Ea5v8Qacdbw2x6vXTu9GXgrflHDReyrKAh9Ka/6qs="

// builtinDandanplaySecrets 内置弹弹play 应用密钥（密文，按优先级排列，失败自动顺延）。
var builtinDandanplaySecrets = []string{
	"enc:v1:Rv477mGixVH6joM+3XTurAhxR3D0BgraDAzNn2BDcdRUD4Va51T2PeGb4CVGeEc70d31KQ04dCvBb295",
	"enc:v1:wJOKsZapnYka0sdwwC0m3KtIaAfXqieG/kuQR4lExX6tVCFOKeRqg5C8as5oI5Q3ZCEnDW+Gl+7RVCmj",
}
