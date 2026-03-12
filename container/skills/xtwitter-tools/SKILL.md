---
name: xtwitter-tools
description: X (Twitter) 信息获取与推文发送工具，基于浏览器自动化实现
allowed-tools: Bash(agent-browser:*)
---

# X (Twitter) 工具集

## 功能说明

此技能提供 X (Twitter) 平台的信息获取和推文发送功能，通过浏览器自动化实现。

## 使用方式

### 1. 打开 X (Twitter) 主页

```bash
agent-browser open https://x.com
agent-browser open https://twitter.com
```

### 2. 查看推文时间线

```bash
agent-browser open https://x.com/home
agent-browser snapshot -i  # 查看可交互元素
```

### 3. 搜索内容

```bash
agent-browser open https://x.com/search?q=your_query
```

### 4. 查看用户资料

```bash
agent-browser open https://x.com/username
```

### 5. 发送推文（需要登录）

```bash
# 先登录（保存状态以便后续使用）
agent-browser open https://x.com/i/flow/login
agent-browser snapshot -i
# 使用 snapshot 返回的 @refs 填写登录表单

# 或加载已保存的登录状态
agent-browser state load twitter-auth.json

# 发送推文
agent-browser open https://x.com/compose/post
agent-browser snapshot -i
agent-browser fill @e1 "你的推文内容"
agent-browser click @e2  # 点击发送按钮
```

### 6. 保存/加载登录状态

```bash
# 登录成功后保存状态
agent-browser state save twitter-auth.json

# 后续使用时加载状态
agent-browser state load twitter-auth.json
```

## 示例工作流

### 读取热门推文

```bash
agent-browser open https://x.com/explore
agent-browser wait --load networkidle
agent-browser snapshot -i
agent-browser screenshot x-explore.png
```

### 搜索并获取结果

```bash
agent-browser open https://x.com/search?q=AI
agent-browser wait 2000
agent-browser snapshot -i
agent-browser get text @e1  # 获取推文内容
```
