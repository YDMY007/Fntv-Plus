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

-- ask_yn.lua  —— 返回一个函数：ask_yn(message, opts, callback)
-- 用法：
--   local ask_yn = require('ask_yn')
--   ask_yn("是否跳过片头到 1:30？", { timeout = 5, default = true }, function(yes)
--     if yes then mp.set_property_native("time-pos", 90) end
--   end)
-- ask.lua  —— 左上角 y/n 弹问（ASS OSD），按下 y/n 后执行回调
-- 用法示例见文末。

local mp    = require "mp"
local msg   = require "mp.msg"

local ask   = {}

local state = {
    active  = false,
    timer   = nil,
    ov      = nil,
    remain  = 0,
    default = nil,
    prefix  = "ask_toggle_", -- 键绑定前缀，避免冲突
}

local function clear()
    if state.timer then
        state.timer:kill(); state.timer = nil
    end
    if state.ov then state.ov:remove() end
    mp.remove_key_binding(state.prefix .. "y")
    mp.remove_key_binding(state.prefix .. "Y")
    mp.remove_key_binding(state.prefix .. "n")
    mp.remove_key_binding(state.prefix .. "N")
    mp.remove_key_binding(state.prefix .. "esc")
    state.active = false
end

local function hint_text(timeout, default, remain)
    local def = (default == true and "跳过")
        or (default == false and "不跳")
        or "取消"
    if (timeout or 0) > 0 then
        local t = math.max(0, math.floor(remain or timeout))
        return string.format("(y/n · %ds 后默认：%s)", t, def)
    end
    return "(y/n)"
end

local function draw(message, hint)
    if not state.ov then state.ov = mp.create_osd_overlay("ass-events") end
    local w, h = mp.get_osd_size()
    state.ov.res_x, state.ov.res_y = w or 1920, h or 1080
    -- 左上角 {\an7}，加描边提可读性
    state.ov.data = string.format("{\\an1\\bord2\\shad0\\fs28}%s {\\fs22}%s",
        message, hint or "(y/n)")
    state.ov:update()
end

-- 低层：显示 message，等待 y/n，回调 callback(true|false|nil)
-- opts = { timeout = 0, default = true/false/nil }
function ask.prompt(message, opts, callback)
    if state.active then clear() end
    state.active = true
    opts = opts or {}
    local timeout = tonumber(opts.timeout or 0) or 0
    state.default = opts.default

    local function decide(val)
        if not state.active then return end
        clear()
        if callback then
            local ok, err = pcall(callback, val)
            if not ok then msg.error("ask.prompt callback error: " .. tostring(err)) end
        end
    end

    draw(message, hint_text(timeout, state.default, timeout))

    mp.add_forced_key_binding("y", state.prefix .. "y", function() decide(true) end)
    mp.add_forced_key_binding("Y", state.prefix .. "Y", function() decide(true) end)
    mp.add_forced_key_binding("n", state.prefix .. "n", function() decide(false) end)
    mp.add_forced_key_binding("N", state.prefix .. "N", function() decide(false) end)
    mp.add_forced_key_binding("ESC", state.prefix .. "esc", function() decide(state.default) end)

    if timeout > 0 then
        state.remain = math.floor(timeout)
        state.timer = mp.add_periodic_timer(1, function()
            state.remain = state.remain - 1
            if state.remain <= 0 then
                decide(state.default)
            else
                draw(message, hint_text(timeout, state.default, state.remain))
            end
        end)
    end
end

-- 语义化封装：做“切换/确认”型询问；on_yes / on_no 为可选回调
-- 例：ask.toggle("是否跳过片头到 1:30？", {timeout=5, default=true},
--                function() mp.set_property_native("time-pos", 90) end)
function ask.toggle(title, opts, callback)
    ask.prompt(title or "是否执行？", opts, callback)
end

-- 手动关闭（比如切歌/切片时）
function ask.close()
    if state.active then clear() end
end

-- 查询当前是否在询问中
function ask.is_active()
    return state.active
end

return ask
