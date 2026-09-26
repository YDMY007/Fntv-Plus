// dev/verify_slide_race.mjs — [v1.10.1] 样式1 横屏底图竞速修复验证。
// 复现 render.ts blob 路径的两种模式（修复前：只同步读 imgEl.complete，不挂 onload；
// 修复后：先挂 onload 再赋 src + 同步加速路径），各跑 24 次大图（3840×2160 JPEG dataURL，
// 模拟 4K 底图解码异步），统计「卡在 display:none」的次数。
// 预期：旧模式高频卡死（竞速命中），新模式 0 卡死。
import pw from 'file:///C:/Users/24305/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';
const { chromium } = pw;

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setContent('<div id="host"></div>');

const result = await page.evaluate(async () => {
  // 1) 造一张 4K JPEG（dataURL 数 MB，与真实 4K 底图同量级）
  const cv = document.createElement('canvas');
  cv.width = 3840; cv.height = 2160;
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 3840, 2160);
  g.addColorStop(0, '#123456'); g.addColorStop(1, '#654321');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 3840, 2160);
  for (let i = 0; i < 2500; i++) { // 加噪点撑大体积
    ctx.fillStyle = `rgba(${i % 255},${255 - i % 255},${i * 7 % 255},.5)`;
    ctx.fillRect(i * 37 % 3840, i * 91 % 2160, 60, 40);
  }
  const dataUrl = cv.toDataURL('image/jpeg', 0.97);
  const sizeMB = (dataUrl.length * 0.75 / 1024 / 1024).toFixed(1);

  const applyCheck = (img) => {
    const nw = img.naturalWidth || 0, nh = img.naturalHeight || 0;
    img.style.display = (nw > 0 && nh > 0 && nw < nh) ? 'none' : 'block';
  };
  const runOne = (mode) => new Promise((resolve) => {
    const img = document.createElement('img');
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:none';
    document.getElementById('host').appendChild(img);
    const done = () => resolve(img.style.display);
    if (mode === 'old') {
      // 修复前：无 onload，仅同步读 complete
      img.src = dataUrl;
      try { if (img.complete) applyCheck(img); } catch (e) {}
      setTimeout(() => resolve(img.style.display), 3000); // 3s 后仍 none = 卡死
    } else {
      // 修复后：先挂 onload 再赋 src（同步 complete 命中仅加速）
      img.onload = () => { applyCheck(img); done(); };
      img.onerror = () => done();
      img.src = dataUrl;
      try { if (img.complete && img.naturalWidth > 0) { applyCheck(img); done(); } } catch (e) {}
      setTimeout(() => resolve(img.style.display), 3000);
    }
  });

  const N = 24;
  const oldResults = [], newResults = [];
  for (let i = 0; i < N; i++) oldResults.push(await runOne('old'));
  for (let i = 0; i < N; i++) newResults.push(await runOne('new'));
  return {
    sizeMB,
    oldStuck: oldResults.filter((d) => d === 'none').length,
    newStuck: newResults.filter((d) => d === 'none').length,
    oldShown: oldResults.filter((d) => d === 'block').length,
    newShown: newResults.filter((d) => d === 'block').length,
  };
});

console.log(`dataURL=${result.sizeMB}MB  旧模式: 卡死${result.oldStuck}/显示${result.oldShown} (共24)  新模式: 卡死${result.newStuck}/显示${result.newShown} (共24)`);
const ok = result.newStuck === 0 && result.newShown === 24;
console.log(ok ? (result.oldStuck > 0 ? '✅ PASS（旧模式竞速复现 ' + result.oldStuck + ' 次卡死，修复后 24/24 全显示）' : '✅ PASS（新模式 24/24 全显示；本轮旧模式未复现卡死——竞速本就时序相关）') : '❌ FAIL');
await browser.close();
process.exit(ok ? 0 : 1);
