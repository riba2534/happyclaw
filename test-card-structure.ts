import { buildAgentReplyCard } from './src/feishu-cards/builder.js';

// 模拟 feishu.ts:517 的调用
const card = buildAgentReplyCard({
  status: 'done',
  text: '这是一个测试回复\n\n包含多行内容\n\n- 列表项 1\n- 列表项 2\n\n```javascript\nconst test = "code block";\n```'
});

console.log(JSON.stringify(card, null, 2));
