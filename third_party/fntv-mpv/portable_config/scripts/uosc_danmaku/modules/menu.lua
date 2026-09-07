local msg = require('mp.msg')
local utils = require("mp.utils")

input_loaded, input = pcall(require, "mp.input")
uosc_available = false

-- 打开番剧数据匹配菜单
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

    local args = make_danmaku_request_args("GET", full_url)

    if args == nil then
        return
    end

    local res = mp.command_native({ name = 'subprocess', capture_stdout = true, capture_stderr = true, args = args })

    if not res.status or res.status ~= 0 then
        local message = "获取数据失败"
        if uosc_available then
            update_menu_uosc(menu_type, menu_title, message, footnote, menu_cmd, query)
        else
            show_message(message, 3)
        end
        msg.error("HTTP 请求失败：" .. res.stderr)
    end

    local response = utils.parse_json(res.stdout)

    if not response or not response.animes then
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

    local res = mp.command_native({ name = 'subprocess', capture_stdout = true, capture_stderr = true, args = args })

    if not res.status or res.status ~= 0 then
        local message = "获取数据失败"
        if uosc_available then
            update_menu_uosc(menu_type, menu_title, message, footnote)
        else
            show_message(message, 3)
        end
        msg.error("HTTP 请求失败：" .. res.stderr)
    end

    local response = utils.parse_json(res.stdout)

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
        hint = "  追加|ds或|dy或|dm可搜索电视剧|电影|国漫",
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
function open_bili_config_menu()
    if not uosc_available then
        show_message("B站弹幕配置需在 uosc 控制栏下使用", 3)
        return
    end
    local items = {}
    table.insert(items, {
        title = "B站弹幕配置",
        bold = true, italic = true, keep_open = true, selectable = false,
    })

    -- 当前文件名解析出的番名/集数（即 B站 默认会搜什么）
    local raw_filename = mp.get_property("filename") or ""
    local path = mp.get_property("path") or ""
    local parse_target = raw_filename
    if type(path) == "string" and (path:find("^%a[%w.+-]-://") ~= nil or path:find("^%a[%w.+-]-:%?") ~= nil) then
        local mtitle = mp.get_property("media-title")
        if mtitle and mtitle ~= "" then
            parse_target = mtitle
        end
    end
    -- 优先显示弹弹play匹配到的干净标题（服务端规范中文名）；
    -- 弹弹play未匹配时才回退到文件名解析（可能含乱码）
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
    if title then
        table.insert(items, { title = "解析策略：" .. method_label, keep_open = true, selectable = false })
        table.insert(items, { title = "当前解析 → 番名：" .. title, keep_open = true, selectable = false })
        table.insert(items, { title = "当前解析 → 集数：" .. (ep and ("第" .. ep .. "集") or "未知（将按单集/第1话搜索）"), keep_open = true, selectable = false })
    else
        table.insert(items, { title = "当前文件无法解析出番名（将转弹弹play兜底）", keep_open = true, selectable = false })
    end

    -- 分隔线
    table.insert(items, { title = "", keep_open = true, selectable = false })

    -- ====== B站关联状态区（用户最关心的信息）======
    if BILI_INFO and type(BILI_INFO) == "table" then
        if BILI_INFO.ok then
            -- ✅ 关联成功
            table.insert(items, { title = "✅ B站弹幕：已关联成功", bold = true, keep_open = true, selectable = false, })
            if BILI_INFO.bvid and BILI_INFO.bvid ~= "" then
                table.insert(items, { title = "  📺 视频：" .. (BILI_INFO.title or "未知") .. " [" .. BILI_INFO.bvid .. "]", keep_open = true, selectable = false })
            elseif BILI_INFO.title then
                table.insert(items, { title = "  📺 略剧：" .. BILI_INFO.title, keep_open = true, selectable = false })
            end
            if BILI_INFO.danmaku_count then
                table.insert(items, { title = "  💬 弹幕数：" .. tostring(BILI_INFO.danmaku_count) .. " 条", keep_open = true, selectable = false })
            end
            local src_label = ({ bangumi = "番剧区（正版）", video = "视频区（UP主搬运）" })[BILI_INFO.source] or BILI_INFO.source or "未知"
            -- 匹配来源标识: 视频区显示 BV 号; 番剧区(正版)无 bvid 但有 ep_id(剧集 ID)更友好
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
            table.insert(items, { title = "  🎯 匹配来源：" .. src_label .. src_extra, keep_open = true, selectable = false })
        else
            -- ❌ 搜索失败
            table.insert(items, { title = "❌ B站弹幕：关联失败", bold = true, keep_open = true, selectable = false })
            table.insert(items, { title = "  原因：" .. (BILI_INFO.error or "未知错误"), keep_open = true, selectable = false })
        end
    else
        -- ⏳ 尚未搜索过
        local has_bili_source = false
        for url, source in pairs(DANMAKU.sources) do
            if url and url:match("bili_danmaku_") then
                has_bili_source = true
                break
            end
        end
        if has_bili_source then
            table.insert(items, { title = "⏳ B站弹幕：已加载（旧版无元数据）", keep_open = true, selectable = false })
        else
            table.insert(items, { title = "⏳ B站弹幕：尚未搜索", keep_open = true, selectable = false })
            table.insert(items, { title = "  点击下方「立即搜索」尝试自动匹配", keep_open = true, selectable = false })
        end
    end

    -- 操作项
    table.insert(items, {
        title = "▶ 手动搜索 B站弹幕",
        value = { "script-message-to", mp.get_script_name(), "open_bili_manual_search" },
        keep_open = false, selectable = true,
    })
    table.insert(items, {
        title = "▶ 用当前解析立即搜索 B站弹幕",
        value = { "script-message-to", mp.get_script_name(), "bili_search_now" },
        keep_open = false, selectable = true,
    })
    table.insert(items, {
        title = "▶ 查看 bili_alias.txt 番名映射",
        value = { "script-message-to", mp.get_script_name(), "bili_show_alias" },
        keep_open = false, selectable = true,
    })

    local menu_props = {
        type = "menu_bili_config",
        title = "B站弹幕配置",
        search_style = "disabled",
        items = items,
    }
    mp.commandv("script-message-to", "uosc", "open-menu", utils.format_json(menu_props))
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
    for _, c in ipairs(cands) do
        local src_label = ({ bangumi = "番剧区", video = "视频区" })[c.source] or c.source
        local tag = c.is_compilation and " ⚠️合集/解说" or ""
        table.insert(new_items, {
            title = ("%s [%s] %s%s"):format(c.title, c.bvid or "?", src_label, tag),
            hint = ("BV: %s"):format(c.bvid or "未知"),
            value = { "script-message-to", mp.get_script_name(), "bili_manual_pick", c.bvid or "", title, tostring(ep or 0) },
            keep_open = false, selectable = true,
        })
    end
    local props = {
        type = "menu_bili_candidates",
        title = ("B站候选：「%s」%s"):format(title, (ep and ep > 0) and ("第" .. ep .. "集") or ""),
        search_style = "disabled",
        items = new_items,
    }
    mp.commandv("script-message-to", "uosc", "open-menu", utils.format_json(props))
end

function open_bili_candidates_error(msg_text)
    if not uosc_available then
        show_message("候选搜索失败：" .. msg_text, 4)
        return
    end
    local items = {
        { title = "❌ 候选搜索失败：" .. msg_text, keep_open = true, selectable = false, bold = true },
        { title = "点击下方返回重新搜索", keep_open = true, selectable = false },
        { title = "▶ 重新搜索", value = { "script-message-to", mp.get_script_name(), "open_bili_manual_search" }, keep_open = false, selectable = true },
    }
    local props = { type = "menu_bili_candidates", title = "候选搜索失败", search_style = "disabled", items = items }
    mp.commandv("script-message-to", "uosc", "open-menu", utils.format_json(props))
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

-- 设置弹幕样式菜单（仅本次播放生效；持久化样式请到 Electron 设置面板调整屏蔽类型）
function add_danmaku_setup(actived, status)
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

    local menu_props = {
        type = "menu_style",
        title = "弹幕样式",
        search_style = "disabled",
        footnote = "样式更改仅在本次播放生效",
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
    mp.commandv("script-message-to", uosc_available and "uosc" or "ignore", actions, json_props)
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


-- 总集合弹幕菜单
function open_add_total_menu_uosc()
    local items = {}
    local total_menu_items_config = {
        { title = "弹幕搜索", action = "open_search_danmaku_menu" },
        { title = "从源添加弹幕", action = "open_add_source_menu" },
        { title = "弹幕源延迟设置", action = "open_source_delay_menu" },
        { title = "弹幕样式", action = "open_setup_danmaku_menu" },
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

mp.commandv(
    "script-message-to",
    "uosc",
    "set-button",
    "danmaku_delay",
    utils.format_json({
        icon = "more_time",
        tooltip = "弹幕源延迟设置",
        command = "script-message open_source_delay_menu",
    })
)

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

mp.commandv(
    "script-message-to",
    "uosc",
    "set-button",
    "bili_search",
    utils.format_json({
        icon = "search",
        tooltip = "手动搜索B站弹幕",
        command = "script-message open_bili_manual_search",
    })
)

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
-- 导致「弹幕样式」按钮变成空壳。现恢复内置菜单(仅本次播放生效), 屏蔽类型仍由 Electron 设置面板管理。
mp.register_script_message("setup-danmaku-style", function(query, text)
    local event = utils.parse_json(query)
    if event ~= nil then
        -- item点击 或 图标点击
        if event.type == "activate" then
            if not event.action then
                if ordered_keys[event.index] == "bold" then
                    options.bold = not options.bold
                    menu_items_config.bold.hint = options.bold and "true" or "false"
                end
                -- "updata" 模式会保留输入框文字
                add_danmaku_setup(ordered_keys[event.index], "updata")
                return
            else
                options[event.action] = menu_items_config[event.action]["original"]
                menu_items_config[event.action]["hint"] = options[event.action]
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

mp.register_script_message('setup-danmaku-source', function(json)
    local event = utils.parse_json(json)
    if event.type == 'activate' then

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
