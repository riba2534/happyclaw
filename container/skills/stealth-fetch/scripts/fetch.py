#!/usr/bin/env python3
"""
Stealth Fetch — anti-bot web fetcher based on Scrapling.

Supports three modes:
  http    — curl_cffi TLS fingerprint impersonation (fast, lightweight)
  dynamic — Patchright headless browser with stealth patches (JS rendering)
  stealth — Patchright + Cloudflare Turnstile auto-solver

Usage:
  python3 fetch.py "https://example.com"
  python3 fetch.py "https://example.com" --mode stealth --json
  python3 fetch.py --setup
"""

import argparse
import json
import os
import subprocess
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
VENV_DIR = os.path.join(SCRIPT_DIR, ".venv")
VENV_PYTHON = os.path.join(VENV_DIR, "bin", "python3")


# ── Venv bootstrap ──────────────────────────────────────────────

def _in_venv():
    """Check if we're running inside the skill's venv."""
    return os.path.realpath(sys.prefix) == os.path.realpath(VENV_DIR)


def _reexec_in_venv():
    """Re-execute this script using the venv's Python."""
    if not os.path.exists(VENV_PYTHON):
        print("Error: venv not found. Run first:\n"
              "  python3 ~/.claude/skills/stealth-fetch/scripts/fetch.py --setup",
              file=sys.stderr)
        sys.exit(1)
    os.execv(VENV_PYTHON, [VENV_PYTHON, os.path.abspath(__file__)] + sys.argv[1:])


# ── Setup ────────────────────────────────────────────────────────

def _find_uv():
    """Find or install uv."""
    for path in [os.path.expanduser("~/.local/bin/uv"), "/usr/local/bin/uv"]:
        if os.path.exists(path):
            return path
    # Try PATH
    import shutil
    uv = shutil.which("uv")
    if uv:
        return uv
    # Install uv
    print("Installing uv package manager...")
    subprocess.run(
        ["bash", "-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"],
        check=True
    )
    return os.path.expanduser("~/.local/bin/uv")


def setup(install_browsers=False):
    """Create venv and install Scrapling."""
    uv = _find_uv()

    # Create venv
    if not os.path.exists(VENV_DIR):
        print(f"Creating venv at {VENV_DIR}...")
        subprocess.run([uv, "venv", VENV_DIR], check=True)
    else:
        print(f"Venv exists at {VENV_DIR}")

    # Install scrapling
    print("Installing scrapling[fetchers]...")
    env = os.environ.copy()
    env["VIRTUAL_ENV"] = VENV_DIR
    env["PATH"] = os.path.join(VENV_DIR, "bin") + ":" + env.get("PATH", "")
    subprocess.run(
        [uv, "pip", "install", "scrapling[fetchers]"],
        env=env, check=True
    )

    if install_browsers:
        _setup_browsers()

    print("\n✓ Setup complete. You can now use:")
    print('  python3 fetch.py "https://example.com"')
    if not install_browsers:
        print("\nFor dynamic/stealth modes, also run:")
        print("  python3 fetch.py --setup-browsers")


def _setup_browsers():
    """Install browser binaries for dynamic/stealth modes."""
    print("\nInstalling browser binaries (Chromium)...")
    venv_bin = os.path.join(VENV_DIR, "bin")
    env = os.environ.copy()
    env["VIRTUAL_ENV"] = VENV_DIR
    env["PATH"] = venv_bin + ":" + env.get("PATH", "")

    # Install playwright + patchright chromium
    for mod in ["playwright", "patchright"]:
        print(f"  Installing {mod} chromium...")
        subprocess.run(
            [VENV_PYTHON, "-m", mod, "install", "chromium"],
            env=env, check=False  # Don't fail if one fails
        )

    print("✓ Browsers installed.")


# ── Fetch implementations ────────────────────────────────────────

def fetch_http(url, method="GET", headers=None, data=None,
               impersonate="chrome131", proxy=None, timeout=30):
    """HTTP fetch with TLS fingerprint impersonation via curl_cffi."""
    from scrapling.fetchers import Fetcher

    kwargs = {}
    if proxy:
        kwargs["proxy"] = proxy
    if headers:
        kwargs["headers"] = headers

    if method.upper() == "GET":
        page = Fetcher.get(url, stealthy_headers=True,
                           impersonate=impersonate, timeout=timeout,
                           **kwargs)
    else:
        page = Fetcher.post(url, stealthy_headers=True,
                            impersonate=impersonate, timeout=timeout,
                            data=data, **kwargs)
    return page


def fetch_dynamic(url, wait_ms=0, proxy=None, timeout=30000):
    """Fetch with Patchright headless browser (JS rendering + stealth patches)."""
    from scrapling.fetchers import DynamicFetcher

    kwargs = {}
    if proxy:
        kwargs["proxy"] = {"server": proxy}

    page = DynamicFetcher.fetch(
        url,
        headless=True,
        timeout=timeout,
        wait_time=wait_ms if wait_ms > 0 else None,
        **kwargs
    )
    return page


def fetch_stealth(url, wait_ms=0, proxy=None, timeout=30000):
    """Fetch with maximum stealth + Cloudflare Turnstile solver."""
    from scrapling.fetchers import StealthyFetcher

    kwargs = {}
    if proxy:
        kwargs["proxy"] = {"server": proxy}

    page = StealthyFetcher.fetch(
        url,
        headless=True,
        solve_cloudflare=True,
        timeout=timeout,
        wait_time=wait_ms if wait_ms > 0 else None,
        **kwargs
    )
    return page


# ── CSS extraction ───────────────────────────────────────────────

def extract_css(page, selectors):
    """Extract text content using CSS selectors."""
    results = []
    for sel in selectors:
        try:
            matches = page.css(sel).getall()
            results.extend(matches)
        except Exception:
            # Try as single selector
            match = page.css(sel).get()
            if match:
                results.append(match)
    return results


# ── Main ─────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Stealth web fetcher — bypass anti-bot protections"
    )
    parser.add_argument("url", nargs="?", help="URL to fetch")
    parser.add_argument("--mode", choices=["http", "dynamic", "stealth", "auto"],
                        default="http",
                        help="Fetch mode (default: http). 'auto' tries http first, "
                             "escalates to dynamic then stealth on failure.")
    parser.add_argument("--method", default="GET",
                        help="HTTP method (default: GET, http mode only)")
    parser.add_argument("--data", help="Request body (http mode POST)")
    parser.add_argument("--header", action="append", dest="headers",
                        help="Custom header (Key: Value), repeatable")
    parser.add_argument("--css", action="append", dest="css_selectors",
                        help="CSS selector to extract, repeatable")
    parser.add_argument("--json", action="store_true", dest="json_output",
                        help="Output as JSON")
    parser.add_argument("--impersonate", default="chrome131",
                        help="Browser TLS fingerprint (default: chrome131)")
    parser.add_argument("--wait", type=int, default=0,
                        help="Wait ms for JS rendering (dynamic/stealth)")
    parser.add_argument("--proxy", help="Proxy URL (e.g., socks5://127.0.0.1:1080)")
    parser.add_argument("--timeout", type=int, default=30,
                        help="Timeout in seconds (default: 30)")
    parser.add_argument("--setup", action="store_true",
                        help="Install venv and dependencies")
    parser.add_argument("--setup-browsers", action="store_true",
                        help="Install browser binaries for dynamic/stealth")

    args = parser.parse_args()

    # Handle setup commands (don't need venv)
    if args.setup:
        setup(install_browsers=False)
        return
    if args.setup_browsers:
        if not _in_venv():
            if os.path.exists(VENV_PYTHON):
                _reexec_in_venv()  # Re-exec so browser install goes to right path
            else:
                print("Run --setup first.", file=sys.stderr)
                sys.exit(1)
        _setup_browsers()
        return

    # URL is required for fetch
    if not args.url:
        parser.print_help()
        sys.exit(1)

    # Ensure we're in venv
    if not _in_venv():
        _reexec_in_venv()

    # Parse custom headers
    custom_headers = {}
    if args.headers:
        for h in args.headers:
            if ":" in h:
                key, val = h.split(":", 1)
                custom_headers[key.strip()] = val.strip()

    # Suppress Scrapling's noisy logging unless --verbose
    if not os.environ.get("STEALTH_FETCH_VERBOSE"):
        import logging
        logging.getLogger("scrapling").setLevel(logging.WARNING)

    # Fetch
    start = time.time()
    mode = args.mode
    page = None
    last_error = None

    if mode == "auto":
        # Auto-escalation: http → dynamic → stealth
        for try_mode in ["http", "dynamic", "stealth"]:
            try:
                if try_mode == "http":
                    page = fetch_http(
                        args.url, method=args.method,
                        headers=custom_headers or None, data=args.data,
                        impersonate=args.impersonate, proxy=args.proxy,
                        timeout=args.timeout,
                    )
                elif try_mode == "dynamic":
                    page = fetch_dynamic(
                        args.url, wait_ms=args.wait, proxy=args.proxy,
                        timeout=args.timeout * 1000,
                    )
                elif try_mode == "stealth":
                    page = fetch_stealth(
                        args.url, wait_ms=args.wait, proxy=args.proxy,
                        timeout=args.timeout * 1000,
                    )
                status = getattr(page, "status", 0) or 0
                has_body = hasattr(page, "body") and page.body and len(page.body) > 0
                if status == 200 and has_body:
                    mode = try_mode
                    break
                # Non-200 or empty body: escalate
                print(f"[auto] {try_mode}: status={status}, escalating...",
                      file=sys.stderr)
            except Exception as e:
                last_error = e
                print(f"[auto] {try_mode}: error={e}, escalating...",
                      file=sys.stderr)
        if page is None or (getattr(page, "status", 0) != 200):
            if last_error and page is None:
                raise last_error
    else:
        try:
            if mode == "http":
                page = fetch_http(
                    args.url,
                    method=args.method,
                    headers=custom_headers or None,
                    data=args.data,
                    impersonate=args.impersonate,
                    proxy=args.proxy,
                    timeout=args.timeout,
                )
            elif mode == "dynamic":
                page = fetch_dynamic(
                    args.url,
                    wait_ms=args.wait,
                    proxy=args.proxy,
                    timeout=args.timeout * 1000,
                )
            elif mode == "stealth":
                page = fetch_stealth(
                    args.url,
                    wait_ms=args.wait,
                    proxy=args.proxy,
                    timeout=args.timeout * 1000,
                )
        except Exception as e:
            elapsed = int((time.time() - start) * 1000)
            if args.json_output:
                print(json.dumps({
                    "url": args.url,
                    "status": -1,
                    "error": str(e),
                    "mode": mode,
                    "elapsed_ms": elapsed,
                }, ensure_ascii=False))
            else:
                print(f"Error: {e}", file=sys.stderr)
            sys.exit(1)

    elapsed = int((time.time() - start) * 1000)

    # Get content type
    ct = None
    if hasattr(page, "headers") and page.headers:
        ct = page.headers.get("content-type", "")

    # Extract CSS selectors if specified
    content = ""
    if args.css_selectors:
        matches = extract_css(page, args.css_selectors)
        content = "\n".join(str(m) for m in matches)
    else:
        # Scrapling: page.body is bytes, page.text may be None for non-HTML
        if hasattr(page, "body") and page.body:
            encoding = getattr(page, "encoding", None) or "utf-8"
            content = page.body.decode(encoding, errors="replace")
        elif hasattr(page, "html_content") and page.html_content:
            content = page.html_content
        elif hasattr(page, "text") and page.text:
            content = page.text
        else:
            content = ""

    # Output
    if args.json_output:
        output = {
            "url": args.url,
            "status": getattr(page, "status", None),
            "content": content,
            "content_type": ct,
            "mode": args.mode,
            "elapsed_ms": elapsed,
        }
        print(json.dumps(output, ensure_ascii=False))
    else:
        if content:
            print(content)
        else:
            status = getattr(page, "status", "unknown")
            print(f"Empty response (status: {status})", file=sys.stderr)
            sys.exit(1)


if __name__ == "__main__":
    main()
