// _bmp2png.cjs — NSIS 画稿 BMP(24bpp 无压缩) → PNG 预览, 仅供调试查看
// 用法: node _bmp2png.cjs <in.bmp> <out.png> [scaleWidth]
const Fs = require('fs');
const Path = require('path');
const sharp = require('sharp');

function decodeBmp(buf) {
  if (buf[0] !== 0x42 || buf[1] !== 0x4d) throw new Error('not BMP');
  const dataOff = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const heightRaw = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  if (bpp !== 24) throw new Error('only 24bpp supported, got ' + bpp);
  if (compression !== 0) throw new Error('only BI_RGB supported, got ' + compression);
  const height = Math.abs(heightRaw);
  const bottomUp = heightRaw > 0;
  const stride = Math.floor((bpp * width + 31) / 32) * 4;
  const out = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    const srcY = bottomUp ? height - 1 - y : y;
    const rowOff = dataOff + srcY * stride;
    for (let x = 0; x < width; x++) {
      const s = rowOff + x * 3;
      const d = (y * width + x) * 3;
      out[d] = buf[s + 2];     // R
      out[d + 1] = buf[s + 1]; // G
      out[d + 2] = buf[s];     // B
    }
  }
  return { width, height, raw: out };
}

(async () => {
  const [, , inFile, outFile, scaleW] = process.argv;
  if (!inFile || !outFile) {
    console.error('usage: node _bmp2png.cjs <in.bmp> <out.png> [scaleWidth]');
    process.exit(1);
  }
  const buf = Fs.readFileSync(inFile);
  const { width, height, raw } = decodeBmp(buf);
  let pipe = sharp(raw, { raw: { width, height, channels: 3 } });
  if (scaleW) pipe = pipe.resize(Number(scaleW));
  await pipe.png().toFile(outFile);
  console.log(`[bmp2png] ${Path.basename(inFile)} ${width}x${height} -> ${outFile}`);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
