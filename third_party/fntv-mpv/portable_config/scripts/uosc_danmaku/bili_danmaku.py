#!/usr/bin/env python3
# 直连 B站 弹幕下载器（绕开失效的弹弹play extcomment 代理）
# 用法: bili_danmaku.py <番名> <集数> <输出xml>
# 依赖: 仅 Python 标准库 (urllib / hashlib / re / html)
import sys, json, os, io, urllib.request, urllib.parse, urllib.error, hashlib, time, html, re, difflib

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

# 注：已移除「谐音/近似名兜底」（含 bili_alias.txt 映射与模糊猜测）。
# 改用剧名相似度阈值策略（见 title_sim / SIM_HIGH / SIM_LOW），匹配更可控、不依赖谐音猜测。

# 明显非正片的标题关键词（reaction/二创/OP/ED/预告等）
BAD_TITLE = ["reaction", "反应", "杂谈", "吐槽", "解说", "盘点", "二创", "mad", "amv",
             "算是", "你们", "为什么", "评", "空降", "切片", "速看", "高能", "op", "ed",
             "ost", "pv", "预告", "花絮", "cos", "直播", "歌词", "致敬", "混剪", "剪辑",
             "有声轻小说", "广播剧", "有声书", "有声小说"]  # 非动画正片（音频/文字向）

# 标题/分P名里常见的非识别性填充词，做相似度比较时剔除
_FILLER = ["高清","1080p","720p","480p","4k","合集","全集","更新","熟肉","生肉",
           "字幕组","官方","独家","番剧","动画","动漫","国语","日语","中字","双语",
           "无修","无删减","精校","完结","第","话","集","全"]

# 剧名匹配阈值：优先完整剧名(SIM_HIGH)；匹配失败则降低阈值到 SIM_LOW(名字相同即可)。
# 注意：仅按剧名相似度+集序号匹配，绝不按视频时长/时间线对齐（见 _select_ep / cid_from_bvid 注释）。
SIM_HIGH = 0.90
SIM_LOW  = 0.70

# 视频区兜底接受阈值：低于 SIM_LOW 但 >= 此值、且含集数/核心剧名的视频，仍纳入候选池，
# 作为「高相似候选无弹幕时」的兜底。典型场景：官方译名带长副标题，搬运标题只写简称
# （如「小书痴的下克上 第四季」省掉「为了成为图书管理员而不择手段」），标题相似度仅 ~0.4，
# 但确为同番且有海量弹幕。噪声候选（reaction/无关视频 sim 多在 0.00~0.09）仍被排除。
# 调用方 main() 会逐个候选拉弹幕、取弹幕最多者，故放低下限不会误用错误视频。
VIDEO_SIM_FLOOR = 0.40

def _norm(t):
    """剧名归一化：去标点/空白/集数标记/填充词，仅留小写识别核心（保留数字以区分季/续作）。"""
    t = (t or "").lower()
    t = re.sub(r"[\s\[\]【】()（）<>《》\-_~～.。,，!！?？:：/\\|'\"‘’“”]", "", t)
    t = re.sub(r"第\s*\d+\s*[话集話回季]", "", t)      # 第N话/集/回/季
    t = re.sub(r"^\d+\s*季", "", t)
    for w in _FILLER:
        t = t.replace(w, "")
    return t

def title_sim(a, b):
    """剧名相似度 [0,1]。优先完整匹配；含子串关系视作高相似。
    用于「优先完整剧名、匹配失败降阈值到70%」策略，彻底替代原先的谐音/近似名模糊兜底。"""
    a, b = _norm(a), _norm(b)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    if a in b or b in a:
        return 0.92
    return difflib.SequenceMatcher(None, a, b).ratio()

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

def _select_ep(eps, ep_num):
    """在已匹配番剧的集列表里选集。
    - ep_num 有效(1..len) -> 精确集（按集序号，不依赖时长/时间线）
    - 否则 -> 取弹幕最多的一集（B站 搬运常以合集/首P 形式，弹幕最多≈正片热度最高）
    注意：绝不按视频时长匹配——B站 很多搬运会在正片后拼接大段无关视频以规避版权，
    按时长对齐会严重错位。"""
    if ep_num and 1 <= ep_num <= len(eps):
        return eps[ep_num - 1]
    best = None; best_dm = -1
    for ep in eps:
        dm = parse_count(ep.get("danmaku"))
        if dm > best_dm:
            best_dm = dm; best = ep
    return best

def search_bangumi(title, ep_num):
    """番剧区搜索（B站正版番剧）。返回候选列表 [(cid, title, info), ...]（按相似度+弹幕数排序）。
    匹配策略：优先完整剧名(sim>=SIM_HIGH)；失败则降阈值到 SIM_LOW(70%，名字相同)；
    不做谐音/近似名兜底。集选择见 _select_ep。"""
    url = f"https://api.bilibili.com/x/web-interface/search/all/v2?keyword={urllib.parse.quote(title)}&search_type=media_bangumi"
    d = jget(url)
    if not d or d.get("code") != 0:
        log("番剧区搜索失败 code=" + str(d.get("code")))
        return []
    cands = []
    for it in d["data"]["result"]:
        if isinstance(it, dict) and it.get("result_type") == "media_bangumi":
            for anime in it.get("data", []):
                t = re.sub(r"<[^>]+>", "", anime.get("title") or "")
                if "中配" in t:
                    continue
                cands.append((title_sim(title, t), t, anime))
    cands.sort(key=lambda x: (-x[0], -parse_count(x[2].get("video_review", 0))))
    log(f"[番剧区] 命中候选 {len(cands)} 个, ep_num={ep_num}")
    for i, (sim, t, anime) in enumerate(cands[:5]):
        eps = anime.get("eps") or []
        log(f"[番剧区]   候选[{i}] sim={sim:.2f} 总集数={len(eps)} {t!r}")

    results = []
    # 优先完整剧名(sim>=SIM_HIGH)；否则降阈值到 SIM_LOW(名字相同)；不做谐音兜底
    for thr in (SIM_HIGH, SIM_LOW):
        for sim, t, anime in cands:
            if sim < thr:
                continue
            eps = anime.get("eps") or []
            if not eps:
                continue
            ep = _select_ep(eps, ep_num)
            if not ep:
                continue
            ep_id = ep.get("ep_id") or ep.get("id")
            if not ep_id:
                continue
            cid = _bangumi_cid(ep_id)
            if cid:
                info = {"source": "bangumi", "season_id": anime.get("season_id"), "epid": ep_id, "bvid": None}
                log(f"[番剧区] sim={sim:.2f}(阈值{thr}) 候选: {t!r} ep序号={ep.get('index')} cid={cid}")
                results.append((cid, t, info))
    if not results:
        log("[番剧区] 无达到相似度阈值(70%)的候选，放弃匹配（已移除谐音兜底）")
    return results

def _ep_in_title(t, ep_num):
    """判断标题/分P名是否明确指向第 ep_num 话（精确单集）。
    覆盖：第N话/集/回、EP03/E03/Episode 3、#3、(3)、独立 03。
    含范围（如 01-03、第1-12集）的视为合集，不算单集命中。"""
    if not ep_num:
        return False
    s = str(t)
    if re.search(rf"第\s*0*{ep_num}\s*[话集回話]", s):
        return True
    # 含范围（如 第1-12集 / 01-03话）整体算合集，不视为单集命中
    if re.search(r"\d\s*[~\-–至]\s*\d", s):
        return False
    # EP03 / E03 / Episode 3 / ep.3 / #3
    if re.search(rf"(?:^|[^A-Za-z\d])(?:e\.?p\.?\s*|episode\s*|#\s*)\s*0*{ep_num}(?!\d)", s, re.I):
        return True
    # 独立数字：03 / 3（排除嵌在大数里，如 12 里的 2）
    if re.search(rf"(?<![\d])0*{ep_num}(?![\d])", s):
        return True
    return False

def _is_compilation_title(t):
    """标题是否表明为多集合集（无法隔离单集弹幕）：全N集/全N话 / 合集 / 第1-12集 / 01-03话 / 01~03 等。"""
    s = str(t)
    # 「全13话」「全12集」「全N集」「全N话」— 最常见的多集合集标记
    if re.search(r"全\s*\d+\s*[集话]", s):
        return True
    if "合集" in s or "总集" in s:
        return True
    if re.search(r"第\s*\d+\s*[~\-–至]\s*\d+\s*[话集]", s):
        return True
    if re.search(r"\d+\s*[~\-–至]\s*\d+\s*话", s):
        return True
    return False

def parse_ep_from_title(title):
    """从标题/文件名字符串提取集数（无则返回 0）。
    覆盖: 第12话/集/回、EP12/ep12/E12、(12)、-12/_12/.12、独立 '12话'。
    过滤年份等大数字(>2010)误判。"""
    if not title:
        return 0
    m = re.search(r"第\s*(\d+)\s*[话集回話]", title)
    if m:
        return int(m.group(1))
    m = re.search(r"(?<![A-Za-z])[Ee][Pp]?\s*(\d+)", title)
    if m:
        n = int(m.group(1))
        if n <= 2010:
            return n
    m = re.search(r"(?<![\d])(\d{1,4})(?![\d])\s*[话集回話]", title)
    if m:
        return int(m.group(1))
    m = re.search(r"[\(（]\s*(\d{1,4})\s*[\)）]", title)
    if m:
        n = int(m.group(1))
        if n <= 2010:
            return n
    m = re.search(r"[\-_.\s]\s*(\d{1,4})\s*(?=[\-\]\)）\s]|$)", title)
    if m:
        n = int(m.group(1))
        if n <= 2010:
            return n
    return 0

def cid_from_bvid(bvid, ep_num=None, title_hint=None):
    """视频区 BV 号拿 cid。多P视频按 ep_num 选对应分P的 cid（按分P标题中的集序号匹配，
    不按视频时长——B站 搬运常在正片后拼接大段无关视频以规避版权，按时长对齐会严重错位）。"""
    try:
        d = jget(f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}")
        if d.get("code") != 0 or not d.get("data"):
            log(f"view请求失败 bvid={bvid} code={d.get('code')}")
            return None
        data = d["data"]
        pages = data.get("pages") or []
        log(f"[cid_from_bvid] bvid={bvid} pages={len(pages)} ep_num={ep_num} title_hint={title_hint!r}")
        if not pages:
            cid = data.get("cid")
            # 单cid视频：若标题表明是多集合集（全N集/合集/第1-12集）却只有一个cid，
            # 无法隔离单集弹幕（弹幕是全集时间轴），直接跳过，让调用方试下一候选。
            if ep_num and _is_compilation_title(title_hint or ""):
                log(f"[cid_from_bvid] 单cid合集视频(标题含全集标记), 无法隔离第{ep_num}话, 跳过")
                return None
            ok = (ep_num is None or _ep_in_title(title_hint or "", ep_num))
            log(f"[cid_from_bvid] 单P: cid={cid} 集数匹配={ok}")
            return cid if ok else None
        if len(pages) == 1:
            cid = pages[0].get("cid")
            if ep_num and _is_compilation_title(title_hint or ""):
                log(f"[cid_from_bvid] 单P合集视频(标题含全集标记), 无法隔离第{ep_num}话, 跳过")
                return None
            ok = (ep_num is None or _ep_in_title(title_hint or "", ep_num))
            log(f"[cid_from_bvid] 单P列表: cid={cid} 集数匹配={ok}")
            return cid if ok else None
        # 多P：匹配对应分P（优先非「先行版/预览」）
        if ep_num:
            best = None
            for i, p in enumerate(pages):
                part = p.get("part", "") or ""
                if _ep_in_title(part, ep_num):
                    if "先行" in part or "预览" in part:
                        if best is None:
                            best = p.get("cid")
                        log(f"[cid_from_bvid] 分P[{i}]={part!r} 命中但为先行/预览, 暂存兜底")
                        continue
                    log(f"[cid_from_bvid] 分P[{i}]={part!r} 集数匹配 -> cid={p.get('cid')}")
                    return p.get("cid")
            log(f"[cid_from_bvid] 多P未精确匹配第{ep_num}话, 兜底 cid={best}")
            return best
        log(f"[cid_from_bvid] 未指定集数, 取首P cid={pages[0].get('cid')}")
        return pages[0].get("cid")
    except Exception as e:
        log("view请求失败: " + str(e))
        return None

def search_video(title, ep_num):
    """视频区搜索（UP主搬运）。按剧名相似度排序：优先完整剧名匹配，匹配失败降阈值到70%。
    命中候选内再按集数/分P对齐（按分P标题中的集序号选分P，不按视频时长）。
    返回候选列表 [(cid, title, info), ...]（按相似度+弹幕数排序），供 main() 逐个尝试拉弹幕。"""
    url = f"https://api.bilibili.com/x/web-interface/search/all/v2?keyword={urllib.parse.quote(title)}&search_type=video"
    d = jget(url)
    if not d or d.get("code") != 0:
        return []
    pool = []
    for it in d["data"]["result"]:
        if isinstance(it, dict) and it.get("result_type") == "video":
            for v in it.get("data", []):
                t = re.sub(r"<[^>]+>", "", v.get("title") or "")
                bvid = v.get("bvid")
                if bvid:
                    vr = parse_count(v.get("video_review"))
                    pool.append((t, bvid, vr))
    if not pool:
        return []
    # 预筛：去除 reaction/二创等明显非正片
    pool = [(t, b, vr) for (t, b, vr) in pool if not any(k in t.lower() for k in BAD_TITLE)]

    # 候选分类：0=精确单集(第N集/EP N/第N话)  1=不明确单集(剧场版/OVA/无编号单集)  2=多集合集(全N集/合集/01-03话)
    # 排序目标：优先精确单集视频（拿到的是「对应集」弹幕），把多集合集降到最后（其弹幕是全集时间轴）。
    def kind_of(t):
        if ep_num and _ep_in_title(t, ep_num) and not _is_compilation_title(t):
            return 0
        if _is_compilation_title(t):
            return 2
        return 1
    scored = [(title_sim(title, t), kind_of(t), t, bvid, vr) for (t, bvid, vr) in pool]
    # 排序：单集优先 > 不明确 > 合集；同档按 (弹幕数↓, 相似度↓)
    # 弹幕数优先：同类候选中弹幕多的先试，避免少弹幕视频抢占匹配机会
    scored.sort(key=lambda x: (x[1], -x[4], -x[0]))
    log(f"[视频区] 候选 {len(scored)} 个, ep_num={ep_num}")
    for i, (sim, kind, t, bvid, vr) in enumerate(scored[:8]):
        tag = {0: "[单集]", 1: "[不明]", 2: "[合集]"}.get(kind, "?")
        log(f"[视频区]   候选[{i}]{tag} sim={sim:.2f} 弹幕={vr} {t!r}")

    results = []
    # 已按 (单集>不明确>合集, 相似度↓, 弹幕数↓) 排序。单次遍历：sim>=VIDEO_SIM_FLOOR 即采纳
    # （VIDEO_SIM_FLOOR 低于 SIM_LOW，作为「高相似候选无弹幕时」的兜底，纳入简称/异译标题但确为同番、
    # 且有弹幕的视频，如官方长副标题被搬运省略导致相似度仅~0.4）。噪声候选(sim<此值)仍排除。
    # 调用方 main() 据此优先拿到「对应集」弹幕；候选逐个尝试拉弹幕，弹幕最多者胜出。
    seen_cids = set()
    for sim, kind, t, bvid, vr in scored:
        if sim < VIDEO_SIM_FLOOR:
            continue
        cid = cid_from_bvid(bvid, ep_num, title_hint=t)
        if cid and cid not in seen_cids:
            seen_cids.add(cid)
            info = {"source": "video", "bvid": bvid}
            tag = {0: "[单集]", 1: "[不明]", 2: "[合集]"}.get(kind, "?")
            mark = "" if sim >= SIM_LOW else " [兜底]"
            log(f"[视频区] sim={sim:.2f}{tag}{mark} 候选: {t!r} cid={cid}")
            results.append((cid, t, info))
    if not results:
        log("[视频区] 无达到相似度阈值(70%)的候选，放弃匹配（已移除谐音兜底）")
    return results

# （已移除 search_video_fuzzy 谐音/近似名模糊兜底：匹配策略改为剧名相似度阈值，见 search_bangumi/search_video）

def search_cid(title, ep_num):
    """搜索 B站 返回候选列表 [(cid, title, info), ...]（番剧区优先，回退视频区）。
    每个候选都已通过相似度阈值+集数对齐验证。调用方应逐个尝试拉弹幕，
    因部分视频可能 seg.so 无弹幕数据（新上传/冷门/被清），需回退到下一候选。"""
    # 清洗弹弹play 可能附带的年份括号（如「尼古喵喵 (2026)」），避免 B站 搜不到
    title = re.sub(r"\s*[\(（]\d{4}[\)）]\s*$", "", title).strip()
    if not title:
        return []
    # ep_num 为 0 时尝试从标题/文件名里再挖一次集数（部分调用方传入的是含集数的完整标题）
    if not ep_num or ep_num == 0:
        derived = parse_ep_from_title(title)
        if derived:
            log(f"[search_cid] ep_num=0, 从标题解析到集数={derived}: {title!r}")
            ep_num = derived
        else:
            log(f"[search_cid] ep_num=0 且标题无集数: {title!r}")
    log(f"[search_cid] 开始匹配: title={title!r} ep_num={ep_num}")
    # 番剧区优先（正版番剧弹幕质量更高）
    candidates = search_bangumi(title, ep_num)
    if candidates:
        log(f"[search_cid] 番剧区返回 {len(candidates)} 个候选")
        return candidates
    log("番剧区无结果，回退到视频区(UP主搬运)")
    candidates = search_video(title, ep_num)
    if candidates:
        log(f"[search_cid] 视频区返回 {len(candidates)} 个候选")
        return candidates
    log("[search_cid] 番剧区/视频区均未匹配（已移除谐音/近似名兜底，不再猜测）")
    return []


def try_fetch_danmaku(cid, out):
    """尝试从单个 cid 拉取 seg.so 弹幕。返回 (成功bool, 弹幕列表)。
    不写文件、不输出 BILI_RESULT，纯拉取+解析。"""
    all_d = []
    for seg in range(1, 51):
        raw = fetch_seg(cid, seg)
        if len(raw) < 20:
            log(f"  cid={cid} 段{seg}空，结束")
            break
        dm = extract(raw)
        if not dm:
            log(f"  cid={cid} 段{seg}无弹幕，结束")
            break
        all_d.extend(dm)
    return (len(all_d) > 0), all_d

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

def _write_xml(out, dm):
    """把弹幕列表 [(pr,mode,col,con),...] 写成 XML 文件。"""
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)  # [lc-301] 确保父目录存在（MPV 落盘已改到 fnos-danmaku 子目录）
    with open(out, "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n<danmaku>\n')
        for (pr, mode, col, con) in dm:
            t = pr / 1000.0
            p = f"{t:.2f},{mode},25,{col},0,0,0"
            f.write(f'<d p="{p}">{html.escape(con)}</d>\n')
        f.write("</danmaku>\n")


def _load_block_types():
    """读取同目录 danmaku_block_types.json（由应用设置面板写入），返回需屏蔽的类型集合。
    支持 key: top(顶部) bottom(底部) scroll(滚动) reverse(逆向) advanced(高级/代码) color(彩色)。"""
    p = os.path.join(SCRIPT_DIR, "danmaku_block_types.json")
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return set(str(x) for x in data)
    except Exception:
        pass
    return set()


def _filter_danmaku(dm, block_types):
    """按屏蔽类型过滤弹幕列表。mode 映射：1滚动 4底部 5顶部 6逆向 7/8高级；col!=16777215 视为彩色。"""
    if not block_types:
        return dm
    out = []
    for (pr, mode, col, con) in dm:
        tags = set()
        if mode == 1:
            tags.add("scroll")
        elif mode == 4:
            tags.add("bottom")
        elif mode == 5:
            tags.add("top")
        elif mode == 6:
            tags.add("reverse")
        elif mode in (7, 8):
            tags.add("advanced")
        if col != 16777215:
            tags.add("color")
        if tags & block_types:
            continue
        out.append((pr, mode, col, con))
    return out


def _emit_result(title, cid, atitle, info, count, source, aggregated_from=None):
    """输出 BILI_RESULT JSON 到 stdout（供 Lua extra.lua 解析后显示在配置面板）。"""
    result = {
        "ok": True,
        "bvid": info.get("bvid") if info else None,
        "title": title,
        "danmaku_count": count,
        "source": source,
        "cid": cid,
    }
    if aggregated_from is not None:
        result["aggregated_from"] = aggregated_from
    print(f"BILI_RESULT:{json.dumps(result, ensure_ascii=False)}")


def _select_danmaku(fetched, agg_threshold, agg_time_limit, min_danmaku):
    """「弹幕对得上」优先策略：只取弹幕最多的【单集时间轴】候选，不合并多源。
       不同 UP 主搬运源时间轴（片头长短/字幕组版本）不同，合并会把源A的弹幕
       错位叠到源B的画面，导致"对不上"。故取消 lc-170 的多源聚合——宁少勿错。
       agg_threshold/min_danmaku 保留签名兼容，实际不再触发合并（始终返回单源）。
       返回 (final_dm, cid, atitle, info, source, agg_count, srcs_str)。
      - 仅【单集时间轴】候选(时间轴<=agg_time_limit)参与「对应集」匹配；跨多集(整季混剪)排除在外，
        避免错把整季弹幕当对应集（lc-170 要求「对应集对应的弹幕」）。
      - 无任何单集有效候选(罕见, 全是跨多集) -> 退回全局弹幕最多者兜底。"""
    valid = [f for f in fetched if f[4] <= agg_time_limit]
    if valid:
        best = max(valid, key=lambda x: len(x[3]))
        return best[3], best[0], best[1], best[2], \
               (best[2].get("source") if best[2] else None), None, ""
    # 罕见：无任何单集有效候选 -> 退回全局弹幕最多者兜底
    best = max(fetched, key=lambda x: len(x[3]))
    return best[3], best[0], best[1], best[2], \
           (best[2].get("source") if best[2] else None), None, ""


def main():
    # Windows 内嵌 Python 默认用 GBK/ANSI 编码写控制台，mpv subprocess 捕获后中文全变乱码。
    # 强制 stdout/stderr 均使用 UTF-8，确保 BILI_RESULT JSON 和日志中的中文正确传递。
    if sys.platform == "win32":
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

    if len(sys.argv) < 4:
        log("用法: bili_danmaku.py <番名> <集数> <输出xml> [聚合阈值]")
        sys.exit(2)
    title = sys.argv[1]; ep_num = int(sys.argv[2]); out = sys.argv[3]
    # 第4参数: 聚合阈值(默认1500)。现已禁用多源合并（合并会错位"对不上"），
    # 该参数仅保留签名兼容，实际总是取【弹幕最多的单集候选】单源，保证时间轴对齐。
    agg_threshold = 1500
    if len(sys.argv) >= 5:
        try:
            agg_threshold = int(sys.argv[4])
        except ValueError:
            pass
    log(f"番名={title} 集数={ep_num} 聚合阈值={agg_threshold}" + (" [登录态]" if COOKIE else " [匿名]"))

    candidates = search_cid(title, ep_num)
    if not candidates:
        log("未找到B站对应集（可能番名不匹配或网络受限）")
        print(f"BILI_RESULT:{json.dumps({'ok': False, 'error': '未找到匹配的B站视频'}, ensure_ascii=False)}")
        sys.exit(1)

    # 单集时长安全上限(秒)：弹幕时间轴超过此值的候选视为跨多集视频，选用/聚合时跳过，
    # 避免把整季混剪视频的「全集时间轴」弹幕叠加进来导致错位。
    # 是否「合集」改以【实际时间轴】判定而非看标题——「全N集」多P 视频的某P 弹幕本就是
    # 对应集(0~1400s)，应纳入聚合；标题含「合集」不再作为排除条件。
    AGG_TIME_LIMIT = 2200
    MIN_DANMAKU = 10
    CAP = 10  # 拉取前 10 个候选：合并模式下需攒到「几个单源(单集)视频」才能合出足量弹幕

    fetched = []  # (cid, atitle, info, all_d, max_time)
    for idx, (cid, atitle, info) in enumerate(candidates[:CAP]):
        label = info.get("bvid") or atitle or f"候选#{idx+1}"
        log(f"[{idx+1}/{len(candidates)}] 尝试 cid={cid} ({label})")
        ok, all_d = try_fetch_danmaku(cid, out)
        if ok and all_d:
            max_t = max((pr for pr, _, _, _ in all_d), default=0) / 1000.0
            fetched.append((cid, atitle, info, all_d, max_t))
            log(f"  -> {len(all_d)} 条弹幕, 时间轴 0~{max_t:.0f}s")
        else:
            log(f"  ⚠️ 候选[{idx+1}] {label} 无弹幕数据，跳过")

    if not fetched:
        tried = ", ".join((info.get("bvid") or atitle or f"#{i+1}") for i, (_, atitle, info) in enumerate(candidates))
        log(f"全部 {len(candidates)} 个候选均无弹幕数据: {tried}")
        print(f"BILI_RESULT:{json.dumps({'ok': False, 'error': f'已试{len(candidates)}个候选均无弹幕数据({tried})'}, ensure_ascii=False)}")
        sys.exit(1)

    # 选择策略：只取弹幕最多的单集候选单源（不合并多源，保证弹幕对得上当前集）。
    final_dm, best_cid, best_atitle, best_info, source, agg_count, srcs = _select_danmaku(
        fetched, agg_threshold, AGG_TIME_LIMIT, MIN_DANMAKU)
    # 弹幕屏蔽类型：按应用设置面板写入的 danmaku_block_types.json 过滤（B站补源弹幕）
    block_types = _load_block_types()
    if block_types:
        before = len(final_dm)
        final_dm = _filter_danmaku(final_dm, block_types)
        log(f"弹幕屏蔽类型生效: 移除 {before - len(final_dm)} 条 (类型={','.join(sorted(block_types))}), 剩余 {len(final_dm)} 条")
    _write_xml(out, final_dm)
    _emit_result(title, best_cid, best_atitle, best_info, len(final_dm), source, aggregated_from=agg_count)
    if agg_count:
        log(f"✅ 最终输出(聚合 {agg_count} 源): {best_atitle} -> {len(final_dm)} 条弹幕 (源: {srcs}) -> {out}")
    else:
        log(f"✅ 最终输出: {best_atitle} -> {len(final_dm)} 条弹幕 (source={source}) -> {out}")
    sys.exit(0)

if __name__ == "__main__":
    main()
