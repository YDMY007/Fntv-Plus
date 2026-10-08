local msg = require('mp.msg')
local utils = require("mp.utils")

input_loaded, input = pcall(require, "mp.input")
uosc_available = false

-- 打开番剧数据匹配菜单
-- [lc-1263] 自建源优先：同一个搜索词并行查自建源（danmu_api），命中则结果置顶展示、
--   选中直接拉自建源弹幕；自建源未命中/未启用时，下方照旧列弹弹play 番剧库结果。
--   用户诉求：「搜索时先搜自建源，自建源没有才匹配弹弹play」（自建源弹幕密度远高于弹弹play）。
local function fetch_self_hosted_candidates(query, ep)
    -- 经本地 shim 的 /danmaku-candidates（主进程里自建源优选 + B站 兜底，返回统一候选结构）
    local params = "title=" .. url_encode(query) .. "&ep=" .. tostring(ep or 0)
    local api = "http://127.0.0.1:22347/danmaku-candidates?" .. params
    local platform = mp.get_property("platform") or ""
    local res
    if platform == "windows" then
        res = mp.command_native({
            name = "subprocess",
            -- PowerShell 必须钉 UTF8（中文机默认 GBK 会把 UTF-8 JSON 整个重编码）
            args = { "powershell", "-NoProfile", "-NonInteractive", "-Command",
                     "[Console]::OutputEncoding=[Text.Encoding]::UTF8; try { (Invoke-WebRequest -Uri '" .. api .. "' -UseBasicParsing -TimeoutSec 30).Content } catch { Write-Output ('ERR:' + $_.Exception.Message) }" },
            capture_stdout = true, capture_stderr = true,
        })
    else
        res = mp.command_native({ name = "subprocess", args = { "curl", "-sS", "--max-time", "30", api }, capture_stdout = true, capture_stderr = true })
    end
    if not res then return {} end
    local body = (res.stdout or ""):gsub("\\r?\\n$", "")
    if body == "" or body:sub(1, 4) == "ERR:" then return {} end
    local ok, parsed = pcall(utils.parse_json, body)
    if not ok or type(parsed) ~= "table" or not parsed.ok then return {} end
    local out = {}
    for _, c in ipairs(parsed.candidates or {}) do
        -- 只收自建源候选（伪 bvid = dmapi:…）；B站 候选留给下面的弹弹play/B站 链路
        local cb = tostring(c.bvid or "")
        if cb:sub(1, 6) == "dmapi:" then
            out[#out + 1] = c
        end
    end
    return out
end

function get_animes(query)
    local encoded_query = url_encode(query)
    local url = options.api_server .. "/api/v2/search/anime"
    local params = "keyword=" .. encoded_query
    local full_url = url .. "?" .. params
    local items = {}

    local message = "加载数据中..."
    local menu_type = "menu_anime"
    local menu_title = "在此处输入番剧名称"
    local footnote = "使用enter或ctrl+enter进行搜索"
    local menu_cmd = { "script-message-to", mp.get_script_name(), "search-anime-event" }
    if uosc_available then
        update_menu_uosc(menu_type, menu_title, message, footnote, menu_cmd, query)
    else
        show_message(message, 30)
    end
    msg.verbose("尝试获取番剧数据：" .. full_url)

    -- [lc-1263] 自建源优先：先并行查自建源候选（弹幕密度远高于弹弹play），命中即置顶
    -- 当前集数：自建源候选是「条目 + 具体集」的形式（bvid = dmapi:<animeId>:<episodeId>），
    --   搜索时必须带上本集号，否则候选会定位到条目的首集 → 拿到的弹幕不是正在看的那集。
    local cur_ep = tonumber(tostring(DANMAKU.episode or ""):match("%d+")) or 0
    local self_cands = fetch_self_hosted_candidates(query, cur_ep)
    if #self_cands > 0 then
        table.insert(items, {
            title = ("⭐ 自建源命中 %d 个（推荐，弹幕更全）· 点击直接使用该条目弹幕"):format(#self_cands),
            bold = true, italic = true, keep_open = true, selectable = false,
        })
        for _, c in ipairs(self_cands) do
            -- [lc-1270] 弹弹play 风格两段结构：title=「主名 · 集标题」（主进程已剥年份/类型/平台尾缀），
            -- hint 右侧只放平台名；全源统一的「点击直接使用」说明收进首行段标题，不再逐行重复。
            local ct = tostring(c.title or "")
            local plat = tostring((c.platform ~= nil and c.platform ~= "") and c.platform or "自建源")
            table.insert(items, {
                title = ct,
                hint = plat .. " · 第" .. (cur_ep > 0 and tostring(cur_ep) or "?") .. "集",
                value = { "script-message-to", mp.get_script_name(), "bili_manual_pick", tostring(c.bvid or ""), query, tostring(cur_ep) },
            })
        end
        table.insert(items, {
            title = "—— 弹弹play 番剧库（下方为备用源）——",
            italic = true, keep_open = true, selectable = false,
        })
        if uosc_available then update_menu_uosc(menu_type, menu_title, items, footnote, menu_cmd, query) end
        msg.info(("[lc-1263] 自建源候选 %d 个已置顶（搜索词=%s ep=%d）"):format(#self_cands, query, cur_ep))
    end

    local args = make_danmaku_request_args("GET", full_url)

    if args == nil then
        -- [lc-1263] 弹弹play 不可用但有自建源结果时，不要把已置顶的自建源列表清掉
        if #items > 0 and uosc_available then
            update_menu_uosc(menu_type, menu_title, items, footnote, menu_cmd, query)
        end
        return
    end

    local body, _, res = dd_request_sync(args)

    if not res or not res.status or res.status ~= 0 then
        local message = "获取数据失败"
        if uosc_available then
            if #items > 0 then
                -- 有自建源结果 → 保留展示，不让弹弹play 的失败把可选项清空
                table.insert(items, { title = "（弹弹play 番剧库查询失败，可继续选上方自建源）", italic = true, selectable = false, keep_open = true })
                update_menu_uosc(menu_type, menu_title, items, footnote, menu_cmd, query)
            else
                update_menu_uosc(menu_type, menu_title, message, footnote, menu_cmd, query)
            end
        else
            show_message(message, 3)
        end
        msg.error("HTTP 请求失败：" .. tostring(res and res.stderr))
    end

    local response = utils.parse_json(body)

    if not response or not response.animes then
        if #items > 0 then
            -- 自建源有结果 → 保留列表（弹弹play 无结果不影响自建源可用）
            if uosc_available then
                table.insert(items, { title = "（弹弹play 番剧库无结果，可继续选上方自建源）", italic = true, selectable = false, keep_open = true })
                update_menu_uosc(menu_type, menu_title, items, footnote, menu_cmd, query)
            end
            msg.info("弹弹play 无结果（已保留自建源候选）")
            return
        end
        local message = "无结果"
        if uosc_available then
            update_menu_uosc(menu_type, menu_title, message, footnote, menu_cmd, query)
        else
            show_message(message, 3)
        end
        msg.info("无结果")
        return
    end

    for _, anime in ipairs(response.animes) do
        table.insert(items, {
            title = anime.animeTitle,
            hint = anime.typeDescription,
            value = {
                "script-message-to",
                mp.get_script_name(),
                "search-episodes-event",
                anime.animeTitle, anime.bangumiId,
            },
        })
    end

    -- [lc-1269] 第三段「B站候选」：一次输入三源齐出（自建源置顶 → 弹弹play 番剧库 → B站视频区）。
    -- 先插占位行立即渲染，B站候选异步回来后 update-menu 原地替换（基建同 lc-1267）。
    -- 手动搜索与自动链路不同：不给 season（用户输入里的 S2 由 bili_manual_parse 口径处理，
    -- 经 candidates 接口的 ep 参数对位集数）。
    if uosc_available then
        local bili_ep = 0
        local q = query or ""
        local m_t, m_s = q:match("^(.-)%s+[Ss](%d+)%s*$")
        local m_t2, m_e = q:match("^(.-)%s+第%s*(%d+)%s*[话集]")
        if m_t2 and m_e then
            bili_ep = tonumber(m_e) or 0
        elseif m_t and m_s then
            bili_ep = 1  -- 「番名 S2」形态：B站候选按第1话对位（季号经 title 影响搜索词）
        end
        local search_title = (m_t or m_t2 or q)
        local season_num = tonumber(m_s) or 0
        local query_for_bili = search_title
        if season_num > 1 and bili_ep > 0 then
            query_for_bili = search_title .. " 第" .. bili_ep .. "集"
        end
        table.insert(items, {
            title = "🔍 正在搜索 B站 候选…",
            keep_open = true, selectable = false, italic = true,
        })
        update_menu_uosc(menu_type, menu_title, items, footnote, menu_cmd, query)
        mp.add_timeout(0.05, function()
            local params = "title=" .. url_encode(query_for_bili) .. "&ep=" .. tostring(bili_ep)
            if season_num > 0 then params = params .. "&season=" .. tostring(season_num) end
            local api = "http://127.0.0.1:22347/danmaku-candidates?" .. params
            local platform = mp.get_property("platform") or ""
            local res
            if platform == "windows" then
                res = mp.command_native({
                    name = "subprocess",
                    args = { "powershell", "-NoProfile", "-NonInteractive", "-Command",
                             "[Console]::OutputEncoding=[Text.Encoding]::UTF8; try { (Invoke-WebRequest -Uri '" .. api .. "' -UseBasicParsing -TimeoutSec 60).Content } catch { Write-Output ('ERR:' + $_.Exception.Message) }" },
                    capture_stdout = true, capture_stderr = true,
                })
            else
                res = mp.command_native({ name = "subprocess", args = { "curl", "-sS", "--max-time", "60", api }, capture_stdout = true, capture_stderr = true })
            end
            -- 弹出占位行（无论成败）
            for i = #items, 1, -1 do
                if items[i].title == "🔍 正在搜索 B站 候选…" then
                    table.remove(items, i)
                    break
                end
            end
            -- [lc-1270] B站候选两段：官方（番剧区/pgc:）与 UP主搬运（视频区/BV）
            local official_items = {}
            local up_items = {}
            local ok_req = res ~= nil
            local body = ok_req and ((res.stdout or ""):gsub("\\r?\\n$", "")) or ""
            if not ok_req or body == "" or body:sub(1, 4) == "ERR:" then ok_req = false end
            local parsed
            if ok_req then
                local ok_p, p = pcall(utils.parse_json, body)
                if ok_p and type(p) == "table" and p.ok then parsed = p else ok_req = false end
            end
            if parsed then
                for _, c in ipairs(parsed.candidates or {}) do
                    local cb = tostring(c.bvid or "")
                    if cb ~= "" and cb:sub(1, 6) ~= "dmapi:" then
                        local src_label = ({ bangumi = "番剧区", video = "视频区" })[c.source] or c.source or ""
                        local tag = ""
                        if c.is_compilation then
                            tag = c.bad_title and " ⚠️解说/二创" or " 📁合集"
                        end
                        local dmTag = ""
                        local dmWarn = ""
                        if c.danmaku_count ~= nil then
                            if (c.danmaku_count or 0) > 0 then
                                dmTag = (" 💬%d"):format(c.danmaku_count)
                            else
                                dmTag = " 💬0"
                                dmWarn = " ⚠️无人发弹幕"
                            end
                        end
                        -- [lc-1270] 三分流：ddp: 弹弹play（不该出现在本段，丢弃——它已有自己的番剧库段）、
                        -- pgc:/source=bangumi 官方番剧、其余（BV+video）UP主搬运。
                        if cb:sub(1, 4) == "ddp:" then
                            -- 弹弹play 候选已在上方番剧库列出，这里跳过防重复展示
                        elseif cb:sub(1, 4) == "pgc:" or c.source == "bangumi" then
                            official_items[#official_items + 1] = {
                                title = tostring(c.title or ""),
                                hint = ("官方%s%s · ep:%s"):format(
                                    src_label == "番剧区" and "番剧" or "国创",
                                    dmTag, tostring(c.epid or cb:sub(5))),
                                value = { "script-message-to", mp.get_script_name(), "bili_manual_pick", cb, query_for_bili, tostring(bili_ep) },
                            }
                        else
                            up_items[#up_items + 1] = {
                                title = tostring(c.title or ""),
                                hint = (src_label .. tag .. dmTag .. " · " .. cb .. dmWarn),
                                value = (c.is_compilation and cb ~= "")
                                    and { "script-message-to", mp.get_script_name(), "bili_open_pages", cb, query_for_bili, tostring(bili_ep), tostring(c.title or "") }
                                    or { "script-message-to", mp.get_script_name(), "bili_manual_pick", cb, query_for_bili, tostring(bili_ep) },
                            }
                        end
                    end
                end
            end
            -- [lc-1270] 官方在前、UP主在后，各自成段（此前混在一段且标题写「UP主搬运/官方」）
            if #official_items > 0 then
                table.insert(items, { title = "—— B站 官方（番剧区正版）——", italic = true, keep_open = true, selectable = false })
                for _, it in ipairs(official_items) do table.insert(items, it) end
            end
            if #up_items > 0 then
                table.insert(items, { title = "—— B站 UP主搬运 ——", italic = true, keep_open = true, selectable = false })
                for _, it in ipairs(up_items) do table.insert(items, it) end
            end
            if #official_items == 0 and #up_items == 0 then
                table.insert(items, { title = "（B站 候选无结果或查询失败）", italic = true, keep_open = true, selectable = false })
            end
            -- 复用候选菜单同款原地替换：本菜单 type=menu_danmaku，uosc update-menu 按 type 命中
            mp.commandv("script-message-to", "uosc", "update-menu", utils.format_json({
                type = menu_type,
                title = menu_title,
                search_style = "palette",
                search_debounce = "submit",
                search_suggestion = parse_title(),
                on_search = { "script-message-to", mp.get_script_name(), "search-anime-event" },
                footnote = footnote,
                items = items,
            }))
        end)
        return
    end

    if uosc_available then
        update_menu_uosc(menu_type, menu_title, items, footnote, menu_cmd, query)
    elseif input_loaded then
        show_message("", 0)
        mp.add_timeout(0.1, function()
            open_menu_select(items)
        end)
    end
end

function get_episodes(animeTitle, bangumiId)
    local url = options.api_server .. "/api/v2/bangumi/" .. bangumiId
    local items = {}

    local message = "加载数据中..."
    local menu_type = "menu_episodes"
    local menu_title = "剧集信息"
    local footnote = "使用 / 打开筛选"

    if uosc_available then
        update_menu_uosc(menu_type, menu_title, message, footnote)
    else
        show_message(message, 30)
    end

    local args = make_danmaku_request_args("GET", url)

    if args == nil then
        return
    end

    local body, _, res = dd_request_sync(args)

    if not res or not res.status or res.status ~= 0 then
        local message = "获取数据失败"
        if uosc_available then
            update_menu_uosc(menu_type, menu_title, message, footnote)
        else
            show_message(message, 3)
        end
        msg.error("HTTP 请求失败：" .. tostring(res and res.stderr))
    end

    local response = utils.parse_json(body)

    if not response or not response.bangumi or not response.bangumi.episodes then
        local message = "无结果"
        if uosc_available then
            update_menu_uosc(menu_type, menu_title, message, footnote)
        else
            show_message(message, 3)
        end
        msg.info("无结果")
        return
    end

    for _, episode in ipairs(response.bangumi.episodes) do
        table.insert(items, {
            title = episode.episodeTitle,
            hint = episode.episodeNumber,
            value = { "script-message-to", mp.get_script_name(), "load-danmaku",
            animeTitle, episode.episodeTitle, episode.episodeId },
            keep_open = false,
            selectable = true,
        })
    end

    if uosc_available then
        update_menu_uosc(menu_type, menu_title, items, footnote)
    elseif input_loaded then
        mp.add_timeout(0.1, function()
            open_menu_select(items)
        end)
    end
end

function update_menu_uosc(menu_type, menu_title, menu_item, menu_footnote, menu_cmd, query)
    local items = {}
    if type(menu_item) == "string" then
        table.insert(items, {
            title = menu_item,
            value = "",
            italic = true,
            keep_open = true,
            selectable = false,
            align = "center",
        })
    else
        items = menu_item
    end

    local menu_props = {
        type = menu_type,
        title = menu_title,
        search_style = menu_cmd and "palette" or "on_demand",
        search_debounce = menu_cmd and "submit" or 0,
        on_search = menu_cmd,
        footnote = menu_footnote,
        search_suggestion = query,
        items = items,
    }
    local json_props = utils.format_json(menu_props)
    mp.commandv("script-message-to", "uosc", "open-menu", json_props)
end

function open_menu_select(menu_items, is_time)
    local item_titles, item_values = {}, {}
    for i, v in ipairs(menu_items) do
        item_titles[i] = is_time and "[" .. v.hint .. "] " .. v.title or
            (v.hint and v.title .. " (" .. v.hint .. ")" or v.title)
        item_values[i] = v.value
    end
    mp.commandv('script-message-to', 'console', 'disable')
    input.select({
        prompt = '筛选:',
        items = item_titles,
        submit = function(id)
            mp.commandv(unpack(item_values[id]))
        end,
    })
end

-- 打开弹幕输入搜索菜单
function open_input_menu_get()
    mp.commandv('script-message-to', 'console', 'disable')
    local title = parse_title()
    input.get({
        prompt = '番剧名称:',
        default_text = title,
        cursor_position = title and #title + 1,
        submit = function(text)
            input.terminate()
            mp.commandv("script-message-to", mp.get_script_name(), "search-anime-event", text)
        end
    })
end

function open_input_menu_uosc()
    local items = {}

    if DANMAKU.anime and DANMAKU.episode then
        local episode = DANMAKU.episode:gsub("%s.-$","")
        episode = episode:match("^(第.*[话回集]+)%s*") or episode
        items[#items + 1] = {
            title = string.format("已关联弹幕：%s-%s", DANMAKU.anime, episode),
            bold = true,
            italic = true,
            keep_open = true,
            selectable = false,
        }
    end

    items[#items + 1] = {
        hint = "  一次输入三源齐出：自建源(置顶) + 弹弹play + B站候选；追加|ds或|dy或|dm可搜电视剧|电影|国漫",
        keep_open = true,
        selectable = false,
    }

    local menu_props = {
        type = "menu_danmaku",
        title = "在此处输入番剧名称",
        search_style = "palette",
        search_debounce = "submit",
        search_suggestion = parse_title(),
        on_search = { "script-message-to", mp.get_script_name(), "search-anime-event" },
        footnote = "使用enter或ctrl+enter进行搜索",
        items = items
    }
    local json_props = utils.format_json(menu_props)
    mp.commandv("script-message-to", "uosc", "open-menu", json_props)
end

function open_input_menu()
    if uosc_available then
        open_input_menu_uosc()
    elseif input_loaded then
        open_input_menu_get()
    end
end

-- ===================== B站弹幕配置面板 =====================
-- 显示当前解析结果、B站关联状态（BV号/标题/弹幕数/是否成功），而非技术参数。
-- ===================== 弹幕配置菜单（[lc-1267] hub-and-spoke 重排）=====================
-- 旧版：20+ 行不可点状态条目与 4 个操作平铺一屏（「──文本──」假分隔线 + 缩进信息行），越长越难扫。
-- 重排为 uosc 官方/上游（Tony15246、dyphire）推荐形态：
--   动作上主菜单（≤6 条）｜状态全部进条目 hint（标题左·状态右）｜详情收进「弹幕源详情」子菜单｜
--   解析信息降为菜单脚注｜假分隔线换 uosc 原生 separator。
-- [lc-1267] 自刷新：搜索/选定等操作完成后经 update-menu 原地刷新（菜单未打开时 uosc 忽略，无害）。

local function _bili_parse_state()
    -- 当前文件名/媒体标题解析出的番名/集数（口径与旧版一致：弹弹play 干净标题优先）
    local raw_filename = mp.get_property("filename") or ""
    local path = mp.get_property("path") or ""
    local parse_target = raw_filename
    if type(path) == "string" and (path:find("^%a[%w.+-]-://") ~= nil or path:find("^%a[%w.+-]-:%?") ~= nil) then
        local mtitle = mp.get_property("media-title")
        if mtitle and mtitle ~= "" then
            parse_target = mtitle
        end
    end
    local title, ep, method_label
    if DANMAKU.anime and DANMAKU.anime ~= "" then
        title = DANMAKU.anime
        ep = DANMAKU.episode and tonumber(tostring(DANMAKU.episode):match("%d+")) or nil
        method_label = "弹弹play标题（推荐）"
    else
        local method
        title, ep, method = guess_bili_title_ep_v2(parse_target)
        method_label = ({ fast = "极速策略", legacy = "兼容链", title_only = "极速·仅标题", legacy_title_only = "兼容·仅标题" })[method] or "无"
    end
    return title, ep, method_label
end

function build_bili_config_menu_props()
    local title, ep, method_label = _bili_parse_state()
    local srcs = (type(BILI_INFO) == "table") and BILI_INFO.sources or nil
    local props = {
        type = "menu_bili_config",
        title = "弹幕配置",
        search_style = "disabled",
        footnote = title
            and ("解析：" .. method_label .. " · 番名「" .. title .. "」· " .. (ep and ("第" .. ep .. "集") or "集数未知（按单集搜索）"))
            or "当前文件无法解析出番名（将转弹弹play兜底）",
    }

    -- —— 逐源结论（口径同旧版 push_source，但从独立信息行改为条目 hint）——
    local function src_note(id, fallback_note)
        if type(srcs) == "table" then
            for _, s in ipairs(srcs) do
                if type(s) == "table" and s.id == id then
                    if s.used then
                        local cnt = (s.count ~= nil) and (" · " .. tostring(s.count) .. " 条") or ""
                        return "✅ " .. tostring(s.detail or "提供了本次弹幕") .. cnt, "✅"
                    elseif s.attempted then
                        return "❌ " .. tostring(s.error or "尝试过但未命中"), "❌"
                    else
                        return "➖ " .. tostring(s.skippedReason or "本轮未参与"), "➖"
                    end
                end
            end
        end
        return fallback_note, "➖"
    end
    local has_srcs = (type(srcs) == "table")
    local note_api, mark_api = src_note("danmu_api", has_srcs and "➖ 未启用（弹幕设置 → 自建弹幕接口）" or "（尚未取过弹幕，无逐源记录）")
    local note_bili, mark_bili = src_note("bilibili", has_srcs and "➖ 未启用或本轮未参与" or "（尚未取过弹幕，无逐源记录）")
    local mark_dd, note_dd = "—", "ℹ️ 兜底源：前两者均未命中时才会取弹幕库（内置凭证下自动延后）"
    if mark_api == "✅" or mark_bili == "✅" then
        mark_dd, note_dd = "➖", "➖ 未启用（前两者已提供弹幕，无需兜底）"
    elseif type(BILI_INFO) == "table" and BILI_INFO.ok then
        mark_dd, note_dd = "✅", "✅ 已从弹弹play 取到弹幕（前两者均未命中）"
    end

    -- —— 实际匹配结果（旧版「实际匹配结果」段收编为二级子菜单）——
    local result_items, result_hint = {}, "⏳ 尚未搜索"
    if type(BILI_INFO) == "table" then
        local src_raw = tostring(BILI_INFO.source or "")
        local src_name = src_raw == "danmu_api+bilibili" and "自建源+B站（低于阈值聚合）"
            or (src_raw:match("danmu_api") and "自建弹幕接口" or "B站弹幕")
        if BILI_INFO.ok then
            local src_label = ({ bangumi = "番剧区（正版）", video = "视频区（UP主搬运）" })[BILI_INFO.source] or BILI_INFO.source or "未知"
            -- 匹配来源标识: 视频区显示 BV 号; 番剧区(正版)无 bvid 但有 ep_id/season_id 更友好
            local src_extra = ""
            if BILI_INFO.bvid and BILI_INFO.bvid ~= "" then
                src_extra = "  (BV:" .. BILI_INFO.bvid .. ")"
            elseif BILI_INFO.epid and BILI_INFO.epid ~= "" then
                src_extra = "  (ep_id:" .. tostring(BILI_INFO.epid) .. ")"
            elseif BILI_INFO.season_id and BILI_INFO.season_id ~= "" then
                src_extra = "  (season_id:" .. tostring(BILI_INFO.season_id) .. ")"
            elseif BILI_INFO.cid then
                src_extra = "  (cid:" .. tostring(BILI_INFO.cid) .. ")"
            end
            result_hint = ("✅ %d 条 · %s"):format(tonumber(BILI_INFO.danmaku_count) or 0, src_name)
            if BILI_INFO.bvid and BILI_INFO.bvid ~= "" then
                table.insert(result_items, { title = "📺 视频：" .. (BILI_INFO.title or "未知") .. " [" .. BILI_INFO.bvid .. "]", selectable = false })
            elseif BILI_INFO.title then
                table.insert(result_items, { title = "📺 剧集：" .. BILI_INFO.title, selectable = false })
            end
            if BILI_INFO.danmaku_count then
                table.insert(result_items, { title = "💬 弹幕数：" .. tostring(BILI_INFO.danmaku_count) .. " 条", selectable = false })
            end
            table.insert(result_items, { title = "🎯 匹配来源：" .. src_label .. src_extra, selectable = false })
        else
            result_hint = "❌ 关联失败"
            table.insert(result_items, { title = "原因：" .. tostring(BILI_INFO.error or "未知错误"), selectable = false })
        end
    else
        local has_bili_source = false
        for url, source in pairs(DANMAKU.sources) do
            if url and url:match("bili_danmaku_") then
                has_bili_source = true
                break
            end
        end
        result_hint = has_bili_source and "已加载（旧版无元数据）" or "尚未搜索"
        if not has_bili_source then
            table.insert(result_items, { title = "点击「用当前解析立即搜索」尝试自动匹配", selectable = false })
        end
    end
    props.hint = result_hint

    -- —— 子菜单：弹幕源详情 ——
    -- [lc-1288] B站 Cookie 体检状态（主进程每日自动检查一次写入 bili_cookie_status.json）
    local cookie_line = "尚未检查，应用每天自动体检一次"
    do
        local cookie_file = io.open(utils.join_path(mp.get_script_directory(), "bili_cookie_status.json"), "r")
        if cookie_file then
            local raw = cookie_file:read("*a")
            cookie_file:close()
            local ok_json, j = pcall(utils.parse_json, raw or "")
            if ok_json and type(j) == "table" and j.status then
                local when = tostring(j.checked_at or ""):gsub("T", " "):gsub("%..*", ""):gsub("%+[0-9:]+$", "")
                if j.status == "valid" then
                    cookie_line = "✅ 已登录" .. (j.uname and ("（" .. j.uname .. "）") or "") .. " · 检查于 " .. when
                elseif j.status == "expired" then
                    cookie_line = "❌ 已失效（重新复制 SESSDATA 到脚本目录 bili_cookie.txt） · " .. when
                elseif j.status == "missing" then
                    cookie_line = "⚠️ 未配置（匿名，弹幕数量受限） · " .. when
                else
                    cookie_line = "⚠️ 校验失败（网络原因，稍后自动重试） · " .. when
                end
            end
        end
    end
    local dd_txt = (DANMAKU.anime and DANMAKU.anime ~= "")
        and ("✅ 已识别：《" .. tostring(DANMAKU.anime) .. "》" .. ((DANMAKU.episode and DANMAKU.episode ~= "") and (" · " .. tostring(DANMAKU.episode)) or ""))
        or "➖ 未识别到条目（按文件名解析番名与集数）"

    local detail_items = {
        { title = "① 自建弹幕接口（danmu_api）", hint = note_api, selectable = false },
        { title = "② 内置 B站", hint = note_bili, selectable = false },
        { title = "③ 弹弹play 弹幕库（兜底）", hint = note_dd, selectable = false },
        { separator = true },
        { title = "B站 Cookie 状态", hint = cookie_line, selectable = false },
        { title = "弹弹play 剧集识别", hint = dd_txt, selectable = false },
        { separator = true },
        { title = "实际匹配结果", hint = result_hint, selectable = false, items = result_items },
    }

    props.items = {
        { title = "手动搜索 B站 弹幕", hint = "输入番名（可带季/集）手动换源", value = { "script-message-to", mp.get_script_name(), "open_bili_manual_search" }, keep_open = false, selectable = true },
        { title = "用当前解析立即搜索", hint = "按脚注中的番名/集数重跑匹配，完成后本菜单原地刷新", value = { "script-message-to", mp.get_script_name(), "bili_search_now" }, keep_open = true, selectable = true },
        { separator = true },
        { title = "弹幕源详情", hint = ("①%s ②%s ③%s"):format(mark_api, mark_bili, mark_dd), items = detail_items },
        { title = "查看 bili_alias 番名映射", hint = "番名 → B站搜索名 的映射表", value = { "script-message-to", mp.get_script_name(), "bili_show_alias" }, keep_open = false, selectable = true },
        -- [lc-1170] 延迟是「每个弹幕源」的属性，与本面板同属弹幕来源域（处理器在 main.lua 路由）
        { title = "弹幕源延迟设置", value = { "script-message-to", mp.get_script_name(), "open_source_delay_menu" }, keep_open = false, selectable = true },
    }
    return props
end

-- [lc-1267] 菜单开着时原地刷新：update-menu 按 type 匹配已打开菜单，未打开时 uosc 忽略（无害）。
-- 由 extra.lua（自动补源完成/失败）与 main.lua（手动选定完成）在状态变更后调用。
function refresh_bili_config_menu()
    if not uosc_available then return end
    local ok, props = pcall(build_bili_config_menu_props)
    if ok and type(props) == "table" then
        mp.commandv("script-message-to", "uosc", "update-menu", utils.format_json(props))
    end
end

function open_bili_config_menu()
    if not uosc_available then
        show_message("弹幕配置菜单需在 uosc 控制栏下使用", 3)
        return
    end
    mp.commandv("script-message-to", "uosc", "open-menu", utils.format_json(build_bili_config_menu_props()))
end
-- ===================== B站弹幕手动搜索 =====================
-- 手动输入番名（可尾随集数，如「番名 3」），直连 B站 搜索并叠加弹幕。
bili_manual_title_cache = nil

-- 第 1 步：uosc 输入条（自动填入解析到的「番名 + 季 + 集」，与手动搜索后的候选列表流程衔接）
function open_bili_manual_search()
    if not uosc_available then
        show_message("手动搜索需在 uosc 控制栏下使用", 3)
        return
    end
    -- 自动预填：优先弹弹play干净标题，否则用 parse_title 从文件/媒体标题解析出的番名；
    -- 同时把「季 / 集」附加到预填串（形如「番名 S2 第5集」），用户可直接回车或改。
    local suggestion = ""
    local base_title = (DANMAKU.anime and DANMAKU.anime ~= "" and DANMAKU.anime) or (function()
        local t, _, _ = parse_title()
        return t or ""
    end)() or ""
    if base_title ~= "" then
        -- 季：从 parse_title 第二返回值
        local _, snum, _ = parse_title()
        local bseason = (snum and tonumber(snum) and tonumber(snum) > 0) and tonumber(snum) or 0
        -- 集：弹弹play 优先，否则 parse_title 第三返回值
        local ep = nil
        if DANMAKU.episode then
            ep = tonumber(tostring(DANMAKU.episode):match("%d+"))
        end
        if not ep then
            local _, _, enum = parse_title()
            ep = enum and tonumber(enum) or nil
        end
        suggestion = base_title
        if bseason and bseason > 0 then suggestion = suggestion .. " S" .. tostring(bseason) end
        if ep and ep > 0 then suggestion = suggestion .. " 第" .. tostring(ep) .. "集" end
    end
    local menu_props = {
        type = "menu_bili_manual",
        title = "输入番名搜索 B站弹幕（可加空格+集数/季，如：番名 第5集 或 番名 S2 第5集）",
        search_style = "palette",
        search_debounce = "submit",
        search_suggestion = suggestion,
        on_search = { "script-message-to", mp.get_script_name(), "bili_manual_search_event" },
        footnote = "输入后回车搜索（将展示候选列表供手动选择）",
        items = {},
    }
    mp.commandv("script-message-to", "uosc", "open-menu", utils.format_json(menu_props))
end

-- 第 2 步：选择搜索方式（仅番名 / 指定集数）
function open_bili_manual_choose(title)
    if not uosc_available then
        show_message("需在 uosc 控制栏下使用", 3)
        return
    end
    if title then bili_manual_title_cache = title end
    local items = {
        {
            title = "手动搜索：" .. (bili_manual_title_cache or "（未知）"),
            bold = true, italic = true, keep_open = true, selectable = false,
        },
        {
            title = "▶ 仅番名搜索（单集/第1话）",
            value = { "script-message-to", mp.get_script_name(), "bili_manual_do", "0" },
            keep_open = false, selectable = true,
        },
        {
            title = "▶ 指定集数搜索",
            value = { "script-message-to", mp.get_script_name(), "open_bili_manual_ep" },
            keep_open = false, selectable = true,
        },
    }
    local menu_props = {
        type = "menu_bili_manual_choose",
        title = "选择搜索方式",
        search_style = "disabled",
        items = items,
    }
    mp.commandv("script-message-to", "uosc", "open-menu", utils.format_json(menu_props))
end

-- 第 3 步：输入集数
function open_bili_manual_ep_menu()
    if not uosc_available then
        show_message("需在 uosc 控制栏下使用", 3)
        return
    end
    if not bili_manual_title_cache then
        show_message("请先输入番名", 3)
        return
    end
    local menu_props = {
        type = "menu_bili_manual_ep",
        title = "输入集数（如 3，留空=单集/第1话）",
        search_style = "palette",
        search_debounce = "submit",
        on_search = { "script-message-to", mp.get_script_name(), "bili_manual_do" },
        footnote = "输入数字后回车",
        items = {},
    }
    mp.commandv("script-message-to", "uosc", "open-menu", utils.format_json(menu_props))
end

-- 查看 bili_alias.txt 中「真实番名 = B站搜索词」的映射
function open_bili_alias_menu()
    if not uosc_available then
        show_message("需在 uosc 控制栏下使用", 3)
        return
    end
    local alias_path = utils.join_path(mp.get_script_directory(), "bili_alias.txt")
    local items = {}
    table.insert(items, {
        title = "bili_alias.txt 映射",
        bold = true, italic = true, keep_open = true, selectable = false,
    })
    table.insert(items, {
        title = "格式：真实番名 = B站搜索词",
        keep_open = true, selectable = false,
    })
    local f = io.open(alias_path, "r")
    if not f then
        table.insert(items, { title = "（文件不存在，暂无映射）", keep_open = true, selectable = false })
    else
        local has = false
        for line in f:lines() do
            line = line:match("^%s*(.-)%s*$")
            if line ~= "" and not line:match("^#") then
                has = true
                table.insert(items, { title = line, keep_open = true, selectable = false })
            end
        end
        f:close()
        if not has then
            table.insert(items, { title = "（暂无映射，每行写 真实番名=搜索词）", keep_open = true, selectable = false })
        end
    end
    table.insert(items, {
        title = "编辑路径：" .. alias_path,
        keep_open = true, selectable = false,
    })
    local menu_props = {
        type = "menu_bili_alias",
        title = "B站番名映射",
        search_style = "disabled",
        items = items,
    }
    mp.commandv("script-message-to", "uosc", "open-menu", utils.format_json(menu_props))
end

-- ===================== B站弹幕候选列表（手动搜索后展示，供用户选定具体视频）=====================
-- 经本地 shim(127.0.0.1:22347) 的 /danmaku-candidates 查询候选并展示为菜单。
function open_bili_candidates_menu(title, ep, season)
    if not uosc_available then
        show_message("需在 uosc 控制栏下使用", 3)
        return
    end
    local items = {
        { title = "🔍 正在搜索 B站 候选视频…", keep_open = true, selectable = false, italic = true },
    }
    local menu_props = {
        type = "menu_bili_candidates",
        title = ("B站候选：「%s」%s"):format(title, (ep and ep > 0) and ("第" .. ep .. "集") or ""),
        search_style = "disabled",
        items = items,
    }
    mp.commandv("script-message-to", "uosc", "open-menu", utils.format_json(menu_props))

    -- 异步查询候选
    local params = "title=" .. url_encode(title) .. "&ep=" .. tostring(ep or 0)
    if season and season > 0 then params = params .. "&season=" .. tostring(season) end
    local api = "http://127.0.0.1:22347/danmaku-candidates?" .. params
    local platform = mp.get_property("platform") or ""
    local res
    if platform == "windows" then
        res = mp.command_native({
            name = "subprocess",
            args = { "powershell", "-NoProfile", "-NonInteractive", "-Command",
                     -- [lc-1092] PowerShell 用「控制台输出编码」写 stdout: 中文机器上那是 GBK,
                     -- shim 返回的 UTF-8 JSON 会被整段重编码(实测 摇 e69187 → GBK d2a1),
                     -- mpv/Lua 再按 UTF-8 读 → 候选标题全是乱码; 西语机器(CP437)更直接变一串 ?。
                     -- 显式钉成 UTF8 后与本机代码页无关(三种代码页实测均产出正确 UTF-8 字节)。
                     "[Console]::OutputEncoding=[Text.Encoding]::UTF8; try { (Invoke-WebRequest -Uri '" .. api .. "' -UseBasicParsing -TimeoutSec 60).Content } catch { Write-Output ('ERR:' + $_.Exception.Message) }" },
            capture_stdout = true, capture_stderr = true,
        })
    else
        res = mp.command_native({ name = "subprocess", args = { "curl", "-sS", "--max-time", "60", api }, capture_stdout = true, capture_stderr = true })
    end
    if not res then
        open_bili_candidates_error("请求失败（shim 未启动？）")
        return
    end
    local body = (res.stdout or ""):gsub("\\r?\\n$", "")
    if body:sub(1, 4) == "ERR:" then
        open_bili_candidates_error(body:sub(5))
        return
    end
    local ok_parse, parsed = pcall(utils.parse_json, body)
    if not ok_parse or type(parsed) ~= "table" then
        open_bili_candidates_error("响应解析失败")
        return
    end
    if not parsed.ok then
        open_bili_candidates_error(parsed.error or "未知错误")
        return
    end
    local cands = parsed.candidates or {}
    if #cands == 0 then
        open_bili_candidates_error("未找到候选（番名不匹配或网络受限）")
        return
    end
    -- 展示候选列表
    local new_items = {}
    table.insert(new_items, { title = ("✅ 共 %d 个候选，选择一个视频使用其弹幕："):format(#cands), bold = true, italic = true, keep_open = true, selectable = false })
    local has_self_hosted = false
    for _, c in ipairs(cands) do
        local src_label = ({ bangumi = "番剧区", video = "视频区" })[c.source] or c.source
        -- [lc-1175] 标签拆分：BAD_TITLE 命中(解说/reaction/二创…)才是真该避开的「⚠️解说/二创」；
        -- 仅「全N集」式多P 正片合集标「📁合集」（lc-1172 起选优不排除，已可按集取分P 放心选）。
        local tag = ""
        if c.is_compilation then
            tag = c.bad_title and " ⚠️解说/二创" or " 📁合集"
        end
        -- [lc-1101] 自建弹幕接口(danmu_api)的候选用 dmapi:<episodeId> 伪 bvid，不能当 BV 号显示
        local cb = tostring(c.bvid or "")
        local is_self = cb:sub(1, 6) == "dmapi:"
        if is_self then has_self_hosted = true end
        -- [lc-1171] 候选带 B站官方弹幕数：💬N=弹幕条数；0 弹幕的候选在 hint 里直接警告（盲选必失败）
        local dmTag = ""
        local dmWarn = ""
        if c.danmaku_count ~= nil then
            if (c.danmaku_count or 0) > 0 then
                dmTag = (" 💬%d"):format(c.danmaku_count)
            else
                dmTag = " 💬0"
                dmWarn = " ⚠️该视频无人发弹幕"
            end
        end
        -- [lc-1195] 合集候选（📁合集 且非自建源）→ 点击展开分P 明细菜单，由用户手动选定具体分P；
        -- 非合集/自建源保持原直选行为。
        if c.is_compilation and not is_self and cb ~= "" then
            table.insert(new_items, {
                title = ("%s [%s] %s%s%s"):format(c.title, c.bvid or "?", src_label, tag, dmTag),
                hint = ("📁合集 → 点击展开分P 明细列表"):format() .. dmWarn,
                value = { "script-message-to", mp.get_script_name(), "bili_open_pages", c.bvid or "", title, tostring(ep or 0), c.title or "" },
                keep_open = false, selectable = true,
            })
        else
            table.insert(new_items, {
                title = ("%s [%s] %s%s%s"):format(c.title, c.bvid or "?", src_label, tag, dmTag),
                hint = is_self and ("自建源 ID: %s"):format(cb:sub(7)) or ("BV: %s%s"):format(c.bvid or "未知", dmWarn),
                value = { "script-message-to", mp.get_script_name(), "bili_manual_pick", c.bvid or "", title, tostring(ep or 0) },
                keep_open = false, selectable = true,
            })
        end
    end
    local props = {
        type = "menu_bili_candidates",
        title = ("%s：「%s」%s"):format(has_self_hosted and "弹幕候选" or "B站候选", title, (ep and ep > 0) and ("第" .. ep .. "集") or ""),
        search_style = "disabled",
        items = new_items,
    }
    -- [lc-1267] 加载占位 → 结果用 update-menu 原地替换（不重建菜单、不闪、保留滚动位置；菜单已被
    -- 用户关掉时 uosc 忽略，不再像 open-menu 那样把已关闭的菜单「复活」）
    mp.commandv("script-message-to", "uosc", "update-menu", utils.format_json(props))
end

-- [lc-1195] 合集候选 → 分P 明细菜单：逐分P 列出（Pn 标题），选择后以该分P 的 cid 精确拉取弹幕；
-- 顶部保留「按集数自动匹配」入口（不手动选分P 时走 ep_num 自动匹配）。
function open_bili_pages_menu(bvid, title, ep, cand_title)
    if not uosc_available then
        show_message("需在 uosc 控制栏下使用", 3)
        return
    end
    local items = {
        { title = "🔍 正在获取分P 列表…", keep_open = true, selectable = false, italic = true },
    }
    local menu_props = {
        type = "menu_bili_pages",
        title = ("分P 明细：%s"):format(cand_title or bvid),
        search_style = "disabled",
        items = items,
    }
    mp.commandv("script-message-to", "uosc", "open-menu", utils.format_json(menu_props))

    local function url_encode(str)
        if not str then return "" end
        return (str:gsub("([^%w%-%.%_%~])", function(c) return string.format("%%%02X", string.byte(c)) end))
    end
    local api = "http://127.0.0.1:22347/danmaku-pages?bvid=" .. url_encode(bvid)
    local platform = mp.get_property("platform") or ""
    local res
    if platform == "windows" then
        res = mp.command_native({
            name = "subprocess",
            args = { "powershell", "-NoProfile", "-NonInteractive", "-Command",
                     "[Console]::OutputEncoding=[Text.Encoding]::UTF8; try { (Invoke-WebRequest -Uri '" .. api .. "' -UseBasicParsing -TimeoutSec 30).Content } catch { Write-Output ('ERR:' + $_.Exception.Message) }" },
            capture_stdout = true, capture_stderr = true,
        })
    else
        res = mp.command_native({ name = "subprocess", args = { "curl", "-sS", "--max-time", "30", api }, capture_stdout = true, capture_stderr = true })
    end
    if not res then
        open_bili_candidates_error("请求失败（shim 未启动？）", "menu_bili_pages")
        return
    end
    local body = (res.stdout or ""):gsub("\\r?\\n$", "")
    if body:sub(1, 4) == "ERR:" then
        open_bili_candidates_error(body:sub(5), "menu_bili_pages")
        return
    end
    local ok_parse, parsed = pcall(utils.parse_json, body)
    if not ok_parse or type(parsed) ~= "table" then
        open_bili_candidates_error("响应解析失败", "menu_bili_pages")
        return
    end
    if not parsed.ok then
        open_bili_candidates_error(parsed.error or "未知错误", "menu_bili_pages")
        return
    end
    local pages = parsed.pages or {}
    if #pages == 0 then
        open_bili_candidates_error("该视频没有分P 列表", "menu_bili_pages")
        return
    end

    local new_items = {}
    table.insert(new_items, { title = ("✅ 「%s」共 %d 个分P，选择具体分P 使用其弹幕："):format(cand_title or bvid, #pages), bold = true, italic = true, keep_open = true, selectable = false })
    if ep and ep > 0 then
        table.insert(new_items, { title = ("⚡ 自动匹配第 %d 集(按分P 标题)"):format(ep), hint = "不手动指定分P，按集数自动匹配（推荐）",
            value = { "script-message-to", mp.get_script_name(), "bili_manual_pick", bvid, title, tostring(ep) },
            keep_open = false, selectable = true })
    end
    for _, p in ipairs(pages) do
        table.insert(new_items, {
            title = ("P%d  %s"):format(p.page or 0, p.part or ""),
            hint = ("cid: %s"):format(p.cid or "?"),
            value = { "script-message-to", mp.get_script_name(), "bili_manual_pick", bvid, title, tostring(ep or 0), tostring(p.cid or "") },
            keep_open = false, selectable = true,
        })
    end
    local props = {
        type = "menu_bili_pages",
        title = ("分P 明细：%s"):format(cand_title or bvid),
        search_style = "disabled",
        items = new_items,
    }
    -- [lc-1267] 原地替换加载占位（同候选菜单）
    mp.commandv("script-message-to", "uosc", "update-menu", utils.format_json(props))
end

-- [lc-1267] menu_type：错误要原地替换的菜单类型（候选=menu_bili_candidates / 分P=menu_bili_pages）
function open_bili_candidates_error(msg_text, menu_type)
    if not uosc_available then
        show_message("候选搜索失败：" .. msg_text, 4)
        return
    end
    local items = {
        { title = "❌ 候选搜索失败：" .. msg_text, keep_open = true, selectable = false, bold = true },
        { title = "点击下方返回重新搜索", keep_open = true, selectable = false },
        { title = "▶ 重新搜索", value = { "script-message-to", mp.get_script_name(), "open_bili_manual_search" }, keep_open = false, selectable = true },
    }
    local props = { type = menu_type or "menu_bili_candidates", title = "候选搜索失败", search_style = "disabled", items = items }
    -- [lc-1267] 原地替换加载占位；菜单已被关闭时忽略
    mp.commandv("script-message-to", "uosc", "update-menu", utils.format_json(props))
end

-- 打开弹幕源添加管理菜单
function open_add_menu_get()
    mp.commandv('script-message-to', 'console', 'disable')
    input.get({
        prompt = 'Input url:',
        submit = function(text)
            input.terminate()
            mp.commandv("script-message-to", mp.get_script_name(), "add-source-event", text)
        end
    })
end

function open_add_menu_uosc()
    local sources = {}
    -- [lc-1302] 弹幕详情入口：清空当前弹幕与本地缓存后重新自动匹配拉取
    -- （屏蔽类型切换后 B站 缓存需重拉才生效，这里是一键重来的通道；无源时也可用）
    table.insert(sources, {
        title = "▶ 清除弹幕并重新拉取",
        hint = "清空当前弹幕与相关缓存，重新自动匹配",
        value = "refetch-all",
        keep_open = false,
        selectable = true,
    })
    for url, source in pairs(DANMAKU.sources) do
        if source.fname then
            local item = {title = url, value = url, keep_open = true,}
            if source.from == "api_server" then
                if source.blocked then
                    item.hint = "来源：弹幕服务器（已屏蔽）"
                    item.actions = {{icon = "check", name = "unblock"},}
                else
                    item.hint = "来源：弹幕服务器（未屏蔽）"
                    item.actions = {{icon = "not_interested", name = "block"},}
                end
            else
                item.hint = "来源：用户添加"
                item.actions = {{icon = "delete", name = "delete"},}
            end
            table.insert(sources, item)
        end
    end
    local menu_props = {
        type = "menu_source",
        title = "在此输入源地址url",
        search_style = "palette",
        search_debounce = "submit",
        on_search = { "script-message-to", mp.get_script_name(), "add-source-event" },
        footnote = "使用enter或ctrl+enter进行添加",
        items = sources,
        item_actions_place = "outside",
        callback = {mp.get_script_name(), 'setup-danmaku-source'},
    }
    local json_props = utils.format_json(menu_props)
    mp.commandv("script-message-to", "uosc", "open-menu", json_props)
end

function open_add_menu()
    if uosc_available then
        open_add_menu_uosc()
    elseif input_loaded then
        open_add_menu_get()
    end
end

-- 打开弹幕内容菜单
function open_content_menu(pos)
    local items = {}
    local time_pos = pos or mp.get_property_native("time-pos")
    local duration = mp.get_property_number("duration", 0)

    if COMMENTS ~= nil then
        for _, event in ipairs(COMMENTS) do
            local text = event.clean_text:gsub("^m%s[mbl%s%-%d%.]+$", ""):gsub("^%s*(.-)%s*$", "%1")
            local delay = get_delay_for_time(DELAYS, event.start_time)
            local start_time = event.start_time + delay
            local end_time = event.end_time + delay
            if text and text ~= "" and start_time >= 0 and start_time <= duration then
                table.insert(items, {
                    title = abbr_str(text, 60),
                    hint = seconds_to_time(start_time),
                    value = { "seek", start_time, "absolute" },
                    active = time_pos >= start_time and time_pos <= end_time,
                })
            end
        end
    end

    local menu_props = {
        type = "menu_content",
        title = "弹幕内容",
        footnote = "使用 / 打开搜索",
        items = items
    }
    local json_props = utils.format_json(menu_props)

    if uosc_available then
        mp.commandv("script-message-to", "uosc", "open-menu", json_props)
    elseif input_loaded then
        open_menu_select(items, true)
    end
end

local menu_items_config = {
    bold = { title = "粗体", hint = options.bold, original = options.bold,
        footnote = "true / false", },
    fontsize = { title = "大小", hint = options.fontsize, original = options.fontsize,
        scope = { min = 0, max = math.huge }, footnote = "请输入整数(>=0)", },
    outline = { title = "描边", hint = options.outline, original = options.outline,
        scope = { min = 0.0, max = 4.0 }, footnote = "输入范围：(0.0-4.0)" },
    shadow = { title = "阴影", hint = options.shadow, original = options.shadow,
        scope = { min = 0, max = math.huge }, footnote = "请输入整数(>=0)", },
    scrolltime = { title = "速度", hint = options.scrolltime, original = options.scrolltime,
        scope = { min = 1, max = math.huge }, footnote = "请输入整数(>=1)", },
    opacity = { title = "透明度", hint = options.opacity, original = options.opacity,
        scope = { min = 0, max = 1 }, footnote = "输入范围：0（完全透明）到1（不透明）", },
    displayarea = { title = "弹幕显示范围", hint = options.displayarea, original = options.displayarea,
        scope = { min = 0.0, max = 1.0 }, footnote = "显示范围(0.0-1.0)", },
}
-- 创建一个包含键顺序的表，这是样式菜单的排布顺序
local ordered_keys = {"bold", "fontsize", "outline", "shadow", "scrolltime", "opacity", "displayarea"}

-- [lc-1252] 样式改动持久化：把当前样式键合并回 script-opts/uosc_danmaku.conf。
-- 只替换自身管理的样式键所在行，其余行（含密文凭证/开关等）逐字节保留；键不存在时追加到尾部。
-- mpv 每次启动重新读 conf，菜单改动因此跨会话生效。bold 写 yes/no 与主进程写法一致。
local STYLE_PERSIST_KEYS = { "bold", "fontsize", "outline", "shadow", "scrolltime", "opacity", "displayarea" }

function persist_style_opts()
    local conf_path = mp.command_native({ "expand-path", "~~/script-opts/uosc_danmaku.conf" })
    if type(conf_path) ~= "string" or conf_path == "" then
        mp.msg.warn("样式持久化失败：无法解析 uosc_danmaku.conf 路径")
        return
    end
    local vals = {}
    for _, key in ipairs(STYLE_PERSIST_KEYS) do
        local v = options[key]
        if key == "bold" then
            vals[key] = v and "yes" or "no"
        elseif v ~= nil then
            vals[key] = tostring(v)
        end
    end
    local lines = {}
    local fin = io.open(conf_path, "r")
    if fin then
        for line in fin:lines() do
            table.insert(lines, line)
        end
        fin:close()
    end
    local seen = {}
    for i, line in ipairs(lines) do
        local key = line:match("^%s*([%w_]+)%s*=")
        if key then
            for _, sk in ipairs(STYLE_PERSIST_KEYS) do
                if key == sk and vals[sk] ~= nil then
                    seen[sk] = true
                    lines[i] = sk .. "=" .. vals[sk]
                    break
                end
            end
        end
    end
    for _, sk in ipairs(STYLE_PERSIST_KEYS) do
        if not seen[sk] and vals[sk] ~= nil then
            table.insert(lines, sk .. "=" .. vals[sk])
        end
    end
    local fout = io.open(conf_path, "w")
    if fout then
        fout:write(table.concat(lines, "\n"))
        if #lines > 0 then fout:write("\n") end
        fout:close()
        mp.msg.info("弹幕样式已持久化: " .. conf_path)
    else
        mp.msg.warn("样式持久化失败：无法写入 " .. conf_path)
    end
end

-- 设置弹幕样式菜单（样式改动自动持久化到 script-opts/uosc_danmaku.conf）
-- [lc-1268] 屏蔽类型收编进本菜单（子菜单 + checkbox 式条目）：此前注释写「屏蔽类型由 Electron
-- 设置面板管理」，MPV 侧只有 Ctrl+k 快捷键一条暗道，看样式菜单的用户无从发现。两者本就共用
-- danmaku_block_types.json 真源，直接以子菜单形态并入，点击即切换、即时重过滤、菜单不关。
-- [lc-1285] add_danmaku_setup 增加 submenu 形参：屏蔽类型切换后原地重开并停在该子菜单，
-- 而不是把用户弹回样式菜单根（toggle_block_type 的 src="style" 分支传 "按类型屏蔽"）。
-- 前向声明：BLOCK_TYPE_DEFS/read_block_types_file 定义在下方「弹幕屏蔽类型快捷开关」段，
-- 本函数运行时（脚本消息回调）才会取值，前向声明让词法可见（否则解析为全局 nil）。
local BLOCK_TYPE_DEFS, read_block_types_file
local BLOCK_TYPES_SUBMENU_ID = "按类型屏蔽"
function add_danmaku_setup(actived, status, submenu)
    if not uosc_available then
        show_message("无uosc UI框架，不支持使用该功能", 2)
        return
    end

    local items = {}
    for _, key in ipairs(ordered_keys) do
        local config = menu_items_config[key]
        local item_config = {
            title = config.title,
            hint = "目前：" .. tostring(config.hint),
            active = key == actived,
            keep_open = true,
            selectable = true,
        }
        if config.hint ~= config.original then
            local original_str = tostring(config.original)
            item_config.actions = {{icon = "refresh", name = key, label = "恢复默认配置 < " .. original_str .. " >"}}
        end
        table.insert(items, item_config)
    end

    -- [lc-1268] 「按类型屏蔽」子菜单（与 Ctrl+k / 设置面板同一真源 danmaku_block_types.json）
    local blocked = {}
    for _, v in ipairs(read_block_types_file()) do blocked[v] = true end
    local block_children = {}
    local blocked_count = 0
    for _, def in ipairs(BLOCK_TYPE_DEFS) do
        local is_blocked = blocked[def.key] == true
        if is_blocked then blocked_count = blocked_count + 1 end
        table.insert(block_children, {
            title = (is_blocked and "✗ 已屏蔽：" or "✓ 显示中：") .. def.label,
            hint = is_blocked and "点击恢复显示" or "点击屏蔽该类型",
            value = { "script-message-to", mp.get_script_name(), "toggle-block-type", def.key, "style" },
            keep_open = true, selectable = true,
        })
    end
    if blocked_count > 0 then
        table.insert(block_children, {
            title = "▶ 全部显示（清空屏蔽）",
            value = { "script-message-to", mp.get_script_name(), "toggle-block-type", "clear", "style" },
            keep_open = true, selectable = true,
        })
    end
    local block_summary = blocked_count == 0 and "全部显示" or ("已屏蔽 " .. blocked_count .. " 类")
    table.insert(items, { separator = true })
    local block_item = {
        title = BLOCK_TYPES_SUBMENU_ID,
        hint = block_summary .. "（滚动/顶部/底部/逆向/高级/彩色）",
        items = block_children,
    }
    table.insert(items, block_item)

    local menu_props = {
        type = "menu_style",
        title = "弹幕样式",
        search_style = "disabled",
        footnote = "样式更改将自动保存，下次播放自动生效；屏蔽类型与设置面板实时同步",
        item_actions_place = "outside",
        items = items,
        callback = { mp.get_script_name(), 'setup-danmaku-style'},
    }

    local actions = "open-menu"
    if status ~= nil then
        if status == "updata" then
            -- "updata" 模式会保留输入框文字
            menu_props.title = "  " .. menu_items_config[actived]["footnote"]
            actions = "update-menu"
        elseif status == "refresh" then
            -- "refresh" 模式会清除输入框文字
            menu_props.title = "  " .. menu_items_config[actived]["footnote"]
        elseif status == "error" then
            menu_props.title = "输入非数字字符或范围出错"
            mp.add_timeout(1.0, function() add_danmaku_setup(actived, "updata") end)
        end
        menu_props.search_style = "palette"
        menu_props.search_debounce = "submit"
        menu_props.footnote = menu_items_config[actived]["footnote"] or ""
        menu_props.on_search = { "script-message-to", mp.get_script_name(), "setup-danmaku-style", actived }
    end

    local json_props = utils.format_json(menu_props)
    -- [lc-1285] submenu 定位：屏蔽类型切换后原地重开并停在该子菜单，而不是把用户弹回样式菜单根。
    -- 只在 open-menu 时用：update-menu 走 Menu:update()，它靠旧 id 保留 current 菜单
    -- （见 uosc elements/Menu.lua 的 old_current_id / by_id），本就是原地刷新，无需定位。
    -- open-menu 带 submenu_id 时 uosc 会 open 后立刻 activate_menu（lib/menus.lua），所以
    -- 带定位时只发这一条，不能先发一条无定位的再发定位的（会开两遍、闪一下）。
    if actions == "open-menu" and submenu ~= nil then
        mp.commandv("script-message-to", "uosc", "open-menu", json_props, submenu)
    else
        mp.commandv("script-message-to", uosc_available and "uosc" or "ignore", actions, json_props)
    end
end

-- 设置弹幕源延迟菜单
function danmaku_delay_setup(source_url)
    if not uosc_available then
        show_message("无uosc UI框架，不支持使用该功能", 2)
        return
    end

    local sources = {}
    for url, source in pairs(DANMAKU.sources) do
        if source.fname and not source.blocked then
            local delay = 0
            if source.delay_segments then
                for _, seg in ipairs(source.delay_segments) do
                    if seg.start == 0 then
                        delay = seg.delay or 0
                        break
                    end
                end
            end
            local item = {title = url, value = url, keep_open = true,}
            item.hint = "当前弹幕源延迟:" .. string.format("%.1f", delay + 1e-10) .. "秒"
            item.active = url == source_url
            table.insert(sources, item)
        end
    end

    local menu_props = {
        type = "menu_delay",
        title = "弹幕源延迟设置",
        search_style = "disabled",
        items = sources,
        callback = {mp.get_script_name(), 'setup-source-delay'},
    }
    if source_url ~= nil then
        menu_props.title = "请输入数字，单位（秒）/ 或者按照形如\"14m15s\"的格式输入分钟数加秒数"
        menu_props.search_style = "palette"
        menu_props.search_debounce = "submit"
        menu_props.on_search = { "script-message-to", mp.get_script_name(), "setup-source-delay", source_url }
    end

    local json_props = utils.format_json(menu_props)
    mp.commandv("script-message-to", "uosc", "open-menu", json_props)
end


-- ===================== 弹幕屏蔽类型快捷开关 =====================
-- [lc-1302] danmaku_block_types.json 为唯一真源：本菜单（快捷键 Ctrl+k）与设置面板
-- （网页端/桌面端「弹幕屏蔽与样式」卡）共用同一文件，任意一侧改动即时互相同步——
--   MPV 侧切换 → 写回文件 + reload_block_types + load_danmaku 重新过滤，立即生效；
--   面板侧改动 → 下方 2s 文件监听自动重读生效（面板打开时也会回读本文件回填勾选）。
-- 注意：B站 源的弹幕在 bili_danmaku.js 拉取落盘时已按当时类型预过滤，对本集「取消屏蔽」
-- 需等下次拉取；弹弹play / 自建源为原始数据，本端过滤，切换立即完整生效。
-- 赋值给上方前向声明的局部变量（不得再写 local：会新建同名变量、让 add_danmaku_setup 内的
-- 引用仍指向 nil 前向声明，运行时炸 nil 调用）
BLOCK_TYPE_DEFS = {
    { key = "scroll",   label = "滚动弹幕" },
    { key = "top",      label = "顶部弹幕" },
    { key = "bottom",   label = "底部弹幕" },
    { key = "reverse",  label = "逆向弹幕" },
    { key = "advanced", label = "高级弹幕" },
    { key = "color",    label = "彩色弹幕" },
}
local block_types_file_path_cache = nil
local block_types_last_content = nil
local block_types_self_write_at = 0

local function get_block_types_path()
    if not block_types_file_path_cache then
        block_types_file_path_cache = mp.command_native({ "expand-path", options.block_types_path })
    end
    return block_types_file_path_cache
end

-- 读真源文件，返回字符串数组（缺文件/坏 JSON 一律回落空数组 = 全部显示）
read_block_types_file = function()
    local arr = {}
    local content = read_file(get_block_types_path())
    if content then
        local parsed = utils.parse_json(content)
        if type(parsed) == "table" then
            for _, v in ipairs(parsed) do
                if type(v) == "string" then arr[#arr + 1] = v end
            end
        end
    end
    return arr
end

local function write_block_types_file(arr)
    local sorted = {}
    for _, v in ipairs(arr) do sorted[#sorted + 1] = v end
    table.sort(sorted)
    local f = io.open(get_block_types_path(), "w")
    if not f then
        msg.warn("[lc-1302] 弹幕屏蔽类型写入失败: " .. get_block_types_path())
        return false
    end
    f:write(utils.format_json(sorted))
    f:close()
    block_types_self_write_at = os.time()
    return true
end

local function block_type_label(key)
    for _, def in ipairs(BLOCK_TYPE_DEFS) do
        if def.key == key then return def.label end
    end
    return key
end

function open_block_types_menu()
    if not uosc_available then
        show_message("弹幕屏蔽菜单需在 uosc 控制栏下使用", 3)
        return
    end
    local blocked = {}
    for _, v in ipairs(read_block_types_file()) do blocked[v] = true end

    local items = {}
    table.insert(items, {
        title = "屏蔽类型（与设置面板实时同步）",
        keep_open = true, selectable = false, muted = true, italic = true,
    })
    for _, def in ipairs(BLOCK_TYPE_DEFS) do
        local is_blocked = blocked[def.key] == true
        table.insert(items, {
            title = (is_blocked and "✗ 已屏蔽：" or "✓ 显示中：") .. def.label,
            hint = is_blocked and "点击恢复显示" or "点击屏蔽该类型",
            value = { "script-message-to", mp.get_script_name(), "toggle-block-type", def.key },
            keep_open = true, selectable = true,
        })
    end
    if next(blocked) ~= nil then
        table.insert(items, {
            title = "▶ 全部显示（清空屏蔽）",
            value = { "script-message-to", mp.get_script_name(), "toggle-block-type", "clear" },
            keep_open = true, selectable = true,
        })
    end

    mp.commandv("script-message-to", "uosc", "open-menu", utils.format_json({
        type = "menu_block_types",
        title = "弹幕屏蔽",
        search_style = "disabled",
        items = items,
    }))
end

-- 切换/清空一个屏蔽类型并立即生效。key 为 6 类之一或 "clear"。
-- [lc-1268] src="style"：从样式菜单的「按类型屏蔽」子菜单进入 → 刷新样式菜单（原地 update-menu），
-- 否则维持旧行为重开 Ctrl+k 独立菜单。两者读同一真源，状态天然一致。
function toggle_block_type(key, src)
    local arr = read_block_types_file()
    if key == "clear" then
        if not write_block_types_file({}) then return end
        show_message("已清空弹幕屏蔽：全部类型显示", 3)
    else
        local exists, kept = false, {}
        for _, v in ipairs(arr) do
            if v == key then exists = true else kept[#kept + 1] = v end
        end
        if not exists then kept[#kept + 1] = key end
        if not write_block_types_file(kept) then return end
        show_message(exists and ("已取消屏蔽：" .. block_type_label(key))
            or ("已屏蔽：" .. block_type_label(key) .. "（Ctrl+k 可恢复）"), 3)
    end
    reload_block_types()
    -- 立即重过滤：从本地源文件重新转换（不重拉网络）；B站 预过滤缓存见上方注释
    if ENABLED and COMMENTS ~= nil then
        load_danmaku(true, true)
    end
    if src == "style" then
        -- [lc-1285] 传 submenu 让样式菜单重开后直接停在「按类型屏蔽」，用户能连续点多项；
        -- 此前重开在根菜单，视觉上等于「点了没反应/被弹回」。
        add_danmaku_setup(nil, nil, BLOCK_TYPES_SUBMENU_ID)
    else
        open_block_types_menu()
    end
end

mp.register_script_message("open_block_types_menu", open_block_types_menu)
mp.register_script_message("toggle-block-type", function(key, src) toggle_block_type(key, src) end)
mp.register_script_message("clear-danmaku-refetch", function() clear_danmaku_refetch() end)
mp.add_key_binding(options.open_block_types_menu_key, "open_block_types_menu", open_block_types_menu)

-- [lc-1302] 面板 → MPV 同步：轮询真源文件内容（文件仅几十字节，2s 一次开销可忽略）。
-- 变更且非本端刚写入 → 重读 + 重过滤。未加载弹幕时静默（下次 load 自然生效）。
mp.add_periodic_timer(2, function()
    if not ENABLED or COMMENTS == nil then return end
    local content = read_file(get_block_types_path()) or ""
    if block_types_last_content == nil then
        block_types_last_content = content
        return
    end
    if content == block_types_last_content then return end
    block_types_last_content = content
    if os.time() - block_types_self_write_at < 5 then return end
    reload_block_types()
    load_danmaku(true, true)
    show_message("设置面板已更改弹幕屏蔽，已应用", 3)
    msg.info("[lc-1302] 检测到 danmaku_block_types.json 变更，重新过滤弹幕")
end)


-- 总集合弹幕菜单
function open_add_total_menu_uosc()
    local items = {}
    local total_menu_items_config = {
        { title = "弹幕搜索", action = "open_search_danmaku_menu" },
        { title = "从源添加弹幕", action = "open_add_source_menu" },
        { title = "弹幕源延迟设置", action = "open_source_delay_menu" },
        { title = "弹幕样式", action = "open_setup_danmaku_menu" },
        { title = "弹幕屏蔽（顶部/滚动/底部/彩色）", action = "open_block_types_menu" },
        { title = "弹幕内容", action = "open_content_danmaku_menu" },
    }


    if DANMAKU.anime and DANMAKU.episode then
        local episode = DANMAKU.episode:gsub("%s.-$","")
        episode = episode:match("^(第.*[话回集]+)%s*") or episode
        items[#items + 1] = {
            title = string.format("已关联弹幕：%s-%s", DANMAKU.anime, episode),
            bold = true,
            italic = true,
            keep_open = true,
            selectable = false,
        }
    end

    for _, config in ipairs(total_menu_items_config) do
        table.insert(items, {
            title = config.title,
            value = { "script-message-to", mp.get_script_name(), config.action },
            keep_open = false,
            selectable = true,
        })
    end

    local menu_props = {
        type = "menu_total",
        title = "弹幕设置",
        search_style = "disabled",
        items = items,
    }
    local json_props = utils.format_json(menu_props)
    mp.commandv("script-message-to", "uosc", "open-menu", json_props)
end

function open_add_total_menu_select()
    local item_titles, item_values = {}, {}
    local total_menu_items_config = {
        { title = "弹幕搜索", action = "open_search_danmaku_menu" },
        { title = "从源添加弹幕", action = "open_add_source_menu" },
        { title = "弹幕内容", action = "open_content_danmaku_menu" },
        { title = "弹幕屏蔽（顶部/滚动/底部/彩色）", action = "open_block_types_menu" },
    }
    for i, config in ipairs(total_menu_items_config) do
        item_titles[i] = config.title
        item_values[i] = { "script-message-to", mp.get_script_name(), config.action }
    end

    mp.commandv('script-message-to', 'console', 'disable')
    input.select({
        prompt = '选择:',
        items = item_titles,
        submit = function(id)
            mp.commandv(unpack(item_values[id]))
        end,
    })
end

function open_add_total_menu()
    if uosc_available then
        open_add_total_menu_uosc()
    elseif input_loaded then
        open_add_total_menu_select()
    end
end

mp.commandv(
    "script-message-to",
    "uosc",
    "set-button",
    "danmaku",
    utils.format_json({
        icon = "search",
        tooltip = "弹幕搜索",
        command = "script-message open_search_danmaku_menu",
    })
)

mp.commandv(
    "script-message-to",
    "uosc",
    "set-button",
    "danmaku_source",
    utils.format_json({
        icon = "add_box",
        tooltip = "从源添加弹幕",
        command = "script-message open_add_source_menu",
    })
)

mp.commandv(
    "script-message-to",
    "uosc",
    "set-button",
    "danmaku_styles",
    utils.format_json({
        icon = "palette",
        tooltip = "弹幕样式",
        command = "script-message open_setup_danmaku_menu",
    })
)

-- [lc-1170] 「弹幕源延迟设置」不再占底栏独立按钮：入口收进「B站弹幕配置」菜单
-- （open_bili_config_menu 的操作项）与「弹幕设置」总菜单（open_add_total_menu_uosc），
-- 底栏控件声明同步从 uosc.conf controls 中移除 button:danmaku_delay。

mp.commandv(
    "script-message-to",
    "uosc",
    "set-button",
    "danmaku_menu",
    utils.format_json({
        icon = "grid_view",
        tooltip = "弹幕设置",
        command = "script-message open_add_total_menu",
    })
)

mp.commandv(
    "script-message-to",
    "uosc",
    "set-button",
    "bili_config",
    utils.format_json({
        icon = "info",
        tooltip = "B站弹幕配置",
        command = "script-message open_bili_config_menu",
    })
)

-- [lc-1269] 「手动搜索B站弹幕」底栏按钮已移除（uosc.conf controls 同步去掉 button:bili_search）：
-- 与「弹幕搜索」按钮图标/交互重复。B站候选已并入「弹幕搜索」结果菜单（三源同出：自建源置顶→
-- 弹弹play 番剧库→B站候选）；open_bili_manual_search 入口保留（总菜单/键盘绑定仍可直达）。

-- [lc-216] 弹幕开关改为 command 按钮(经 toggle_danmaku 处理), 不再依赖 uosc `set show_danmaku` 用户数据桥接。
-- 该桥接在部分 mpv 版本触发内部 tonumber 崩溃, 使整个 uosc_danmaku 控制失效(见 lc-201)。
-- 这里仅用 set-button 同步按钮图标状态(set-button 不读用户数据属性, 安全)。
function sync_danmaku_toggle_btn()
    if not uosc_available then return end
    local ok, on = pcall(get_danmaku_visibility)
    if not ok then on = false end
    mp.commandv("script-message-to", "uosc", "set-button", "danmaku_toggle", utils.format_json({
        icon = on and "toggle_on" or "toggle_off",
        tooltip = on and "弹幕开关（开）" or "弹幕开关（关）",
        command = "script-message toggle_danmaku",
    }))
end

mp.commandv(
    "script-message-to",
    "uosc",
    "set-button",
    "danmaku_toggle",
    utils.format_json({
        icon = "toggle_on",
        tooltip = "弹幕开关",
        command = "script-message toggle_danmaku",
    })
)

mp.register_script_message('uosc-version', function()
    uosc_available = true
end)

-- [lc-216] 移除启动时的 `set show_danmaku off`(旧 user-data 桥接崩溃路径, 见 lc-201);
-- 弹幕开关改为 command 按钮, 由下方 toggle_danmaku 处理, 不再走 set 桥接。
mp.register_script_message("toggle_danmaku", function()
    toggle_danmaku_state()
end)

function toggle_danmaku_state()
    if ENABLED then
        ENABLED = false
        set_danmaku_visibility(false)
        show_message("关闭弹幕", 2)
        hide_danmaku_func()
    else
        ENABLED = true
        set_danmaku_visibility(true)
        local path = mp.get_property("path")
        if COMMENTS == nil then
            init(path)
        else
            show_loaded()
            show_danmaku_func()
        end
    end
    sync_danmaku_toggle_btn()
end

-- 兼容旧 uosc 属性桥接(已弃用): 仅做状态同步, 不再回写 `set show_danmaku`(旧崩溃路径)。
mp.register_script_message("set", function(prop, value)
    if prop ~= "show_danmaku" then
        return
    end
    sync_danmaku_toggle_btn()
end)

-- 注册函数给 uosc 按钮使用
mp.register_script_message("search-anime-event", function(query)
    if uosc_available then
        mp.commandv("script-message-to", "uosc", "close-menu", "menu_danmaku")
    end
    local name, class = query:match("^(.-)%s*|%s*(.-)%s*$")
    if name and class then
        query_extra(name, class)
    else
        get_animes(query)
    end
end)
mp.register_script_message("search-episodes-event", function(animeTitle, bangumiId)
    if uosc_available then
        mp.commandv("script-message-to", "uosc", "close-menu", "menu_anime")
    end
    get_episodes(animeTitle, bangumiId)
end)

-- Register script message to show the input menu
mp.register_script_message("load-danmaku", function(animeTitle, episodeTitle, episodeId)
    ENABLED = true
    DANMAKU.anime = animeTitle
    DANMAKU.episode = episodeTitle
    set_episode_id(episodeId, true)
end)

mp.register_script_message("add-source-event", function(query)
    if uosc_available then
        mp.commandv("script-message-to", "uosc", "close-menu", "menu_source")
    end
    ENABLED = true
    add_danmaku_source(query, true)
end)

mp.register_script_message("open_setup_danmaku_menu", function()
    if uosc_available then
        mp.commandv("script-message-to", "uosc", "close-menu", "menu_total")
    end
    add_danmaku_setup()
end)
mp.register_script_message("open_content_danmaku_menu", function()
    if uosc_available then
        mp.commandv("script-message-to", "uosc", "close-menu", "menu_total")
    end
    open_content_menu()
end)

-- [lc-217] 恢复播放器内弹幕样式菜单回调。lc-200/lc-215 将样式控件从设置面板也移除了,
-- 导致「弹幕样式」按钮变成空壳。现恢复内置菜单(样式改动经 persist_style_opts 自动持久化),
-- 屏蔽类型仍由 Electron 设置面板管理。
mp.register_script_message("setup-danmaku-style", function(query, text)
    local event = utils.parse_json(query)
    if event ~= nil then
        -- item点击 或 图标点击
        if event.type == "activate" then
            -- [lc-1285] 屏蔽类型子菜单的条目自带 value = {"script-message-to", 本脚本,
            -- "toggle-block-type", key, "style"}。uosc 菜单只要配了 callback，所有条目的激活都
            -- 只回调脚本（见 uosc lib/menus.lua：type(callback)=='table' 分支不会 run_command
            -- (event.value)），不会执行 value 里的命令。此前本回调只看 event.index，于是这些条目
            -- 全被当成样式行处理：ordered_keys[9] 为 nil → add_danmaku_setup(nil, "updata") →
            -- 菜单重开但类型没切换，用户看到的就是「点了没反应」。
            -- 故先把非 nil 的 value 命令执行掉，再对样式行按 index 处理。
            if event.action == nil and type(event.value) == "table" and event.value[1] == "script-message-to"
                and event.value[2] == mp.get_script_name() and event.value[3] == "toggle-block-type" then
                mp.commandv(unpack(event.value))
                return
            end
            if not event.action then
                -- 防御：非样式行（分隔线/子菜单父项等）无 ordered_keys 对应项，别带着 nil 重开菜单
                local key = ordered_keys[event.index]
                if key == nil then return end
                if key == "bold" then
                    options.bold = not options.bold
                    menu_items_config.bold.hint = options.bold and "true" or "false"
                    persist_style_opts()
                end
                -- "updata" 模式会保留输入框文字
                add_danmaku_setup(key, "updata")
                return
            else
                options[event.action] = menu_items_config[event.action]["original"]
                menu_items_config[event.action]["hint"] = options[event.action]
                persist_style_opts()
                add_danmaku_setup(event.action, "updata")
                if event.action == "fontsize" or event.action == "scrolltime" then
                    load_danmaku(true)
                end
            end
        end
    else
        -- 数值输入
        if text == nil or text == "" then
            return
        end
        local newText, _ = text:gsub("%s", "") -- 移除所有空白字符
        if tonumber(newText) ~= nil and menu_items_config[query]["scope"] ~= nil then
            local num = tonumber(newText)
            local min_num = menu_items_config[query]["scope"]["min"]
            local max_num = menu_items_config[query]["scope"]["max"]
            if num and min_num <= num and num <= max_num then
                if string.match(menu_items_config[query]["footnote"], "整数") then
                    num = tostring(math.floor(num))
                end
                options[query] = tostring(num)
                menu_items_config[query]["hint"] = options[query]
                persist_style_opts()
                add_danmaku_setup(query, "refresh")
                if query == "fontsize" or query == "scrolltime" then
                    load_danmaku(true, true)
                end
                return
            end
        end
        add_danmaku_setup(query, "error")
    end
end)

-- [lc-1302] 清除弹幕并重新拉取：清空运行态与本地缓存（源工作文件 / 弹弹play 当前集缓存 /
-- B站 源缓存与源决策缓存），随后按当前视频重新走自动匹配。B站 源在拉取落盘时按类型预过滤，
-- 本功能也是「屏蔽类型切换后让 B站 缓存立即生效」的配套入口（弹幕源菜单内可达）。
function clear_danmaku_refetch()
    local path = mp.get_property("path")
    if not path then
        show_message("没有正在播放的文件", 3)
        return
    end
    -- ① 先记下要清的缓存范围（episodeId 从 api_server 源 url 提取；番名用于匹配 B站 xml 缓存）
    local dd_ids = {}
    for url, source in pairs(DANMAKU.sources) do
        if source.from == "api_server" then
            local id = tostring(url):match("/comment/(%d+)")
            if id then dd_ids[id] = true end
        end
    end
    local anime = DANMAKU.anime
    -- ② 停显示 + 清运行态
    if ENABLED then hide_danmaku_func() end
    COMMENTS = nil
    BILI_INFO = nil
    DELAY = 0
    DELAYS = {}
    mp.set_property_native(DELAY_PROPERTY, 0)
    -- ③ 解除全部源引用（用户本地文件本体保留，仅解除引用）
    for _, source in pairs(DANMAKU.sources) do
        if source.fname and source.from ~= "user_local" and file_exists(source.fname) then
            os.remove(source.fname)
        end
    end
    DANMAKU.sources = {}
    DANMAKU.count = 1
    DANMAKU.anime = nil
    DANMAKU.episode = nil
    DANMAKU._primary_ep = nil
    -- ④ 删缓存：per-PID 工作文件 / 弹弹play 当前集 / B站 决策与哈希缓存 / 当前番名 bili xml
    for _, name in ipairs({ "danmaku-" .. PID .. ".json", "danmaku-" .. PID .. ".ass",
                            "temp-" .. PID .. ".mp4", "bahamut-" .. PID .. ".json" }) do
        local p = utils.join_path(DANMAKU_PATH, name)
        if file_exists(p) then os.remove(p) end
    end
    for id in pairs(dd_ids) do
        local p = utils.join_path(DANMAKU_PATH, "dandanplay_" .. id .. ".json")
        if file_exists(p) then os.remove(p) end
    end
    local src_cache = utils.join_path(mp.command_native({ "expand-path", "~~/scripts/uosc_danmaku" }),
        "danmaku_source_cache.json")
    if file_exists(src_cache) then os.remove(src_cache) end
    local ok, items = pcall(utils.readdir, DANMAKU_PATH, "files")
    if ok and type(items) == "table" then
        for _, name in ipairs(items) do
            if type(name) == "string" then
                local hit = name:match("^bili_d%d+")
                    or (anime and anime ~= "" and name:sub(1, #"bili_danmaku_" .. anime) == "bili_danmaku_" .. anime)
                if hit then os.remove(utils.join_path(DANMAKU_PATH, name)) end
            end
        end
    end
    -- ⑤ 重新自动匹配拉取（B站 补源标记复位，让 auto_search_extra 重新触发）
    bili_auto_triggered = false
    ENABLED = true
    init(path)
    show_message("弹幕已清除，正在重新拉取…", 4)
    msg.info("[lc-1302] 清除弹幕并重新拉取")
end

mp.register_script_message('setup-danmaku-source', function(json)
    local event = utils.parse_json(json)
    if event.type == 'activate' then

        if event.value == "refetch-all" then
            mp.commandv("script-message-to", "uosc", "close-menu", "menu_source")
            clear_danmaku_refetch()
            return
        end

        if event.action == "delete" then
            local rm = DANMAKU.sources[event.value]["fname"]
            if rm and file_exists(rm) and DANMAKU.sources[event.value]["from"] ~= "user_local" then
                os.remove(rm)
            end
            DANMAKU.sources[event.value] = nil
            remove_source_from_history(event.value)
            mp.commandv("script-message-to", "uosc", "close-menu", "menu_source")
            open_add_menu_uosc()
            load_danmaku(true)
        end

        if event.action == "block" then
            DANMAKU.sources[event.value]["blocked"] = true
            add_source_to_history(event.value, DANMAKU.sources[event.value])
            mp.commandv("script-message-to", "uosc", "close-menu", "menu_source")
            open_add_menu_uosc()
            load_danmaku(true)
        end

        if event.action == "unblock" then
            DANMAKU.sources[event.value]["blocked"] = false
            add_source_to_history(event.value, DANMAKU.sources[event.value])
            mp.commandv("script-message-to", "uosc", "close-menu", "menu_source")
            open_add_menu_uosc()
            load_danmaku(true)
        end
    end
end)

mp.register_script_message("setup-source-delay", function(query, text)
    local event = utils.parse_json(query)
    if event ~= nil then
        -- item点击
        if event.type == "activate" then
            danmaku_delay_setup(event.value)
        end
    else
        -- 数值输入
        if text == nil or text == "" then
            return
        end
        local newText, _ = text:gsub("%s", "") -- 移除所有空白字符
        local num = tonumber(newText)
        local delay_segments = shallow_copy(DANMAKU.sources[query]["delay_segments"] or {})
        for i = #delay_segments, 1, -1 do
            if delay_segments[i].start == 0 then
                table.remove(delay_segments, i)
            end
        end
        if num ~= nil then
            table.insert(delay_segments, 1, { start = 0, delay = tonumber(num) })
            DANMAKU.sources[query]["delay_segments"] = delay_segments
            add_source_to_history(query, DANMAKU.sources[query])
            mp.commandv("script-message-to", "uosc", "close-menu", "menu_delay")
            danmaku_delay_setup(query)
            load_danmaku(true, true)
        elseif newText:match("^%-?%d+m%d+s$") then
            local minutes, seconds = string.match(newText, "^(%-?%d+)m(%d+)s$")
            minutes = tonumber(minutes)
            seconds = tonumber(seconds)
            if minutes < 0 then seconds = -seconds end
            table.insert(delay_segments, 1, { start = 0, delay = 60 * minutes + seconds })
            DANMAKU.sources[query]["delay_segments"] = delay_segments
            add_source_to_history(query, DANMAKU.sources[query])
            mp.commandv("script-message-to", "uosc", "close-menu", "menu_delay")
            danmaku_delay_setup(query)
            load_danmaku(true, true)
        end
    end
end)
