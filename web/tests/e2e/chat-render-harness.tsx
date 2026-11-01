// Visual harness for the chat canvas: renders ChatView with representative
// history, streaming and queue states from mocked stores (no backend).
//   ?scenario=history | streaming | waiting | silent | settled | live | empty
//            | facts (a settled card whose calls report what they did and
//              printed) | facts-live (the same, with its sub-agent still running)
//            | proactive (&visibility=hidden|activity|full; &progress=1 for a
//              turn that also sent the user a progress statement)
//            | thinking-markdown
//            | lazy-trace (a reply whose reasoning and trace the server kept;
//              &mode=proactive&visibility=hidden|activity|full for a proactive one)
//            | markdown | markdown-streaming (&cut=fence|list|table)
//   &display=compact   &theme=dark   &scheme=default|neutral
//   &layout=classic|timeline (the streaming layout; timeline by default)
//   &steps=1 (history: the reply m4 also has the ordered steps it streamed)
// window.renderHarness drives the `live` scenario through the real reducer.
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ChatView } from '../../src/components/chat/ChatView';
import { TooltipProvider } from '../../src/components/ui/tooltip';
import { ConfirmHost } from '../../src/components/common/ConfirmHost';
import { Toaster } from 'sonner';
import { MotionProvider } from '../../src/lib/motion';
import { useAuthStore, type UserPublic } from '../../src/stores/auth';
import {
  useChatStore,
  type Message,
  type QueuedFollowUp,
  type StreamingState,
} from '../../src/stores/chat';
import { useFileStore } from '../../src/stores/files';
import type { StreamingStep } from '../../src/lib/stream-steps';
import type { StreamEvent } from '../../src/stream-event.types';
import '@fontsource-variable/inter';
import '@fontsource-variable/geist-mono';
import '../../src/styles/globals.css';

const params = new URLSearchParams(window.location.search);
const scenario = params.get('scenario') ?? 'streaming';
const theme = params.get('theme');
const scheme = params.get('scheme');
const root = document.documentElement;
root.classList.toggle('dark', theme === 'dark');
root.classList.toggle('theme-neutral', scheme === 'neutral');
root.classList.toggle('theme-orange', !scheme || scheme === 'orange');

const groupJid = 'web:render-harness';
/** The session the harness shows. */
const sessionId = 'render-session';
const sessionJid = `${groupJid}#agent:${sessionId}`;
const userId = 'harness-user';
if (params.get('display') === 'compact') {
  localStorage.setItem(`happyclaw-display-mode:${userId}`, 'compact');
} else {
  localStorage.removeItem(`happyclaw-display-mode:${userId}`);
}
if (params.get('layout') === 'classic') {
  localStorage.setItem(`happyclaw-stream-layout:${userId}`, 'classic');
} else {
  localStorage.removeItem(`happyclaw-stream-layout:${userId}`);
}
const visibilityParam = params.get('visibility');
const processVisibility =
  visibilityParam === 'activity' || visibilityParam === 'full'
    ? visibilityParam
    : 'hidden';

const user: UserPublic = {
  id: userId,
  username: 'riba2534',
  display_name: 'riba2534',
  role: 'admin',
  status: 'active',
  permissions: [],
  must_change_password: false,
  disable_reason: null,
  notes: null,
  created_at: '2026-01-01T00:00:00.000Z',
  last_login_at: null,
  last_active_at: null,
  deleted_at: null,
  avatar_emoji: null,
  avatar_color: null,
  avatar_url: null,
  ai_name: null,
  ai_avatar_emoji: null,
  ai_avatar_color: null,
  ai_avatar_url: null,
  default_require_mention: false,
};

const now = Date.now();
const at = (minutesAgo: number) =>
  new Date(now - minutesAgo * 60_000).toISOString();

const swatch = btoa(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#e9e5dc"/><circle cx="110" cy="100" r="54" fill="#d97757"/><rect x="180" y="58" width="100" height="84" rx="12" fill="#6b7f8f"/></svg>',
);

const richMarkdown = [
  '已定位到问题：侧栏订阅了整个 `useChatStore`，流式 delta 每帧都会触发重渲染。',
  '',
  '## 修复方案',
  '',
  '1. 改为**窄 selector**，只订阅需要的字段',
  '2. 运行中会话 id 拼成字符串比较，避免引用变化',
  '3. 为会话行加 `memo`',
  '',
  '```ts',
  'const groups = useChatStore((s) => s.groups);',
  'const activeIds = useChatStore((s) =>',
  '  agents.filter((a) => s.agentWaiting[a.id]).map((a) => a.id).join(","),',
  ');',
  '```',
  '',
  '| 方案 | 重渲染次数 | 复杂度 |',
  '| --- | --- | --- |',
  '| 整 store 订阅 | 每帧 | 低 |',
  '| 窄 selector | 仅相关变化 | 低 |',
  '| 拆分 store | 最少 | 高 |',
  '',
  '> 窄 selector 改动最小，收益最明显。',
  '',
  '验证命令：',
  '',
  '```bash',
  'npx vitest run tests/frontend-session-sidebar-copy.test.ts',
  'make typecheck && make build',
  '```',
  '',
  '复杂度从 $O(n \\cdot k)$ 降到 $O(k)$，其中 $k$ 为变化的会话数。参考 [React 文档](https://react.dev)。',
  '',
  '- [x] 侧栏改为窄订阅',
  '- [ ] 会话列表虚拟滚动',
].join('\n');

const workflowRun = {
  taskId: 'wf-1',
  workflowName: 'code-review',
  summary: '并行审查 3 个模块并汇总结论',
  status: 'completed' as const,
  durationMs: 94_000,
  agentCount: 3,
  totalTokens: 48_200,
  totalToolCalls: 37,
  phases: [
    { index: 0, title: '分析变更' },
    { index: 1, title: '并行审查' },
    { index: 2, title: '汇总' },
  ],
  agents: [
    {
      index: 0,
      label: '架构审查',
      phaseIndex: 1,
      state: 'done' as const,
      resultPreview: '未发现结构问题',
    },
    {
      index: 1,
      label: '安全审查',
      phaseIndex: 1,
      state: 'done' as const,
      resultPreview: '1 处输入未转义',
    },
    {
      index: 2,
      label: '性能审查',
      phaseIndex: 1,
      state: 'done' as const,
      resultPreview: '列表渲染可虚拟化',
    },
  ],
};

const msg = (
  id: string,
  minutesAgo: number,
  fromAgent: boolean,
  content: string,
  extra: Partial<Message> = {},
): Message => ({
  id,
  chat_jid: sessionJid,
  sender: fromAgent ? 'happyclaw-agent' : userId,
  sender_name: fromAgent ? 'HappyClaw' : 'riba2534',
  content,
  timestamp: at(minutesAgo),
  is_from_me: fromAgent,
  ...(fromAgent
    ? { source_kind: 'sdk_final', finalization_reason: 'completed' }
    : {}),
  ...extra,
});

const usage = (input: number, output: number, durationMs: number) =>
  JSON.stringify({ inputTokens: input, outputTokens: output, durationMs });

// ── Markdown kitchen sink (scenario=markdown | markdown-streaming) ──
const FENCE = '```';
const longCodeLines = Array.from(
  { length: 150 },
  (_, i) =>
    `  const row${String(i + 1).padStart(3, '0')} = compute(${i}, 'value-${i}'); // line ${i + 1}`,
);
const wideHeader = Array.from({ length: 12 }, (_, i) => `列 ${i + 1} Column`);

const markdownKitchenSink = `# 一级标题：Markdown 渲染全量样例

这是一段中英文混排的长段落，用来检查正文字号、行高与 CJK 标点间距。HappyClaw 是基于 Claude Agent SDK 的自托管 Agent 工作台，支持 Web 与飞书、Telegram、QQ 等渠道；它在 Host 模式下直接使用 \`customCwd\` 作为工作目录，而 Container 模式则通过只读/读写挂载访问资源。The quick brown fox jumps over the lazy dog, and then keeps running across a very long English sentence to test wrapping behaviour inside the message column.

## 二级标题 Heading 2

### 三级标题 Heading 3

#### 四级标题 Heading 4

普通段落，紧跟在四级标题之后。

**粗体**、*斜体*、~~删除线~~、***粗斜体***，以及 **注意：**中文标点后紧跟正文的粗体，和 **“引号包裹”**的粗体。

行内代码 \`useChatStore\`，以及很长的行内代码 \`useChatStore.getState().streaming[groupJid].partialText.slice(-MAX_STREAMING_TEXT).replace(/\\n$/, '')\` 需要在窄屏换行。返回值类型是 Promise<void>，泛型写作 Array<string>。

链接：裸链接 https://react.dev/learn 自动识别；中文标点紧跟裸链接 https://claw.riba2534.cn/chat，后面是中文。带 title 的链接 [React 官方文档](https://react.dev "React 官方文档")，工作区相对路径文件链接 [report.md](output/report.md)。超长 URL：https://example.com/api/v1/workspaces/render-harness/sessions/0f9c2b7e-1d3a-4c5b-9e8f-7a6b5c4d3e2f/messages?cursor=eyJpZCI6IjEyMzQ1Njc4OTAiLCJ0cyI6MTcwMDAwMDAwMH0&limit=50&include=attachments,usage

中文标点：「引号」、（括号）、——破折号、……省略号；English, punctuation; 混排 iPhone 13 与 390px 宽度。

无空格长单词：Pneumonoultramicroscopicsilicovolcanoconiosis_Pneumonoultramicroscopicsilicovolcanoconiosis_Pneumonoultramicroscopicsilicovolcanoconiosis

长哈希：e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855e3b0c44298fc1c149afbf4c8996fb924

Emoji：🚀 ✅ ⚠️ 🎉 👨‍👩‍👧‍👦 🇨🇳

## 列表

- 一级无序列表
  - 二级无序列表
    - 三级无序列表
- 第二个一级项

1. 第一步
2. 第二步
   1. 子步骤 a
   2. 子步骤 b
      - 三级无序
3. 第三步

1. 松散列表项的第一段。

   同一列表项的第二段，应当另起一行。

2. 包含代码块的列表项：

   ${FENCE}bash
   npm ci && npm run build
   ${FENCE}

3. 第三项

模型常见输出——编号被代码块打断：

1. 安装依赖

${FENCE}bash
npm ci
${FENCE}

2. 启动开发服务

${FENCE}bash
make dev
${FENCE}

3. 打开浏览器访问

- [x] 已完成的任务
- [ ] 未完成的任务
  - [ ] 嵌套子任务
- [ ] 一个非常长的任务项，用来检查任务列表在窄屏下的换行与复选框对齐是否正确，文字应该与第一行左侧对齐。

## 引用

> 一级引用，包含 **粗体** 与 \`code\`。
>
> > 嵌套引用的内容。
>
> - 引用中的列表项 1
> - 引用中的列表项 2

---

## 代码

${FENCE}ts
interface StreamingState {
  partialText: string;
  isThinking: boolean;
}

export function streamingTail(text: string, max: number): string {
  return text.length > max ? '...' + text.slice(-max) : text;
}
${FENCE}

${FENCE}python
def fib(n: int) -> int:
    """Return the n-th Fibonacci number."""
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
${FENCE}

${FENCE}bash
#!/usr/bin/env bash
set -euo pipefail
lsof -ti:5231 -sTCP:LISTEN | xargs kill
echo "done: $(date +%s)"
${FENCE}

${FENCE}json
{
  "name": "happyclaw",
  "private": true,
  "scripts": { "dev": "vite", "build": "tsc -b && vite build" }
}
${FENCE}

${FENCE}diff
- const store = useChatStore();
+ const groups = useChatStore((s) => s.groups);
  const theme = useTheme();
${FENCE}

${FENCE}
无语言的多行代码块
second line without language
${FENCE}

${FENCE}
npm install --save-dev single-line-without-language
${FENCE}

${FENCE}ts
const veryLongSingleLine = { alpha: 'aaaaaaaaaaaaaaaa', beta: 'bbbbbbbbbbbbbbbb', gamma: 'cccccccccccccccc', delta: 'dddddddddddddddd', epsilon: 'eeeeeeeeeeeeeeee', zeta: 'ffffffffffffffff' };
${FENCE}

${FENCE}ts
export function generated() {
${longCodeLines.join('\n')}
}
${FENCE}

## 表格

| 方案 | 次数 | 复杂度 |
| --- | ---: | :---: |
| 整 store 订阅 | 120 | 低 |
| 窄 selector | 3 | 低 |

| ${wideHeader.join(' | ')} |
| ${wideHeader.map(() => '---').join(' | ')} |
| ${wideHeader.map((_, i) => `值 ${i + 1}`).join(' | ')} |
| ${wideHeader.map((_, i) => `value-${i + 1}-long`).join(' | ')} |

| 字段 | 说明 |
| --- | --- |
| partialText | 流式输出的部分文本。当内容超过阈值时只渲染尾部，这一列故意写得很长，用来检查表格单元格在长文本下是否会换行，而不是把整张表撑成一行超宽的横向滚动条，影响阅读。 |
| isThinking | 是否处于思考阶段 |

## 图片

![数据 URL 图片](data:image/svg+xml;base64,${swatch})

![本地静态资源](/icons/icon-192.png "HappyClaw 图标")

![工作区相对路径图片](output/chart.png)

## 公式

行内公式 $E = mc^2$（单美元符号），双美元行内 $$\\sqrt{x^2 + 1}$$。

$$
\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}
$$

$$
f(x) = a_0 + a_1 x + a_2 x^2 + a_3 x^3 + a_4 x^4 + a_5 x^5 + a_6 x^6 + a_7 x^7 + a_8 x^8 + a_9 x^9 + a_{10} x^{10} + a_{11} x^{11}
$$

## Mermaid

${FENCE}mermaid
flowchart LR
  A[用户消息] --> B{需要工具?}
  B -->|是| C[调用工具]
  B -->|否| D[直接回复]
  C --> D
${FENCE}

${FENCE}mermaid
flowchart LR
  A --> (((
${FENCE}

## 脚注

这里有一个脚注引用[^1]，以及第二个脚注[^note]。

[^1]: 第一个脚注的内容。
[^note]: 第二个脚注，带 [链接](https://example.com)。

## 原始 HTML

<details>
<summary>点击展开详情</summary>

折叠内容里的 **Markdown**。

</details>

按 <kbd>Ctrl</kbd> + <kbd>C</kbd> 复制。第一行<br>第二行（br 换行）。

<script>window.__xssScript = 1</script>
<img src="x" onerror="window.__xssImg = 1">
<a href="javascript:window.__xssLink=1">恶意 HTML 链接</a> 与 [恶意 Markdown 链接](javascript:window.__xssMd=1)

<div style="position:fixed;inset:0;z-index:9999;background:rgba(220,38,38,.35)" data-sanitize-probe="overlay"><a href="https://example.com/phish">全屏覆盖层（style 注入探针）</a></div>

结尾段落。`;

const codeOnlyMessage = `${FENCE}ts
export const answer = 42;
console.log(\`answer = \${answer}\`);
${FENCE}`;

const mathOnlyMessage = `只含公式的消息（走 Math 渲染管线）：$$\\sqrt{x^2 + 1}$$，以及

$$
\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}
$$`;

const markdownCuts: Record<string, string> = {
  list: '      - 三级无序\n3. 第三步',
  fence: 'export function streamingTail',
  table: '| value-1-long | value-2-long | value-3-long',
};
const cutMarker =
  markdownCuts[params.get('cut') ?? 'fence'] ?? markdownCuts.fence;
const markdownPartial = markdownKitchenSink.slice(
  0,
  markdownKitchenSink.indexOf(cutMarker) + cutMarker.length,
);

const markdownHistory: Message[] = [
  msg('md-u1', 30, false, '把所有 Markdown 元素都渲染一遍给我看看。'),
  msg('md-a1', 29, true, markdownKitchenSink, {
    token_usage: usage(9_800, 3_400, 21_000),
  }),
  msg('md-u2', 20, false, '只给我代码。'),
  msg('md-a2', 19, true, codeOnlyMessage),
  msg('md-u3', 10, false, '再单独给一个公式。'),
  msg('md-a3', 9, true, mathOnlyMessage),
];

const chatHistory: Message[] =
  scenario === 'empty'
    ? []
    : [
        msg('m1', 60 * 26, false, '昨天那个侧栏重渲染的问题有结论了吗？'),
        msg('m2', 60 * 26 - 1, true, '有的，结论见下一条。', {
          token_usage: usage(1200, 80, 2100),
        }),
        msg(
          'm3',
          42,
          false,
          '帮我看看侧栏组件为什么在流式输出时会频繁重渲染？顺便看下这张截图里的布局问题。',
          {
            attachments: JSON.stringify([
              {
                type: 'image',
                data: swatch,
                mimeType: 'image/svg+xml',
                name: 'layout.svg',
              },
              {
                type: 'image',
                data: swatch,
                mimeType: 'image/svg+xml',
                name: 'layout-2.svg',
              },
            ]),
          },
        ),
        msg('m4', 41, true, richMarkdown, {
          token_usage: usage(18_200, 4_120, 48_400),
          workflow_runs: [workflowRun],
        }),
        msg('sys1', 30, false, 'context_reset', { sender: '__system__' }),
        msg('m5', 29, false, '/spawn 并行检查所有页面的暗色模式对比度'),
        msg(
          'm6',
          20,
          true,
          'context_overflow: 上下文超过模型上限（212k / 200k tokens），请使用 /fresh 开启新窗口。',
          {
            sender: '__system__',
          },
        ),
        msg(
          'err1',
          19,
          false,
          'agent_error:Container exited with code 137 (OOM)',
          {
            sender: '__system__',
          },
        ),
        msg(
          'm7',
          12,
          false,
          '那继续把会话列表也改成虚拟滚动吧，注意保持现在的排序规则，另外移动端也要同步验证一下滚动性能，长列表大概会有 1000 个会话。',
        ),
        msg(
          'm8',
          11,
          true,
          '已经完成：会话列表现在使用 `@tanstack/react-virtual`，预估行高 48px。\n\n- 1000 个会话时首屏渲染从 **320ms** 降到 **18ms**\n- 滚动帧率稳定在 60fps',
          {
            token_usage: usage(2_310, 188, 5_200),
          },
        ),
        msg('m9', 6, false, '把 1 到 300 逐行列出来。'),
        // A reply the user stopped part-way.
        msg('m10', 5, true, '1\n2\n3\n4\n5', {
          source_kind: 'interrupt_partial',
          finalization_reason: 'interrupted',
        }),
      ];

// Replies of an earlier session: the server kept their reasoning and trace,
// this tab holds neither until a row is opened.
const lazyTraceHistory: Message[] = [
  msg('lz-u1', 6, false, '帮我看看侧栏为什么在流式输出时频繁重渲染？'),
  msg(
    'lz-a1',
    5,
    true,
    '原因是侧栏订阅了整个 `useChatStore`，每个 delta 都会触发重渲染。\n\n改成窄 selector 即可。',
    {
      turn_id: 'turn-kept',
      has_trace: true,
      token_usage: usage(4_200, 310, 9_800),
    },
  ),
];

const history: Message[] =
  scenario === 'markdown'
    ? markdownHistory
    : scenario === 'markdown-streaming'
      ? markdownHistory.slice(0, 1)
      : scenario === 'lazy-trace'
        ? lazyTraceHistory
        : chatHistory;

// Reasoning the way the models write it: a bold title, then short paragraphs.
const thinkingA =
  '**确认订阅范围**\n\n用户希望保持排序。现有排序基于 `last_active_at`，虚拟列表只负责渲染，不影响排序。';
const thinkingB =
  '**比较方案**\n\n有两种做法：\n\n- 窄 selector，只订阅需要的字段\n- 拆分 store，改动更大\n\n先选改动最小的一种。';
const thinkingC =
  '**核对行高估算**\n\n需要注意行高估算与实际高度不一致时的滚动跳动……';
const commentary = '我先把渲染循环换成虚拟列表，再跑测试。';
const answerText =
  '正在把会话列表改成虚拟滚动。目前已经替换了 `SessionSidebar` 的渲染循环，接下来验证';

const ago = (seconds: number) => now - seconds * 1000;

/** The steps of a run that is part-way: finished ones, then what is running. */
const liveSteps: StreamingStep[] = [
  {
    id: 'thinking-0',
    kind: 'thinking',
    at: ago(46),
    endedAt: ago(40),
    status: 'done',
    durationMs: 5_800,
    title: '确认订阅范围',
    text: thinkingA,
  },
  {
    id: 'tool-t0',
    kind: 'tool',
    at: ago(39),
    endedAt: ago(38),
    status: 'done',
    toolUseId: 't0',
    toolName: 'Grep',
    summary: 'useVirtualizer in web/src',
  },
  {
    id: 'tool-t4',
    kind: 'tool',
    at: ago(37),
    endedAt: ago(36),
    status: 'done',
    toolUseId: 't4',
    toolName: 'Read',
    summary:
      '/workspace/group/happyclaw/web/src/components/chat/SessionSidebar.tsx',
  },
  {
    id: 'tool-t5',
    kind: 'tool',
    at: ago(35),
    endedAt: ago(34),
    status: 'error',
    toolUseId: 't5',
    toolName: 'Bash',
    summary: 'rm -rf node_modules',
    resultPreview: '被权限策略拒绝',
  },
  {
    id: 'thinking-1',
    kind: 'thinking',
    at: ago(33),
    endedAt: ago(26),
    status: 'done',
    durationMs: 7_000,
    title: '比较方案',
    text: thinkingB,
  },
  {
    id: 'text-0',
    kind: 'text',
    at: ago(25),
    endedAt: ago(24),
    status: 'done',
    from: 0,
    text: commentary,
  },
  {
    id: 'tool-t1',
    kind: 'tool',
    at: ago(12),
    status: 'running',
    toolUseId: 't1',
    toolName: 'Bash',
    summary:
      "bash -lc 'npx vitest run tests/frontend-session-sidebar-copy.test.ts'",
  },
  {
    id: 'task-task1',
    kind: 'task',
    at: ago(9),
    status: 'running',
    taskId: 'task1',
    toolUseId: 'task1',
    toolName: 'Task',
    title: '检查移动端滚动性能',
    summary: '已用 Playwright 录制 3 组滚动帧率',
  },
  {
    id: 'tool-t2',
    kind: 'tool',
    at: ago(3),
    status: 'running',
    toolUseId: 't2',
    toolName: 'Read',
    summary:
      '/workspace/group/happyclaw/web/src/components/chat/SessionSidebar.tsx',
  },
  {
    id: 'thinking-2',
    kind: 'thinking',
    at: ago(2),
    status: 'running',
    title: '核对行高估算',
    text: thinkingC,
  },
  {
    id: 'text-1',
    kind: 'text',
    at: ago(1),
    status: 'running',
    from: commentary.length,
  },
];

const taskStates: StreamingState['taskStates'] = {
  task1: {
    id: 'task1',
    title: '检查移动端滚动性能',
    status: 'running',
    subagentType: 'general-purpose',
    thinkingTail: '',
    textTail: '正在用 Playwright 录制 390×844 下的滚动帧率…',
    activeTools: [],
    recentTools: [],
    lastToolName: 'Bash',
    latestSummary: '已用 Playwright 录制 3 组滚动帧率',
    updatedAt: ago(2),
  },
};

const streaming: StreamingState = {
  partialText: commentary + answerText,
  partialBase: 0,
  thinkingText: [thinkingA, thinkingB, thinkingC].join('\n\n'),
  thinkingTitle: '核对行高估算',
  isThinking: scenario === 'streaming',
  thinkingDurationMs: 12_800,
  steps: liveSteps,
  activeTools: [
    {
      toolName: 'Bash',
      toolUseId: 't1',
      startTime: ago(12),
      toolInputSummary:
        "bash -lc 'npx vitest run tests/frontend-session-sidebar-copy.test.ts'",
    },
    {
      toolName: 'Read',
      toolUseId: 't2',
      startTime: ago(3),
      toolInputSummary:
        '/workspace/group/happyclaw/web/src/components/chat/SessionSidebar.tsx',
    },
  ],
  activeHook: null,
  systemStatus: null,
  recentEvents: [],
  traceEvents: [
    {
      id: 'tr1',
      timestamp: ago(39),
      kind: 'tool',
      title: '工具 Grep',
      summary: 'useVirtualizer in web/src',
      toolUseId: 't0',
    },
    {
      id: 'tr2',
      timestamp: ago(37),
      kind: 'tool',
      title: '工具 Read',
      summary: 'SessionSidebar.tsx',
      toolUseId: 't4',
    },
    {
      id: 'tr3',
      timestamp: ago(35),
      kind: 'permission',
      title: 'Bash',
      summary: 'rm -rf node_modules',
      detail: '被权限策略拒绝',
    },
  ],
  taskStates,
  todos: [
    { id: '1', content: '替换渲染循环为虚拟列表', status: 'completed' },
    { id: '2', content: '保持 last_active_at 排序', status: 'completed' },
    { id: '3', content: '移动端滚动性能验证', status: 'in_progress' },
    { id: '4', content: '补充回归测试', status: 'pending' },
  ],
};

/** The model's request is out and nothing has come back: no text, no thinking. */
const silentStreaming: StreamingState = {
  partialText: '',
  thinkingText: '',
  isThinking: false,
  awaitingModel: true,
  phaseStartedAt: ago(9),
  activeTools: [],
  activeHook: null,
  systemStatus: 'requesting',
  recentEvents: [],
  traceEvents: [],
  taskStates: {},
};

/** A finished run's card, waiting for its final message. */
const settledStreaming: StreamingState = {
  ...streaming,
  isThinking: false,
  activeTools: [],
  thinkingDurationMs: 21_300,
  steps: liveSteps.map((step) => ({
    ...step,
    status: step.status === 'running' ? 'done' : step.status,
    endedAt: step.endedAt ?? now,
  })),
  taskStates: {
    task1: { ...taskStates.task1, status: 'completed' },
  },
  todos: undefined,
  settling: true,
  runId: 'run-harness',
};

/**
 * Calls that report what they did (`resultFacts`) and what they printed
 * (`resultPreview`), the way a Runner that reads the SDK's structured results
 * sends them: edits with their lines, a failed command with its exit code and
 * a long output, a run of reads merged into one row, a fetch, a sub-agent.
 */
const failedBuild = Array.from(
  { length: 14 },
  (_, i) => `src/part${i}.ts(${10 + i},5): error TS2322: type mismatch`,
).join('\n');
const factsSteps: StreamingStep[] = [
  {
    id: 'thinking-0',
    kind: 'thinking',
    at: ago(60),
    endedAt: ago(56),
    status: 'done',
    durationMs: 4_000,
    title: '确认改动范围',
    text: thinkingA,
  },
  {
    id: 'tool-e1',
    kind: 'tool',
    at: ago(55),
    endedAt: ago(54),
    status: 'done',
    toolUseId: 'e1',
    toolName: 'Edit',
    summary:
      '{"file_path":"/workspace/group/happyclaw/web/src/components/chat/ProcessRows.tsx"}',
    resultFacts: { added: 12, removed: 3 },
  },
  {
    id: 'tool-w1',
    kind: 'tool',
    at: ago(53),
    endedAt: ago(52),
    status: 'done',
    toolUseId: 'w1',
    toolName: 'Write',
    summary:
      '{"file_path":"/workspace/group/happyclaw/web/src/lib/process-facts.ts"}',
    resultFacts: { created: true, added: 24 },
  },
  {
    id: 'tool-b1',
    kind: 'tool',
    at: ago(51),
    endedAt: ago(45),
    status: 'done',
    toolUseId: 'b1',
    toolName: 'Bash',
    summary: 'command: npx vitest run web/tests/process-tool-rows.test.tsx',
    resultPreview:
      ' RUN  v4.1.11\n\n ✓ web/tests/process-tool-rows.test.tsx (26 tests) 242ms\n\n Test Files  1 passed (1)\n      Tests  26 passed (26)',
  },
  {
    id: 'tool-r1',
    kind: 'tool',
    at: ago(44),
    endedAt: ago(43),
    status: 'done',
    toolUseId: 'r1',
    toolName: 'Read',
    summary: '/workspace/group/happyclaw/web/src/lib/process-steps.ts',
    resultFacts: { lines: 120, totalLines: 430 },
    resultPreview:
      "import { describeToolCall } from '../components/chat/ToolActivityCard';",
  },
  {
    id: 'tool-g1',
    kind: 'tool',
    at: ago(42),
    endedAt: ago(41),
    status: 'done',
    toolUseId: 'g1',
    toolName: 'Grep',
    summary: 'pattern: useChatStore',
    resultFacts: { matches: 24, files: 8 },
  },
  {
    id: 'tool-gl1',
    kind: 'tool',
    at: ago(40),
    endedAt: ago(39),
    status: 'done',
    toolUseId: 'gl1',
    toolName: 'Glob',
    summary: 'web/src/**/*.test.tsx',
    resultFacts: { files: 31 },
  },
  {
    id: 'tool-b2',
    kind: 'tool',
    at: ago(38),
    endedAt: ago(30),
    status: 'error',
    toolUseId: 'b2',
    toolName: 'Bash',
    summary: 'command: npm run build:web',
    resultPreview: failedBuild,
    resultFacts: { exitCode: 1 },
  },
  {
    id: 'tool-f1',
    kind: 'tool',
    at: ago(29),
    endedAt: ago(27),
    status: 'done',
    toolUseId: 'f1',
    toolName: 'WebFetch',
    summary: 'https://docs.anthropic.com/en/docs/claude-code/sdk',
    resultFacts: { httpCode: 200, bytes: 14 * 1024 },
  },
  {
    id: 'task-agent1',
    kind: 'task',
    at: ago(26),
    endedAt: ago(5),
    status: 'done',
    taskId: 'agent1',
    toolUseId: 'agent1',
    toolName: 'Task',
    title: '检查移动端滚动性能',
    resultFacts: {
      agent: {
        reads: 3,
        searches: 2,
        edits: 1,
        commands: 4,
        added: 12,
        removed: 3,
        tokens: 12_345,
        durationMs: 21_000,
      },
    },
  },
];

const factsSettled: StreamingState = {
  ...settledStreaming,
  thinkingDurationMs: 4_000,
  steps: factsSteps,
  taskStates: {},
};

/** The same run with its sub-agent still going, and what it has cost so far. */
const factsLive: StreamingState = {
  ...streaming,
  isThinking: false,
  thinkingDurationMs: 4_000,
  steps: factsSteps.map((step) =>
    step.id === 'task-agent1'
      ? {
          ...step,
          status: 'running',
          endedAt: undefined,
          resultFacts: undefined,
          summary: '已用 Playwright 录制 3 组滚动帧率',
        }
      : step,
  ),
  activeTools: [],
  taskStates: {
    agent1: {
      ...taskStates.task1,
      id: 'agent1',
      lastToolName: 'Bash',
      usage: { totalTokens: 12_345, toolUses: 14, durationMs: 21_000 },
    },
  },
  todos: undefined,
};

// A proactive turn's state as the render must treat it. The host sends no
// reply text and, below `full`, no reasoning text; the state here carries both
// at every level, so what the page leaves out is the component's doing.
const draft = '这段是还没发出去的回复草稿，主动模式下不会显示在界面里。';
const proactiveTaskStates: StreamingState['taskStates'] = {
  task1: {
    ...taskStates.task1,
    thinkingTail: '子 Agent 的思考：先核对帧率采样方式。',
  },
};

/** What a proactive workspace shows of a turn, by visibility. */
const proactiveSteps: StreamingStep[] = [
  {
    id: 'thinking-0',
    kind: 'thinking',
    at: ago(40),
    endedAt: ago(33),
    status: 'done',
    durationMs: 6_400,
    title: '确认订阅范围',
    text: thinkingA,
  },
  {
    id: 'tool-t0',
    kind: 'tool',
    at: ago(32),
    endedAt: ago(31),
    status: 'done',
    toolUseId: 't0',
    toolName: 'Grep',
    summary: 'useVirtualizer in web/src',
  },
  {
    id: 'tool-t1',
    kind: 'tool',
    at: ago(12),
    status: 'running',
    toolUseId: 't1',
    toolName: 'Bash',
    summary:
      "bash -lc 'npx vitest run tests/frontend-session-sidebar-copy.test.ts'",
  },
  {
    id: 'task-task1',
    kind: 'task',
    at: ago(9),
    status: 'running',
    taskId: 'task1',
    toolUseId: 'task1',
    toolName: 'Task',
    title: '检查移动端滚动性能',
    summary: '已用 Playwright 录制 3 组滚动帧率',
  },
];

/** A progress statement the Agent sent the user mid-turn (`&progress=1`). */
const progressStep: StreamingStep = {
  id: 'note-progress',
  kind: 'text',
  at: ago(36),
  endedAt: ago(36),
  status: 'done',
  commentary: true,
  progress: true,
  text: '收到，我先跑一遍侧栏的测试，再看滚动帧率，大概要一两分钟。',
};
const withProgress = (steps: StreamingStep[]): StreamingStep[] =>
  params.get('progress') === '1'
    ? [...steps.slice(0, 1), progressStep, ...steps.slice(1)]
    : steps;

const proactiveStreaming: StreamingState = {
  partialText: draft,
  thinkingText: thinkingA,
  thinkingTitle: '确认订阅范围',
  isThinking: false,
  thinkingDurationMs: 6_400,
  steps: withProgress(proactiveSteps),
  activeTools: [
    {
      toolName: 'Bash',
      toolUseId: 't1',
      startTime: ago(12),
      toolInputSummary:
        "bash -lc 'npx vitest run tests/frontend-session-sidebar-copy.test.ts'",
    },
  ],
  activeHook: null,
  systemStatus: null,
  recentEvents: [],
  traceEvents: [],
  taskStates: proactiveTaskStates,
  todos: [
    { id: '1', content: '替换渲染循环为虚拟列表', status: 'completed' },
    { id: '3', content: '移动端滚动性能验证', status: 'in_progress' },
  ],
};

/** Reasoning with the Markdown the models write: titles, lists, code. */
const markdownThinking = [
  '**检查流式渲染的开销**',
  '',
  '先看每个 delta 触发的重渲染范围：`StreamingDisplay` 订阅了整个 streaming 对象，所以每帧都会重渲染。',
  '',
  '**对比两种做法**',
  '',
  '- 窄 selector：只订阅需要的字段，改动最小',
  '- 拆分 store：更彻底，但要改动所有订阅方',
  '',
  '```ts',
  'const text = useChatStore((s) => s.streaming[jid]?.partialText);',
  '```',
  '',
  '**确认行高估算**',
  '',
  '估算与实测不一致时，终稿替换流式卡片会出现滚动跳动，需要用卡片实测高度播种。',
].join('\n');

const thinkingMarkdownStreaming: StreamingState = {
  partialText: '',
  thinkingText: markdownThinking,
  thinkingTitle: '确认行高估算',
  isThinking: true,
  thinkingDurationMs: 4_200,
  steps: [
    {
      id: 'thinking-0',
      kind: 'thinking',
      at: ago(14),
      status: 'running',
      title: '确认行高估算',
      text: markdownThinking,
    },
  ],
  activeTools: [],
  activeHook: null,
  systemStatus: null,
  recentEvents: [],
  traceEvents: [],
  taskStates: {},
};

const markdownStreaming: StreamingState = {
  partialText: markdownPartial,
  thinkingText: '',
  isThinking: false,
  activeTools: [],
  activeHook: null,
  systemStatus: null,
  recentEvents: [],
  traceEvents: [],
  taskStates: {},
  todos: [],
};

const followUps: QueuedFollowUp[] =
  scenario === 'streaming'
    ? [
        {
          id: 'q1',
          chat_jid: sessionJid,
          sender: userId,
          sender_name: 'riba2534',
          content: '做完以后顺便把 FilePanel 的列表也检查一下',
          timestamp: at(1),
          delivery_mode: 'queue',
          delivery_status: 'queued',
          delivery_priority: 0,
        },
        {
          id: 'q2',
          chat_jid: sessionJid,
          sender: userId,
          sender_name: 'riba2534',
          content: '还有暗色模式下的对比度',
          timestamp: at(0),
          delivery_mode: 'queue',
          delivery_status: 'queued',
          delivery_priority: 0,
        },
      ]
    : [];

useAuthStore.setState({
  authenticated: true,
  user,
  initialized: true,
  checking: false,
});

const isRunning =
  scenario === 'streaming' ||
  scenario === 'facts-live' ||
  scenario === 'markdown-streaming' ||
  scenario === 'waiting' ||
  scenario === 'silent' ||
  scenario === 'thinking-markdown' ||
  scenario === 'proactive';

const scenarioStreaming: StreamingState | undefined =
  scenario === 'streaming'
    ? streaming
    : scenario === 'facts-live'
      ? factsLive
      : scenario === 'silent'
        ? silentStreaming
        : scenario === 'thinking-markdown'
          ? thinkingMarkdownStreaming
          : scenario === 'markdown-streaming'
            ? markdownStreaming
            : scenario === 'proactive'
              ? processVisibility === 'hidden'
                ? {
                    ...silentStreaming,
                    awaitingModel: false,
                    partialText: draft,
                    steps: withProgress([]),
                  }
                : proactiveStreaming
              : undefined;

useChatStore.setState({
  groups: {
    [groupJid]: {
      name: '前端重构',
      folder: 'render-harness',
      added_at: '2026-01-01T00:00:00.000Z',
      interaction_mode:
        scenario === 'proactive' || params.get('mode') === 'proactive'
          ? 'proactive'
          : 'assistant',
      process_visibility: processVisibility,
      kind: 'web',
      is_home: false,
      is_my_home: false,
      can_modify: true,
      execution_mode: 'host',
      agent_profile_name: 'HappyClaw',
    },
  },
  currentGroup: groupJid,
  agentMessages: { [sessionId]: history },
  agentWaiting: isRunning ? { [sessionId]: true } : {},
  activeRuns: isRunning
    ? {
        [sessionJid]: {
          chatJid: sessionJid,
          runId: 'run-harness',
          startedAt: new Date(now - 47_000).toISOString(),
          phase: 'running',
        },
      }
    : {},
  agentStreaming: scenarioStreaming ? { [sessionId]: scenarioStreaming } : {},
  settledStreaming:
    scenario === 'settled'
      ? { [sessionJid]: settledStreaming }
      : scenario === 'facts'
        ? { [sessionJid]: factsSettled }
        : {},
  thinkingCache: {
    m4: '**确认订阅范围**\n\n先看订阅层级，再比较几种方案的复杂度与收益。',
  },
  // A reply whose model gave no reasoning text still says how long it thought.
  thinkingDurationCache: { m4: 12_400, m8: 3_400 },
  // A reply that has its steps is summed up in the settled card; one without
  // (m8, and m4 unless asked) keeps the reasoning and trace rows.
  stepsCache:
    params.get('steps') === '1'
      ? { m4: { steps: settledStreaming.steps ?? [], dropped: 0 } }
      : {},
  traceCache: {
    m4: [
      {
        id: 'h1',
        timestamp: now - 60_000,
        kind: 'tool',
        title: '工具 Grep',
        summary: 'useVirtualizer in web/src',
        toolUseId: 'ht1',
      },
      {
        id: 'h2',
        timestamp: now - 59_000,
        kind: 'tool',
        title: '工具 Read',
        summary: 'SessionSidebar.tsx',
        toolUseId: 'ht2',
      },
    ],
  },
  agents: {
    [groupJid]: [
      {
        id: sessionId,
        name: '前端重构讨论',
        prompt: '',
        status: 'idle',
        kind: 'conversation',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ],
  },
  activeAgentTab: { [groupJid]: sessionId },
  agentHasMore: { [sessionId]: false },
  followUps: { [sessionJid]: followUps },
  loading: false,
  loadAgentMessages: async () => undefined,
  hydrateAgentMessages: async () => undefined,
  refreshAgentMessages: async () => undefined,
  restoreActiveState: async () => undefined,
  loadAgents: async () => undefined,
  loadFollowUps: async () => undefined,
  markChatRead: () => undefined,
});

useFileStore.setState({
  files: { [groupJid]: [] },
  currentPath: { [groupJid]: '' },
  loading: false,
  error: null,
  loadFiles: async () => undefined,
  navigateTo: () => undefined,
});

// The `live` scenario: a spec drives a run through the real reducer, event by
// event, and finishes it like the server does (run_finished, then the final).
if (scenario === 'live') {
  const runId = 'run-live';
  Object.assign(window, {
    renderHarness: {
      start() {
        useChatStore.getState().handleRunStarted(sessionJid, runId);
      },
      emit(event: StreamEvent) {
        useChatStore
          .getState()
          .handleStreamEvent(
            groupJid,
            { turnId: 'turn-live', ...event },
            sessionId,
            runId,
          );
      },
      finish(content: string) {
        useChatStore.getState().handleRunFinished(sessionJid, runId);
        window.setTimeout(() => {
          useChatStore.getState().handleWsNewMessage(
            groupJid,
            {
              ...msg('live-final', 0, true, content),
              turn_id: 'turn-live',
            },
            sessionId,
          );
        }, 60);
      },
    },
  });
}

// Lets a test drive markdown-streaming: stream more text, then settle the
// turn into the final message the way a finished run does. `finish(content)`
// also appends an arbitrary settled reply to the markdown scenario.
if (scenario === 'markdown' || scenario === 'markdown-streaming') {
  Object.assign(window, {
    markdownHarness: {
      kitchenSink: markdownKitchenSink,
      setPartial(partialText: string) {
        useChatStore.setState((s) => ({
          agentStreaming: {
            ...s.agentStreaming,
            [sessionId]: { ...markdownStreaming, partialText },
          },
        }));
      },
      finish(content = markdownKitchenSink) {
        useChatStore.setState((s) => ({
          agentMessages: {
            ...s.agentMessages,
            [sessionId]: [
              ...(s.agentMessages[sessionId] ?? []),
              msg('md-final', 0, true, content),
            ],
          },
          agentStreaming: {},
          agentWaiting: {},
          activeRuns: {},
        }));
      },
    },
  });
}

// Any scenario: a spec can add a message of its own (a long user message).
Object.assign(window, {
  chatHarness: {
    append(id: string, fromMe: boolean, content: string) {
      useChatStore.setState((s) => ({
        agentMessages: {
          ...s.agentMessages,
          [sessionId]: [
            ...(s.agentMessages[sessionId] ?? []),
            msg(id, 0, fromMe, content),
          ],
        },
      }));
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <MotionProvider>
    <TooltipProvider>
      <MemoryRouter
        initialEntries={[`/chat/render-harness?agent=${sessionId}`]}
      >
        <main className="h-[100dvh] overflow-hidden bg-background">
          <ChatView groupJid={groupJid} />
        </main>
      </MemoryRouter>
      <ConfirmHost />
      <Toaster position="top-center" />
    </TooltipProvider>
  </MotionProvider>,
);
