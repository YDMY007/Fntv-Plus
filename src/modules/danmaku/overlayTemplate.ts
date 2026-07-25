/**
 * 弹幕 overlay 的 HTML 模板（含内联 CSS + JS 弹幕引擎）。
 * 由 danmakuOverlay.ts 在运行时写出到临时文件并 loadFile 加载。
 *
 * 引擎设计：
 *  - 主进程通过 window.danmaku.onInit(init) 下发 {items, seek, ...}，并周期性
 *    window.danmaku.onSync({position, state}) 同步播放进度（来自 potctl）。
 *  - 渲染端用自身 requestAnimationFrame 时钟（锚定 seek，按 potctl 周期性重锚）驱动弹幕，
 *    与 PotPlayer 播放进度对齐，且与真实字幕轨道完全解耦（互不争抢）。
 *  - 碰撞避让：滚动弹幕按行分配（间距公式避免追尾），顶部/底部固定弹幕按堆叠行分配。
 */
export function getOverlayHtml(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>danmaku-overlay</title>
<style>
  html, body {
    margin: 0; padding: 0; width: 100%; height: 100%;
    overflow: hidden; background: transparent;
  }
  #stage {
    position: fixed; inset: 0; overflow: hidden; pointer-events: none;
  }
  .dm {
    position: absolute; white-space: nowrap; font-weight: bold;
    font-family: 'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', sans-serif;
    text-shadow: 0 1px 2px rgba(0,0,0,.85), 0 0 3px rgba(0,0,0,.6);
    will-change: transform; line-height: 1.1;
  }
  .dm.scroll { top: 0; }
  .dm.fixed { left: 50%; transform: translateX(-50%); text-align: center; }
</style>
</head>
<body>
<div id="stage"></div>
<script>
(function () {
  var stage = document.getElementById('stage');
  var items = [];
  var index = 0;
  var anchorPos = 0;       // 播放进度(秒)在 anchorTime 时刻的值
  var anchorTime = 0;       // performance.now() 锚点
  var paused = false;
  var fontSize = 28;
  var rowH = 32;
  var scrollDur = 9000;    // 滚动弹幕时长(ms)
  var fixDur = 4500;       // 固定弹幕停留(ms)
  var opacity = 0.9;
  var running = false;
  var scrollRows = [];
  var topRows = [];
  var botRows = [];
  var activeAnims = [];    // 所有在飞的弹幕动画（滚动/固定统一用 WAAPI，便于随播放暂停/恢复）

  function removeAnim(a) {
    var i = activeAnims.indexOf(a);
    if (i >= 0) activeAnims.splice(i, 1);
  }

  // 暂停/恢复所有弹幕动画：滚动弹幕由 WAAPI 独立时间线驱动，与 rAF 时钟无关，
  // 必须显式 pause()/play()，否则视频暂停后弹幕仍会继续滚动。
  function setPaused(p) {
    if (p === paused) return;
    paused = p;
    for (var i = 0; i < activeAnims.length; i++) {
      try { p ? activeAnims[i].pause() : activeAnims[i].play(); } catch (e) { /* ignore */ }
    }
  }

  function init(d) {
    items = (d.items || []).slice().sort(function (a, b) { return a.time - b.time; });
    // 字号按窗口高度自适应（4K/高缩放下也不至于过大）：约窗口高度的 1/42，封顶 30px。
    fontSize = d.fontSize || Math.max(16, Math.min(30, Math.round(window.innerHeight / 42)));
    rowH = Math.round(fontSize * 1.15);
    scrollDur = d.scrollDur || 9000;
    fixDur = d.fixDur || 4500;
    opacity = (d.opacity == null) ? 0.9 : d.opacity;
    anchorPos = d.seek || 0;
    anchorTime = performance.now();
    paused = false;
    // 重新初始化（连播切集）：清掉旧动画引用
    activeAnims = [];

    var h = window.innerHeight;
    var nScroll = Math.max(1, Math.floor(h / rowH));
    scrollRows = [];
    for (var i = 0; i < nScroll; i++) scrollRows.push({ lastStart: -1e9, lastW: 0, lastV: 0 });
    var nFix = Math.max(1, Math.floor(h / (rowH * 1.2)));
    topRows = []; botRows = [];
    for (var j = 0; j < nFix; j++) { topRows.push({ freeAt: -1e9 }); botRows.push({ freeAt: -1e9 }); }

    stage.innerHTML = '';
    // 跳过已过去的弹幕，从当前进度开始（晚进不补放）
    index = 0;
    while (index < items.length && items[index].time < anchorPos) index++;

    if (!running) { running = true; requestAnimationFrame(loop); }
  }

  function nowPos() {
    if (paused) return anchorPos;
    return anchorPos + (performance.now() - anchorTime) / 1000;
  }

  function sync(d) {
    var pos = d.position;
    if (d.state != null) setPaused(d.state !== 2);
    if (pos != null && isFinite(pos)) {
      if (pos > anchorPos + 1) {
        // 前进跳转：跳过中间已不存在的弹幕，避免一次性 flooding
        while (index < items.length && items[index].time < pos) index++;
      }
      anchorPos = pos;
      anchorTime = performance.now();
    }
  }

  function loop() {
    if (!running) return;
    var t = nowPos();
    while (index < items.length && items[index].time <= t) {
      spawn(items[index]);
      index++;
    }
    requestAnimationFrame(loop);
  }

  function rgb(c) {
    c = c || 0xffffff;
    var r = (c >> 16) & 0xff, g = (c >> 8) & 0xff, b = c & 0xff;
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function spawn(it) {
    var type = it.type;
    if (type === 4) spawnFixed(it, false);
    else if (type === 5) spawnFixed(it, true);
    else spawnScroll(it);
  }

  function spawnScroll(it) {
    var el = document.createElement('div');
    el.className = 'dm scroll';
    el.textContent = it.text;
    el.style.color = rgb(it.color);
    el.style.fontSize = fontSize + 'px';
    el.style.opacity = opacity;
    stage.appendChild(el);
    var w = el.offsetWidth;
    var W = window.innerWidth;
    var total = W + w;
    var v = total / scrollDur; // px/ms
    var chosen = -1, bestBias = -1e9, bestRow = 0;
    for (var i = 0; i < scrollRows.length; i++) {
      var r = scrollRows[i];
      if (r.lastStart < -1e8) { chosen = i; break; }
      var gap = (r.lastW + w) / (r.lastV + v); // ms，两条不追尾所需最小间隔
      var dt = performance.now() - r.lastStart;
      if (dt >= gap) { chosen = i; break; }
      var bias = dt - gap;
      if (bias > bestBias) { bestBias = bias; bestRow = i; }
    }
    if (chosen < 0) chosen = bestRow;
    el.style.top = (chosen * rowH + 4) + 'px';
    scrollRows[chosen] = { lastStart: performance.now(), lastW: w, lastV: v };
    var anim = el.animate([
      { transform: 'translateX(' + W + 'px)' },
      { transform: 'translateX(' + (-w) + 'px)' }
    ], { duration: scrollDur, easing: 'linear' });
    if (paused) { try { anim.pause(); } catch (e) { /* ignore */ } }
    activeAnims.push(anim);
    anim.onfinish = function () { removeAnim(anim); if (el.parentNode) el.parentNode.removeChild(el); };
  }

  function spawnFixed(it, top) {
    var rows = top ? topRows : botRows;
    var el = document.createElement('div');
    el.className = 'dm fixed';
    el.textContent = it.text;
    el.style.color = rgb(it.color);
    el.style.fontSize = fontSize + 'px';
    el.style.opacity = opacity;
    var chosen = -1;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].freeAt <= performance.now()) { chosen = i; break; }
    }
    if (chosen < 0) chosen = 0;
    var y = top
      ? (chosen * rowH * 1.2 + 4)
      : (window.innerHeight - (chosen + 1) * rowH * 1.2 - 4);
    el.style.top = y + 'px';
    rows[chosen].freeAt = performance.now() + fixDur;
    stage.appendChild(el);
    // 用 WAAPI 计时（而非 setTimeout），使固定弹幕的停留也能随视频暂停/恢复。
    var anim = el.animate([{ opacity: opacity }, { opacity: opacity }], { duration: fixDur });
    if (paused) { try { anim.pause(); } catch (e) { /* ignore */ } }
    activeAnims.push(anim);
    anim.onfinish = function () { removeAnim(anim); if (el.parentNode) el.parentNode.removeChild(el); };
  }

  window.danmaku.onInit(init);
  window.danmaku.onSync(sync);
  window.danmaku.onHide(function () { running = false; activeAnims = []; stage.innerHTML = ''; });
})();
</script>
</body>
</html>`;
}
