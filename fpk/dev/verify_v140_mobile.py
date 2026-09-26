# -*- coding: utf-8 -*-
"""v1.4.0 手机网页适配验证:
  A) 详情页 390x844 触屏视口: 两栏→单列(选集/卡/演职人员纵向堆叠,序号视图卡回流 row3)
  B) 桌面 1990x1020 不回归(两栏保持,v1.3.5 12 项仍过 — 由 verify_v135.py 单独跑)
  C) 播放页窄屏: 弹幕按钮点按 toggle 开/关面板,面板不溢出视口
"""
import json, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PAYLOAD = (ROOT / 'dist' / 'fntv-plus.user.js').read_text(encoding='utf-8')
GUID = '0ae81abecafe0ae81abecafe0ae81abe'

def detail_html(num_view: bool) -> str:
    if num_view:
        episodes = ''.join(
            f'<button class="semi-button semi-button-{("primary" if i == 0 else "tertiary")}">{i+1}</button>'
            for i in range(13))
        eps_block = ('<div class="flex items-center justify-between"><p class="semi-typography">选集</p></div>'
                     f'<div class="grid grid-cols-[repeat(auto-fill,52px)] gap-3 mt-4" id="numgrid">{episodes}</div>')
    else:
        rows = ''.join(
            '<div data-id="details" class="box-border w-full"><div class="rounded-lg relative mb-3 flex h-[146px] w-full shrink-0 overflow-hidden"></div>'
            f'<p class="truncate">第 {i} 集</p></div>' for i in range(1, 4))
        eps_block = f'<div class="flex flex-col">{rows}</div>'
    card = ('<div id="fnos-showinfo-card" class="fnos-beautify-card">'
            '<div class="fnos-showinfo__block"><span class="fnos-showinfo__num">8.6</span></div>'
            '<div class="fnos-showinfo__block fnos-showinfo__sec"><p class="fnos-showinfo__sec-t">别名</p><div class="fnos-showinfo__v">很长的别名行……</div></div></div>')
    actors = ''.join(
        '<div class="group" style="width:120px;height:145px"><a href="/v/person/x" class="no-underline">'
        '<div class="size-[90px] rounded-full" style="width:90px;height:90px;background:#345"></div>'
        f'<p class="text-base">演员 {i}</p><p>角色 {i}</p></a></div>' for i in range(1, 9))
    people = (f'{card}<div class="relative" id="rh-root"><p class="semi-typography">演职人员</p>'
              f'<div class="ms-container overflow-x-scroll"><div>{actors}</div></div></div>')
    return f"""<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<script>try{{history.replaceState(null,'','/v/tv/season/{GUID}')}}catch(e){{}}</script>
<style>
  body{{margin:0;background:#f6f7f9;color:#1d1d1f;font:14px/1.6 system-ui,sans-serif}}
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
  #hero{{height:180px;background:linear-gradient(120deg,#22304a,#31456b);border-radius:12px}}
</style></head><body>
<div style="padding:0 16px">
  <div class="trim-ui__cache-outlet--exclude">
  <div class="mb-[46px] flex flex-col gap-3 w-full" id="col">
    <div class="semi-always-dark h-[470px]" id="hero"></div>
    <div id="eps">{eps_block}</div>
    <div class="relative flex w-full flex-col my-10" id="bh-root">{people}</div>
  </div>
  </div>
</div>
<script src="/dist/fntv-plus.user.js"></script></body></html>"""

def player_html() -> str:
    return f"""<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<script>try{{history.replaceState(null,'','/v/tv/episode/{GUID}')}}catch(e){{}}</script>
<style>
  body{{margin:0;background:#000;color:#fff;font:14px/1.6 system-ui,sans-serif}}
  .xgplayer{{position:relative;width:100vw;height:60vh;background:#111}}
  xg-controls{{position:absolute;left:0;right:0;bottom:0;height:48px;display:flex;align-items:center;
    justify-content:space-between;padding:0 12px;background:rgba(0,0,0,.55);z-index:20}}
  xg-right-grid{{display:flex;align-items:center;gap:16px}}
  .plugin-placeholder{{height:100%;display:block}}
  video{{width:100%;height:100%;background:#222}}
</style></head><body>
<div class="xgplayer xgplayer-is-initialized" id="player">
  <video src="" controls playsinline></video>
  <xg-controls class="xgplayer-controls"><div style="width:80px">倍速</div><xg-right-grid id="rightgrid"><div class="plugin-placeholder">原画</div></xg-right-grid></xg-controls>
</div>
<script src="/dist/fntv-plus.user.js"></script></body></html>"""

results = []
def ok(name, cond, detail=''):
    results.append((name, bool(cond), detail))

def rect(page, sel):
    return page.evaluate(f"""() => {{ const e = document.querySelector({json.dumps(sel)});
      if (!e) return null; const r = e.getBoundingClientRect();
      return {{x:r.x,y:r.y,w:r.width,h:r.height,top:r.top,bottom:r.bottom,left:r.left,right:r.right}}; }}""")

def open_replica(page, html, viewport):
    page.set_viewport_size(viewport)
    Path('dev/_replica_v140.html').write_text(html, encoding='utf-8')
    page.goto('http://localhost:8137/dev/_replica_v140.html')
    page.wait_for_timeout(1300)

def main():
    with sync_playwright() as p:
        b = p.chromium.launch()
        # ── A. 手机视口详情页 ──
        page = b.new_page(viewport={'width': 390, 'height': 844}, has_touch=True,
                          is_mobile=True)
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))

        open_replica(page, detail_html(True), {'width': 390, 'height': 844})
        ok('A1 美化启用', page.evaluate("() => document.body.classList.contains('fnos-beautify')"))
        # ⚠ Chromium computed 序列化怪癖: minmax(0,1fr) 单列会返回 "358px 0px" 两个 used 值,
        # 不能按 split 数列数。真判据: 流内子元素横向对齐(同一 x)即单列。
        # 序号视图下 #bh-root contents 化 → rect 全 0 (x=0), 豁免后判流内子元素
        kidxs = page.evaluate("""() => [...document.getElementById('col').children]
            .map(k => k.getBoundingClientRect())
            .filter(r => r.width > 2)
            .map(r => Math.round(r.x))""")
        ok('A2 窄屏单列(流内子元素同x)', len(kidxs) >= 2 and max(kidxs) - min(kidxs) <= 2, f'xs={kidxs}')
        num, card, title, ms = rect(page, '#numgrid'), rect(page, '.fnos-beautify-card'), rect(page, '#rh-root > p.semi-typography'), rect(page, '.ms-container')
        ok('A3 卡回流流内(static)', page.evaluate("() => getComputedStyle(document.querySelector('.fnos-beautify-card')).position") == 'static')
        ok('A4 卡在选集下方(row3)', card and num and card['y'] >= num['bottom'] - 4, f"num.bottom={num and round(num['bottom'])}, card.y={card and round(card['y'])}")
        ok('A5 标题在卡下方', title and card and title['y'] >= card['bottom'] - 4, f"card.bottom={card and round(card['bottom'])}, title.y={title and round(title['y'])}")
        ok('A6 标题无大空当(段间距级)', title and card and (title['y'] - card['bottom']) < 90,
           f"gap={title and card and round(title['y']-card['bottom'])}")
        ok('A7 演员列表在标题下', ms and title and ms['y'] >= title['bottom'] - 4)
        ok('A8 内容不横向溢出', page.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1"),
           f"scrollWidth={page.evaluate('() => document.documentElement.scrollWidth')}, innerWidth={page.evaluate('() => window.innerWidth')}")

        # 列表视图也单列(同 A2 判据: 子元素横向对齐)
        open_replica(page, detail_html(False), {'width': 390, 'height': 844})
        kidxs2 = page.evaluate("""() => [...document.getElementById('col').children]
            .map(k => k.getBoundingClientRect())
            .filter(r => r.width > 2)
            .map(r => Math.round(r.x))""")
        ok('A9 列表视图窄屏单列', len(kidxs2) >= 2 and max(kidxs2) - min(kidxs2) <= 2, f'xs={kidxs2}')
        page.screenshot(path=str(ROOT / 'dev' / 'v140-mobile-detail.png'), full_page=True)

        # ── C. 手机视口播放页: 弹幕触控 ──
        open_replica(page, player_html(), {'width': 390, 'height': 844})
        page.wait_for_timeout(2500)
        btn = page.evaluate("() => { const w = document.querySelector('.plugin-placeholder[data-fnos-ui]'); if(!w) return null; const r = w.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; }")
        ok('C1 弹幕按钮入位控制栏', btn and btn['h'] > 10, f'btn={btn}')
        active0 = page.evaluate("() => document.querySelector('.fntv-dm-list')?.classList.contains('active') || false")
        # 触屏 tap 按钮
        page.tap('.plugin-placeholder[data-fnos-ui] .flex span')
        page.wait_for_timeout(400)
        active1 = page.evaluate("() => document.querySelector('.fntv-dm-list')?.classList.contains('active') || false")
        ok('C2 点按打开面板', (not active0) and active1, f'{active0}→{active1}')
        box = rect(page, '.fntv-dm-list')
        vw = page.evaluate('() => window.innerWidth')
        ok('C3 面板不溢出视口', box and box['x'] >= -2 and box['right'] <= vw + 2, f"panel.x={box and round(box['x'])}, right={box and round(box['right'])}, vw={vw}")
        ok('C4 面板宽=92vw 级(自适应)', box and box['w'] <= 370 and box['w'] >= 300, f"w={box and round(box['w'])}")
        # 点面板外关闭（面板锚在按钮上方 y≈150-460，取 y=40 顶部安全区）
        page.touchscreen.tap(195, 40)
        page.wait_for_timeout(400)
        active2 = page.evaluate("() => document.querySelector('.fntv-dm-list')?.classList.contains('active') || false")
        ok('C5 点外部关闭面板', active2 is False, f'active={active2}')
        # 再点按钮再开(toggle 往返)
        page.tap('.plugin-placeholder[data-fnos-ui] .flex span')
        page.wait_for_timeout(300)
        active3 = page.evaluate("() => document.querySelector('.fntv-dm-list')?.classList.contains('active') || false")
        page.tap('.plugin-placeholder[data-fnos-ui] .flex span')
        page.wait_for_timeout(300)
        active4 = page.evaluate("() => document.querySelector('.fntv-dm-list')?.classList.contains('active') || false")
        ok('C6 按钮 toggle 往返(开→关)', active3 and not active4, f'{active3}→{active4}')
        page.screenshot(path=str(ROOT / 'dev' / 'v140-mobile-player.png'))

        # ── 桌面视口: 弹幕 hover 行为不回归 ──
        dpage = b.new_page(viewport={'width': 1440, 'height': 900})
        open_replica(dpage, player_html(), {'width': 1440, 'height': 900})
        dpage.wait_for_timeout(2500)
        dpage.hover('.plugin-placeholder[data-fnos-ui] .flex span')
        dpage.wait_for_timeout(400)
        dactive1 = dpage.evaluate("() => document.querySelector('.fntv-dm-list')?.classList.contains('active') || false")
        ok('D1 桌面 hover 开面板', dactive1)
        pw = dpage.evaluate("() => document.querySelector('.fntv-dm-list').getBoundingClientRect().width")
        ok('D2 桌面面板仍 320px', abs(pw - 320) < 3, f'w={pw}')
        dpage.mouse.move(720, 100)  # 移出
        dpage.wait_for_timeout(600)
        dactive2 = dpage.evaluate("() => document.querySelector('.fntv-dm-list')?.classList.contains('active') || false")
        ok('D3 桌面移出延时关闭', dactive2 is False, f'active={dactive2}')

        b.close()

    fails = [r for r in results if not r[1]]
    print(f"\npageerror: {errors or '无'}")
    for name, passed, detail in results:
        print(f"{'✅' if passed else '❌'} {name}" + (f"  [{detail}]" if detail else ''))
    print(f"\n{len(results)-len(fails)}/{len(results)} 通过")
    sys.exit(1 if fails or errors else 0)

main()
