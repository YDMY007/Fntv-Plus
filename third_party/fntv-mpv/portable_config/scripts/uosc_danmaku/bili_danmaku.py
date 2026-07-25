#!/usr/bin/env python3
# 直连 B站 弹幕下载器（绕开失效的弹弹play extcomment 代理）
# 用法: bili_danmaku.py <番名> <集数> <输出xml>
# 依赖: 仅 Python 标准库 (urllib / hashlib / re / html)
import sys, json, os, urllib.request, urllib.parse, urllib.error, hashlib, time, html, re

UA = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com"}
ENC = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]

# 登录态 Cookie：把 B站 浏览器 Cookie（一行）存到同目录 bili_cookie.txt
# 可绕过匿名 seg.so 概率性空响应风控；文件不存在/为空则走匿名。
# 安全：此文件含账号凭证，请勿提交到 git/云同步，仅留本地。
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
def _load_cookie():
    p = os.path.join(SCRIPT_DIR, "bili_cookie.txt")
    try:
        with open(p, "r", encoding="utf-8") as f:
            c = f.read().strip()
            return c or None
    except Exception:
        return None
COOKIE = _load_cookie()

# ---- 谐音/近似名兜底（最后手段） ----
# 常规标题匹配不到 B站 时（如 UP主用谐音梗名字上传），可手动编辑同目录
# bili_alias.txt，每行: 真实番名关键词= B站搜索词（谐音名/任意搜索词）
# 例: 葬送的芙莉莲=早丧的福里莲
# 程序会优先用映射后的搜索词去 B站 找，能 100% 命中谐音名搬运。
def _load_alias():
    p = os.path.join(SCRIPT_DIR, "bili_alias.txt")
    m = {}
    try:
        with open(p, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    k, v = line.split("=", 1)
                    k, v = k.strip(), v.strip()
                    if k and v:
                        m[k] = v
    except Exception:
        pass
    return m
ALIAS = _load_alias()

# 明显非正片的标题关键词（reaction/二创/OP/ED/预告等）
BAD_TITLE = ["reaction", "反应", "杂谈", "吐槽", "解说", "盘点", "二创", "mad", "amv",
             "算是", "你们", "为什么", "评", "空降", "切片", "速看", "高能", "op", "ed",
             "ost", "pv", "预告", "花絮", "cos", "直播", "歌词", "致敬", "混剪", "剪辑"]

# 标题/分P名里常见的非识别性填充词，做相似度比较时剔除
_FILLER = ["高清","1080p","720p","480p","4k","合集","全集","更新","熟肉","生肉",
           "字幕组","官方","独家","番剧","动画","动漫","国语","日语","中字","双语",
           "无修","无删减","精校","完结","第","话","集","全"]

def _core(t):
    """提取标题的「识别核心」：去标点/集数/数字/填充词，仅留汉字与字母。"""
    t = re.sub(r"[\s\[\]【】()（）<>《》\-_~～.。,，!！?？:：/\\|『』「」〔〕〈〉]", "", t)
    t = re.sub(r"第\s*\d+\s*[话集話]", "", t)
    t = re.sub(r"\d+", "", t)
    for w in _FILLER:
        t = t.replace(w, "")
    return t

def _overlap(a, b):
    sa, sb = set(a), set(b)
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)

def log(s):
    sys.stderr.write("[bili_danmaku] " + str(s) + "\n")
    sys.stderr.flush()

def parse_count(v):
    """把 B站 返回的弹幕数/播放数（可能是 int、'1.2万'、'--'、None）统一成整数。"""
    if v is None:
        return 0
    if isinstance(v, (int, float)):
        return int(v)
    s = str(v).strip().replace(",", "")
    if s in ("", "--", "无", "—"):
        return 0
    try:
        m = re.match(r"([\d.]+)\s*亿", s)
        if m:
            return int(float(m.group(1)) * 1e8)
        m = re.match(r"([\d.]+)\s*万", s)
        if m:
            return int(float(m.group(1)) * 10000)
        return int(float(s))
    except Exception:
        return 0

def fetch(url, binary=False):
    hdr = dict(UA)
    hdr["Cache-Control"] = "no-cache"
    if COOKIE:
        hdr["Cookie"] = COOKIE
    req = urllib.request.Request(url, headers=hdr)
    try:
        data = urllib.request.urlopen(req, timeout=15).read()
    except urllib.error.HTTPError as e:
        if e.code == 304:
            return b"" if binary else ""
        raise
    return data if binary else data.decode("utf-8", "ignore")

def fetch_seg(cid, seg):
    """下载单段弹幕，带重试以缓解限流/网络抖动（空响应重试一次再判定结束）。"""
    url = f"https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid={cid}&segment_index={seg}"
    last = b""
    for attempt in range(3):
        try:
            raw = fetch(url, binary=True)
        except Exception as e:
            log(f"段{seg}下载失败(重试{attempt+1}/3): {e}")
            time.sleep(2)
            continue
        if len(raw) >= 20:
            return raw
        last = raw
        if attempt < 2:
            log(f"段{seg}空响应(重试{attempt+1}/3)")
            time.sleep(2)
            continue
        return raw
    return last

def jget(url):
    return json.loads(fetch(url))

def wbi_sign(params):
    nav = jget("https://api.bilibili.com/x/web-interface/nav")["data"]["wbi_img"]
    ik = nav["img_url"].rsplit("/", 1)[1].split(".")[0]
    sk = nav["sub_url"].rsplit("/", 1)[1].split(".")[0]
    mixed = hashlib.md5((ik + sk).encode()).hexdigest()
    mixin = "".join(mixed[i % 32] for i in ENC)[:32]
    p = dict(sorted(params.items()))
    s = "".join(f"{k}={v}" for k, v in p.items())
    wts = int(time.time())
    w_rid = hashlib.md5((s + str(wts)).encode()).hexdigest()
    return f"w_rid={w_rid}&wts={wts}"

def _bangumi_cid(ep_id):
    """由 ep_id 取 cid（仅当该 ep 有 cid 时）。"""
    try:
        sd = jget(f"https://api.bilibili.com/pgc/view/web/season?ep_id={ep_id}")
        if sd.get("code") == 0:
            for e in sd["result"].get("episodes", []):
                if e.get("ep_id") == ep_id and e.get("cid"):
                    return e["cid"]
    except Exception as e:
        log("pgc请求失败: " + str(e))
    return None

def search_bangumi(title, ep_num):
    """番剧区搜索（B站正版番剧）。返回 (cid, title) 或 (None, None)。
    匹配逻辑：优先精确集数；集数超出范围时，改取该番「弹幕最多的一集」兜底，
    避免默认取首集却弹幕稀少的情况。"""
    url = f"https://api.bilibili.com/x/web-interface/search/all/v2?keyword={urllib.parse.quote(title)}&search_type=media_bangumi"
    d = jget(url)
    if not d or d.get("code") != 0:
        log("番剧区搜索失败 code=" + str(d.get("code")))
        return None, None
    prefix = title[:3]
    matched = []
    for it in d["data"]["result"]:
        if isinstance(it, dict) and it.get("result_type") == "media_bangumi":
            for anime in it.get("data", []):
                t = re.sub(r"<[^>]+>", "", anime.get("title") or "")
                if "中配" in t:
                    continue
                if prefix and prefix not in t:
                    continue
                matched.append((t, anime))

    if not matched:
        return None, None

    # 仅番名/单集模式：取首集（第1话）
    if ep_num == 0:
        for t, anime in matched:
            eps = anime.get("eps") or []
            if eps:
                ep_id = eps[0].get("ep_id") or eps[0].get("id")
                if ep_id:
                    cid = _bangumi_cid(ep_id)
                    if cid:
                        return cid, t
        return None, None

    # 精确集数优先
    for t, anime in matched:
        eps = anime.get("eps") or []
        if 1 <= ep_num <= len(eps):
            ep = eps[ep_num - 1]
            ep_id = ep.get("ep_id") or ep.get("id")
            if ep_id:
                cid = _bangumi_cid(ep_id)
                if cid:
                    return cid, t

    # 兜底：第 N 话超出范围时，取「弹幕最多」的一集（搜索结果自带 danmaku 字段）
    best = None
    best_dm = -1
    for t, anime in matched:
        for ep in (anime.get("eps") or []):
            dm = parse_count(ep.get("danmaku"))
            ep_id = ep.get("ep_id") or ep.get("id")
            if not ep_id:
                continue
            if dm > best_dm:
                best_dm = dm
                best = (t, ep_id)
    if best:
        cid = _bangumi_cid(best[1])
        if cid:
            log("番剧区：第%d话超出范围，改取弹幕最多的一集（弹幕=%d）: %s" % (ep_num, best_dm, best[0]))
            return cid, best[0]
    return None, None

def _ep_in_title(t, ep_num):
    """判断标题/分P名是否明确指向第 ep_num 话。"""
    if re.search(rf"第\s*0*{ep_num}\s*[话集話]", t):
        return True
    # 独立集数标记（如 02 / 2（先行版） / (2)），避免嵌在大数里（如 12 里的 2）
    if re.search(rf"(?<![\d])0*{ep_num}(?![\d])", t):
        if not re.search(r"\d\s*[~\-至]\s*\d", t):
            return True
    return False

def cid_from_bvid(bvid, ep_num=None, title_hint=None):
    """视频区 BV 号拿 cid。多P视频按 ep_num 选对应分P的 cid（分P弹幕时间线对齐）。"""
    try:
        d = jget(f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}")
        if d.get("code") != 0 or not d.get("data"):
            return None
        data = d["data"]
        pages = data.get("pages") or []
        if not pages:
            cid = data.get("cid")
            return cid if (ep_num is None or _ep_in_title(title_hint or "", ep_num)) else None
        if len(pages) == 1:
            cid = pages[0].get("cid")
            return cid if (ep_num is None or _ep_in_title(title_hint or "", ep_num)) else None
        # 多P：匹配对应分P（优先非「先行版/预览」）
        if ep_num:
            best = None
            for p in pages:
                part = p.get("part", "") or ""
                if _ep_in_title(part, ep_num):
                    if "先行" in part or "预览" in part:
                        if best is None:
                            best = p.get("cid")
                        continue
                    return p.get("cid")
            return best
        return pages[0].get("cid")
    except Exception as e:
        log("view请求失败: " + str(e))
        return None

def search_video(title, ep_num):
    """视频区搜索（UP主搬运）。按弹幕数（video_review）优选候选，而非第一个命中即返回。
    优先集数对齐；在「集数对齐且标题相关」的候选中挑弹幕最多的那一个。"""
    url = f"https://api.bilibili.com/x/web-interface/search/all/v2?keyword={urllib.parse.quote(title)}&search_type=video"
    d = jget(url)
    if not d or d.get("code") != 0:
        return None, None
    pool = []
    for it in d["data"]["result"]:
        if isinstance(it, dict) and it.get("result_type") == "video":
            for v in it.get("data", []):
                t = re.sub(r"<[^>]+>", "", v.get("title") or "")
                bvid = v.get("bvid")
                if bvid:
                    # video_review 即弹幕数（搜索结果自带，无需额外请求）
                    vr = parse_count(v.get("video_review"))
                    pool.append((t, bvid, vr))
    if not pool:
        return None, None

    prefix = title[:2]
    # 预筛：标题含番名前缀、非二创，再按弹幕数降序
    cands = []
    for t, bvid, vr in pool:
        if any(k in t.lower() for k in BAD_TITLE):
            continue
        if prefix and prefix not in t:
            continue
        cands.append((t, bvid, vr))
    if not cands:
        return None, None
    cands.sort(key=lambda x: -x[2])

    # 1) 集数对齐：按弹幕数降序逐个尝试，命中即返回（优先弹幕多且集数对齐）
    if ep_num:
        for t, bvid, vr in cands:
            cid = cid_from_bvid(bvid, ep_num, title_hint=t)
            if cid:
                log("视频区：在%d个候选中按弹幕数优先选定（弹幕=%d）: %s" % (len(cands), vr, t))
                return cid, t
        log("视频区未找到第%d话对应视频（仅有合集/无单集搬运）" % ep_num)
        return None, None

    # 2) 仅番名/第1话：直接取弹幕最多的（合集首P≈第1话，时间线基本对齐）
    for t, bvid, vr in cands:
        cid = cid_from_bvid(bvid)
        if cid:
            log("视频区（仅番名）：选定弹幕最多候选（弹幕=%d）: %s" % (vr, t))
            return cid, t
    log("视频区（仅番名）：候选均无可用分P")
    return None, None

def search_video_fuzzy(kw, ep_num):
    """最后兜底：常规标题匹配全失败时，对 B站 视频搜索结果做「识别核心」字符相似度
    猜测，仅当命中所需集数且相似度较高才采用，并明确告警（谐音/近似名不可靠，请核对）。
    在达到相似度阈值的候选中，优先弹幕数最多者。"""
    url = f"https://api.bilibili.com/x/web-interface/search/all/v2?keyword={urllib.parse.quote(kw)}&search_type=video"
    d = jget(url)
    if not d or d.get("code") != 0:
        return None, None
    pool = []
    for it in d.get("data", {}).get("result", []):
        if isinstance(it, dict) and it.get("result_type") == "video":
            for v in it.get("data", []):
                t = re.sub(r"<[^>]+>", "", v.get("title") or "")
                bvid = v.get("bvid")
                if bvid:
                    vr = parse_count(v.get("video_review"))
                    pool.append((t, bvid, vr))
    if not pool:
        return None, None
    core_kw = _core(kw)
    # 先按弹幕数降序，逐个校验相似度，第一个达阈值者即最优（弹幕多且足够相似）
    pool.sort(key=lambda x: -x[2])
    for t, bvid, vr in pool:
        if any(k in t.lower() for k in BAD_TITLE):
            continue
        cid = cid_from_bvid(bvid, ep_num, title_hint=t)
        if not cid:
            continue
        sim = _overlap(core_kw, _core(t))
        if sim >= 0.45:
            log(f"[模糊兜底-谐音/近似名猜测] 相似度={sim:.2f} 弹幕数={vr} 命中: {t}  (不可靠，请核对集数)")
            return cid, t
    log(f"模糊兜底未找到足够相似的视频")
    return None, None

def search_cid(title, ep_num):
    # 清洗弹弹play 可能附带的年份括号（如「尼古喵喵 (2026)」），避免 B站 搜不到
    title = re.sub(r"\s*[\(（]\d{4}[\)）]\s*$", "", title).strip()
    # 剥掉 CJK 书名号/直角引号（『』「」《》【】等）。飞牛 tvTitle 常带这些包裹符号
    # （如『你们先走我断后』，于是…），而 B站 番名没有，会导致 title[:2/3] 前缀
    # 过滤把候选整批筛掉→匹配不上。剥掉后再用「你们先走我断后」去搜即可命中。
    title = re.sub(r"[『』「」【】〔〕《》〈〉“”‘’]", "", title).strip()
    if not title:
        return None, None
    # 谐音/近似名别名映射（用户编辑 bili_alias.txt）：用映射后的搜索词去 B站 找
    kw = title
    for k, v in ALIAS.items():
        if k == title or (len(k) >= 2 and k in title):
            kw = v
            log(f"[别名映射] 真实名={title} -> 搜索词={v}")
            break
    cid, atitle = search_bangumi(kw, ep_num)
    if cid:
        return cid, atitle
    log("番剧区无结果，回退到视频区(UP主搬运)")
    cid, atitle = search_video(kw, ep_num)
    if cid:
        return cid, atitle
    # 最后兜底：常规匹配全失败，尝试谐音/近似名模糊猜测
    log("常规匹配失败，尝试谐音/近似名模糊兜底")
    return search_video_fuzzy(kw, ep_num)

def read_varint(b, i):
    shift = 0; val = 0
    while True:
        x = b[i]; i += 1
        val |= (x & 0x7f) << shift
        if not (x & 0x80):
            break
        shift += 7
    return val, i

def parse(b):
    out = []; i = 0; n = len(b)
    while i < n:
        tag, i = read_varint(b, i)
        f = tag >> 3; wt = tag & 7
        if wt == 2:
            ln, i = read_varint(b, i); dt = b[i:i+ln]; i += ln; out.append((f, 2, dt))
        elif wt == 0:
            v, i = read_varint(b, i); out.append((f, 0, v))
        elif wt == 5:
            out.append((f, 5, b[i:i+4])); i += 4
        elif wt == 1:
            out.append((f, 1, b[i:i+8])); i += 8
        else:
            break
    return out

def extract(raw):
    top = parse(raw)
    elems = [v for (f, wt, v) in top if f == 1 and wt == 2]
    res = []
    for e in elems:
        pr = 0; con = None; mode = 1; col = 16777215
        for (f, wt, v) in parse(e):
            if f == 2 and wt == 0:
                pr = v
            elif f == 7 and wt == 2:
                try:
                    con = v.decode("utf-8", "ignore")
                except Exception:
                    con = None
            elif f == 3 and wt == 0:
                mode = v
            elif f == 5 and wt == 5:
                col = int.from_bytes(v, "little")
        if con:
            res.append((pr, mode, col, con))
    return res

def main():
    if len(sys.argv) < 4:
        log("用法: bili_danmaku.py <番名> <集数> <输出xml>")
        sys.exit(2)
    title = sys.argv[1]; ep_num = int(sys.argv[2]); out = sys.argv[3]
    log(f"番名={title} 集数={ep_num}" + (" [登录态]" if COOKIE else " [匿名]"))
    cid, atitle = search_cid(title, ep_num)
    if not cid:
        log("未找到B站对应集（可能番名不匹配或网络受限）")
        sys.exit(1)
    log(f"cid={cid} 番名={atitle}")
    all_d = []
    for seg in range(1, 51):
        raw = fetch_seg(cid, seg)
        if len(raw) < 20:
            log(f"段{seg}空，结束")
            break
        dm = extract(raw)
        if not dm:
            log(f"段{seg}无弹幕，结束")
            break
        all_d.extend(dm)
    if not all_d:
        log("B站该集无弹幕")
        sys.exit(1)
    with open(out, "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n<danmaku>\n')
        for (pr, mode, col, con) in all_d:
            t = pr / 1000.0
            p = f"{t:.2f},{mode},25,{col},0,0,0"
            f.write(f'<d p="{p}">{html.escape(con)}</d>\n')
        f.write("</danmaku>\n")
    log(f"生成 {len(all_d)} 条弹幕 -> {out}")
    sys.exit(0)

if __name__ == "__main__":
    main()
