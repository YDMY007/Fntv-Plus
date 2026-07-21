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

local msg         = require('mp.msg')
local utils       = require('mp.utils')
local api         = require('./api')
local mutils      = require('./mutils')

-- 你的配置模块（需导出 opts / DETECT_MODE）
local options_mod = require('./options')
local opts        = options_mod.opts
local DETECT_MODE = options_mod.DETECT_MODE
local SCRIPT      = mp.get_script_name()

-- ========= 工具 =========
local function mode_name(m)
    if m == DETECT_MODE.CHAPTER then return '章节模式' end
    if m == DETECT_MODE.MANUAL then return '手动模式' end
    if m == DETECT_MODE.AUTO then return '自动模式' end
    if m == DETECT_MODE.SILENCE then return '静音检查模式' end
    return tostring(m)
end

local function bool_sign(b) return b and '✔' or 'X' end

local function current_outro_len()
    return (opts.manual_outro_end or 0) - (opts.manual_outro_start or 0)
end

-- ========= uosc 菜单渲染 =========
local function open_uosc_menu(items, title, footnote, menu_type)
    local props = {
        type            = menu_type or 'menu_skip',
        title           = title or '跳过片头片尾设置',
        items           = items,
        footnote        = footnote or '提示：回车提交；Esc 返回',
        search_style    = 'on_demand',
        search_debounce = 0,
    }
    mp.commandv('script-message-to', 'uosc', 'open-menu', utils.format_json(props))
end

local function open_input(control_id, title, placeholder)
    local props = {
        type              = 'menu_input_' .. control_id,
        title             = title or '请输入整数（秒）',
        items             = {
            { title = '输入后按 Enter 提交', align = 'center', italic = true, selectable = false, keep_open = true },
        },
        search_style      = 'palette',
        search_debounce   = 'submit',
        on_search         = { 'script-message-to', SCRIPT, 'menu:input', control_id },
        search_suggestion = placeholder or '',
        footnote          = '仅允许非负整数（单位：秒）',
    }
    mp.commandv('script-message-to', 'uosc', 'open-menu', utils.format_json(props))
end

-- ========= 控件注册（声明式） =========
local Controls = {
    enabled = {
        type  = 'toggle',
        title = '总开关',
        parse = mutils.parse_integer,
        get   = function() return opts.enabled end,
        set   = function(v)
            opts.enabled = not not v
            mutils.save_options()
        end,
        after = function(n)
            msg.info('跳过功能：' .. bool_sign(opts.enabled))
        end,
    },

    detect_mode = {
        type    = 'radio',
        title   = '模式选择',
        options = {
            { id = DETECT_MODE.AUTO, name = '自动模式', hint = '优先章节，无则使用手动模式' },
            { id = DETECT_MODE.CHAPTER, name = '章节模式', hint = '通过章节自动识别' },
            -- { id = DETECT_MODE.SILENCE, name = '静音检查', hint = '通过识别静音区间自动跳过指定长度' },
            { id = DETECT_MODE.MANUAL, name = '手动模式', hint = '手动指定片头片尾长度' },
        },
        parse   = mutils.parse_integer,
        get     = function() return opts.detect_mode end,
        set     = function(id)
            opts.detect_mode = tonumber(id) or opts.detect_mode
            mutils.save_options()
        end,
        after   = function(n)
            msg.info('检测模式 => ' .. mode_name(opts.detect_mode))
        end,
    },

    intro = {
        type     = 'number',
        title    = '片头时长（秒）',
        hint     = '输入整数（秒）后回车',
        parse    = mutils.parse_integer,
        get      = function() return opts.manual_intro_end or 0 end,
        validate = function(n)
            if n < 0 then return false, '必须 ≥ 0' end
            local max = opts.manual_outro_end or math.huge
            if n > max then return false, '不能超过片尾边界' end
            return true
        end,
        set      = function(n)
            opts.manual_intro_end = n
            local play_url = mp.get_property('path')
            api.set_skip_time(play_url, opts.manual_intro_end, current_outro_len())
            mutils.save_options()
        end,
        after    = function(n)
            msg.info('片头时长 => ' .. n .. ' 秒')
        end,
    },

    outro = {
        type     = 'number',
        title    = '片尾时长（秒）',
        hint     = '输入整数（秒）后回车',
        parse    = mutils.parse_integer,
        get      = function() return current_outro_len() end,
        validate = function(n)
            if n < 0 then return false, '必须 ≥ 0' end
            local max = opts.manual_outro_end or math.huge
            if n > max then return false, '不能超过片尾边界' end
            return true
        end,
        set      = function(n)
            opts.manual_outro_start = (opts.manual_outro_end or 0) - n
            local play_url = mp.get_property('path')
            api.set_skip_time(play_url, opts.manual_intro_end or 0, n)
            mutils.save_options()
        end,
        after    = function(n)
            msg.info('片尾时长 => ' .. n .. ' 秒')
        end,
    },

    skipdur = {
        type     = 'number',
        title    = '快捷跳过时长（秒）',
        hint     = '输入整数（秒）后回车',
        parse    = mutils.parse_integer,
        get      = function() return opts.manual_skip_duration or 0 end,
        validate = function(n)
            if n < 0 then return false, '必须 ≥ 0' end
            return true
        end,
        set      = function(n)
            opts.manual_skip_duration = n
            mutils.save_options()
        end,
        after    = function(n)
            msg.info('快捷跳过时长 => ' .. n .. ' 秒')
        end,
    },
}

-- ========= 菜单构建（由控件表生成） =========
local function build_items()
    local items = {}

    -- 顶部状态行
    table.insert(items, {
        title      = string.format('跳过功能：%s', bool_sign(opts.enabled)),
        bold       = true,
        italic     = true,
        keep_open  = true,
        selectable = false,
    })

    -- 开关按钮
    table.insert(items, {
        title      = opts.enabled and '关闭' or '开启',
        hint       = Controls.enabled.title,
        value      = { 'script-message-to', SCRIPT, 'menu:action', 'toggle', 'enabled' },
        keep_open  = true,
        selectable = true,
    })

    -- 模式选择
    table.insert(items, { title = '— 模式选择 —', keep_open = true, selectable = false })
    local dm = Controls.detect_mode
    for _, opt in ipairs(dm.options) do
        table.insert(items, {
            title      = ((dm.get() == opt.id) and '● ' or '○ ') .. opt.name,
            hint       = opt.hint,
            value      = { 'script-message-to', SCRIPT, 'menu:action', 'set', 'detect_mode', tostring(opt.id) },
            keep_open  = true,
            selectable = true,
        })
    end

    -- 静音检测参数设置
    -- table.insert(items, { title = '— 静音检测参数设置 —', keep_open = true, selectable = false })

    -- table.insert(items, {
    --     title = string.format('静音检测阈值：%d', Controls.silence_db.get()),
    --     hint = Controls.silence_db.hint,
    --     value = { 'script-message-to', SCRIPT, 'menu:action', 'open_input', 'silence_db' },
    --     keep_open = true,
    --     selectable = true,
    -- })

    -- table.insert(items, {
    --     title = string.format('静音持续时间：%s', tostring(Controls.silence_min_dur.get())),
    --     hint = Controls.silence_min_dur.hint,
    --     value = { 'script-message-to', SCRIPT, 'menu:action', 'open_input', 'silence_min_dur' },
    --     keep_open = true,
    --     selectable = true,
    -- })

    -- 快捷时长
    table.insert(items,
        { title = '— 快捷键快速跳过时长（秒） —', keep_open = true, selectable = false, hint = '默认快捷键: Backspace' })

    table.insert(items, {
        title      = string.format('跳过时长：%d', Controls.skipdur.get()),
        hint       = Controls.skipdur.hint,
        value      = { 'script-message-to', SCRIPT, 'menu:action', 'open_input', 'skipdur' },
        keep_open  = true,
        selectable = true,
    })

    -- 手动时间
    table.insert(items, { title = '— 手动设置片头片尾时间 —', keep_open = true, selectable = false })

    table.insert(items, {
        title      = string.format('设置片头: %d s', Controls.intro.get()),
        hint       = '将片头结束时间设置为当前播放位置',
        value      = { 'script-message-to', SCRIPT, 'menu:action', 'set_skip_time', 'intro' },
        keep_open  = true,
        selectable = true,
    })

    table.insert(items, {
        title      = string.format('设置片尾: %d s', Controls.outro.get()),
        hint       = '将片尾开始时间设置为当前播放位置',
        value      = { 'script-message-to', SCRIPT, 'menu:action', 'set_skip_time', 'outro' },
        keep_open  = true,
        selectable = true,
    })

    table.insert(items, {
        title      = string.format('清空片头片尾设置'),
        hint       = '',
        value      = { 'script-message-to', SCRIPT, 'menu:action', 'clean_skip_time', 'all' },
        keep_open  = true,
        selectable = true,
    })

    return items
end

local function open_main_menu()
    open_uosc_menu(build_items(), '跳过片头片尾设置', '提示：回车提交；Esc 返回', 'menu_skip')
end

-- ========= 统一事件处理 =========
mp.register_script_message('menu:action', function(op, id, value)
    if not op then return end

    if op == 'toggle' and id == 'enabled' then
        local c = Controls.enabled
        c.set(not c.get())
        if c.after then c.after(c.get()) end
        return open_main_menu()
    end

    if op == 'open_input' and id then
        local c = Controls[id]; if not c then return end
        return open_input(id, c.title, tostring(c.get()))
    end

    if op == 'set' and id == 'detect_mode' and value then
        local c = Controls.detect_mode
        c.set(tonumber(value))
        if c.after then c.after() end
        return open_main_menu()
    end

    if op == 'set_skip_time' and id then
        local c = Controls[id]; if not c then return end
        local t = mutils.timepos()
        local n
        if id == 'intro' then
            n = math.floor(t)
        elseif id == 'outro' then
            local total = mutils.dur()
            n = math.floor(total - t)
        end

        if n and n >= 0 then
            c.set(n)
            if c.after then c.after(n) end
        end
        return open_main_menu()
    end

    if op == 'clean_skip_time' then
        local play_url = mp.get_property('path')
        api.set_skip_time(play_url, 0, 0)
        opts.manual_intro_start = 0
        opts.manual_outro_start = 0
        opts.manual_intro_end = 0
        opts.manual_outro_end = 0
        mutils.save_options()
        return open_main_menu()
    end

end)

mp.register_script_message('menu:input', function(id, value)
    local c = Controls[id]; if not c then return end

    local n
    if c.parse then
        n = c.parse(value)
    end

    if not n then
        return open_input(id, c.title .. '（无效输入）', '')
    end

    if c.validate then
        local ok, reason = c.validate(n)
        if not ok then
            return open_input(id, c.title .. '(' .. (reason or '非法') .. ')', '')
        end
    end

    c.set(n)
    if c.after then c.after(n) end
    return open_main_menu()
end)

-- ========= 顶部按钮（uosc） =========
mp.commandv('script-message-to', 'uosc', 'set-button', 'skip_cfg_btn', utils.format_json({
    icon    = 'settings',
    tooltip = '跳过片头片尾设置',
    command = 'script-message open-skip-menu',
}))

-- 打开菜单入口（供外部/按钮调用）
mp.register_script_message('open-skip-menu', open_main_menu)
