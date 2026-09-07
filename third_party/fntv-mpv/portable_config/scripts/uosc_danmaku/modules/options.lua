local opt = require("mp.options")

-- 选项
options = {
    -- 指定弹幕服务器地址，自定义服务需兼容 dandanplay 的 api
    api_server = "https://api.dandanplay.net",
    -- 指定 b 站和爱腾优的弹幕获取的兜底服务器地址，主要用于获取非动画弹幕
    -- 服务器可以自托管：https://github.com/lyz05/danmaku
    fallback_server = "https://fc.lyz05.cn",
    -- 设置 tmdb 的 API Key，用于获取非动画条目的中文信息(当搜索内容非中文时)
    -- 可以在 https://www.themoviedb.org 注册后去个人账号设置界面获取
    -- 注意：自定义此参数时还需要对获取到的 API Key 进行 base64 编码
    tmdb_api_key = "NmJmYjIxOTZkNzIyN2UyMTIzMGM3Y2YzZjQ4MDNkZGM=",
    load_more_danmaku = false,
    auto_load = false,
    autoload_local_danmaku = false,
    -- ⚠️ 网络流（fnOS 串流）自动跑弹弹play 匹配的总开关。
    -- 默认 true 与提交态 uosc_danmaku.conf 的 autoload_for_url=yes 意图一致。
    -- 应用层从不写此键（只写在 conf 里），故若某份 conf（如标准模式 AppData/Roaming/mpv
    -- 那份，被 lc-308 的 writeBiliSearchEnabled 重写时未带此行）缺失该键，会回落到默认。
    -- 若默认设 false，则这些 conf 下弹弹play 对网络流静默不自动触发（表现「直接不匹配、无任何反馈」）。
    -- 故此处默认必须 true，确保任何读取路径下弹弹play 都自动跑（lc-312 修复）。
    autoload_for_url = true,
    -- 自动补源：弹弹play 匹配成功后 / 文件名解析到番名后，自动去搜 B站对应集弹幕并叠加显示。
    -- 默认开启，与 bili_search_enabled（手动搜索门控）保持一致（两者由设置面板同开同关），
    -- 避免「开关开着却永远看不到 B站 弹幕」的静默陷阱；用户仍可在设置面板关闭。
    auto_load_extra = true,
    -- B站弹幕搜索总开关（由应用设置面板写入 conf；手动搜索门控，与 auto_load_extra 同开同关）
    bili_search_enabled = true,
    -- [lc-1101] 自建弹幕接口（danmu_api，多平台聚合）开关，由应用设置面板
    -- 「弹幕设置→自建弹幕接口」写入 script-opts/uosc_danmaku.conf。
    -- 这里只当【Lua 侧闸门】用：置 true 时即使 B站搜索（auto_load_extra）被关掉，
    -- 自动补源仍会去请求本地 shim，让主进程里的「优选源」有机会命中；
    -- 真正的服务地址由主进程从 config.json 读取，Lua 不直接发这个请求。
    danmu_api_enabled = false,
    -- B站弹幕聚合阈值（由应用设置面板写入 conf）。单个视频弹幕数 < 此值时，
    -- 自动合并多个同类候选（时间轴对齐的单集源）的弹幕，提升弹幕密度。
    -- 设为 0 或负数可禁用聚合（只取最佳单源）。默认 1500（单个视频弹幕>=1500 直接用单源，否则合并）。
    aggregate_threshold = 1500,
    -- [lc-1018] 弹弹play 开放 API 自定义凭证（在弹弹play 开放平台注册应用后获得 AppId + Secret）。
    -- 两项都非空才启用自定义签名；留空=使用脚本内置的共享凭证——该共享凭证已被官方接口
    -- 整体 403 拒绝（2026-09-05 实测，表现为搜索/弹幕恒返回"无数据"），留空仅作向后兼容保留。
    -- 由应用设置面板「弹幕设置→弹弹play 凭证」写入 script-opts/uosc_danmaku.conf。
    dandanplay_app_id = "",
    dandanplay_app_secret = "",
    save_danmaku = false,
    user_agent = "mpv_danmaku/1.0",
    proxy = "",
    -- 使用 fps 视频滤镜，大幅提升弹幕平滑度。默认禁用
    vf_fps = false,
    -- 设置要使用的 fps 滤镜参数
    fps = "60/1.001",
    -- 指定合并重复弹幕的时间间隔的容差值，单位为秒。默认值: -1，表示禁用
    merge_tolerance = -1,
    -- 指定弹幕关联历史记录文件的路径，支持绝对路径和相对路径
    history_path = "~~/danmaku-history.json",
    open_search_danmaku_menu_key = "Ctrl+d",
    show_danmaku_keyboard_key = "j",
    -- 中文简繁转换。0-不转换，1-转换为简体，2-转换为繁体
    chConvert = 0,
    --滚动弹幕的显示时间
    scrolltime = 15,
    --固定弹幕的显示时间
    fixtime = 5,
    --字体
    fontname = "sans-serif",
    --字体大小 
    fontsize = 50,
    --字体阴影
    shadow = 0,
    --字体粗体
    bold = true,
    -- 透明度：0（完全透明）到 1（不透明）
    opacity = 0.7,
    --全部弹幕的显示范围(0.0-1.0)
    displayarea = 0.85,
    --描边 0-4
    outline = 1.0,
    -- 限制屏幕中同时显示的最大弹幕数量，0 表示不限制
    max_screen_danmaku = 0,
    --指定弹幕屏蔽词文件路径(black.txt)，支持绝对路径和相对路径。文件内容以换行分隔
    --支持 lua 的正则表达式写法
    blacklist_path = "",
    --指定脚本相关消息显示的消息的对齐方式
    message_anlignment = 7,
    --指定脚本相关消息显示的消息的x轴坐标
    message_x = 30,
    --指定脚本相关消息显示的消息的y轴坐标
    message_y = 30,
    -- 自定义标题解析中的额外替换规则，内容格式为 JSON 字符串，替换模式为 lua 的 string.gsub 函数
    --! 注意：由于 mpv 的 lua 版本限制，自定义规则只支持形如 %n 的捕获组写法，即示例用法，不支持直接替换字符的写法
    title_replace = [[
       [{ 
           "rules": [{ "^〔(.-)〕": "%1"},{ "^.*《(.-)》": "%1" }],
       }]
    ]],
    -- 指定哈希匹配中需忽略的共享盘（挂载盘）的路径/目录。支持绝对路径和相对路径，多个路径用逗号分隔
    -- 示例：["X:", "Z:", "F:/Download/", "Download"]
    excluded_path = [[
        []
    ]],
}

opt.read_options(options, mp.get_script_name(), function() end)
