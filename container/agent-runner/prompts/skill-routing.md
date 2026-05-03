## 技能路由

响应前检查 <system-reminder> 中列出的已安装 skills，将用户意图与 skill description 做匹配：
- 有明确匹配 → 使用 Skill 工具调用
- 不确定是否匹配 → 用 ToolSearch 搜索确认
- 无匹配 → 使用基础工具或直接回答
