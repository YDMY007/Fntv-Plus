// ═══════════════════════════════════════════════════════════════
//  FilmGrain — 胶片粒度模拟
//
//  特点：基于高斯噪声的模拟胶片颗粒，带空间相关性（非纯白噪）
//  用途：掩盖压缩色带/伪影、增加电影感、平滑数字视频的"塑料感"
//  注意：建议放在着色器链末尾（在其他效果之后叠加粒度）
// ═══════════════════════════════════════════════════════════════

//!HOOK MAIN
//!BIND HOOKED
//!WIDTH HOOKED.w
//!HEIGHT HOOKED.h
//!DESC 胶片粒度

#define GRAIN_STRENGTH  0.025    // 粒度强度 (0.01~0.08，推荐 0.02~0.04)
#define GRAIN_MEAN      0.0      // 噪声均值偏移（通常为 0）

// 基于坐标+时间的伪随机（每帧不同，同帧内空间连续）
float rand(vec2 co) {
    return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
}

vec4 color = HOOKED_tex(HOOKED_pos);

// 用像素坐标 + 时间驱动噪声（动画帧间变化）
vec2 uv = gl_FragCoord.xy;
float noise = rand(uv + floor(random * 10000.0)) - 0.5 + GRAIN_MEAN;

// 粒度随亮度自适应（暗部更明显，亮部更微妙）— 模拟真实胶片特性
float luminance = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
float adaptiveStrength = GRAIN_STRENGTH * (1.2 - luminance * 0.5);

color.rgb += noise * adaptiveStrength;

// 钳制
HOOKED.rgb = clamp(color.rgb, 0.0, 1.0);
HOOKED.a   = color.a;
