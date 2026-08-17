-- fntv_interp.lua
-- Fntv-Plus · MPV 插帧（AI 补帧）实时切换
-- ───────────────────────────────────────────────────────────────────────
-- 触发：uosc 控制栏按钮
--   cycle:auto_awesome:user-data/fntv/interp:no/yes!?插帧
--   点击切换 user-data/fntv/interp 属性（'yes'/'no'），本脚本监听并应用对应引擎。
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

local PROP = 'user-data/fntv/interp'

local function toast(msg)
    pcall(function() mp.commandv('show-text', msg, 2200) end)
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

-- 文件加载后：按默认开关初始化 user-data（使 uosc 按钮高亮与默认一致）
mp.register_event('file-loaded', function()
    if conf.default_on then
        mp.set_property(PROP, 'yes')
    end
end)

-- 监听 user-data/fntv/interp，实时应用
mp.observe_property(PROP, 'string', function(_, val)
    apply(val == 'yes' or val == true)
end)

-- 备用：通过 script-message 触发（若改用 command:...:script-message fntv-interp toggle）
mp.register_script_message('fntv-interp', function(arg)
    if arg == 'toggle' then
        local cur = mp.get_property(PROP, 'no')
        mp.set_property(PROP, cur == 'yes' and 'no' or 'yes')
    end
end)

mp.log('info', '[fntv_interp] 已加载 (engine=' .. tostring(conf.engine) .. ', default_on=' .. tostring(conf.default_on) .. ')')
