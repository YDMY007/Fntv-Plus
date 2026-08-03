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

local mp = require('mp')
local msg = require('mp.msg')
local mutils = require('./mutils')
local http_async = require('./http_async')
local opt = require('mp.options')

local api = {}

-- 设置跳过时间点
function api.set_skip_time(play_url, start_time, end_time, callback)
    if not play_url or play_url == "" then
        msg.error("播放地址不能为空")
        return false
    end

    if start_time < 0 or end_time < 0 then
        msg.error("无效的跳过时间点,start:".. start_time .. " end:".. end_time)
        return false
    end

    -- 获取query参数
    local id, query = mutils.extract_id_and_query(play_url)
    if not query or not id then
        msg.error("无法解析播放地址的查询参数:" .. tostring(play_url))
        return false
    end

    local url = "http://127.0.0.1:22346/api/v1/skipinfo?" .. query
    local data = {
        guid = id,
        skipStart = start_time,
        skipEnd = end_time
    }

    http_async.request({
        url = url,
        method = "POST",
        headers = nil,
        data = data,
        json = true
    }, callback)
    
    return true
end

function api.get_skip_time(play_url, callback)
    if not play_url or play_url == "" then
        msg.error("播放地址不能为空")
        return nil
    end

    -- 获取query参数
    local id, query = mutils.extract_id_and_query(play_url)
    if not query or not id then
        msg.error("无法解析播放地址的查询参数:".. tostring(play_url))
        return nil
    end

    local url = "http://127.0.0.1:22346/api/v1/skipinfo/".. id .. "?" .. query

    http_async.request({
        url = url,
        method = "GET",
        headers = nil,
        json = true
    }, callback)

    return true
end

-- 从 theintrodb 兜底获取片头/片尾（当 fnOS 未配置跳过时）
-- tmdb_id 来自 fnOS 的 trim_id（飞牛影视元数据源为 TMDB）
-- 返回结构: { intro=[{start_ms,end_ms}], credits=[{start_ms,end_ms}], ... }（毫秒；null 表示视频头/尾）
function api.get_theintrodb(tmdb_id, season, episode, duration_ms, callback)
    if not tmdb_id or tostring(tmdb_id) == "" or tostring(tmdb_id) == "0" then
        msg.error("theintrodb: 缺少有效 tmdb_id")
        if callback then callback(nil, "no tmdb_id") end
        return false
    end

    -- [lc-338] theintrodb v2 -> v3 迁移（v2 将于 2027-01-18 废弃）。
    -- 端点改为 /v3/media，并尽可能附带 duration_ms 以匹配正确的发行版本。
    local url = "https://api.theintrodb.org/v3/media?tmdb_id=" .. tostring(tmdb_id)
    if season and tonumber(season) then
        url = url .. "&season=" .. tostring(season)
        if episode and tonumber(episode) then
            url = url .. "&episode=" .. tostring(episode)
        end
    end
    if duration_ms and tonumber(duration_ms) and tonumber(duration_ms) > 0 then
        url = url .. "&duration_ms=" .. tostring(math.floor(tonumber(duration_ms)))
    end

    http_async.request({
        url = url,
        method = "GET",
        headers = nil,
        json = true
    }, function(resp, err)
        if callback then callback(resp, err) end
    end)

    return true
end

return api