/**
 * [lc-1225] TMDB 季号自动对位（纯函数，无任何依赖，验证脚本可直测）。
 *
 * 背景实锤（2026-09-19 测试库「爱书的下克上」）：飞牛按番剧季数把 2026 年放送的「领主的养女」
 *   识别成「第 4 季」（Bangumi 系计数：2019 第一期 / 2020 第二期 / 2022 第三期 / 2026 第四期），
 *   而 TMDB tv/91768 只有 S1/S2 —— 2026 这季在 TMDB 是 S2。飞牛季号直取 /tv/{id}/season/4
 *   必然 404，「补全集信息」「剧集信息卡」整条链路全落空，用户只能手动把目录改名成第二季。
 * 本模块在「请求季 404」时，从 /tv/{id} 自带的 seasons 列表里挑出实际对应的 TMDB 季。
 *
 * 选季规则（按优先级）：
 *   ① episodeCountHint>0 且恰有一个季的 episode_count 相等 → 唯一命中（整季集数完全对上最可信；
 *      多个季同集数则歧义，弃用此通道）；
 *   ② 取 air_date ≤ 今天 的季里 air_date 最新者（触发本兜底的绝大多数是追新番场景 ——
 *      在播的那季在两套计数里必然都存在）；并列取季号更大者。全部未播时取最大季号。
 * 特殊季（season_number=0 / Specials）与空季（episode_count=0 的占位季）不参与候选。
 * 返回 null = 无合适候选（调用方维持原 404 报错，绝不瞎配）。
 */
export function pickFallbackSeason(
    seasons: any[], requested: number, episodeCountHint?: number,
): number | null {
    const list = (Array.isArray(seasons) ? seasons : [])
        .filter((s: any) => s && typeof s.season_number === 'number' && s.season_number >= 1
            && (typeof s.episode_count === 'number' && s.episode_count > 0));
    if (!list.length) return null;
    const hint = (typeof episodeCountHint === 'number' && episodeCountHint > 0) ? episodeCountHint : 0;
    if (hint) {
        const byCount = list.filter((s: any) => s.episode_count === hint);
        if (byCount.length === 1) return byCount[0].season_number;
    }
    const hasRealDate = (s: any): boolean =>
        typeof s.air_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.air_date);
    const today = new Date().toISOString().slice(0, 10);
    const aired = list.filter((s: any) => hasRealDate(s) && s.air_date <= today);
    if (aired.length) {
        let best = aired[0];
        for (const s of aired) {
            if (s.air_date > best.air_date
                || (s.air_date === best.air_date && s.season_number > best.season_number)) best = s;
        }
        return best.season_number;
    }
    // 无任何已播季（全未来日期 / 全缺日期）：退而取最大季号的非空真实季
    let best = list[0];
    for (const s of list) if (s.season_number > best.season_number) best = s;
    return best.season_number;
}
