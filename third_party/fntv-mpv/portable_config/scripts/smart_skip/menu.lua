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
    if m == DETECT_MODE.CHAPTER then return '章节' end
    if m == DETECT_MODE.MANUAL then return '仅手动标记' end
    if m == DETECT_MODE.AUTO then return '自动' end
    if m == DETECT_MODE.SILENCE then return '静音检查' end
    return tostring(m)
end

local function bool_sign(b) return b and '✔' or '✘' end

-- [lc-1264] 时间格式化（分:秒）；nil/负数 → 未标。0 是合法起点（片头从 0 开始），须显示 0:00。
local function fmt_ts(t)
    t = tonumber(t)
    if not t or t < 0 then return '未标' end
    return string.format('%d:%02d', math.floor(t / 60), math.floor(t % 60))
end

local function fmt_sec(t)
    return tostring(math.floor(tonumber(t) or 0))
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
-- [lc-1296] play_url 为 nil（空闲/换集瞬间）时直接跳过双写：api 层对 nil url 会抛
--   「attempt to index local 'url'」把整个脚本杀死（旧版实测，菜单从此失灵直到重启播放器）。
--   opts 已先行改好，等下一次播放触发数据加载即可。
local function apply_manual_marks()
    local play_url = mp.get_property('path')
    if not play_url or play_url == '' then
        msg.warn('当前无播放文件，跳过服务端/本地标记同步')
        sync_shared_marks()
        return
    end
    api.set_skip_time(play_url, opts.manual_intro_end or 0, fnos_skip_end())
    api.sync_manual_local(play_url, opts.manual_intro_end or 0, fnos_skip_end(), mutils.dur(),
        opts.manual_intro_start or 0, opts.manual_outro_start or 0, opts.manual_outro_end or 0)
    mutils.save_options()
    sync_shared_marks()
end

-- ========= [lc-1296] uosc 菜单：两级结构 + 原地刷新 =========
-- 旧版面板是 ~20 行平铺列表（开关/模式/打点/区间/试跳/窗口全部堆一页），信息过载。
-- 重组为两级：根页 6 行（说明 + 开关 / 标记片头片尾 / 识别方式 / 按钮显示时机 / 快速跳过），
-- 「标记」子菜单内再分片头、片尾两个小节；读写逻辑（opts + 飞牛服务端 + 本地 4 值
-- 三源同步）与打点语义完全不动，只重组 UI 层。
-- 刷新改用 uosc 的 update-menu：按菜单 id 匹配原地重建，保留当前所在子菜单、选中项
-- 与滚动位置（旧版每次操作后重发 open-menu，菜单整个重开、焦点跳回第一行）。
-- 子菜单 id 规则（uosc Menu:update）：根={root}；item 带 id 字段则子菜单 id=该值。
-- 每个分组 item 固定 id（marks/detect/timing），保证跨次刷新 id 稳定、状态可延续，
-- 也供输入面板提交后 open-menu 带 submenu_id 直达返回（activate_menu(id)）。
-- ⚠️ uosc 的 footnote 文字仅在悬停左下角帮助图标时显示，重要说明必须用普通行承载；
--   分隔线沿用 uosc 惯例画在「上一行」下方（separator=true 挂在前一小节末行上）。

local MENU_TYPE = 'menu_skip'

local SUBMARKS_ID, SUBDETECT_ID, SUBTIMING_ID = 'marks', 'detect', 'timing'

-- ── 标记子菜单：顶部状态总览 + 片头/片尾两个小节 ──
local function build_submarks()
    local intro_s = opts.manual_intro_start or 0
    local intro_e = opts.manual_intro_end or 0
    local outro_s = opts.manual_outro_start or 0
    local outro_e = opts.manual_outro_end or 0
    -- 与 main.lua 的 has_real_marks 同式：终点 > 起点 ⇔ 该段已标
    local intro_marked = intro_e > intro_s
    local outro_marked = outro_e > outro_s

    local items = {}

    items[#items + 1] = {
        title = intro_marked
            and string.format('片头：%s ~ %s（%d 秒）', fmt_ts(intro_s), fmt_ts(intro_e), math.floor(intro_e - intro_s))
            or '片头：未标记',
        italic = not intro_marked,
        muted = not intro_marked,
        selectable = false,
        keep_open = true,
    }
    items[#items + 1] = {
        title = outro_marked
            and string.format('片尾：%s ~ %s（%d 秒）', fmt_ts(outro_s), fmt_ts(outro_e), math.floor(outro_e - outro_s))
            or '片尾：未标记',
        italic = not outro_marked,
        muted = not outro_marked,
        selectable = false,
        keep_open = true,
    }

    -- ── 片头小节 ──
    items[#items].separator = true
    items[#items + 1] = { title = '片头', italic = true, selectable = false, keep_open = true }
    if intro_marked then
        -- 已标记：收起打点按钮，只留试跳校准 + 直填（沿袭 lc-1265 的收起逻辑）
        items[#items + 1] = {
            title = '试跳：跳到片头终点',
            hint = '校准打点是否准确；跳错点「回到原位」',
            value = { 'script-message-to', SCRIPT, 'menu:action', 'seek_test', 'intro_end' },
            keep_open = true,
        }
    else
        items[#items + 1] = {
            title = string.format('打点起点（当前 %s）', fmt_ts(mutils.timepos())),
            hint = '当前位置记为片头开始（OP 前有前情回顾时用）',
            value = { 'script-message-to', SCRIPT, 'menu:action', 'mark_at', 'intro_start' },
            keep_open = true,
        }
        items[#items + 1] = {
            title = string.format('打点终点（当前 %s）', fmt_ts(mutils.timepos())),
            hint = '当前位置记为片头结束（跳过落点）',
            value = { 'script-message-to', SCRIPT, 'menu:action', 'mark_at', 'intro_end' },
            keep_open = true,
        }
    end
    items[#items + 1] = {
        title = string.format('直填区间（秒）：%s ~ %s', fmt_sec(intro_s), fmt_sec(intro_e)),
        hint = '「起点,终点」如 0,90；0,0 清除该片头',
        value = { 'script-message-to', SCRIPT, 'menu:action', 'open_interval_input', 'intro' },
        keep_open = true,
    }

    -- ── 片尾小节 ──
    items[#items].separator = true
    items[#items + 1] = { title = '片尾', italic = true, selectable = false, keep_open = true }
    if outro_marked then
        items[#items + 1] = {
            title = '试跳：跳到片尾起点',
            hint = '校准打点是否准确；跳错点「回到原位」',
            value = { 'script-message-to', SCRIPT, 'menu:action', 'seek_test', 'outro_start' },
            keep_open = true,
        }
    else
        items[#items + 1] = {
            title = string.format('打点起点（当前 %s）', fmt_ts(mutils.timepos())),
            hint = '当前位置记为片尾开始（跳过起点）',
            value = { 'script-message-to', SCRIPT, 'menu:action', 'mark_at', 'outro_start' },
            keep_open = true,
        }
        items[#items + 1] = {
            title = string.format('打点终点（当前 %s）', fmt_ts(mutils.timepos())),
            hint = '当前位置记为片尾结束（ED 完的位置）',
            value = { 'script-message-to', SCRIPT, 'menu:action', 'mark_at', 'outro_end' },
            keep_open = true,
        }
    end
    items[#items + 1] = {
        title = string.format('直填区间（秒）：%s ~ %s', fmt_sec(outro_s), fmt_sec(outro_e)),
        hint = '「起点,终点」如 660,720；0,0 清除该片尾',
        value = { 'script-message-to', SCRIPT, 'menu:action', 'open_interval_input', 'outro' },
        keep_open = true,
    }

    -- 回到原位（仅试跳过才出现）
    if pre_seek_pos >= 0 then
        items[#items + 1] = {
            title = string.format('◁ 回到原位（%s）', fmt_ts(pre_seek_pos)),
            value = { 'script-message-to', SCRIPT, 'menu:action', 'seek_test', 'back' },
            keep_open = true,
        }
    end

    items[#items].separator = true
    items[#items + 1] = {
        title = '清除全部标记',
        hint = '片头+片尾清零（服务端+本地），恢复自动识别',
        value = { 'script-message-to', SCRIPT, 'menu:action', 'clean_skip_time', 'all' },
        keep_open = true,
    }

    return {
        title    = '标记片头片尾',
        footnote = '标记保存到服务端 + 本地，网页端同步生效',
        items    = items,
    }
end

-- ── 识别方式子菜单 ──
local function build_subdetect()
    local modes = {
        { id = DETECT_MODE.AUTO,    name = '自动',       hint = '章节 → 手动标记 → 在线库兜底' },
        { id = DETECT_MODE.CHAPTER, name = '章节',       hint = '用视频内嵌章节推断' },
        { id = DETECT_MODE.MANUAL,  name = '仅手动标记', hint = '只用打点/直填的区间' },
    }
    local items = {}
    for _, m in ipairs(modes) do
        items[#items + 1] = {
            title     = m.name,
            hint      = m.hint,
            active    = (opts.detect_mode == m.id),
            value     = { 'script-message-to', SCRIPT, 'menu:action', 'set', 'detect_mode', tostring(m.id) },
            keep_open = true,
        }
    end
    return {
        title    = '识别方式',
        footnote = '决定跳过数据从哪来；无数据的集不显示按钮',
        items    = items,
    }
end

-- ── 按钮显示时机子菜单 ──
local function build_subtiming()
    local items = {}
    items[#items + 1] = {
        title = string.format('按钮提前出现：%d 秒', mutils.lead_for(opts)),
        hint = '比区间起点早 N 秒出现（0~60）',
        value = { 'script-message-to', SCRIPT, 'menu:action', 'open_input', 'skip_lead' },
        keep_open = true,
    }
    items[#items + 1] = {
        title = string.format('片头显示窗口：%d 秒', mutils.window_for(opts, 'intro')),
        hint = '开播后 N 秒内显示片头按钮（0=仅按标记区间）',
        value = { 'script-message-to', SCRIPT, 'menu:action', 'open_input', 'intro_window' },
        keep_open = true,
    }
    items[#items + 1] = {
        title = string.format('片尾显示窗口：%d 秒', mutils.window_for(opts, 'outro')),
        hint = '距结束剩 N 秒内显示片尾按钮（0=仅按标记区间）',
        value = { 'script-message-to', SCRIPT, 'menu:action', 'open_input', 'outro_window' },
        keep_open = true,
    }
    return {
        title    = '按钮显示时机',
        footnote = '时间窗口 ∪ 标记区间，满足其一即显示',
        items    = items,
    }
end

-- ── 根菜单 ──
local function menu_props()
    local intro_marked = (opts.manual_intro_end or 0) > (opts.manual_intro_start or 0)
    local outro_marked = (opts.manual_outro_end or 0) > (opts.manual_outro_start or 0)
    local marks_hint
    if intro_marked and outro_marked then
        marks_hint = '已标记'
    elseif intro_marked then
        marks_hint = '仅片头已标'
    elseif outro_marked then
        marks_hint = '仅片尾已标'
    else
        marks_hint = '未标记'
    end

    local items = {}

    -- 行为说明（「点击才跳过」是这个功能最容易被误解的点，保留一行常显说明）
    items[#items + 1] = {
        title      = '进入片头/片尾区间时屏幕出现按钮，点击后跳过',
        italic     = true,
        muted      = true,
        selectable = false,
        keep_open  = true,
    }

    items[#items + 1] = {
        title     = opts.enabled and '关闭跳过按钮' or '开启跳过按钮',
        hint      = opts.enabled and '当前已开启' or '当前已关闭',
        bold      = true,
        value     = { 'script-message-to', SCRIPT, 'menu:action', 'toggle', 'enabled' },
        keep_open = true,
    }

    local sub_marks = build_submarks()
    items[#items + 1] = {
        id       = SUBMARKS_ID,
        title    = sub_marks.title,
        hint     = marks_hint,
        footnote = sub_marks.footnote,
        items    = sub_marks.items,
    }

    local sub_detect = build_subdetect()
    items[#items + 1] = {
        id       = SUBDETECT_ID,
        title    = sub_detect.title,
        hint     = mode_name(opts.detect_mode),
        footnote = sub_detect.footnote,
        items    = sub_detect.items,
    }

    local sub_timing = build_subtiming()
    items[#items + 1] = {
        id       = SUBTIMING_ID,
        title    = sub_timing.title,
        hint     = string.format('提前 %d 秒', mutils.lead_for(opts)),
        footnote = sub_timing.footnote,
        items    = sub_timing.items,
    }

    items[#items + 1] = {
        title     = string.format('快速跳过时长：%d 秒', opts.manual_skip_duration or 0),
        hint      = '快捷键 Backspace',
        value     = { 'script-message-to', SCRIPT, 'menu:action', 'open_input', 'skipdur' },
        keep_open = true,
    }

    return {
        type            = MENU_TYPE,
        title           = '跳过片头片尾',
        footnote        = '设置即时保存；Esc 关闭',
        items           = items,
        search_style    = 'on_demand',
        search_debounce = 0,
    }
end

-- 原地刷新（保留当前子菜单与选中项）；菜单没开时 uosc 侧静默跳过
local function refresh_menu()
    mp.commandv('script-message-to', 'uosc', 'update-menu', utils.format_json(menu_props()))
end

-- 重开菜单（可带子菜单 id 直达；用于初次打开和输入面板提交后返回）
local function open_menu(submenu_id)
    local json = utils.format_json(menu_props())
    if submenu_id and submenu_id ~= '' then
        mp.commandv('script-message-to', 'uosc', 'open-menu', json, submenu_id)
    else
        mp.commandv('script-message-to', 'uosc', 'open-menu', json)
    end
end

-- 当前所在的子菜单 id（供输入面板提交后原路返回）：
--   输入面板是另一个菜单实例（type 不同），打开时主菜单已被替换销毁，无从读取位置，
--   因此在每次打开输入面板时记录来源子菜单，输入完成后据此直达返回。
local current_submenu = nil

local function note_submenu_from_input(id)
    if id == 'skip_lead' or id == 'intro_window' or id == 'outro_window' then
        current_submenu = SUBTIMING_ID
    elseif id == 'skipdur' then
        current_submenu = nil
    else
        current_submenu = SUBMARKS_ID
    end
end

-- ========= 输入面板（palette，回车提交） =========
local function open_input(control_id, title, placeholder)
    note_submenu_from_input(control_id)
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

-- 区间输入面板（「起点,终点」双值）
local function open_interval_input(id, placeholder)
    current_submenu = SUBMARKS_ID
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
        footnote          = '回车提交',
    }
    mp.commandv('script-message-to', 'uosc', 'open-menu', utils.format_json(props))
end

-- ========= 控件注册（声明式，输入面板的目标控件） =========
local Controls = {
    skipdur = {
        type     = 'number',
        title    = '快速跳过时长（秒）',
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
            msg.info('快速跳过时长 => ' .. n .. ' 秒')
        end,
    },

    -- [lc-1264] 提前量输入（复用 menu:input 通道）
    skip_lead = {
        type     = 'number',
        title    = '按钮提前出现（秒）',
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
    },

    -- [lc-1266] 显示窗口输入：片头=播放开始后 N 秒内显示按钮；片尾=距结束剩 N 秒内显示按钮
    intro_window = {
        type     = 'number',
        title    = '片头按钮显示窗口（秒）',
        parse    = mutils.parse_integer,
        get      = function() return opts.manual_intro_window or 0 end,
        validate = function(n) if n < 0 or n > 7200 then return false, '应在 0~7200' end return true end,
        set      = function(n)
            opts.manual_intro_window = n
            mutils.save_options()
        end,
        after    = function(n) msg.info('片头显示窗口 => ' .. n .. ' 秒') end,
    },

    outro_window = {
        type     = 'number',
        title    = '片尾按钮显示窗口（秒）',
        parse    = mutils.parse_integer,
        get      = function() return opts.manual_outro_window or 0 end,
        validate = function(n) if n < 0 or n > 7200 then return false, '应在 0~7200' end return true end,
        set      = function(n)
            opts.manual_outro_window = n
            mutils.save_options()
        end,
        after    = function(n) msg.info('片尾显示窗口 => ' .. n .. ' 秒') end,
    },
}

-- ========= 统一事件处理 =========
mp.register_script_message('menu:action', function(op, id, value)
    if not op then return end

    if op == 'toggle' and id == 'enabled' then
        opts.enabled = not opts.enabled
        mutils.save_options()
        msg.info('跳过功能：' .. bool_sign(opts.enabled))
        return refresh_menu()
    end

    if op == 'open_input' and id then
        local c = Controls[id]; if not c then return end
        return open_input(id, c.title, tostring(c.get()))
    end

    if op == 'set' and id == 'detect_mode' and value then
        opts.detect_mode = tonumber(value) or opts.detect_mode
        mutils.save_options()
        msg.info('检测模式 => ' .. mode_name(opts.detect_mode))
        return refresh_menu()
    end

    if op == 'clean_skip_time' then
        local play_url = mp.get_property('path')
        -- [lc-1296] 同 apply_manual_marks：无播放文件时跳过双写，避免 nil url 崩脚本
        if play_url and play_url ~= '' then
            api.set_skip_time(play_url, 0, 0)
            -- [lc-1257] 清空动作同步删本地标记（双零载荷 = 删除语义）
            api.sync_manual_local(play_url, 0, 0, 0)
        end
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
        return refresh_menu()
    end

    -- 打点：把当前播放位置记为指定标记点（四点打点，与网页端对齐）
    if op == 'mark_at' and id then
        local n = math.floor(mutils.timepos() or 0)
        if id == 'intro_start' then
            opts.manual_intro_start = n
            if (opts.manual_intro_end or 0) <= n then opts.manual_intro_end = 0 end  -- 终点须大于起点
        elseif id == 'intro_end' then
            opts.manual_intro_end = n
        elseif id == 'outro_start' then
            -- [lc-1265] 不自动把终点默认成片长：终点未标 = 片尾未标完，
            --  面板保持打点按钮可继续标终点（旧行为会把跳过落点悄悄顶到文件尾）。
            opts.manual_outro_start = n
        elseif id == 'outro_end' then
            opts.manual_outro_end = n
        end
        apply_manual_marks()
        return refresh_menu()
    end

    -- 精确区间编辑：输入「起点,终点」（单值=只改起点；0,0=清除该区间）
    if op == 'open_interval_input' and id then
        local cur
        if id == 'intro' then
            cur = string.format('%d,%d', math.floor(opts.manual_intro_start or 0), math.floor(opts.manual_intro_end or 0))
        else
            cur = string.format('%d,%d', math.floor(opts.manual_outro_start or 0), math.floor(opts.manual_outro_end or 0))
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
        return refresh_menu()
    end

end)

mp.register_script_message('menu:input', function(id, value)
    local c = Controls[id]; if not c then return end

    local n = c.parse and c.parse(value) or nil

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
    -- [lc-1296] 输入面板提交后面板已关：重开主菜单并直达原子菜单
    return open_menu(current_submenu)
end)

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
    return open_menu(current_submenu)
end)

-- ========= 顶部按钮（uosc） =========
mp.commandv('script-message-to', 'uosc', 'set-button', 'skip_cfg_btn', utils.format_json({
    icon    = 'settings',
    tooltip = '跳过片头片尾设置',
    command = 'script-message open-skip-menu',
}))

-- 打开菜单入口（供外部/按钮调用）
mp.register_script_message('open-skip-menu', function()
    current_submenu = nil
    open_menu()
end)
