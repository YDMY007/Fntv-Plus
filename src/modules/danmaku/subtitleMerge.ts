import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import log from '../logger';

/**
 * 字幕合并：把【翻译字幕】与【B站弹幕 ASS】合并成【同一个 ASS 文件】，
 * 让 PotPlayer 用一个 -sub 就能同时显示翻译（底部）+ 弹幕（\pos 浮在画面）。
 *
 * 为什么这么做（比"PotPlayer 原生双字幕"更稳）：
 *   PotPlayer 的"次字幕输出 / 双字幕显示"是它内部的【二进制配置 blob】，
 *   无法用命令行安全强制开启（改坏会让 PotPlayer 崩溃/重置），所以"代码锁死双字幕"
 *   在工程上不可靠。而合并方案把弹幕和翻译放进【同一个字幕轨道】，PotPlayer 默认就
 *   显示主字幕（这一轨），两者天然同时出现，完全不依赖 PotPlayer 的双字幕开关——
 *   比"锁死"更彻底，且 4K/175% 缩放在 PotPlayer 内部 ASS 渲染管线里自然处理。
 *
 *   翻译字幕可能是 vtt/srt/ass；弹幕 ASS 由 xmlToAss 生成（含 R2L/TOP/BTM 三个样式，
 *   弹幕用 \pos/\move 自带定位）。合并时把弹幕的样式段也并入，保证 \pos 生效。
 */

const MERGED_DIR = path.join(os.tmpdir(), 'fnos-danmaku');

interface AssSections {
    info: string[];        // [Script Info] 段内容行（含段头）
    styles: string[];      // [V4+ Styles] 里 Style: 开头的行
    eventsHeader: string;  // [Events] 里的 Format: 行
    dialogues: string[];   // [Events] 里的 Dialogue: 行
}

function parseAssSections(ass: string): AssSections {
    const lines = ass.split(/\r?\n/);
    const res: AssSections = { info: [], styles: [], eventsHeader: '', dialogues: [] };
    let cur = '';
    for (const line of lines) {
        const t = line.trim();
        if (t.startsWith('[Script Info]')) { cur = 'info'; res.info.push(line); continue; }
        if (t.startsWith('[V4+ Styles]')) { cur = 'styles'; continue; }
        if (t.startsWith('[Events]')) { cur = 'events'; continue; }
        if (t.startsWith('[')) { cur = 'other'; continue; }
        if (cur === 'info') res.info.push(line);
        else if (cur === 'styles') { if (/^Style\s*:/i.test(t)) res.styles.push(line.trim()); }
        else if (cur === 'events') {
            if (/^Format\s*:/i.test(t)) res.eventsHeader = line.trim();
            else if (/^Dialogue\s*:/i.test(t)) res.dialogues.push(line.trim());
        }
    }
    return res;
}

/** 把 vtt/srt/ass 统一转成 ASS 文本（失败返回 null） */
function toAss(subPath: string): string | null {
    let raw: string;
    try { raw = fs.readFileSync(subPath, 'utf-8'); } catch (e) {
        log.warn('[merge] 读翻译字幕失败: ' + (e as Error).message);
        return null;
    }
    // ⚠️ 关键修复：远程字幕常「扩展名/format 与内容不符」（例如谎报 vtt 实际是 Aegisub 生成的 ASS）。
    // 不能唯扩展名论——先按【内容嗅探】判断：含 [Events]+Dialogue: 即视为 ASS 原样采用，
    // 否则再按扩展名走 vtt/srt 转换。这是上次「合并失败退回多轨、弹幕出不来」的真因。
    if (/\[Events\]/i.test(raw) && /Dialogue\s*:/i.test(raw)) return raw;
    const ext = path.extname(subPath).toLowerCase();
    if (ext === '.ass') return raw;
    if (ext === '.vtt') return vttToAss(raw);
    if (ext === '.srt') return srtToAss(raw);
    if (raw.includes('[Events]')) return raw;
    return null;
}

/** WebVTT -> ASS（处理基础 cue：时间轴 + 多行文本，跳过 NOTE/STYLE/区块） */
function vttToAss(vtt: string): string | null {
    const lines = vtt.split(/\r?\n/);
    const dialogues: string[] = [];
    let i = 0;
    let inBlock = false;
    const reTime = /^([\d:.]+)\s*-->\s*([\d:.]+)/;
    while (i < lines.length) {
        const line = lines[i].trim();
        // 跳过头与区块声明
        if (/^WEBVTT/.test(line) || line === '' || /^NOTE/.test(line) ||
            /^STYLE/.test(line) || /^REGION/.test(line)) {
            inBlock = /^NOTE|^STYLE|^REGION/.test(line);
            i++;
            continue;
        }
        if (inBlock) { i++; continue; }
        const m = line.match(reTime);
        if (m) {
            const start = vttTimeToAss(m[1]);
            const end = vttTimeToAss(m[2]);
            // 收集后续文本行直到空行
            const texts: string[] = [];
            i++;
            while (i < lines.length && lines[i].trim() !== '') {
                texts.push(lines[i].trim());
                i++;
            }
            const text = texts.join('\\N').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
            dialogues.push(`Dialogue: 0,${start},${end},Subtitle,,0,0,0,,${text}`);
        } else {
            i++;
        }
    }
    if (dialogues.length === 0) return null;
    return wrapAsAss(dialogues);
}

/** SRT -> ASS */
function srtToAss(srt: string): string | null {
    const blocks = srt.replace(/\r/g, '').split(/\n\s*\n/);
    const dialogues: string[] = [];
    const reTime = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/;
    for (const b of blocks) {
        const lines = b.split('\n').filter(l => l.trim() !== '');
        if (lines.length < 2) continue;
        const m = lines[1].match(reTime);
        if (!m) continue;
        const start = srtTimeToAss(m[1]);
        const end = srtTimeToAss(m[2]);
        const text = lines.slice(2).join('\\N').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
        dialogues.push(`Dialogue: 0,${start},${end},Subtitle,,0,0,0,,${text}`);
    }
    if (dialogues.length === 0) return null;
    return wrapAsAss(dialogues);
}

function wrapAsAss(dialogues: string[]): string {
    const header = `[Script Info]
Title: Merged Subtitle
ScriptType: v4.00+
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Subtitle,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,1.5,0,2,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
    return header + dialogues.join('\n') + '\n';
}

function vttTimeToAss(t: string): string {
    // HH:MM:SS.mmm 或 MM:SS.mmm
    const parts = t.split(':');
    let h = 0, m = 0, s = 0;
    if (parts.length === 3) { h = parseInt(parts[0], 10); m = parseInt(parts[1], 10); s = parseFloat(parts[2]); }
    else if (parts.length === 2) { m = parseInt(parts[0], 10); s = parseFloat(parts[1]); }
    else { s = parseFloat(parts[0]); }
    const hh = String(h).padStart(1, '0');
    const mm = String(m).padStart(2, '0');
    const ss = s.toFixed(2).padStart(5, '0');
    return `${hh}:${mm}:${ss}`;
}

function srtTimeToAss(t: string): string {
    return vttTimeToAss(t.replace(',', '.'));
}

/**
 * 合并翻译字幕与弹幕 ASS 为一个文件。
 * @param subPath 翻译字幕（vtt/srt/ass）
 * @param danmakuAssPath 弹幕 ASS（由 xmlToAss 生成，含 R2L/TOP/BTM 样式）
 * @returns 合并后的 ASS 路径；任一失败返回 null
 */
export function mergeSubtitleWithDanmaku(subPath: string, danmakuAssPath: string): string | null {
    try {
        let dmRaw: string;
        try { dmRaw = fs.readFileSync(danmakuAssPath, 'utf-8'); } catch (e) {
            log.warn('[merge] 读弹幕 ASS 失败: ' + (e as Error).message); return null;
        }
        const dm = parseAssSections(dmRaw);
        if (dm.dialogues.length === 0) { log.warn('[merge] 弹幕 ASS 无 Dialogue'); return null; }

        // 弹幕坐标基于弹幕 ASS 的 PlayRes(默认 1920x1080) 画布；
        // 合并文件的 PlayRes【必须强制用弹幕的】，不能沿用翻译字幕自带的（常为 384x288 等），
        // 否则 libass 按错误分辨率映射 → 弹幕坐标偏移、飞出画面。
        const rx = (dmRaw.match(/PlayResX\s*:\s*(\d+)/i) || [])[1] || '1920';
        const ry = (dmRaw.match(/PlayResY\s*:\s*(\d+)/i) || [])[1] || '1080';

        // 翻译字幕：解析失败也【不致命】——降级为「仅弹幕」单轨，保证弹幕绝不丢（用户首要需求）。
        let sub: AssSections | null = null;
        let subDialogueCount = 0;
        try {
            const subAss = toAss(subPath);
            if (subAss) { sub = parseAssSections(subAss); subDialogueCount = sub.dialogues.length; }
            else log.warn('[merge] 翻译字幕转 ASS 失败，降级为仅弹幕单轨: ' + subPath);
        } catch (e) {
            log.warn('[merge] 翻译字幕解析异常，降级为仅弹幕单轨: ' + (e as Error).message);
        }

        // 样式合并：翻译样式 + 弹幕样式（同名以弹幕为准，保留 R2L/TOP/BTM）
        const styleMap = new Map<string, string>();
        if (sub) for (const s of sub.styles) { const n = s.split(',')[0].trim(); if (n) styleMap.set(n, s); }
        for (const s of dm.styles) { const n = s.split(',')[0].trim(); if (n) styleMap.set(n, s); }
        const mergedStyles = [...styleMap.values()];

        const mergedDialogues = [...(sub ? sub.dialogues : []), ...dm.dialogues];
        const eventsHeader = dm.eventsHeader ||
            (sub ? sub.eventsHeader : '') ||
            'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text';

        const out: string[] = [];
        // 强制用弹幕的 PlayRes 重写 [Script Info]，丢弃翻译自带的分辨率
        out.push('[Script Info]', 'Title: Merged Subtitle', 'ScriptType: v4.00+',
            `PlayResX: ${rx}`, `PlayResY: ${ry}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes');
        out.push('', '[V4+ Styles]');
        out.push('Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding');
        out.push(...mergedStyles);
        out.push('', '[Events]');
        out.push(eventsHeader);
        out.push(...mergedDialogues);

        if (!fs.existsSync(MERGED_DIR)) fs.mkdirSync(MERGED_DIR, { recursive: true });
        else {
            // 清理上一次播放遗留的 merged 文件（避免弹幕缓存目录无限膨胀；不动弹幕 .ass 缓存本身）
            try {
                for (const f of fs.readdirSync(MERGED_DIR)) {
                    if (/^merged_.*\.ass$/i.test(f)) {
                        try { fs.unlinkSync(path.join(MERGED_DIR, f)); } catch (_) { /* ignore */ }
                    }
                }
            } catch (_) { /* ignore */ }
        }
        const outPath = path.join(MERGED_DIR, `merged_${Date.now()}.ass`);
        fs.writeFileSync(outPath, out.join('\n') + '\n', 'utf-8');
        log.info(`[merge] ✅ 合并字幕+弹幕: ${outPath} (翻译${subDialogueCount} + 弹幕${dm.dialogues.length} 条, 样式${mergedStyles.length}, PlayRes=${rx}x${ry})`);
        return outPath;
    } catch (e) {
        log.warn('[merge] 合并异常: ' + (e as Error).message);
        return null;
    }
}
