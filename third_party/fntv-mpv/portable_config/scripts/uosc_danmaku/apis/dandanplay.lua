local msg = require('mp.msg')
local utils = require("mp.utils")

local function extract_url(url)
    local path = url:match("^https?://[^/]+(/[^%?]*)")
    return path
end

local function generateXSignature(url, time, appid, app_accept)
    local url_path = extract_url(url)
    if not url_path then
        return nil
    end

    local dataToHash = string.format("%s%d%s%s", AES.ECB.decrypt(KEY, Base64.decode(appid)),
    time, url_path, AES.ECB.decrypt(KEY, Base64.decode(app_accept)))
    local hash = Sha256(dataToHash)
    local base64Hash = Base64.encode(hex_to_bin(hash))
    return base64Hash
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
    if options.load_more_danmaku then
        fetch_danmaku_all(episodeId, from_menu)
    else
        fetch_danmaku(episodeId, from_menu)
    end
    -- 自动补源（兜底）：弹弹play 匹配成功后，用其返回的干净服务端标题 DANMAKU.anime 补源 B站。
    -- 触发条件（满足其一）：
    --   a) file-loaded 阶段未按文件名触发过 B站（bili_auto_triggered=false）
    --   b) 文件名触发过但失败/无关联（BILI_INFO 为空或 ok=false）——典型场景是文件名乱码，
    --      拿乱码去搜 B站 必然失败；此时必须用弹弹play的干净标题重试一次。
    if options.auto_load_extra and DANMAKU.anime then
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
        local time = os.time()
        local appid = "UgjRIH45lE1BBLNmir1WKw=="
        local app_accept = "SzuWlFZAPRMqeWf9qmfp8dcvYr3hvxuSrIRZuAeEfko="
        table.insert(args, '-H')
        table.insert(args, string.format('X-AppId: %s', AES.ECB.decrypt(KEY, Base64.decode(appid))))
        table.insert(args, '-H')
        table.insert(args, string.format('X-Signature: %s', generateXSignature(url, time, appid, app_accept)))
        table.insert(args, '-H')
        table.insert(args, string.format('X-Timestamp: %s', time))
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

    call_cmd_async(args, function(error, json)
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

    call_cmd_async(args, function(error, json)
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

        call_cmd_async(args, function(error, json)
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
    call_cmd_async(args, function(error, json)
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
        show_message("服务器无缓存数据，再次尝试请求", 30)
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
    show_message(string.format("正在从第三方库装填弹幕 [%d/%d]", index, #relateds), 30)
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
    show_message("正在从弹弹Play库装填弹幕", 30)
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
function fetch_danmaku(episodeId, from_menu)
    local url = options.api_server .. "/api/v2/comment/" .. episodeId .. "?withRelated=false&chConvert=0"
    show_message("弹幕加载中...", 30)
    msg.verbose("尝试获取弹幕：" .. url)
    local args = make_danmaku_request_args("GET", url)

    if args == nil then
        return
    end

    fetch_danmaku_data(args, function(data)
        handle_fetched_danmaku(data, url, from_menu)
    end)
end

-- 主函数：获取所有相关弹幕
function fetch_danmaku_all(episodeId, from_menu)
    local url = options.api_server .. "/api/v2/related/" .. episodeId
    show_message("弹幕加载中...", 30)
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
    show_message("弹幕加载中...", 30)
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
