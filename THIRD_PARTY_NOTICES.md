# Third-party notices

HappyClaw is released under the MIT License (see `LICENSE`). The parts listed
below are adapted from other projects and remain under their own licenses.

## Cindy

- Source: https://github.com/makecindy/cindy, commit `7be4c57d7b`
- License: Apache License 2.0 (full text in `LICENSES/Apache-2.0.txt`)
- Notice:

  ```
  Cindy
  Copyright 2026 XD Inc.

  This product includes software developed by XD Inc.
  ```

Adapted parts, each modified for HappyClaw (every adapted file says so in its
header):

- `shared/model-providers.ts`: the vendor preset catalog, the model
  capability table (context windows and reasoning efforts), the model list
  parsing and the upstream error classification.
- `web/src/components/chat/composer/cindy/`: the chat composer's editor core
  (list nodes, punctuation and selection plugins, reference and long-paste
  chips, Markdown serialization, palette matching, the send button) and its
  tests.

## CLIProxyAPI

- Source: https://github.com/router-for-me/CLIProxyAPI
- License: MIT

The Gemini subscription gateway (`src/gemini-gateway/`) follows
CLIProxyAPI's Antigravity integration: the Cloud Code endpoint shape, the
OAuth flow parameters of the Antigravity desktop client, the request/response
envelope, and the handling of thought signatures on function calls.
HappyClaw's implementation is a separate TypeScript port written for its
Anthropic Messages gateway, not a copy of the Go source.

```
MIT License

Copyright (c) 2025-2005.9 Luis Pater
Copyright (c) 2025.9-present Router-For.ME

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Vendor marks

`web/src/components/brand/vendorMarks.ts` holds the vendor marks shown next to
model connections and models. Brand marks remain their owners' trademarks and
are used only to identify the vendor.

### Simple Icons

- Source: https://github.com/simple-icons/simple-icons, version 16.27.0
- License: CC0-1.0
- Marks: Anthropic, DeepSeek, Moonshot AI, Alibaba Cloud, Xiaomi, OpenRouter,
  ByteDance

### Lobe Icons

- Source: https://github.com/lobehub/lobe-icons, package
  `@lobehub/icons-static-svg` 1.101.0
- License: MIT
- Marks: OpenAI, ChatGLM, Kimi, MiniMax, StepFun, LongCat, Hunyuan, opencode,
  SiliconCloud

```
MIT License

Copyright (c) 2023 LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
