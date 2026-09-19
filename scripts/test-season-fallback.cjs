// 验证 [lc-1225] TMDB 季号自动对位 pickFallbackSeason（纯函数，零依赖直测）。
// 背景：飞牛按番剧/Bangumi 季数识别目录（爱书的下克上 2026「领主的养女」= 飞牛「第 4 季」），
//   TMDB tv/91768 只有 S1/S2 —— season/4 404，「补全集信息」全落空。此函数在 404 后对位实际季。
const assert = require('assert');
const { pickFallbackSeason } = require('../dest/main/common/tmdbSeasonResolve.js');

let n = 0;
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg + ' → 实际=' + JSON.stringify(a)); n++; };

// ── 实锤案例：tv/91768 爱书的下克上（S1 2019 / S2 2026 在播）──
const honzuki = [
  { season_number: 1, air_date: '2019-10-02', episode_count: 26, name: '第一季' },
  { season_number: 2, air_date: '2026-04-04', episode_count: 22, name: '领主的养女' },
];
eq(pickFallbackSeason(honzuki, 4, 22), 2, '集数 22 唯一命中 S2');
eq(pickFallbackSeason(honzuki, 4, 24), 2, '集数对不上(24≠22) → 最近播出季仍 S2');
eq(pickFallbackSeason(honzuki, 4), 2, '无集数线索 → 最近播出季 S2');
eq(pickFallbackSeason(honzuki, 1), 2, '函数不判「请求季是否存在」(404 后才被调用) — 契约仅选季');

// ── 集数歧义时弃用集数通道 ──
eq(pickFallbackSeason([
  { season_number: 1, air_date: '2019-01-01', episode_count: 12 },
  { season_number: 2, air_date: '2021-01-01', episode_count: 12 },
], 5, 12), 2, '两季同集数 → 歧义弃用，落最近播出');

// ── 未来季不参与「最近播出」（防抓到未播占位季）──
eq(pickFallbackSeason([
  { season_number: 1, air_date: '2019-01-01', episode_count: 26 },
  { season_number: 2, air_date: '2099-01-01', episode_count: 24 },
], 3), 1, 'S2 未播 → 只能对位已播的 S1');

// ── 全部未播 / 缺日期 → 取最大季号 ──
eq(pickFallbackSeason([
  { season_number: 1, air_date: '', episode_count: 10 },
  { season_number: 2, air_date: '2099-01-01', episode_count: 10 },
], 3), 2, '全未播 → 最大季号');
eq(pickFallbackSeason([
  { season_number: 1, episode_count: 10 },
  { season_number: 3, episode_count: 10 },
], 5), 3, '全缺日期 → 最大季号');

// ── 同日并列取更大季号 ──
eq(pickFallbackSeason([
  { season_number: 1, air_date: '2026-04-04', episode_count: 12 },
  { season_number: 2, air_date: '2026-04-04', episode_count: 12 },
], 9), 2, '同日并列 → 更大季号');

// ── 特殊季(0)与空季(episode_count=0)剔除 ──
eq(pickFallbackSeason([
  { season_number: 0, air_date: '2026-01-01', episode_count: 5 },
  { season_number: 1, air_date: '2019-01-01', episode_count: 26 },
  { season_number: 2, air_date: '2026-04-04', episode_count: 0 },
], 2), 1, 'Specials 不参选；空占位季不参选');

// ── 无候选 → null（调用方维持原 404 语义，绝不瞎配）──
eq(pickFallbackSeason([], 4, 22), null, '空列表');
eq(pickFallbackSeason([{ season_number: 0, air_date: '2026-01-01', episode_count: 5 }], 4), null, '仅 Specials');
eq(pickFallbackSeason([{ season_number: 1, air_date: '2019-01-01', episode_count: 0 }], 4), null, '仅空占位季');
eq(pickFallbackSeason(null, 4), null, 'null 入参');
eq(pickFallbackSeason(undefined, 4), null, 'undefined 入参');

console.log('✅ lc-1225 断言全通过 (' + n + ' 项)');
