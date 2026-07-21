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


local mp         = require "mp"
local utils      = require "mp.utils"
local msg        = require "mp.msg"

local http_async = {}

-- 内部: JSON 编解码
local function encode_json(tbl)
    local s, err = utils.format_json(tbl)
    if not s then return nil, err end
    return s
end

local function decode_json(str)
    local t, err = utils.parse_json(str)
    if not t then return nil, err end
    return t
end

-- 通用异步 HTTP 请求
-- opts = {
--   url      = "http://...",
--   method   = "GET" | "POST",
--   headers  = { ["Header"]="Value" },
--   data     = string | table,
--   json     = true/false,  -- data 是 table 时是否 JSON encode（默认 true）
-- }
-- callback(result, err) -> result = string
function http_async.request(opts, callback)
    local args = { "curl", "-sS", "--show-error", "-X", opts.method or "GET", opts.url }

    -- headers
    if opts.headers then
        for k, v in pairs(opts.headers) do
            table.insert(args, "-H")
            table.insert(args, string.format("%s: %s", k, v))
        end
    end

    -- body
    if opts.data then
        local body = opts.data
        if type(body) == "table" and (opts.json == nil or opts.json) then
            body = encode_json(body)
            table.insert(args, "-H")
            table.insert(args, "Content-Type: application/json")
        end
        table.insert(args, "--data")
        table.insert(args, body)
    end

    mp.command_native_async({
        name = "subprocess",
        args = args,
        capture_stdout = true,
        capture_stderr = true,
        playback_only = false
    }, function(success, result, err)
        if not callback then return end

        if not success then
            -- 子进程启动/调用失败（mpv 级错误），通常 err 含错误信息
            callback(nil, "subprocess failed: " .. tostring(err))
            return
        end

        -- 到这一步说明子进程确实跑了，检查退出码
        if not result or result.status ~= 0 then
            local code = result and result.status or "nil"
            local se = result and result.stderr or ""
            callback(nil, "curl exit=" .. tostring(code) .. " stderr=" .. tostring(se))
            return
        end

        local stdout = result.stdout or ""

        -- 如果你期望是 JSON，再去 decode；否则直接返回字符串
        if opts and opts.expect_json ~= false then
            local obj, jerr = decode_json(stdout)
            if not obj then
                callback(nil, "json decode failed: " .. tostring(jerr))
                return
            end
            callback(obj, nil)
        else
            callback(stdout, nil)
        end
    end)
end

-- 封装get
function http_async.get(url, headers, callback)
    http_async.request({
        url = url,
        method = "GET",
        headers = headers
    }, callback)
end

-- 封装post
function http_async.post(url, headers, data, json, callback)
    http_async.request({
        url = url,
        method = "POST",
        headers = headers,
        data = data,
        json = json
    }, callback)
end

return http_async
