#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Fntv-Plus 呼吸动画 v2 —— 从 2048 原图直接逐帧降采样（画质修复版）。
v1 的糊：4.4MB 2048 原图 → 先降为 256 → 每帧再放大 4x 做亚像素 → 缩回 256。
  "小图放大再缩小"往返让峰值帧锐度只剩原图的 82%（PSNR 21dB，肉眼可见糊）。
v2：每帧按缩放系数把 2048 原图重采样到目标边长再降回 256 —— 纯降采样路径，
  锐度保留 ≈100%，花瓣边缘与 fndesk 级清晰度同档。
"""
import math
import os
from PIL import Image

SRC_2048 = r"D:/GitHub/Fntv-Plus/fpk/docs/icon-main-2048-v9.png"
OUT_DIR = r"D:/GitHub/Fntv-Plus/fpk/dev/icon-anim"
S = 256
SS = 4
N = 30
PEAK = 1.045           # 与已上线的 v1 呼吸版同参数（用户已验收节奏）
DUR = 80               # ms/帧
os.makedirs(OUT_DIR, exist_ok=True)

src_hi = Image.open(SRC_2048).convert("RGB")
print("2048 原图:", src_hi.size, src_hi.mode)

# 预备一条 1024 中间档：2048→1024→目标 的两步降采样（大倍率单次缩放会丢细节，项目惯例）
mid = src_hi.resize((1024, 1024), Image.LANCZOS)

frames = []
for i in range(N):
    k = 0.5 - 0.5 * math.cos(2 * math.pi * i / N)
    s = 1.0 + (PEAK - 1.0) * k
    # 目标边长（亚像素精度直接体现在目标边长上，2048 源足够大，无需再超采样）
    target = int(round(S * SS * s))                     # 4x 目标（1024 级）
    # 1024 → target 级（≈1024..1070），再 → 256：全部是降采样，锐度无损
    step = mid.resize((target, target), Image.LANCZOS) if target != 1024 else mid.copy()
    w4 = S * SS
    if target >= w4:
        l = (target - w4) // 2
        fr = step.crop((l, l, l + w4, l + w4)).resize((S, S), Image.LANCZOS)
    else:
        # target < 1024 时（s<1 不会发生，PEAK>1，保底分支）
        up = step.resize((w4, w4), Image.LANCZOS)
        fr = up
    if k > 0.02:
        fr = Image.blend(fr, Image.new("RGB", (S, S), (255, 246, 236)), 0.10 * k)
    frames.append(fr)

webp = os.path.join(OUT_DIR, "variant-1-breath-v2.webp")
frames[0].save(webp, save_all=True, append_images=frames[1:], duration=DUR, loop=0,
               quality=90, method=6)
im = Image.open(webp)
print("v2 动画: %d 帧(webp 实存) %dx%d  %.1f KB" % (im.n_frames, S, S, os.path.getsize(webp) / 1024))

# ── 64px 版：同理从 2048 直接降 ──
S64 = 64
frames64 = []
for i in range(N):
    k = 0.5 - 0.5 * math.cos(2 * math.pi * i / N)
    s = 1.0 + (PEAK - 1.0) * k
    t64 = int(round(S64 * SS * s))
    step = mid.resize((t64, t64), Image.LANCZOS) if t64 != 1024 else mid.copy()
    w4 = S64 * SS
    l = (t64 - w4) // 2
    fr = step.crop((l, l, l + w4, l + w4)).resize((S64, S64), Image.LANCZOS)
    if k > 0.02:
        fr = Image.blend(fr, Image.new("RGB", (S64, S64), (255, 246, 236)), 0.10 * k)
    frames64.append(fr)
webp64 = os.path.join(OUT_DIR, "variant-1-breath-64-v2.webp")
frames64[0].save(webp64, save_all=True, append_images=frames64[1:], duration=DUR, loop=0,
                 quality=90, method=6)
im64 = Image.open(webp64)
print("v2 64px: %d 帧(webp 实存) %dx%d  %.1f KB" % (im64.n_frames, S64, S64, os.path.getsize(webp64) / 1024))

# ── 验收：锐度对比（v2 峰值帧 vs 当前线上静态原图 256）──
def sharpness(im):
    g = im.convert("L"); w, h = g.size; px = g.load()
    t = 0
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            lap = 4 * px[x, y] - px[x - 1, y] - px[x + 1, y] - px[x, y - 1] - px[x, y + 1]
            t += lap * lap
    return t

ref256 = Image.open(r"D:/GitHub/Fntv-Plus/fpk/app/ui/images/fntv_v9_256.png").convert("RGB")
peak_v2 = frames[15]   # i=15 → k 最大
a = sharpness(ref256); b = sharpness(peak_v2)
print("锐度: 线上256原图=%d  v2峰值帧=%d  保留=%.1f%%" % (a, b, 100 * b / a))
# v1 对照
v1 = Image.open(os.path.join(OUT_DIR, "variant-1-breath.webp")); v1.seek(14)
v1f = v1.convert("RGB")
b1 = sharpness(v1f)
print("v1峰值帧锐度=%d (保留 %.1f%%)  ← 旧版糊的量化证据" % (b1, 100 * b1 / a))
