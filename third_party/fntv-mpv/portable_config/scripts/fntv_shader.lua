-- fntv_shader.lua
-- Fntv-Plus · MPV 着色器(glsl-shaders)快捷开关
-- ───────────────────────────────────────────────────────────────────────
-- 触发：uosc 控制栏按钮
--   cycle:filter_alt:fntv_shader@fntv_shader:no/yes!?着色器
--   点击时 uosc 自动算出下一值（no↔yes）并把 set 消息回传给本脚本；
--   本脚本据此设置/清空 glsl-shaders，并用 script-message-to uosc set 回写高亮态
--   （yes=高亮、no=不高亮）—— 实现「开启即高亮」。
-- 实时生效，无需重启 MPV。
--
-- 配置：script-opts/fntv_shader.conf
--   shaders    = 着色器文件列表（逗号分隔；支持 ~~/ 表示 mpv 配置目录；
--                留空 = 只切换 glsl-shaders 启用状态，不预置文件）
--   default_on = 启动即开启（默认关）

local mp = require 'mp'
local opt = require 'mp.options'

local conf = {
    -- Anime4K 动画超分组合（Restore 还原 + Upscale x2 放大）
    shaders = '~~/shaders/Anime4K_Restore_CNN_S.glsl,~~/shaders/Anime4K_Upscale_CNN_x2_S.glsl',
    -- 启动即开启着色器（默认关）
    default_on = false,
}
opt.read_options(conf, 'fntv_shader')

-- uosc 外部属性名（须与 controls 行 @fntv_shader 的脚本名一致）
local EXT = 'fntv_shader'

local function toast(msg)
    pcall(function() mp.commandv('show-text', msg, 2200) end)
end

-- 通知 uosc 更新按钮高亮态（yes=高亮 / no=不高亮）
local function set_uosc(val)
    pcall(function()
        mp.commandv('script-message-to', 'uosc', 'set', EXT, val)
    end)
end

-- 核心：应用/关闭着色器（含 OSD 提示）
local function apply(on)
    local ok, err = pcall(function()
        if on then
            mp.set_property('glsl-shaders', conf.shaders)
        else
            mp.set_property('glsl-shaders', '')
        end
    end)
    if not ok then
        toast('着色器切换失败: ' .. tostring(err))
        return
    end
    toast(on and '着色器已开启' or '着色器已关闭')
    set_uosc(on and 'yes' or 'no')
end

-- [lc-1007] 高亮态一律以真实 glsl-shaders 属性为准，不再用 conf.default_on 猜：
--   面板预设(mpv-user.conf 的 glsl-shaders-append) / Ctrl+1~9 临时切换 / 按钮开关
--   都会改 glsl-shaders，observer 捕获后统一回写 uosc 高亮，杜绝「面板选了默认但按钮不同步」。
local function sync_btn()
    local cur = mp.get_property('glsl-shaders') or ''
    set_uosc((cur ~= '' and cur ~= 'no') and 'yes' or 'no')
end
mp.observe_property('glsl-shaders', 'string', function() sync_btn() end)

-- 文件加载后：仅当当前无着色器且 default_on 时应用一次；随后 sync_btn 兜底初始高亮
mp.register_event('file-loaded', function()
    if conf.default_on and (mp.get_property('glsl-shaders') or '') == '' then
        apply(true)
    end
    sync_btn()
end)

-- 监听 uosc 控制栏按钮（cycle:...@fntv_shader）点击：
-- uosc 算出下一值后回传 set 消息，本脚本据此应用着色器。
-- 高亮态不再无条件回写，改由 apply() 成功路径 + glsl-shaders observer 统一保证一致，
-- 避免 apply 失败（如着色器文件缺失）时按钮仍误翻到高亮。
mp.register_script_message('set', function(prop, value)
    if prop ~= EXT then return end
    apply(value == 'yes' or value == true)
end)

mp.log('info', '[fntv_shader] 已加载 (shaders=' .. tostring(conf.shaders) .. ', default_on=' .. tostring(conf.default_on) .. ')')
