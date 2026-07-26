// ═══════════════════════════════════════════════════════════════
//  ColorVibrance — 色彩鲜活增强
//
//  特点：非线性饱和度提升（ Vibrance 算法）
//        对已经饱和的像素少加、对灰暗的像素多加，避免肤色过饱和
//  用途：让串流/压缩视频色彩更通透；与 Anime4K 叠加效果更好
//  参考: Vibrance algorithm by Sébastien Lagarde / Unreal PostProcess
// ═══════════════════════════════════════════════════════════════

//!HOOK MAIN
//!BIND HOOKED
//!WIDTH HOOKED.w
//!HEIGHT HOOKED.h
//!DESC 色彩鲜活增强

#define VIBRANCE      0.20     // 鲜活强度 (0.0~0.5，推荐 0.15~0.30)
#define SATURATION    0.05     // 全局饱和度微调 (-0.1~0.1)

vec4 color = HOOKED_tex(HOOKED_pos);

// 转换到可操作色彩空间
float luminance = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));

// 计算 RGB 各通道与亮度的偏差（即"色彩量"）
vec3 colorDeviation = color.rgb - luminance;

// 最大通道偏差 = 该像素的最大色彩强度
float maxDeviation = max(max(colorDeviation.r, colorDeviation.g), colorDeviation.b);

// Vibrance: 根据已有饱和度自适应提升
// 已饱和的像素(maxDeviation大) → 提升少；灰暗像素 → 提升多
vec3 vibranceBoost = colorDeviation * (1.0 - maxDeviance / (luminance + 0.001)) * VIBRANCE;

// 全局饱和度微调
vec3 satBoost = colorDeviation * SATURATION;

color.rgb += vibranceBoost + satBoost;

// 钳制并保留 Alpha
HOOKED.rgb = clamp(color.rgb, 0.0, 1.0);
HOOKED.a   = color.a;
