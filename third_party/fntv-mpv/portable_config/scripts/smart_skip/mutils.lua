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

local mp        = require('mp')
local utils     = require('mp.utils')
local msg       = require('mp.msg')

local mutils    = {}

mutils.SCRIPT   = mp.get_script_name()
-- 用 mpv 提供的方式拿配置文件路径
local conf_dir  = mp.command_native({ "expand-path", "~~/script-opts" })
local conf_path = conf_dir .. "/" .. mutils.SCRIPT .. ".conf"

function mutils.to_json(tbl)
    -- utils.format_json 成功时返回 1 个值；失败时返回 (nil, "error")
    local s, err = utils.format_json(tbl)
    if not s then return nil, err end
    return s
end

function mutils.dur() return mp.get_property_number('duration', 0) or 0 end

function mutils.timepos() return mp.get_property_number('time-pos', 0) or 0 end

-- 在OSD上显示消息
function mutils.show_message(text, duration)
    duration = duration or 3 -- 默认显示3秒
    -- 设置OSD样式和对齐方式
    local ass = mp.get_property_osd("osd-ass-cc/0")
    -- {\\an1} 表示左下角对齐，{\\an2} 表示底部居中对齐
    local styled_text = ass .. "{\\an1}" .. text
    mp.osd_message(styled_text, duration)
end

-- 获取章节列表
function mutils.get_chapter_list()
    local chapters = mp.get_property_native('chapter-list')
    if not chapters then return nil end
    return chapters
end

-- 跳过一次：如果当前位置在 [a,b] 内，立即 seek 到 b
function mutils.skip_if_in(curr_pos, a, b, why)
    if curr_pos >= a and curr_pos <= b then
        mutils.show_message(why, 2)
        mp.set_property_number('time-pos', b)
        return true
    end
    return false
end

-- 判断当前位置是否在区间 [a,b] 内
function mutils.if_in(curr_pos, a, b)
    return curr_pos >= a and curr_pos <= b
end

-- 在指定时间窗口内寻找符合时长条件的连续章节区间
function mutils.find_sections_in_window(chapters, start_time, end_time, min_dur, max_dur)
    local candidates = {}

    for i = 1, #chapters do
        local chapter = chapters[i]
        -- 确保章节在指定时间窗口内
        if chapter.time >= start_time and chapter.time <= end_time then
            local next_chapter = chapters[i + 1]
            if next_chapter then
                local duration = next_chapter.time - chapter.time
                if duration >= min_dur and duration <= max_dur then
                    table.insert(candidates, {
                        start_time = chapter.time,
                        end_time = next_chapter.time,
                        duration = duration
                    })
                end
            end
        end
    end

    return candidates
end

function mutils.af_add_noise(label, threshold, duration)
    mp.commandv("af", "add",
        ("@%s:lavfi=[silencedetect=noise=%sdB:d=%.3f]"):format(label, threshold, duration))
end

function mutils.af_rm(label) mp.commandv("af", "remove", ("@%s"):format(label)) end

function mutils.af_meta(label) return ("af-metadata/%s"):format(label) end

-- 新增：视频黑帧检测
function mutils.vf_add_blackdetect(label, d, pic_th, pix_th)
    -- d: 最小黑帧持续时间（秒），比如 0.1
    -- pic_th: 黑画面比例阈值（0~1），比如 0.98
    -- pix_th: 像素黑阈值（0~1），比如 0.10 (对应 ~25/255)
    local chain = ("@%s:lavfi=[blackdetect=d=%.3f:pic_th=%.3f:pix_th=%.3f]"):
        format(label, d or 0.10, pic_th or 0.98, pix_th or 0.10)
    mp.commandv("vf", "add", chain)
end

function mutils.vf_meta(label)
    return ("vf-metadata/%s"):format(label)
end

-- 提取 path 中的 id 以及原始 query string
function mutils.extract_id_and_query(url)
    -- 提取 id （playvideo/后到 ? 前）
    local id = url:match("/playvideo/([^%?]+)")
    -- 提取 query string （? 后的部分）
    local query = url:match("%?(.*)")

    return id, query
end

-- 持久化配置
function mutils.save_options()
    local dir = utils.split_path(conf_path)
    utils.subprocess({ args = { "mkdir", "-p", dir } })

    local f, err = io.open(conf_path, "w+")
    if not f then
        msg.error("无法写入配置: " .. tostring(err))
        return
    end

    -- 黑名单：这些key不应写入配置文件
    local blacklist = {
        ["manual_intro_start"] = true,
        ["manual_intro_end"] = true,
        ["manual_outro_start"] = true,
        ["manual_outro_end"] = true,
    }

    for k, v in pairs(opts) do
        if not blacklist[k] then
            local val
            if type(v) == "boolean" then
                val = v and "yes" or "no"
            else
                val = tostring(v)
            end
            f:write(string.format("%s=%s\n", k, val))
        end
    end

    f:close()
    msg.info("配置已保存到 " .. conf_path)
end

-- 解析为数字
function mutils.parse_number(v)
    if type(v) ~= 'string' then return nil end
    local trimmed = v:match('^%s*(.-)%s*$')
    if trimmed == '' then return nil end
    return tonumber(trimmed)
end

-- 解析整数
function mutils.parse_integer(v)
    local n = mutils.parse_number(v)
    if not n or n ~= math.floor(n) then return nil end
    return n
end

return mutils
