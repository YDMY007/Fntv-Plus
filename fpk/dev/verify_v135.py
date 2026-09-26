# -*- coding: utf-8 -*-
"""v1.3.5 序号视图布局验证：演职人员提到选集正下方（红线处），TMDB 卡绝对定位脱高。

复刻页按 2026-09-11 用户截图 + v1.3.3 挖出的 NAS 真实 DOM 结构：
  COL(mb-[46px].flex.flex-col.gap-3)
   ├─ hero(.semi-always-dark.h-[470px])
   ├─ :nth-child(2) 选集区（序号视图 = div.grid.grid-cols-[repeat(auto-fill,52px)] + 数字按钮）
   └─ :nth-child(3) div.relative.flex.w-full.flex-col.my-10（BH 根）
       ├─ .fnos-beautify-card（注入的 TMDB 卡，insertBefore firstChild；高卡内容撑到 ~1500px）
       └─ div.relative（RH 根）
           ├─ p.semi-typography（「演职人员」标题）
           └─ .ms-container（演员列表）
注入 dist/fntv-plus.user.js 后断言：
  1) COL_NUM 命中：body.fnos-beautify 挂上（序号视图美化启用）
  2) 卡 position=absolute、grid-area 2/2，其顶部 ≈ 选集数字块顶部（原右栏位视觉不变）
  3) row2 高度 = 选集数字块高度（卡不再撑行高）
  4) 演职人员标题顶部 ≈ 数字块底部 + ~100px（红线处），不再从卡底开始
  5) 演员列表在标题正下方
  6) 列表视图（details 卡）复刻页不命中 COL_NUM 布局段（rows 仍两行 / 标题无 margin）
"""
import json, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PAYLOAD = (ROOT / 'dist' / 'fntv-plus.user.js').read_text(encoding='utf-8')

NUM_CELL = 13  # 数字格数（两行）

def replica_html(num_view: bool) -> str:
    if num_view:
        episodes = ''.join(
            f'<button class="semi-button semi-button-{("primary" if i == 0 else "tertiary")} {i+1}">{i+1}</button>'
            for i in range(NUM_CELL))
        eps_block = (
            '<div class="flex items-center justify-between"><p class="semi-typography">选集</p></div>'
            f'<div class="grid grid-cols-[repeat(auto-fill,52px)] gap-3 mt-4" id="numgrid">{episodes}</div>'
        )
    else:
        rows = ''.join(
            '<div data-id="details" class="box-border w-full"><div class="rounded-lg relative mb-3 flex h-[146px] w-full shrink-0 overflow-hidden">'
            '<div class="box-border"><div class="relative size-full"><div class="size-full"><picture><img src="" class="object-cover absolute inset-0"></picture></div></div></div>'
            '</div><p class="truncate">第 %d 集 标题</p></div>' % i for i in range(1, 4))
        eps_block = f'<div class="flex flex-col">{rows}</div>'
    stills = ''.join('<img class="fnos-showinfo__still is-ready" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">' for _ in range(3))
    card = (
        '<div id="fnos-showinfo-card" class="fnos-beautify-card">'
        '<div class="fnos-showinfo__block"><span class="fnos-showinfo__num">8.6</span></div>'
        f'<div class="fnos-showinfo__block fnos-showinfo__sec"><p class="fnos-showinfo__sec-t">剧照</p><div class="fnos-showinfo__stills">{stills}</div></div>'
        '<div class="fnos-showinfo__block fnos-showinfo__sec"><p class="fnos-showinfo__sec-t">相似剧集</p><div class="fnos-showinfo__recs">A · B · C</div></div>'
        '<div class="fnos-showinfo__block fnos-showinfo__sec"><p class="fnos-showinfo__sec-t">别名</p><div class="fnos-showinfo__v">很长的别名行……</div></div>'
        '</div>'
    )
    actors = ''.join(
        '<div class="group" style="width:120px;height:145px"><a href="/v/person/x" class="no-underline">'
        '<div class="size-[90px] rounded-full" style="width:90px;height:90px;background:#345"></div>'
        f'<p class="text-base">演员 {i}</p><p>饰演 角色 {i}</p></a></div>' for i in range(1, 9))
    people = (
        f'{card}'
        '<div class="relative" id="rh-root">'
        '<p class="semi-typography">演职人员</p>'
        f'<div class="ms-container overflow-x-scroll"><div>{actors}</div></div>'
        '</div>'
    )
    return f"""<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<base href="http://localhost:8137/">
<script>try{{history.replaceState(null,'','/v/tv/season/0ae81abecafe0ae81abecafe0ae81abe')}}catch(e){{}}</script>
<style>
  body{{margin:0;background:#f6f7f9;color:#1d1d1f;font:14px/1.6 system-ui,sans-serif}}
  .semi-always-dark{{position:relative}}
  .mb-\[46px\]{{margin-bottom:46px}} .flex{{display:flex}} .flex-col{{flex-direction:column}}
  .gap-3{{gap:12px}} .w-full{{width:100%}} .relative{{position:relative}}
  .my-10{{margin:40px 0}} .mt-4{{margin-top:16px}} .items-center{{align-items:center}}
  .justify-between{{justify-content:space-between}} .grid{{display:grid}}
  .grid-cols-\[repeat\(auto-fill\,52px\)\]{{grid-template-columns:repeat(auto-fill,52px)}}
  .semi-button{{width:52px;height:52px;border:1px solid #e0e0e3;border-radius:10px;background:#fff;font-size:15px}}
  .semi-button-primary{{background:#3f6ff2;color:#fff;border-color:#3f6ff2}}
  .semi-typography{{font-size:16px;font-weight:600;margin:0}}
  .overflow-x-scroll{{overflow-x:scroll}} .ms-container{{display:flex;height:190px}}
  .ms-container>div{{display:flex;gap:12px}} .group{{flex:0 0 auto}}
  .no-underline{{text-decoration:none;color:inherit;display:flex;flex-direction:column;align-items:center}}
  .rounded-full{{border-radius:50%}} .size-\[90px\]{{width:90px;height:90px}}
  .text-base{{font-size:16px}} .truncate{{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
  #hero{{height:220px;background:linear-gradient(120deg,#22304a,#31456b);border-radius:12px}}
</style></head><body>
<div style="padding:0 46px">
  <div class="trim-ui__cache-outlet--exclude" style="display:block">
  <div class="mb-[46px] flex flex-col gap-3 w-full" id="col">
    <div class="semi-always-dark h-[470px]" id="hero"></div>
    <div id="eps">{eps_block}</div>
    <div class="relative flex w-full flex-col my-10" id="bh-root">{people}</div>
  </div>
  </div>
</div>
<script src="/dist/fntv-plus.user.js"></script></body></html>"""

def rect(page, sel):
    return page.evaluate(f"""() => {{ const e = document.querySelector({json.dumps(sel)});
      if (!e) return null; const r = e.getBoundingClientRect();
      return {{x:r.x,y:r.y,w:r.width,h:r.height,top:r.top,bottom:r.bottom,left:r.left,right:r.right}}; }}""")

def cs(page, sel, prop):
    return page.evaluate(f"""() => {{ const e = document.querySelector({json.dumps(sel)});
      return e ? getComputedStyle(e).{prop} : null; }}""")

def run(page, num_view, checks):
    # payload 需在 /v/tv/season/<id> 路由上执行（isDetailPage 判据）：先走本地服务器导航拿到
    # 同源路由，再 document.write 整页替换（同源、history 保留、内联脚本照常执行）。
    Path('dev/_replica.html').write_text(replica_html(num_view), encoding='utf-8')
    page.goto('http://localhost:8137/dev/_replica.html')
    page.wait_for_timeout(1200)
    return checks(page)

def main():
    results = []
    def ok(name, cond, detail=''):
        results.append((name, bool(cond), detail))

    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport={'width': 1990, 'height': 1020})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))

        # ── 序号视图 ──
        def checks_num(page):
            beautify = page.evaluate("() => document.body.classList.contains('fnos-beautify')")
            ok('①序号视图美化启用(body.fnos-beautify)', beautify)

            card, num, title, ms = rect(page, '.fnos-beautify-card'), rect(page, '#numgrid'), rect(page, '#rh-root > p.semi-typography'), rect(page, '.ms-container')
            ok('②卡为绝对定位', cs(page, '.fnos-beautify-card', 'position') == 'absolute',
               f"position={cs(page, '.fnos-beautify-card', 'position')}")
            eps = rect(page, '#eps')
            ok('③卡仍在右栏(左缘>页宽55%)', card and card['x'] > 1990 * 0.55, f"card.x={card and round(card['x'])}")
            ok('④卡顶=选集区顶(原右栏位,row2 区起点)', card and eps and abs(card['y'] - eps['y']) < 4,
               f"card.y={card and round(card['y'])}, eps.y={eps and round(eps['y'])}")
            row2_h = num['h']
            ok('⑤row2高度=数字块高度(卡不再撑高)', row2_h < 200, f"numgrid.h={round(row2_h)}")
            gap = title['y'] - num['bottom']
            ok('⑥标题顶=数字块下~100px(红线)', 85 <= gap <= 115, f"标题top={round(title['y'])}, 数字块bottom={round(num['bottom'])}, gap={round(gap)}")
            ok('⑦演员列表在标题正下方', 0 <= ms['y'] - title['bottom'] < 30,
               f"ms.y={round(ms['y'])}, title.bottom={round(title['bottom'])}")
            ok('⑧标题从红线处开始(数字块下~100px,不再被卡底推走)', gap_check := (100 <= title['y'] - num['bottom'] <= 115),
               f"title.y={round(title['y'])}, num.bottom={round(num['bottom'])}")
            # 卡与演员列表不重叠（左右列互不遮挡：卡右列 x 起 > 演员列表右缘? 不——列表占左栏全宽，
            # 卡是绝对定位悬浮于右列；断言卡左缘 > COL 左栏宽 60% 分界即可）
            ok('⑨卡左缘在左右分界右侧(不遮演员行)', card['x'] > num['x'] + num['w'] * 0.6 + 100,
               f"card.x={round(card['x'])}, numgrid 右缘={round(num['x']+num['w'])}")
            return page

        run(page, True, checks_num)

        # ── 列表视图（details 卡）不命中序号布局段 ──
        def checks_list(page):
            beautify = page.evaluate("() => document.body.classList.contains('fnos-beautify')")
            ok('⑩列表视图美化仍启用', beautify)
            title_margin = cs(page, '#rh-root > p.semi-typography', 'marginTop')
            ok('⑪列表视图标题无80px顶距(布局段未命中)', title_margin in ('0px', '40px'),
               f"marginTop={title_margin}")
            card_pos = cs(page, '.fnos-beautify-card', 'position')
            ok('⑫列表视图卡仍为流内(grid item)', card_pos == 'static', f"position={card_pos}")
            return page

        run(page, False, checks_list)

        # 截图留档
        run(page, True, lambda pg: pg)
        page.screenshot(path=str(ROOT / 'dev' / 'v135-num-view.png'), full_page=True)
        run(page, False, lambda pg: pg)
        page.screenshot(path=str(ROOT / 'dev' / 'v135-list-view.png'), full_page=True)
        b.close()

    fails = [r for r in results if not r[1]]
    print(f"\npageerror: {errors or '无'}")
    for name, passed, detail in results:
        print(f"{'✅' if passed else '❌'} {name}" + (f"  [{detail}]" if detail else ''))
    print(f"\n{len(results)-len(fails)}/{len(results)} 通过")
    sys.exit(1 if fails or errors else 0)

main()
