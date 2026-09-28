--[[
MIT License

Copyright (c) 2025 Tag mig hånden

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

GitHub: https://github.com/QiaoKes/fntv-mpv-config
]]

local mp = require('mp')
local msg = require('mp.msg')
local mutils = require('./mutils')
local opt = require('mp.options')
local utils = require('mp.utils')
local api = require('./api')
local options = require('./options')
require("./menu")
local ask         = require('ask')
local opts        = options.opts
local DETECT_MODE = options.DETECT_MODE

-- ===== Fntv-Plus 扩展：theintrodb 兜底 + 可点击跳过按钮 =====
-- guid -> { tmdb=string, season=number?, episode=number? }，由 Electron 经 script-message 注入
local skip_meta_map = {}
local fnos_empty = false
local pending_fallback = false
local aniskip_intro_applied = false
local aniskip_outro_applied = false
local pending_aniskip = false

-- 跳过按钮状态：进入片头/片尾区间显示，由用户点击才跳过
local skip_btn = {
    active = false,
    hover = false,
    kind = nil,    -- "跳过片头" / "跳过片尾"
    target = 0,    -- 标记区间终点（日志用）
    seg_len = 0,   -- [lc-1265] 打点得出的区间时长（秒）；点击跳过=从当前位置相对跳过这么久
    rect = { x = 0, y = 0, w = 0, h = 0 },
}

-- time-pos 观察器只注册一次（file-loaded 每集都会触发，重复注册会叠加多个观察器）
local timepos_observed = false
-- 点击跳过后落点恰在区间右端点上，留一小段缓冲避免按钮在落点上闪现
local BUTTON_EPSILON = 0.3

-- [lc-1265] 跨文件共享状态（本文件与 menu.lua 同属一个 Lua state，经 _G 传递）：
--   gen                    每换集/每次手动改标记 +1，使在途的异步结果作废（防串集/防旧响应覆盖新打点）
--   source                 'local'=精确 4 值人工标记 | 'server'=飞牛 2 值/兜底换算 | nil
--   have_intro/have_outro  该区间是否已被人工标记覆盖（已覆盖则自动来源不再写 opts）
--   intro_done/outro_done  本集该段落是否已点击跳过（每集重置）
local skip_shared = _G.fntv_skip_state
if not skip_shared then
    skip_shared = { gen = 0, source = nil, have_intro = false, have_outro = false,
                    intro_done = false, outro_done = false }
    _G.fntv_skip_state = skip_shared
end
local skip_state = skip_shared

-- [lc-1265] 异步回调有效性：换集或用户重新打点后，在途的旧结果必须丢弃
local function gen_alive(gen)
    if gen ~= nil and gen ~= skip_shared.gen then
        msg.verbose("跳过数据响应已过期（换集或重新标记），丢弃")
        return false
    end
    return true
end

-- [lc-1265] 该区间是否已有精确人工标记（=最高优先级，自动/兜底来源不得覆盖）
local function has_local_marks(section)
    if section == 'intro' then return skip_shared.have_intro end
    if section == 'outro' then return skip_shared.have_outro end
    return skip_shared.have_intro or skip_shared.have_outro
end

-- MBTN_LEFT 强制绑定当前是否已注册
local click_bound = false
local CLICK_BIND = "fntv_smart_skip_click"

-- theintrodb 兜底：根据当前播放 guid 查 tmdb 元数据获取片头/片尾
local function try_theintrodb_fallback()
    local play_url = mp.get_property("path")
    local id = mutils.extract_id_and_query(play_url)
    if not id then
        msg.error("theintrodb: 无法从播放地址解析 guid")
        return
    end
    local meta = skip_meta_map[id]
    if not meta or not meta.tmdb then
        -- 元数据可能晚于 fnOS 返回到达，标记待补触发
        pending_fallback = true
        msg.info("theintrodb: 当前条目暂无可兜底数据（等待元数据）")
        return
    end
    pending_fallback = false
    local dur_ms = (mutils.dur() or 0) * 1000
    api.get_theintrodb(meta.tmdb, meta.season, meta.episode, dur_ms, function(resp, err)
        if err or not resp then
            msg.error("theintrodb 请求失败: " .. tostring(err))
            return
        end
        local total_dur = mutils.dur()
        if not total_dur or total_dur <= 0 then return end

        local intro = resp.intro and resp.intro[1]
        local credits = resp.credits and resp.credits[1]
        -- [lc-1265] 人工标记区间优先：已有精确标记时不覆盖
        if intro and not aniskip_intro_applied and not has_local_marks('intro') then
            local s = (intro.start_ms and intro.start_ms / 1000) or 0
            local e = (intro.end_ms and intro.end_ms / 1000) or 0
            if e > s then
                opts.manual_intro_start = s
                opts.manual_intro_end = e
                msg.info(string.format("theintrodb 片头: %.0f - %.0f 秒", s, e))
            end
        end
        if credits and not aniskip_outro_applied and not has_local_marks('outro') then
            local s = (credits.start_ms and credits.start_ms / 1000) or 0
            local e = (credits.end_ms and credits.end_ms / 1000) or total_dur
            if e > s then
                opts.manual_outro_start = s
                opts.manual_outro_end = e
                msg.info(string.format("theintrodb 片尾: %.0f - %.0f 秒", s, e))
            end
        end
    end)
end

-- [lc-1059] AniSkip 兜底：按 MAL id 查精确 OP/ED 区间(绝对秒)，优先于 theintrodb
--   (社区投票校准 + 动漫专项库)；MAL 由 Electron 标题映射链异步解析后随 skip-metadata 补发。
local function try_aniskip_fallback()
    local play_url = mp.get_property("path")
    local id = mutils.extract_id_and_query(play_url)
    if not id then return end
    local meta = skip_meta_map[id]
    if not meta or not meta.episode then return end
    if not meta.mal then
        -- MAL 映射由 Electron 侧异步解析，晚到后经 skip-metadata 补触发
        if meta.tmdb then pending_aniskip = true end
        return
    end
    if aniskip_intro_applied and aniskip_outro_applied then return end
    local dur_s = mutils.dur() or 0
    api.get_aniskip(meta.mal, meta.episode, dur_s, function(resp, err)
        if err or not resp then return end
        local op, ed
        for _, r in ipairs(resp.results or {}) do
            if r.skipType == "op" and not op then op = r end
            if r.skipType == "ed" and not ed then ed = r end
        end
        if op and op.interval and not aniskip_intro_applied then
            local s = op.interval.startTime or 0
            local e = op.interval.endTime or 0
            if e > s and e > 0 then
                opts.manual_intro_start = s
                opts.manual_intro_end = e
                aniskip_intro_applied = true
                msg.info(string.format("AniSkip 片头: %.1f - %.1f 秒", s, e))
            end
        end
        if ed and ed.interval and not aniskip_outro_applied then
            local s = ed.interval.startTime or 0
            local e = ed.interval.endTime or 0
            if e > s and e > 0 then
                opts.manual_outro_start = s
                opts.manual_outro_end = e
                aniskip_outro_applied = true
                msg.info(string.format("AniSkip 片尾: %.1f - %.1f 秒", s, e))
            end
        end
    end)
end

-- 接收 Electron 注入的 skip 元数据（guid -> tmdb/season/episode）
mp.register_script_message('skip-metadata', function(payload)
    if not payload or payload == "" then return end
    local meta = utils.parse_json(payload)
    if not meta or type(meta) ~= "table" then
        msg.error("skip-metadata 解析失败: " .. tostring(payload))
        return
    end
    skip_meta_map = meta
    local n = 0
    for _ in pairs(meta) do n = n + 1 end
    msg.info("收到 skip 元数据, 条目数: " .. n)
    -- 若此前 fnOS 已返回空而元数据晚到，补触发兜底
    if pending_fallback then
        pending_fallback = false
        try_theintrodb_fallback()
    end
end)

-- [lc-1227] 跳过按钮距底部的基线（像素，按 osd 高度缩放）。
-- 原值 80 是硬编码：在那个尺寸下按钮底边正好压进 uosc 底部控制栏（实测 720p 控制栏高 81px），
-- 表现为「跳过片头」被进度条/按钮行遮住。现在改为读取 uosc 实际公布的控制栏高度后再上抬。
local SKIP_BTN_BASE_LIFT = 80
-- [lc-1229] 水平内缩（像素，按高度缩放）：按钮左边缘距屏幕左侧的距离。
-- 与右侧留白用同一个基准，换边后视觉位置对称。
local SKIP_BTN_MARGIN_X = 40

-- uosc 在每次渲染后把「未被占用的边缘」发布到 user-data/osc/margins（比例值 0~1，b=底部）。
-- 这是唯一能跟着用户 uosc 配置/DPI 缩放/窗口尺寸自动变化的高度来源，比猜一个常量可靠。
-- ⚠️ 该属性在 uosc 完成首次渲染前为 nil（脚本加载早于首帧），必须回退到经验值。
local function controls_bottom_px(h)
    local margins = mp.get_property_native("user-data/osc/margins")
    if type(margins) == "table" then
        local b = tonumber(margins.b)
        if b and b > 0 and b < 1 then
            return math.floor(b * h)
        end
    end
    return 0
end

-- 绘制跳过按钮（[lc-1229] 左下角）
-- 用纯文字大描边实现按钮底色：set_osd_ass 单 Dialogue 事件内矢量矩形(\p1)会使后续
-- 文字定位失效（实测 \pos 被忽略、错位），描边文字方案经截图验证清晰可靠。
-- hover 用描边变色（深灰→蓝）代替底色变化。
local function draw_skip_button()
    -- osd-width/height 可能在 file-loaded 早期返回 0（非 nil），直接用会导致按钮画到
    -- 屏幕外（实测 pos(-40,-80)）；为 0/nil 时回退 1280x720，并监听尺寸变化重绘。
    local w = mp.get_property_number("osd-width") or 0
    local h = mp.get_property_number("osd-height") or 0
    if w <= 0 or h <= 0 then
        w, h = 1280, 720
    end
    if not skip_btn.active then
        mp.set_osd_ass(w, h, "")
        return
    end
    local fs = 28
    -- 预估文字尺寸以计算命中区（中文 4 字 + border8：宽约 fs*4，高约 fs+bord*2）
    local bw = fs * 4 + 40
    local bh = fs + 30
    -- [lc-1227] 垂直定位：\pos 的 y 锚在文字【上边】，所以要让「文字底边」落在
    -- 控制栏上沿之上，须满足 pos_y + bh <= h - bar - gap，即 lift >= bar + gap + bh。
    -- （原实现直接用 lift=80：文字底边落在 h-22，而 720p 控制栏从 h-81 起 —— 必然被遮挡。）
    local scale = h / 720
    local gap = math.floor(24 * scale)                      -- 控制栏与按钮之间的留白
    local bar = controls_bottom_px(h)
    if bar <= 0 then bar = math.floor(SKIP_BTN_BASE_LIFT * scale) end  -- uosc 首帧前回退
    local lift = bar + gap + bh
    -- 上限保护：极端矮窗口下别把按钮顶进标题区域
    lift = math.min(lift, math.floor(h * 0.5))
    -- [lc-1229] 左对齐：\an7 锚在文字【左上】，x 即按钮左边缘，故直接用左边距。
    -- 注意 \an7 与 \an9 的 x 语义不同（前者=左边缘，后者=右边缘），换边时必须同时改 \an。
    local margin_x = math.floor(SKIP_BTN_MARGIN_X * scale)
    -- 命中区与文字同位：rect 左上角 = 文字左上角，二者不再错位
    skip_btn.rect = { x = margin_x, y = h - lift, w = bw, h = bh }
    local border_hex = skip_btn.hover and "4C8DFF" or "2A2F3A"
    local ass = string.format(
        "{\\an7\\pos(%d,%d)\\c&HFFFFFF&\\b1\\fs%d\\bord8\\3c&H%s&\\shad1\\4c&H000000&}%s",
        margin_x, h - lift, fs, border_hex, skip_btn.kind)
    mp.set_osd_ass(w, h, ass)
end

-- 鼠标悬停高亮 + 动态接管左键点击
-- 捆绑的 mpv v0.41 已移除 mouse-btn-down 事件；uosc 接管全局 MBTN_LEFT。
-- 探测结论：add_forced_key_binding 的绑定优先级(priority≈23)高于 input.conf(17)
-- 与 uosc(-1)，因此仅在鼠标悬停按钮时注册强制 MBTN_LEFT 绑定，点击按钮本身，
-- 离开/隐藏按钮时立即注销，其余区域点击不受影响（仍走 uosc/暂停切换）。
local function hide_click_binding()
    if click_bound then
        click_bound = false
        mp.remove_key_binding(CLICK_BIND)
    end
end

-- [lc-1265] 点击跳过 = 按打点得出的区间时长做「相对跳过」（动态跳过片头片尾）：
--   打点后算出片头/片尾各是多长（e - s），点击时从当前位置直接跳过对应的秒数，
--   不再 seek 到某个固定时间点——固定端点经飞牛 2 值换算（片尾终点恒为文件尾）
--   或整季标记跨集复用后会漂移，时长是稳定的。
local function do_skip_jump()
    local seg_len = tonumber(skip_btn.seg_len) or 0
    if seg_len <= 0 then
        msg.warn("跳过按钮缺少时长信息，忽略本次点击")
        return
    end
    local pos = mutils.timepos() or 0
    local dur = mutils.dur() or 0
    local target = pos + seg_len
    if dur > 0 and target > dur then target = dur end   -- 不越过文件末尾
    mp.commandv('seek', tostring(target), 'absolute+exact')
    mutils.show_message(string.format("⏭️ 已%s（跳过 %d 秒）", skip_btn.kind, math.floor(seg_len + 0.5)), 2)
    msg.info(string.format("用户点击跳过按钮: %s 相对跳过 %.1f 秒（%.1f → %.1f）",
        skip_btn.kind, seg_len, pos, target))
    -- 本集该段落已跳过：此后即使重新进入区间（如回看）也不再显示按钮
    if skip_btn.kind == "跳过片头" then
        skip_state.intro_done = true
    elseif skip_btn.kind == "跳过片尾" then
        skip_state.outro_done = true
    end
    skip_btn.active = false
    skip_btn.kind = nil
    skip_btn.seg_len = 0
    skip_btn.hover = false
    hide_click_binding()
    draw_skip_button()
end

local function show_click_binding()
    if click_bound then return end
    click_bound = true
    mp.add_forced_key_binding("MBTN_LEFT", CLICK_BIND, function()
        if skip_btn.active and skip_btn.hover then
            do_skip_jump()
        else
            -- 悬停态过期（按钮已隐藏但绑定尚未注销）：交还控制权
            hide_click_binding()
            mp.commandv("keypress", "MBTN_LEFT")
        end
    end)
end

-- 根据当前播放位置更新按钮显示/隐藏
-- [用户点击跳过] 检测到片头/片尾数据后，按显示窗口/标记区间显示按钮，由用户决定是否跳过；
-- 已点击跳过的段落不再重复显示按钮。
-- [lc-1265] ① 显示窗口 = [区间起点 - 提前量, 区间终点 - ε]（提前量应用于片头/片尾两处）；
--   ② 点击跳过不再跳「固定时间点」而是按打点得出的区间时长相对跳过（见 do_skip_jump），
--   因此按钮激活时把时长（e - s）记到 skip_btn.seg_len，供点击时使用；
--   ③ 落点/时长每次刷新（而非仅 kind 变化时）——改完标记后按钮必须立即跟随，否则带旧值去跳。
-- [lc-1266] 显示判定改为「时间窗口 ∪ 标记区间」：
--   片头：播放开始后 N 秒内（窗口）∪ 标记区间起点前提前量 ~ 区间终点；
--   片尾：距视频结束剩 N 秒内（窗口）∪ 同上；
--   两个窗口与标记无关，即使标记没命中（如整季标记落到别集/时长不同的集）按钮也会按时出现；
--   但都必须有可用区间（有时长才跳得了）。
local function update_skip_button(curr_pos, result)
    local show, label, target, seg_len = false, "", 0, 0
    local dur = mutils.dur() or 0
    if result and result.intro and not skip_state.intro_done then
        local s, e = result.intro[1], result.intro[2]
        local in_time_window = curr_pos <= mutils.window_for(opts, 'intro')
        local in_marks = curr_pos >= s - mutils.lead_for(opts) and curr_pos <= e - BUTTON_EPSILON
        if (in_time_window or in_marks) and e > s then
            show, label, target, seg_len = true, "跳过片头", e, e - s
        end
    end
    if not show and result and result.outro and not skip_state.outro_done then
        local s, e = result.outro[1], result.outro[2]
        local remain = (dur > 0) and (dur - curr_pos) or math.huge
        local in_time_window = remain <= mutils.window_for(opts, 'outro')
        local in_marks = curr_pos >= s - mutils.lead_for(opts) and curr_pos <= e - BUTTON_EPSILON
        if (in_time_window or in_marks) and e > s then
            show, label, target, seg_len = true, "跳过片尾", e, e - s
        end
    end
    if show then
        if not skip_btn.active or skip_btn.kind ~= label
            or skip_btn.target ~= target or skip_btn.seg_len ~= seg_len then
            skip_btn.active = true
            skip_btn.kind = label
            skip_btn.target = target
            skip_btn.seg_len = seg_len
            draw_skip_button()
        end
    elseif skip_btn.active then
        skip_btn.active = false
        skip_btn.kind = nil
        skip_btn.seg_len = 0
        skip_btn.hover = false
        hide_click_binding()
        draw_skip_button()
    end
end

mp.observe_property("mouse-pos", "native", function(_, pos)
    if not skip_btn.active or not pos then return end
    local r = skip_btn.rect
    local inside = pos.x >= r.x and pos.x <= r.x + r.w and pos.y >= r.y and pos.y <= r.y + r.h
    if inside ~= skip_btn.hover then
        skip_btn.hover = inside
        if inside then
            show_click_binding()
        else
            hide_click_binding()
        end
        draw_skip_button()
    end
end)

-- OSD 分辨率变化（窗口缩放/全屏切换）时重绘按钮，避免位置停留在旧坐标系
mp.observe_property("osd-width", "number", function()
    if skip_btn.active then draw_skip_button() end
end)
mp.observe_property("osd-height", "number", function()
    if skip_btn.active then draw_skip_button() end
end)

-- [lc-1227] uosc 首次渲染后才发布 margins（此前为 nil，draw 走的是回退值）。
-- 不监听的话，首帧前画的按钮会一直停在回退位置上（仍是遮挡状态的近似值），
-- 必须等 margins 到位后重绘一次，才能落到「控制栏上方」的正确位置。
mp.observe_property("user-data/osc/margins", "native", function()
    if skip_btn.active then draw_skip_button() end
end)

--  通过章节检测片头片尾
local function detect_by_chapters()
    local chapters = mutils.get_chapter_list()
    local D = mutils.dur()
    if not chapters or not D or D <= 0 then return nil end

    local scan_win = math.min(opts.max_scan_window, (opts.max_scan_percent / 100) * D) -- 前 10 分钟/25% 取小
    -- 寻找片头候选区间（在视频开头部分）
    local intro_candidates = mutils.find_sections_in_window(chapters, 0, scan_win,
        opts.min_skip_duration, opts.max_skip_duration)

    -- 寻找片尾候选区间（在视频结尾部分）
    local outro_candidates = mutils.find_sections_in_window(chapters, D - scan_win, D,
        opts.min_skip_duration, opts.max_skip_duration)

    -- 如果都没找到符合条件的区间
    if #intro_candidates == 0 and #outro_candidates == 0 then
        return nil
    end

    -- 处理片头：如果有多个候选，优先选择第二个（可能第一个是开场剧情）
    local selected_intro = intro_candidates[2] or intro_candidates[1]

    -- 处理片尾：如果有多个候选，优先选择倒数第二个（可能最后一个是结尾剧情
    local len = #outro_candidates
    local selected_outro = outro_candidates[len - 1] or outro_candidates[len]

    -- 返回检测到的片头片尾信息
    return {
        intro = selected_intro and { selected_intro.start_time, selected_intro.end_time } or nil,
        outro = selected_outro and { selected_outro.start_time, selected_outro.end_time } or nil
    }
end

-- 通过手动指定片头片尾
local function detect_by_manual()
    local intro = (opts.manual_intro_start >= 0 and opts.manual_intro_end > opts.manual_intro_start) and
        { opts.manual_intro_start, opts.manual_intro_end } or nil
    local outro = (opts.manual_outro_start >= 0 and opts.manual_outro_end > opts.manual_outro_start) and
        { opts.manual_outro_start, opts.manual_outro_end } or nil
    if not intro and not outro then return nil end
    return { intro = intro, outro = outro }
end

local function detect_by_mode()
    if opts.detect_mode == DETECT_MODE.CHAPTER then
        return detect_by_chapters()
    elseif opts.detect_mode == DETECT_MODE.MANUAL then
        return detect_by_manual()
    elseif opts.detect_mode == DETECT_MODE.AUTO then
        -- [lc-1265] 人工精确标记优先（用户既定优先级：人工 > 获取）：
        --   已打点的区间固定用人工值，章节检测只补未打点的区间——
        --   否则有章节的文件里，章节推出来的片尾（往往顶到文件尾）会顶掉用户标的区间。
        local result = detect_by_chapters()
        local manual = detect_by_manual()
        if has_local_marks('intro') and manual and manual.intro then
            result = result or {}
            result.intro = manual.intro
        end
        if has_local_marks('outro') and manual and manual.outro then
            result = result or {}
            result.outro = manual.outro
        end
        if result then return result end
        return manual
    else
        msg.error("未知的检测模式")
        return nil
    end
end

-- [lc-1265] 读取 Electron 本地精确 4 值标记（人工打点，优先级最高）：
--   飞牛服务端只有 2 值（skipStart/skipEnd=从结尾倒数秒数），还原出的片尾终点恒等于「文件末尾」，
--   用户把片尾终点标在 ED 结束处（其后还有正片）时会丢失 → 点击跳过直接跳到文件尾触发 EOF 切下一集。
--   本地存储（skip-manual.json）保留了精确区间，此处优先采用；命中后 have_* 置位，
--   服务端 2 值/兜底链不得再覆盖对应区间。
local function load_local_marks(gen)
    local play_url = mp.get_property("path")
    local id = mutils.extract_id_and_query(play_url)
    if not id then return end
    api.get_manual_local(id, function(resp, err)
        if not gen_alive(gen) then return end
        if err or not resp or resp.empty then
            msg.verbose("本地无精确标记，回落服务端/兜底数据")
            return
        end
        local hit = false
        if (tonumber(resp.introEnd) or 0) > (tonumber(resp.introStart) or 0) then
            opts.manual_intro_start = tonumber(resp.introStart) or 0
            opts.manual_intro_end = tonumber(resp.introEnd)
            skip_shared.have_intro = true
            hit = true
        end
        if (tonumber(resp.outroEnd) or 0) > (tonumber(resp.outroStart) or 0) then
            opts.manual_outro_start = tonumber(resp.outroStart)
            opts.manual_outro_end = tonumber(resp.outroEnd)
            skip_shared.have_outro = true
            hit = true
        end
        if hit then
            skip_shared.source = 'local'
            msg.info(string.format("本地精确标记(%s): 片头 %.0f - %.0f 秒, 片尾 %.0f - %.0f 秒",
                tostring(resp.scope or 'episode'),
                opts.manual_intro_start, opts.manual_intro_end,
                opts.manual_outro_start, opts.manual_outro_end))
        end
    end)
end

-- 读取服务器配置
local function load_server_config(gen)
    local play_url = mp.get_property("path")
    api.get_skip_time(play_url, function(resp, err)
        if not gen_alive(gen) then return end
        if err or not resp or resp.code ~= 0 then
            msg.error("获取服务器跳过时间点失败: " .. tostring(err))
            fnos_empty = true
            try_theintrodb_fallback()
            try_aniskip_fallback()
            return
        end
        local data = resp.data
        if data and data.skipStart and data.skipEnd then
            local total_dur = mutils.dur()
            if not total_dur or total_dur <= 0 then return end

            -- [lc-1265] 已有本地精确标记的区间不再被服务端 2 值换算覆盖
            if not has_local_marks('intro') then
                opts.manual_intro_start = 0
                opts.manual_intro_end = data.skipStart
            end

            local outro_start = total_dur - data.skipEnd
            -- 合理性检查：片尾开始时间不应早于视频的一半
            if outro_start < total_dur / 2 then
                msg.warn("服务器返回的片尾时间异常，已忽略。片尾时长: "..data.skipEnd)
                if not has_local_marks('outro') then
                    opts.manual_outro_start = 0
                    opts.manual_outro_end = 0
                end
            elseif not has_local_marks('outro') then
                opts.manual_outro_start = outro_start
                opts.manual_outro_end = total_dur
            end

            msg.info(string.format("服务器跳过时间点: 片头 %d - %d 秒, 片尾 %d - %d 秒",
                opts.manual_intro_start, opts.manual_intro_end,
                opts.manual_outro_start, opts.manual_outro_end))
        else
            msg.info("fnOS 无跳过数据，尝试 theintrodb 兜底")
            fnos_empty = true
            try_theintrodb_fallback()
            try_aniskip_fallback()
        end
    end)
end

-- 手动快捷跳过
local function manual_skip_forward()
    local duration = tonumber(opts.manual_skip_duration) or 0
    if duration <= 0 then
        msg.warn('manual_skip_duration 未设置或小于等于 0，跳过快捷键已忽略')
        return
    end

    mp.commandv('seek', tostring(duration), 'relative', 'exact')
    mutils.show_message(string.format('⏩ 快速跳过 %d 秒', duration), 2)
end

-- 智能跳过片头片尾：获取到跳过数据后，播放进入片头/片尾区间显示按钮，
-- 由用户点击才执行跳过（不自动 seek：很多剧先正剧后片头曲，自动跳过会误切正剧）
local function smart_skip()
    -- [lc-1265] 换集：gen+1 作废上一集在途的异步响应；重置本集的人工标记覆盖位与点击态
    skip_shared.gen = skip_shared.gen + 1
    local gen = skip_shared.gen
    skip_shared.source = nil
    skip_shared.have_intro = false
    skip_shared.have_outro = false
    skip_state.intro_done = false
    skip_state.outro_done = false
    -- 立即清空上一集的区间值：等待新数据期间不得用旧区间显示按钮（防跨集误跳）
    opts.manual_intro_start = 0
    opts.manual_intro_end = 0
    opts.manual_outro_start = 0
    opts.manual_outro_end = 0
    skip_btn.active = false
    skip_btn.kind = nil
    skip_btn.target = 0
    skip_btn.seg_len = 0
    skip_btn.hover = false
    hide_click_binding()
    draw_skip_button()

    -- 优先级：本地精确 4 值（人工打点）> 飞牛服务端 2 值 > AniSkip/theintrodb 兜底。
    -- 两者并行发出，先到先写；本地命中后服务端/兜底不再覆盖对应区间（has_local_marks 守门）。
    load_local_marks(gen)
    load_server_config(gen)

    -- [lc-1265] 供 menu.lua 打点后立即刷新按钮（暂停时 time-pos 不变化，观察器不会触发）。
    -- 必须注册在 timepos_observed 提前返回之前：否则第 2 集起不会再注册，
    -- 打点后按钮不刷新（会带着旧落点去跳）。读的是当前 opts，无跨集风险。
    skip_shared.refresh = function()
        update_skip_button(mutils.timepos() or 0, detect_by_mode())
    end

    if timepos_observed then return end
    timepos_observed = true

    -- 监听播放位置以显示/隐藏按钮
    mp.observe_property("time-pos", "number", function(_, curr_pos)
        if not curr_pos then
            return
        end

        -- 总开关关闭：不显示跳过按钮
        if not opts.enabled then
            if skip_btn.active then
                skip_btn.active = false
                skip_btn.kind = nil
                skip_btn.hover = false
                hide_click_binding()
                draw_skip_button()
            end
            return
        end

        local result = detect_by_mode()
        update_skip_button(curr_pos, result)
    end)
end

mp.add_key_binding(nil, 'manual-skip', manual_skip_forward)
mp.register_script_message('manual-skip', manual_skip_forward)

-- 初始化函数
local function init()
    -- 读取配置文件
    opt.read_options(opts, mp.get_script_name())
    -- 注册事件处理器
    mp.register_event("file-loaded", smart_skip)
end

-- 启动初始化
init()

