import { ipcRenderer } from 'electron';
import { log } from '../log';

// embyWall/nav/inject.ts — 导航注入：原生返回按钮、外置播放器按钮、视频预览外置播放
// 由 scripts/embywall-split.js 从 embyWall.ts 整段抽取；改实现请改这里，不要在入口文件里补。

/* ========== 入口 ========== */
/** [lc-371] 飞牛原生 NAS 系统页下的浮动"返回影视"按钮: 点击切回 TV 模式(/v)。
 *  原生页不注入 Fntv-Plus 侧栏, 故用此浮动按钮提供返回入口, 避免进入原生页后无路可退。 */
export function injectNativeReturnButton(): void {
  if (document.getElementById('fnos-native-return')) return;
  const btn = document.createElement('button');
  btn.id = 'fnos-native-return';
  btn.type = 'button';
  btn.textContent = '↩ 返回影视';
  btn.setAttribute('data-fnos-ui', '1');
  // 纯色背景(无 backdrop-filter): 避开 transparent 窗口 GPU 负担历史坑(lc-366/lc-369)
  // [lc-377] 远离窗口 16px 圆角/边缘裁切区: bottom 30px + left 20px 确保完整可见
  btn.style.cssText = 'position:fixed;left:20px;bottom:30px;z-index:2147483647;'
    + 'padding:9px 16px;border-radius:12px;cursor:pointer;'
    + 'background:rgba(40,30,60,.92);color:#fff;font-size:13px;font-weight:600;'
    + 'border:1px solid rgba(255,255,255,.28);box-shadow:0 6px 20px rgba(0,0,0,.35);';
  btn.addEventListener('click', (e: Event) => {
    e.stopPropagation();
    // [lc-473] 清除"主动看系统页"标记 → 回到 /v 后 autoJumpToTv 恢复(本就只在 / 跳, /v 不跳)
    try { sessionStorage.removeItem('fntv-system-intent'); } catch (_) { /* ignore */ }
    // [lc-375] 交主进程清除 _systemPageMode 并跳转 /v(原子操作, 避免守卫竞态)
    ipcRenderer.send('fntv:exit-system-page');
  });
  document.body.appendChild(btn);
  // 兜底: 原生 SPA 若重建 body 子节点, 每 3s 确保按钮仍在(避免被移除后无法返回)
  setInterval(() => {
    if (!document.getElementById('fnos-native-return') && document.body) {
      document.body.appendChild(btn);
    }
  }, 3000);
}

// [lc-385] 系统页(飞牛原生桌面/文件管理器)显式「外部播放」入口：
// 不劫持正常点击，提供浮动按钮 + 小面板，让用户粘贴直链 / 选择本地文件，
// 经主进程 external-play IPC 用 PotPlayer/MPV 打开（fnOS 流类点击拦截另由点击委托实现）。
export function injectExternalPlayButton(): void {
  if (document.getElementById('fnos-ext-play')) return;

  const panel = document.createElement('div');
  panel.id = 'fnos-ext-play-panel';
  panel.style.cssText = 'position:fixed;right:20px;bottom:80px;z-index:2147483647;width:260px;padding:12px;'
    + 'border-radius:14px;background:rgba(30,24,44,.94);color:#fff;font-size:12px;box-shadow:0 8px 28px rgba(0,0,0,.45);'
    + 'border:1px solid rgba(255,255,255,.2);display:none;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);';

  panel.innerHTML = ''
    + '<div style="font-weight:700;margin-bottom:8px;">外部播放器打开</div>'
    + '<div style="margin-bottom:8px;">播放器：'
    + '<label style="margin-right:10px;cursor:pointer;"><input type="radio" name="ext-player" value="mpv" checked> MPV</label>'
    + '<label style="cursor:pointer;"><input type="radio" name="ext-player" value="potplayer"> PotPlayer</label>'
    + '</div>'
    + '<div style="margin-bottom:6px;color:rgba(255,255,255,.7);">直链 URL</div>'
    + '<input id="ext-url" type="text" placeholder="https://.../xxx.mp4" style="width:100%;box-sizing:border-box;height:30px;margin-bottom:8px;'
    + 'border-radius:7px;border:1px solid rgba(255,255,255,.25);background:rgba(0,0,0,.3);color:#fff;padding:0 8px;">'
    + '<button id="ext-open-url" style="width:100%;height:30px;margin-bottom:10px;border-radius:7px;border:none;cursor:pointer;'
    + 'background:#6c5ce7;color:#fff;font-weight:600;">用播放器打开直链</button>'
    + '<div style="margin-bottom:6px;color:rgba(255,255,255,.7);">本地文件</div>'
    + '<input id="ext-file" type="file" accept="video/*" style="width:100%;margin-bottom:8px;color:#fff;">'
    + '<button id="ext-open-file" style="width:100%;height:30px;border-radius:7px;border:none;cursor:pointer;'
    + 'background:#00b894;color:#fff;font-weight:600;">用播放器打开本地文件</button>';

  const toggle = document.createElement('button');
  toggle.id = 'fnos-ext-play';
  toggle.type = 'button';
  toggle.textContent = '🎬 外部播放';
  toggle.style.cssText = 'position:fixed;right:20px;bottom:30px;z-index:2147483647;padding:9px 14px;border-radius:12px;cursor:pointer;'
    + 'background:rgba(40,30,60,.92);color:#fff;font-size:13px;font-weight:600;'
    + 'border:1px solid rgba(255,255,255,.28);box-shadow:0 6px 20px rgba(0,0,0,.35);';

  toggle.addEventListener('click', (e: Event) => {
    e.stopPropagation();
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });

  panel.querySelector('#ext-open-url')!.addEventListener('click', (e: Event) => {
    e.stopPropagation();
    const url = (panel.querySelector('#ext-url') as HTMLInputElement).value.trim();
    const player = (panel.querySelector('input[name=ext-player]:checked') as HTMLInputElement)?.value as 'mpv' | 'potplayer';
    if (!url) { alert('请先粘贴视频直链'); return; }
    ipcRenderer.send('external-play', { kind: 'url', url, player });
    panel.style.display = 'none';
  });

  panel.querySelector('#ext-open-file')!.addEventListener('click', (e: Event) => {
    e.stopPropagation();
    const fileInput = panel.querySelector('#ext-file') as HTMLInputElement;
    const f = fileInput.files && fileInput.files[0];
    if (!f) { alert('请先选择本地视频文件'); return; }
    const player = (panel.querySelector('input[name=ext-player]:checked') as HTMLInputElement)?.value as 'mpv' | 'potplayer';
    // Electron 渲染进程里 fileInput.files[0].path 即本地绝对路径
    const p = (f as any).path as string;
    if (!p) { alert('无法读取本地文件路径'); return; }
    ipcRenderer.send('external-play', { kind: 'file', path: p, player });
    panel.style.display = 'none';
  });

  // 点击面板内部不冒泡关闭；点击面板外关闭
  panel.addEventListener('click', (e: Event) => e.stopPropagation());
  document.addEventListener('click', () => { if (panel.style.display === 'block') panel.style.display = 'none'; });

  document.body.appendChild(panel);
  document.body.appendChild(toggle);
  setInterval(() => {
    if (!document.getElementById('fnos-ext-play') && document.body) {
      document.body.appendChild(panel);
      document.body.appendChild(toggle);
    }
  }, 3000);
}

// ─── fnOS 视频预览窗口 → 标题栏「🎬 外部打开」按钮 ───
// 飞牛视频预览以模态窗口(.trim-ui__app-layout--window)内联 xgplayer <video> 播放,
// 其 src 为带签名(sign)的直链 /download/.../file.mp4?t=...&sign=..., 自鉴权,
// 可直接交给外部播放器(PotPlayer/MPV)播放, 无需再走 fnOS 代理或 cookie.
// 策略: 保留原生预览, 仅在模态标题栏注入一个按钮, 点击时取 video 直链 → external-play(url).
export function injectVideoPreviewExternalPlay(): void {
  if (document.getElementById('fnos-video-preview-hook')) return;
  const marker = document.createElement('div');
  marker.id = 'fnos-video-preview-hook';
  marker.style.display = 'none';
  document.body.appendChild(marker);

  // [lc-453] 撤销 lc-395/lc-396 的强制黑底: 恢复飞牛视频预览模态原生白色顶栏(用户要求),
  //   不再注入 fntv-video-modal 头部配色规则(连强制白字一并撤掉, 否则白底白字不可见).

  // 冻结/解冻: 在用户选择播放方式之前, 阻止飞牛原生 xgplayer 自动播放(避免"还没选就播了").
  // 原理: capture 阶段拦截 <video> 的 play 事件(prioritize 于 xgplayer 的 listener),
  //       preventDefault + stopImmediatePropagation + 再次 pause, 使任何 play() 企图都被挡住.
  const frozen = new WeakSet<HTMLVideoElement>();
  function freezeVideo(video: HTMLVideoElement | null): void {
    if (!video || frozen.has(video)) return;
    frozen.add(video);
    try { video.pause(); } catch (_) { /* ignore */ }
    const block = (e: Event): void => {
      e.preventDefault();
      e.stopImmediatePropagation();
      try { video.pause(); } catch (_) { /* ignore */ }
    };
    video.addEventListener('play', block, true);
    (video as any).__fntvBlock = block;
  }
  function unfreezeVideo(video: HTMLVideoElement | null): void {
    if (!video) return;
    const block = (video as any).__fntvBlock as EventListener | undefined;
    if (block) { video.removeEventListener('play', block, true); (video as any).__fntvBlock = null; }
    frozen.delete(video);
    try { video.play().catch(() => {}); } catch (_) { /* ignore */ }
  }

  /** 用外部播放器打开: 优先走 fnOS 完整播放链路(代理注入鉴权), 兜底直链 */
  function launchExternal(modal: HTMLElement): void {
    const video = modal.querySelector('video') as HTMLVideoElement | null;
    const rawUrl = video?.currentSrc || video?.src || '';
    const titleEl = modal.querySelector('.trim-ui__app-layout--header-title span');
    const title = (titleEl?.textContent || 'fnOS 视频').trim();
    // [lc-595] 飞牛预览 video src 是 /v/api/v1/media/range/{guid}(需 Authx/cookie 鉴权),
    // 直接给 MPV 会 403; 提取 guid 走 kind='fnos' 由 handlePlayMovie 经 Go 代理注入 cookie 播放。
    const m = rawUrl.match(/\/v\/api\/v1\/media\/range\/([a-f0-9]{32})/i);
    if (m) {
      log('[视频预览外放] 走 fnOS 播放链路:', title, m[1]);
      ipcRenderer.send('external-play', { kind: 'fnos', id: m[1], title });
      // 关闭原生预览(轻微延迟, 让外部播放器先启动)
      setTimeout(() => {
        const closeBtn = modal.querySelector('.app-layout-header-close') as HTMLElement | null;
        if (closeBtn) closeBtn.click();
        else modal.style.display = 'none';
      }, 200);
      return;
    }
    // 兜底: 其他 http(s) 直链(相对路径补全, [lc-594])
    let url = rawUrl;
    if (url && url.startsWith('/')) url = location.origin + url;
    if (!url || !/^https?:\/\//i.test(url)) {
      log('[视频预览外放] 未取到有效直链:', url);
      alert('未能获取视频直链，无法外部打开');
      return;
    }
    log('[视频预览外放] 外部打开:', title, url);
    ipcRenderer.send('external-play', { kind: 'url', url, title });
    // 关闭原生预览(轻微延迟, 让外部播放器先启动)
    setTimeout(() => {
      const closeBtn = modal.querySelector('.app-layout-header-close') as HTMLElement | null;
      if (closeBtn) closeBtn.click();
      else modal.style.display = 'none';
    }, 200);
  }

  /** 弹出居中选择弹窗(暂停原生 video 避免双声); 飞牛原生 / 外置播放器 二选一 */
  function showChoiceDialog(modal: HTMLElement): void {
    if (modal.dataset.fntvChoice === '1') return; // 防重复弹出
    modal.dataset.fntvChoice = '1';

    const video = modal.querySelector('video') as HTMLVideoElement | null;

    const overlay = document.createElement('div');
    overlay.className = 'fntv-choice-dialog';
    // z-index 高于飞牛预览窗口(10015), 遮罩盖住预览直到用户选择
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10020;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.45);';

    const card = document.createElement('div');
    card.style.cssText = 'min-width:300px;max-width:90vw;padding:20px 22px;border-radius:14px;background:var(--semi-color-bg-1,#fff);box-shadow:0 8px 30px rgba(0,0,0,0.25);color:var(--semi-color-text-0);';
    card.innerHTML =
      '<div style="font-weight:600;font-size:15px;margin-bottom:4px;">选择播放方式</div>' +
      '<div style="opacity:0.7;font-size:12px;margin-bottom:14px;">要如何播放此视频？</div>';

    const mkBtn = (label: string, primary: boolean, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText =
        'display:block;width:100%;margin-top:10px;padding:10px 14px;border:0;border-radius:10px;cursor:pointer;font-size:14px;font-weight:600;' +
        (primary
          ? 'background:var(--semi-color-primary,#3370ff);color:#fff;'
          : 'background:var(--semi-color-fill-0,#f0f0f0);color:var(--semi-color-text-0);');
      b.onmouseenter = () => { b.style.opacity = '0.85'; };
      b.onmouseleave = () => { b.style.opacity = '1'; };
      b.onclick = onClick;
      return b;
    };

    const closeDialog = (): void => { overlay.remove(); }; // 保留 dataset.fntvChoice='1', 防止 observer 重新弹窗/重新冻结
    const playNative = (): void => { unfreezeVideo(video); }; // 解冻(移除 play 拦截) + 底层 video.play()(用户手势内允许播放; 不再被 observer 重新冻结, 故稳定播放)

    card.appendChild(mkBtn('🎬 外置播放器 (PotPlayer / MPV)', true, () => {
      closeDialog();
      launchExternal(modal);
    }));
    card.appendChild(mkBtn('▶ 飞牛原生播放', false, () => {
      closeDialog();
      playNative();
    }));

    overlay.appendChild(card);
    // 点击遮罩空白处 = 飞牛原生(不打断用户)
    overlay.addEventListener('click', (e: Event) => {
      if (e.target === overlay) { closeDialog(); playNative(); }
    });
    overlay.addEventListener('mousedown', (e: Event) => e.stopPropagation()); // 防穿透到预览窗口

    document.body.appendChild(overlay);
    log('[视频预览外放] 已弹出播放方式选择弹窗');
  }

  function ensureButton(modal: HTMLElement): void {
    if (modal.querySelector('.fntv-ext-open')) return; // 幂等(应对 fnOS 重渲染标题栏)

    // 标题栏右侧按钮容器 = 关闭按钮的父节点(minimize/maximize/close 同容器)
    const closeBtn = modal.querySelector('.app-layout-header-close') as HTMLElement | null;
    const headerBtns = (closeBtn?.parentElement) as HTMLElement | null;
    if (!headerBtns) return;

    const btn = document.createElement('div');
    btn.className = 'fntv-ext-open flex h-full items-center px-[15px] cursor-pointer hover:!bg-[var(--semi-color-fill-0)] active:!bg-[var(--semi-color-fill-0)]';
    btn.style.cssText = 'font-weight:600;font-size:13px;white-space:nowrap;user-select:none;color:var(--semi-color-text-0);';
    btn.textContent = '🎬 外部打开';
    btn.title = '用 PotPlayer / MPV 打开此视频';
    btn.addEventListener('click', (e: Event) => { e.stopPropagation(); launchExternal(modal); });
    btn.addEventListener('mousedown', (e: Event) => e.stopPropagation()); // 避免触发标题栏拖拽

    headerBtns.insertBefore(btn, headerBtns.firstChild);
  }

  // 注意: MutationObserver 在 xgplayer 播放时因进度条等 DOM 变化会反复触发.
  // 已处理过的 modal(dataset.fntvChoice==='1')必须整体跳过, 否则会对已解冻的视频重新 freeze(视频反复被暂停),
  // 且会因 closeDialog 删除 dataset 而重新弹出选择窗(现象: 弹窗关不掉/视频不播).
  const handleModal = (modal: HTMLElement): void => {
    if (modal.dataset.fntvChoice === '1') return; // 已选过播放方式: 不再冻结/弹窗/注入按钮
    if (modal.querySelector('video')) {
      freezeVideo(modal.querySelector('video')); // 选择前冻结原生播放, 避免"还没选就播了"
      showChoiceDialog(modal); // 自动弹窗(主要交互)
      ensureButton(modal);     // 标题栏按钮(弹窗关闭后仍可作为二次入口)
    }
  };

  const observer = new MutationObserver(() => {
    document.querySelectorAll('.trim-ui__app-layout--window').forEach((m) => handleModal(m as HTMLElement));
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // 首次注入时也扫一遍(模态可能已存在)
  document.querySelectorAll('.trim-ui__app-layout--window').forEach((m) => handleModal(m as HTMLElement));

  // [lc-596] 影视播放页(xgplayer)控制栏注入「🎬 MPV」按钮:
  // 未刮削个人视频在详情页可能没有标准"播放"按钮导致 playButton 注入不了,
  // 用户打开原生网页播放后这里提供 MPV 出口——从 video src(media/range/{guid}) 提取
  // guid 走 play-movie(fnOS 代理链路, 主进程 config.token 兜底鉴权)。
  const mpvBtnInjected = (): void => {
    try {
      const video = document.querySelector('video[src*="/v/api/v1/media/range/"], xgplayer video') as HTMLVideoElement | null;
      if (!video || !video.offsetParent) return;
      if (video.closest('.trim-ui__app-layout--window')) return; // 文件预览 modal 由上面的弹窗逻辑处理
      const bar = document.querySelector('xg-right-grid') as HTMLElement | null;
      if (!bar || bar.querySelector('.fntv-playerbar-mpv')) return;
      const btn = document.createElement('div');
      btn.className = 'fntv-playerbar-mpv';
      btn.style.cssText = 'display:flex;align-items:center;justify-content:center;padding:0 12px;cursor:pointer;color:var(--semi-color-text-1,#e8e8ee);font-size:13px;font-weight:600;white-space:nowrap;user-select:none';
      btn.textContent = '🎬 MPV';
      btn.title = '用 MPV 播放器打开此视频';
      btn.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        // [lc-600] 修正: 必须是 item GUID(走 fnapi.getPlayInfo)而非 media file GUID。
        // - 正确: 从 location.pathname 提取(/v/video/{32hex} / /v/tv/{32hex} / /v/movie/{32hex})
        // - 错误(旧 lc-596): 从 video.src 提 media/range/{32hex} 走 getPlayInfo 找不到 item, 失败
        const path = (location.pathname || '').replace(/\/+$/, '');
        const m = path.match(/\/v\/(?:movie|tv|video|other)\/(?:season\/|episode\/)?([a-f0-9]{32})/i);
        if (!m) { alert('未能从当前页面提取视频 ID(URL=' + path + ')'); return; }
        const itemGuid = m[1];
        log('[播放页 MPV] 打开 item:', itemGuid);
        ipcRenderer.send('play-movie', { id: itemGuid, token: '', sourceIndex: 0, player: 'mpv' });
      });
      bar.appendChild(btn);
      log('[播放页 MPV] 控制栏按钮已注入');
    } catch (e) { /* ignore */ }
  };
  const mpvObs = new MutationObserver(mpvBtnInjected);
  mpvObs.observe(document.body, { childList: true, subtree: true });
  mpvBtnInjected();

  log('[视频预览外放] 已注入(自动弹窗选择 + 标题栏外部打开按钮)');
}
