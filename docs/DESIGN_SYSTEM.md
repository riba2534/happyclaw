---
name: design-system
description: HappyClaw Design System — typography, color tokens, component patterns, and styling rules. Applies when creating or modifying UI components, styling chat bubbles, cards, streaming displays, or any visual element in the web frontend.
user-invocable: false
---

# HappyClaw Design System

暖色调 AI 聊天界面设计规范，适配群聊 IM 场景的卡片式布局。

## 1. 字体栈

三套字体，各有明确分工：

| 变量 | 字体栈 | 用途 |
|------|--------|------|
| `--font-sans` | Inter Variable, system-ui, Segoe UI, Roboto, sans-serif | UI 界面：按钮、标签、导航、输入框、侧边栏 |
| `--font-serif` | Georgia, Noto Serif SC, Times New Roman, serif | AI 回复内容：消息卡片、流式文本、推理块 |
| `--font-mono` | JetBrains Mono, Fira Code, ui-monospace, monospace | 代码：行内代码、代码块、终端、Bash 命令 |

### 使用规则

- AI 消息卡片（MessageBubble、StreamingDisplay）加 `font-serif`
- 卡片内嵌的 UI 元素（ToolActivityCard、TodoProgressPanel）用 `font-sans` 保持区分
- `<pre>` 和行内 `<code>` 始终用 `font-mono`
- 用户消息、侧边栏、设置页等用默认 `font-sans`（无需显式声明）
- AI 回复中的 `<strong>` / `<b>` 使用 `font-weight: 600`（semibold），不是默认的 700

## 2. 字号层级

| 层级 | 大小 | 行高 | 场景 |
|------|------|------|------|
| 正文 | `text-base` (16px) | `leading-[1.65]` (26.4px) | AI 回复 Markdown 正文 |
| 二级内容 | `text-[13px]` | 默认 | 工具卡片、事件轨迹、状态提示、Todo 条目、Agent 摘要 |
| 标签 | `text-xs` (12px) | 默认 | "Reasoning" 标签、sender name、elapsed time、进度百分比 |
| 小标签 | `text-[11px]` | 默认 | Agent 状态标签、AskUser 提示文字 |
| 标题 H2 | 18px | 26.4px | Markdown 渲染的 H2，font-weight 600 |
| 标题 H3 | 16px | 24px | Markdown 渲染的 H3，font-weight 600 |
| 代码块 | `text-sm` (14px) | 默认 | `<pre>` 代码块 |
| 行内代码 | `text-[0.9em]` (~14.4px) | relaxed | `<code>` 行内代码 |

## 3. 颜色系统

### 3.1 语义 Token（必须使用）

| Token | 用途 | 禁止替代 |
|-------|------|---------|
| `text-foreground` | 主要文字 | 不要用 `text-slate-900`、`text-black` |
| `text-muted-foreground` | 次要文字、placeholder | 不要用 `text-slate-400`、`text-gray-500` |
| `text-foreground/70` | 可交互次要文字 | 不要用 `text-slate-600` |
| `bg-muted` | 按钮 hover、进度条底色 | 不要用 `bg-slate-100` |
| `bg-background` | 页面底色 | 不要用 `bg-white`（页面级） |
| `border-border` | 通用边框 | 不要用 `border-slate-200` |
| `text-primary` | 品牌强调色 | — |
| `bg-brand-*` | 品牌色阶（50-700） | — |

> **硬规则：禁止在聊天组件中使用 `text-slate-*`、`bg-slate-*`、`border-slate-*`。** 所有 slate 色已清理完毕，不要重新引入。

### 3.2 行内代码颜色

暖棕色方案，通过 CSS 变量定义（`globals.css`），不使用 primary 橙色：

```
背景: bg-[var(--inline-code-bg)]
文字: text-[var(--inline-code-text)]
圆角: rounded-md
内边距: px-1 py-px
```

### 3.3 代码块颜色

```
背景: !bg-[var(--code-block-bg)]
文字: 继承 rehype-highlight 语法高亮
圆角: rounded-lg
内边距: p-3.5
```

### 3.4 状态色（TaskAgentBlock）

每种状态需同时声明 light 和 dark 变体：

| 状态 | Light | Dark |
|------|-------|------|
| Running | `blue-200/60`, `blue-50/40`, `text-blue-700` | `blue-700/40`, `blue-950/30`, `text-blue-300` |
| Error | `red-200/60`, `red-50/40`, `text-red-700` | `red-700/40`, `red-950/30`, `text-red-300` |
| Completed | `emerald-200/60`, `emerald-50/40`, `text-emerald-700` | `emerald-700/40`, `emerald-950/30`, `text-emerald-300` |
| Reasoning | `amber-200/60`, `amber-50/40`, `text-amber-700` | `amber-800/40`, `amber-950/30`, `text-amber-300` |

## 4. 卡片与容器

### 4.1 AI 消息卡片

```
bg-surface rounded-xl border border-border/60
px-5 py-4 font-serif shadow-card
移动端: max-lg:bg-surface/90 max-lg:backdrop-blur-sm
```

- `bg-surface` 在亮/暗模式下自动适配（light: #ffffff, dark: oklch(0.205 0 0)）
- 不使用 `bg-card`（#F0EEE6 太黄暗）
- `shadow-card` 通过 CSS 变量定义，暗色模式自动加深

### 4.2 用户消息

用户消息不用卡片，右对齐 pill 样式：

```
bg-brand-50 border border-brand-200 rounded-2xl rounded-br-md
px-4 py-2.5
```

### 4.3 工具卡片（ToolActivityCard）

```
rounded-lg border border-brand-200 bg-brand-50/50
px-2.5 py-1.5 text-[13px] font-sans
```

嵌套工具：`ml-4 border-l-2 border-brand-200 pl-2`

### 4.4 选中态

```
选中: bg-accent
悬停: hover:bg-accent/50
```

## 5. 暗色模式规则

每个硬编码的浅色值必须有 `dark:` 对应：

| Light | Dark | 说明 |
|-------|------|------|
| `bg-surface` | 自动适配 | 卡片（通过 CSS 变量 `--surface`） |
| `border-border/60` | 自动适配 | 边框 |
| `shadow-card` | 自动适配 | 投影（通过 CSS 变量 `--card-shadow`） |
| `bg-amber-50/40` | `dark:bg-amber-950/30` | Reasoning 块 |
| `text-amber-700` | `dark:text-amber-300` | Reasoning 标签 |
| `text-blue-700` | `dark:text-blue-300` | Running 状态 |

## 6. 间距与布局

- 消息区域最大宽度：`max-w-3xl` (768px)
- 消息区域水平 padding：`px-4`
- 卡片内 padding：`px-5 py-4`
- 工具卡片 padding：`px-2.5 py-1.5`
- 消息间距：`py-3`（消息之间）
- 头像与卡片间距：`gap-3`（Desktop）

## 7. 动画

### Bouncing Dots（思考中指示器）

```html
<span class="w-2 h-2 bg-brand-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
<span class="w-2 h-2 bg-brand-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
<span class="w-2 h-2 bg-brand-400 rounded-full animate-bounce" />
```

### Spinner（工具调用、Hook 执行）

```html
<svg class="w-3.5 h-3.5 animate-spin text-primary" viewBox="0 0 24 24" fill="none">
  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
</svg>
```

## 8. 设计审查清单

修改聊天相关组件时，检查以下项目：

- [ ] 没有引入任何 `slate-*` 颜色
- [ ] 所有硬编码颜色都有 `dark:` 变体
- [ ] AI 内容区域使用 `font-serif`，UI 元素使用 `font-sans`
- [ ] 代码使用 `font-mono`
- [ ] 文字大小符合层级规范（16px/13px/12px/11px）
- [ ] 卡片使用 `bg-surface`，不使用 `bg-card`
- [ ] 行内代码使用暖棕色 `rgb(138,36,36)`，不使用 `text-primary`

### Known Limitations

- `billing/` 目录组件仍使用 `bg-white dark:bg-zinc-800`、`border-zinc-*` 等旧模式，待后续统一迁移
