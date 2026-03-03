---
name: translate
description: >
  Translate text between languages using the Baidu Translate API. Use this skill whenever the user
  asks to translate text, wants something translated, says /translate, or needs help understanding
  text in a foreign language. This includes translating single words, phrases, sentences, paragraphs,
  or entire documents between Chinese, English, Japanese, Korean, French, German, Russian, Spanish,
  and many other languages. Also use this when the user pastes foreign-language text and asks
  "what does this mean" or wants a translation of code comments, error messages, documentation, etc.
---

# Translate

Translate text between languages via the Baidu Translate API. The translation script is bundled at `scripts/translate.py` and reads credentials from `scripts/config.json`.

## How to use

Run the translation script with the text to translate:

```bash
python3 <skill-dir>/scripts/translate.py "<text>" [--from LANG] [--to LANG]
```

The script outputs JSON:

```json
{
  "from": "en",
  "to": "zh",
  "translations": [
    {"src": "Hello world", "dst": "你好世界"}
  ]
}
```

## Auto language detection

When `--to` is not specified, the script automatically picks the target language:
- If the input contains Chinese characters → translate to English
- Otherwise → translate to Chinese

This covers the most common use case (Chinese-English translation) without requiring the user to specify languages.

## Specifying languages

When the user specifies a language direction (e.g., "translate to Japanese", "en->jp"), pass the appropriate `--from` and `--to` flags. Common patterns:

| User says | --from | --to |
|-----------|--------|------|
| "翻译成英文" / "translate to English" | auto | en |
| "translate to Japanese" | auto | jp |
| "en->jp" or "英译日" | en | jp |
| "translate from French to Chinese" | fra | zh |

## Supported language codes

| Language | Code |
|----------|------|
| Chinese | zh |
| English | en |
| Japanese | jp |
| Korean | kor |
| French | fra |
| German | de |
| Russian | ru |
| Spanish | spa |
| Portuguese | pt |
| Italian | it |
| Thai | th |
| Arabic | ara |
| Auto-detect | auto |

## Parsing user input

The user might invoke this skill in several ways:

1. **`/translate <text>`** — translate the text directly
2. **`/translate en->jp <text>`** — with explicit language direction
3. **"帮我翻译：<text>"** — natural language request
4. **Pasting foreign text and asking what it means**

Parse the user's intent and extract:
- The text to translate
- Source language (default: auto)
- Target language (default: auto-detect based on content)

## Presenting results

Format the output cleanly for the user. For single translations:

```
**原文** (English): Hello world
**译文** (中文): 你好世界
```

For multi-line text, present each line's translation clearly. If the text is long, consider using a table or code block for readability.

## Error handling

If the API returns an error, the script outputs an error JSON. Common issues:
- **54003**: Rate limit — wait 1 second and retry once
- **54001**: Invalid sign — likely a config issue, check credentials
- **58001**: Unsupported language pair — inform the user

## Multi-line text

For longer text with multiple lines, pass the entire text as a single quoted argument. The API handles newlines and returns per-line translations.
