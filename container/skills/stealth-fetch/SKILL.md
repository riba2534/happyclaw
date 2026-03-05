---
name: stealth-fetch
description: >
  Anti-bot web fetcher with TLS fingerprint impersonation, stealth browser, and Cloudflare bypass.
  Use this skill BEFORE giving up on fetching a URL. Trigger when:
  (1) WebFetch or curl returns 403, 503, "Access Denied", "Just a moment...", or empty response from any website;
  (2) User says a site is "blocked", "protected", "behind Cloudflare", or asks to "bypass" / "绕过" anti-bot;
  (3) Need to scrape a JS-rendered SPA where static HTTP gets empty/incomplete content;
  (4) User asks to extract data from a site that uses bot detection or CAPTCHA;
  (5) Previous fetch attempt failed with signs of anti-bot (short response, challenge page, redirect loop).
  Supports modes: http (TLS impersonation, ~1s), dynamic (stealth headless browser, ~5s),
  stealth (Cloudflare Turnstile solver, ~10s), auto (tries all three, escalating on failure).
  Always try this skill when WebFetch fails on a public website — it handles most anti-bot scenarios
  that block standard HTTP clients. Not guaranteed for enterprise IP reputation blocks.
---

# Stealth Fetch (反爬隐蔽抓取)

Anti-bot web fetcher based on [Scrapling](https://github.com/D4Vinci/Scrapling). When a normal HTTP request fails due to bot detection, this tool can often get through by impersonating a real browser's TLS fingerprint and behavior.

## Decision guide

```
WebFetch / curl failed?
  ├── 403 "Attention Required" / "Access Denied"
  │     → Try --mode http first (TLS fingerprint often enough)
  │     → If still blocked → --mode stealth
  ├── Empty content / JS-only page
  │     → --mode dynamic (renders JavaScript)
  ├── "Just a moment..." Cloudflare challenge
  │     → --mode stealth (auto-solves Turnstile)
  ├── Not sure what's blocking?
  │     → --mode auto (tries http → dynamic → stealth)
  └── Still blocked after stealth?
        → Enterprise IP block, needs residential proxy (--proxy)
```

## First-time setup

```bash
# Required: install core dependencies (~50MB)
python3 ~/.claude/skills/stealth-fetch/scripts/fetch.py --setup

# Optional: install Chromium for dynamic/stealth modes (~300MB)
python3 ~/.claude/skills/stealth-fetch/scripts/fetch.py --setup-browsers
```

## Usage

```bash
# Basic fetch with TLS fingerprint impersonation (fastest)
python3 ~/.claude/skills/stealth-fetch/scripts/fetch.py "https://example.com"

# Auto mode: tries http → dynamic → stealth, stops on success
python3 ~/.claude/skills/stealth-fetch/scripts/fetch.py "https://protected-site.com" --mode auto

# Bypass Cloudflare Turnstile specifically
python3 ~/.claude/skills/stealth-fetch/scripts/fetch.py "https://cf-site.com" --mode stealth

# JS-rendered page (SPA, React, etc.)
python3 ~/.claude/skills/stealth-fetch/scripts/fetch.py "https://spa-site.com" --mode dynamic --wait 5000

# Extract specific content with CSS selectors
python3 ~/.claude/skills/stealth-fetch/scripts/fetch.py "https://example.com" --css "h1::text" --css ".content p::text"

# JSON output (for programmatic use)
python3 ~/.claude/skills/stealth-fetch/scripts/fetch.py "https://example.com" --json

# POST request with data
python3 ~/.claude/skills/stealth-fetch/scripts/fetch.py "https://api.example.com" --method POST --data '{"key":"value"}'

# Custom headers
python3 ~/.claude/skills/stealth-fetch/scripts/fetch.py "https://example.com" --header "Authorization: Bearer token"

# With proxy
python3 ~/.claude/skills/stealth-fetch/scripts/fetch.py "https://example.com" --proxy socks5://127.0.0.1:1080
```

## Modes

| Mode | Engine | Speed | Anti-bot level | Setup |
|------|--------|-------|----------------|-------|
| `http` (default) | curl_cffi TLS impersonation | ~1s | TLS fingerprint, User-Agent | `--setup` |
| `dynamic` | Patchright (stealth Chromium) | ~5s | JS rendering, light anti-bot | `--setup-browsers` |
| `stealth` | Patchright + CF Solver | ~10s | Cloudflare Turnstile | `--setup-browsers` |
| `auto` | Tries http → dynamic → stealth | varies | Escalates on failure | `--setup-browsers` |

## Output

- **Default**: raw content to stdout (HTML, JSON, or extracted text)
- **`--json`**: `{"url", "status", "content", "content_type", "mode", "elapsed_ms"}`
- **`--css`**: extracted text from CSS selectors, one match per line

## Limitations

- Enterprise Cloudflare (IP reputation), Akamai, DataDome may still block from datacenter IPs
- Browser modes require ~300MB disk and significant CPU/RAM
- Not suitable for high-volume concurrent scraping (use http mode for that)
