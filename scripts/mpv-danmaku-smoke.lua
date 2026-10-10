-- scripts/mpv-danmaku-smoke.lua —— MPV 弹幕生成链冒烟（由 scripts/verify-mpv-danmaku-render.cjs 用 mpv 拉起）
--
-- 为什么需要它（lc-1339 教训）：lc-1335 把 parse.lua 整体回退到旧版时，把一处
-- `adaptive_fontsize()` 调用也带回来了 —— 而该函数已被 lc-1300 从 utils.lua 删掉，
-- 于是运行到那里直接 `attempt to call global 'adaptive_fontsize' (a nil value)`，
-- ASS 写不出来、弹幕整条消失（用户报「mpv端字幕不显示」）。纯静态 grep 抓不到这类
-- 「跨文件接口对不上」，只有真跑一遍生成链才看得见 —— 所以留成常驻冒烟。
--
-- 覆盖：模块加载 → XML 解析 → 轨道排版 → ASS 落盘 → 标签齐备 → density_percent 生效。
local function log(...)
    local parts = {}
    for _, v in ipairs({ ... }) do parts[#parts + 1] = tostring(v) end
    mp.msg.info('HARNESS ' .. table.concat(parts, ' '))
end

-- parse.lua 用 require('dicts/s2t_chars')，模块搜索路径得含脚本自身目录（生产里 main.lua 天然满足）
local scriptdir = mp.command_native({ 'expand-path', '~~/scripts/uosc_danmaku' })
package.path = scriptdir .. '/?.lua;' .. scriptdir .. '/?/init.lua;' .. scriptdir .. '/modules/?.lua;' .. package.path
local root = scriptdir .. '/modules'

-- main.lua 提供的全局（模块只在运行时用；生产里由 main.lua 定义）
function get_delay_for_time(_delay_segments, _time) return 0 end

dofile(root .. '/options.lua')
dofile(root .. '/utils.lua')
dofile(root .. '/parse.lua')
log('modules-loaded density_percent=' .. tostring(options.density_percent) ..
    ' scrolltime=' .. tostring(options.scrolltime))

local dir = os.getenv('TEMP') or os.getenv('TMP') or '.'
local xml = dir .. '/fntv-danmaku-smoke.xml'
local ass = dir .. '/fntv-danmaku-smoke.ass'

local f = io.open(xml, 'w')
f:write('<?xml version="1.0" encoding="UTF-8"?><i>')
for i = 1, 20 do
    f:write(string.format('<d p="%.1f,1,25,16777215,0,0,0,0">滚动弹幕 %d</d>', i * 0.5, i))
end
f:write('<d p="3.0,5,25,16711680,0,0,0,0">顶部弹幕</d>')
f:write('<d p="4.0,4,25,16711680,0,0,0,0">底部弹幕</d>')
f:write('</i>')
f:close()

convert_danmaku_format({ xml }, ass, {})

local function count_events(path)
    local h = io.open(path, 'r')
    if not h then return -1, 0 end
    local text = h:read('*a')
    h:close()
    local n = 0
    for _ in text:gmatch('\nDialogue:') do n = n + 1 end
    return n, #text
end

local n100, size100 = count_events(ass)
log('ass events=' .. n100 .. ' bytes=' .. size100)

local h = io.open(ass, 'r')
local has_move, has_pos = false, false
if h then
    local t = h:read('*a')
    h:close()
    has_move = t:find('\\move', 1, true) ~= nil
    has_pos = t:find('\\pos', 1, true) ~= nil
end
log('tags move=' .. tostring(has_move) .. ' pos=' .. tostring(has_pos))

-- 占比 50% 应约减半（lc-1336）
options.density_percent = 50
local ass50 = dir .. '/fntv-danmaku-smoke-50.ass'
convert_danmaku_format({ xml }, ass50, {})
local n50 = count_events(ass50)
log('density50 events=' .. n50)

os.remove(xml)
os.remove(ass)
os.remove(ass50)
mp.command('quit')