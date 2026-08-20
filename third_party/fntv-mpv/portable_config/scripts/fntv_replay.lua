-- fntv_replay.lua — uosc 控制栏「重新播放」按钮
-- [lc-611] 播放完毕后重新播放需要关掉再开 → 加一键从头播放:
--   任意时刻点击 → 停止 → seek 到 0 → 恢复播放（EOF 结束后也能重新起播）。
--
-- 触发（uosc controls 行，command 类型 = 一次性动作，点击即执行）:
--   command:replay:script-message-to fntv_replay do_replay?重新播放
--
-- 与 fntv_interp.lua / fntv_shader.lua 同构（uosc 按钮 + script-message 回调）。

local mp = require 'mp'
local msg = require 'mp.msg'

-- 通知 uosc 按钮短暂高亮（点击反馈）
local function flash()
    pcall(function()
        mp.commandv('script-message-to', 'uosc', 'set', 'fntv_replay', 'yes')
        mp.add_timeout(0.7, function()
            pcall(function()
                mp.commandv('script-message-to', 'uosc', 'set', 'fntv_replay', 'no')
            end)
        end)
    end)
end

-- 核心：重新播放（从头开始）
local function do_replay()
    if not mp.get_property('path') then
        msg.warn('重新播放：无当前文件')
        return
    end
    flash()
    msg.info('重新播放：从头开始')
    -- 1) 取消暂停、回到开头
    mp.set_property_bool('pause', false)
    mp.set_property('time-pos', 0)
    -- 2) 若已 EOF 结束（播放器处于 ended 态），seek 0 后强制 seek 0.01 触发重新解码起播
    mp.command('seek 0 absolute')
    mp.add_timeout(0.15, function()
        mp.set_property_bool('pause', false)
        mp.command('seek 0.01 absolute')
    end)
    -- 3) OSD 提示
    pcall(function() mp.commandv('show-text', '↻ 重新播放', 1500) end)
end

mp.register_script_message('do_replay', do_replay)

msg.info('[fntv_replay] 已加载（重新播放按钮）')
