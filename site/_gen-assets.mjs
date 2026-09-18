/**
 * 把 resource/docs 里的截图压缩成 webp，输出到 site/assets（供官网使用）
 * 用法：在项目根目录执行  node site/_gen-assets.mjs
 */
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'resource/docs';
const OUT = 'site/assets';
fs.mkdirSync(OUT, { recursive: true });

// 只挑能体现项目特色的几张，避免页面过重
const picks = [
  ['Home.png', 'home'],
  ['Details1.png', 'detail'],
  ['BiliDanmu.png', 'danmaku'],
  ['Potplayer.png', 'player'],
  ['Settings.png', 'settings'],
  ['Nashome.png', 'nas'],
  ['Actor.png', 'actor'],
];

for (const [file, name] of picks) {
  const src = path.join(SRC, file);
  if (!fs.existsSync(src)) { console.log('跳过（不存在）:', file); continue; }
  const dst = path.join(OUT, `${name}.webp`);
  await sharp(src).resize({ width: 1280, withoutEnlargement: true }).webp({ quality: 78 }).toFile(dst);
  const kb = (fs.statSync(dst).size / 1024).toFixed(0);
  console.log(`${file} → ${name}.webp  ${kb} KB`);
}
console.log('完成，输出目录：' + OUT);
