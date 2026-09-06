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

-- [lc-1090] EOF 后文件被卸载: 应用侧用 --idle 启动 mpv(node-mpv-2 默认)且没有配 keep-open
--   (uosc.conf autoload=no → uosc 也不会替我们设 keep-open=yes), 播完时事件序列是
--   end-file:eof → idle, 此后 path / time-pos / eof-reached 全部 "property unavailable"。
--   旧实现开头 `if not mp.get_property('path') then return` 在这个态下必然命中 →
--   点「重新播放」毫无反应(mpv.log 实测: [w][fntv_replay] 重新播放：无当前文件)。
--   所以自己记住最后一次成功加载的地址, EOF 后用 loadfile replace 重新起播。
local last_path = nil
mp.observe_property('path', 'string', function(_, v)
    if v and v ~= '' then last_path = v end
end)

-- 核心：重新播放（从头开始）
local function do_replay()
    local cur = mp.get_property('path')
    flash()
    pcall(function() mp.commandv('show-text', '↻ 重新播放', 1500) end)

    if not cur or cur == '' then
        if not last_path then
            msg.warn('重新播放：无当前文件（也无可重载的地址）')
            return
        end
        msg.info('重新播放：EOF 空闲态 → 重新加载 ' .. tostring(last_path))
        -- watch_later 会把续播位置带回来(save-position-on-quit=yes, 实测 reload 后
        -- "Resuming playback" → playback restart @1.1 而非 0), 所以显式 start=+0 压掉它,
        -- 并在 file-loaded 后再归零一次兜底。
        local function zero_once()
            mp.unregister_event(zero_once)
            mp.set_property_bool('pause', false)
            mp.set_property('time-pos', 0)
        end
        mp.register_event('file-loaded', zero_once)
        mp.add_timeout(20, function() pcall(function() mp.unregister_event(zero_once) end) end)
        -- loadfile 的位置参数是 url/flags/index/options(第 4 位是整数 index, 直接塞 options 会报
        -- "The loadfile option must be an integer") → 必须用命名参数形式传 options。
        mp.command_native({ name = 'loadfile', url = last_path, flags = 'replace', options = 'start=+0' })
        return
    end

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
end

mp.register_script_message('do_replay', do_replay)

msg.info('[fntv_replay] 已加载（重新播放按钮）')
