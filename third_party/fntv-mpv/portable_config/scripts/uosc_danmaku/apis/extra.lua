local utils = require 'mp.utils'
local msg = require 'mp.msg'

-- 标记：本文件是否已按文件名触发过 B站 弹幕。用于避免「文件名优先触发」与
-- 「弹弹play 匹配成功后再触发」重复跑 B站（两次可能用了不同番名→两份 XML）。
bili_auto_triggered = false

-- B站弹幕搜索结果元数据（由 bili_danmaku.py 的 stdout BILI_RESULT: JSON 填充）
-- 供 menu.lua 的 open_bili_config_menu() 面板显示关联状态
BILI_INFO = nil

local Source = {
    ["b 站"] = "bilibili1",
    ["腾讯"] = "qq",
    ["爱奇艺"] = "qiyi",
    ["优酷"] = "youku",
}

local function load_extra_danmaku(url, episode, number, class, id, site, title, year)
    local play_url = nil
    if url:match("^.-%.html") then
        play_url = url:match("^(.-%.html).*")
    else
        play_url = url:gsub("%?bsource=360ogvys$","")
    end
    ENABLED = true
    DANMAKU.anime = title .. " (" .. year .. ")"
    DANMAKU.episode = "第" .. episode .. "话"
    DANMAKU.source = site
    DANMAKU.extra = {
        id = id,
        site = site,
        year = year,
        class = class,
        title = title,
        number = tonumber(number),
        episodenum = tonumber(episode),
    }
    write_history()
    add_danmaku_source(play_url, true)
end

local function query_tmdb(title, class, menu)
    local encoded_title = url_encode(title)
    local url = string.format("https://api.themoviedb.org/3/search/%s?api_key=%s&query=%s&language=zh-CN",
    class, Base64.decode(options.tmdb_api_key), encoded_title)

    local cmd = {
        "curl",
        "-s",
        "-H", "accept: application/json",
        url
    }

    if options.proxy ~= "" then
        table.insert(cmd, '-x')
        table.insert(cmd, options.proxy)
    end

    local res = mp.command_native({
        name = "subprocess",
        args = cmd,
        capture_stdout = true,
        capture_stderr = true,
    })

    local data = utils.parse_json(res.stdout)
    if not res.status or res.status ~= 0 or not data.results or #data.results == 0 then
        local message = "获取 tmdb 中文数据失败"
        if uosc_available then
            update_menu_uosc(menu.type, menu.title, message, menu.footnote, menu.cmd, title)
        else
            show_message(message, 3)
        end
        msg.error("获取 tmdb 中文数据失败：" .. res.stdout)
    else
        if class == "tv" then
            return data.results[1].name
        else
            return data.results[1].title
        end
    end
end

local function get_number(cat, id, site)
    local url = string.format("https://api.web.360kan.com/v1/detail?cat=%s&id=%s&site=%s",
        cat, id, site)

    local cmd = { "curl", "-s", url }
    local res = mp.command_native({
        name = "subprocess",
        args = cmd,
        capture_stdout = true,
        capture_stderr = true,
    })

    if not res.status or res.status ~= 0 then
        msg.error("Failed to fetch data: " .. (res.stderr or "unknown error"))
        return nil
    end

    local result = utils.parse_json(res.stdout)
    if result and result.data and result.data.allupinfo then
        return tonumber(result.data.allupinfo[site])
    end
    return nil
end

function get_details(class, id, site, title, year, number, episodenum)
    local message = episodenum and "查询弹幕中..." or "加载数据中..."
    local menu_type = "menu_details"
    local menu_title = "剧集信息"
    local footnote = "使用 / 打开筛选"
    if uosc_available and not episodenum then
        update_menu_uosc(menu_type, menu_title, message, footnote)
    else
        show_message(message, 3)
    end

    local cat = 0
    if class == "电影" then
        cat = 1
    elseif class == "电视剧" then
        cat = 2
--  elseif class == "综艺" then
--      cat = 3
    elseif class == "动漫" then
        cat = 4
    end

    if not number and cat ~= 0 then
        number = get_number(cat, id, site)
    end
    if not number or cat == 0 then
        local message = "无结果"
        if uosc_available and not episodenum then
            update_menu_uosc(menu_type, menu_title, message, footnote)
        else
            show_message(message, 3)
        end
        msg.verbose("无结果")
        return
    end

    local url = string.format("https://api.web.360kan.com/v1/detail?cat=%s&id=%s&start=1&end=%s&site=%s",
        cat, id, number, site)

    local cmd = { "curl", "-s", url }
    local res = mp.command_native({
        name = "subprocess",
        args = cmd,
        capture_stdout = true,
        capture_stderr = true,
    })

    if not res.status or res.status ~= 0 then
        local message = "无结果"
        if uosc_available and not episodenum then
            update_menu_uosc(menu_type, menu_title, message, footnote)
        else
            show_message(message, 3)
        end
        msg.verbose("无结果")
        return
    end

    local result = utils.parse_json(res.stdout)
    local items = {}
    if result and result.data and result.data.allepidetail then
        local data = result.data.allepidetail
        local playurl, episode = nil, nil
        if episodenum then
            for _, item in ipairs(data[site]) do
                if tonumber(item.playlink_num) == tonumber(episodenum) then
                    playurl = item.url
                    episode = item.playlink_num
                    break
                end
            end
            if playurl then
                load_extra_danmaku(playurl, episode, number, class, id, site, title, year)
                return
            end
        end
        for _, item in ipairs(data[site]) do
            table.insert(items, {
                title = "第" .. item.playlink_num .. "集",
                hint = item.playlink_num,
                value = {
                    "script-message-to",
                    mp.get_script_name(),
                    "add-extra-event",
                    item.url, item.playlink_num, number, class, id, site, title, year
                },
            })
        end
    end
    if #items > 0 then
        if uosc_available and not episodenum then
            update_menu_uosc(menu_type, menu_title, items, footnote)
        elseif not episodenum then
            show_message("", 0)
            mp.add_timeout(0.1, function()
                open_menu_select(items)
            end)
        end
    else
        local message = "无结果"
        if uosc_available and not episodenum then
            update_menu_uosc(menu_type, menu_title, message, footnote)
        else
            show_message(message, 3)
        end
        msg.verbose("无结果")
    end
end

local function search_query(query, class, menu)
    local url = string.format("https://api.so.360kan.com/index?force_v=1&kw=%s", query)
    if class ~= nil then
        url = url .. "&type=" .. class
    end
    local cmd = { "curl", "-s", url }

    local res = mp.command_native({
        name = "subprocess",
        args = cmd,
        capture_stdout = true,
        capture_stderr = true,
    })

    if not res.status or res.status ~= 0 then
        local message = "无结果"
        if uosc_available then
            update_menu_uosc(menu.type, menu.title, message, menu.footnote, menu.cmd, query)
        else
            show_message(message, 3)
        end
        msg.verbose("无结果")
        return
    end

    local result = utils.parse_json(res.stdout)
    local items = {}
    if result and result.data.longData and result.data.longData.rows then
        for _, item in ipairs(result.data.longData.rows) do
            if item.playlinks then
                for source_name, source_id in pairs(Source) do
                    if item.playlinks[source_id] then
                        table.insert(items, {
                            title = item.titleTxt,
                            hint = item.cat_name .. " | " .. item.year .. " | 来源：" .. source_name,
                            value = {
                                "script-message-to",
                                mp.get_script_name(),
                                "get-extra-event",
                                item.cat_name, item.en_id, item.playlinks[source_id], source_id,
                                item.titleTxt, item.year,
                            },
                        })
                    end
                end
            end
        end
    end
    if #items > 0 then
        if uosc_available then
            update_menu_uosc(menu.type, menu.title, items, menu.footnote, menu.cmd, query)
        else
            show_message("", 0)
            mp.add_timeout(0.1, function()
                open_menu_select(items)
            end)
        end
    else
        local message = "无结果"
        if uosc_available then
            update_menu_uosc(menu.type, menu.title, message, menu.footnote, menu.cmd, query)
        else
            show_message(message, 3)
        end
        msg.verbose("无结果")
    end
end

function query_extra(name, class)
    local name = name:gsub("%s*%(%d-%)%s*$", "")
    local title = nil
    local class = class and class:lower()
    local message = "加载数据中..."
    local menu = {
        type = "menu_anime",
        title = "在此处输入番剧名称",
        footnote = "使用enter或ctrl+enter进行搜索"
    }
    menu.cmd = { "script-message-to", mp.get_script_name(), "search-anime-event" }
    if uosc_available then
        update_menu_uosc(menu.type, menu.title, message, menu.footnote, menu.cmd, name)
    else
        show_message(message, 30)
    end

    if is_chinese(name) then
        search_query(name, class, menu)
        return
    end


    if options.tmdb_api_key == "" or #Base64.decode(options.tmdb_api_key) < 32 then
        local message = "请正确设置 tmdb_api_key 或尝试使用中文搜索"
        if uosc_available then
            update_menu_uosc(menu.type, menu.title, message, menu.footnote, menu.cmd, name)
        else
            show_message(message, 3)
        end
        return
    end

    if class == "dy" then
        title = query_tmdb(name, "movie", menu)
    else
        title = query_tmdb(name, "tv", menu)
    end

    if title then
        search_query(title, class, menu)
    end
end

mp.register_script_message("get-extra-event", function(cat, id, playlink, source_id, title, year)
    if uosc_available then
        mp.commandv("script-message-to", "uosc", "close-menu", "menu_anime")
    end
    if cat == "电影" then
        if playlink:match("^.-%.html") then
            playlink = playlink:match("^(.-%.html).*")
        else
            playlink = playlink:gsub("%?bsource=360ogvys$","")
        end
        DANMAKU.anime = title .. " (" .. year .. ")"
        DANMAKU.episode = "电影"
        DANMAKU.source = source_id
        write_history()
        add_danmaku_source(playlink, true)
    else
        get_details(cat, id, source_id, title, year)
    end
end)

mp.register_script_message("add-extra-event", function(url, episode, number, class, id, site, title, year)
    if uosc_available then
        mp.commandv("script-message-to", "uosc", "close-menu", "menu_details")
    end
    load_extra_danmaku(url, episode, number, class, id, site, title, year)
end)

-- 解析中文数字集数（如 "第一话"->1, "第十二集"->12, "二十话"->20, "二十三话"->23）
local cn_digit = {["零"]=0,["一"]=1,["二"]=2,["两"]=2,["三"]=3,["四"]=4,["五"]=5,["六"]=6,["七"]=7,["八"]=8,["九"]=9,["十"]=10}
local function parse_cn_episode(s)
    if not s then return nil end
    local cn = s:match("第([零一二两三四五六七八九十]+)[话集回期]")
    if not cn then return nil end
    if cn == "十" then return 10 end
    if cn:sub(1,1) == "十" then
        return 10 + (cn_digit[cn:sub(2,2)] or 0)
    elseif cn:sub(-1) == "十" then
        return (cn_digit[cn:sub(1,1)] or 1) * 10
    else
        local h, t = cn:match("^(.)十(.)")
        if h then
            return (cn_digit[h] or 1) * 10 + (cn_digit[t] or 0)
        end
        return cn_digit[cn]
    end
end

-- 从文件名解析「番名 + 集数」，供 B站 优先匹配使用（依赖 guess.format_filename）
-- 返回 (title, episode) 或 (nil, nil)。解析不出集数时不返回，交由弹弹play 兜底。
function guess_bili_title_ep(filename)
    local fmt = format_filename(filename)
    if not fmt then return nil, nil end
    local ep = tonumber((fmt:match("[Ee](%d+)")) or (fmt:match("第?(%d+)话")))
    if not ep then return nil, nil end
    local title = fmt
    title = title:gsub("%(%d%d%d%d%)", "")       -- 去掉年份 (2026)
    title = title:gsub("%s*[Ss]%d+", "")          -- 去掉季 S1
    title = title:gsub("%s*[Ee]%d+%.?%d*", "")    -- 去掉集 E3
    title = title:match("^%s*(.-)%s*$")
    if not title or title == "" then return nil, nil end
    return title, ep
end

-- ============ 极速策略：轻量自包含解析（不依赖 dandanplay 21 条正则链） ============
-- 单次提取「番名 + 集数」，覆盖更多真实文件名：电影/单集/OVA、中文第X集、
-- 括号集数、纯数字分隔(-03/_03/.03)、E/EP 标记等。
-- 返回 (title, ep, method)：method ∈ "fast"(番名+集数) / "title_only"(仅番名) / nil

-- 中文数字 → 阿拉伯（一~九十九，按 UTF-8 逐字符解析）
local function cn_ep_to_num(s)
    if not s or s == "" then return nil end
    local map = { ["一"]=1,["二"]=2,["三"]=3,["四"]=4,["五"]=5,["六"]=6,["七"]=7,["八"]=8,["九"]=9,["零"]=0,["两"]=2,["十"]=10 }
    local chars, i, n = {}, 1, 0
    while i <= #s do
        local b = s:byte(i)
        local len = (b < 0x80) and 1 or (b < 0xE0) and 2 or (b < 0xF0) and 3 or 4
        chars[#chars + 1] = s:sub(i, i + len - 1)
        i = i + len
    end
    local sec = 0
    for _, ch in ipairs(chars) do
        if ch == "十" then
            n = n + (sec == 0 and 1 or sec) * 10
            sec = 0
        elseif map[ch] and map[ch] ~= 10 then
            sec = map[ch]
        end
    end
    n = n + sec
    return n > 0 and n or nil
end

function bili_fast_parse(filename)
    if not filename or filename == "" then return nil, nil, nil end
    local s = filename:gsub("%.[^%.]+$", "")                                  -- 去扩展名
    s = s:gsub("^[%[%(【『][^%]%)】』]*[%]%)】』]%s*", "")                     -- 去开头组标签
    -- 去常见质量/编码/来源标签（不伤番名）
    -- 去常见质量/编码/来源标签（拆成多条简单 gsub，避免超长正则在某些 Lua 实现下失效）
    s = s:gsub("%d+[pPkKxX]", " ")
    s = s:gsub("Blu[%.%-%s]?Ray", " "):gsub("WEB[%.%-%s]?DL", " "):gsub("WEBDL", " ")
    s = s:gsub("HDTV", " "):gsub("DVD", " "):gsub("HDR", " ")
    s = s:gsub("x264", " "):gsub("x265", " "):gsub("H%.?264", " "):gsub("H%.?265", " "):gsub("HEVC", " "):gsub("AVC", " ")
    s = s:gsub("10bit", " "):gsub("8bit", " ")
    s = s:gsub("AAC", " "):gsub("FLAC", " "):gsub("AC3", " "):gsub("DTS", " "):gsub("Dual", " ")
    s = s:gsub("CHT", " "):gsub("CHS", " "):gsub("JPN", " "):gsub("GB", " "):gsub("BIG5", " "):gsub("RAW", " ")
    s = s:gsub("%(%d%d%d%d%)", " "):gsub("%[%d%d%d%d%]", " ")                  -- 去年份
    -- 提取集数（优先级：第X话/集 → E/EP → -/_/.数字 → [数字]）
    local ep
    local m = tonumber((s:match("第%s*(%d+)%s*[话集回話]")))
    if not m then
        local cm = s:match("第%s*([一二三四五六七八九十两零]+)%s*[话集回話]")
        if cm then m = cn_ep_to_num(cm) end
    end
    if not m then m = tonumber((s:match("[Ee][pP]?%s*(%d+)"))) end
    if not m then m = tonumber((s:match("%s[%#%-_%.]%s*(%d%d?)%s"))) end
    if not m then m = tonumber((s:match("%[(%d%d?)%]"))) end
    if m and m > 999 then m = nil end
    ep = m
    -- 标题 = 集数标记之前的部分，清理
    local title = s
    title = title:gsub("第%s*%d+%s*[话集回話]", "")
    title = title:gsub("第%s*[一二三四五六七八九十两零]+%s*[话集回話]", "")
    title = title:gsub("%s*[Ss]%d+%s*", " ")
    title = title:gsub("[Ee][pP]?%s*%d+", "")
    title = title:gsub("%s[%#%-_%.]%s*%d%d?%s*", " ")
    title = title:gsub("%[%d%d?%]", "")
    title = title:gsub("%[.-%]", " "):gsub("%(.-%)", " ")
    title = title:gsub("%]", " "):gsub("%[", " "):gsub("%(", " "):gsub("%)", " ")
    title = title:gsub("^%s*(.-)%s*$", "%1")
    title = title:gsub("[_%.]+", " ")
    title = title:gsub("%s+", " ")
    if title == "" then return nil, nil, nil end
    if ep then
        return title, ep, "fast"
    end
    return title, nil, "title_only"
end

-- 极速优先、兼容链兜底的解析分发
function guess_bili_title_ep_v2(filename)
    local ft, fe, fm = bili_fast_parse(filename)
    if ft then
        if fe then return ft, fe, "fast" end
        return ft, nil, "title_only"
    end
    local lt, le = guess_bili_title_ep(filename)
    if lt then
        if le then return lt, le, "legacy" end
        return lt, nil, "legacy_title_only"
    end
    return nil, nil, nil
end

-- 自动补源：文件名优先解析到番名/集数后，直连 B站 搜索对应集弹幕并叠加
-- （绕开失效的 extcomment 代理）。也作为弹弹play 匹配成功后的兜底补源。
function auto_search_extra(title, episode_num)
    if not title or title == "" then return end
    -- 调试：记录进入时的原始上下文
    msg.info(("[自动补源-DEBUG] 进入 title=%q DANMAKU.episode=%q 传入episode_num=%s")
        :format(title, tostring(DANMAKU.episode), tostring(episode_num)))
    -- episode_num：数字=指定集；0/nil=仅标题搜索（B站 取最优结果，极速兜底）
    if episode_num == nil then
        if DANMAKU.episode then
            episode_num = tonumber(DANMAKU.episode:match("%d+")) or parse_cn_episode(DANMAKU.episode) or 0
        else
            episode_num = 0
        end
    end
    if not episode_num or episode_num < 0 then episode_num = 0 end
    -- 若集数仍为 0，尝试从标题本身再挖一次集数（标题可能含 "第12话"/EP12 等）
    if episode_num == 0 then
        local _, te = guess_bili_title_ep_v2(title)
        if te then
            msg.info(("[自动补源-DEBUG] 从标题再解析到集数=%d: %q"):format(te, title))
            episode_num = te
        end
    end
    msg.info(("[自动补源-DEBUG] 最终 episode_num=%d (title=%q)"):format(episode_num, title))

    -- 去文件名里的非法字符，构造唯一 XML 路径
    local safe_title = (title:gsub('[\\/:*?"<>|]', "") or "x")
    local out_xml = utils.join_path(DANMAKU_PATH, "bili_danmaku_" .. safe_title .. "_" .. episode_num .. ".xml")
    -- 避免同一集重复加载
    if DANMAKU.sources[out_xml] then
        msg.warn("自动补源：该集B站弹幕已加载，跳过")
        return
    end

    -- ⚠️ py_script 必须用脚本所在目录动态计算，绝不能写死绝对路径
    -- （否则换机器 / 换目录 / 走 dev 仓库就找不到 bili_danmaku.py，导致 B站弹幕 100% 失败）
    -- main.lua 通过 require('apis/extra') 加载本文件，故 get_script_directory() 返回
    -- main.lua 所在目录 .../scripts/uosc_danmaku/，bili_danmaku.py 就在此目录下。
    local script_dir = mp.get_script_directory()
    local py_script = utils.join_path(script_dir, "bili_danmaku.py")

    -- 向上回溯到 app 根目录：scripts/uosc_danmaku -> scripts -> portable_config -> 根（根下含 third_party）
    local function _parent(p)
        p = p:gsub("[\\/]$", "")  -- 去掉结尾分隔符，确保 split_path 行为稳定（不受 get_script_directory 是否带尾斜杠影响）
        local d = utils.split_path(p)
        return d
    end
    local app_root = _parent(_parent(_parent(script_dir)))

    -- Python 解释器候选（与主进程 biliDanmaku.ts 的 findPythonCandidates 对齐）：
    -- 内置便携 Python > 系统 PATH。保证无 Python 环境的电脑也能用 B站弹幕。
    local py_candidates = {
        -- utils.join_path 仅接受两个参数，逐级拼接；app_root 已含尾斜杠
        utils.join_path(utils.join_path(utils.join_path(app_root, "third_party"), "python"), "python.exe"),  -- 内置便携 Python（随安装包/仓库分发）
        "python",
        "python3",
        "py",
    }

    local ep_label = episode_num == 0 and "仅标题/单集(极速兜底)" or ("第" .. episode_num .. "集")
    msg.warn(("自动补源：直连B站搜索 %s（%s）"):format(title, ep_label))
    msg.info(("[自动补源-DEBUG] py_candidates=%s"):format(table.concat(py_candidates, " | ")))
    local ok = false
    for _, py in ipairs(py_candidates) do
        msg.info(("[自动补源-DEBUG] 试 py=%q script=%q args=%s,%s,%s")
            :format(py, py_script, title, tostring(episode_num), out_xml))
        local res = mp.command_native({
            name = "subprocess",
            args = { py, py_script, title, tostring(episode_num), out_xml },
            capture_stdout = true,
            capture_stderr = true,
        })
        if res.status == 0 and file_exists(out_xml) then
            ok = true
            -- 解析 Python 输出的 BILI_RESULT JSON（供配置面板显示关联状态）
            local stdout = res.stdout or ""
            local bili_line = stdout:match("BILI_RESULT:(.+)")
            if bili_line then
                local ok_parse, parsed = pcall(utils.parse_json, bili_line)
                if ok_parse and type(parsed) == "table" then
                    BILI_INFO = parsed
                    msg.info(("[自动补源] B站元数据: %s"):format(bili_line))
                else
                    msg.warn("[自动补源] BILI_RESULT JSON 解析失败: " .. tostring(bili_line))
                end
            end
            break
        end
    end
    if not ok then
        msg.warn("自动补源：B站弹幕下载失败（检查网络/Python环境，详见 mpv.log 的 [bili_danmaku] 日志）")
        return
    end
    msg.warn(("自动补源：叠加 B站弹幕（%s 第%s集）"):format(title, episode_num))
    add_danmaku_source_local(out_xml, false)
end
