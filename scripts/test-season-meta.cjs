// 验证 [lc-1176] 季信息兜底链的纯函数部分（stripSeasonSuffix / extractBangumiId / extractTmdbId）。
// 背景：Bangumi 源（trim_id=bg456080）刮削的条目，季级 title 恒空、无 TMDB id，
//   旧代码据此直接判定「无法匹配」。本脚本用真实响应体断言兜底链可用。
const assert = require('assert');
// 渲染进程模块 require('electron')，脚本环境下 stub 掉
const Module = require('module');
const _load = Module._load;
Module._load = function (req) {
  if (req === 'electron') {
    return { ipcRenderer: { on() {}, invoke: () => Promise.resolve(''), send() {} } };
  }
  return _load.apply(this, arguments);
};
const { stripSeasonSuffix, parseCardNum } = require('../dest/preload/plugins/embyWall/detail/epBackfill.js');
const { extractTmdbId, extractBangumiId } = require('../dest/preload/plugins/embyWall/carousel/api.js');

let n = 0;
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg + ' → 实际=' + JSON.stringify(a)); n++; };

// ── stripSeasonSuffix：剥季缀（TMDB 搜索不接受季号）──
eq(stripSeasonSuffix('转学后班上的清纯可爱美少女，竟是小时候玩在一起的哥们儿 第1季'),
  '转学后班上的清纯可爱美少女，竟是小时候玩在一起的哥们儿', '剥中文季缀');
eq(stripSeasonSuffix('XXX Season 2'), 'XXX', '剥 Season N');
eq(stripSeasonSuffix('XXX S2'), 'XXX', '剥 S2');
eq(stripSeasonSuffix('第 1 季'), '', '纯季缀→空（应继续走下一级兜底）');
eq(stripSeasonSuffix(''), '', '空串');
eq(stripSeasonSuffix('葬送的芙莉莲'), '葬送的芙莉莲', '无季缀原样返回');
eq(stripSeasonSuffix('第 12 季'), '', '纯季缀(带空格)也剥干净');

// ── 真实 Bangumi 源响应体（2026-09-17 日志取证）──
const bgSeason = {
  item_guid: 'b0c75735899c4e4a92f922043b1f2c5f',
  trim_id: 'bg456080', is_official: true,
  title: '', overview: '', posters: '/6a/14/bgm_0_19eccbe00ad564e4.webp',
};
eq(extractTmdbId(bgSeason), undefined, 'Bangumi 源拿不到 TMDB id（旧实现失败的根因）');
eq(extractBangumiId(bgSeason), '456080', 'Bangumi subject id 正确解析');
eq(stripSeasonSuffix(bgSeason.title), '', '季 title 为空 → 走父级/DOM 兜底');

// ── TMDB 源响应体（回归保护：不能因为新逻辑而回退）──
const tmSeason = { trim_id: 'tm250008', title: '转学后班上的清纯可爱美少女 第1季' };
eq(extractTmdbId(tmSeason), '250008', 'TMDB 源仍解析正确');
eq(extractBangumiId(tmSeason), undefined, 'TMDB 源不误判为 Bangumi');

// ── [lc-1178] parseCardNum：选集卡文本 → 集号（空壳集的唯一集号来源）──
eq(parseCardNum('8 夏日的回忆碎片'), 8, '真机截图形态: 数字前缀+标题');
eq(parseCardNum('12 两人的约定 本季大结局 0% 评个分吧!'), 12, '带胶囊文本的整串 textContent');
eq(parseCardNum('第 11 集'), 11, '占位标题形态');
eq(parseCardNum('Episode 4'), 4, '英文占位');
eq(parseCardNum('夏日的回忆碎片'), null, '无集号前缀 → null(不瞎猜)');
eq(parseCardNum('3月的狮子'), null, '数字后无空白不入集号(防标题误判)');
eq(parseCardNum(''), null, '空串');

console.log('✅ lc-1176/1178 断言全通过 (' + n + ' 项)');
