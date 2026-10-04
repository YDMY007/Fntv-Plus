#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Fntv-Plus 图标动画变体生成器（供选型评审）。
源图：fpk/app/ui/images/fntv_v9_256.png（256×256 橙红渐变底 + 白花 + 橙播放键）
产物：4 个动画 WebP（交付格式）+ 同名 GIF（方便预览）+ 帧条 PNG（静态查看）
所有变体均无缝循环（相位用完整 2π 周期 / 扫光起止在画布外）。
"""
import math
import os
from PIL import Image, ImageDraw, ImageFilter

SRC = r"D:/GitHub/Fntv-Plus/fpk/app/ui/images/fntv_v9_256.png"
OUT = r"D:/GitHub/Fntv-Plus/fpk/dev/icon-anim"
S = 256
SS = 4          # 超采样倍率：亚像素几何变换用（整数像素裁剪会把微缩放取整吃掉 → 帧重复 → 动态卡成静图）
os.makedirs(OUT, exist_ok=True)

src = Image.open(SRC).convert("RGB")
assert src.size == (S, S), src.size
big_src = src.resize((S * SS, S * SS), Image.LANCZOS)


def scale_center(im, s):
    """亚像素精度中心缩放（s 任意倍数）：放大到 S*SS 做变换，再缩回 S 抗锯齿。
    直接对 256 图做整数裁剪会让 <1px 的微缩放全部取整 → 相邻帧完全相同（实测 13/29 对
    差异为 0），Pillow 帧去重合并后动画变静图。"""
    w = S * SS
    nw = max(2, int(round(w * s)))
    r = im.resize((nw, nw), Image.LANCZOS)
    l = (nw - w) // 2
    return r.crop((l, l, l + w, l + w)).resize((S, S), Image.LANCZOS)


def contact_sheet(frames, path, n=8, gap=8, cols=4):
    """抽 n 帧拼网格（默认 4 列 2 行），每格原尺寸 256，供静态预览/验收。"""
    idxs = [int(i * (len(frames) - 1) / (n - 1)) for i in range(n)]
    sel = [frames[i] for i in idxs]
    rows = (len(sel) + cols - 1) // cols
    w = cols * S + (cols - 1) * gap
    h = rows * S + (rows - 1) * gap
    sheet = Image.new("RGB", (w, h), (24, 24, 28))
    for k, f in enumerate(sel):
        r, c = divmod(k, cols)
        sheet.paste(f, (c * (S + gap), r * (S + gap)))
    sheet.save(path)


def save_variant(name, frames, duration_ms=80, quality=88):
    webp = os.path.join(OUT, name + ".webp")
    gif = os.path.join(OUT, name + ".gif")
    # quality=88 + method=6：实测体积/画质拐点（q100=404KB → q88=153KB，帧数不变 28、色块图无损感）。
    # 不能用 lossless（体积 968KB 起）。帧去重合并只在「相邻帧视觉无差」时发生——那种帧合并
    # 本来就不影响观感，真正要防的是「帧间差被取整吃掉」（见 scale_center 的亚像素说明）。
    frames[0].save(webp, save_all=True, append_images=frames[1:], duration=duration_ms,
                   loop=0, quality=quality, method=6)
    # GIF：WebP 预览用不了时（微信/部分看图器）的兼容预览
    pal = [f.convert("P", palette=Image.ADAPTIVE, colors=256) for f in frames]
    pal[0].save(gif, save_all=True, append_images=pal[1:], duration=duration_ms, loop=0,
                disposal=1, optimize=False)
    contact_sheet(frames, os.path.join(OUT, name + "-sheet.png"))
    n_written = Image.open(webp).n_frames
    print("%-22s frames=%-3d (webp 实存 %-3d) webp=%6.1fKB gif=%7.1fKB" % (
        name, len(frames), n_written,
        os.path.getsize(webp) / 1024, os.path.getsize(gif) / 1024))


# ── 变体 1：呼吸（整体极轻缩放 + 同步的柔光脉动，经典 App 图标节奏）───────
def variant_breath(n=30, peak=1.045):
    frames = []
    for i in range(n):
        p = 2 * math.pi * i / n
        k = 0.5 - 0.5 * math.cos(p)          # 0..1..0 平滑往返
        f = scale_center(big_src, 1.0 + (peak - 1.0) * k)
        # 柔光脉动：放大到峰值时整体亮度微升 6%（"吸气"的高光感）
        if k > 0.02:
            glow = Image.new("RGB", (S, S), (255, 246, 236))
            f = Image.blend(f, glow, 0.10 * k)
        frames.append(f)
    return frames


# ── 变体 2：光泽扫过（柔光斜扫 + 全程极缓转动，避免静止段被帧去重合并）──────
def variant_shine(n=40, sweep=22, band=58, ang=24, peak_alpha=0.52, rot=1.6):
    """扫光在 40 帧的前 22 帧完成，其余帧保持缓慢转动（±1.6°）——若无此转动，
    静止段 28 帧只有 ±1 的亮度差，会被编码器去重合并成几帧，动画变成「扫完立刻重扫」。
    转动让每帧都有可见变化，节奏才是：扫光 → 缓转 → 再扫。"""
    frames = []
    up = src.resize((S * SS, S * SS), Image.LANCZOS)
    side = S * SS
    off = (side - S * SS) // 2
    for i in range(n):
        p = 2 * math.pi * i / n
        # 全程极缓转动（单周期来回）
        a = rot * math.sin(p)
        r = up.rotate(a, resample=Image.BICUBIC, center=(side // 2, side // 2))
        f = r.crop((off, off, off + S * SS, off + S * SS)).resize((S, S), Image.LANCZOS)
        if i < sweep:
            t = i / (sweep - 1)                       # 0..1
            pos = -S * 0.62 + t * (S * 2.24)          # 从左画布外扫到右画布外
            big = Image.new("L", (S * 2, S * 2), 0)
            db = ImageDraw.Draw(big)
            cx = S + pos - S // 2
            db.rectangle([cx - band // 2, -S, cx + band // 2, S * 3], fill=255)
            big = big.rotate(ang, resample=Image.BICUBIC, center=(S, S))
            m = big.crop((S // 2, S // 2, S // 2 + S, S // 2 + S))
            m = m.filter(ImageFilter.GaussianBlur(12)).point(
                lambda v: int(v * peak_alpha))
            f.paste((255, 252, 245), (0, 0), m)
        frames.append(f)
    return frames


# ── 变体 3：播放键脉冲（圆形局部放大，播放三角从中心放大回缩）─────────────
def find_play_center():
    """在中心区域检测播放三角（显著偏离白色的像素）的包围盒中心。"""
    px = src.load()
    xs, ys = [], []
    for y in range(S):
        for x in range(S):
            if (x - 128) ** 2 + (y - 128) ** 2 > 88 ** 2:
                continue
            r, g, b = px[x, y]
            # 与白色的距离（三角为橙色，白花/浅阴影距离小）
            if (255 - r) + (255 - g) * 0.5 + (255 - b) > 105:
                xs.append(x); ys.append(y)
    if not xs:
        raise RuntimeError("未检测到播放三角")
    cx = (min(xs) + max(xs)) // 2
    cy = (min(ys) + max(ys)) // 2
    rad = max(max(xs) - min(xs), max(ys) - min(ys)) // 2
    print("play center=(%d,%d) radius=%d bbox=(%d,%d)-(%d,%d)" % (
        cx, cy, rad, min(xs), min(ys), max(xs), max(ys)))
    return cx, cy, rad


def variant_play_pulse(n=26, peak=1.13, feather=0.46):
    """播放三角局部脉冲：以三角中心为圆心放大回缩。
    关键：局部放大后的补丁边缘与周围静态像素必然错位（花瓣上会出现可见的圆形断层），
    必须用径向羽化遮罩把补丁边缘渐变融合回原图 —— 实心贴图会露出圆盘边界（已复现）。"""
    cx, cy, rad = find_play_center()
    R = int(rad * peak) + 10                   # 补丁半径（含放大余量）
    if cx - R < 0 or cy - R < 0 or cx + R > S or cy + R > S:
        raise RuntimeError("补丁超界: %s" % ((cx - R, cy - R, cx + R, cy + R),))
    # 径向羽化遮罩：中心全不透明 → feather 处开始线性衰减 → 边缘全透明（高斯软化）
    mask = Image.new("L", (R * 2, R * 2), 0)
    dm = ImageDraw.Draw(mask)
    r0 = int(R * feather)
    for rr in range(r0, R + 1):
        v = int(255 * (1 - (rr - r0) / max(1, R - r0)) ** 1.5)
        dm.ellipse([R - rr, R - rr, R + rr, R + rr], outline=v, width=2)
    dm.ellipse([R - r0, R - r0, R + r0, R + r0], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(2))
    bx, by, bR = cx * SS, cy * SS, R * SS
    patch_big = big_src.crop((bx - bR, by - bR, bx + bR, by + bR))
    frames = []
    for i in range(n):
        p = 2 * math.pi * i / n
        s = 1.0 + (peak - 1.0) * (0.5 - 0.5 * math.cos(p))
        nw = max(2, int(round(bR * 2 * s)))
        r = patch_big.resize((nw, nw), Image.LANCZOS)
        l = (nw - bR * 2) // 2
        patch = r.crop((l, l, l + bR * 2, l + bR * 2)).resize((R * 2, R * 2), Image.LANCZOS)
        f = src.copy()
        f.paste(patch, (cx - R, cy - R), mask)   # 带羽化遮罩贴回（边界渐变融合）
        frames.append(f)
    return frames


# ── 变体 4：轻摇（过扫描后整体 ±2.6° 缓摆，俏皮不浮夸）────────────────────
def variant_sway(n=34, ang=2.6, overscan=1.14):
    """4x 图上做旋转（角度精确到亚像素）→ 裁中心 256，摆动时四角不露空。"""
    up = src.resize((int(S * overscan * SS), int(S * overscan * SS)), Image.LANCZOS)
    side = int(S * overscan * SS)
    off = (side - S * SS) // 2
    frames = []
    for i in range(n):
        p = 2 * math.pi * i / n
        a = ang * math.sin(p)
        r = up.rotate(a, resample=Image.BICUBIC, center=(side // 2, side // 2))
        crop = r.crop((off, off, off + S * SS, off + S * SS))
        frames.append(crop.resize((S, S), Image.LANCZOS))
    return frames


if __name__ == "__main__":
    print("源图:", SRC, src.size)
    save_variant("variant-1-breath", variant_breath())
    save_variant("variant-2-shine", variant_shine())
    save_variant("variant-3-play-pulse", variant_play_pulse())
    save_variant("variant-4-sway", variant_sway())
    print("输出目录:", OUT)
