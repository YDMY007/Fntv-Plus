# -*- coding: utf-8 -*-
"""真实结构播放器底栏复刻: 测量手机 390px 下各控件挤压/溢出情况。"""
from playwright.sync_api import sync_playwright
import json

HTML = '''<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<script>try{history.replaceState(null,'','/v/tv/episode/0ae81abecafe0ae81abecafe0ae81abe')}catch(e){}</script>
<style>
body{margin:0;background:#000;font:12px/1.4 system-ui}
.xgplayer{position:relative;width:100vw;height:56vh;background:#151515}
video{width:100%;height:100%}
xg-controls{position:absolute;left:0;right:0;bottom:0;height:48px;display:flex;align-items:center;
  padding:0 12px;background:linear-gradient(transparent,rgba(0,0,0,.7));z-index:20;gap:4px}
xg-left-grid{display:flex;align-items:center;gap:8px}
xg-right-grid{display:flex;align-items:center;gap:14px;margin-left:auto}
.plugin-placeholder{height:100%;display:block}
.control-item{color:#eee;font-size:14px;white-space:nowrap}
.xg-progress{position:absolute;left:12px;right:12px;bottom:48px;height:14px}
.xg-progress-bar{height:3px;background:rgba(255,255,255,.3);border-radius:2px;margin-top:8px}
</style></head><body>
<div class="xgplayer">
<video src="" playsinline></video>
<div class="xg-progress"><div class="xg-progress-bar"></div></div>
<xg-controls class="xgplayer-controls">
  <xg-left-grid><div class="plugin-placeholder"><span class="control-item">播放</span></div>
  <div class="plugin-placeholder"><span class="control-item">00:00 / 24:00</span></div></xg-left-grid>
  <xg-right-grid id="rg">
    <div class="plugin-placeholder"><span class="control-item">倍速</span></div>
    <div class="plugin-placeholder"><span class="control-item">原画</span></div>
    <div class="plugin-placeholder"><span class="control-item">选集</span></div>
    <div class="plugin-placeholder"><span class="control-item">音量</span></div>
    <div class="plugin-placeholder"><span class="control-item">设置</span></div>
    <div class="plugin-placeholder"><span class="control-item">全屏</span></div>
  </xg-right-grid>
</xg-controls>
</div>
<script src="/dist/fntv-plus.user.js"></script></body></html>'''

def main():
    with sync_playwright() as p:
        b = p.chromium.launch()
        for vw, vh, name in [(390, 844, 'mobile'), (844, 390, 'landscape')]:
            pg = b.new_page(viewport={'width': vw, 'height': vh}, has_touch=True, is_mobile=True)
            open('dev/_probe_page.html', 'w', encoding='utf-8').write(HTML)
            pg.goto('http://localhost:8137/dev/_probe_page.html')
            pg.wait_for_timeout(2500)
            r = pg.evaluate("""() => {
              const bar = document.querySelector('xg-controls');
              const btns = [...bar.querySelectorAll('.control-item')].map(e => {
                const r = e.getBoundingClientRect();
                return {txt: (e.textContent||'').trim().slice(0,8), x: Math.round(r.x), right: Math.round(r.right)};
              });
              const left = bar.querySelector('xg-left-grid')?.getBoundingClientRect();
              const right = bar.querySelector('xg-right-grid')?.getBoundingClientRect();
              return {vw: innerWidth, leftW: Math.round(left?.width||0), rightW: Math.round(right?.width||0),
                      overlap: left && right ? Math.round(left.right - right.x) : null, btns};
            }""")
            print(f'== {name} {vw}x{vh} ==')
            print(json.dumps(r, ensure_ascii=False))
            pg.screenshot(path=f'dev/_playerbar-{name}.png')
            pg.close()
        b.close()

main()
