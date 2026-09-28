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

-- [lc-1257] MPV 面板打点同步到 Electron 本地 4 值存储（fire-and-forget，失败不影响主流程）。
-- [lc-1264] 升级为精确 4 值载荷（introStart/outroStart/outroEnd 可缺省=旧版 2 值语义，
--   由 Electron 侧回落换算）；服务端写回由 set_skip_time 完成，这里只补本地
--   （供网页端「标记不准」状态与精确兜底按钮跨端一致）。
function api.sync_manual_local(play_url, intro_end, outro_len, total_duration, intro_start, outro_start, outro_end)
    local id, _ = mutils.extract_id_and_query(play_url)
    if not id then return end
    http_async.request({
        url = "http://127.0.0.1:22347/skip-manual",
        method = "POST",
        data = {
            guid = id,
            introEnd = intro_end or 0,
            outroLen = outro_len or 0,
            totalDuration = total_duration or 0,
            introStart = intro_start or 0,
            outroStart = outro_start or 0,
            outroEnd = outro_end or 0,
        },
        json = true,
    }, function(_resp, err)
        if err then msg.verbose("本地标记同步失败: " .. tostring(err)) end
    end)
end

-- [lc-1264] MPV 面板改提前量 → 同步 Electron 侧 skip-manual 配置（兜底按钮提前量同一套值）。
-- 复用 /skip-manual 端点的 config 载荷形态；失败静默（Electron 侧重启后以自己面板的值为准）。
function api.sync_manual_lead(seconds)
    http_async.request({
        url = "http://127.0.0.1:22347/skip-manual-config",
        method = "POST",
        data = { leadSeconds = seconds or 5 },
        json = true,
    }, function(_resp, err)
        if err then msg.verbose("提前量同步失败: " .. tostring(err)) end
    end)
end

-- [lc-1265] 读取 Electron 本地精确 4 值标记（人工打点，最高优先级）。
--   飞牛服务端只有 2 值（skipStart=片头跳过秒数 / skipEnd=片尾从结尾倒数秒数），
--   还原出的片尾终点恒为「文件末尾」，无法表达「ED 结束但后面还有正片」。
--   本地 skip-manual.json 保留精确区间，MPV 侧经此拉取后优先采用。
--   返回：{ introStart, introEnd, outroStart, outroEnd, scope } 或 { empty = true }
function api.get_manual_local(guid, callback)
    if not guid or guid == "" then
        if callback then callback(nil, "get_manual_local: 缺少 guid") end
        return false
    end
    http_async.request({
        url = "http://127.0.0.1:22347/skip-manual?guid=" .. guid,
        method = "GET",
        headers = nil,
        json = true
    }, function(resp, err)
        if callback then callback(resp, err) end
    end)
    return true
end

-- 设置跳过时间点。
-- ⚠️ [lc-1265] 飞牛语义是「时长」而非「区间端点」：
--   skipStart = 片头从 0 跳过的秒数（= 片头终点）
--   skipEnd   = 片尾从结尾倒数的秒数（= 总时长 − 片尾起点），读回时按 total_dur - skipEnd 还原起点。
--   传「片尾区间长度」当 skipEnd 会被读成「片尾起点更靠后」，每次读回都漂移，
--   故调用方（menu.lua apply_manual_marks）必须传 总时长 − 片尾起点。
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


-- [lc-1059] AniSkip 社区跳过库：按 MAL id + 集号查询 OP/ED 精确区间(绝对秒)。
-- episodeLength 敏感(差 1 秒可能不命中) → 长度阶梯 [d, d+1, d-1, d+2] 逐档尝试。
function api.get_aniskip(mal_id, episode, duration_s, callback)
    if not mal_id or tostring(mal_id) == "" then
        if callback then callback(nil, "aniskip: 缺少 mal_id") end
        return false
    end
    local base = "https://api.aniskip.com/v2/skip-times/" .. tostring(mal_id) .. "/" .. tostring(episode)
        .. "?types%5B%5D=op&types%5B%5D=ed"
    local lens = { 0 }
    if duration_s and tonumber(duration_s) and tonumber(duration_s) > 0 then
        local d = math.floor(tonumber(duration_s))
        lens = { d, d + 1, d - 1, d + 2 }
    end
    local try_idx = 0
    local function try_next()
        try_idx = try_idx + 1
        if try_idx > #lens then
            if callback then callback(nil, "aniskip: 各时长档位均无命中") end
            return
        end
        local url = base .. "&episodeLength=" .. tostring(lens[try_idx])
        http_async.request({
            url = url,
            method = "GET",
            headers = { ["appId"] = "fntv-plus" },
            json = true
        }, function(resp, err)
            if err or not resp then
                if callback then callback(nil, err) end
                return
            end
            if resp.found and resp.results and #resp.results > 0 then
                if callback then callback(resp, nil) end
            else
                try_next()  -- 本档无命中 → 下一档时长
            end
        end)
    end
    try_next()
    return true
end

return api
