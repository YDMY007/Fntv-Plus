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

    local url = "http://127.0.0.1:22345/api/v1/skipinfo?" .. query
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

    local url = "http://127.0.0.1:22345/api/v1/skipinfo/".. id .. "?" .. query

    http_async.request({
        url = url,
        method = "GET",
        headers = nil,
        json = true
    }, callback)

    return true
end

return api