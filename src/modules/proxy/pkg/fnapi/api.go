package fnapi

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"proxy/pkg/utils"
	"sync"
	"time"

	"github.com/allegro/bigcache/v3"
)

// 全局缓存实例
var (
	globalCache *bigcache.BigCache
	cacheOnce   sync.Once
)

// initGlobalCache 初始化全局缓存
func initGlobalCache() {
	cacheOnce.Do(func() {
		config := bigcache.DefaultConfig(10 * time.Minute)
		config.Shards = 1024
		config.MaxEntriesInWindow = 1000 * 10 * 60
		config.MaxEntrySize = 500
		config.HardMaxCacheSize = 512

		var err error
		globalCache, err = bigcache.New(context.TODO(), config)
		if err != nil {
			log.Printf("初始化全局缓存失败: %v", err)
			// 如果初始化失败，使用默认配置
			globalCache, _ = bigcache.New(context.TODO(), bigcache.DefaultConfig(10*time.Minute))
		}
		log.Println("全局缓存初始化完成")
	})
}

// ApiService API服务
type ApiService struct {
	baseURL    string
	token      string
	skipVerify bool
	cookie     string // [lc-295] 会话 Cookie(Trim-MC-token 等), 由主进程经代理 URL 传入, 转发给 NAS 鉴权
	client     *http.Client
}

// NewApiService 创建API服务实例
func NewApiService(baseURL, token string, skipVerify bool, cookie string) *ApiService {
	initGlobalCache()

	// 创建HTTP客户端
	client := &http.Client{
		Timeout: time.Duration(DefaultTimeout) * time.Millisecond,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				InsecureSkipVerify: skipVerify,
			},
		},
	}

	return &ApiService{
		baseURL:    baseURL,
		token:      token,
		skipVerify: skipVerify,
		cookie:     cookie,
		client:     client,
	}
}

// GetBaseURL 获取当前API基础URL
func (s *ApiService) GetBaseURL() string {
	return s.baseURL
}

// setCache 设置缓存
func setCache(key string, value interface{}) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return globalCache.Set(key, data)
}

// getCache 获取缓存
func getCache(key string, dest interface{}) (bool, error) {
	data, err := globalCache.Get(key)
	if err != nil {
		return false, err
	}

	err = json.Unmarshal(data, dest)
	if err != nil {
		return false, err
	}
	return true, nil
}

// generateCacheKey 生成缓存键
func generateCacheKey(method, url string, params interface{}) string {
	key := fmt.Sprintf("%s:%s", method, url)
	if params != nil {
		paramsStr, _ := json.Marshal(params)
		key += ":" + string(paramsStr)
	}
	return key
}

// [lc-1004] 直链/流列表解析的并发去重（in-flight 合并）。
// 场景：起播时主进程会预热直链（把 NAS 新铸直链的 ~3s 藏进播放器启动窗口），播放器紧接着
// 又发第一个 Range 请求；两者都走到 *Cached，而缓存此刻都还是空的 —— 于是同一条直链被解析
// 两遍，NAS/网盘侧要为同一件事付两次代价（115 还要排两次 1 req/s 的队）。
// 合并后：第一个调用真去解析，其余调用等它的结果。
type flight[T any] struct {
	done chan struct{}
	v    T
	err  error
}

var (
	flightsMu sync.Mutex
	flights   = map[string]any{}
)

// doInflight 同 key 的并发调用只真跑一次 fn，其余共享其结果。
// key 需自带类型前缀（见调用处），避免不同 T 撞同一个 key。
// 返回的指针被所有等待者共享，调用方只读取、不得就地修改。
func doInflight[T any](key string, fn func() (T, error)) (T, error) {
	flightsMu.Lock()
	if e, ok := flights[key]; ok {
		if f, ok2 := e.(*flight[T]); ok2 {
			flightsMu.Unlock()
			<-f.done
			return f.v, f.err
		}
	}
	f := &flight[T]{done: make(chan struct{})}
	flights[key] = f
	flightsMu.Unlock()

	f.v, f.err = fn()

	flightsMu.Lock()
	delete(flights, key)
	flightsMu.Unlock()
	close(f.done)
	return f.v, f.err
}

// Login 用户登录
func (s *ApiService) Login(username, password string) (*ApiResponse[interface{}], error) {
	return Request[interface{}](s.client, s.baseURL, "/v/api/v1/login", MethodPOST, s.token, LoginData{
		AppName:  "trimemedia-web",
		Username: username,
		Password: password,
	}, nil, 0, 0, s.cookie)
}

// Logout 用户登出
func (s *ApiService) Logout() (*ApiResponse[interface{}], error) {
	return Request[interface{}](s.client, s.baseURL, "/v/api/v1/logout", MethodPOST, s.token, nil, nil, 0, 0, s.cookie)
}

// GetUserInfo 获取用户信息
func (s *ApiService) GetUserInfo() (*ApiResponse[UserInfo], error) {
	return Request[UserInfo](s.client, s.baseURL, "/v/api/v1/user/info", MethodGET, s.token, nil, nil, 0, 0, s.cookie)
}

// GetPlayInfo 获取视频播放信息
func (s *ApiService) GetPlayInfo(itemGUID string) (*ApiResponse[PlayInfo], error) {
	data := PlayInfoData{ItemGUID: itemGUID}
	return Request[PlayInfo](s.client, s.baseURL, "/v/api/v1/play/info", MethodPOST, s.token, data, nil, 0, 0, s.cookie)
}

// GetPlayQuality 获取播放质量列表
func (s *ApiService) GetPlayQuality(mediaGUID string) (*ApiResponse[PlayQualityResponse], error) {
	return Request[PlayQualityResponse](s.client, s.baseURL, "/v/api/v1/play/quality", MethodPOST, s.token, map[string]string{
		"media_guid": mediaGUID,
	}, nil, 0, 0, s.cookie)
}

// GetStreamList 获取流列表
func (s *ApiService) GetStreamList(itemGUID string) (*ApiResponse[StreamListResponse], error) {
	return Request[StreamListResponse](s.client, s.baseURL, fmt.Sprintf("/v/api/v1/stream/list/%s", itemGUID), MethodGET, s.token, nil, nil, 0, 0, s.cookie)
}

// GetEpisodeList 获取播放列表
func (s *ApiService) GetEpisodeList(id string) (*ApiResponse[[]PlayListItem], error) {
	return Request[[]PlayListItem](s.client, s.baseURL, fmt.Sprintf("/v/api/v1/episode/list/%s", id), MethodGET, s.token, nil, nil, 0, 0, s.cookie)
}

// GetVideoURL 获取视频直链地址
func (s *ApiService) GetVideoURL(mediaGUID string) string {
	return fmt.Sprintf("%s/v/api/v1/media/range/%s", s.baseURL, mediaGUID)
}

// SetWatched 设置视频为已观看状态
func (s *ApiService) SetWatched(itemGUID string) (*ApiResponse[interface{}], error) {
	return Request[interface{}](s.client, s.baseURL, "/v/api/v1/item/watched", MethodPOST, s.token, WatchedData{
		ItemGUID: itemGUID,
	}, nil, 0, 0, s.cookie)
}

// RecordPlayStatus 记录播放状态
func (s *ApiService) RecordPlayStatus(statusData PlayStatusData) (*ApiResponse[interface{}], error) {
	return Request[interface{}](s.client, s.baseURL, "/v/api/v1/play/record", MethodPOST, s.token, statusData, nil, 0, 0, s.cookie)
}

// GetStream 获取流信息
func (s *ApiService) GetStream(mediaGUID, ip string) (*ApiResponse[StreamResponse], error) {
	data := StreamRequestData{
		Header: Header{
			UserAgent: []string{"trim_player"},
		},
		Level:     1,
		MediaGUID: mediaGUID,
		IP:        ip,
	}
	return Request[StreamResponse](s.client, s.baseURL, "/v/api/v1/stream", MethodPOST, s.token, data, nil, 0, 0, s.cookie)
}

// SetSkipInfo 设置跳过片头片尾信息
func (s *ApiService) SetSkipInfo(parentGuid string, skipStart, skipEnd int) error {
	data := SetSkipInfoReq{
		ParentGuid: parentGuid,
		SkipStart:  skipStart,
		SkipEnd:    skipEnd,
	}
	resp, err := Request[any](s.client, s.baseURL, "/v/api/v1/play/setConfigByItem", MethodPOST, s.token, data, nil, 0, 0, s.cookie)
	if err != nil {
		return err
	}
	if !resp.Success {
		return fmt.Errorf("设置跳过片头片尾信息失败: %s", resp.Message)
	}
	return nil
}

// GetUserInfoCached 获取用户信息（带缓存）
func (s *ApiService) GetUserInfoCached() (*ApiResponse[UserInfo], error) {
	cacheKey := generateCacheKey("GET", "/v/api/v1/user/info", nil)
	var cachedResp ApiResponse[UserInfo]
	if exists, err := getCache(cacheKey, &cachedResp); exists && err == nil {
		return &cachedResp, nil
	}

	resp, err := s.GetUserInfo()
	if err == nil && resp.Success {
		setCache(cacheKey, resp)
	}
	return resp, err
}

// GetPlayInfoCached 获取视频播放信息（带缓存）
func (s *ApiService) GetPlayInfoCached(itemGUID string) (*ApiResponse[PlayInfo], error) {
	cacheKey := generateCacheKey("POST", "/v/api/v1/play/info", PlayInfoData{ItemGUID: itemGUID})
	var cachedResp ApiResponse[PlayInfo]
	if exists, err := getCache(cacheKey, &cachedResp); exists && err == nil {
		return &cachedResp, nil
	}

	resp, err := s.GetPlayInfo(itemGUID)
	if err == nil && resp.Success {
		setCache(cacheKey, resp)
	}
	return resp, err
}

// GetPlayQualityCached 获取播放质量列表（带缓存）
func (s *ApiService) GetPlayQualityCached(mediaGUID string) (*ApiResponse[PlayQualityResponse], error) {
	cacheKey := generateCacheKey("POST", "/v/api/v1/play/quality", map[string]string{"media_guid": mediaGUID})
	var cachedResp ApiResponse[PlayQualityResponse]
	if exists, err := getCache(cacheKey, &cachedResp); exists && err == nil {
		return &cachedResp, nil
	}

	resp, err := s.GetPlayQuality(mediaGUID)
	if err == nil && resp.Success {
		setCache(cacheKey, resp)
	}
	return resp, err
}

// GetStreamListCached 获取流列表（带缓存 + 并发去重）
func (s *ApiService) GetStreamListCached(itemGUID string) (*ApiResponse[StreamListResponse], error) {
	cacheKey := generateCacheKey("GET", fmt.Sprintf("/v/api/v1/stream/list/%s", itemGUID), nil)
	var cachedResp ApiResponse[StreamListResponse]
	if exists, err := getCache(cacheKey, &cachedResp); exists && err == nil {
		return &cachedResp, nil
	}

	return doInflight("list:"+cacheKey, func() (*ApiResponse[StreamListResponse], error) {
		resp, err := s.GetStreamList(itemGUID)
		if err == nil && resp.Success {
			setCache(cacheKey, resp)
		}
		return resp, err
	})
}

// streamCacheKey 计算 GetStreamCached 使用的缓存键（抽出来供 HasStreamCached 复用）
func streamCacheKey(mediaGUID, account string) string {
	data := StreamRequestData{
		Header: Header{
			UserAgent: []string{"trim_player"},
		},
		Level:     1,
		MediaGUID: mediaGUID,
		IP:        utils.StringToUUID(account),
	}
	return generateCacheKey("POST", "/v/api/v1/stream", data)
}

// HasStreamCached 报告 (mediaGUID, account) 的直链是否已在缓存中。
// [lc-1004] 用途：115 的 1 req/s 限速本意是防止**解析直链**触发风控，但它原先被放在
// 每个 HTTP 请求（含播放器的每个 Range/续传/拖动请求）前面，导致 115 源每次拖动都白等 1s。
// 调用方据此判断「本次是否真的要去 fnOS 重新解析」，只在真解析时付这个代价。
func (s *ApiService) HasStreamCached(mediaGUID, account string) bool {
	var cachedResp ApiResponse[StreamResponse]
	exists, err := getCache(streamCacheKey(mediaGUID, account), &cachedResp)
	return exists && err == nil
}

// GetStreamCached 获取流信息（带缓存 + 并发去重）
func (s *ApiService) GetStreamCached(mediaGUID, account string) (*ApiResponse[StreamResponse], error) {
	ip := utils.StringToUUID(account)
	cacheKey := streamCacheKey(mediaGUID, account)
	var cachedResp ApiResponse[StreamResponse]
	if exists, err := getCache(cacheKey, &cachedResp); exists && err == nil {
		return &cachedResp, nil
	}

	return doInflight("stream:"+cacheKey, func() (*ApiResponse[StreamResponse], error) {
		resp, err := s.GetStream(mediaGUID, ip)
		if err == nil && resp.Success {
			setCache(cacheKey, resp)
		}
		return resp, err
	})
}

// IsStreamInflight 报告 (mediaGUID, account) 的直链此刻是否正在被别的请求解析。
// [lc-1004] 与 HasStreamCached 搭配：两者都为 false 才说明本次真的会触发一次新解析，
// 115 的 1 req/s 限速只该在那时排队。起播预热已在解析时，播放器的首个请求只是搭便车等结果，
// 再排一次队纯属白等 1s。
func IsStreamInflight(mediaGUID, account string) bool {
	key := "stream:" + streamCacheKey(mediaGUID, account)
	flightsMu.Lock()
	defer flightsMu.Unlock()
	_, ok := flights[key]
	return ok
}
