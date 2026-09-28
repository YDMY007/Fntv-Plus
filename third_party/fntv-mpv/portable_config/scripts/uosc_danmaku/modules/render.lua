-- modified from https://github.com/rkscv/danmaku/blob/main/danmaku.lua
local msg = require('mp.msg')
local utils = require("mp.utils")

-- [lc-1272] 渲染步进：vf_fps=yes 时 0.01s(100Hz)。120Hz 显示器与 100Hz 更新无法整除对齐，
--   有的显示帧重复旧位置、有的帧跳新位置 → 全屏下肉眼可见「左右抖动」。
--   display-fps 观察器会把步进改为「显示器刷新率 ÷2」(60Hz@120屏) 实现整帧对齐。
local INTERVAL = options.vf_fps and 0.01 or 0.001
local osd_width, osd_height, pause = 0, 0, true

-- 提取 \move 参数 (x1, y1, x2, y2) 并返回
local function parse_move_tag(text)
    -- 匹配包括小数和负数在内的坐标值
    local x1, y1, x2, y2 = text:match("\\move%((%-?[%d%.]+),%s*(%-?[%d%.]+),%s*(%-?[%d%.]+),%s*(%-?[%d%.]+).*%)")
    if x1 and y1 and x2 and y2 then
        return tonumber(x1), tonumber(y1), tonumber(x2), tonumber(y2)
    end
    return nil
end

local function parse_comment(event, pos, height, delay)
    local x1, y1, x2, y2 = parse_move_tag(event.text)
    local displayarea = tonumber(height * options.displayarea)
    if not x1 then
        local current_x, current_y = event.text:match("\\pos%((%-?[%d%.]+),%s*(%-?[%d%.]+).*%)")
        if not current_y or tonumber(current_y) > displayarea then return end
        if event.style ~= "SP" and event.style ~= "MSG" then
            return string.format("{\\an8}%s", event.text)
        else
            return string.format("{\\an7}%s", event.text)
        end
    end

    -- 计算移动的时间范围
    local duration = event.end_time - event.start_time  --mean: options.scrolltime
    local progress = (pos - event.start_time - delay) / duration  -- 移动进度 [0, 1]

    -- 计算当前坐标
    local current_x = tonumber(x1 + (x2 - x1) * progress)
    local current_y = tonumber(y1 + (y2 - y1) * progress)

    -- 移除 \move 标签并应用当前坐标
    -- [lc-1272] 坐标精度 0.1px→0.01px：全屏后物理分辨率翻倍（overlay 纹理实测 4096 宽），
    --   0.1 逻辑像素的量化误差在物理像素间来回取整 → 弹幕左右抖动；0.01 足够平滑。
    local clean_text = event.text:gsub("\\move%(.-%)", "")
    if current_y > displayarea then return end
    if event.style ~= "SP" and event.style ~= "MSG" then
        return string.format("{\\pos(%.2f,%.2f)\\an8}%s", current_x, current_y, clean_text)
    else
        return string.format("{\\pos(%.2f,%.2f)\\an7}%s", current_x, current_y, clean_text)
    end
end

-- 从 ASS 文件中解析样式和事件
local function parse_ass_events(ass_path, callback)
    local ass_file = io.open(ass_path, "r")
    if not ass_file then
        callback("无法打开 ASS 文件")
        return
    end

    local events = {}
    local time_tolerance = options.merge_tolerance

    for line in ass_file:lines() do
        if line:match("^Dialogue:") then
            local start_time, end_time, style, text = line:match("Dialogue:%s*[^,]*,%s*([^,]*),%s*([^,]*),%s*([^,]*),[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,(.*)")

            if start_time and end_time and text then
                local event = {
                    start_time = time_to_seconds(start_time),
                    end_time = time_to_seconds(end_time),
                    style = style,
                    text = text:gsub("%s+$", ""),
                    clean_text = text:gsub("\\h+", " "):gsub("{[\\=].-}", ""):gsub("^%s*(.-)%s*$", "%1"),
                    pos = text:match("\\pos"),
                    move = text:match("\\move"),
                }

                table.insert(events, event)
            end
        end
    end

    table.sort(events, function(a, b)
        return a.start_time < b.start_time
    end)

    ass_file:close()
    callback(nil, events)
end

local overlay = mp.create_osd_overlay('ass-events')

function render()
    if COMMENTS == nil then return end

    local pos, err = mp.get_property_number('time-pos')
    if err ~= nil then
        return msg.error(err)
    end

    local delay = get_delay_for_time(DELAYS, pos)

    local fontname = options.fontname
    local fontsize = options.fontsize
    local alpha = string.format("%02X", (1 - tonumber(options.opacity)) * 255)

    local width, height = 1920, 1080
    local ratio = osd_width / osd_height
    if width / height < ratio then
        height = width / ratio
        fontsize = options.fontsize - ratio * 2
    end

    local ass_events = {}

    for _, event in ipairs(COMMENTS) do
        if pos >= event.start_time + delay and pos <= event.end_time + delay then
            local text = parse_comment(event, pos, height, delay)
            if text then
                text = text:gsub("&#%d+;","")
            end

            if text and text:match("\\fs%d+") then
                text = text:gsub("\\fs(%d+)", function(size)
                    return string.format("\\fs%d", size * 1.5)
                end)
            end

            -- 构建 ASS 字符串
            local ass_text = text and string.format("{\\rDefault\\fn%s\\fs%d\\c&HFFFFFF&\\alpha&H%s\\bord%s\\shad%s\\b%s\\q2}%s",
                fontname, fontsize, alpha, options.outline, options.shadow, options.bold and "1" or "0", text)

            table.insert(ass_events, ass_text)
        end
    end

    overlay.res_x = width
    overlay.res_y = height
    overlay.data = table.concat(ass_events, '\n')
    overlay:update()
end

local timer = mp.add_periodic_timer(INTERVAL, render, true)

function parse_danmaku(ass_file_path, from_menu, no_osd)
    parse_ass_events(ass_file_path, function(err, events)
        COMMENTS = events
        if err then
            msg.error("ASS 解析错误: " .. err)
            return
        end

        if ENABLED and (from_menu or get_danmaku_visibility()) then
            if not no_osd then
                show_loaded(true)
            end
            if uosc_available and sync_danmaku_toggle_btn then sync_danmaku_toggle_btn() end
            show_danmaku_func()
        else
            show_message("")
            hide_danmaku_func()
        end
    end)
end

local function filter_state(label, name)
    local filters = mp.get_property_native("vf")
    for _, filter in pairs(filters) do
        if filter.label == label or filter.name == name
        or filter.params[name] ~= nil then
            return true
        end
    end
    return false
end

function show_danmaku_func()
    render()
    mp.set_property_bool(HAS_DANMAKU, true)
    if not pause then
        timer:resume()
    end
    if options.vf_fps then
        local display_fps = mp.get_property_number('display-fps')
        local video_fps = mp.get_property_number('estimated-vf-fps')
        if (display_fps and display_fps < 58) or (video_fps and video_fps > 58) then
            return
        end
        if not filter_state("danmaku", "fps") then
            mp.commandv("vf", "append", string.format("@danmaku:fps=fps=%s", options.fps))
        end
    end
end

function hide_danmaku_func()
    timer:kill()
    mp.set_property_bool(HAS_DANMAKU, false)
    overlay:remove()
    if filter_state("danmaku") then
        mp.commandv("vf", "remove", "@danmaku")
    end
end

-- [lc-1267/1268] 消息堆叠 + 占位：每条消息各带到期时间，按行堆在同一处渲染（\N 换行）。
--   sticky（占位）消息不过期、一直显示（如「弹幕加载中...」），任意下一条消息出现时被顶替；
--   普通消息按各自时长堆叠展示，相同文本重复弹出只保留一条。
--   堆叠上限 4 条，超出丢最旧的；全部到期后移除 overlay 并停表。
local message_overlay = mp.create_osd_overlay('ass-events')
local active_messages = {}   -- { { text = ..., expire = ..., sticky = ... } }

local function render_message_block()
    local lines = {}
    for _, m in ipairs(active_messages) do lines[#lines + 1] = m.text end
    local message = string.format("{\\an%d\\pos(%d,%d)}%s", options.message_anlignment,
       options.message_x, options.message_y, table.concat(lines, "\\N"))
    local width, height = 1920, 1080
    local ratio = osd_width / osd_height
    if width / height < ratio then
        height = width / ratio
    end
    message_overlay.res_x = width
    message_overlay.res_y = height
    message_overlay.data = message
    message_overlay:update()
end

-- ⚠️ message_timer 必须前置声明：回调里要用到它自己，而 `local x = f(function() x end)`
-- 的 x 在初始化表达式中尚未进入作用域（会被解析成全局 nil → 回调一执行就崩掉整个脚本）。
local message_timer
message_timer = mp.add_periodic_timer(0.25, function()
    local now = mp.get_time()
    local keep, pruned = {}, false
    for _, m in ipairs(active_messages) do
        if m.expire > now then keep[#keep + 1] = m else pruned = true end
    end
    if #keep ~= #active_messages then active_messages = keep end
    if #active_messages == 0 then
        message_timer:kill()
        message_overlay:remove()
        return
    end
    if pruned then render_message_block() end
end)
message_timer:kill()   -- 空闲时不空转，首条消息弹出时再启动

function show_message(text, time, sticky)
    local expire = sticky and math.huge or (mp.get_time() + (time or 3) + 0.05)
    -- 新消息出现时：顶掉所有占位条 + 同文本旧条
    for i = #active_messages, 1, -1 do
        local m = active_messages[i]
        if m.sticky or m.text == text then table.remove(active_messages, i) end
    end
    if not sticky and #active_messages >= 4 then table.remove(active_messages, 1) end
    active_messages[#active_messages + 1] = { text = text, expire = expire, sticky = sticky }
    render_message_block()
    if not message_timer:is_enabled() then message_timer:resume() end
end

mp.observe_property('osd-width', 'number', function(_, value) osd_width = value or osd_width end)
mp.observe_property('osd-height', 'number', function(_, value) osd_height = value or osd_height end)
-- [lc-1272] 步进=两显示帧(2/fps)：更新频率是刷新率的整约数，逐帧位置严格对齐，
--   消除「100Hz 更新 × 120Hz 显示」错频造成的抖动；比 1/fps 省一半重排开销。
mp.observe_property('display-fps', 'number', function(_, value)
    if value ~= nil then
        local interval = 2 / value
        if interval > INTERVAL then
            timer:kill()
            timer = mp.add_periodic_timer(interval, render, true)
            if ENABLED then
                timer:resume()
            end
        else
            timer:kill()
            timer = mp.add_periodic_timer(INTERVAL, render, true)
            if ENABLED then
                timer:resume()
            end
        end
    end
end)
mp.observe_property('pause', 'bool', function(_, value)
    if value ~= nil then
        pause = value
    end
    if ENABLED then
        if pause then
            timer:kill()
        elseif COMMENTS ~= nil then
            timer:resume()
        end
    end
end)

mp.register_event('playback-restart', function(event)
    if event.error then
        return msg.error(event.error)
    end
    if ENABLED and COMMENTS ~= nil then
        render()
    end
end)

mp.add_hook("on_unload", 50, function()
    COMMENTS, DELAY = nil, 0
    timer:kill()
    overlay:remove()
    mp.set_property_native(DELAY_PROPERTY, 0)
    if filter_state("danmaku") then
        mp.commandv("vf", "remove", "@danmaku")
    end

    local files_to_remove = {
        file1 = utils.join_path(DANMAKU_PATH, "danmaku-" .. PID .. ".json"),
        file2 = utils.join_path(DANMAKU_PATH, "danmaku-" .. PID .. ".ass"),
        file3 = utils.join_path(DANMAKU_PATH, "temp-" .. PID .. ".mp4"),
        file4 = utils.join_path(DANMAKU_PATH, "bahamut-" .. PID .. ".json")
    }

    if options.save_danmaku and file_exists(files_to_remove.file2) then
        save_danmaku(true)
    end

    for _, file in pairs(files_to_remove) do
        if file_exists(file) then
            os.remove(file)
        end
    end

    for _, source in pairs(DANMAKU.sources) do
        if source.fname and source.from and source.from ~= "user_local" and file_exists(source.fname) then
            os.remove(source.fname)
        end
    end
    DANMAKU = {sources = {}, count = 1}
    -- 换文件时重置 B站关联元数据，避免配置面板显示上一集的残留状态
    BILI_INFO = nil
end)
