// scripts/verify-mpv-danmaku-original.cjs —— MPV 弹幕「回退到原版排版 + 只留密度开关」的静态守卫
//
// 背景（lc-1335）：lc-1286~lc-1303 一串改动把弹幕排版换成了「轨道池 + 接力式分配」
// （一条轨道上并排塞多条、靠追及判定避让），同屏条数翻了好几倍，但同轨内互相追及穿插，
// 用户观感就是「抖动」，并明确要求「恢复成原来的那样，只保留那个弹幕稀疏调节」。
// 于是：parse.lua 回退到 lc-1285（轨道独占模型，= 原版行为），保留密度开关（改写 scrolltime）。
//
// 本脚本零 CPU（纯文本断言），防三类回归：
//   ① 接力/轨道池代码偷偷回来（排版一变，抖动就回来）
//   ② 密度开关失效（菜单/conf/排版三处必须仍然对得上）
//   ③ 渲染步进退回「÷2」（那是历史上一抽一抽的直接原因：60Hz 屏上弹幕只走 30fps）
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const D = 'third_party/fntv-mpv/portable_config';
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const parseLua = read(`${D}/scripts/uosc_danmaku/modules/parse.lua`);
const renderLua = read(`${D}/scripts/uosc_danmaku/modules/render.lua`);
const menuLua = read(`${D}/scripts/uosc_danmaku/modules/menu.lua`);
const conf = read(`${D}/script-opts/uosc_danmaku.conf`);

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
};

console.log('\n[1] 排版回到原版：轨道独占（一条轨道一条弹幕，不接力）');
{
  ok(/function get_position_y\(font_size, appear_time, text_length, resolution_x, roll_time, array\)/.test(parseLua),
    'get_position_y 仍是原版签名（排版入口未换实现）');
  ok(!/array:occupy\(/.test(parseLua) && !/接力/.test(parseLua) && !/轨道池/.test(parseLua),
    '没有「轨道池 / 接力式分配」残留（同轨追及穿插 = 用户说的抖动）');
  ok(!/DENSITY_PRESETS|dense_danmaku/.test(parseLua),
    '密度档位不进排版层（只由菜单改写 scrolltime，排版照常读它）');
}

console.log('\n[2] 弹幕展示占比（手动输入 0-100）四处对齐');
{
  ok(/local function apply_display_percent\(list\)/.test(parseLua) && /options\.density_percent/.test(parseLua),
    'parse.lua 有占比过滤器，且读 options.density_percent');
  ok(/stable_sample_key/.test(parseLua),
    '按「文本+时间」稳定哈希采样（同一批弹幕每次重载保留同一批，不是随机抽）');
  ok(/apply_display_percent\(all_danmaku\)/.test(parseLua.split('function parse_danmaku_files')[1] || ''),
    'parse_danmaku_files 里真的调用了它（不是死代码）');
  ok(/^density_percent=/m.test(conf) && !/^dense_danmaku=/m.test(conf),
    'conf 里是 density_percent（旧的 dense_danmaku 已清掉）');
  ok(/density_percent = 100,/.test(read(D + '/scripts/uosc_danmaku/modules/options.lua')),
    'options 默认 100（= 全部照旧）');
  ok(/register_script_message\("set-danmaku-density"/.test(menuLua) && /input\.get\(\{/.test(menuLua),
    '菜单项走输入框（手动输入），不是两档开关');
  ok(/STYLE_PERSIST_KEYS = \{[^}]*"density_percent"/.test(menuLua),
    '落盘清单含 density_percent（改完跨会话生效）');
  ok(!/DENSITY_PRESETS|dense_danmaku|toggle_danmaku_density/.test(menuLua),
    '两档开关残留（preset 表 / dense_danmaku / 旧函数）已清干净');
  ok(/function reload_block_types/.test(parseLua) && /reload_block_types\(\)/.test(parseLua.split('function parse_danmaku_files')[1] || ''),
    '屏蔽类型（Ctrl+K）运行时刷新仍在，且每次加载前重读');
}


console.log('\n[2b] 回退后的 parse.lua 不引用任何已被删除的 helper（lc-1339 事故）');
{
  const utilsLua = read(D + '/scripts/uosc_danmaku/modules/utils.lua');
  const NL = String.fromCharCode(10);
  const stripLua = (src) => src.split(NL).filter((l) => l.trim().indexOf('--') !== 0).join(NL);
  const utilsCode = stripLua(utilsLua);
  const parseCode = stripLua(parseLua);
  // lc-1300 从 utils.lua 删掉的函数：回退 parse.lua 时把调用带回来，运行到那里就会
  // attempt to call a nil value → ASS 写不出来 → 弹幕整条消失（真机就是这么坏的）。
  for (const fn of ['adaptive_fontsize', 'get_font_scale', 'get_display_render_height']) {
  const defined = utilsCode.indexOf('function ' + fn) >= 0;
  const called = parseCode.indexOf(fn + '(') >= 0;
    ok(!called || defined,
      'parse.lua 没有调用已删除的 ' + fn + '（utils.lua 里定义：' + (defined ? '有' : '无') + '）',
      '调用点会 attempt to call a nil value → 弹幕整条消失');
  }
}


console.log('\n[3] 渲染步进：每个显示帧一次（不再「÷2」）');
{
  ok(/local interval = 1 \/ value/.test(renderLua),
    '按 display-fps 重建定时器 = 每显示帧一次');
  // 只查代码，剥掉注释（历史注释里会解释「原先 ÷2」这件事，别把它当实现）
  const codeAfterFps = (renderLua.split('display-fps')[1] || '')
    .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  ok(!/value\s*\/\s*2|\/\s*2\s*$/.test(codeAfterFps),
    '没有「显示帧率 ÷2」的步进（60Hz 屏上弹幕只走 30fps = 一抽一抽）');
  ok(/local INTERVAL = options\.vf_fps and 0\.01 or/.test(renderLua),
    'INTERVAL 兜底仍与 vf_fps 联动');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);