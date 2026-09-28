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

-- ========= [lc-1264] 时间格式化与试跳 =========
local function fmt_ts(t)
    if not t or t <= 0 then return '未标' end
    return string.format('%d:%02d', math.floor(t / 60), math.floor(t % 60))
end

-- [lc-1265] 飞牛 skipinfo 的 2 值语义：skipStart=片头跳过秒数、skipEnd=片尾从结尾倒数秒数。
--   ⚠️ 不能把「片尾区间长度」当 skipEnd 写（读回按 total-skipEnd 还原起点，会逐次漂移）；
--   必须写 总时长 − 片尾起点。片尾终点（ED 后仍有正片的情形）2 值表达不了，
--   靠本地 4 值存储 + MPV 侧 load_local_marks 精确保留。
local function fnos_skip_end()
    local total = mutils.dur() or 0
    local outro_start = opts.manual_outro_start or 0
    if outro_start > 0 and total > 0 and total > outro_start then
        return math.floor(total - outro_start)
    end
    return 0
end

-- 试跳到指定秒数（校准打点用；记录原位置供「回到原位」）
local pre_seek_pos = -1

local function seek_to(t)
    if not t or t < 0 then return end
    local pos = mutils.timepos()
    if pos and pos >= 0 then pre_seek_pos = pos end
    mp.commandv('seek', t, 'absolute+exact')
end

-- [lc-1265] 人工标记改动后同步共享状态：作废在途异步结果（gen+1）、
--   声明来源为本地精确标记并按当前 opts 置位区间覆盖位（自动/兜底来源不得再覆盖）。
local function sync_shared_marks()
    local shared = _G.fntv_skip_state
    if not shared then return end
    shared.gen = (shared.gen or 0) + 1
    shared.source = 'local'
    shared.have_intro = (opts.manual_intro_end or 0) > (opts.manual_intro_start or 0)
    shared.have_outro = (opts.manual_outro_end or 0) > (opts.manual_outro_start or 0)
    if shared.refresh then shared.refresh() end
end

-- [lc-1257] 打点动作统一出口：写 opts + 飞牛服务端 + 本地 4 值存储（三者同源不脱节）
-- [lc-1264] 升级：本地同步带精确 4 值（introStart/outroStart/outroEnd），网页端兜底按钮同区间
-- [lc-1265] 写服务端改用正确 skipEnd 语义（总时长−片尾起点）；打点后立即刷新按钮落点
local function apply_manual_marks()
    local play_url = mp.get_property('path')
    api.set_skip_time(play_url, opts.manual_intro_end or 0, fnos_skip_end())
    api.sync_manual_local(play_url, opts.manual_intro_end or 0, fnos_skip_end(), mutils.dur(),
        opts.manual_intro_start or 0, opts.manual_outro_start or 0, opts.manual_outro_end or 0)
    mutils.save_options()
    sync_shared_marks()
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
            api.set_skip_time(play_url, opts.manual_intro_end, fnos_skip_end())
            -- [lc-1257] 同步本地 4 值存储（网页端「标记不准」状态/兜底按钮跨端一致）
            api.sync_manual_local(play_url, opts.manual_intro_end, fnos_skip_end(), mutils.dur(),
                opts.manual_intro_start or 0, opts.manual_outro_start or 0, opts.manual_outro_end or 0)
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
            api.set_skip_time(play_url, opts.manual_intro_end or 0, fnos_skip_end())
            -- [lc-1257] 同步本地 4 值存储（改片尾时长 = 移动片尾起点，终点保持不变）
            api.sync_manual_local(play_url, opts.manual_intro_end or 0, fnos_skip_end(), mutils.dur(),
                opts.manual_intro_start or 0, opts.manual_outro_start or 0, opts.manual_outro_end or 0)
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

    -- 行为说明行
    table.insert(items, {
        title      = '开启后：进入片头/片尾区间显示按钮，点击才跳过',
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

    -- 模式选择（决定跳过数据来源：检测到数据才有按钮可显示）
    table.insert(items, { title = '— 数据来源（检测到才有按钮） —', keep_open = true, selectable = false })
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
    -- [lc-1264] 当前值回显（分:秒）+ 精确区间编辑 + 试跳校准 + 起点打点。
    -- [lc-1265] 打点完成后（该段起点/终点均已标）收起该段的两个打点按钮，
    --   直接显示「片头/片尾时长」；点「清除标记」后恢复打点按钮重新标记。
    local intro_marked = (opts.manual_intro_end or 0) > 0
        and (opts.manual_intro_end or 0) > (opts.manual_intro_start or 0)
    local outro_marked = (opts.manual_outro_start or 0) > 0
        and (opts.manual_outro_end or 0) > (opts.manual_outro_start or 0)

    table.insert(items, { title = '— 手动标记片头片尾（写服务端 + 本地，全端生效） —', keep_open = true, selectable = false })

    if intro_marked then
        local ilen = math.floor((opts.manual_intro_end or 0) - (opts.manual_intro_start or 0))
        table.insert(items, {
            title      = string.format('▶ 片头时长: %s（%d 秒）', fmt_ts(ilen), ilen),
            hint       = string.format('区间 %s ~ %s；点「清除标记」可重新打点',
                fmt_ts(opts.manual_intro_start), fmt_ts(opts.manual_intro_end)),
            keep_open  = true,
            selectable = false,
        })
    else
        table.insert(items, {
            title      = '▶ 片头: 未标记',
            hint       = '播放到对应位置点下方「打点」，或用「编辑片头起点/终点」直填秒数',
            keep_open  = true,
            selectable = false,
        })
        -- 打点（当前播放位置）
        table.insert(items, {
            title      = string.format('◈ 打点片头起点（当前 %s）', fmt_ts(mutils.timepos())),
            hint       = '把当前播放位置记为片头开始（OP 前有前情回顾时用）',
            value      = { 'script-message-to', SCRIPT, 'menu:action', 'mark_at', 'intro_start' },
            keep_open  = true,
            selectable = true,
        })
        table.insert(items, {
            title      = string.format('◈ 打点片头终点（当前 %s）', fmt_ts(mutils.timepos())),
            hint       = '把当前播放位置记为片头结束（跳过落点）',
            value      = { 'script-message-to', SCRIPT, 'menu:action', 'mark_at', 'intro_end' },
            keep_open  = true,
            selectable = true,
        })
    end

    if outro_marked then
        local olen = math.floor((opts.manual_outro_end or 0) - (opts.manual_outro_start or 0))
        table.insert(items, {
            title      = string.format('▶ 片尾时长: %s（%d 秒）', fmt_ts(olen), olen),
            hint       = string.format('区间 %s ~ %s；点「清除标记」可重新打点',
                fmt_ts(opts.manual_outro_start), fmt_ts(opts.manual_outro_end)),
            keep_open  = true,
            selectable = false,
        })
    else
        table.insert(items, {
            title      = '▶ 片尾: 未标记',
            hint       = '播放到对应位置点下方「打点」，或用「编辑片尾起点/终点」直填秒数',
            keep_open  = true,
            selectable = false,
        })
        table.insert(items, {
            title      = string.format('◈ 打点片尾起点（当前 %s）', fmt_ts(mutils.timepos())),
            hint       = '把当前播放位置记为片尾开始（跳过起点）',
            value      = { 'script-message-to', SCRIPT, 'menu:action', 'mark_at', 'outro_start' },
            keep_open  = true,
            selectable = true,
        })
        table.insert(items, {
            title      = string.format('◈ 打点片尾终点（当前 %s）', fmt_ts(mutils.timepos())),
            hint       = '把当前播放位置记为片尾结束（ED 完的位置）',
            value      = { 'script-message-to', SCRIPT, 'menu:action', 'mark_at', 'outro_end' },
            keep_open  = true,
            selectable = true,
        })
    end

    -- 精确区间编辑（直接输秒数，对齐网页端「直填秒数」）
    table.insert(items, {
        title      = string.format('编辑片头起点/终点（秒）: %d / %d', opts.manual_intro_start or 0, opts.manual_intro_end or 0),
        hint       = '输入「起点,终点」如「0,90」；单值则只改起点',
        value      = { 'script-message-to', SCRIPT, 'menu:action', 'open_interval_input', 'intro' },
        keep_open  = true,
        selectable = true,
    })
    table.insert(items, {
        title      = string.format('编辑片尾起点/终点（秒）: %d / %d', opts.manual_outro_start or 0, opts.manual_outro_end or 0),
        hint       = '输入「起点,终点」如「660,720」；单值则只改起点',
        value      = { 'script-message-to', SCRIPT, 'menu:action', 'open_interval_input', 'outro' },
        keep_open  = true,
        selectable = true,
    })

    -- 试跳校准（对齐网页端「试跳 + 回到原位」）
    table.insert(items, {
        title      = '▷ 试跳：跳到片头终点',
        hint       = '校准打点是否准确；跳错了点「回到原位」',
        value      = { 'script-message-to', SCRIPT, 'menu:action', 'seek_test', 'intro_end' },
        keep_open  = true,
        selectable = true,
    })
    table.insert(items, {
        title      = '▷ 试跳：跳到片尾起点',
        hint       = '校准片尾起点；确认后回到原位继续标记',
        value      = { 'script-message-to', SCRIPT, 'menu:action', 'seek_test', 'outro_start' },
        keep_open  = true,
        selectable = true,
    })
    if pre_seek_pos >= 0 then
        table.insert(items, {
            title      = string.format('◁ 回到原位（%s）', fmt_ts(pre_seek_pos)),
            value      = { 'script-message-to', SCRIPT, 'menu:action', 'seek_test', 'back' },
            keep_open  = true,
            selectable = true,
        })
    end

    table.insert(items, {
        title      = string.format('清除标记（恢复自动检测）'),
        hint       = '清空片头片尾标记 + 服务端清零 + 本地删除',
        value      = { 'script-message-to', SCRIPT, 'menu:action', 'clean_skip_time', 'all' },
        keep_open  = true,
        selectable = true,
    })

    -- 跳过按钮行为（提前量：片头/片尾按钮提前多少秒出现）
    table.insert(items, { title = '— 跳过按钮 —', keep_open = true, selectable = false })
    table.insert(items, {
        title      = string.format('提前量: %d 秒', Controls.skip_lead.get()),
        hint       = '按钮比片头/片尾起点早出现的秒数（0~60，片头片尾共用）',
        value      = { 'script-message-to', SCRIPT, 'menu:action', 'open_input', 'skip_lead' },
        keep_open  = true,
        selectable = true,
    })
    -- [lc-1266] 显示窗口：片头=播放开始后多少秒内；片尾=距结束剩多少秒内
    table.insert(items, {
        title      = string.format('片头显示窗口: %d 秒', Controls.intro_window.get()),
        hint       = '播放开始后多少秒内显示「跳过片头」按钮（0=仅按标记区间显示）',
        value      = { 'script-message-to', SCRIPT, 'menu:action', 'open_input', 'intro_window' },
        keep_open  = true,
        selectable = true,
    })
    table.insert(items, {
        title      = string.format('片尾显示窗口: %d 秒', Controls.outro_window.get()),
        hint       = '距视频结束还剩多少秒内显示「跳过片尾」按钮（0=仅按标记区间显示）',
        value      = { 'script-message-to', SCRIPT, 'menu:action', 'open_input', 'outro_window' },
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
        -- [lc-1257] 清空动作同步删本地标记（双零载荷 = 删除语义）
        api.sync_manual_local(play_url, 0, 0, 0)
        opts.manual_intro_start = 0
        opts.manual_outro_start = 0
        opts.manual_intro_end = 0
        opts.manual_outro_end = 0
        mutils.save_options()
        -- [lc-1265] 清空后：作废在途异步结果 + 复位人工覆盖位 → 面板恢复 4 个打点按钮
        local shared = _G.fntv_skip_state
        if shared then
            shared.gen = (shared.gen or 0) + 1
            shared.source = nil
            shared.have_intro = false
            shared.have_outro = false
            if shared.refresh then shared.refresh() end
        end
        return open_main_menu()
    end

    -- ===== [lc-1264] 全面升级的新动作 =====

    -- 打点：把当前播放位置记为指定标记点（四点打点，与网页端对齐）
    if op == 'mark_at' and id then
        local t = mutils.timepos() or 0
        local n = math.floor(t)
        if id == 'intro_start' then
            opts.manual_intro_start = n
            if (opts.manual_intro_end or 0) <= n then opts.manual_intro_end = 0 end  -- 终点须大于起点
        elseif id == 'intro_end' then
            opts.manual_intro_end = n
        elseif id == 'outro_start' then
            -- [lc-1265] 不再自动把终点默认成片长：终点未标 = 片尾未标完，
            --  面板保持打点按钮可继续标终点（旧行为会把跳过落点悄悄顶到文件尾）。
            opts.manual_outro_start = n
        elseif id == 'outro_end' then
            opts.manual_outro_end = n
        end
        apply_manual_marks()
        return open_main_menu()
    end

    -- 精确区间编辑：输入「起点,终点」（单值=只改起点；0,0=清除该区间）
    if op == 'open_interval_input' and id then
        local cur
        if id == 'intro' then
            cur = string.format('%d,%d', opts.manual_intro_start or 0, opts.manual_intro_end or 0)
        else
            cur = string.format('%d,%d', opts.manual_outro_start or 0, opts.manual_outro_end or 0)
        end
        return open_interval_input(id, cur)
    end

    -- 试跳与回原位
    if op == 'seek_test' and id then
        if id == 'back' then
            if pre_seek_pos >= 0 then
                mp.commandv('seek', pre_seek_pos, 'absolute+exact')
                pre_seek_pos = -1
            end
        elseif id == 'intro_end' and (opts.manual_intro_end or 0) > 0 then
            seek_to(opts.manual_intro_end)
        elseif id == 'outro_start' and (opts.manual_outro_start or 0) > 0 then
            seek_to(opts.manual_outro_start)
        end
        return open_main_menu()
    end

end)

-- 区间输入菜单（「起点,终点」双值）
function open_interval_input(id, placeholder)
    local props = {
        type              = 'menu_interval_input_' .. id,
        title             = id == 'intro' and '片头区间（秒）: 起点,终点' or '片尾区间（秒）: 起点,终点',
        items             = {
            { title = '输入「起点,终点」如 0,90；单值只改起点；0,0 清除', align = 'center', italic = true, selectable = false, keep_open = true },
        },
        search_style      = 'palette',
        search_debounce   = 'submit',
        on_search         = { 'script-message-to', SCRIPT, 'menu:interval_input', id },
        search_suggestion = placeholder or '',
        footnote          = '回车提交；Esc 返回',
    }
    mp.commandv('script-message-to', 'uosc', 'open-menu', utils.format_json(props))
end

mp.register_script_message('menu:interval_input', function(id, value)
    local s = tostring(value or ''):gsub('%s', '')
    if s == '' then return open_interval_input(id, '') end
    local a, b = s:match('^(%d+),(%d+)$')
    local single = s:match('^(%d+)$')
    if not a and not single then
        return open_interval_input(id, '输入非法，应为「起点,终点」或单值')
    end
    if id == 'intro' then
        local start_v = tonumber(a or single) or 0
        local end_v = a and tonumber(b) or (opts.manual_intro_end or 0)
        if start_v == 0 and end_v == 0 then
            opts.manual_intro_start = 0
            opts.manual_intro_end = 0
        elseif end_v > start_v then
            opts.manual_intro_start = start_v
            opts.manual_intro_end = end_v
        else
            return open_interval_input(id, '终点须大于起点')
        end
    else
        local start_v = tonumber(a or single) or 0
        local end_v = a and tonumber(b) or (opts.manual_outro_end or 0)
        if start_v == 0 and end_v == 0 then
            opts.manual_outro_start = 0
            opts.manual_outro_end = 0
        elseif end_v > start_v then
            opts.manual_outro_start = start_v
            opts.manual_outro_end = end_v
        else
            return open_interval_input(id, '终点须大于起点')
        end
    end
    apply_manual_marks()
    return open_main_menu()
end)

-- [lc-1264] 提前量输入（复用 menu:input 通道：Controls 里注册 skip_lead）
Controls.skip_lead = {
    type     = 'number',
    title    = '跳过按钮提前量（秒）',
    hint     = '按钮比片头/片尾起点早出现的秒数（0~60）',
    parse    = mutils.parse_integer,
    get      = function() return opts.manual_skip_lead or 5 end,
    validate = function(n) if n < 0 or n > 60 then return false, '应在 0~60' end return true end,
    set      = function(n)
        opts.manual_skip_lead = n
        mutils.save_options()
        -- 同步给 Electron 侧配置（兜底按钮同一套值），best-effort
        api.sync_manual_lead(n)
    end,
    after    = function(n) msg.info('提前量 => ' .. n .. ' 秒') end,
}

-- [lc-1266] 显示窗口输入：片头=播放开始后 N 秒内显示按钮；片尾=距结束剩 N 秒内显示按钮
Controls.intro_window = {
    type     = 'number',
    title    = '片头按钮显示窗口（秒）',
    hint     = '播放开始后多少秒内显示「跳过片头」按钮（0=仅按标记区间显示）',
    parse    = mutils.parse_integer,
    get      = function() return opts.manual_intro_window or 0 end,
    validate = function(n) if n < 0 or n > 7200 then return false, '应在 0~7200' end return true end,
    set      = function(n)
        opts.manual_intro_window = n
        mutils.save_options()
    end,
    after    = function(n) msg.info('片头显示窗口 => ' .. n .. ' 秒') end,
}

Controls.outro_window = {
    type     = 'number',
    title    = '片尾按钮显示窗口（秒）',
    hint     = '距视频结束还剩多少秒内显示「跳过片尾」按钮（0=仅按标记区间显示）',
    parse    = mutils.parse_integer,
    get      = function() return opts.manual_outro_window or 0 end,
    validate = function(n) if n < 0 or n > 7200 then return false, '应在 0~7200' end return true end,
    set      = function(n)
        opts.manual_outro_window = n
        mutils.save_options()
    end,
    after    = function(n) msg.info('片尾显示窗口 => ' .. n .. ' 秒') end,
}

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
