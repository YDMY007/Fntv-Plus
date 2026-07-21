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
        local result = detect_by_chapters()
        if result then return result end
        result = detect_by_manual()
        if result then return result end
        return nil
    else
        msg.error("未知的检测模式")
        return nil
    end
end

-- 读取服务器配置
local function load_server_config()
    local play_url = mp.get_property("path")
    api.get_skip_time(play_url, function(resp, err)
        if err or not resp or resp.code ~= 0 then
            msg.error("获取服务器跳过时间点失败: " .. err)
            return
        end
        local data = resp.data
        if data and data.skipStart and data.skipEnd then
            local total_dur = mutils.dur()
            if not total_dur or total_dur <= 0 then return end

            opts.manual_intro_start = 0
            opts.manual_intro_end = data.skipStart

            local outro_start = total_dur - data.skipEnd
            -- 合理性检查：片尾开始时间不应早于视频的一半
            if outro_start < total_dur / 2 then
                msg.warn("服务器返回的片尾时间异常，已忽略。片尾时长: "..data.skipEnd)
                opts.manual_outro_start = 0
                opts.manual_outro_end = 0
            else
                opts.manual_outro_start = outro_start
                opts.manual_outro_end = total_dur
            end
            
            msg.info(string.format("服务器跳过时间点: 片头 %d - %d 秒, 片尾 %d - %d 秒",
                opts.manual_intro_start, opts.manual_intro_end,
                opts.manual_outro_start, opts.manual_outro_end))
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

-- 智能跳过片头片尾
local function smart_skip()
    load_server_config()

    local has_skip_intro = false
    local has_skip_outro = false

    -- 监听播放位置以执行跳过
    mp.observe_property("time-pos", "number", function(_, curr_pos)
        if not curr_pos then
            return
        end

        if not opts.enabled then
            return
        end

        local result = detect_by_mode()

        if not has_skip_intro and result and result.intro then
            has_skip_intro = mutils.skip_if_in(curr_pos, result.intro[1], result.intro[2], "⏭️ 正在跳过片头...")
            if has_skip_intro then
                msg.info("检测到片头, mode=" .. opts.detect_mode .. " args:" .. utils.to_string(result.intro))
            end
        end

        if not has_skip_outro and result and result.outro then
            has_skip_outro = mutils.skip_if_in(curr_pos, result.outro[1], result.outro[2], "⏭️ 正在跳过片尾...")
            if has_skip_outro then
                msg.info("检测到片尾, mode=" .. opts.detect_mode .. " args:" .. utils.to_string(result.outro))
            end
        end
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
