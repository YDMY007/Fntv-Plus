/* app.js — 安装器页面状态机 + JS桥 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var host = (window.chrome && window.chrome.webview) ? window.chrome.webview : null;

  function send(m) { if (host) host.postMessage(JSON.stringify(m)); }

  /* ── Toast ── */
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg; t.hidden = false;
    requestAnimationFrame(function () { t.classList.add('show'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { t.hidden = true; }, 320);
    }, 2400);
  }

  /* ── 屏幕切换 ── */
  var screens = ['welcome', 'options', 'progress', 'finish'];
  var badgeTexts = { welcome: 'SETUP', options: 'SETUP', progress: 'SETUP', finish: 'DONE' };
  function show(name) {
    screens.forEach(function (s) {
      var el = $('screen-' + s);
      if (s === name) el.classList.add('active'); else el.classList.remove('active');
    });
    $('chromeBadge').textContent = badgeTexts[name] || 'SETUP';
  }

  /* ── 状态 ── */
  var state = { agreed: false, mode: 'user', path: '', exeName: 'Fntv-Plus.exe', version: '', installing: false };

  function setMode(mode) {
    state.mode = mode;
    $('cardUser').classList.toggle('selected', mode === 'user');
    $('cardAll').classList.toggle('selected', mode === 'all');
    $('cardUser').querySelector('.radio').className = 'radio' + (mode === 'user' ? ' on' : '');
    $('cardAll').querySelector('.radio').className = 'radio' + (mode === 'all' ? ' on' : '');
    var needAdmin = mode === 'all';
    $('modeHint').textContent = needAdmin
      ? '将为所有用户安装（通常位于 Program Files）, 点击「开始安装」后会弹出管理员授权。'
      : '将为当前用户安装, 无需管理员权限。';
    send({ type: 'modeChanged', mode: mode });
  }
  function setPath(p) {
    state.path = p;
    $('pathText').textContent = p || '';
    $('pathText').title = p || '';
  }

  /* ── ① 欢迎页 ── */
  $('agreeRow').addEventListener('click', function (e) {
    if (e.target.tagName === 'A') return;
    state.agreed = !state.agreed;
    $('agreeRow').classList.toggle('on', state.agreed);
    $('btnWelcomeNext').disabled = !state.agreed;
  });
  $('btnWelcomeNext').addEventListener('click', function () {
    if (!state.agreed) return;
    show('options');
  });

  /* ── 许可协议 ── */
  var licLoaded = false;
  function openLicense() {
    var ov = $('licOverlay');
    ov.hidden = false;
    requestAnimationFrame(function () { ov.classList.add('show'); });
    if (!licLoaded) {
      fetch('license.txt', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.text() : Promise.reject(0); })
        .then(function (t) { $('licBody').textContent = t; licLoaded = true; })
        .catch(function () { $('licBody').textContent = '许可协议文件缺失。本软件基于 MIT 协议开源发布。'; });
    }
  }
  function closeLicense(accept) {
    var ov = $('licOverlay');
    ov.classList.remove('show');
    setTimeout(function () { ov.hidden = true; }, 260);
    if (accept) {
      if (!state.agreed) { state.agreed = true; $('agreeRow').classList.add('on'); $('btnWelcomeNext').disabled = false; }
    }
  }
  $('linkLicense').addEventListener('click', function (e) { e.preventDefault(); openLicense(); });
  $('licClose').addEventListener('click', function () { closeLicense(false); });
  $('licAccept').addEventListener('click', function () { closeLicense(true); });

  /* ── ② 选项页 ── */
  $('cardUser').addEventListener('click', function () { setMode('user'); });
  $('cardAll').addEventListener('click', function () { setMode('all'); });
  $('btnBrowse').addEventListener('click', function () { send({ type: 'pickFolder' }); });
  $('btnBack').addEventListener('click', function () { show('welcome'); });
  $('btnInstall').addEventListener('click', function () {
    if (state.installing) return;
    if (!state.path) { toast('请先选择安装位置'); return; }
    state.installing = true;
    show('progress');
    setProgress(0, 'prepare', '正在准备安装…');
    send({ type: 'install', mode: state.mode, path: state.path });
  });

  /* ── ③ 进度页 ── */
  var shownPct = -1;
  var phaseTexts = { prepare: '正在准备安装…', extract: '正在解压应用文件…', settle: '正在写入注册表与快捷方式…' };
  function setProgress(pct, phase, file) {
    var p = Math.max(0, Math.min(100, pct));
    if (p !== shownPct) {
      shownPct = p;
      $('pctNum').textContent = Math.round(p);
      $('barFill').style.width = p + '%';
      var C = 2 * Math.PI * 52;
      $('ringFill').style.strokeDashoffset = (C * (1 - p / 100)).toFixed(1);
    }
    $('progFile').textContent = file || phaseTexts[phase] || '';
    if (phase === 'settle') $('progSub').textContent = '即将完成 · 请稍候';
  }

  /* ── ④ 完成页 ── */
  $('btnLaunch').addEventListener('click', function () { send({ type: 'launch' }); });
  $('btnFinishClose').addEventListener('click', function () { send({ type: 'close' }); });

  /* ── chrome ── */
  $('btnMin').addEventListener('click', function () { send({ type: 'minimize' }); });
  $('btnClose').addEventListener('click', function () {
    if (state.installing && !$('screen-finish').classList.contains('active')) {
      toast('正在安装中, 请等待完成');
      return;
    }
    send({ type: 'close' });
  });
  document.querySelectorAll('[data-drag]').forEach(function (el) {
    el.addEventListener('mousedown', function (e) {
      if (e.button === 0) send({ type: 'drag' });
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      if ($('screen-welcome').classList.contains('active') && state.agreed) show('options');
      else if ($('screen-options').classList.contains('active')) $('btnInstall').click();
    }
    if (e.key === 'Escape' && !$('licOverlay').hidden) closeLicense(false);
  });

  /* ── host → web ── */
  if (host) {
    host.addEventListener('message', function (e) {
      var m;
      try { m = (typeof e.data === 'string') ? JSON.parse(e.data) : e.data; } catch (err) { return; }
      if (!m || typeof m !== 'object') return;
      switch (m.type) {
        case 'meta':
          state.version = m.version || '';
          state.exeName = m.exeName || state.exeName;
          $('verWelcome').textContent = 'v' + m.version + ' · 安装向导';
          setMode(m.mode || 'user');
          setPath(m.path || '');
          $('dirHint').textContent = '点「浏览…」选择安装文件夹';
          break;
        case 'folder':
          if (m.path) setPath(m.path);
          if (m.warn) toast(m.warn);
          break;
        case 'progress':
          setProgress(m.pct, m.phase, m.file);
          break;
        case 'installed':
          setProgress(100, 'done', '安装完成');
          state.installing = false;
          show('finish');
          break;
        case 'error':
          state.installing = false;
          toast(m.msg || '安装失败');
          show('options');
          break;
      }
    });
    send({ type: 'ready' });
    /* ?tour=1 自动巡演: 截图验收用(含协议弹层一帧) */
    if (/[?&]tour=1/.test(location.search)) {
      setTimeout(function () { openLicense(); }, 1000);
      setTimeout(function () { closeLicense(true); }, 2300);
      setTimeout(function () { $('btnWelcomeNext').disabled = false; $('agreeRow').classList.add('on'); state.agreed = true; $('btnWelcomeNext').click(); }, 2600);
      setTimeout(function () { $('btnInstall').click(); }, 4000);
    }
  } else {
    /* 浏览器直接打开 www/ 时给演示数据 */
    $('verWelcome').textContent = 'v3.8.0 · 安装向导（预览）';
    setPath('C:\\Users\\demo\\AppData\\Local\\Programs\\Fntv-Plus');
    setMode('user');
  }
})();
