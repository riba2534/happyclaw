---
name: wechat-reader
description: Read and analyze WeChat public account articles (mp.weixin.qq.com). Use this skill whenever the user shares a WeChat article link, pastes a mp.weixin.qq.com URL, asks to read/summarize/analyze a WeChat article, or when you encounter a WeChat URL that needs to be fetched. WeChat articles are behind anti-bot verification that blocks normal HTTP requests, so this skill is essential for accessing their content.
---

# WeChat Article Reader

WeChat public account articles (mp.weixin.qq.com) are protected by an anti-bot verification system that blocks direct HTTP requests (like WebFetch or curl). This skill provides a reliable method to bypass the verification and extract article content.

## Why this skill exists

When you try to fetch a WeChat article URL directly:
- `WebFetch` returns a "环境异常" verification page instead of the article
- The page requires completing a JavaScript-based verification challenge
- A real browser is needed to pass the verification

## Reading flow

Follow these steps in order. Do NOT try WebFetch first — it will always fail for WeChat articles and wastes time.

### Step 1: Open the URL and bypass verification

Open the article URL. WeChat will redirect to a verification page — this is expected.

```bash
agent-browser open "<url>"
```

Then click the "去验证" button via JavaScript eval (the normal `click` command may time out because it triggers async navigation):

```bash
agent-browser eval "document.querySelector('.weui-btn')?.click()"
```

Wait for the article page to load:

```bash
sleep 3
```

### Step 2: Verify and extract content

First, check whether the verification succeeded by looking at the page title:

```bash
agent-browser eval "document.querySelector('#activity-name')?.textContent?.trim() || document.title"
```

If it returns an article title (not "环境异常"), the verification passed. Now extract structured content:

```bash
agent-browser eval "JSON.stringify({ title: document.querySelector('#activity-name')?.textContent?.trim(), author: document.querySelector('#js_name')?.textContent?.trim(), date: document.querySelector('#publish_time')?.textContent?.trim(), content: document.querySelector('#js_content')?.innerText?.trim() })"
```

This gives you clean structured data (title, author, date, body text) without needing to parse a full page snapshot.

If the structured extraction returns null fields, fall back to a full snapshot:

```bash
agent-browser snapshot
```

### Step 3: Present the content

After extracting, present the article to the user based on what they asked for:
- If they just shared a link: provide a summary with key points
- If they asked to "analyze": provide structured analysis (main argument, supporting points, strengths/weaknesses)
- If they asked to "translate": translate the content
- If they asked to "read": present the full content in a clean format

## Troubleshooting

### Verification button not found

If `.weui-btn` doesn't match, try a broader selector:

```bash
agent-browser eval "document.querySelectorAll('a, button').forEach(el => { if(el.textContent.includes('验证')) el.click() })"
```

### Still on verification page after clicking

Wait longer and retry:

```bash
sleep 5
agent-browser eval "document.querySelector('#activity-name')?.textContent?.trim() || 'STILL_ON_VERIFICATION'"
```

If still blocked, the article may require a captcha type we haven't encountered yet (slider, image recognition, etc.). Inform the user and note the specific verification type so this skill can be updated.

### Article not accessible

If the page shows error messages like "该内容已被发布者删除" or "此内容因违规无法查看", the article has been removed. Report this to the user.

## Known verification types

This is a living document — add new verification methods as they are encountered:

| Type | Selector | Method | Status |
|------|----------|--------|--------|
| Button ("去验证") | `.weui-btn` | `eval` click | Working (2026-03) |

## Important notes

- Always close the browser when done if no further browsing is needed: `agent-browser close`
- WeChat articles may contain images that won't appear in the text extraction — mention this if relevant
- Some articles may be subscriber-only or deleted — check and report to the user
