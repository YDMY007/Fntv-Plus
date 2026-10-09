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

-- [lc-1303] 固定弹幕（顶部/底部）居中等三条常量：
--   FIXED_ZONE_HALF   滚动弹幕判定「是否走过屏幕中央」时按「中线 ± 该半径」预留净空：
--                     240px ≈ 16 个汉字 @字号30，覆盖绝大多数固定弹幕宽度。
--   FIXED_MAX_WAIT    固定弹幕为躲开穿行中的滚动弹幕，最多愿意延后多少秒出现。
--   FREE_LANE_SCORE   整行空闲的加分。取 1e5：高于任何接力行可能出现的净空（几百~几千），
--                     于是「空闲行 > 有净空的接力行」这个次序在同类行之间成立。
--   FIXED_LANE_RESERVE 预留行的减分，取 1e6：量级压过空闲加分 —— 首行/末行只有在
--                     其余所有行都接不下时才会被滚动弹幕占用，从而把这两行尽可能
--                     留给顶部/底部弹幕（它们整段窗口定在中央，行被滚动弹幕占着就只能
--                     硬塞进去压字，实测固定弹幕压字样本 59 个 → 预留后为 0）。
local FIXED_ZONE_HALF = 240
local FIXED_MAX_WAIT = 3.0
local FREE_LANE_SCORE = 1e5
local FIXED_LANE_RESERVE = 1e6

function DanmakuArray:new(res_x, res_y, font_size, displayarea)
    local row_font_size = math.max(font_size, math.ceil(font_size * MERGE_FS_MAX_MULT))
    -- [lc-1292] 轨道池只按**可见区域**建，而不是整屏：
    -- 渲染端（render.lua parse_comment / write_render_file）会丢弃 y > 高度*displayarea 的弹幕，
    -- 排版端却按满屏 res_y 建满 rows，于是排到「不可见行」的弹幕全部白丢。
    -- 实测 fontsize=30 / displayarea=0.35 / scrolltime=15 时：满屏 27 行里只有 9 行可见，
    -- 200 条弹幕有 155 条（78%）被分配到看不见的行上——这才是「稀稀拉拉」的主因。
    -- 可见行数 = floor(res_y * displayarea / 行高)，行高不变保证放大弹幕仍不压行。
    local area = tonumber(displayarea) or 0.85
    if area <= 0 or area > 1 then area = 0.85 end
    local usable_height = res_y * area
    local obj = {
        solution_y = usable_height,
        font_size = font_size,
        -- 每条轨道占的高度 = max(基础字号, 放大上限)，保证放大弹幕不越界压到下一行
        row_height = row_font_size,
        rows = math.floor(usable_height / row_font_size),
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

-- [lc-1303] 轨道占用改为**双槽位**记录：滚动链头（time/length/font_size/until_time）
--   与顶部/底部弹幕的占用窗口（fixed_until）互不覆盖。两类弹幕的冲突模型不同 ——
--   滚动弹幕之间是**追及问题**（只要错开就能共用一行），顶部/底部弹幕定在屏幕中央不动
--   （滚动弹幕穿过它必然压字，只能等它到期）。旧实现只有一个槽位、后写者覆盖前者：
--   固定弹幕的记录会抹掉滚动链头，链头上的接力判据随之失效。
function DanmakuArray:occupy(row, appear_time, until_time, font_size, length)
    if row > 0 and row <= self.rows then
        local prev = self.time_length_array[row]
        self.time_length_array[row] = {
            time = appear_time, length = length or 0,
            font_size = font_size, until_time = until_time,
            -- 固定弹幕窗口原样保留，不参与滚动弹幕的接力判据
            fixed_until = prev and prev.fixed_until or -1,
            -- 屏幕中央被滚动弹幕「走空」的时刻，同样继承（见 mark_center_clear）
            center_clear = prev and prev.center_clear or -1,
        }
    end
end

-- 顶部/底部弹幕占位：只写 fixed_until，滚动链头原样保留，
-- 于是后续滚动弹幕仍能按接力判据判定这一行。
function DanmakuArray:occupy_fixed(row, until_time)
    if row > 0 and row <= self.rows then
        local rec = self.time_length_array[row]
        if rec then
            if until_time > (rec.fixed_until or -1) then
                rec.fixed_until = until_time
            end
        else
            self.time_length_array[row] = { time = -1, length = 0, fixed_until = until_time }
        end
    end
end

-- [lc-1303] 屏幕中央的「净空时刻」：固定弹幕恒在中央，只要该行有滚动弹幕还在
--   中央附近穿行，两者就会压字。单个槽位只记得住**最后一条**，而接力模型下一行
--   同时飞着好几条（前几条可能正穿过中央）—— 所以按「整行取最大值」记一个时间戳：
--   每放一条滚动弹幕就推进一次 = 该行中央被所有已知弹幕走空的时刻。
function DanmakuArray:mark_center_clear(row, clear_at)
    if row > 0 and row <= self.rows then
        local rec = self.time_length_array[row]
        if rec and clear_at > (rec.center_clear or -1) then
            rec.center_clear = clear_at
        end
    end
end

function DanmakuArray:center_clear_at(row)
    if row > 0 and row <= self.rows then
        return self.time_length_array[row].center_clear or -1
    end
    return -1
end

function DanmakuArray:fixed_until(row)
    if row > 0 and row <= self.rows then
        return self.time_length_array[row].fixed_until or -1
    end
    return -1
end

-- 该行彻底空闲的时刻 = 滚动链头离场与固定弹幕到期取较晚者
function DanmakuArray:free_at(row)
    if row > 0 and row <= self.rows then
        local rec = self.time_length_array[row]
        local a, b = rec.until_time or -1, rec.fixed_until or -1
        return a > b and a or b
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

-- [lc-1286] 字号维度：轨道除时间/宽度外还要记住该行上一条的**实际字号**（聚合弹幕放大后更宽）。
function DanmakuArray:get_font_size(row)
    if row > 0 and row <= self.rows then
        return self.time_length_array[row].font_size or self.font_size
    end
    return self.font_size
end

-- 滚动弹幕 Y 坐标算法
-- [lc-1303] 改为**接力模型**（用户反馈「弹幕只有十来条」「一抽一抽的」「重叠也没修好」）。
--   旧实现（lc-1286④ + lc-1294）要求某行上一条**完全离场**才能复用该行，只剩两条兜底路径
--   能把弹幕塞回去，于是要么整条丢弃、要么挤成一团。实测本机配置（fontsize=30 /
--   displayarea=0.35 → 9 行 / scrolltime=15 / 180 条弹幕）：仅 66 条上屏、79 条被丢（44%），
--   同屏最多 11 条 —— 正是「只有十来条」。
--   容量账：独占模型单行 = 1 条/roll_time，9 行合计 ≈ 0.6 条/秒（热门视频 1.5~3 条/秒必溢出）；
--   接力模型单行可并行 ≈ roll_time ÷ (弹幕宽 ÷ 速度)（15s ÷ 1.4s ≈ 10 条），9 行合计 ≈ 90 条。
--   两条硬条件（缺一即压字）：
--     ① 入轨不压字：净空 gap = 上一条速度 × 入轨间隔 - 上一条宽度 ≥ 0；
--     ② 追及发生在离场之后：本条更快时，追上上一条的时刻 ≥ 上一条飞出屏幕的时刻。
--   另外**不再「第一个能用的行就用」**（first-fit 会把弹幕全堆进第 1、2 行，
--   上几行挤成一片、下面几行空着 —— 既难看又提前触发溢出）：安全行里取净空最大的
--   那行，等于「最闲的行优先」，弹幕自然摊到全部轨道上。
--   所有行都在接力时，取净空最大的一行放入（沿用 lc-1286 起的口径：宁可局部微重叠，
--   也不整条丢弃 —— 丢一条是永久缺一条，微重叠只是瞬间擦身）。
function get_position_y(font_size, appear_time, text_length, resolution_x, roll_time, array)
    local velocity = (text_length + resolution_x) / roll_time
    local best_row, best_score = nil, -math.huge     -- 安全行里评分最高的
    local loose_row, loose_slack = nil, -math.huge   -- 全都不安全时净空最大的
    -- 本条弹幕的尾部彻底走空屏幕中央区域的时刻（供后续固定弹幕判定能否共用该行）。
    -- 中央区域按「屏幕中线 ± FIXED_ZONE_HALF」预留：顶部/底部弹幕居中显示，
    -- 宽到 ±240px（约 16 个汉字 @字号30）仍不会与已走空的滚动弹幕相交。
    local clear_at = appear_time + (resolution_x / 2 + FIXED_ZONE_HALF + text_length) / velocity
    local function place(row)
        array:occupy(row, appear_time, appear_time + roll_time, font_size, text_length)
        array:mark_center_clear(row, clear_at)
        return array:get_y(row)
    end

    for i = 1, array.rows do
        -- 该行有未到期的顶部/底部弹幕：滚动弹幕穿过屏幕中央时必然压字，跳过这一行
        if array:fixed_until(i) > appear_time then goto continue end

        local score
        local prev_time = array:get_time(i)
        if prev_time < 0 or appear_time >= array:free_at(i) then
            -- 整行空闲（空行 / 链头已离场 / 固定弹幕已到期）
            score = FREE_LANE_SCORE
        else
            -- 该行链头还在飞 → 按接力判据判定能否并行
            local prev_len = array:get_length(i)
            if prev_len > 0 then
                local prev_v = (prev_len + resolution_x) / roll_time
                local dt = appear_time - prev_time
                local gap = prev_v * dt - prev_len
                local safe = gap >= 0
                -- 本条更快 → 追及时刻 = 入轨时刻 + 净空 ÷ 速度差，要求那时链头已离场
                if safe and velocity > prev_v then
                    safe = appear_time + gap / (velocity - prev_v) >= prev_time + roll_time
                end
                if safe then
                    score = gap
                elseif gap > loose_slack then
                    loose_slack, loose_row = gap, i
                end
            end
        end

        if score then
            -- 首行/末行留给顶部与底部弹幕（它们整段窗口定在中央，普通行抢走后
            -- 固定弹幕就只能硬塞进去压字）：同样空闲时优先用其它行。
            if i == 1 or i == array.rows then
                score = score - FIXED_LANE_RESERVE
            end
            if score > best_score then
                best_score, best_row = score, i
            end
        end
        ::continue::
    end

    if best_row then return place(best_row) end
    -- 兜底：所有行都在接力中且都不安全 → 取净空最大的一行，把重叠面压到最小。
    -- 净空小到半条弹幕宽以上才认输丢弃（此时屏幕已经彻底排满，硬塞只会整片糊字）。
    if loose_row and loose_slack >= -text_length * 0.5 then
        return place(loose_row)
    end
    return nil
end

-- 固定弹幕（顶部/底部）Y 坐标算法（返回 y 与「延后秒数」）
-- [lc-1286] 行间距走 array.row_height（含聚合放大上限）。
-- [lc-1287] 与滚动弹幕共用同一轨道池，避免「顶部弹幕必然压在滚动弹幕的行上」。
-- [lc-1303] 判定与滚动弹幕能否共用该行，看「整行中央是否已走空」（center_clear_at）：
--   ① 该行现在就能用（整行空闲 / 中央已走空 / 上一条固定弹幕已到期）→ 立即放，延后 0；
--   ② 都不能立刻用 → **延后 fixtime 上限内的最短等待**，等到最快要走空的那一行，
--      换来零压字。固定弹幕整段窗口定在中央，与穿行中的滚动弹幕是硬冲突：
--      实测「宁可压字也不等」的版本压字样本 45~59 个（≈ 三成固定弹幕被压），
--      而顶/底弹幕晚出现 1~2 秒观众无感（弹幕本身的窗口就有 5 秒，且固定弹幕
--      不滚动，不存在「追不上进度」的问题）。
--   ③ 连等待上限都等不到（全屏彻底排满）→ 取中央最先走空的一行硬放，压字窗口最短。
--   判定必须看「整行」的时间戳：只看最后一条会漏掉接力链上还在中央穿行的前几条
--   （实测压字 46 对）；反向的「本条结束后它才到中央」也不能放行，更晚入轨的弹幕
--   可能更早穿过中央。
function get_fixed_y(font_size, appear_time, fixtime, array, from_top, resolution_x, roll_time, text_length)
    local wait_row, wait_delay = nil, math.huge    -- 需要等待时：等待最短的可零压字行
    local loose_row, loose_avail = nil, math.huge  -- 兜底一：只被滚动弹幕挡着的行（压字 1~2 秒）
    local clash_row, clash_avail = nil, math.huge  -- 兜底二：被另一条固定弹幕占着的行（整段压死）
    local row_start, row_end, row_step
    if from_top then
        row_start, row_end, row_step = 1, array.rows, 1
    else
        row_start, row_end, row_step = array.rows, 1, -1
    end

    for i = row_start, row_end, row_step do
        -- 该行「可供固定弹幕使用」的最早时刻：滚动弹幕走空中央、或上一条固定弹幕到期
        local fixed_until = array:fixed_until(i)
        local avail = array:center_clear_at(i)
        if fixed_until > avail then avail = fixed_until end
        -- 该行上一条还在飞（未离场）的滚动弹幕：固定弹幕走后它还要穿行一段，
        -- 但上面 center_clear 已经涵盖「是否穿过中央」，故无需再判 free_at

        if avail <= appear_time then
            array:occupy_fixed(i, appear_time + fixtime)
            return array:get_y(i), 0
        end
        local delay = avail - appear_time
        if delay < wait_delay then
            wait_delay, wait_row = delay, i
        end
        if fixed_until > appear_time then
            if avail < clash_avail then
                clash_avail, clash_row = avail, i
            end
        elseif avail < loose_avail then
            loose_avail, loose_row = avail, i
        end
    end

    -- 等得起就等（零压字优先）
    if wait_row and wait_delay <= FIXED_MAX_WAIT then
        array:occupy_fixed(wait_row, appear_time + wait_delay + fixtime)
        return array:get_y(wait_row), wait_delay
    end
    -- 等不起：全屏排满，硬放（原实现这里是 return nil，固定弹幕成片消失）。
    -- 只被滚动弹幕挡着的行优先 —— 与穿行的滚动弹幕压字只有 1~2 秒，
    -- 两条固定弹幕叠在一起则是整段窗口（5 秒）完全糊死。
    local row = loose_row or clash_row
    if row then
        array:occupy_fixed(row, appear_time + fixtime)
        return array:get_y(row), 0
    end
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
    local fontsize = tonumber(options.fontsize) or 30
    local scrolltime = tonumber(options.scrolltime) or 15
    local fixtime = tonumber(options.fixtime) or 5
    local outline = tonumber(options.outline) or 1.0
    local shadow = tonumber(options.shadow) or 0.0

    local res_x = 1920
    local res_y = 1080

    -- [lc-1287] 滚动 / 顶部 / 底部弹幕共用同一个轨道池：三类弹幕的 Y 都来自同一组行，
--   任一行同一时刻只能被一条弹幕占用，从根本上消除跨类型压字（原先 roll_array 与
--   top_array 是两套独立行号，都从第 1 行开始排，顶部弹幕必然落在滚动弹幕的行上）。
local track_array = DanmakuArray:new(res_x, res_y, fontsize, options.displayarea)

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
            -- [lc-1303] 一并传画布宽/滚动时长/本条宽度；返回的 delay>0 表示「等了一会儿
            --   才等到中央走空的行」，起止时间随之平移（顶/底弹幕晚 1~2 秒出现观众无感，
            --   换来零压字）
            local y, delay = get_fixed_y(ev_fs, appear_time, fixtime, track_array, true,
                res_x, scrolltime, get_str_width(layout_text, ev_fs))
            if y then
                delay = delay or 0
                if delay > 0 then
                    start_time_str = seconds_to_time(appear_time + delay)
                    end_time_str = seconds_to_time(ev.end_time + delay)
                end
                effect = string.format("{\\pos(%d, %d)}", x, y)
            end

        -- 底部弹幕 (类型 4)
        elseif danmaku_type == 4 then
            layer = 1
            end_time_str = seconds_to_time(ev.end_time)
            style = "BTM"
            local x = res_x / 2
            local y, delay = get_fixed_y(ev_fs, appear_time, fixtime, track_array, false,
                res_x, scrolltime, get_str_width(layout_text, ev_fs))
            if y then
                delay = delay or 0
                if delay > 0 then
                    start_time_str = seconds_to_time(appear_time + delay)
                    end_time_str = seconds_to_time(ev.end_time + delay)
                end
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
