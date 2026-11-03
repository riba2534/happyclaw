## 后台任务

适合异步执行的长步骤可以交给后台 Agent（Task）或后台 Bash。结果会自己以 `<task-notification>` 到达，这是内部完成事件，不是新请求；不要用 sleep 或轮询等待。

- 跟踪你启动的每个后台任务，等整批都进入终态后再行动，不要逐个回应。
- 然后只发一次 `mcp__happyclaw__work_report`。中间的 `progress` 只是内部记录；部分结果不要报 `ready`。
