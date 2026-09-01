import { S } from '../state';
import { applyCarouselBackdrop } from './images';
import { getEffectiveDark } from '../theme';
import { log } from '../log';
import { resolveSeasonHref } from './href';
import { resolveShowLogo } from './logo';

// embyWall/carousel/styles.ts — 轮播样式构建：style2 / style3 / style4 三套皮肤 + 公共 CSS 注入
// 由 scripts/embywall-split.js 从 embyWall.ts 整段抽取；改实现请改这里，不要在入口文件里补。

export function buildCarouselStyle2(
  container: HTMLElement,
  wrapper: HTMLElement,
  shows: any[],
  base: string,
  rebuild: boolean
): void {
  const log2 = (...a: any[]) => log('[s2]', ...a);

  const imgUrl = (p: string, w?: number) => {
    if (!p) return '';
    if (p.startsWith('http') || p.startsWith('/v/api/')) return p + (w ? '?w=' + w : '');
    return `${base}/v/api/v1/${p}` + (w ? '?w=' + w : '');
  };

  // 一次性注入样式（scoped 到样式 2）
  if (!document.getElementById('fnos-carousel-style2-style')) {
    const st = document.createElement('style');
    st.id = 'fnos-carousel-style2-style';
    st.textContent = `
[data-fntv-carousel-style="2"] .fnos-slide-track{position:relative;width:100%;height:100%}
[data-fntv-carousel-style="2"] .fnos-slide-item{
  position:absolute;inset:0;border-radius:24px;overflow:hidden;
  opacity:0;visibility:hidden;
  transition:opacity .9s cubic-bezier(.4,0,.2,1),transform .9s cubic-bezier(.4,0,.2,1),visibility .9s;
  transform:translateX(80px) scale(1.05);z-index:1;will-change:transform,opacity;
}
[data-fntv-carousel-style="2"] .fnos-slide-item.active{
  opacity:1;visibility:visible;transform:translateX(0) scale(1);z-index:2;
  transition:opacity 1.1s cubic-bezier(.22,1,.36,1),transform 1.1s cubic-bezier(.22,1,.36,1),visibility 1.1s;
}
[data-fntv-carousel-style="2"] .fnos-slide-item.exit-left{
  opacity:0;visibility:visible;transform:translateX(-60px) scale(.97);z-index:1;
  transition:opacity .8s cubic-bezier(.55,0,.1,1),transform .8s cubic-bezier(.55,0,.1,1),visibility .8s;
}
[data-fntv-carousel-style="2"] .fnos-slide-item.pre-enter{opacity:0;visibility:hidden;transform:translateX(100px) scale(1.08);z-index:0}
[data-fntv-carousel-style="2"] .fnos-slide-bg{position:absolute;inset:0;background-size:cover;background-position:center 25%;transform:scale(1.08);transition:transform 2.5s cubic-bezier(.25,.8,.25,1)}
[data-fntv-carousel-style="2"] .fnos-slide-item.active .fnos-slide-bg{transform:scale(1)}
[data-fntv-carousel-style="2"] .fnos-slide-bg::after{content:'';position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.95) 0%,rgba(0,0,0,.7) 25%,rgba(0,0,0,.3) 55%,rgba(0,0,0,.1) 75%,rgba(0,0,0,.02) 100%)}
[data-fntv-carousel-style="2"] .fnos-slide-content{position:relative;z-index:3;height:100%;display:flex;flex-direction:column;justify-content:flex-end;padding:2rem 2.5rem 3.6rem;color:#fff}
[data-fntv-carousel-style="2"] .fnos-slide-meta{font-size:.75rem;letter-spacing:2px;color:#d4b48c;margin-bottom:.5rem;text-transform:uppercase;opacity:0;transform:translateY(20px);transition:opacity .7s ease .5s,transform .7s cubic-bezier(.22,1,.36,1) .5s}
[data-fntv-carousel-style="2"] .fnos-slide-title{font-size:3.3rem;font-weight:900;letter-spacing:1px;line-height:1.15;word-break:break-word;margin-bottom:.6rem;background:var(--fnos-hero-title-grad);-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;filter:var(--fnos-hero-title-glow);opacity:0;transform:translateY(25px);transition:opacity .7s ease .65s,transform .7s cubic-bezier(.22,1,.36,1) .65s}
[data-fntv-carousel-style="2"] .fnos-slide-title--logo{background:none;-webkit-background-clip:border-box;background-clip:border-box;-webkit-text-fill-color:initial;color:#fff;filter:none;display:flex;align-items:flex-end;margin-bottom:.4rem}
[data-fntv-carousel-style="2"] .fnos-slide-title-logo-img{max-height:130px;max-width:62%;width:auto;height:auto;display:block;object-fit:contain;filter:drop-shadow(0 4px 18px rgba(0,0,0,.7))}
[data-fntv-carousel-style="2"] .fnos-slide-desc{font-size:1rem;color:rgba(232,221,208,.72);line-height:1.6;text-shadow:0 2px 8px rgba(0,0,0,.7);max-width:600px;margin-bottom:1.5rem;opacity:0;transform:translateY(25px);transition:opacity .7s ease .8s,transform .7s cubic-bezier(.22,1,.36,1) .8s}
[data-fntv-carousel-style="2"] .fnos-slide-actions{display:flex;gap:.8rem;flex-wrap:wrap;opacity:0;transform:translateY(20px);transition:opacity .7s ease .95s,transform .7s cubic-bezier(.22,1,.36,1) .95s}
[data-fntv-carousel-style="2"] .fnos-slide-item.active .fnos-slide-meta{opacity:1;transform:translateY(0)}
[data-fntv-carousel-style="2"] .fnos-slide-item.active .fnos-slide-title{opacity:1;transform:translateY(0)}
[data-fntv-carousel-style="2"] .fnos-slide-item.active .fnos-slide-desc{opacity:1;transform:translateY(0)}
[data-fntv-carousel-style="2"] .fnos-slide-item.active .fnos-slide-actions{opacity:1;transform:translateY(0)}
[data-fntv-carousel-style="2"] .fnos-s2-play{
  padding:.85rem 1.8rem;border-radius:50px;font-weight:600;font-size:.95rem;cursor:pointer;
  letter-spacing:1px;transition:all .3s ease;border:none;display:inline-flex;align-items:center;gap:.5rem;white-space:nowrap;
  background:linear-gradient(135deg,#f0b85c,#d49a3a);color:#1a120a;
  box-shadow:none;
}
[data-fntv-carousel-style="2"] .fnos-s2-play:hover{background:linear-gradient(135deg,#f7c66e,#dfa844);transform:translateY(-2px);box-shadow:0 8px 20px rgba(212,160,76,.35)}
[data-fntv-carousel-style="2"] .fnos-s2-detail{
  padding:.85rem 1.8rem;border-radius:50px;font-weight:600;font-size:.95rem;cursor:pointer;
  letter-spacing:1px;transition:all .3s ease;border:1.5px solid rgba(210,180,140,.7);display:inline-flex;align-items:center;gap:.5rem;white-space:nowrap;
  background:rgba(20,15,10,.6);color:#f0e3ce;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
}
[data-fntv-carousel-style="2"] .fnos-s2-detail:hover{background:rgba(184,155,106,.25);border-color:#e3c08a;color:#fff7e8;transform:translateY(-2px)}
[data-fntv-carousel-style="2"] .fnos-s2-play:active,.fnos-s2-detail:active{transform:translateY(0) scale(.97)}
[data-fntv-carousel-style="2"] .fnos-s2-detail.is-loading{opacity:.6;pointer-events:none}
[data-fntv-carousel-style="2"] .fnos-s2-play.is-loading{opacity:.6;pointer-events:none}  /* [lc-900] PLAY 走二级路由加载态 */
[data-fntv-carousel-style="2"] .fnos-slider-footer{position:absolute;left:0;right:0;bottom:0;z-index:7;width:100%;box-sizing:border-box;display:flex;align-items:center;gap:1.2rem;padding:0 2.5rem 14px}
[data-fntv-carousel-style="2"] .fnos-progress-bar{flex:1;height:4px;background:rgba(255,255,255,.12);border-radius:4px;overflow:hidden;cursor:pointer;position:relative}
[data-fntv-carousel-style="2"] .fnos-progress-fill{height:100%;background:linear-gradient(90deg,#d4a04c,#f0b85c);border-radius:4px;width:0%;transform-origin:left center;transition:width .15s linear;box-shadow:0 0 10px rgba(240,184,92,.5)}
@keyframes fnos-progress-retract{0%{transform:scaleX(1)}100%{transform:scaleX(0)}}
[data-fntv-carousel-style="2"] .fnos-progress-retract{animation:fnos-progress-retract .7s cubic-bezier(.16,1,.3,1) both}
[data-fntv-carousel-style="2"] .fnos-dots{display:flex;gap:8px;align-items:center;flex:0 0 auto}
[data-fntv-carousel-style="2"] .fnos-dot{width:8px;height:8px;border-radius:50%;background:rgba(160,140,110,.4);border:1px solid rgba(255,255,255,.3);cursor:pointer;transition:all .35s cubic-bezier(.22,1,.36,1)}
[data-fntv-carousel-style="2"] .fnos-dot.active{background:#f0b85c;transform:scale(1.4);box-shadow:0 0 10px rgba(240,184,92,.6);border-color:#fff}
[data-fntv-carousel-style="2"] .fnos-carousel-frame{position:absolute;inset:0;border-radius:24px;pointer-events:none;z-index:6;box-shadow:inset 0 0 0 1px rgba(255,255,255,.12);-webkit-mask-image:radial-gradient(130% 100% at 50% 112%,#000 48%,transparent 100%);mask-image:radial-gradient(130% 100% at 50% 112%,#000 48%,transparent 100%)}
@media (max-width:800px){
  [data-fntv-carousel-style="2"] .fnos-slide-title{font-size:2.2rem}
  [data-fntv-carousel-style="2"] .fnos-slide-desc{font-size:.85rem;max-width:90%}
  [data-fntv-carousel-style="2"] .fnos-slide-content{padding:1.5rem 1.5rem 3.2rem}
  [data-fntv-carousel-style="2"] .fnos-slide-title-logo-img{max-height:84px;max-width:75%}
}
@media (prefers-reduced-motion: reduce){
  [data-fntv-carousel-style="2"] .fnos-slide-item,[data-fntv-carousel-style="2"] .fnos-slide-item.exit-left{transition:opacity .2s ease}
  [data-fntv-carousel-style="2"] .fnos-slide-item.active,[data-fntv-carousel-style="2"] .fnos-slide-item.exit-left,[data-fntv-carousel-style="2"] .fnos-slide-item.pre-enter{transform:none}
  [data-fntv-carousel-style="2"] .fnos-slide-meta,[data-fntv-carousel-style="2"] .fnos-slide-title,[data-fntv-carousel-style="2"] .fnos-slide-desc,[data-fntv-carousel-style="2"] .fnos-slide-actions{transition:opacity .2s ease;transform:none}
  [data-fntv-carousel-style="2"] .fnos-s2-play,[data-fntv-carousel-style="2"] .fnos-s2-detail{transition:background-color .15s ease}
  [data-fntv-carousel-style="2"] .fnos-s2-play:hover,[data-fntv-carousel-style="2"] .fnos-s2-detail:hover{transform:none}
}
`;
    (document.head || document.documentElement).appendChild(st);
  }

  // [lc-785] 布局：海报满铺、底部叠加进度条/轮播点。
  //   footer 改为【绝对定位叠在容器内底部】(z-index:7)，保证永不被推到屏外/被区块裁掉
  //   （之前作为 wrapper 兄弟节点追加，在高容器下被挤出可视区 → 进度条/轮播点"消失"）。
  //   顶部/左右去掉硬边框(接缝源)，仅保留底部柔和投影；frame 叠层做顶/侧渐影。
  // [lc-807] 高度与样式 1 一致(max-height:calc(100vh - 380px);aspect-ratio:16/9)，宽度不变(100%)
  container.style.width = '100%';
  container.style.height = '';
  container.style.minHeight = '0';
  container.style.maxHeight = 'calc(100vh - 380px)';
  container.style.border = 'none';
  // 仅底部柔和投影：负扩散(-12px)把光往下压，减少向上/左右溢出 → 顶/侧不再有"框"感
  container.style.boxShadow = '0 26px 60px -12px rgba(0,0,0,.55)';
  container.style.aspectRatio = '16 / 9';
  container.style.margin = '0';
  container.style.background = 'transparent';
  // frame 叠层：底部可见、顶/侧渐隐的描边(替代原硬边框)，实现"渐影消掉"
  const frame = document.createElement('div');
  frame.className = 'fnos-carousel-frame';
  container.appendChild(frame);

  // 每片主题色（按 demo 的五色循环，给顶部 logo 胶囊上色）
  const accents = [
    { border: '#6eb5ff', text: '#eaf4ff' },
    { border: '#d69b6a', text: '#fcead8' },
    { border: '#b08fe0', text: '#f0e6ff' },
    { border: '#5fb0a8', text: '#e0fcf7' },
    { border: '#e08585', text: '#ffe8e8' },
  ];

  const track = document.createElement('div');
  track.className = 'fnos-slide-track';
  container.appendChild(track);

  const slides: HTMLElement[] = [];
  const dotsEls: HTMLElement[] = [];

  shows.forEach((show, i) => {
    const accent = accents[i % accents.length];
    const slide = document.createElement('div');
    slide.className = 'fnos-slide-item' + (i === 0 ? ' active' : ' pre-enter');
    slide.setAttribute('data-index', String(i));

    // 背景：先渐变兜底，真实 backdrop 加载成功后替换
    const slideBg = document.createElement('div');
    slideBg.className = 'fnos-slide-bg';
    slideBg.style.backgroundImage = `linear-gradient(160deg, ${accent.border}55, #0b1219)`;
    slide.appendChild(slideBg);

    // 内容区（标题/简介用 textContent，避免 HTML 注入）
    const content = document.createElement('div');
    content.className = 'fnos-slide-content';
    const genreArr: string[] = (show as any).genres || [];
    // [lc-795] 标题上方不再显示年份，仅保留类型标签
    const meta = (genreArr[0] || '').toUpperCase();
    content.innerHTML =
      '<div class="fnos-slide-meta"></div>' +
      '<div class="fnos-slide-title"></div>' +
      '<div class="fnos-slide-desc"></div>' +
      '<div class="fnos-slide-actions">' +
        '<button class="fnos-s2-play" type="button">开始播放</button>' +
        '<button class="fnos-s2-detail" type="button">更多详情</button>' +
      '</div>';
    const titleEl = content.querySelector('.fnos-slide-title') as HTMLElement;
    (content.querySelector('.fnos-slide-meta') as HTMLElement).textContent = meta;
    (content.querySelector('.fnos-slide-meta') as HTMLElement).style.display = meta ? '' : 'none';
    titleEl.textContent = (show as any).title || '';
    (content.querySelector('.fnos-slide-desc') as HTMLElement).textContent = (show as any).desc || '';
    slide.appendChild(content);

    // [lc-795] 有剧集 logo 时直接替换标题文字为 logo 图；无则保留放大后的文字标题
    resolveShowLogo(show, base).then((src) => {
      if (!src) return;
      titleEl.textContent = '';
      titleEl.classList.add('fnos-slide-title--logo');
      const logoImg = document.createElement('img');
      logoImg.className = 'fnos-slide-title-logo-img';
      logoImg.alt = (show as any).title || '';
      logoImg.src = src;
      titleEl.appendChild(logoImg);
    });
    track.appendChild(slide);
    slides.push(slide);

    // [lc-933] 复用首拉已校验横版的 _backdropBlob(零网络, 规避 s.backdrop 二次拉取返回竖版/错位图)
    applyCarouselBackdrop(show, slideBg, base);

    // 按钮行为（沿用飞牛 SPA 路由）
    const playBtn = content.querySelector('.fnos-s2-play') as HTMLElement | null;
    const detailBtn = content.querySelector('.fnos-s2-detail') as HTMLElement | null;
    const spaNav = (href: string): void => {
      history.pushState({}, '', href);
      window.dispatchEvent(new PopStateEvent('popstate'));
      setTimeout(() => {
        // [lc-941] 仅当 fnOS 确实未接管导航时才兜底整页跳转。
        // 旧逻辑用「返回按钮是否存在」单一判定: 详情页加载慢(>600ms 才出返回键)会误判为未接管 → location.href 整页刷新,
        // 导致返回首页时模块重载、S.apiShows/_backdropBlob 被重置 → 轮播海报不显示(原生卡片进详情不经此路径故正常)。
        // 现改双重判定「首页轮播仍可见 且 详情返回键未出现」才视为未接管; fnOS 已接管后 hideStaleViews 会把首页视图
        // display:none, 轮播 getBoundingClientRect 为 0 → 绝不整页刷新。
        const backBtn = !!document.querySelector('button[aria-label="返回"]');
        // [lc-944] 兜底判据改为「季页内容是否真渲染」, 修复 lc-941 引入的白屏:
        //   fnOS 收合成 popstate 后可能进入半死状态(首页被隐藏→轮播尺寸归零, 但季页内容未渲染、返回键也未出现),
        //   旧 carouselVisible 判定此时为 false → 兜底不触发 → 整页卡白屏。
        //   现以「返回键 或 季页内容(选集卡/演职人员/剧集信息卡)任一存在」作为 fnOS 已接管的判据:
        //   已接管→不整页刷新(保留轮播数据); 未接管(两者皆无)→整页跳转救活, 杜绝白屏。
        const seasonRendered = !!document.querySelector('[data-id="details"]')
          || !!document.querySelector('.fnos-season-2col')
          || !!document.querySelector('a[href*="/v/person/"]');
        if (!backBtn && !seasonRendered) location.href = href;
      }, 600);
    };
    // [lc-900] PLAY 默认进二级详情页(与 DETAIL 同构)
    if (playBtn) playBtn.addEventListener('click', () => { playBtn.classList.add('is-loading'); resolveSeasonHref(show).then((href) => { playBtn.classList.remove('is-loading'); spaNav(href); }); });
    if (detailBtn) detailBtn.addEventListener('click', () => {
      detailBtn.classList.add('is-loading');
      resolveSeasonHref(show).then((href) => { detailBtn.classList.remove('is-loading'); spaNav(href); });
    });
  });

  // 底部 footer：进度条 + 指示点（样式 2 不显示自动播放提示文字）
  const footer = document.createElement('div');
  footer.className = 'fnos-slider-footer';
  const progressBar = document.createElement('div');
  progressBar.className = 'fnos-progress-bar';
  const progressFill = document.createElement('div');
  progressFill.className = 'fnos-progress-fill';
  progressBar.appendChild(progressFill);
  const dots = document.createElement('div');
  dots.className = 'fnos-dots';
  slides.forEach((_, i) => {
    const d = document.createElement('span');
    d.className = 'fnos-dot' + (i === 0 ? ' active' : '');
    d.setAttribute('data-index', String(i));
    dots.appendChild(d);
    dotsEls.push(d);
  });
  footer.appendChild(progressBar);
  footer.appendChild(dots);
  container.appendChild(footer); // [lc-785] 绝对定位叠在容器内底部，永不被推走

  // ---------- 交互逻辑（移植自 demo）----------
  let currentIndex = 0;
  let autoTimer: number | null = null;
  let progressInterval: number | null = null;
  let progress = 0;
  let isPaused = false;
  let retracting = false;
  let pendingStart = false; // [lc-803] 回缩期间若触发 startProgress，延后到回缩结束再真正开始填充
  const AUTO_DELAY = 6000;

  const updateSlides = (): void => {
    slides.forEach((slide, idx) => {
      slide.classList.remove('active', 'exit-left', 'pre-enter');
      if (idx === currentIndex) slide.classList.add('active');
      else if (idx < currentIndex || (currentIndex === 0 && idx === slides.length - 1)) slide.classList.add('exit-left');
      else slide.classList.add('pre-enter');
    });
    dotsEls.forEach((d, idx) => d.classList.toggle('active', idx === currentIndex));
    // [lc-793] 不在此重置进度条 DOM：交给 startProgress / playRetract 统一管理，
    //           避免回缩动画进行中被 updateSlides 的宽度重置打断，导致进度条与封面脱节
  };

  const goTo = (idx: number): void => {
    let n = idx;
    if (n < 0) n = slides.length - 1;
    if (n >= slides.length) n = 0;
    currentIndex = n;
    updateSlides();
    if (!isPaused) startProgress();
  };
  const nextSlide = (): void => goTo(currentIndex + 1);
  const prevSlide = (): void => goTo(currentIndex - 1);

  // [lc-793] 满格后弹性慢缩回：transform scaleX 做带回弹的收缩动画(0.8s)。
  //           与封面切换并行（见 startProgress 满格分支），回缩结束后再重新填充——节奏一致。
  const playRetract = (): void => {
    retracting = true;
    progressFill.style.transition = 'none';
    progressFill.style.transform = 'scaleX(1)';
    progressFill.style.width = '100%';
    void progressFill.offsetWidth; // 强制回流，确保动画从头播放
    progressFill.classList.add('fnos-progress-retract');
  };
  progressFill.addEventListener('animationend', () => {
    if (!progressFill.classList.contains('fnos-progress-retract')) return;
    progressFill.classList.remove('fnos-progress-retract');
    retracting = false;
    progressFill.style.transition = 'none';
    progressFill.style.transform = 'scaleX(1)';
    progressFill.style.width = '0%';
    void progressFill.offsetWidth;
    progressFill.style.transition = 'width .1s linear';
    // [lc-803] 封面已在满格瞬间同步切换；回缩结束只负责重新开始填充（若期间被触发过）
    if (pendingStart) { pendingStart = false; startProgress(); }
  });

  const startProgress = (): void => {
    if (retracting) { pendingStart = true; return; } // [lc-803] 回缩进行中：延后到回缩结束再开始填充（封面已切，不阻塞）
    if (progressInterval) clearInterval(progressInterval);
    progressFill.classList.remove('fnos-progress-retract');
    progress = 0;
    progressFill.style.transition = 'none';
    progressFill.style.transform = 'scaleX(1)';
    progressFill.style.width = '0%';
    void progressFill.offsetWidth;
    progressFill.style.transition = 'width .1s linear';
    const stepTime = 50;
    const increment = 100 / (AUTO_DELAY / stepTime);
    progressInterval = window.setInterval(() => {
      if (isPaused) return;
      progress += increment;
      if (progress >= 100) {
        progress = 100;
        progressFill.style.width = '100%';
        if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
        // [lc-803] 满格瞬间：先播回缩(设 retracting=true)，再同步切页(nextSlide 经 pendingStart 延后填充)，
        //          封面与进度条满格严格同步，回缩仅作进度条归零过渡，不再阻塞切换
        playRetract();
        nextSlide();
      } else {
        progressFill.style.width = progress + '%';
      }
    }, stepTime);
  };
  const startAuto = (): void => {
    // [lc-789] 由进度条驱动切换：不再用独立 autoTimer 抢在满格前重置（会导致进度条永远走不到 100%、回缩动画没机会播），
    //           满格后的弹性回缩 + 切页统一由 startProgress → playRetract → animationend 完成。
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    startProgress();
  };
  const stopAuto = (): void => {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
  };

  dotsEls.forEach((d) => {
    d.addEventListener('click', () => {
      const idx = parseInt(d.getAttribute('data-index') || '0', 10);
      goTo(idx);
      if (!isPaused) { stopAuto(); startAuto(); }
    });
  });
  progressBar.addEventListener('click', (e: MouseEvent) => {
    const rect = progressBar.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    const targetIdx = Math.floor(percent * slides.length);
    goTo(Math.min(Math.max(targetIdx, 0), slides.length - 1));
    if (!isPaused) { stopAuto(); startAuto(); }
  });
  container.addEventListener('mouseenter', () => { isPaused = true; stopAuto(); });
  container.addEventListener('mouseleave', () => { isPaused = false; startAuto(); });
  let touchX = 0;
  container.addEventListener('touchstart', (e: TouchEvent) => { touchX = e.changedTouches[0].screenX; isPaused = true; stopAuto(); }, { passive: true });
  container.addEventListener('touchend', (e: TouchEvent) => {
    const diff = touchX - e.changedTouches[0].screenX;
    if (Math.abs(diff) > 40) { if (diff > 0) nextSlide(); else prevSlide(); }
    isPaused = false; startAuto();
  }, { passive: true });
  const keyHandler = (e: KeyboardEvent): void => {
    if (!document.body.contains(container)) { window.removeEventListener('keydown', keyHandler); return; }
    const rect = container.getBoundingClientRect();
    if (rect.top >= window.innerHeight || rect.bottom <= 0) return; // 仅在轮播可见时响应
    if (e.key === 'ArrowRight') { nextSlide(); if (!isPaused) { stopAuto(); startAuto(); } }
    else if (e.key === 'ArrowLeft') { prevSlide(); if (!isPaused) { stopAuto(); startAuto(); } }
  };
  window.addEventListener('keydown', keyHandler);

  updateSlides();
  startAuto();
  // [lc-876] 页面隐藏时暂停进度条timer（fnOS SPA导航可能只隐藏不销毁首页视图），
  //   防止隐藏期间 progressInterval 继续跑 → 满格切页 → 回来后状态错乱
  const visHandler = (): void => {
    if (document.hidden) { isPaused = true; stopAuto(); }
    else { isPaused = false; startAuto(); }
  };
  document.addEventListener('visibilitychange', visHandler);
  // [lc-876] 注册清理句柄：SPA导航离开/重建前销毁所有timer + event listener
  S.carouselCleanup = (): void => {
    stopAuto(); // 清 autoTimer + progressInterval
    window.removeEventListener('keydown', keyHandler);
    document.removeEventListener('visibilitychange', visHandler);
    log2('cleanup: style2 timers & listeners destroyed');
  };
  // [lc-946] 复用轮播时重启自动轮播(返回首页不重建 DOM); 同时补回被 cleanup 移除的键盘/可见性监听器(同引用 addEventListener 去重)
  S.carouselResume = (): void => { if (!document.body.contains(container)) return; window.addEventListener('keydown', keyHandler); document.addEventListener('visibilitychange', visHandler); startAuto(); };
  log2('样式2 轮播注入完成, slides=', slides.length);
}

// [lc-809] 样式 3：堆叠卡片式轮播（照抄 demo 的卡片交互方式）。
//   视觉：所有卡片 position:absolute;inset:0 叠放，靠 .active/.prev/.next/.behind 类切换
//        前后卡片在左右后方倾斜露出的堆叠感；容器 overflow:visible 让 prev/next 露出。
//   交互：自动轮播(setInterval) + 指示点 + 悬停暂停 + 触摸滑动 + 键盘左右（均移植自 demo）。
//   数据/导航：复用真实片库 shows、fetchImageAuth 拉横版背景、resolveShowLogo 取剧集 logo、
//            spaNav(飞牛 SPA 路由)。高度与样式1/2 一致，避免加载完高度跳变。
export function buildCarouselStyle3(
  container: HTMLElement,
  wrapper: HTMLElement,
  shows: any[],
  base: string,
  rebuild: boolean
): void {
  const log3 = (...a: any[]) => log('[s3]', ...a);

  const imgUrl = (p: string, w?: number) => {
    if (!p) return '';
    if (p.startsWith('http') || p.startsWith('/v/api/')) return p + (w ? '?w=' + w : '');
    return `${base}/v/api/v1/${p}` + (w ? '?w=' + w : '');
  };

  // 一次性注入样式（scoped 到样式 3）
  if (!document.getElementById('fnos-carousel-style3-style')) {
    const st = document.createElement('style');
    st.id = 'fnos-carousel-style3-style';
    st.textContent = `
[data-fntv-carousel-style="3"] .fntv-s3-stack{position:relative;width:100%;height:100%;perspective:1600px;perspective-origin:50% 40%}
[data-fntv-carousel-style="3"] .fntv-s3-card{
  position:absolute;inset:0;border-radius:24px;overflow:hidden;
  box-shadow:none;
  transition:transform .85s cubic-bezier(.22,1,.36,1),opacity .7s cubic-bezier(.4,0,.2,1),filter .7s ease;
  opacity:0;transform:translateY(80px) scale(.85) rotateX(8deg);transform-origin:center bottom;
  z-index:1;will-change:transform,opacity,filter;
  border:1px solid rgba(255,255,255,.1);background:#1e1b17;cursor:pointer;
}
[data-fntv-carousel-style="3"] .fntv-s3-card.active{
  opacity:1;transform:translateY(0) scale(1) rotateX(0deg);z-index:10;filter:brightness(1);
  box-shadow:none;
  transition:transform .9s cubic-bezier(.22,1,.36,1),opacity .7s ease,filter .7s ease;
}
[data-fntv-carousel-style="3"] .fntv-s3-card.prev{opacity:0;transform:translateX(-40px) scale(.92);z-index:7;filter:blur(2px) brightness(.6);pointer-events:none}
[data-fntv-carousel-style="3"] .fntv-s3-card.next{opacity:0;transform:translateX(40px) scale(.92);z-index:7;filter:blur(2px) brightness(.6);pointer-events:none}
[data-fntv-carousel-style="3"] .fntv-s3-card.behind1{opacity:.4;transform:translateY(-48px) scale(.9) rotateX(-5deg);transform-origin:center top;z-index:5;filter:blur(1.5px) brightness(.65)}
[data-fntv-carousel-style="3"] .fntv-s3-card.behind2{opacity:.3;transform:translateY(-82px) scale(.83) rotateX(-7deg);transform-origin:center top;z-index:4;filter:blur(2px) brightness(.55)}
[data-fntv-carousel-style="3"] .fntv-s3-card.deep{opacity:.2;transform:translateY(-110px) scale(.78) rotateX(-9deg);transform-origin:center top;z-index:3;filter:blur(2.5px) brightness(.45);pointer-events:none}
[data-fntv-carousel-style="3"] .fntv-s3-card.behind{opacity:0;transform:translateY(-120px) scale(.7);z-index:1;pointer-events:none}
[data-fntv-carousel-style="3"] .fntv-s3-bg{width:100%;height:100%;background-size:cover;background-position:center;position:relative;display:flex;align-items:flex-end;padding:2rem;transform:scale(1.08);transition:transform 2.2s cubic-bezier(.25,.8,.25,1)}
[data-fntv-carousel-style="3"] .fntv-s3-card.active .fntv-s3-bg{transform:scale(1)}
[data-fntv-carousel-style="3"] .fntv-s3-bg::before{content:'';position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.92) 0%,rgba(0,0,0,.5) 40%,rgba(0,0,0,.15) 70%,rgba(0,0,0,.03) 100%)}
[data-fntv-carousel-style="3"] .fntv-s3-info h3.fntv-s3-title--logo{background:none;-webkit-background-clip:border-box;background-clip:border-box;-webkit-text-fill-color:initial;color:#fff;filter:none;display:block;margin-bottom:.4rem;line-height:1.1}
[data-fntv-carousel-style="3"] .fntv-s3-title-logo-img{max-height:100px;max-width:64%;width:auto;height:auto;display:block;object-fit:contain;filter:drop-shadow(0 4px 18px rgba(0,0,0,.7))}
[data-fntv-carousel-style="3"] .fntv-s3-info{position:absolute;left:0;right:0;bottom:0;z-index:3;color:#fff;padding:2rem 2rem 3rem;box-sizing:border-box}
[data-fntv-carousel-style="3"] .fntv-s3-info .meta{font-size:.72rem;letter-spacing:2px;color:#d4b48c;margin-bottom:.4rem;text-transform:uppercase;opacity:0;transform:translateY(18px);transition:opacity .6s ease .45s,transform .6s cubic-bezier(.22,1,.36,1) .45s}
[data-fntv-carousel-style="3"] .fntv-s3-info h3{font-size:2rem;font-weight:700;letter-spacing:1px;margin-bottom:.4rem;line-height:1.15;word-break:break-word;background:var(--fnos-hero-title-grad);-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;filter:var(--fnos-hero-title-glow);opacity:0;transform:translateY(22px);transition:opacity .6s ease .55s,transform .6s cubic-bezier(.22,1,.36,1) .55s}
[data-fntv-carousel-style="3"] .fntv-s3-info .desc{font-size:.95rem;color:#e2d7c5;line-height:1.55;text-shadow:0 2px 8px rgba(0,0,0,.7);max-width:520px;margin-bottom:1rem;opacity:0;transform:translateY(22px);transition:opacity .6s ease .65s,transform .6s cubic-bezier(.22,1,.36,1) .65s}
[data-fntv-carousel-style="3"] .fntv-s3-actions{display:flex;gap:.7rem;flex-wrap:wrap;opacity:0;transform:translateY(18px);transition:opacity .6s ease .75s,transform .6s cubic-bezier(.22,1,.36,1) .75s}
[data-fntv-carousel-style="3"] .fntv-s3-card.active .fntv-s3-info .meta{opacity:1;transform:translateY(0)}
[data-fntv-carousel-style="3"] .fntv-s3-card.active .fntv-s3-info h3{opacity:1;transform:translateY(0)}
[data-fntv-carousel-style="3"] .fntv-s3-card.active .fntv-s3-info .desc{opacity:1;transform:translateY(0)}
[data-fntv-carousel-style="3"] .fntv-s3-card.active .fntv-s3-actions{opacity:1;transform:translateY(0)}
[data-fntv-carousel-style="3"] .fntv-s3-play{padding:.8rem 1.6rem;border-radius:50px;font-weight:600;font-size:.9rem;cursor:pointer;letter-spacing:.8px;transition:all .3s ease;border:none;display:inline-flex;align-items:center;gap:.4rem;white-space:nowrap;background:linear-gradient(135deg,#f0b85c,#d49a3a);color:#1a120a;box-shadow:0 6px 18px rgba(212,160,76,.4)}
[data-fntv-carousel-style="3"] .fntv-s3-play:hover{background:linear-gradient(135deg,#f7c66e,#dfa844);transform:translateY(-2px);box-shadow:0 10px 24px rgba(212,160,76,.55)}
[data-fntv-carousel-style="3"] .fntv-s3-detail{padding:.8rem 1.6rem;border-radius:50px;font-weight:600;font-size:.9rem;cursor:pointer;letter-spacing:.8px;transition:all .3s ease;border:1.5px solid rgba(210,180,140,.7);display:inline-flex;align-items:center;gap:.4rem;white-space:nowrap;background:rgba(20,15,10,.6);color:#f0e3ce;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
[data-fntv-carousel-style="3"] .fntv-s3-detail:hover{background:rgba(184,155,106,.25);border-color:#e3c08a;color:#fff7e8;transform:translateY(-2px)}
[data-fntv-carousel-style="3"] .fntv-s3-play:active,[data-fntv-carousel-style="3"] .fntv-s3-detail:active{transform:translateY(0) scale(.97)}
[data-fntv-carousel-style="3"] .fntv-s3-detail.is-loading{opacity:.6;pointer-events:none}
[data-fntv-carousel-style="3"] .fntv-s3-play.is-loading{opacity:.6;pointer-events:none}  /* [lc-900] PLAY 走二级路由加载态 */
[data-fntv-carousel-style="3"] .fntv-s3-dots{position:absolute;left:0;right:0;bottom:14px;z-index:11;display:flex;justify-content:center;gap:10px}
[data-fntv-carousel-style="3"] .fntv-s3-dot{width:8px;height:8px;border-radius:50%;background:rgba(160,140,110,.4);border:1px solid rgba(255,255,255,.3);cursor:pointer;transition:all .35s cubic-bezier(.22,1,.36,1)}
[data-fntv-carousel-style="3"] .fntv-s3-dot.active{background:#f0b85c;transform:scale(1.4);box-shadow:0 0 10px rgba(240,184,92,.6);border-color:#fff}
/* [lc-811] .fntv-s3-hint 已弃用(底部"自动轮播中"提示移除) */
@media (max-width:800px){
  [data-fntv-carousel-style="3"] .fntv-s3-info{padding:1.5rem 1.5rem 2.4rem}
  [data-fntv-carousel-style="3"] .fntv-s3-info h3{font-size:1.5rem}
  [data-fntv-carousel-style="3"] .fntv-s3-info .desc{font-size:.85rem}
  [data-fntv-carousel-style="3"] .fntv-s3-title-logo-img{max-height:84px}
  [data-fntv-carousel-style="3"] .fntv-s3-bg{padding:1.5rem}
}
@media (max-width:500px){
  [data-fntv-carousel-style="3"] .fntv-s3-info{padding:1.2rem 1.2rem 2rem}
  [data-fntv-carousel-style="3"] .fntv-s3-info h3{font-size:1.3rem}
  [data-fntv-carousel-style="3"] .fntv-s3-title-logo-img{max-height:64px}
  [data-fntv-carousel-style="3"] .fntv-s3-actions{flex-direction:column;align-items:flex-start}
  [data-fntv-carousel-style="3"] .fntv-s3-play,[data-fntv-carousel-style="3"] .fntv-s3-detail{padding:.6rem 1.2rem;font-size:.8rem}
}
@media (prefers-reduced-motion: reduce){
  [data-fntv-carousel-style="3"] .fntv-s3-card{transition:opacity .2s ease}
  [data-fntv-carousel-style="3"] .fntv-s3-card.active,[data-fntv-carousel-style="3"] .fntv-s3-card.prev,[data-fntv-carousel-style="3"] .fntv-s3-card.next,[data-fntv-carousel-style="3"] .fntv-s3-card.behind1,[data-fntv-carousel-style="3"] .fntv-s3-card.behind2,[data-fntv-carousel-style="3"] .fntv-s3-card.deep,[data-fntv-carousel-style="3"] .fntv-s3-card.behind{transform:none}
  [data-fntv-carousel-style="3"] .fntv-s3-info .meta,[data-fntv-carousel-style="3"] .fntv-s3-info h3,[data-fntv-carousel-style="3"] .fntv-s3-info .desc,[data-fntv-carousel-style="3"] .fntv-s3-actions{transition:opacity .2s ease;transform:none}
  [data-fntv-carousel-style="3"] .fntv-s3-play,[data-fntv-carousel-style="3"] .fntv-s3-detail{transition:background-color .15s ease}
  [data-fntv-carousel-style="3"] .fntv-s3-play:hover,[data-fntv-carousel-style="3"] .fntv-s3-detail:hover{transform:none}
}
`;
    (document.head || document.documentElement).appendChild(st);
  }

  // 布局：堆叠卡片容器（高度与样式1/2 一致，避免加载完高度跳变）
  // [lc-807 同款] 与样式1/2 同样 max-height:calc(100vh-380px);aspect-ratio:16/9；overflow:visible 让 prev/next 在左右后方露出堆叠感
  wrapper.style.cssText = 'display:block;padding:0 44px;margin-top:0;margin-bottom:0';
  container.style.width = '100%';
  container.style.height = '';
  container.style.minHeight = '0';
  container.style.maxHeight = 'calc(100vh - 380px)';
  container.style.border = 'none';
  container.style.boxShadow = '0 26px 60px -12px rgba(0,0,0,.55)';
  container.style.aspectRatio = '16 / 9';
  container.style.margin = '0';
  container.style.background = 'transparent';
  container.style.overflow = 'visible'; // [s3] 让 prev/next 在左右后方露出堆叠感

  const accents = ['#6eb5ff', '#d69b6a', '#b08fe0', '#5fb0a8', '#e08585'];

  const stack = document.createElement('div');
  stack.className = 'fntv-s3-stack';
  container.appendChild(stack);

  const cards: HTMLElement[] = [];
  const dotsEls: HTMLElement[] = [];

  shows.forEach((show, i) => {
    const accent = accents[i % accents.length];
    const card = document.createElement('div');
    card.className = 'fntv-s3-card' + (i === 0 ? ' active' : ' behind');
    card.setAttribute('data-index', String(i));

    // 背景：先渐变兜底，真实 backdrop 加载成功后替换
    const bg = document.createElement('div');
    bg.className = 'fntv-s3-bg';
    bg.style.backgroundImage = `linear-gradient(160deg, ${accent}55, #0b1219)`;
    card.appendChild(bg);

    const genreArr: string[] = (show as any).genres || [];

    // 内容区（标题/简介用 textContent，避免 HTML 注入）
    const info = document.createElement('div');
    info.className = 'fntv-s3-info';
    const meta = (genreArr[0] || '').toUpperCase();
    info.innerHTML =
      '<div class="meta"></div>' +
      '<h3></h3>' +
      '<div class="desc"></div>' +
      '<div class="fntv-s3-actions">' +
        '<button class="fntv-s3-play" type="button">开始播放</button>' +
        '<button class="fntv-s3-detail" type="button">更多详情</button>' +
      '</div>';
    (info.querySelector('.meta') as HTMLElement).textContent = meta;
    (info.querySelector('.meta') as HTMLElement).style.display = meta ? '' : 'none';
    const titleEl = info.querySelector('h3') as HTMLElement;
    titleEl.textContent = (show as any).title || '';
    (info.querySelector('.desc') as HTMLElement).textContent = (show as any).desc || '';
    card.appendChild(info);

    // [lc-817] 标题用 logo 替换，跟样式2 一致：有 logo 则清空文字、塞 logo 图；无 logo 则保留彩色渐变文字标题
    resolveShowLogo(show, base).then((src) => {
      if (!src) return;
      titleEl.textContent = '';
      titleEl.classList.add('fntv-s3-title--logo');
      const logoImg = document.createElement('img');
      logoImg.className = 'fntv-s3-title-logo-img';
      logoImg.alt = (show as any).title || '';
      logoImg.src = src;
      titleEl.appendChild(logoImg);
    });

    // [lc-933] 复用首拉已校验横版的 _backdropBlob(零网络, 规避 s.backdrop 二次拉取返回竖版/错位图)
    applyCarouselBackdrop(show, bg, base);

    // 按钮行为（沿用飞牛 SPA 路由）
    const playBtn = info.querySelector('.fntv-s3-play') as HTMLElement | null;
    const detailBtn = info.querySelector('.fntv-s3-detail') as HTMLElement | null;
    const spaNav = (href: string): void => {
      history.pushState({}, '', href);
      window.dispatchEvent(new PopStateEvent('popstate'));
      setTimeout(() => {
        // [lc-941] 仅当 fnOS 确实未接管导航时才兜底整页跳转。
        // 旧逻辑用「返回按钮是否存在」单一判定: 详情页加载慢(>600ms 才出返回键)会误判为未接管 → location.href 整页刷新,
        // 导致返回首页时模块重载、S.apiShows/_backdropBlob 被重置 → 轮播海报不显示(原生卡片进详情不经此路径故正常)。
        // 现改双重判定「首页轮播仍可见 且 详情返回键未出现」才视为未接管; fnOS 已接管后 hideStaleViews 会把首页视图
        // display:none, 轮播 getBoundingClientRect 为 0 → 绝不整页刷新。
        const backBtn = !!document.querySelector('button[aria-label="返回"]');
        // [lc-944] 兜底判据改为「季页内容是否真渲染」, 修复 lc-941 引入的白屏:
        //   fnOS 收合成 popstate 后可能进入半死状态(首页被隐藏→轮播尺寸归零, 但季页内容未渲染、返回键也未出现),
        //   旧 carouselVisible 判定此时为 false → 兜底不触发 → 整页卡白屏。
        //   现以「返回键 或 季页内容(选集卡/演职人员/剧集信息卡)任一存在」作为 fnOS 已接管的判据:
        //   已接管→不整页刷新(保留轮播数据); 未接管(两者皆无)→整页跳转救活, 杜绝白屏。
        const seasonRendered = !!document.querySelector('[data-id="details"]')
          || !!document.querySelector('.fnos-season-2col')
          || !!document.querySelector('a[href*="/v/person/"]');
        if (!backBtn && !seasonRendered) location.href = href;
      }, 600);
    };
    // [lc-900] PLAY 默认进二级详情页(与 DETAIL 同构)
    if (playBtn) playBtn.addEventListener('click', (e: MouseEvent) => { e.stopPropagation(); playBtn.classList.add('is-loading'); resolveSeasonHref(show).then((href) => { playBtn.classList.remove('is-loading'); spaNav(href); }); });
    if (detailBtn) detailBtn.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      detailBtn.classList.add('is-loading');
      resolveSeasonHref(show).then((href) => { detailBtn.classList.remove('is-loading'); spaNav(href); });
    });

    stack.appendChild(card);
    cards.push(card);
  });

  // 指示点（海报容器内部、居中最下方；挂在 stack 内绝对定位贴底）
  const dotsRow = document.createElement('div');
  dotsRow.className = 'fntv-s3-dots';
  cards.forEach((_, i) => {
    const d = document.createElement('span');
    d.className = 'fntv-s3-dot' + (i === 0 ? ' active' : '');
    d.setAttribute('data-index', String(i));
    dotsRow.appendChild(d);
    dotsEls.push(d);
  });
  stack.appendChild(dotsRow);
  // [lc-811] 底部"自动轮播中"提示已移除

  // ---------- 交互逻辑（移植自 demo：堆叠卡片）----------
  let currentIndex = 0;
  let autoTimer: number | null = null;
  const AUTO_DELAY = 4500;

  const updatePositions = (): void => {
    const n = cards.length;
    cards.forEach((card, idx) => {
      card.classList.remove('active', 'prev', 'next', 'behind', 'behind1', 'behind2', 'deep');
      const diff = (idx - currentIndex + n) % n; // 距当前卡正向深度
      if (diff === 0) card.classList.add('active');
      else if (diff === n - 1) card.classList.add('prev');        // 上一张：左后方
      else if (diff === 1) card.classList.add('next');             // 下一张：右后方
      else if (diff === 2) card.classList.add('behind1');          // 后一层：居中下沉
      else if (diff === 3) card.classList.add('behind2');          // 再后一层：继续下沉
      else card.classList.add('deep');                             // 最底层：露出最大边缘
    });
    dotsEls.forEach((d, idx) => d.classList.toggle('active', idx === currentIndex));
  };

  const goTo = (idx: number): void => {
    let n = idx;
    if (n < 0) n = cards.length - 1;
    if (n >= cards.length) n = 0;
    currentIndex = n;
    updatePositions();
  };

  const resetAuto = (): void => {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = window.setInterval(() => {
      // [s3] rebuild/卸载后自动停，避免旧闭包 interval 泄漏
      if (!document.body.contains(container)) {
        if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
        return;
      }
      currentIndex = (currentIndex + 1) % cards.length;
      updatePositions();
    }, AUTO_DELAY);
  };
  const stopAuto = (): void => {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  };

  dotsEls.forEach((d) => {
    d.addEventListener('click', () => {
      goTo(parseInt(d.getAttribute('data-index') || '0', 10));
      resetAuto();
    });
  });

  // 触摸滑动
  let touchX = 0;
  container.addEventListener('touchstart', (e: TouchEvent) => { touchX = e.changedTouches[0].screenX; stopAuto(); }, { passive: true });
  container.addEventListener('touchend', (e: TouchEvent) => {
    const diff = touchX - e.changedTouches[0].screenX;
    if (Math.abs(diff) > 40) { if (diff > 0) goTo(currentIndex + 1); else goTo(currentIndex - 1); }
    resetAuto();
  }, { passive: true });

  // 键盘导航（仅在轮播可见时响应，移除后自动解绑）
  const keyHandler = (e: KeyboardEvent): void => {
    if (!document.body.contains(container)) { window.removeEventListener('keydown', keyHandler); return; }
    const rect = container.getBoundingClientRect();
    if (rect.top >= window.innerHeight || rect.bottom <= 0) return;
    if (e.key === 'ArrowRight') { goTo(currentIndex + 1); resetAuto(); }
    else if (e.key === 'ArrowLeft') { goTo(currentIndex - 1); resetAuto(); }
  };
  window.addEventListener('keydown', keyHandler);

  updatePositions();
  resetAuto();
  // [lc-876] 页面隐藏时暂停自动轮播
  const visHandler = (): void => { if (document.hidden) stopAuto(); else resetAuto(); };
  document.addEventListener('visibilitychange', visHandler);
  // [lc-876] 注册清理句柄
  S.carouselCleanup = (): void => {
    stopAuto(); // 清 autoTimer
    window.removeEventListener('keydown', keyHandler);
    document.removeEventListener('visibilitychange', visHandler);
    log3('cleanup: style3 timer & listeners destroyed');
  };
  // [lc-946] 复用轮播时重启自动轮播(返回首页不重建 DOM); 同时补回被 cleanup 移除的键盘/可见性监听器(同引用 addEventListener 去重)
  S.carouselResume = (): void => { if (!document.body.contains(container)) return; window.addEventListener('keydown', keyHandler); document.addEventListener('visibilitychange', visHandler); resetAuto(); };
  log3('样式3 堆叠卡片轮播注入完成, cards=', cards.length);
}

/* ========== 预加载优雅占位(替代硬编码 demo 无职转生) ========== */
// 真实片库未就绪时显示; 一旦 fetchShowsViaIPC 拉到数据, 上层 rebuild 机制会自动替换为真实轮播
// [lc-839+] 样式4 真实 CSS 提取为可重入函数: 真实轮播(buildCarouselStyle4) 与 加载骨架(buildLoadingPlaceholder 的 _cs===4 分支) 共用同一份,
// 避免骨架阶段 style4 css 尚未注入导致复用 .fntv-s4-* 类无样式。
export function ensureStyle4Css(): void {
  if (document.getElementById('fnos-carousel-style4-style')) return;
  const st = document.createElement('style');
  st.id = 'fnos-carousel-style4-style';
  st.textContent = `
[data-fntv-carousel-style="4"]{background:transparent;overflow:hidden;border-radius:24px;perspective:1700px}
[data-fntv-carousel-style="4"] .fntv-s4-track{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;transform-style:preserve-3d;transition:transform .9s cubic-bezier(.22,1,.36,1)}
[data-fntv-carousel-style="4"] .fntv-s4-card{
  position:absolute;left:7%;top:4%;width:86%;height:92%;
  border-radius:22px;overflow:hidden;
  box-shadow:0 30px 60px rgba(0,0,0,.42);
  transition:transform .85s cubic-bezier(.22,1,.36,1),opacity .7s ease,filter .7s ease,box-shadow .7s ease,visibility .7s;
  opacity:0;visibility:hidden;will-change:transform,opacity,filter;
  transform:scale(.82) translateX(42px) rotateY(10deg);
  border:1px solid rgba(255,255,255,.07);background:#1e1b17;cursor:pointer;
}
[data-fntv-carousel-style="4"] .fntv-s4-card.active{opacity:1;visibility:visible;transform:scale(1) translateX(0) rotateY(0deg);z-index:10;box-shadow:0 34px 80px rgba(0,0,0,.5)}
[data-fntv-carousel-style="4"] .fntv-s4-card.prev{opacity:.5;visibility:visible;transform:scale(.8) translateX(-72%) rotateY(30deg);z-index:5;filter:blur(1.5px) brightness(.82)}
[data-fntv-carousel-style="4"] .fntv-s4-card.next{opacity:.5;visibility:visible;transform:scale(.8) translateX(72%) rotateY(-30deg);z-index:5;filter:blur(1.5px) brightness(.82)}
[data-fntv-carousel-style="4"] .fntv-s4-card.far-left,[data-fntv-carousel-style="4"] .fntv-s4-card.far-right{opacity:0;visibility:hidden;transform:scale(.55) translateX(135%) rotateY(38deg);z-index:1}
[data-fntv-carousel-style="4"] .fntv-s4-bg{width:100%;height:100%;background-size:cover;background-position:center;position:relative;display:flex;align-items:flex-end;padding:2rem;transform:scale(1.08);transition:transform 3.6s cubic-bezier(.2,.7,.2,1)}
[data-fntv-carousel-style="4"] .fntv-s4-card.active .fntv-s4-bg{transform:scale(1)}
[data-fntv-carousel-style="4"] .fntv-s4-bg::before{content:'';position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.95) 0%,rgba(0,0,0,.5) 40%,rgba(0,0,0,.1) 70%,rgba(0,0,0,.02) 100%)}
[data-fntv-carousel-style="4"] .fntv-s4-info h3.fntv-s4-title--logo{background:none;-webkit-background-clip:border-box;background-clip:border-box;-webkit-text-fill-color:initial;color:#fff;filter:none;display:block;margin-bottom:.4rem;line-height:1.1}
[data-fntv-carousel-style="4"] .fntv-s4-title-logo-img{max-height:100px;max-width:64%;width:auto;height:auto;display:block;object-fit:contain;filter:drop-shadow(0 4px 18px rgba(0,0,0,.7))}
[data-fntv-carousel-style="4"] .fntv-s4-info{position:absolute;left:0;right:0;bottom:0;z-index:3;color:#fff;padding:2rem 2rem 3rem;box-sizing:border-box}
[data-fntv-carousel-style="4"] .fntv-s4-info .meta{font-size:.72rem;letter-spacing:2px;color:#d4b48c;margin-bottom:.4rem;text-transform:uppercase}
[data-fntv-carousel-style="4"] .fntv-s4-info h3{font-size:2rem;font-weight:700;letter-spacing:1px;margin-bottom:.4rem;line-height:1.15;word-break:break-word;background:var(--fnos-hero-title-grad);-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;filter:var(--fnos-hero-title-glow)}
[data-fntv-carousel-style="4"] .fntv-s4-info .desc{font-size:.95rem;color:#e2d7c5;line-height:1.55;text-shadow:0 2px 8px rgba(0,0,0,.7);max-width:520px;margin-bottom:1rem}
/* [lc-855] 文字逐级上浮(苹果式错峰入场): 元素基态微下移+透明, active 时依次归位 */
[data-fntv-carousel-style="4"] .fntv-s4-info .meta,[data-fntv-carousel-style="4"] .fntv-s4-info h3,[data-fntv-carousel-style="4"] .fntv-s4-info .desc,[data-fntv-carousel-style="4"] .fntv-s4-actions{opacity:0;transform:translateY(20px);transition:opacity .6s ease,transform .75s cubic-bezier(.22,1,.36,1)}
[data-fntv-carousel-style="4"] .fntv-s4-card.active .fntv-s4-info .meta{opacity:1;transform:translateY(0);transition-delay:.18s}
[data-fntv-carousel-style="4"] .fntv-s4-card.active .fntv-s4-info h3{opacity:1;transform:translateY(0);transition-delay:.26s}
[data-fntv-carousel-style="4"] .fntv-s4-card.active .fntv-s4-info .desc{opacity:1;transform:translateY(0);transition-delay:.34s}
[data-fntv-carousel-style="4"] .fntv-s4-card.active .fntv-s4-actions{opacity:1;transform:translateY(0);transition-delay:.42s}
[data-fntv-carousel-style="4"] .fntv-s4-actions{display:flex;gap:.7rem;flex-wrap:wrap}
[data-fntv-carousel-style="4"] .fntv-s4-play{padding:.8rem 1.6rem;border-radius:50px;font-weight:600;font-size:.9rem;cursor:pointer;letter-spacing:.8px;transition:all .3s ease;border:none;display:inline-flex;align-items:center;gap:.4rem;white-space:nowrap;background:linear-gradient(135deg,#f0b85c,#d49a3a);color:#1a120a;box-shadow:0 6px 18px rgba(212,160,76,.4)}
[data-fntv-carousel-style="4"] .fntv-s4-play:hover{background:linear-gradient(135deg,#f7c66e,#dfa844);transform:translateY(-2px);box-shadow:0 10px 24px rgba(212,160,76,.55)}
[data-fntv-carousel-style="4"] .fntv-s4-detail{padding:.8rem 1.6rem;border-radius:50px;font-weight:600;font-size:.9rem;cursor:pointer;letter-spacing:.8px;transition:all .3s ease;border:1.5px solid rgba(210,180,140,.7);display:inline-flex;align-items:center;gap:.4rem;white-space:nowrap;background:rgba(20,15,10,.6);color:#f0e3ce;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
[data-fntv-carousel-style="4"] .fntv-s4-detail:hover{background:rgba(184,155,106,.25);border-color:#e3c08a;color:#fff7e8;transform:translateY(-2px)}
[data-fntv-carousel-style="4"] .fntv-s4-play:active,[data-fntv-carousel-style="4"] .fntv-s4-detail:active{transform:translateY(0) scale(.97)}
[data-fntv-carousel-style="4"] .fntv-s4-detail.is-loading{opacity:.6;pointer-events:none}
[data-fntv-carousel-style="4"] .fntv-s4-play.is-loading{opacity:.6;pointer-events:none}  /* [lc-900] PLAY 走二级路由加载态 */
[data-fntv-carousel-style="4"] .fntv-s4-dots{position:absolute;left:9%;right:9%;bottom:44px;z-index:12;display:flex;justify-content:center;gap:9px}
[data-fntv-carousel-style="4"] .fntv-s4-dot{width:7px;height:7px;border-radius:99px;background:rgba(160,140,110,.45);cursor:pointer;transition:width .45s cubic-bezier(.22,1,.36,1),background-color .4s ease,box-shadow .4s ease}
[data-fntv-carousel-style="4"] .fntv-s4-dot.active{background:#f0b85c;width:24px;box-shadow:0 0 12px rgba(240,184,92,.5)}
/* [lc-829] 左右切换：海报两侧空白处的浅色 大于号/小于号 按钮 */
[data-fntv-carousel-style="4"] .fntv-s4-nav{position:absolute;top:50%;transform:translateY(-50%);z-index:14;cursor:pointer;border:none;background:transparent;padding:0;display:flex;align-items:center;justify-content:center;width:46px;height:72px;border-radius:16px;font-size:2.4rem;font-weight:700;line-height:1;font-family:system-ui,sans-serif;user-select:none;-webkit-user-select:none;color:var(--fntv-s4-nav-color,rgba(255,255,255,.5));text-shadow:0 2px 10px rgba(0,0,0,.45);transition:color .25s ease,background-color .25s ease,transform .25s ease;opacity:.55}
[data-fntv-carousel-style="4"] .fntv-s4-nav:hover{opacity:1;color:var(--fntv-s4-nav-color-hover,#fff);background:rgba(255,255,255,.08)}
[data-fntv-carousel-style="4"] .fntv-s4-nav:active{transform:translateY(-50%) scale(.92)}
[data-fntv-carousel-style="4"] .fntv-s4-nav.prev{left:3%}
[data-fntv-carousel-style="4"] .fntv-s4-nav.next{right:3%}
@media (max-width:800px){
  [data-fntv-carousel-style="4"] .fntv-s4-info{padding:1.5rem 1.5rem 2.4rem}
  [data-fntv-carousel-style="4"] .fntv-s4-info h3{font-size:1.5rem}
  [data-fntv-carousel-style="4"] .fntv-s4-info .desc{font-size:.85rem}
  [data-fntv-carousel-style="4"] .fntv-s4-title-logo-img{max-height:84px}
  [data-fntv-carousel-style="4"] .fntv-s4-bg{padding:1.5rem}
}
@media (max-width:500px){
  [data-fntv-carousel-style="4"] .fntv-s4-info{padding:1.2rem 1.2rem 2rem}
  [data-fntv-carousel-style="4"] .fntv-s4-info h3{font-size:1.3rem}
  [data-fntv-carousel-style="4"] .fntv-s4-title-logo-img{max-height:64px}
  [data-fntv-carousel-style="4"] .fntv-s4-actions{flex-direction:column;align-items:flex-start}
  [data-fntv-carousel-style="4"] .fntv-s4-play,[data-fntv-carousel-style="4"] .fntv-s4-detail{padding:.6rem 1.2rem;font-size:.8rem}
}
@media (prefers-reduced-motion: reduce){
  [data-fntv-carousel-style="4"] .fntv-s4-card{transition:opacity .2s ease}
  [data-fntv-carousel-style="4"] .fntv-s4-card.active,[data-fntv-carousel-style="4"] .fntv-s4-card.prev,[data-fntv-carousel-style="4"] .fntv-s4-card.next,[data-fntv-carousel-style="4"] .fntv-s4-card.far-left,[data-fntv-carousel-style="4"] .fntv-s4-card.far-right{transform:none}
  [data-fntv-carousel-style="4"] .fntv-s4-card.prev,[data-fntv-carousel-style="4"] .fntv-s4-card.next,[data-fntv-carousel-style="4"] .fntv-s4-card.far-left,[data-fntv-carousel-style="4"] .fntv-s4-card.far-right{opacity:0}
  [data-fntv-carousel-style="4"] .fntv-s4-bg{transform:none!important;transition:none}
  [data-fntv-carousel-style="4"] .fntv-s4-info .meta,[data-fntv-carousel-style="4"] .fntv-s4-info h3,[data-fntv-carousel-style="4"] .fntv-s4-info .desc,[data-fntv-carousel-style="4"] .fntv-s4-actions{opacity:1!important;transform:none!important;transition:none}
  [data-fntv-carousel-style="4"] .fntv-s4-play,[data-fntv-carousel-style="4"] .fntv-s4-detail{transition:background-color .15s ease}
  [data-fntv-carousel-style="4"] .fntv-s4-play:hover,[data-fntv-carousel-style="4"] .fntv-s4-detail:hover{transform:none}
}
`;
  (document.head || document.documentElement).appendChild(st);
}

export function buildCarouselStyle4(
  container: HTMLElement,
  wrapper: HTMLElement,
  shows: any[],
  base: string,
  rebuild: boolean
): void {
  const log4 = (...a: any[]) => log('[s4]', ...a);

  const imgUrl = (p: string, w?: number) => {
    if (!p) return '';
    if (p.startsWith('http') || p.startsWith('/v/api/')) return p + (w ? '?w=' + w : '');
    return `${base}/v/api/v1/${p}` + (w ? '?w=' + w : '');
  };

  // [lc-839+] 注入(或复用)样式4 真实 CSS —— 抽成 ensureStyle4Css(), 骨架阶段也会调用
  ensureStyle4Css();

  // 布局：3D 旋转木马舞台（高度与样式1/2/3 一致：calc(100vh - 380px)，避免加载完高度跳变；海报内部底部留白(见 .fntv-s4-card)负责与下方模块拉开间距）
  wrapper.style.cssText = 'display:block;padding:0;margin:0';
  container.style.width = '100%';
  container.style.height = '';
  container.style.minHeight = '0';
  container.style.maxHeight = 'calc(100vh - 380px)';
  container.style.aspectRatio = '16 / 9';
  container.style.margin = '0';
  container.style.overflow = 'hidden'; // [s4] 舞台裁剪 3D 场景（无背景无边框，卡片自身带完整视觉）
  container.style.perspective = '1600px';

  const accents = ['#6eb5ff', '#d69b6a', '#b08fe0', '#5fb0a8', '#e08585'];

  const track = document.createElement('div');
  track.className = 'fntv-s4-track';
  container.appendChild(track);

  const cards: HTMLElement[] = [];
  const dotsEls: HTMLElement[] = [];

  shows.forEach((show, i) => {
    const accent = accents[i % accents.length];
    const card = document.createElement('div');
    card.className = 'fntv-s4-card' + (i === 0 ? ' active' : '');
    card.setAttribute('data-index', String(i));

    // 背景：先渐变兜底，真实 backdrop 加载成功后替换
    const bg = document.createElement('div');
    bg.className = 'fntv-s4-bg';
    bg.style.backgroundImage = `linear-gradient(160deg, ${accent}55, #0b1219)`;
    card.appendChild(bg);

    const genreArr: string[] = (show as any).genres || [];

    // 内容区（标题/简介用 textContent，避免 HTML 注入）
    const info = document.createElement('div');
    info.className = 'fntv-s4-info';
    const meta = (genreArr[0] || '').toUpperCase();
    info.innerHTML =
      '<div class="meta"></div>' +
      '<h3></h3>' +
      '<div class="desc"></div>' +
      '<div class="fntv-s4-actions">' +
        '<button class="fntv-s4-play" type="button">开始播放</button>' +
        '<button class="fntv-s4-detail" type="button">更多详情</button>' +
      '</div>';
    (info.querySelector('.meta') as HTMLElement).textContent = meta;
    (info.querySelector('.meta') as HTMLElement).style.display = meta ? '' : 'none';
    const titleEl = info.querySelector('h3') as HTMLElement;
    titleEl.textContent = (show as any).title || '';
    (info.querySelector('.desc') as HTMLElement).textContent = (show as any).desc || '';
    card.appendChild(info);

    // [lc-817 同款] 标题用 logo 替换：有 logo 则清空文字、塞 logo 图
    resolveShowLogo(show, base).then((src) => {
      if (!src) return;
      titleEl.textContent = '';
      titleEl.classList.add('fntv-s4-title--logo');
      const logoImg = document.createElement('img');
      logoImg.className = 'fntv-s4-title-logo-img';
      logoImg.alt = (show as any).title || '';
      logoImg.src = src;
      titleEl.appendChild(logoImg);
    });

    // [lc-933] 复用首拉已校验横版的 _backdropBlob(零网络, 规避 s.backdrop 二次拉取返回竖版/错位图)
    applyCarouselBackdrop(show, bg, base);

    // 按钮行为（沿用飞牛 SPA 路由）
    const playBtn = info.querySelector('.fntv-s4-play') as HTMLElement | null;
    const detailBtn = info.querySelector('.fntv-s4-detail') as HTMLElement | null;
    const spaNav = (href: string): void => {
      history.pushState({}, '', href);
      window.dispatchEvent(new PopStateEvent('popstate'));
      setTimeout(() => {
        // [lc-941] 仅当 fnOS 确实未接管导航时才兜底整页跳转。
        // 旧逻辑用「返回按钮是否存在」单一判定: 详情页加载慢(>600ms 才出返回键)会误判为未接管 → location.href 整页刷新,
        // 导致返回首页时模块重载、S.apiShows/_backdropBlob 被重置 → 轮播海报不显示(原生卡片进详情不经此路径故正常)。
        // 现改双重判定「首页轮播仍可见 且 详情返回键未出现」才视为未接管; fnOS 已接管后 hideStaleViews 会把首页视图
        // display:none, 轮播 getBoundingClientRect 为 0 → 绝不整页刷新。
        const backBtn = !!document.querySelector('button[aria-label="返回"]');
        // [lc-944] 兜底判据改为「季页内容是否真渲染」, 修复 lc-941 引入的白屏:
        //   fnOS 收合成 popstate 后可能进入半死状态(首页被隐藏→轮播尺寸归零, 但季页内容未渲染、返回键也未出现),
        //   旧 carouselVisible 判定此时为 false → 兜底不触发 → 整页卡白屏。
        //   现以「返回键 或 季页内容(选集卡/演职人员/剧集信息卡)任一存在」作为 fnOS 已接管的判据:
        //   已接管→不整页刷新(保留轮播数据); 未接管(两者皆无)→整页跳转救活, 杜绝白屏。
        const seasonRendered = !!document.querySelector('[data-id="details"]')
          || !!document.querySelector('.fnos-season-2col')
          || !!document.querySelector('a[href*="/v/person/"]');
        if (!backBtn && !seasonRendered) location.href = href;
      }, 600);
    };
    // [lc-900] PLAY 默认进二级详情页(与 DETAIL 同构)
    if (playBtn) playBtn.addEventListener('click', (e: MouseEvent) => { e.stopPropagation(); playBtn.classList.add('is-loading'); resolveSeasonHref(show).then((href) => { playBtn.classList.remove('is-loading'); spaNav(href); }); });
    if (detailBtn) detailBtn.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      detailBtn.classList.add('is-loading');
      resolveSeasonHref(show).then((href) => { detailBtn.classList.remove('is-loading'); spaNav(href); });
    });

    track.appendChild(card);
    cards.push(card);
  });

  // 指示点（舞台内、居中最下方；挂在 container 内绝对定位贴底，避开 3D track）
  const dotsRow = document.createElement('div');
  dotsRow.className = 'fntv-s4-dots';
  cards.forEach((_, i) => {
    const d = document.createElement('span');
    d.className = 'fntv-s4-dot' + (i === 0 ? ' active' : '');
    d.setAttribute('data-index', String(i));
    dotsRow.appendChild(d);
    dotsEls.push(d);
  });
  container.appendChild(dotsRow);

  // ---------- 交互逻辑（借鉴 demo：3D 旋转木马）----------
  let currentIndex = 0;
  let autoTimer: number | null = null;
  const AUTO_DELAY = 5000;

  const updatePositions = (): void => {
    const n = cards.length;
    cards.forEach((card, idx) => {
      card.classList.remove('active', 'prev', 'next', 'far-left', 'far-right');
      let diff = idx - currentIndex;
      if (diff < 0) diff += n;
      if (diff === 0) card.classList.add('active');
      else if (diff === 1) card.classList.add('next');
      else if (diff === n - 1) card.classList.add('prev');
      else if (diff > 1 && diff < n / 2) card.classList.add('far-right');
      else card.classList.add('far-left');
    });
    dotsEls.forEach((d, idx) => d.classList.toggle('active', idx === currentIndex));
  };

  const goTo = (idx: number): void => {
    let n = idx;
    if (n < 0) n = cards.length - 1;
    if (n >= cards.length) n = 0;
    currentIndex = n;
    updatePositions();
  };

  const resetAuto = (): void => {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = window.setInterval(() => {
      // [s4] rebuild/卸载后自动停，避免旧闭包 interval 泄漏
      if (!document.body.contains(container)) {
        if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
        return;
      }
      currentIndex = (currentIndex + 1) % cards.length;
      updatePositions();
    }, AUTO_DELAY);
  };
  const stopAuto = (): void => {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  };

  dotsEls.forEach((d) => {
    d.addEventListener('click', () => {
      goTo(parseInt(d.getAttribute('data-index') || '0', 10));
      resetAuto();
    });
  });

  // [lc-829] 左右切换按钮（海报两侧空白处，浅色 小于号/大于号）
  const isDarkS4 = getEffectiveDark();
  container.style.setProperty('--fntv-s4-nav-color', isDarkS4 ? 'rgba(255,255,255,.5)' : 'rgba(60,48,36,.5)');
  container.style.setProperty('--fntv-s4-nav-color-hover', isDarkS4 ? '#fff' : '#3a2e20');
  const mkNav = (dir: 'prev' | 'next', glyph: string): HTMLElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fntv-s4-nav ' + dir;
    b.textContent = glyph;
    b.setAttribute('aria-label', dir === 'prev' ? '上一张' : '下一张');
    b.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      goTo(currentIndex + (dir === 'prev' ? -1 : 1));
      resetAuto();
    });
    return b;
  };
  const navPrev = mkNav('prev', '‹'); // 小于号
  const navNext = mkNav('next', '›'); // 大于号
  container.appendChild(navPrev);
  container.appendChild(navNext);

  // 触摸滑动
  let touchX = 0;
  container.addEventListener('touchstart', (e: TouchEvent) => { touchX = e.changedTouches[0].screenX; stopAuto(); }, { passive: true });
  container.addEventListener('touchend', (e: TouchEvent) => {
    const diff = touchX - e.changedTouches[0].screenX;
    if (Math.abs(diff) > 40) { if (diff > 0) goTo(currentIndex + 1); else goTo(currentIndex - 1); }
    resetAuto();
  }, { passive: true });

  // 键盘导航（仅在轮播可见时响应，移除后自动解绑）
  const keyHandler = (e: KeyboardEvent): void => {
    if (!document.body.contains(container)) { window.removeEventListener('keydown', keyHandler); return; }
    const rect = container.getBoundingClientRect();
    if (rect.top >= window.innerHeight || rect.bottom <= 0) return;
    if (e.key === 'ArrowRight') { goTo(currentIndex + 1); resetAuto(); }
    else if (e.key === 'ArrowLeft') { goTo(currentIndex - 1); resetAuto(); }
  };
  window.addEventListener('keydown', keyHandler);

  updatePositions();
  resetAuto();
  // [lc-876] 页面隐藏时暂停自动轮播
  const visHandler = (): void => { if (document.hidden) stopAuto(); else resetAuto(); };
  document.addEventListener('visibilitychange', visHandler);
  // [lc-876] 注册清理句柄
  S.carouselCleanup = (): void => {
    stopAuto(); // 清 autoTimer
    window.removeEventListener('keydown', keyHandler);
    document.removeEventListener('visibilitychange', visHandler);
    log4('cleanup: style4 timer & listeners destroyed');
  };
  // [lc-946] 复用轮播时重启自动轮播(返回首页不重建 DOM); 同时补回被 cleanup 移除的键盘/可见性监听器(同引用 addEventListener 去重)
  S.carouselResume = (): void => { if (!document.body.contains(container)) return; window.addEventListener('keydown', keyHandler); document.addEventListener('visibilitychange', visHandler); resetAuto(); };
  log4('样式4 3D旋转木马轮播注入完成, cards=', cards.length);
}
