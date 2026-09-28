local msg = require('mp.msg')
local utils = require("mp.utils")

local function extract_url(url)
    local path = url:match("^https?://[^/]+(/[^%?]*)")
    return path
end

-- ===== [lc-1226] 弹弹play 开放 API 内置凭证 =====
-- 官方文档：https://doc.dandanplay.com/open/
--   签名 = base64(sha256(AppId + Timestamp + Path + AppSecret))；Path 取域名后、不含查询串的路径。
--   请求头 X-AppId / X-Timestamp / X-Signature。凭证模式（X-AppSecret）只推荐服务端用。
-- AppId 与 Secret 都以 AES-256-ECB 密文内嵌在此（密钥即 main.lua 的 KEY），运行时解密使用。
-- 不落明文的原因：本文件既被 git 跟踪、又随安装包分发到每台用户机器，明文等于公开传播。
-- ⚠️ 内置凭证是【兜底】：仅当用户没配自定义凭证时才用（见 dd_credentials）。
-- ⚠️ [lc-1228] 固定只用 1 号密钥，不做自动轮换（自动切换会被视为绕过官方处置）；
--    需要换密钥时由维护者手动替换下面的密文，用户无感知。
local BUILTIN_APPID_B64 = "ywOH0hrmLAPXgUVlwumuzg=="
local BUILTIN_SECRETS_B64 = {
    "bwlyxWbVRl9YSc3WIV08SkFUTR+wNtttVe66x4kfTBE=",
    "lsEbThojhb40A7Qe8V+a3InMY4ndPY1QB2h4FUL8KiY=",
}
local builtin_appid, builtin_secrets = nil, nil
local active_secret_idx = 1

local function trim_ws(s)
    return tostring(s or ""):match("^%s*(.-)%s*$")
end

-- 解开设置面板写入的 AES-256-ECB 密文（base64）。密钥同 main.lua 的 KEY。
-- 解不开时返回 nil，由调用方回落内置凭证，绝不因一条坏配置让整条弹幕链路崩掉。
-- base64 解码本身也要进 pcall：它对非法字符会直接抛错，放在 pcall 外面就等于没防住。
local function dd_decrypt_conf(blob)
    local b = trim_ws(blob)
    if b == "" then
        return nil
    end
    local ok, decoded = pcall(Base64.decode, b)
    if not ok or type(decoded) ~= 'string' or #decoded == 0 then
        msg.warn("弹弹play 自定义凭证密文非法（base64 解码失败），回落内置凭证")
        return nil
    end
    local ok2, plain = pcall(AES.ECB.decrypt, KEY, decoded)
    if not ok2 or type(plain) ~= 'string' then
        msg.warn("弹弹play 自定义凭证解密失败，回落内置凭证")
        return nil
    end
    plain = trim_ws(plain)
    -- 合理性校验：解错密钥时通常得到一串乱码/控制字符。用它当凭证签出来的名必然被官方拒，
    -- 又不能轮换（自定义凭证不参与内置轮换），会把原本可用的内置凭证顶掉 —— 那就等于配置一坏
    -- 弹幕全废。故要求「长度像样且全为可打印 ASCII」，否则视为不可信、回落内置。
    -- 用「可打印」而不是具体字符白名单：官方 AppId/Secret 是纯字母数字，但白名单太窄会误伤
    -- 用户手上可能存在的其它合法形态凭证，而控制字符这一条已足以识别解错密钥的乱码。
    if #plain < 4 or #plain > 128 or plain:find("[^%g%s]") then
        msg.warn("弹弹play 自定义凭证解密结果不可信，回落内置凭证")
        return nil
    end
    return plain
end

-- 解密内置凭证（幂等：成功解出后缓存，后续调用零开销）
local function load_builtin_credentials()
    if builtin_appid and builtin_secrets and #builtin_secrets > 0 then
        return true
    end
    local ok, appid = pcall(AES.ECB.decrypt, KEY, Base64.decode(BUILTIN_APPID_B64))
    if not ok or type(appid) ~= 'string' or trim_ws(appid) == '' then
        msg.error("弹弹play 内置凭证：AppId 解密失败")
        return false
    end
    local secrets = {}
    for _, blob in ipairs(BUILTIN_SECRETS_B64) do
        local ok2, s = pcall(AES.ECB.decrypt, KEY, Base64.decode(blob))
        if ok2 and type(s) == 'string' and trim_ws(s) ~= '' then
            secrets[#secrets + 1] = trim_ws(s)
        end
    end
    if #secrets == 0 then
        msg.error("弹弹play 内置凭证：Secret 解密失败")
        return false
    end
    builtin_appid, builtin_secrets = trim_ws(appid), secrets
    return true
end

-- 用户在设置面板填的专属凭证（存的是 AES 密文，见 options.lua 的 *_enc 键）。
-- 兼容旧的明文键：老版本 conf 里可能还留着 dandanplay_app_id/secret，读得到就照用
-- （下一次应用启动同步会把它清掉换成密文键）。
-- 不缓存：每次调用重新解一次密（AES 解 32 字节的开销可忽略），换取「配置改动立即可见」，
-- 避免缓存把同一次 mpv 会话里后来的配置变更挡成静默失效。
local function dd_custom_credentials()
    local id = dd_decrypt_conf(options.dandanplay_app_id_enc)
    local secret = dd_decrypt_conf(options.dandanplay_app_secret_enc)
    if not id or not secret then
        id = trim_ws(options.dandanplay_app_id)
        secret = trim_ws(options.dandanplay_app_secret)
        if id == "" or secret == "" then
            id, secret = nil, nil
        end
    end
    return id, secret
end

local function dd_using_custom()
    local id, secret = dd_custom_credentials()
    return id ~= nil and secret ~= nil
end

-- 当前生效的凭证 → appId, secret, is_custom
local function dd_credentials()
    local cid, csecret = dd_custom_credentials()
    if cid and csecret then
        return cid, csecret, true
    end
    if load_builtin_credentials() then
        local s = builtin_secrets[active_secret_idx] or builtin_secrets[1]
        return builtin_appid, s, false
    end
    return nil, nil, false
end

-- [lc-1228] 内置 Secret 被官方拒绝（403）时的处理：只报警、不自动切换。
-- 曾经实现为「403 就自动切到另一枚」——已移除：官方发两枚 Secret 是给开发者【主动轮换】用的，
-- 若密钥被封是出于滥用判定，自动切换等于绕过官方处置，与「禁止滥用 API」的精神相悖；
-- 且自动来回切会掩盖真实状态（用户/维护者看不出凭证已被拒）。
-- 现在固定只用 1 号密钥，直至维护者手动更换内嵌密文（见 BUILTIN_SECRETS_B64）。

-- 403 报警（只报一次，避免每个请求刷屏）。这是密钥失效的唯一提示渠道：
-- Lua 侧日志会经 mpv.log 转发进 app.log，维护者据此决定是否手动轮换。
local dd_403_warned = false
local function dd_warn_403()
    if dd_403_warned then return end
    dd_403_warned = true
    local which = dd_using_custom() and "自定义凭证" or ("内置密钥 " .. tostring(active_secret_idx))
    msg.error(("弹弹play 返回 403（%s 被官方拒绝）：弹幕将不可用，请到开放平台检查应用状态；" ..
        "内置凭证需轮换时改 BUILTIN_SECRETS_B64 密文（不再自动切换）"):format(which))
end

-- 按官方算法签名，生成鉴权请求头（-H key / value 交替的三对）。
-- 无可用凭证时返回空表：请求照发，官方回 403，由上层决定是否重试。
local function dd_auth_headers(url)
    local url_path = extract_url(url)
    if not url_path then
        return {}
    end
    local appid, secret = dd_credentials()
    if not appid or not secret then
        msg.warn("弹弹play 凭证不可用（内置解密失败且未配置自定义凭证），本次请求无签名，官方将返回 403")
        return {}
    end
    local time = os.time()
    local hash = Sha256(appid .. time .. url_path .. secret)
    return {
        '-H', string.format('X-AppId: %s', appid),
        '-H', string.format('X-Signature: %s', Base64.encode(hex_to_bin(hash))),
        '-H', string.format('X-Timestamp: %s', time),
    }
end

-- 往已构造好的 curl 参数尾部追加鉴权头（调用方随后再插入 url，故顺序正确）
local function append_dandanplay_auth(args, url)
    for _, v in ipairs(dd_auth_headers(url)) do
        args[#args + 1] = v
    end
end

-- 给 args 追加 `-w` 状态码标记（插在 url 之前），以便从 stdout 尾部取回 HTTP 状态。
-- 只有在判断 403 时才需要状态码：curl 无 --fail 时 403 也返回退出码 0，光看退出码分不出
-- 「密钥失效」和「正常拿到了空弹幕」。
local DD_HTTP_MARK = "__DDHTTP__"
local function dd_args_with_status(args)
    local out = {}
    for i = 1, #args - 1 do
        out[i] = args[i]
    end
    out[#args] = '-w'
    out[#args + 1] = "\n" .. DD_HTTP_MARK .. "%{http_code}"
    out[#args + 2] = args[#args]
    return out
end

-- 从带状态码标记的输出里拆出 (body, status)。无标记时按原样当 body 返回。
local function dd_split_status(out)
    if type(out) ~= 'string' then
        return out, nil
    end
    local body, code = out:match("^(.-)\n" .. DD_HTTP_MARK .. "(%d+)%s*$")
    if body then
        return body, tonumber(code)
    end
    return out, nil
end

-- 异步请求（等价 call_cmd_async(args, callback) 的 drop-in 替换），带 403 检测与报警。
-- [lc-1228] 不再自动重试/换密钥：403 只报警一次，请求结果照常交给上层
-- （上层把空弹幕当「未命中」，走既有的降级链）。
local function dd_fetch(args, callback)
    call_cmd_async(dd_args_with_status(args), function(error, out)
        if error then
            callback(error, {})
            return
        end
        local body, status = dd_split_status(out)
        if status == 403 then
            dd_warn_403()
        end
        callback(nil, body)
    end)
end

-- 同步请求（供 menu.lua 这类用 mp.command_native 的调用点）。
-- (body, status, res)：res 为原始 subprocess 结果（调用方判断退出码/stderr）。
-- [lc-1258] 必须为全局：menu.lua 与本文件不共享作用域，lc-1226/1228 加入调用点后
--   本函数仍是 local → menu.lua 取到 nil → 「输入番剧名搜索」直接 Lua error 崩溃
--   （表现为搜索菜单卡在「加载数据中...」）。同文件其它被 menu.lua 消费的函数（match_*/fetch_*）
--   都是全局风格，此处统一。
function dd_request_sync(args)
    local res = mp.command_native({
        name = 'subprocess', capture_stdout = true, capture_stderr = true,
        args = dd_args_with_status(args),
    })
    if type(res) ~= 'table' or res.status ~= 0 then
        return nil, nil, res
    end
    local body, status = dd_split_status(res.stdout or '')
    if status == 403 then
        dd_warn_403()
    end
    return body, status, res
end

-- ===== [lc-1228] 内置凭证降级 + 本地弹幕文件复用 =====
-- 合规背景（https://doc.dandanplay.com/open/ 使用约定）：
--   「请缓存 API 返回的数据，以减少对服务器的请求次数」「请结合用户的实际操作调用 API，并按需使用」。
-- 两条措施：
--   ① 内置凭证降级——/comment（弹幕库，单次几百 KB，是流量大头）推迟到「自建源 + 内置 B站」
--      都拿不到弹幕时才发；/match（识别剧集，几 KB）照常，因为另外两个源正靠它给出的规范番名搜索。
--      用户填了自定义凭证时完全不干预（那是他自己的配额，且他要的就是弹弹play 弹幕库）。
--   ② 本地缓存复用——弹幕库按 episodeId 落盘，重播同一集直接读盘，一次 /comment 只发一次。
-- 缓存文件用固定命名且【不注册进 DANMAKU.sources】，这样 render.lua 换片时的清理循环
-- （只删 sources 里登记的文件）不会把它删掉，重播才能命中。

-- 弹幕库 URL。集中构造：DANMAKU.sources 以这个 URL 为键，缓存命中路径与请求路径
-- 必须给出完全一致的字符串，否则会被当成两个不同的源而重复加载。
local function dd_comment_url(episodeId)
    return options.api_server .. "/api/v2/comment/" .. tostring(episodeId) .. "?withRelated=false&chConvert=0"
end

-- 缓存文件路径：按 episodeId 稳定命名（与 PID/DANMAKU.count 无关，故可跨进程复用）
local function dd_cache_path(episodeId)
    return utils.join_path(DANMAKU_PATH, "dandanplay_" .. tostring(episodeId) .. ".json")
end

-- 二进制拷贝（缓存 → 工作文件）。用 rb/wb 避免 Windows 下 CRLF 被改写。
local function dd_copy_file(src, dst)
    local i = io.open(normalize(src), "rb")
    if not i then return false end
    local data = i:read("*a")
    i:close()
    if not data or #data == 0 then return false end
    local o = io.open(normalize(dst), "wb")
    if not o then return false end
    o:write(data)
    o:close()
    return true
end

-- 缓存条数上限（超出按修改时间删最旧）。单集缓存约几百 KB，上限 300 ≈ 数十 MB 量级。
local DD_CACHE_MAX = 300

-- 清理过量的缓存文件（保留最近 DD_CACHE_MAX 个），避免弹幕目录无限膨胀。
local function dd_prune_cache()
    local ok, items = pcall(utils.readdir, DANMAKU_PATH, "files")
    if not ok or type(items) ~= "table" then return end
    local files = {}
    for _, name in ipairs(items) do
        if type(name) == "string" and name:match("^dandanplay_%d+%.json$") then
            local p = utils.join_path(DANMAKU_PATH, name)
            local info = utils.file_info(p)
            files[#files + 1] = { path = p, mtime = (info and info.mtime) or 0 }
        end
    end
    if #files <= DD_CACHE_MAX then return end
    table.sort(files, function(a, b) return a.mtime < b.mtime end)
    for i = 1, #files - DD_CACHE_MAX do
        os.remove(files[i].path)
    end
    msg.info(("弹弹play 缓存清理：%d → %d 个"):format(#files, DD_CACHE_MAX))
end

-- [lc-1260] 缓存条数：弹弹play 缓存是 JSON 数组，每条形如 {"c":"...","m":"..."}。
-- 数顶层对象个数（"\"c\":" 每条恰好一次，且只出现在条目内）即弹幕条数，比完整解析便宜得多。
local function dd_cache_count(path)
    local f = io.open(normalize(path), "rb")
    if not f then return -1 end
    local data = f:read("*a")
    f:close()
    if not data or data == "" then return -1 end
    local n = 0
    for _ in data:gmatch('"c":') do n = n + 1 end
    return n
end

-- [lc-1260] 缓存复用的条数闸门：缓存弹幕少于该值时视为「上次没取到足够弹幕」（多为源侧瞬时
-- 失败或被限流后落下的残缺结果），每次重新拉取；达到该值才复用旧弹幕、跳过 /comment。
-- 语义与 aggregate_threshold 同量级（用户熟悉的「弹幕够不够多」口径）。
function dd_min_cache_count()
    local v = tonumber(options.dd_cache_min_count)
    if v == nil then return 1500 end
    return v
end

-- 把已落盘的工作文件复制一份成稳定命名的缓存（供下次重播复用）。
-- [lc-1260] 写入端不设闸门：缓存始终落盘（哪怕本次条数偏少）——是否复用由读取端
-- dd_try_use_cache 按条数闸门决定（少于 dd_cache_min_count 则重拉，够多则直接复用）。
-- 这样「重拉了但这次仍不多」时下次仍能复用已有缓存，不会因不写盘而每次都白跑请求。
local function dd_write_cache(episodeId, url)
    local src = DANMAKU.sources[url] and DANMAKU.sources[url].fname
    if not src or not file_exists(src) then return end
    if dd_copy_file(src, dd_cache_path(episodeId)) then
        msg.info(("弹弹play 弹幕已缓存 %d 条（重播同集不再请求 /comment）: %s")
            :format(dd_cache_count(src), dd_cache_path(episodeId)))
        dd_prune_cache()
    end
end

-- 命中本地缓存 → 复制成工作文件并注册为弹幕源；返回 true 表示调用方无需再发 /comment。
-- [lc-1260] 复用前先过条数闸门：不足 dd_cache_min_count 条则不用旧缓存，改为重新拉取。
-- force=true 时跳过闸门（同会话去重路径专用：本集本次已拉过，宁可复用少弹幕也不再耗 API 配额）。
local function dd_try_use_cache(episodeId, url, from_menu, force)
    local cache = dd_cache_path(episodeId)
    if not file_exists(cache) then return false end
    local n = dd_cache_count(cache)
    local minCount = dd_min_cache_count()
    if not force and minCount > 0 and (n < 0 or n < minCount) then
        msg.info(("弹弹play 缓存仅 %d 条（阈值 %d）→ 不复用，重新拉取: %s")
            :format(n, minCount, cache))
        return false
    end
    local danmaku_file = utils.join_path(DANMAKU_PATH, "danmaku-" .. PID .. DANMAKU.count .. ".json")
    DANMAKU.count = DANMAKU.count + 1
    if not dd_copy_file(cache, danmaku_file) then
        msg.warn("弹弹play 缓存读取失败，改为重新请求: " .. cache)
        return false
    end
    if DANMAKU.sources[url] ~= nil then
        if DANMAKU.sources[url].fname and file_exists(DANMAKU.sources[url].fname) then
            os.remove(DANMAKU.sources[url].fname)
        end
        DANMAKU.sources[url]["fname"] = danmaku_file
    else
        DANMAKU.sources[url] = {from = "api_server", fname = danmaku_file}
    end
    msg.info(("弹弹play 命中本地缓存（%d 条 ≥ %d），跳过 /comment 请求: %s")
        :format(n, minCount, cache))
    show_message(("弹弹play 弹幕来自本地缓存（%d 条）"):format(n), 3)
    load_danmaku(from_menu)
    return true
end

-- 待回退的 /comment（内置凭证降级时挂起，等自建源/B站 结果）
local pending_dd_comment = nil
local pending_dd_timer = nil

-- 是否该把 /comment 推迟到其他源之后：仅「用内置凭证」且「有其他源可等」时为真。
local function dd_should_defer_comment()
    if dd_using_custom() then return false end
    if not (options.auto_load_extra or options.danmu_api_enabled) then return false end
    return true
end

-- 其他源是否已交付过弹幕（判断「都不行」用；不把弹弹play 自己的源算进去）。
local function dd_has_other_source()
    for url, s in pairs(DANMAKU.sources) do
        if type(url) == "string" and not url:find("api%.dandanplay%.") then
            if s and s.fname and file_exists(s.fname) then return true end
        end
    end
    return false
end

-- 挂起 /comment，等自建源/B站 结果；带超时安全网（其他源因解析失败根本没发起时兜底）。
function dd_set_pending_comment(episodeId, from_menu)
    pending_dd_comment = { episodeId = episodeId, from_menu = from_menu }
    if pending_dd_timer then pending_dd_timer:kill() end
    pending_dd_timer = mp.add_timeout(25, function()
        pending_dd_timer = nil
        dd_flush_pending_comment("等待其他源超时")
    end)
    msg.info(("弹弹play：内置凭证降级——暂缓 /comment（ep=%s），等自建源/内置 B站 结果")
        :format(tostring(episodeId)))
end

-- 其他源已提供弹幕 → 取消挂起的 /comment（这就是「降级」省下的请求）。
function dd_clear_pending_comment()
    if pending_dd_timer then pending_dd_timer:kill() pending_dd_timer = nil end
    if pending_dd_comment then
        msg.info("弹弹play：其他源已提供弹幕，取消内置凭证 /comment（省一次请求）")
    end
    pending_dd_comment = nil
end

-- 其他源都没拿到 → 回退用内置凭证发 /comment；若已有其他源弹幕则不重复拉。
function dd_flush_pending_comment(reason)
    if pending_dd_timer then pending_dd_timer:kill() pending_dd_timer = nil end
    local p = pending_dd_comment
    pending_dd_comment = nil
    if not p then return end
    if dd_has_other_source() then
        msg.info("弹弹play：已有其他源弹幕，无需回退 /comment")
        return
    end
    msg.warn(("弹弹play：其他源均未提供弹幕（%s），回退内置凭证取弹幕库（ep=%s）")
        :format(reason, tostring(p.episodeId)))
    fetch_danmaku(p.episodeId, p.from_menu)
end

-- 写入history.json
-- 读取episodeId获取danmaku
function set_episode_id(input, from_menu)
    from_menu = from_menu or false
    DANMAKU.source = "dandanplay"
    for url, source in pairs(DANMAKU.sources) do
        if source.from == "api_server" then
            if source.fname and file_exists(source.fname) then
                os.remove(source.fname)
            end

            if not source.from_history then
                DANMAKU.sources[url] = nil
            else
                DANMAKU.sources[url]["fname"] = nil
            end
        end
    end
    local episodeId = tonumber(input)
    write_history(episodeId)
    set_danmaku_button()

    local dd_url = dd_comment_url(episodeId)
    -- [lc-1228] ① 本地缓存复用：本集弹幕以前拉过就直接用，完全不再碰官方接口，
    --   也无需进入下面的降级等待。
    --   ⚠️ 不可在此 return：下方的「自动补源（B站 叠加）」仍须执行 —— 缓存只替代弹弹play
    --   的弹幕库请求，不代表本集已有 B站 弹幕；提前 return 会让命中缓存的那一集只剩弹弹play 弹幕。
    if not options.load_more_danmaku and dd_try_use_cache(episodeId, dd_url, from_menu) then
        -- 已从缓存取到弹弹play 弹幕，跳过请求/挂起，但继续走下面的 B站 补源
    elseif options.load_more_danmaku then
        fetch_danmaku_all(episodeId, from_menu)
    elseif dd_should_defer_comment() then
        -- [lc-1228] ② 内置凭证降级：暂缓 /comment，优先让自建源/内置 B站 去取
        --   （它们在 file-loaded 阶段已经发起）。等它们落地后再决定要不要回退。
        dd_set_pending_comment(episodeId, from_menu)
    else
        fetch_danmaku(episodeId, from_menu)
    end
    -- 自动补源（兜底）：弹弹play 匹配成功后，用其返回的干净服务端标题 DANMAKU.anime 补源 B站。
    -- 触发条件（满足其一）：
    --   a) file-loaded 阶段未按文件名触发过 B站（bili_auto_triggered=false）
    --   b) 文件名触发过但失败/无关联（BILI_INFO 为空或 ok=false）——典型场景是文件名乱码，
    --      拿乱码去搜 B站 必然失败；此时必须用弹弹play的干净标题重试一次。
    if (options.auto_load_extra or options.danmu_api_enabled) and DANMAKU.anime then
        local bili_failed = (BILI_INFO == nil) or (type(BILI_INFO) == "table" and not BILI_INFO.ok)
        if not bili_auto_triggered or bili_failed then
            local ep_num = tonumber((DANMAKU.episode or ""):match("%d+"))
            if ep_num then
                msg.warn(("自动补源：触发 anime=%s ep=%s（%s）"):format(
                    DANMAKU.anime, ep_num,
                    bili_auto_triggered and "文件名触发失败，用弹弹play干净标题重试" or "首次触发"))
                mp.add_timeout(1.2, function()
                    auto_search_extra(DANMAKU.anime, ep_num)
                end)
            else
                msg.warn(("自动补源：跳过（集数提取失败，episode=%s）"):format(DANMAKU.episode or "nil"))
            end
        else
            msg.info("自动补源：B站已按文件名关联成功，跳过重复补源")
        end
    end
end

-- 回退使用额外的弹幕获取方式
function get_danmaku_fallback(query)
    local url = options.fallback_server .. "/?url=" .. query
    msg.verbose("尝试获取弹幕：" .. url)
    local temp_file = "danmaku-" .. PID .. DANMAKU.count .. ".xml"
    local danmaku_xml = utils.join_path(DANMAKU_PATH, temp_file)
    DANMAKU.count = DANMAKU.count + 1
    local arg = {
        "curl",
        "-L",
        "-s",
        "--compressed",
        "--user-agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
        "--output",
        danmaku_xml,
        url,
    }

    call_cmd_async(arg, function(error)
        async_running = false
        if error then
            show_message("HTTP 请求失败，打开控制台查看详情", 5)
            msg.error(error)
            return
        end
        if file_exists(danmaku_xml) then
            if query:find("iqiyi%.com") ~= nil then
                DANMAKU.strict = true
            end
            save_danmaku_downloaded(query, danmaku_xml)
            load_danmaku(true)
        end
    end)
end

-- 返回弹幕请求参数
function make_danmaku_request_args(method, url, headers, body)
    local args = {
        "curl",
        "-L",
        "-X",
        method,
        "-H",
        "Accept: application/json",
        "-H",
        "User-Agent: " .. options.user_agent,
    }

    if headers then
        for k, v in pairs(headers) do
            table.insert(args, '-H')
            table.insert(args, string.format('%s: %s', k, v))
        end
    end

    if body then
        table.insert(args, '-d')
        table.insert(args, utils.format_json(body))
        table.insert(args, '-H')
        table.insert(args, 'Content-Type: application/json')
    end

    if url:find("api%.dandanplay%.") then
        -- [lc-1226] 自定义凭证优先，否则用内置凭证（密文内嵌，运行时解密）。两者都带
        -- 密钥轮换能力：自定义不可轮换，内置默认 1 号、被拒自动切 2 号。
        append_dandanplay_auth(args, url)
    end

    table.insert(args, url)

    return args
end

-- 尝试通过解析文件名匹配剧集
local function match_episode(animeTitle, bangumiId, episode_num)
    local url = options.api_server .. "/api/v2/bangumi/" .. bangumiId
    local args = make_danmaku_request_args("GET", url)

    if args == nil then
        return
    end

    dd_fetch(args, function(error, json)
        async_running = false
        if error then
            show_message("HTTP 请求失败，打开控制台查看详情", 5)
            msg.error(error)
            return
        end

        local data = utils.parse_json(json)
        if not data or not data.bangumi or not data.bangumi.episodes then
            msg.info("无结果")
            return
        end

        for _, episode in ipairs(data.bangumi.episodes) do
            local ep_num = tonumber(episode.episodeNumber)
            if ep_num and ep_num == tonumber(episode_num) then
                DANMAKU.anime = animeTitle
                DANMAKU.episode = episode.episodeTitle
                set_episode_id(episode.episodeId)
                break
            end
        end
    end)
end

local function match_anime()
    local animes = {}
    local movie_animes = {}
    local anime_type = "tvseries"
    local type_count = 0
    local title, season_num, episode_num = parse_title()
    if not episode_num then
        msg.info("无法解析剧集信息")
        return
    end

    if title:match("OVA") or title:match("OAD") then
        anime_type = "ova"
    end

    local encoded_query = url_encode(title)
    local url = options.api_server .. "/api/v2/search/anime"
    local params = "keyword=" .. encoded_query
    local full_url = url .. "?" .. params
    local args = make_danmaku_request_args("GET", full_url)

    if not args then return end

    dd_fetch(args, function(error, json)
        async_running = false
        if error then
            show_message("HTTP 请求失败，打开控制台查看详情", 5)
            msg.error(error)
            return
        end

        local data = utils.parse_json(json)
        if not data or not data.animes then
            msg.info("无结果")
            return
        end

        for _, anime in ipairs(data.animes) do
            if anime.type == anime_type then
                type_count = type_count + 1
                table.insert(animes, anime)
            elseif anime.type == "movie" then
                table.insert(movie_animes, anime)
            end
        end

        -- 剧集无结果时，退而求其次尝试电影类型（仅当恰好一个电影匹配，避免误选）
        local search_list, list_count = animes, type_count
        if type_count == 0 and #movie_animes == 1 then
            search_list = movie_animes
            list_count = 1
        end

        if list_count == 1 then
            match_episode(search_list[1].animeTitle, search_list[1].bangumiId, episode_num)
        elseif list_count > 1 and season_num then
            local best_match, best_score = nil, -1
            local target_title = title
            if tonumber(season_num) == 1 then
                target_title = title .. " 第一季"
            else
                target_title = title .. " 第" .. number_to_chinese(season_num) .. "季"
            end
            for _, anime in ipairs(search_list) do
                local score = jaro_winkler(target_title, anime.animeTitle)
                msg.debug(("候选: %s -> 相似度 %.3f"):format(anime.animeTitle, score))
                if score > best_score then
                    best_score = score
                    best_match = anime
                end
            end

            if best_match and best_score >= 0.7 then
                msg.info(("模糊匹配选中: %s (score=%.2f)"):format(best_match.animeTitle, best_score))
                match_episode(best_match.animeTitle, best_match.bangumiId, episode_num)
            else
                msg.info("匹配到多个结果，但相似度不足，请手动搜索")
            end
        else
            msg.info("没有找到合适的匹配结果")
        end
    end)
end

-- 计算文件哈希（dandanplay 约定：取前 16MB；文件更小时取整个文件）
-- 原先仅对 >16MB 的文件算哈希，<=16MB 直接发空 hash，导致小文件只能靠文件名猜、易失败
local function compute_hash_sync(file_path)
    local file_info = utils.file_info(file_path)
    if not file_info then return nil end
    local limit = math.min(file_info.size, 16 * 1024 * 1024)
    if limit <= 0 then return nil end
    local file, err = io.open(normalize(file_path), 'rb')
    if not file then return nil end
    local m = MD5.new()
    local read = 0
    while read < limit do
        local chunk = file:read(math.min(1024, limit - read))
        if not chunk then break end
        m:update(chunk)
        read = read + #chunk
    end
    file:close()
    return m:finish()
end

-- 从 certutil 输出中解析 MD5（精确匹配 16 个字节对，避免误匹配到其他含十六进制字符的行）
local function parse_certutil_hash(out)
    -- [修复] call_cmd_async 失败时第二参数传的是空 table {} 而非 nil/字符串，
    -- 原 `if not out` 守卫拦不住 table（table 在 Lua 里为 truthy），导致 `{}:gmatch` 直接崩溃，
    -- 进而整个 uosc_danmaku 脚本死亡、后续 B站弹幕触发代码无法执行。
    -- 改为显式判断字符串类型；非字符串（nil/table）一律返回 nil，由上层回退到 Lua 自带 MD5。
    if type(out) ~= "string" then return nil end
    for line in out:gmatch("[^\r\n]+") do
        if line:match("^%s*(%x%x%s+){15}%x%x%s*$") then
            return line:gsub("%s+", ""):lower()
        end
    end
    return nil
end

-- 执行哈希匹配获取弹幕
local function match_file(file_path, file_name, callback)
    async_running = true

    local title, season_num, episode_num = parse_title()
    if title and episode_num then
        if season_num then
            file_name = title .. " S" .. season_num .. "E" .. episode_num
        else
            file_name = title .. " E" .. episode_num
        end
    else
        file_name = title or mp.get_property("filename/no-ext") or ""
    end

    local function do_match(hash)
        if hash then msg.info('hash:', hash) end

        local url = options.api_server .. "/api/v2/match"
        local args = make_danmaku_request_args("POST", url, {
                ["Content-Type"] = "application/json"
            }, {
                fileName = file_name,
                fileHash = hash or "",
                matchMode = "hashAndFileName"
            }
        )

        if not args then
            callback("请求构造失败")
            return
        end

        dd_fetch(args, function(error, json)
            async_running = false
            if error then
                show_message("HTTP 请求失败，打开控制台查看详情", 5)
                callback(error)
                return
            end
            local data = utils.parse_json(json)
            if not data or not data.isMatched or #data.matches == 0 then
                callback("没有匹配的剧集")
                return
            end

            -- hashAndFileName 可能返回多个候选（hash 命中 + 文件名命中）：
            -- 优先取 hash 命中的（更准确），否则取第一个（API 已按置信度排序）
            local best = data.matches[1]
            for _, cand in ipairs(data.matches) do
                if cand.matchType == "hash" then
                    best = cand
                    break
                end
            end

            DANMAKU.anime = best.animeTitle
            DANMAKU.episode = best.episodeTitle

            -- 获取并加载弹幕数据
            set_episode_id(best.episodeId)
        end)
    end

    -- Windows 下用 certutil 异步计算哈希（不阻塞播放器）；失败则回退到 Lua MD5 同步计算
    if PLATFORM == "windows" then
        local arg = { "certutil", "-hashfile", normalize(file_path), "MD5" }
        call_cmd_async(arg, function(error, out)
            local hash = parse_certutil_hash(out)
            if not hash then
                msg.verbose("certutil 不可用，回退到 Lua MD5")
                hash = compute_hash_sync(file_path)
            end
            do_match(hash)
        end)
    else
        do_match(compute_hash_sync(file_path))
    end
end

-- 异步获取弹幕数据
function fetch_danmaku_data(args, callback)
    dd_fetch(args, function(error, json)
        async_running = false
        if error then
            show_message("获取数据失败", 3)
            msg.error("HTTP 请求失败：" .. error)
            return
        end
        local data = utils.parse_json(json)
        if data == nil then
            if json == nil or json:match("^%s*$") then
                -- 空响应体：典型场景是弹弹play服务器限流(HTTP 429)或临时故障
                msg.warn("弹弹play API 返回空响应（很可能是服务器限流 429，请几小时后再试）")
                show_message("弹弹play服务器限流，请稍后再试", 5)
            else
                msg.warn("弹弹play API 返回非JSON内容: " .. json:sub(1, 200))
            end
        end
        callback(data)
    end)
end

-- 保存弹幕数据
function save_danmaku_data(comments, query, danmaku_source)
    local temp_file = "danmaku-" .. PID .. DANMAKU.count .. ".json"
    local danmaku_file = utils.join_path(DANMAKU_PATH, temp_file)
    DANMAKU.count = DANMAKU.count + 1
    local success = save_danmaku_json(comments, danmaku_file)

    if success then
        if DANMAKU.sources[query] ~= nil then
            if DANMAKU.sources[query].fname and file_exists(DANMAKU.sources[query].fname) then
                os.remove(DANMAKU.sources[query].fname)
            end
            DANMAKU.sources[query]["fname"] = danmaku_file
        else
            DANMAKU.sources[query] = {from = danmaku_source, fname = danmaku_file}
        end
    end
end

function save_danmaku_downloaded(url, downloaded_file)
    if DANMAKU.sources[url] ~= nil then
        if DANMAKU.sources[url].fname and file_exists(DANMAKU.sources[url].fname) then
            os.remove(DANMAKU.sources[url].fname)
        end
        DANMAKU.sources[url]["fname"] = downloaded_file
    else
        DANMAKU.sources[url] = {from = "user_custom", fname = downloaded_file}
    end
end

-- 处理弹幕数据
function handle_danmaku_data(query, data, from_menu)
    local comments = data["comments"]
    local count = data["count"]

    -- 如果没有数据，进行重试
    if count == 0 then
        show_message("服务器无缓存数据，再次尝试请求…", nil, true)
        msg.verbose("服务器无缓存数据，再次尝试请求")
        -- 等待 2 秒后重试
        local start = os.time()
        while os.time() - start < 2 do
            -- 空循环，等待 2 秒
        end
        -- 重新发起请求
        local url = options.api_server .. "/api/v2/extcomment?url=" .. url_encode(query)
        local args = make_danmaku_request_args("GET", url)

        if args == nil then
            return
        end

        fetch_danmaku_data(args, function(retry_data)
            if not retry_data or not retry_data["comments"] or retry_data["count"] == 0 then
                get_danmaku_fallback(query)
                return
            end
            save_danmaku_data(retry_data["comments"], query, "user_custom")
            load_danmaku(from_menu)
        end)
    else
        save_danmaku_data(comments, query, "user_custom")
        load_danmaku(from_menu)
    end
end

-- 处理第三方弹幕数据
function handle_related_danmaku(index, relateds, related, shift, callback)
    local url = options.api_server .. "/api/v2/extcomment?url=" .. url_encode(related["url"])
    show_message(string.format("正在从第三方库装填弹幕 [%d/%d]…", index, #relateds), nil, true)
    msg.verbose("正在从第三方库装填弹幕：" .. url)

    local args = make_danmaku_request_args("GET", url)

    if args == nil then
        return
    end

    fetch_danmaku_data(args, function(data)
        local comments = {}
        if data and data["comments"] then
            if data["count"] == 0 then
                -- 如果没有数据，稍等 2 秒重试
                local start = os.time()
                while os.time() - start < 2 do
                    -- 空循环，等待 2 秒
                end
                fetch_danmaku_data(args, function(data)
                    for _, comment in ipairs(data["comments"]) do
                        comment["shift"] = shift
                        table.insert(comments, comment)
                    end
                    callback(comments)
                end)
            else
                for _, comment in ipairs(data["comments"]) do
                    comment["shift"] = shift
                    table.insert(comments, comment)
                end
                callback(comments)
            end
        else
            show_message("无数据", 3)
            msg.info("无数据")
            callback(comments)
        end
    end)
end

-- 处理dandan库的弹幕数据
function handle_main_danmaku(url, from_menu)
    show_message("正在从弹弹Play库装填弹幕…", nil, true)
    msg.verbose("尝试获取弹幕：" .. url)
    local args = make_danmaku_request_args("GET", url)

    if args == nil then
        return
    end

    fetch_danmaku_data(args, function(data)
        if not data or not data["comments"] then
            show_message("无数据", 3)
            msg.info("无数据")
            return
        end

        local comments = data["comments"]
        local count = data["count"]

        if count == 0 then
            if DANMAKU.sources[url] == nil then
                DANMAKU.sources[url] = {from = "api_server"}
            end
            load_danmaku(from_menu)
            return
        end

        save_danmaku_data(comments, url, "api_server")
        load_danmaku(from_menu)
    end)
end

-- 处理获取到的数据
function handle_fetched_danmaku(data, url, from_menu)
    if data and data["comments"] then
        if data["count"] == 0 then
            if DANMAKU.sources[url] == nil then
                DANMAKU.sources[url] = {from = "api_server"}
            end
            show_message("该集弹幕内容为空，结束加载", 3)
            msg.verbose("该集弹幕内容为空，结束加载")
            return
        end
        save_danmaku_data(data["comments"], url, "api_server")
        load_danmaku(from_menu)
    else
        show_message("无数据", 3)
        msg.info("无数据")
    end
end

-- 匹配弹幕库 comment, 仅匹配dandan本身弹幕库
-- 通过danmaku api（url）+id获取弹幕
-- [lc-1228] 拿到数据后落一份 episodeId 命名的缓存（含 get_danmaku_fallback 重试路径），
-- 下次重播同集直接读盘（见 dd_try_use_cache），不再请求官方 /comment。
-- [lc-1260] 同集会话内去重（仅针对弹弹play：其开放 API 有次数配额，同一集不该拉第二次）。
--   跨会话：缓存 < dd_cache_min_count 条 → 重拉；≥ 阈值 → 复用旧盘（省配额）
--   同会话：本集已拉过一次 → 沿用现有弹幕/缓存，绝不再打接口
-- ⚠️ 去重命中时不能简单 return：set_episode_id 开头已把上一份 api_server 工作文件删掉，
--   直接返回会让本集弹幕消失。故命中时若仍有可用缓存/工作文件则重新挂载。
--   仅当「工作文件与缓存都不可用」时才放行重拉——否则本集将无弹幕可用。
local dd_fetched_episodes = {}

function fetch_danmaku(episodeId, from_menu)
    local key = tostring(episodeId)
    local url = dd_comment_url(episodeId)
    if dd_fetched_episodes[key] then
        local cur = DANMAKU.sources[url]
        local has_work = cur and cur.fname and file_exists(cur.fname)
        if has_work then
            msg.info(("弹弹play：本集（ep=%s）本次会话已拉取过，沿用现有弹幕不再请求") :format(key))
            show_message("弹弹play 弹幕已加载（本次会话已拉取过）", 3)
            load_danmaku(from_menu)
            return
        end
        -- 跳过条数闸门（force）：本集已拉过，宁可复用偏少缓存也不再耗配额
        if dd_try_use_cache(episodeId, url, from_menu, true) then return end
        -- 工作文件与缓存都不可用 → 只能重拉，否则本集弹幕为空（此路径无法省配额）
        msg.warn(("弹弹play：本集（ep=%s）本次会话已拉过但工作文件与缓存均不可用 → 重新拉取")
            :format(key))
    end
    local args = make_danmaku_request_args("GET", url)
    if args == nil then
        -- 请求都构造不出来（未配置/无凭证）→ 不标记已拉取，下次仍可重试
        return
    end
    dd_fetched_episodes[key] = true
    show_message("弹幕加载中...", nil, true)
    msg.verbose("尝试获取弹幕：" .. url)

    fetch_danmaku_data(args, function(data)
        handle_fetched_danmaku(data, url, from_menu)
        dd_write_cache(episodeId, url)
    end)
end

-- 主函数：获取所有相关弹幕
function fetch_danmaku_all(episodeId, from_menu)
    local url = options.api_server .. "/api/v2/related/" .. episodeId
    show_message("弹幕加载中...", nil, true)
    msg.verbose("尝试获取弹幕：" .. url)
    local args = make_danmaku_request_args("GET", url)

    if args == nil then
        return
    end

    fetch_danmaku_data(args, function(data)
        if not data or not data["relateds"] then
            show_message("无数据", 3)
            msg.info("无数据")
            return
        end

        -- 处理所有的相关弹幕
        local relateds = data["relateds"]
        local function process_related(index)
            if index > #relateds then
                -- 所有相关弹幕加载完成后，开始加载主库弹幕
                url = options.api_server .. "/api/v2/comment/" .. episodeId .. "?withRelated=false&chConvert=0"
                handle_main_danmaku(url, from_menu)
                return
            end

            local related = relateds[index]
            local shift = related["shift"]

            -- 处理当前的相关弹幕
            handle_related_danmaku(index, relateds, related, shift, function(comments)
                if #comments == 0 then
                    if DANMAKU.sources[related["url"]] == nil then
                        DANMAKU.sources[related["url"]] = {from = "api_server"}
                    end
                else
                    save_danmaku_data(comments, related["url"], "api_server")
                end

                -- 继续处理下一个相关弹幕
                process_related(index + 1)
            end)
        end

        -- 从第一个相关库开始请求
        process_related(1)
    end)
end

-- 从用户添加过的弹幕源添加弹幕
function addon_danmaku(dir, from_menu)
    if dir then
        local history_json = read_file(HISTORY_PATH)
        local history = utils.parse_json(history_json) or {}
        if history[dir] and history[dir].extra ~= nil then
            return
        end
    end
    for url, source in pairs(DANMAKU.sources) do
        if source.from ~= "api_server" then
            add_danmaku_source(url, from_menu)
        end
    end
end

--通过输入源url获取弹幕库
function add_danmaku_source(query, from_menu)
    if DANMAKU.sources[query] == nil then
        DANMAKU.sources[query] = {from = "user_custom"}
    end

    from_menu = from_menu or false
    if from_menu then
        add_source_to_history(query, DANMAKU.sources[query])
    end

    if is_protocol(query) then
        add_danmaku_source_online(query, from_menu)
    else
        add_danmaku_source_local(query, from_menu)
    end
end

function add_danmaku_source_local(query, from_menu)
    local path = normalize(query)
    if not file_exists(path) then
        msg.warn("无效的文件路径")
        return
    end
    if not (string.match(path, "%.xml$") or string.match(path, "%.json$") or string.match(path, "%.ass$")) then
        msg.warn("仅支持弹幕文件")
        return
    end

    if DANMAKU.sources[query] ~= nil then
        if DANMAKU.sources[query].fname and file_exists(DANMAKU.sources[query].fname) then
            os.remove(DANMAKU.sources[query].fname)
        end
        DANMAKU.sources[query]["from"] = "user_local"
        DANMAKU.sources[query]["fname"] = path
    else
        DANMAKU.sources[query] = {from = "user_local", fname = path}
    end

    set_danmaku_button()
    load_danmaku(from_menu)
end

--通过输入源url获取弹幕库
function add_danmaku_source_online(query, from_menu)
    set_danmaku_button()
    local url = options.api_server .. "/api/v2/extcomment?url=" .. url_encode(query)
    show_message("弹幕加载中...", nil, true)
    msg.verbose("尝试获取弹幕：" .. url)
    local args = make_danmaku_request_args("GET", url)

    if args == nil then
        return
    end

    fetch_danmaku_data(args, function(data)
        if not data or not data["comments"] then
            show_message("此源弹幕无法加载", 3)
            msg.verbose("此源弹幕无法加载")
            return
        end
        handle_danmaku_data(query, data, from_menu)
    end)
end

-- 将弹幕转换为factory可读的json格式
function save_danmaku_json(comments, json_filename)
    local temp_file = "danmaku-" .. PID .. ".json"
    json_filename = json_filename or utils.join_path(DANMAKU_PATH, temp_file)
    local json_file = io.open(json_filename, "w")

    if json_file then
        json_file:write("[\n")
        for _, comment in ipairs(comments) do
            local p = comment["p"]
            local shift = comment["shift"]
            if p then
                local fields = split(p, ",")
                if shift ~= nil then
                    fields[1] = tonumber(fields[1]) + tonumber(shift)
                end
                local c_value = string.format(
                    "%s,%s,%s,25,,,",
                    tostring(fields[1]), -- first field of p to first field of c
                    fields[3], -- third field of p to second field of c
                    fields[2]  -- second field of p to third field of c
                )
                local m_value = comment["m"]
                                :gsub("[%z\1-\31]", "")
                                :gsub("\\", "")
                                :gsub("\"", "")

                -- Write the JSON object as a single line, no spaces or extra formatting
                local json_entry = string.format('{"c":"%s","m":"%s"},\n', c_value, m_value)
                json_file:write(json_entry)
            end
        end
        json_file:write("]")
        json_file:close()
        return true
    end

    return false
end

-- 通过文件前 16M 的 hash 值进行弹幕匹配
function get_danmaku_with_hash(file_name, file_path)
    if type(MD5) ~= "table" or not MD5.sum then
        msg.warn("MD5 模块不支持 Lua 5.1，回退到文件名匹配")
        match_anime()
        return
    end
    if is_protocol(file_path) then
        set_danmaku_button()
        local temp_file = "temp-" .. PID .. ".mp4"
        local arg = {
            "curl",
            "--connect-timeout",
            "10",
            "--max-time",
            "30",
            -- [lc-998] 限速：弹幕 hash 只要前 16MB，但它是与视频流**同一条**网盘/隧道连接上
            -- 的第二次全速下载 —— 实测开播阶段它曾占满带宽约 15s，把视频缓冲直接拖垮(表现为一卡一卡)。
            -- 限速把带宽优先让给视频；弹幕晚几秒出现远好过视频卡顿。可用 options.hash_limit_rate 覆盖。
            "--limit-rate",
            options.hash_limit_rate or "1M",
            "--range",
            "0-16777215",
            "--user-agent",
            options.user_agent,
            "--output",
            utils.join_path(DANMAKU_PATH, temp_file),
            "-L",
            file_path,
        }

        if options.proxy ~= "" then
            table.insert(arg, '-x')
            table.insert(arg, options.proxy)
        end

        call_cmd_async(arg, function(error)
            async_running = false

            file_path = utils.join_path(DANMAKU_PATH, temp_file)

            match_file(file_path, file_name, function(error)
                if error then
                    msg.error(error)
                    msg.info("尝试通过解析文件名获取弹幕")
                    match_anime()
                end
            end)
        end)
    else
        local dir = get_parent_directory(file_path)
        local excluded_path = utils.parse_json(options.excluded_path)
        if PLATFORM == "windows" then
            for i, path in pairs(excluded_path) do
                excluded_path[i] = path:gsub("/", "\\")
            end
        end
        if contains_any(excluded_path, dir) then
            match_anime()
            return
        end
        match_file(file_path, file_name, function(error)
            if error then
                msg.error(error)
                msg.info("尝试通过解析文件名获取弹幕")
                match_anime()
            end
        end)
    end
end
