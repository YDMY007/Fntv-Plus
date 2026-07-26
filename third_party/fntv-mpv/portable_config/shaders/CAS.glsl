// ═══════════════════════════════════════════════════════════════
//  CAS — Contrast Adaptive Sharppening（对比度自适应锐化）
//  源自 AMD FidelityFX CAS，移植为 MPV 用户着色器
//
//  特点：只在边缘区域锐化，平坦区域不处理，不会产生光晕/振铃
//  用途：与 Anime4K 叠加使用时增强细节；也可单独用于真人视频
//  性能：极轻量，单次采样邻域 3×3
// ═══════════════════════════════════════════════════════════════

//!HOOK MAIN
//!BIND HOOKED
//!WIDTH HOOKED.w
//!HEIGHT HOOKED.h
//!DESC CAS 锐化

#define CAS_SHARPEN    0.6      // 锐化强度 (0.0~1.0，推荐 0.4~0.8)
#define CAS_EDGE_THRESH 0.05     // 边缘检测阈值 (越小越敏感)

vec4 color = HOOKED_tex(HOOKED_pos);
vec2 d = HOOKED_pt;

// 3×3 邻域采样
vec4 tl = textureLod(HOOKED_raw, HOOKED_pos - vec2(d.x, -d.y), 0.0);
vec4  t = textureLod(HOOKED_raw, HOOKED_pos + vec2(0.0, -d.y), 0.0);
vec4 tr = textureLod(HOOKED_raw, HOOKED_pos + vec2(d.x, -d.y), 0.0);
vec4  l = textureLod(HOOKED_raw, HOOKED_pos - vec2(d.x,  0.0), 0.0);
vec4  r = textureLod(HOOKED_raw, HOOKED_pos + vec2(d.x,  0.0), 0.0);
vec4 bl = textureLod(HOOKED_raw, HOOKED_pos - vec2(d.x, d.y), 0.0);
vec4  b = textureLod(HOOKED_raw, HOOKED_pos + vec2(0.0, d.y), 0.0);
vec4 br = textureLod(HOOKED_raw, HOOKED_pos + vec2(d.x, d.y), 0.0);

// 取周围最大/最小值（各通道独立）
vec4 mx = max(max(max(tl, t), tr), max(max(l, r), max(bl, b)));
mx = max(mx, br);
vec4 mn = min(min(min(tl, t), tr), min(min(l, r), min(bl, b)));
mn = min(mn, br);

// 对比度自适应锐化：根据局部对比度动态调整强度
vec4 contrast = mx - mn;
vec4 w = clamp(contrast / (CAS_EDGE_THRESH + contrast), 0.0, 1.0);
vec4 sharp = color + (color - (mn * 0.5 + mx * 0.5)) * w * CAS_SHARPEN;

// 钳制到合法范围避免过冲
HOOKED.rgb = clamp(sharp.rgb, 0.0, 1.0);
HOOKED.a   = color.a;
