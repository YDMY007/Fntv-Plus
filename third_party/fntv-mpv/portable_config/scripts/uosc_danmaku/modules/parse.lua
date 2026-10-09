local msg   = require 'mp.msg'
local utils = require 'mp.utils'
local s2t   = require("dicts/s2t_chars")
local t2s   = require("dicts/t2s_chars")

local function ass_escape(text)
    return text:gsub("\\", "\\\\")
               :gsub("{", "\\{")
               :gsub("}", "\\}")
               :gsub("\n", "\\N")
end

local function xml_unescape(str)
    return str:gsub("&quot;", "\"")
              :gsub("&apos;", "'")
              :gsub("&gt;", ">")
              :gsub("&lt;", "<")
              :gsub("&amp;", "&")
end

local function decode_html_entities(text)
    return text:gsub("&#x([%x]+);", function(hex)
        local codepoint = tonumber(hex, 16)
        return unicode_to_utf8(codepoint)
    end):gsub("&#(%d+);", function(dec)
        local codepoint = tonumber(dec, 10)
        return unicode_to_utf8(codepoint)
    end)
end

-- 加载黑名单模式
local function load_blacklist_patterns(filepath)
    local patterns = {}
    if not file_exists(filepath) then
        return patterns
    end
    local file = io.open(filepath, "r")
    if not file then
        msg.error("无法打开黑名单文件: " .. filepath)
        return patterns
    end

    for line in file:lines() do
        line = line:match("^%s*(.-)%s*$")
        if line ~= "" then
            table.insert(patterns, line)
        end
    end

    file:close()
    return patterns
end

local blacklist_file = mp.command_native({ "expand-path", options.blacklist_path })
local black_patterns = load_blacklist_patterns(blacklist_file)

-- 检查字符串是否在黑名单中
function is_blacklisted(str, patterns)
    for _, pattern in ipairs(patterns) do
        local ok, result = pcall(function()
            return str:match(pattern)
        end)

        if ok and result then
            return true, pattern
        elseif not ok then
            -- msg.debug("黑名单规则错误，跳过: " .. pattern .. "，错误信息：" .. result)
        end
    end
    return false
end

-- 弹幕屏蔽类型：mode → 标签，映射与 bili_danmaku.js:_filter_danmaku 逐条对齐
local MODE_BLOCK_TAG = {
    [1] = "scroll",
    [4] = "bottom",
    [5] = "top",
    [6] = "reverse",
    [7] = "advanced",
    [8] = "advanced",
}

local function load_block_types(filepath)
    local tags = {}
    if not file_exists(filepath) then
        return tags
    end
    local content = read_file(filepath)
    if not content then
        msg.warn("无法读取屏蔽类型文件: " .. filepath)
        return tags
    end
    local arr = utils.parse_json(content)
    if type(arr) ~= "table" then
        msg.warn("屏蔽类型文件不是 JSON 数组: " .. filepath)
        return tags
    end
    for _, v in ipairs(arr) do
        if type(v) == "string" then
            tags[v] = true
        end
    end
    if next(tags) ~= nil then
        local names = {}
        for k in pairs(tags) do names[#names + 1] = k end
        table.sort(names)
        msg.info("弹幕屏蔽类型已加载: " .. table.concat(names, ","))
    end
    return tags
end

local block_types = load_block_types(mp.command_native({ "expand-path", options.block_types_path }))

-- [lc-1302] 屏蔽类型运行时刷新：danmaku_block_types.json 是「MPV 快捷键菜单 / 设置面板」
-- 共用的真源文件，任意一侧改动后都须在下次加载弹幕前重读。parse_danmaku_files 开头会调用。
function reload_block_types()
    block_types = load_block_types(mp.command_native({ "expand-path", options.block_types_path }))
    return block_types
end

function get_block_types()
    return block_types
end

-- 判定必须用归一化后的 d.type/d.color：parse_xml_danmaku 的 params 序是 {time,type,size,color}，
-- 而 parse_json_danmaku 是 {time,color,type,size} —— 两者相反，碰原始 params 必错。
local function is_type_blocked(d)
    if next(block_types) == nil then
        return false
    end
    local tag = MODE_BLOCK_TAG[d.type or 1]
    if tag and block_types[tag] then
        return true
    end
    return block_types["color"] == true and (d.color or 0xFFFFFF) ~= 0xFFFFFF
end

-- 简繁转换
local function convert(text, dict)
    return text:gsub("[%z\1-\127\194-\244][\128-\191]*", function(c)
        return dict[c] or c
    end)
end

local function ch_convert(str)
    if options.chConvert == 1 then
        return convert(str, t2s)
    elseif options.chConvert == 2 then
        return convert(str, s2t)
    end
    return str
end

local ch_convert_cache = {}
local ch_cache_keys = {}
local ch_cache_max = 5000

local function ch_convert_cached(text)
    if type(text) ~= "string" or text == "" then return text end
    local cached = ch_convert_cache[text]
    if cached ~= nil then return cached end

    local converted = ch_convert(text)
    ch_convert_cache[text] = converted
    ch_cache_keys[#ch_cache_keys+1] = text

    if #ch_cache_keys > ch_cache_max then
        local old_key = table.remove(ch_cache_keys, 1)
        ch_convert_cache[old_key] = nil
    end

    return converted
end

-- 合并重复弹幕
local function merge_duplicate_danmaku(danmakus, threshold)
    if not threshold or tonumber(threshold) < 0 then return danmakus end

    local groups = {}

    for _, d in ipairs(danmakus) do
        local key = d.type .. "|" .. d.color .. "|" .. d.text
        if not groups[key] then groups[key] = {} end
        table.insert(groups[key], d)
    end

    local merged = {}

    for _, group in pairs(groups) do
        table.sort(group, function(a, b) return a.time < b.time end)

        local i = 1
        while i <= #group do
            local base = group[i]
            local times = { base.time }
            local count = 1
            local j = i + 1

            while j <= #group and math.abs(group[j].time - base.time) <= threshold do
                table.insert(times, group[j].time)
                count = count + 1
                j = j + 1
            end

            local same_time = true
            for k = 2, #times do
                if times[k] ~= times[1] then
                    same_time = false
                    break
                end
            end

            local danmaku = {
                time = base.time,
                type = base.type,
                size = base.size,
                color = base.color,
                text = base.text,
            }
            if count > 2 or not same_time then
                danmaku.text = danmaku.text .. string.format("x%d", count)
            end

            table.insert(merged, danmaku)
            i = j
        end
    end

    table.sort(merged, function(a, b) return a.time < b.time end)
    return merged
end

-- 限制每屏弹幕条数
local function limit_danmaku(danmakus, limit)
    if not limit or limit <= 0 then
        return danmakus
    end

    local window = {}
    for _, d in ipairs(danmakus) do
        for i = #window, 1, -1 do
            if window[i].end_time <= d.start_time then
                table.remove(window, i)
            end
        end

        if #window < limit then
            table.insert(window, d)
        else
            local max_idx = 1
            for i = 2, #window do
                if window[i].end_time > window[max_idx].end_time then
                    max_idx = i
                end
            end
            if window[max_idx].end_time > d.end_time then
                window[max_idx].drop = true
                window[max_idx] = d
            else
                d.drop = true
            end
        end
    end

    local result = {}
    for _, d in ipairs(danmakus) do
        if not d.drop then
            table.insert(result, d)
        end
    end
    return result
end

-- 解析 XML 弹幕
local function parse_xml_danmaku(xml_string, delay_segments)
    local danmakus = {}
    for p_attr, text in xml_string:gmatch('<d p="([^"]+)">([^<]+)</d>') do
        local params = {}
        local i = 1
        for val in p_attr:gmatch("([^,]+)") do
            params[i] = tonumber(val)
            i = i + 1
        end

        if params[1] and params[2]  and params[3] and params[4] then
            local base_time = params[1]
            local delay = get_delay_for_time(delay_segments, base_time)
            table.insert(danmakus, {
                time = base_time + delay,
                type = params[2] or 1,
                size = params[3] or 25,
                color = params[4] or 0xFFFFFF,
                text = xml_unescape(text)
            })
        end
    end

    table.sort(danmakus, function(a, b) return a.time < b.time end)
    return danmakus
end

-- 解析 JSON 弹幕
local function parse_json_danmaku(json_string, delay_segments)
    local danmakus = {}
    if json_string:sub(1, 3) == "\239\187\191" then
        json_string = json_string:sub(4)
    end

    local json = utils.parse_json(json_string)
    if not json or type(json) ~= "table" then
        msg.info("JSON 解析失败")
        return danmakus
    end

    for _, entry in ipairs(json) do
        local c = entry.c
        local text = entry.m or ""
        if type(c) == "string" then
            local params = {}
            local i = 1
            for val in c:gmatch("([^,]+)") do
                params[i] = tonumber(val)
                i = i + 1
            end

            if params[1] and params[2] and params[3] and params[4] then
                local base_time = params[1]
                local delay = get_delay_for_time(delay_segments, base_time)
                table.insert(danmakus, {
                    time = base_time + delay,
                    color = params[2] or 0xFFFFFF,
                    type = params[3] or 1,
                    size = params[4] or 25,
                    text = text
                })
            end
        end
    end

    table.sort(danmakus, function(a, b) return a.time < b.time end)
    return danmakus
end

-- 解析弹幕文件
function parse_danmaku_files(danmaku_input, delays)
    -- [lc-1302] 每次转换前重读屏蔽类型：快捷键菜单/设置面板刚改过的开关立即生效
    reload_block_types()
    local DANMAKU_PATHs = {}
    if type(danmaku_input) == "string" then
        DANMAKU_PATHs = { danmaku_input }
    else
        for i, input in ipairs(danmaku_input) do
            DANMAKU_PATHs[#DANMAKU_PATHs + 1] = input
        end
    end

    local all_danmaku = {}

    for i, DANMAKU_PATH in ipairs(DANMAKU_PATHs) do
        if file_exists(DANMAKU_PATH) then
            local content = read_file(DANMAKU_PATH)
            if content then
                local parsed = {}
                local delay_segments = delays and delays[i] or {}
                if DANMAKU_PATH:match("%.xml$") then
                    parsed = parse_xml_danmaku(content, delay_segments)
                elseif DANMAKU_PATH:match("%.json$") then
                    parsed = parse_json_danmaku(content, delay_segments)
                end

                for _, d in ipairs(parsed) do
                    if not is_type_blocked(d) then
                        local matched, pattern = is_blacklisted(d.text, black_patterns)
                        if not matched then
                            d.text = ch_convert_cached(d.text)
                            table.insert(all_danmaku, d)
                        else
                            -- msg.debug("命中黑名单: " .. pattern)
                        end
                    end
                end
            else
                msg.info("无法读取文件内容: " .. DANMAKU_PATH)
            end
        else
            msg.info("文件不存在: " .. DANMAKU_PATH)
        end
    end

    if #all_danmaku == 0 then
        msg.info("未能解析任何弹幕")
        return nil
    end

    if options.max_screen_danmaku > 0 and options.merge_tolerance <= 0 then
        options.merge_tolerance = options.scrolltime
    end

    -- 按时间排序
    table.sort(all_danmaku, function(a, b)
        return a.time < b.time
    end)

    all_danmaku = merge_duplicate_danmaku(all_danmaku, options.merge_tolerance)

    return all_danmaku
end

--# 弹幕数组与布局算法 (Danmaku Array & Layout Algorithms)
local DanmakuArray = {}
DanmakuArray.__index = DanmakuArray

-- [lc-1286] 行高：轨道数组按**最大可能字号**建，而不是 options.fontsize 基础字号。
-- 聚合弹幕（lc-1253）会把字号放大到 1.3 倍，DanmakuArray:new 仍按基础字号算 rows，
-- 于是轨道数偏多（1080p/30px → 36 行）、相邻轨道 Y 间距只有基础字号 30px，
-- 而放大后的弹幕实际高 37px → 上下行文字直接叠在一起（用户反馈「不同轨道弹幕重叠」）。
-- 按最大字号建轨道后，任意一条放大弹幕的行高都不会超出所在轨道的间距。
-- 上限 1.3 与 convert_danmaku_to_ass 里的放大曲线同源，改那边记得同步这里。
local MERGE_FS_MAX_MULT = 1.3

function DanmakuArray:new(res_x, res_y, font_size)
    local row_font_size = math.max(font_size, math.ceil(font_size * MERGE_FS_MAX_MULT))
    local obj = {
        solution_y = res_y,
        font_size = font_size,
        -- 每条轨道占的高度 = max(基础字号, 放大上限)，保证放大弹幕不越界压到下一行
        row_height = row_font_size,
        rows = math.floor(res_y / row_font_size),
        time_length_array = {}
    }
    for i = 1, obj.rows do
        obj.time_length_array[i] = { time = -1, length = 0 }
    end
    setmetatable(obj, self)
    return obj
end

-- [lc-1286] 轨道 i 的 Y 坐标：统一走行高，避免调用方各写一套 math（原先散落 1+(i-1)*font_size）
function DanmakuArray:get_y(row)
    return 1 + (row - 1) * self.row_height
end

function DanmakuArray:set_time_length(row, time, length)
    if row > 0 and row <= self.rows then
        self.time_length_array[row] = { time = time, length = length }
    end
end

-- [lc-1286] 字号维度：轨道除时间/宽度外还要记住该行上一条的**实际字号**。
-- 原先同轨判定只用上一条的 text_length，而聚合弹幕放大后宽度更大、占据水平空间更久，
-- 追及判据 delta_x 用的仍是旧宽度 → 判「已经拉开距离」而放进同一行，
-- 实际渲染时大字弹幕与小字弹幕同轨并行、上下压字（用户反馈的遮挡）。
-- 记录 font_size 后，同轨放置要求「上一条已经完全离场」或「水平方向确已错开」。
function DanmakuArray:set_time_length_fs(row, time, length, font_size)
    if row > 0 and row <= self.rows then
        self.time_length_array[row] = { time = time, length = length, font_size = font_size }
    end
end

function DanmakuArray:get_font_size(row)
    if row > 0 and row <= self.rows then
        return self.time_length_array[row].font_size or self.font_size
    end
    return self.font_size
end

-- [lc-1287] 轨道占用到期时间：共享轨道池后，滚动弹幕与顶部/底部弹幕落在同一组行上，
-- 各自持续时间不同（滚动 = scrolltime，固定 = fixtime）。只记 appear_time 无法判断
-- 「这一行上的东西是否已经走完」，于是固定弹幕会复用滚动弹幕尚未离场的行 → 压字。
-- 用 until_time 显式记录该行被占到什么时候，两类弹幕各自写自己的值。
-- length 仍需保留：滚动弹幕的追及判据要用上一条的宽度（get_length）。
function DanmakuArray:occupy(row, appear_time, until_time, font_size, length)
    if row > 0 and row <= self.rows then
        self.time_length_array[row] = {
            time = appear_time, length = length or 0,
            font_size = font_size, until_time = until_time,
        }
    end
end

function DanmakuArray:free_at(row)
    if row > 0 and row <= self.rows then
        return self.time_length_array[row].until_time or -1
    end
    return -1
end

function DanmakuArray:get_time(row)
    if row > 0 and row <= self.rows then
        return self.time_length_array[row].time
    end
    return -1
end

function DanmakuArray:get_length(row)
    if row > 0 and row <= self.rows then
        return self.time_length_array[row].length
    end
    return 0
end

-- 滚动弹幕 Y 坐标算法
-- [lc-1286] 四处修正（用户反馈：重复弹幕放大字号后与其它弹幕互相遮挡、
--          且同屏内「速率不一样」）：
--   ① 行间距走 array.row_height（含聚合放大上限），不再用基础字号，
--      否则放大弹幕的实际高度超出轨道间距、压到相邻轨道（用户反馈「不同轨道重叠」）；
--   ② 布局宽度只按**可见字符**计算（见 convert_danmaku_to_ass 的 layout_text）。
--      原先把覆写标签 {\fs37} 也计入字宽，宽度虚高约 67% → \move 行程变长，
--      同屏内速率与其它弹幕不一致（用户反馈「速率不一样」）；
--   ③ 记录每行的实际字号，同轨放置时字号不同者要求上一条已完全离场——
--      原判据只用上一条的 text_length，大字弹幕占位更久却被误判为「已错开」，
--      于是大字与小字同轨并行、上下压字；
--   ④ 补「上一条是否还在屏上」的校验。原算法在 bias > 0（追及时刻为正）时直接放行，
--      但 bias > 0 只说明「新弹幕会在屏幕外追上前一条」，不代表入屏瞬间两者不重叠：
--      实测 4 条同文本弹幕间隔 11s、滚动 15s，四条全被判进第 1 行，
--      而第 1 条要到 t=16 才离场，第 2 条 t=12 就入屏 → t=12~16 四条并行同轨、整片叠字。
--      现在要求复用某行时上一条已完全离场（appear_time - previous_appear_time >= roll_time），
--      未离场则跳过该行；所有行都未离场则回退到原「追及点在屏外」的宽松判据，
--      以免弹幕被全部丢弃（宁可局部叠字，也不整屏无弹幕）。
function get_position_y(font_size, appear_time, text_length, resolution_x, roll_time, array)
    local velocity = (text_length + resolution_x) / roll_time
    local best_row = 0
    local best_bias = -math.huge
    local fallback_row = nil

    for i = 1, array.rows do
        local previous_appear_time = array:get_time(i)
        if array:get_time(i) < 0 then
            array:occupy(i, appear_time, appear_time + roll_time, font_size, text_length)
            return array:get_y(i)
        end

        -- 上一条是否已经完全离场：没离场就不能复用该行
        -- [lc-1287] 用轨道记录的 until_time（真实到期时刻）判定，而非一律按 roll_time：
        -- 共享轨道池后该行可能是顶部/底部弹幕（只占 fixtime 秒）或更早的滚动弹幕，
        -- 统一用 roll_time 会把早已离场的固定弹幕误判为「还在屏上」，白占一行。
        local dt = appear_time - previous_appear_time
        local prev_left = appear_time >= array:free_at(i)
        -- 记录第一个「未离场但追及点在屏外」的候选行，供回退使用
        if not prev_left and not fallback_row and array:get_font_size(i) == font_size then
            local prev_len = array:get_length(i)
            local prev_v = (prev_len + resolution_x) / roll_time
            local dx = dt * prev_v - (prev_len + text_length) / 2
            if dx >= 0 then
                local dv = velocity - prev_v
                if dv <= 0 then
                    fallback_row = i
                else
                    local t_catch = previous_appear_time + dx / dv
                    if prev_v * (t_catch - previous_appear_time) > resolution_x then
                        fallback_row = i
                    end
                end
            end
        end

        local same_size = math.abs((array:get_font_size(i) or array.font_size) - font_size) < 0.5

        local previous_length = array:get_length(i)
        local previous_velocity = (previous_length + resolution_x) / roll_time
        local delta_velocity = velocity - previous_velocity
        local delta_x = dt * previous_velocity - (previous_length + text_length) / 2

        -- [lc-1286]④ 上一条仍在屏上 → 该行不可用，直接看下一行
        if not prev_left then goto continue end

        if delta_x >= 0 then
            if delta_velocity <= 0 then
                if not same_size then goto continue end
                array:occupy(i, appear_time, appear_time + roll_time, font_size, text_length)
                return array:get_y(i)
            end

            local delta_time = delta_x / delta_velocity
            local bias = dt - delta_time
            -- 判断：追及点是否在屏幕之外
            local t_catch = previous_appear_time + delta_time
            local distance_prev = previous_velocity * (t_catch - previous_appear_time)
            if distance_prev > resolution_x then
                -- 追及发生在屏幕之外，允许放置
                array:occupy(i, appear_time, appear_time + roll_time, font_size, text_length)
                return array:get_y(i)
            end
            if bias > 0 then
                array:occupy(i, appear_time, appear_time + roll_time, font_size, text_length)
                return array:get_y(i)
            elseif bias > best_bias then
                best_bias = bias
                best_row = i
            end
        end
        ::continue::
    end

    -- [lc-1288] 所有行都还被占用时的回退：优先用循环中记下的 fallback_row
    -- （该行上一条字号相同、且追及点落在屏幕之外 → 两条不会真的撞上）。
    -- 此前 fallback_row 只算不用、直接 return nil，把整批弹幕丢成 Comment，
    -- 表现为「一段出现一下、隔很久才出现下一段」：实测 200 条等间隔(0.35s)弹幕
    -- 被丢弃 65 条(32.5%)、最大空档拉到 6s；修复前原样行为是 200 条全显示、
    -- 最大空档 1.0s。
    if fallback_row then
        array:occupy(fallback_row, appear_time, appear_time + roll_time, font_size, text_length)
        return array:get_y(fallback_row)
    end
    -- best_row 是追及最晚的一行（bias 最大，最接近自然错开），次优选择
    if best_row > 0 then
        array:occupy(best_row, appear_time, appear_time + roll_time, font_size, text_length)
        return array:get_y(best_row)
    end
    -- 所有行都被占用且无任何候选，放弃渲染
    return nil
end

-- 固定弹幕（顶部/底部）Y 坐标算法
-- [lc-1286] 行间距走 array.row_height。
-- [lc-1287] 与滚动弹幕共用同一轨道池（见 convert_danmaku_to_ass 的 track_array）：
--   原先 roll_array / top_array 是两个独立数组，两者都从第 1 行(y=1)开始排，
--   于是顶部/底部弹幕必然落在滚动弹幕所占的行上 → 上下压字（实测 R2L[1,16]fs37
--   与 TOP[2,7]fs30 同处 y=1 且时间重叠）。改为共享轨道后，固定弹幕会避开
--   滚动弹幕正在占用的行。
--   占位时长记录真实持续时间（appear_time + fixtime），而滚动弹幕记 appear_time + roll_time，
--   两者在同一行的时间轴上才能互不误判（见 DanmakuArray:occupy / free_at）。
function get_fixed_y(font_size, appear_time, fixtime, array, from_top)
    local best_row = 0
    local best_bias = -1
    local row_start, row_end, row_step
    if from_top then
        row_start, row_end, row_step = 1, array.rows, 1
    else
        row_start, row_end, row_step = array.rows, 1, -1
    end

    for i = row_start, row_end, row_step do
        local previous_appear_time = array:get_time(i)
        -- [lc-1287] 该行若还被上一条（滚动或固定）占用且未到期，则不可用。
        -- 原先固定弹幕只看 fixtime 内的间隔、不看滚动弹幕的 scrolltime 占用，
        -- 于是直接抢走滚动弹幕正在用的行。
        local free_at = array:free_at(i)
        if previous_appear_time < 0 or appear_time >= free_at then
            if array:get_font_size(i) ~= font_size and free_at > appear_time then goto next_row end
            array:occupy(i, appear_time, appear_time + fixtime, font_size)
            return array:get_y(i)
        else
            local delta_time = appear_time - previous_appear_time
            if delta_time > best_bias then
                best_bias = delta_time
                best_row = i
            end
        end
        ::next_row::
    end
    -- 所有行都被占用，放弃渲染
    return nil
end

-- 将弹幕转换为 ASS 格式
function convert_danmaku_to_ass(all_danmaku, danmaku_file)
    if #all_danmaku == 0 then
        msg.info("弹幕文件为空或解析失败")
        return false
    end
    msg.info("已解析 " .. #all_danmaku .. " 条弹幕")

    local alpha = string.format("%02X", (1 - tonumber(options.opacity)) * 255)
    local bold = options.bold and "1" or "0"
    -- [lc-1300] 排版轨道/文本宽度估算与渲染 Style 用同一字号（原版行为：直接用
    -- options.fontsize；lc-1299 的显示高补偿是双重缩放，已随 utils.lua 一并移除）
    local fontsize = tonumber(options.fontsize) or 50
    local scrolltime = tonumber(options.scrolltime) or 15
    local fixtime = tonumber(options.fixtime) or 5
    local outline = tonumber(options.outline) or 1.0
    local shadow = tonumber(options.shadow) or 0.0

    local res_x = 1920
    local res_y = 1080

    -- [lc-1287] 滚动 / 顶部 / 底部弹幕共用同一个轨道池：三类弹幕的 Y 都来自同一组行，
--   任一行同一时刻只能被一条弹幕占用，从根本上消除跨类型压字（原先 roll_array 与
--   top_array 是两套独立行号，都从第 1 行开始排，顶部弹幕必然落在滚动弹幕的行上）。
local track_array = DanmakuArray:new(res_x, res_y, fontsize)

    local ass_header = string.format([[
[Script Info]
Title: DanmakuConvert for mpv
ScriptType: v4.00+
Collisions: Normal
PlayResX: %d
PlayResY: %d
Timer: 100.0000
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: R2L,%s,%d,&H%sFFFFFF,&H00FFFFFF,&H00000000,&H%s000000,%d,0,0,0,100,100,0,0,1,%.1f,%.1f,7,0,0,0,1
Style: TOP,%s,%d,&H%sFFFFFF,&H00FFFFFF,&H00000000,&H%s000000,%d,0,0,0,100,100,0,0,1,%.1f,%.1f,8,0,0,0,1
Style: BTM,%s,%d,&H%sFFFFFF,&H00FFFFFF,&H00000000,&H%s000000,%d,0,0,0,100,100,0,0,1,%.1f,%.1f,2,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
]], res_x, res_y, options.fontname, fontsize, alpha, alpha, bold, outline, shadow,
    options.fontname, fontsize, alpha, alpha, bold, outline, shadow,
    options.fontname, fontsize, alpha, alpha, bold, outline, shadow)

    -- 预处理弹幕，先计算时间段以便进行数量限制
    local pre_events = {}
    for _, d in ipairs(all_danmaku) do
        local time = d.type == 1 and math.floor(d.time + 0.5) or d.time
        local appear_time = time
        local danmaku_type = d.type

        local end_time = nil
        if danmaku_type >= 1 and danmaku_type <= 3 then
            end_time = appear_time + scrolltime
        elseif danmaku_type == 5 or danmaku_type == 4 then
            end_time = appear_time + fixtime
        end

        if end_time then
            table.insert(pre_events, {start_time = appear_time, end_time = end_time, danmaku = d})
        end
    end

    -- [lc-1253] 相同弹幕聚合：先于 max_screen 限制执行（合并后数量减少，限额不误伤组内重叠）。
    -- 以组首事件为锚，merge_window 秒内同文本同类型合并为一条，count 记录重叠次数。
    if options.merge_same_text then
        local merged_events = {}
        local cur = nil
        for _, ev in ipairs(pre_events) do
            local d = ev.danmaku
            if cur and d.type == cur.danmaku.type and d.text == cur.danmaku.text
                and (ev.start_time - cur.start_time) <= (options.merge_window or 10) then
                cur.count = (cur.count or 1) + 1
            else
                if cur then table.insert(merged_events, cur) end
                cur = { start_time = ev.start_time, end_time = ev.end_time, danmaku = d, count = 1 }
            end
        end
        if cur then table.insert(merged_events, cur) end
        pre_events = merged_events
    end

    if options.max_screen_danmaku > 0 then
        pre_events = limit_danmaku(pre_events, options.max_screen_danmaku)
    end

    local ass_events = {}
    for _, ev in ipairs(pre_events) do
        local d = ev.danmaku
        local appear_time = ev.start_time
        local danmaku_type = d.type
        local text = ass_escape(decode_html_entities(d.text))
                    :gsub("x(%d+)$", "{\\b1\\i1}x%1")

        -- [lc-1253] 聚合弹幕：追加 ×N 后缀，字号按重叠次数放大（内联 \fs 覆写，log2 增长）；
        -- [lc-1256] 曲线收紧（与网页端一致）：×2 仅 +8%，×16 及以上封顶 +30%——
        -- 旧曲线 ×2 +20% / 封顶 +80% 被反馈放大过猛，观感接近翻倍。
        -- [lc-1286] 宽度估算改用 layout_text（只含真正可见的字符）。原先直接对 text 求宽，
        -- 而 text 里含 "{\fs37}" / "{\b1\i1}" 等覆写标签——这些字符被 get_str_width 当成
        -- 可见字宽累加 → 布局宽度虚高（实测「666」×8 在 1080p/30px 下：真实可见 111px，
        -- 旧算法得 175px）。虚高会让轨道分配误判「两条弹幕已拉开距离」，把本该错开的
        -- 弹幕放进同一行 → 用户看到的遮挡。反向的 ×N 后缀此前也被漏算，一并修正。
        -- × 用乘号字符，不与来源自带的 xN gsub 冲突
        local count = tonumber(ev.count) or 1
        local ev_fs = fontsize
        local layout_text = text
        if options.merge_same_text and count > 1 then
            local mult = 1 + 0.08 * (math.log(count) / math.log(2))
            if mult > MERGE_FS_MAX_MULT then mult = MERGE_FS_MAX_MULT end
            ev_fs = math.floor(fontsize * mult + 0.5)
            local suffix = string.format(" ×%d", count)
            layout_text = layout_text .. suffix
            text = string.format("{\\fs%d}", ev_fs) .. text
            text = text .. string.format("{\\b1\\i1} ×%d", count)
        end

        -- 颜色从十进制转为 BGR Hex
        local color = math.max(0, math.min(d.color or 0xFFFFFF, 0xFFFFFF))
        local color_hex = string.format("%06X", color)
        local r = string.sub(color_hex, 1, 2)
        local g = string.sub(color_hex, 3, 4)
        local b = string.sub(color_hex, 5, 6)
        local color_text = string.format("{\\c&H%s%s%s&}", b, g, r)

        local start_time_str = seconds_to_time(appear_time)
        local layer, end_time_str, style, effect

        -- 滚动弹幕 (类型 1, 2, 3)
        if danmaku_type >= 1 and danmaku_type <= 3 then
            layer = 0
            end_time_str = seconds_to_time(ev.end_time)
            style = "R2L"
            -- [lc-1286] 用 layout_text（仅可见字符）求宽；宽度决定 x1/x2 与轨道冲突判定
            local text_length = get_str_width(layout_text, ev_fs)
            local x1 = res_x + text_length / 2
            local x2 = -text_length / 2
            -- [lc-1286] 传该条**实际**字号（ev_fs），原先恒传基础字号 → 同轨字号判据失效
            local y = get_position_y(ev_fs, appear_time, text_length, res_x, scrolltime, track_array)
            if y then
                effect = string.format("{\\move(%d, %d, %d, %d)}", x1, y, x2, y)
            end

        -- 顶部弹幕 (类型 5)
        elseif danmaku_type == 5 then
            layer = 1
            end_time_str = seconds_to_time(ev.end_time)
            style = "TOP"
            local x = res_x / 2
            -- [lc-1286] 传该条实际字号 ev_fs（聚合放大的顶部弹幕同样要占更高的行）
            local y = get_fixed_y(ev_fs, appear_time, fixtime, track_array, true)
            if y then
                effect = string.format("{\\pos(%d, %d)}", x, y)
            end

        -- 底部弹幕 (类型 4)
        elseif danmaku_type == 4 then
            layer = 1
            end_time_str = seconds_to_time(ev.end_time)
            style = "BTM"
            local x = res_x / 2
            local y = get_fixed_y(ev_fs, appear_time, fixtime, track_array, false)
            if y then
                effect = string.format("{\\pos(%d, %d)}", x, y)
            end
        end

        if style then
            local line = nil
            if effect then
               line = string.format("Dialogue: %d,%s,%s,%s,,0,0,0,,%s%s%s", layer, start_time_str, end_time_str, style, effect, color_text, text)
            else
               line = string.format("Comment: %d,%s,%s,%s,,0,0,0,,%s%s", layer, start_time_str, end_time_str, style, color_text, text)
            end
            table.insert(ass_events, line)
        end
    end

    local final_ass = ass_header .. table.concat(ass_events, "\n")

    local ass_file = io.open(danmaku_file, "w")
    if not ass_file then
        msg.info("错误: 无法写入 ASS 弹幕文件")
        return false
    end
    ass_file:write(final_ass)
    ass_file:close()

    msg.debug("已成功转换并写入 ASS：" .. danmaku_file)
    return true
end

-- 将弹幕转换为 XML 格式
function convert_danmaku_to_xml(danmaku_input, danmaku_out, delays)
   local all_danmaku = parse_danmaku_files(danmaku_input, delays)
   if not all_danmaku then
        show_message("转换 XML 弹幕失败", 3)
        msg.info("转换 XML 弹幕失败")
        return
   end

    -- 拼接为 XML 内容
    local xml = { '<?xml version="1.0" encoding="UTF-8"?><i>\n' }
    for _, d in ipairs(all_danmaku) do
        local time = d.time
        local type = d.type or 1
        local size = d.size or 25
        local color = d.color or 0xFFFFFF
        local text = d.text or ""

        text = text:gsub("&", "&amp;")
                   :gsub("<", "&lt;")
                   :gsub(">", "&gt;")
                   :gsub("\"", "&quot;")
                   :gsub("'", "&apos;")

        table.insert(xml, string.format('<d p="%s,%s,%s,%s">%s</d>\n', time, type, size, color, text))
    end
    table.insert(xml, '</i>')

    -- 写入 XML 文件
    local file = io.open(danmaku_out, "w")
    if not file then
        show_message("无法写入目标 XML 文件", 3)
        msg.info("无法写入目标 XML 文件: " .. danmaku_out)
        return false
    end
    file:write(table.concat(xml))
    file:close()
    show_message("转换 XML 弹幕成功： " .. danmaku_out, 3)
    msg.info("转换 XML 弹幕成功： " .. danmaku_out)
    return true
end

-- 解析和转换弹幕
function convert_danmaku_format(danmaku_input, danmaku_file, delays)
    local all_danmaku = parse_danmaku_files(danmaku_input, delays)
    if all_danmaku then
        convert_danmaku_to_ass(all_danmaku, danmaku_file)
    else
        msg.info("未能解析对应的 .xml 或 .json 弹幕文件")
        return false
    end
end
