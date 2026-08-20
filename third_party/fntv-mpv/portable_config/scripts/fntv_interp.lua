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
--   - nvidia：N 卡 Smooth Motion（RTX50+ 驱动级视频帧生成），走 D3D11 呈现由驱动接管；
--            显式档，不进 auto 自动探测（无法可靠识别 RTX50+ 与驱动是否开启 Smooth Motion）。
-- 若所选/探测到的 AI 引擎不可用（profile 不存在或 apply 失败），
-- 自动回退到 MPV 内置平滑运动并提示，绝不报错卡死。

local mp = require 'mp'
local opt = require 'mp.options'

local conf = {
    -- auto | svp | rife | builtin | nvidia
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

        if eng == 'nvidia' then
            -- N 卡 Smooth Motion（RTX50+ 驱动级视频帧生成）
            -- 机制：驱动在 Vulkan(DX12) 呈现的视频帧上做帧生成，无需 VapourSynth/MPCVR/AI 模型，最轻量。
            -- ⚠️ 关键：必须走 Vulkan 呈现（gpu-context=winvk），D3D11 上下文 NVIDIA SM 不生效；
            --    gpu-context 是启动项，无法运行时切换，已由应用侧写入 mpv-interp-nvidia.conf（被 mpv-user.conf include），
            --    故开启后需重启一次播放器才生效。本分支只负责提示与高亮，不做运行时属性切换。
            -- 前提：① 显卡 RTX50+；② 在 NVIDIA App 将本播放器 mpv.exe 加入「程序设置」并开启 Smooth Motion
            --       （仅全局开启对多数播放器无效，必须按 exe 单独加；NVIDIA App / Profile Inspector 均可）。
            toast('插帧：N 卡 Smooth Motion（RTX50 驱动级）已开启\n重启播放器后由 NVIDIA 驱动接管；\n请确认 NVIDIA App 已把本播放器 mpv.exe 加入程序列表并开启 Smooth Motion')
            return
        end

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
-- [lc-612] 同时同步内部开关状态 interp_on，供右键菜单 toggle 从正确状态起算
local interp_on = false
mp.register_event('file-loaded', function()
    local init = conf.default_on and 'yes' or 'no'
    set_uosc(init)
    apply(init == 'yes')
    interp_on = init == 'yes'
end)

-- 监听 uosc 控制栏按钮（cycle:...@fntv_interp）点击：
-- uosc 算出下一值后回传 set 消息，本脚本据此应用插帧并回写高亮态。
mp.register_script_message('set', function(prop, value)
    if prop ~= EXT then return end
    local on = (value == 'yes' or value == true)
    apply(on)
    interp_on = on
    set_uosc(value) -- 回写，确保 uosc 显示态与真实状态一致
end)

-- [lc-612] 右键菜单「插帧开关」切换入口（input.conf #menu: 项调用）：
-- 点击即翻转内部开关状态（不再依赖 uosc cycle 按钮）。
mp.register_script_message('toggle', function()
    interp_on = not interp_on
    apply(interp_on)
    set_uosc(interp_on and 'yes' or 'no')
end)

mp.log('info', '[fntv_interp] 已加载 (engine=' .. tostring(conf.engine) .. ', default_on=' .. tostring(conf.default_on) .. ')')
