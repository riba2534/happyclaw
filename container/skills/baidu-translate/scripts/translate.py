#!/usr/bin/env python3
"""
Baidu Translate API client.

Usage:
    python translate.py <text> [--from LANG] [--to LANG]
    python translate.py "Hello world"                  # auto-detect -> zh
    python translate.py "你好世界"                      # auto-detect -> en
    python translate.py "Hello" --from en --to jp      # English -> Japanese

Language codes:
    zh (Chinese), en (English), jp (Japanese), kor (Korean),
    fra (French), de (German), ru (Russian), spa (Spanish),
    pt (Portuguese), it (Italian), th (Thai), ara (Arabic),
    auto (auto-detect, source only)
"""

import hashlib
import json
import random
import sys
import urllib.parse
import urllib.request
from pathlib import Path


def load_config():
    config_path = Path(__file__).parent / "config.json"
    with open(config_path, "r") as f:
        return json.load(f)


def contains_chinese(text):
    """Check if text contains Chinese characters."""
    for ch in text:
        if "\u4e00" <= ch <= "\u9fff" or "\u3400" <= ch <= "\u4dbf":
            return True
    return False


def translate(text, from_lang="auto", to_lang=None):
    config = load_config()
    appid = config["appid"]
    secret_key = config["secret_key"]
    api_url = config["api_url"]

    # Auto-determine target language if not specified
    if to_lang is None:
        if contains_chinese(text):
            to_lang = "en"
        else:
            to_lang = "zh"

    salt = str(random.randint(10000, 99999))
    sign_str = appid + text + salt + secret_key
    sign = hashlib.md5(sign_str.encode("utf-8")).hexdigest()

    params = {
        "q": text,
        "from": from_lang,
        "to": to_lang,
        "appid": appid,
        "salt": salt,
        "sign": sign,
    }

    url = api_url + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url)
    req.add_header("Content-Type", "application/x-www-form-urlencoded")

    with urllib.request.urlopen(req, timeout=10) as resp:
        result = json.loads(resp.read().decode("utf-8"))

    if "error_code" in result:
        error_codes = {
            "52001": "Request timeout",
            "52002": "System error",
            "52003": "Unauthorized user (check appid)",
            "54000": "Missing required parameter",
            "54001": "Invalid sign",
            "54003": "Rate limit exceeded (try again later)",
            "54004": "Insufficient balance",
            "54005": "Frequent identical long queries",
            "58000": "Client IP not allowed",
            "58001": "Unsupported language pair",
            "58002": "Service closed",
            "90107": "Authentication failed",
        }
        code = str(result["error_code"])
        msg = error_codes.get(code, result.get("error_msg", "Unknown error"))
        print(json.dumps({"error": True, "code": code, "message": msg}))
        sys.exit(1)

    translations = []
    for item in result.get("trans_result", []):
        translations.append({"src": item["src"], "dst": item["dst"]})

    output = {
        "from": result.get("from", from_lang),
        "to": result.get("to", to_lang),
        "translations": translations,
    }
    print(json.dumps(output, ensure_ascii=False))


def main():
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        sys.exit(0)

    from_lang = "auto"
    to_lang = None
    text_parts = []

    i = 0
    while i < len(args):
        if args[i] == "--from" and i + 1 < len(args):
            from_lang = args[i + 1]
            i += 2
        elif args[i] == "--to" and i + 1 < len(args):
            to_lang = args[i + 1]
            i += 2
        else:
            text_parts.append(args[i])
            i += 1

    text = " ".join(text_parts)
    if not text:
        print("Error: no text provided")
        sys.exit(1)

    translate(text, from_lang, to_lang)


if __name__ == "__main__":
    main()
