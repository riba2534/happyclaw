#!/usr/bin/env python3
"""
Fund Query Tool - 基金信息查询 (v3.1)
Fetches fund data from Eastmoney (天天基金网) including purchase limits, NAV, fees, and scale.
Also queries direct sales channel (直销渠道) purchase limits from fund company websites.

Changes in v3.1 (2026-03-03):
  - Improved: Bosera scrape only triggers when queried codes include Bosera funds
  - Improved: direct sales cache changed to per-fund granularity (30min TTL)
  - Improved: manual direct limits loadable from external direct_limits.json
  - Improved: thread pool exception handling (single fund failure no longer crashes query)
  - Improved: progress output uses \\n instead of \\r in non-TTY environments

Changes in v3 (2026-03-03):
  - New: direct sales channel (直销) purchase limit queries
  - New: Bosera (博时) auto-scrape via window.fundListJson
  - New: MANUAL_DIRECT_LIMITS for funds where scraping is not feasible
  - New: "直销限额" column in table output
  - New: --sort direct_limit option
  - Expanded: sp500 preset (3 → 9 funds)

Changes in v2 (2026-03-02):
  - Fix: cache removal OSError on read-only filesystem
  - New: --search flag to search fund codes by Chinese name
  - New: fallback HTML fee scraping when mobile API returns empty
  - New: I-class funds in presets (021000 南方纳指100I etc.)
  - Improved: purchase limit parsing with more regex patterns
  - Improved: batch NAV with per-fund fallback when batch returns partial

Usage:
    python3 query_funds.py 539001 019172          # Query specific funds
    python3 query_funds.py --preset nasdaq100      # Query preset group
    python3 query_funds.py --preset nasdaq100 --json  # JSON output
    python3 query_funds.py --search 南方纳斯达克     # Search fund by name
    python3 query_funds.py --preset nasdaq100 --sort nav_change  # Sort by field
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed

# ── Preset fund groups ──────────────────────────────────────────────

PRESETS = {
    "nasdaq100": [
        ("539001", "建信纳指100A"),
        ("012752", "建信纳指100C"),
        ("019172", "摩根纳指100A"),
        ("270042", "广发纳指100联接A"),
        ("019547", "招商纳指100联接A"),
        ("000834", "大成纳指100联接A"),
        ("161130", "易方达纳指100联接"),
        ("160213", "国泰纳指100"),
        ("015299", "华夏纳指100联接A"),
        ("016532", "嘉实纳指100联接A"),
        ("018043", "天弘纳指100A"),
        ("016055", "博时纳指100联接A"),
        ("019524", "华泰柏瑞纳指100联接A"),
        ("018966", "汇添富纳指100联接A"),
        ("016452", "南方纳指100A"),
        ("040046", "华安纳指100联接A"),
        ("021000", "南方纳指100I"),
    ],
    "nasdaq100_i": [
        # I/F class shares with lower fees (直销专属)
        ("021000", "南方纳指100I"),
        ("021778", "广发纳指100F"),
    ],
    "sp500": [
        ("050025", "博时标普500联接A"),
        ("006075", "博时标普500联接C"),
        ("018738", "博时标普500联接E"),
        ("161125", "易方达标普500A"),
        ("012860", "易方达标普500C"),
        ("017641", "摩根标普500A"),
        ("019305", "摩根标普500C"),
        ("007721", "天弘标普500A"),
        ("007722", "天弘标普500C"),
    ],
    "qdii": [],  # Will be populated as nasdaq100 + sp500
}
PRESETS["qdii"] = PRESETS["nasdaq100"] + PRESETS["sp500"]

# ── Direct sales (直销) purchase limits ──────────────────────────
# Manual overrides loaded from external JSON, with inline fallback.
# Bosera (博时) limits are auto-scraped; manual entries override auto-scraped values.

_DEFAULT_DIRECT_LIMITS = {
    # 南方基金
    "021000": "10万元",      # 南方纳指100I (南方基金APP)
    "016452": "暂停申购",    # 南方纳指100A
    # 易方达
    "161125": "暂停申购",    # 易方达标普500A
    "012860": "暂停申购",    # 易方达标普500C
    "161130": "暂停申购",    # 易方达纳指100联接
    # 天弘
    "018043": "100元",       # 天弘纳指100A
    "007721": "100元",       # 天弘标普500A
    "007722": "100元",       # 天弘标普500C
    # 摩根
    "019172": "50元",        # 摩根纳指100A
    "017641": "50元",        # 摩根标普500A
    "019305": "50元",        # 摩根标普500C
    # 华夏
    "015299": "100元",       # 华夏纳指100联接A
}

# Known Bosera (博时) fund code prefixes for smart scrape gating
_BOSERA_CODES_IN_PRESETS = {"050025", "006075", "018738", "016055"}


def _load_manual_direct_limits():
    """Load manual direct limits from external JSON if available, else use defaults."""
    json_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "direct_limits.json")
    try:
        with open(json_path, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return _DEFAULT_DIRECT_LIMITS

# ── HTTP helpers ────────────────────────────────────────────────────

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36",
}
MAX_WORKERS = 4  # concurrent threads for detail/limit requests

# ── Cache ───────────────────────────────────────────────────────────

CACHE_TTL = 300  # 5 minutes
CACHE_FILE = os.path.join(os.environ.get("TMPDIR", "/tmp"), ".fund_cache.json")


def load_cache():
    """Load cache from file, return dict of {code: {data, ts}}."""
    try:
        with open(CACHE_FILE, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def save_cache(cache):
    """Save cache to file."""
    try:
        with open(CACHE_FILE, "w") as f:
            json.dump(cache, f, ensure_ascii=False)
    except OSError:
        pass


def get_cached(code, cache):
    """Get cached result if still valid."""
    entry = cache.get(code)
    if entry and time.time() - entry.get("ts", 0) < CACHE_TTL:
        return entry.get("data")
    return None


def set_cached(code, data, cache):
    """Set cache entry."""
    cache[code] = {"data": data, "ts": time.time()}


# ── HTTP fetch ──────────────────────────────────────────────────────

def fetch_url(url, timeout=15):
    """Fetch URL content with error handling."""
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        resp = urllib.request.urlopen(req, timeout=timeout)
        return resp.read().decode("utf-8", errors="ignore")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
        sys.stderr.write(f"  ⚠ 请求失败: {url} ({e})\n")
        return None


def fetch_json(url, timeout=15):
    """Fetch and parse JSON from URL."""
    content = fetch_url(url, timeout)
    if content is None:
        return None
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        sys.stderr.write(f"  ⚠ JSON解析失败: {url}\n")
        return None


# ── Fund search by name ────────────────────────────────────────────

def search_fund(keyword):
    """Search fund codes by Chinese name using Eastmoney suggest API.
    Returns list of (code, name, type) tuples.
    """
    encoded = urllib.parse.quote(keyword)
    url = (
        f"https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx"
        f"?callback=&m=1&key={encoded}"
    )
    data = fetch_json(url)
    if not data or not data.get("Datas"):
        return []

    results = []
    for item in data["Datas"]:
        code = item.get("CODE", "")
        name = item.get("NAME", "")
        ftype = item.get("FundType", "")
        if code:
            results.append((code, name, ftype))
    return results


# ── Data fetching ───────────────────────────────────────────────────

def fetch_nav_batch(codes):
    """Fetch NAV data for multiple funds. Try batch first, fallback to individual.
    Returns dict: {code: {name, nav, acc_nav, nav_date, nav_change}}
    """
    result = {}

    # Try batch request first
    codes_str = ",".join(codes)
    url = (
        f"https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo"
        f"?pageIndex=1&pageSize={len(codes)}&plat=Android&appType=ttjj"
        f"&product=EFund&Version=6.2.4&Fcodes={codes_str}"
        f"&SortColumn=DWJZ&Sort=desc&deviceid=fundquery"
    )
    data = fetch_json(url)
    if data:
        datas = data.get("Datas") or []
        for item in datas:
            code = item.get("FCODE", "")
            if code:
                result[code] = {
                    "name": item.get("SHORTNAME", ""),
                    "nav": item.get("NAV", "N/A"),
                    "acc_nav": item.get("ACCNAV", "N/A"),
                    "nav_date": item.get("PDATE", "N/A"),
                    "nav_change": item.get("NAVCHGRT", "N/A"),
                }

    # Fallback: query missing codes individually
    missing = [c for c in codes if c not in result]
    if missing:
        sys.stderr.write(f"  批量缺失 {len(missing)} 只，逐个查询...\n")
        for code in missing:
            single_url = (
                f"https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo"
                f"?pageIndex=1&pageSize=1&plat=Android&appType=ttjj"
                f"&product=EFund&Version=6.2.4&Fcodes={code}"
                f"&deviceid=fundquery"
            )
            single_data = fetch_json(single_url)
            if single_data:
                datas = single_data.get("Datas") or []
                if datas:
                    item = datas[0]
                    result[code] = {
                        "name": item.get("SHORTNAME", ""),
                        "nav": item.get("NAV", "N/A"),
                        "acc_nav": item.get("ACCNAV", "N/A"),
                        "nav_date": item.get("PDATE", "N/A"),
                        "nav_change": item.get("NAVCHGRT", "N/A"),
                    }

    return result


def fetch_detail(code):
    """Fetch fund detail (fees, scale) from Eastmoney mobile API.
    Falls back to HTML scraping if API returns empty.
    """
    url = (
        f"https://fundmobapi.eastmoney.com/FundMNewApi/FundMNDetailInformation"
        f"?FCODE={code}&plat=Android&appType=ttjj"
        f"&product=EFund&Version=6.2.4&deviceid=fundquery"
    )
    data = fetch_json(url)
    detail = (data.get("Datas") or {}) if data else {}

    # Check if API returned meaningful data
    has_api_data = detail.get("MGREXP") or detail.get("ENDNAV")

    if has_api_data:
        scale_raw = detail.get("ENDNAV", "0")
        try:
            scale = f"{float(scale_raw) / 1e8:.2f}亿"
        except (ValueError, TypeError):
            scale = "N/A"

        return {
            "mgr_fee": detail.get("MGREXP", "N/A"),
            "trust_fee": detail.get("TRUSTEXP", "N/A"),
            "sales_fee": detail.get("SALESEXP", "N/A"),
            "scale": scale,
            "scale_date": detail.get("FEGMRQ", "N/A"),
            "established": detail.get("ESTABDATE", "N/A"),
            "fund_company": detail.get("JJGS", "N/A"),
            "fund_manager": detail.get("JJJL", "N/A"),
        }

    # Fallback: scrape fees from HTML page
    return fetch_detail_from_html(code)


def fetch_detail_from_html(code):
    """Fallback: scrape fee and scale info from Eastmoney HTML pages."""
    result = {
        "mgr_fee": "N/A",
        "trust_fee": "N/A",
        "sales_fee": "N/A",
        "scale": "N/A",
        "scale_date": "N/A",
        "established": "N/A",
        "fund_company": "N/A",
        "fund_manager": "N/A",
    }

    # Try fee page
    fee_url = f"https://fundf10.eastmoney.com/jjfl_{code}.html"
    fee_html = fetch_url(fee_url)
    if fee_html:
        mgr = re.search(r"管理费率.*?([\d.]+%)", fee_html)
        trust = re.search(r"托管费率.*?([\d.]+%)", fee_html)
        sales = re.search(r"销售服务费率.*?([\d.]+%)", fee_html)
        if mgr:
            result["mgr_fee"] = mgr.group(1)
        if trust:
            result["trust_fee"] = trust.group(1)
        if sales:
            result["sales_fee"] = sales.group(1)

    # Try main page for scale and other info
    main_url = f"https://fund.eastmoney.com/{code}.html"
    main_html = fetch_url(main_url)
    if main_html:
        scale = re.search(r"基金规模.*?([\d.]+)\s*亿", main_html)
        if not scale:
            scale = re.search(r"规模.*?([\d.]+)\s*亿元", main_html)
        if scale:
            result["scale"] = f"{scale.group(1)}亿"

        setup = re.search(r"成立日期.*?(\d{4}-\d{2}-\d{2})", main_html)
        if setup:
            result["established"] = setup.group(1)

    return result


def fetch_purchase_limit(code):
    """Fetch purchase status and daily limit from Eastmoney web page."""
    url = f"http://fundf10.eastmoney.com/jjfl_{code}.html"
    content = fetch_url(url)
    if content is None:
        return {"status": "获取失败", "daily_limit": "N/A"}

    # Parse purchase status
    status = "未知"
    if "暂停申购" in content:
        status = "暂停申购"
    elif "限大额" in content:
        status = "限大额"
    elif "开放申购" in content:
        status = "开放申购"

    # Parse daily limit - try multiple patterns
    daily_limit = "N/A"
    patterns = [
        r"单日累计购买上限.*?([\d,]+\.?\d*)\s*([万亿]?)\s*元",
        r"日累计购买上限.*?([\d,]+\.?\d*)\s*([万亿]?)\s*元",
        r"购买上限.*?([\d,]+\.?\d*)\s*([万亿]?)\s*元",
        r"申购上限.*?([\d,]+\.?\d*)\s*([万亿]?)\s*元",
        r"限额.*?([\d,]+\.?\d*)\s*([万亿]?)\s*元",
        r"单笔限额.*?([\d,]+\.?\d*)\s*([万亿]?)\s*元",
    ]
    for pattern in patterns:
        m = re.search(pattern, content)
        if m:
            amount = m.group(1).strip()
            unit = m.group(2).strip() if m.lastindex >= 2 else ""
            daily_limit = f"{amount}{unit}元"
            break

    # If still N/A and status is 限大额, try to get from announcement text
    if daily_limit == "N/A" and status == "限大额":
        # Look for any number followed by 元 near 限购/限额 keywords
        limit_area = re.search(r"(限购|限额|大额申购)[^<]{0,200}?([\d,]+\.?\d*)\s*([万亿]?)\s*元", content)
        if limit_area:
            amount = limit_area.group(2).strip()
            unit = limit_area.group(3).strip()
            daily_limit = f"{amount}{unit}元"

    return {"status": status, "daily_limit": daily_limit}


# ── Direct sales channel (直销渠道) limits ─────────────────────────

DIRECT_CACHE_FILE = os.path.join(os.environ.get("TMPDIR", "/tmp"), ".fund_direct_cache.json")
DIRECT_CACHE_TTL = 1800  # 30 minutes


def _load_direct_cache():
    try:
        with open(DIRECT_CACHE_FILE, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _save_direct_cache(data):
    try:
        with open(DIRECT_CACHE_FILE, "w") as f:
            json.dump(data, f, ensure_ascii=False)
    except OSError:
        pass


def _parse_bosera_limit(desc):
    """Parse Bosera limitLargeDesc like '单日基金账号限额1,000.00元' to '1000元'."""
    if not desc or desc.strip() in ("", " "):
        return ""
    if "暂停" in desc:
        return "暂停申购"
    m = re.search(r"([\d,]+)(?:\.00)?\s*元", desc)
    if not m:
        return desc.strip()
    raw = m.group(1).replace(",", "")
    try:
        val = int(raw)
    except ValueError:
        return desc.strip()
    if val >= 100000000:
        return f"{val // 100000000}亿元"
    if val >= 10000:
        return f"{val // 10000}万元"
    return f"{val}元"


def fetch_bosera_direct_limits():
    """Fetch direct sales limits from Bosera (博时基金) fund list page.
    Parses window.fundListJson embedded in HTML.
    Returns dict: {fund_code: limit_description}
    """
    url = "https://www.bosera.com/fund/index.html"
    html = fetch_url(url, timeout=20)
    if not html:
        sys.stderr.write("  ⚠ 博时基金网站请求失败\n")
        return {}

    m = re.search(r'window\.fundListJson\s*=\s*(\[.*?\])\s*;', html, re.DOTALL)
    if not m:
        sys.stderr.write("  ⚠ 博时基金: 未找到 fundListJson\n")
        return {}

    try:
        fund_list = json.loads(m.group(1))
    except json.JSONDecodeError:
        sys.stderr.write("  ⚠ 博时基金: JSON解析失败\n")
        return {}

    result = {}
    for fund in fund_list:
        code = fund.get("fundCode", "")
        if not code:
            continue
        status = fund.get("fundStatus", "")
        limit_desc = fund.get("limitLargeDesc", "").strip()

        if status in ("5", "9"):  # 5=暂停申购, 9=终止
            result[code] = "暂停申购"
        elif limit_desc and limit_desc != " ":
            result[code] = _parse_bosera_limit(limit_desc)
        else:
            result[code] = "无限制"

    return result


def fetch_direct_limits(codes):
    """Fetch direct sales channel purchase limits for given fund codes.
    Combines: Bosera auto-scrape (only if needed) + manual overrides.
    Uses per-fund cache entries for finer granularity.
    Returns dict: {code: limit_string}
    """
    now = time.time()
    cache = _load_direct_cache()
    manual_limits = _load_manual_direct_limits()

    # Check per-fund cache
    result = {}
    uncached = []
    for c in codes:
        entry = cache.get(c)
        if entry and now - entry.get("ts", 0) < DIRECT_CACHE_TTL:
            result[c] = entry.get("val", "")
        else:
            uncached.append(c)

    if not uncached:
        return result

    sys.stderr.write("  [3/3] 查询直销渠道限额...\n")

    # Only scrape Bosera if any uncached code is a Bosera fund
    bosera_limits = {}
    needs_bosera = any(c in _BOSERA_CODES_IN_PRESETS for c in uncached)
    if needs_bosera:
        bosera_limits = fetch_bosera_direct_limits()

    # Merge: Bosera auto → manual overrides (higher priority)
    for c in uncached:
        val = manual_limits.get(c) or bosera_limits.get(c, "")
        result[c] = val
        cache[c] = {"val": val, "ts": now}

    _save_direct_cache(cache)
    return result


# ── Concurrent query ────────────────────────────────────────────────

def fetch_detail_and_limit(code):
    """Fetch both detail and purchase limit for a fund (used in thread pool)."""
    detail = fetch_detail(code)
    limit = fetch_purchase_limit(code)
    return code, {**detail, **limit}


def query_funds(codes):
    """Query data for multiple funds with batch NAV + concurrent detail/limit."""
    cache = load_cache()

    # Check cache first
    cached_results = {}
    uncached_codes = []
    for code in codes:
        cached = get_cached(code, cache)
        if cached:
            cached_results[code] = cached
        else:
            uncached_codes.append(code)

    if cached_results:
        sys.stderr.write(f"缓存命中: {len(cached_results)} 只 | ")

    if not uncached_codes:
        sys.stderr.write("全部来自缓存\n")
        return [cached_results[c] for c in codes]

    total = len(uncached_codes)
    sys.stderr.write(f"查询中: {total} 只基金...\n")

    # Step 1: Batch NAV query (single request for all funds)
    sys.stderr.write("  [1/3] 批量获取净值...\n")
    nav_map = fetch_nav_batch(uncached_codes)

    # Step 2: Concurrent detail + purchase limit queries
    sys.stderr.write(f"  [2/3] 并发获取详情+限额 (workers={MAX_WORKERS})...\n")
    detail_limit_map = {}
    is_tty = hasattr(sys.stderr, "isatty") and sys.stderr.isatty()
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {
            executor.submit(fetch_detail_and_limit, code): code
            for code in uncached_codes
        }
        done_count = 0
        for future in as_completed(futures):
            fund_code = futures[future]
            try:
                code, data = future.result()
                detail_limit_map[code] = data
            except Exception as e:
                sys.stderr.write(f"\n  ⚠ {fund_code} 查询异常: {e}\n")
                detail_limit_map[fund_code] = {
                    "mgr_fee": "N/A", "trust_fee": "N/A", "sales_fee": "N/A",
                    "scale": "N/A", "status": "获取失败", "daily_limit": "N/A",
                }
            done_count += 1
            if is_tty:
                sys.stderr.write(f"\r  进度: {done_count}/{total}")
                sys.stderr.flush()

    if is_tty:
        sys.stderr.write("\n")
    else:
        sys.stderr.write(f"  进度: {done_count}/{total}\n")

    # Step 3: Direct sales channel limits (single batch)
    direct_limits = fetch_direct_limits(uncached_codes)

    # Merge results
    new_results = {}
    for code in uncached_codes:
        result = {"code": code}
        result.update(nav_map.get(code, {}))
        result.update(detail_limit_map.get(code, {}))
        result["direct_limit"] = direct_limits.get(code, "")
        new_results[code] = result
        set_cached(code, result, cache)

    # Save cache
    save_cache(cache)

    # Combine cached + new in original order
    return [cached_results.get(c) or new_results.get(c, {"code": c}) for c in codes]


# ── Sorting ─────────────────────────────────────────────────────────

def parse_limit_value(limit_str):
    """Parse daily limit string to numeric value in CNY for sorting."""
    if not limit_str or limit_str == "N/A":
        return -1
    m = re.match(r"([\d,.]+)\s*([万亿]?)\s*元", limit_str)
    if not m:
        return -1
    val = float(m.group(1).replace(",", ""))
    unit = m.group(2)
    if unit == "万":
        val *= 10000
    elif unit == "亿":
        val *= 100000000
    return val


def sort_results(results, sort_key, reverse=True):
    """Sort results by the given key."""
    if sort_key == "daily_limit":
        return sorted(results, key=lambda r: parse_limit_value(r.get("daily_limit", "N/A")), reverse=reverse)
    elif sort_key == "direct_limit":
        return sorted(results, key=lambda r: parse_limit_value(r.get("direct_limit", "") or "N/A"), reverse=reverse)
    elif sort_key == "nav_change":
        def nav_change_val(r):
            v = r.get("nav_change", "N/A")
            try:
                return float(v)
            except (ValueError, TypeError):
                return float("-inf")
        return sorted(results, key=nav_change_val, reverse=reverse)
    elif sort_key == "scale":
        def scale_val(r):
            s = r.get("scale", "N/A")
            m = re.match(r"([\d.]+)亿", s)
            return float(m.group(1)) if m else -1
        return sorted(results, key=scale_val, reverse=reverse)
    elif sort_key == "nav":
        def nav_val(r):
            try:
                return float(r.get("nav", "0"))
            except (ValueError, TypeError):
                return -1
        return sorted(results, key=nav_val, reverse=reverse)
    else:
        return results


# ── Output formatting ───────────────────────────────────────────────

def format_table(results):
    """Format results as a readable table."""
    lines = []
    lines.append(
        f"{'代码':<10} {'名称':<28} {'净值':>8} {'日期':>12} {'涨跌%':>7} "
        f"{'状态':<8} {'三方限额':<10} {'直销限额':<10} "
        f"{'管理费':<7} {'托管费':<7} {'规模':<10}"
    )
    lines.append("-" * 140)

    for r in results:
        name = r.get("name", r.get("code", "?"))
        if len(name) > 25:
            name = name[:23] + ".."
        direct = r.get("direct_limit", "") or "-"
        lines.append(
            f"{r.get('code', '?'):<10} {name:<28} "
            f"{r.get('nav', 'N/A'):>8} {r.get('nav_date', 'N/A'):>12} "
            f"{r.get('nav_change', 'N/A'):>7} {r.get('status', '?'):<8} "
            f"{r.get('daily_limit', 'N/A'):<10} {direct:<10} "
            f"{r.get('mgr_fee', 'N/A'):<7} {r.get('trust_fee', 'N/A'):<7} "
            f"{r.get('scale', 'N/A'):<10}"
        )

    # Summary
    lines.append("")
    open_count = sum(1 for r in results if r.get("status") == "开放申购")
    limited_count = sum(1 for r in results if r.get("status") == "限大额")
    suspended_count = sum(1 for r in results if r.get("status") == "暂停申购")
    lines.append(f"共 {len(results)} 只基金 | 开放申购: {open_count} | 限大额: {limited_count} | 暂停申购: {suspended_count}")

    # Highlight funds with higher limits (三方渠道)
    high_limit = []
    for r in results:
        limit_str = r.get("daily_limit", "N/A")
        if limit_str == "N/A":
            continue
        val = parse_limit_value(limit_str)
        if val >= 500 and r.get("status") != "暂停申购":
            high_limit.append((r.get("code", "?"), r.get("name", ""), limit_str))

    if high_limit:
        lines.append("")
        lines.append("三方渠道额度 ≥ 500元:")
        for code, name, limit in high_limit:
            lines.append(f"  {code} {name} — {limit}")

    # Highlight funds with higher direct sales limits
    high_direct = []
    for r in results:
        dl = r.get("direct_limit", "")
        if not dl or dl in ("暂停申购", "-"):
            continue
        val = parse_limit_value(dl)
        if val >= 500:
            high_direct.append((r.get("code", "?"), r.get("name", ""), dl))

    if high_direct:
        lines.append("")
        lines.append("直销渠道额度 ≥ 500元:")
        for code, name, limit in high_direct:
            lines.append(f"  {code} {name} — {limit}")

    if not high_limit and not high_direct:
        lines.append("")
        lines.append("⚠ 没有找到每日限额 ≥ 500元 且可申购的基金")

    return "\n".join(lines)


def format_search_results(results):
    """Format fund search results."""
    lines = []
    lines.append(f"{'代码':<10} {'名称':<50} {'类型':<15}")
    lines.append("-" * 75)
    for code, name, ftype in results:
        lines.append(f"{code:<10} {name:<50} {ftype or '':<15}")
    lines.append(f"\n共找到 {len(results)} 只基金")
    return "\n".join(lines)


# ── CLI entry point ─────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="查询基金限购额度、净值、费率等信息 (数据来源: 天天基金网 + 基金公司直销)"
    )
    parser.add_argument("codes", nargs="*", help="基金代码 (可多个)")
    parser.add_argument(
        "--preset",
        choices=list(PRESETS.keys()),
        help="使用预设基金组 (nasdaq100/nasdaq100_i/sp500/qdii)",
    )
    parser.add_argument("--json", action="store_true", help="输出 JSON 格式")
    parser.add_argument(
        "--search",
        metavar="KEYWORD",
        help="按名称搜索基金代码 (如: 南方纳斯达克)",
    )
    parser.add_argument(
        "--fields",
        help="只输出指定字段 (逗号分隔, 如: code,name,status,daily_limit)",
    )
    parser.add_argument(
        "--sort",
        choices=["daily_limit", "direct_limit", "nav_change", "scale", "nav"],
        default="daily_limit",
        help="排序字段 (默认: daily_limit)",
    )
    parser.add_argument(
        "--asc",
        action="store_true",
        help="升序排列 (默认降序)",
    )
    parser.add_argument(
        "--no-cache",
        action="store_true",
        help="忽略缓存，强制重新查询",
    )

    args = parser.parse_args()

    # Search mode
    if args.search:
        results = search_fund(args.search)
        if not results:
            print(f"未找到匹配 '{args.search}' 的基金")
            sys.exit(0)
        if args.json:
            print(json.dumps([{"code": c, "name": n, "type": t} for c, n, t in results], ensure_ascii=False, indent=2))
        else:
            print(format_search_results(results))
        sys.exit(0)

    # Determine which funds to query
    codes = []
    if args.preset:
        codes = [c for c, _ in PRESETS[args.preset]]
    if args.codes:
        codes.extend(args.codes)

    if not codes:
        parser.print_help()
        sys.exit(1)

    # Remove duplicates while preserving order
    seen = set()
    unique_codes = []
    for c in codes:
        if c not in seen:
            seen.add(c)
            unique_codes.append(c)
    codes = unique_codes

    # Clear cache if requested
    if args.no_cache:
        for cf in (CACHE_FILE, DIRECT_CACHE_FILE):
            try:
                os.remove(cf)
            except (FileNotFoundError, OSError):
                pass

    # Query
    t0 = time.time()
    results = query_funds(codes)
    elapsed = time.time() - t0
    sys.stderr.write(f"查询完成, 耗时 {elapsed:.1f}s\n")

    # Sort
    results = sort_results(results, args.sort, reverse=not args.asc)

    # Filter fields if requested
    if args.fields:
        fields = [f.strip() for f in args.fields.split(",")]
        results = [{k: v for k, v in r.items() if k in fields} for r in results]

    # Output
    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        print(format_table(results))


if __name__ == "__main__":
    main()
