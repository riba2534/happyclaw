---
name: fund-query
description: Query Chinese mutual fund (基金) information including purchase limits, NAV, fees, and scale. Use this skill whenever the user asks about fund purchase quotas (限购额度), QDII fund availability, fund NAV (净值), fund fees (费率), or wants to compare multiple funds. Also trigger when the user mentions specific fund codes (like 539001, 019172, 021000), fund names (like 建信纳指, 摩根纳指, 南方纳指), or asks about 纳斯达克100/纳指100 QDII funds. Use this even when the user just wants to check if a fund is open for purchase (申购状态), or wants to search for a fund by name. Also supports querying direct sales channel (直销渠道) purchase limits from fund company websites.
---

# Fund Query (基金信息查询)

Query real-time fund data from Eastmoney (天天基金网) and fund company direct sales channels (直销渠道), including purchase limits, NAV, fees, and scale.

## When to use

- User asks about fund purchase limits (限购额度/申购限额)
- User asks about direct sales limits (直销限额/直销额度/官方APP额度)
- User asks about fund NAV (净值), fees (费率), or scale (规模)
- User wants to compare multiple QDII funds
- User asks if a specific fund is open for purchase
- User mentions fund codes or names
- User wants to search for a fund by name (模糊搜索)

## How to use

Run the query script with fund codes:

```bash
# Query specific funds by code
python3 ~/.claude/skills/fund-query/scripts/query_funds.py 539001 019172 270042

# Query all pre-configured 纳指100 QDII funds
python3 ~/.claude/skills/fund-query/scripts/query_funds.py --preset nasdaq100

# Query S&P 500 QDII funds
python3 ~/.claude/skills/fund-query/scripts/query_funds.py --preset sp500

# Search fund by name (returns code, name, type)
python3 ~/.claude/skills/fund-query/scripts/query_funds.py --search 南方纳斯达克

# Sort by direct sales limit
python3 ~/.claude/skills/fund-query/scripts/query_funds.py --preset sp500 --sort direct_limit

# Output as JSON for programmatic use
python3 ~/.claude/skills/fund-query/scripts/query_funds.py --preset nasdaq100 --json

# Force refresh (ignore all caches)
python3 ~/.claude/skills/fund-query/scripts/query_funds.py --preset nasdaq100 --no-cache
```

### Presets

- `nasdaq100` — All major 纳斯达克100 QDII funds (27 funds, A/C/D/E/I class)
- `nasdaq100_i` — I/F class shares only (直销专属, lower fees)
- `sp500` — S&P 500 QDII funds (16 funds: 博时/易方达/摩根/天弘/大成/国泰/华夏)
- `qdii` — All tracked QDII funds (nasdaq100 + sp500)

### Output fields

| Field | Description |
|-------|-------------|
| code | Fund code (基金代码) |
| name | Fund name (基金名称) |
| nav | Latest NAV (最新净值) |
| nav_date | NAV date (净值日期) |
| nav_change | NAV daily change % (日涨跌) |
| status | Purchase status: 开放申购/限大额/暂停申购 |
| daily_limit | Third-party channel daily limit (三方渠道每日限额, from Eastmoney) |
| direct_limit | Direct sales channel limit (直销渠道限额, from fund company) |
| mgr_fee | Management fee (管理费) |
| trust_fee | Custody fee (托管费) |
| sales_fee | Sales service fee (销售服务费, I/F class) |
| scale | Fund scale in 亿元 (基金规模) |

## Interpreting results

- **三方限额** = limit on third-party platforms (天天基金, 支付宝, etc.)
- **直销限额** = limit on fund company's own APP (直销渠道), often higher than third-party
- **限大额** means the fund accepts purchases but with a daily cap
- **暂停申购** means purchases are completely suspended
- A limit of "N/A" or "-" means the limit couldn't be determined
- Scale data may lag by up to a quarter (reported quarterly)
- NAV for QDII funds typically has a 1-2 day delay vs US market close
- **I/F class** shares are 直销专属 (only available on fund company's own app)

## Key learnings (2026-03)

- ALL Nasdaq 100 QDII A/C class funds have ≤100元/day limits (most are 10-50元)
- **021000 南方纳指100 I class** has 2000元/day on 南方基金 APP
- **018738 博时标普500联接E** has 1000元/day on 博时基金 APP (auto-detected)
- Direct sales limits are often **higher** than third-party channel limits
- Purchase limits are **per person across all channels** (多渠道共享), not per platform
- QDII quotas are allocated by SAFE roughly once a year

## Data sources

1. **Eastmoney Mobile API** — NAV, fees, scale, fund name (structured JSON)
2. **Eastmoney Web Page** — Purchase status, third-party daily limit (HTML scraping)
3. **Eastmoney Suggest API** — Fund name search
4. **Bosera (博时基金) Website** — Direct sales limits (auto-scraped from window.fundListJson)
5. **Auto-derived** — Most A/C class direct limits = third-party limits (易方达/摩根/天弘/华夏/南方等)
6. **Manual overrides** — I/F/E/D class & 大成/华安 (direct limits differ from third-party)

### Cache

- Eastmoney data: 5-minute TTL (`/tmp/.fund_cache.json`)
- Direct sales data: 30-minute TTL (`/tmp/.fund_direct_cache.json`)
- Use `--no-cache` to force refresh both caches
