-- fntv_interp.lua
-- Fntv-Plus · MPV 插帧（AI 补帧）实时切换
-- ───────────────────────────────────────────────────────────────────────
-- 触发：uosc 控制栏按钮
--   cycle:auto_awesome:fntv_interp@fntv_interp:no/yes!?插帧
--   点击时 uosc 自动算出下一值（no↔yes）并把 set 消息回传给本脚本；
--   本脚本据此应用插帧，并用 script-message-to uosc set 回写高亮态
--   （yes=高亮、no=不高亮）—— 实现「开启即高亮」。
-- 实时生效，无需重启 MPV。
--
-- 引擎优先级（engine=auto 时）：SVP → RIFE → MPV 内置平滑运动
--   - SVP  ：SmoothVideo Project 已安装并运行，启用 [fntv-interp-svp] profile
--   - RIFE ：rife-ncnn-vulkan 已就位，启用 [fntv-interp-rife] profile
--   - builtin：MPV 自带 interpolation + video-sync=display-resample（运动补偿/去抖动）
-- 若所选/探测到的 AI 引擎不可用（profile 不存在或 apply 失败），
-- 自动回退到 MPV 内置平滑运动并提示，绝不报错卡死。

local mp = require 'mp'
local opt = require 'mp.options'

local conf = {
    -- auto | svp | rife | builtin
    engine = 'auto',
    -- 启动即开启插帧（默认关）
    default_on = false,
    -- SVP 安装目录 或 rife-ncnn-vulkan 可执行文件完整路径（留空=自动探测）
    engine_path = '',
}
opt.read_options(conf, 'fntv_interp')

-- uosc 外部属性名（须与 controls 行 @fntv_interp 的脚本名一致）
local EXT = 'fntv_interp'

local function toast(msg)
    pcall(function() mp.commandv('show-text', msg, 2200) end)
end

-- 通知 uosc 更新按钮高亮态（yes=高亮 / no=不高亮）
local function set_uosc(val)
    pcall(function()
        mp.commandv('script-message-to', 'uosc', 'set', EXT, val)
    end)
end

-- 内置平滑运动（MPV 自带，永远可用）
local function apply_builtin(on)
    if on then
        mp.set_property('interpolation', 'yes')
        mp.set_property('video-sync', 'display-resample')
    else
        mp.set_property('interpolation', 'no')
        mp.set_property('video-sync', 'audio')
    end
end

-- 移除可能由 AI 引擎注入的视频滤镜
local function clear_ai()
    pcall(function() mp.commandv('vf', 'clr') end)
    pcall(function() mp.set_property('video-sync', 'audio') end)
end

-- 尝试启用某个 profile（SVP/RIFE），成功返回 true
-- 注意：profile 不存在时 mpv 会报错但 mp.commandv 仍"派发成功"，需用其返回值判定真正生效
local function try_profile(name)
    local ok, res = pcall(function()
        return mp.commandv('apply-profile', name)
    end)
    return ok and res == true
end

-- 核心：按引擎应用/关闭插帧（含 OSD 提示）
local function apply(on)
    if on then
        local eng = (conf.engine or 'auto'):lower()

        if eng == 'builtin' then
            apply_builtin(true)
            toast('插帧：MPV 内置平滑运动 已开启')
            return
        end

        if eng == 'svp' or eng == 'auto' then
            if try_profile('fntv-interp-svp') then
                toast('插帧：SVP AI 补帧 已开启')
                return
            end
        end

        if eng == 'rife' or eng == 'auto' then
            if try_profile('fntv-interp-rife') then
                toast('插帧：RIFE AI 补帧 已开启')
                return
            end
        end

        -- AI 引擎不可用 → 回退内置
        apply_builtin(true)
        toast('未检测到可用的 AI 补帧引擎，已回退 MPV 内置平滑运动')
    else
        clear_ai()
        apply_builtin(false)
        toast('插帧 已关闭')
    end
end

-- 文件加载后：按默认开关设定初始「高亮态 + 插帧开关」
mp.register_event('file-loaded', function()
    local init = conf.default_on and 'yes' or 'no'
    set_uosc(init)
    apply(init == 'yes')
end)

-- 监听 uosc 控制栏按钮（cycle:...@fntv_interp）点击：
-- uosc 算出下一值后回传 set 消息，本脚本据此应用插帧并回写高亮态。
mp.register_script_message('set', function(prop, value)
    if prop ~= EXT then return end
    local on = (value == 'yes' or value == true)
    apply(on)
    set_uosc(value) -- 回写，确保 uosc 显示态与真实状态一致
end)

mp.log('info', '[fntv_interp] 已加载 (engine=' .. tostring(conf.engine) .. ', default_on=' .. tostring(conf.default_on) .. ')')
