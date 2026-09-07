import type { EvalCase } from './types.js';

export const SYSTEM_EVAL_SUITE_ID = 'eval-suite-system-benchmark-15';
export const SYSTEM_EVAL_SUITE_NAME = '高频智能体典型任务评测基准 (15条)';
export const SYSTEM_EVAL_SUITE_DESCRIPTION =
  '涵盖代码重构、配置诊断、JSON提取、日志根因、SQL优化、参数校验、并发控制、REST规范、文档提炼、跨平台排查、幂等设计、Docker瘦身、Git恢复、安全脱敏、国际化处理等15项典型任务与确定性验收条件。';

export const BUILTIN_EVAL_CASES: Array<
  Omit<EvalCase, 'created_at' | 'updated_at'>
> = [
  {
    id: 'eval-case-01-refactor-boundary',
    suite_id: SYSTEM_EVAL_SUITE_ID,
    name: 'TypeScript 边界防御与严格类型重构',
    category: 'code',
    input_prompt:
      '给定以下处理订单总金额与优惠折扣的 JavaScript 代码，存在隐式类型转换、null 穿透和除以零可能。请使用 TypeScript 重构为强类型防守式代码：声明接口、严禁 any、加入边界校验，并输出代码与简要设计说明：\n\n```js\nfunction calcTotal(items, discountRate) {\n  let sum = 0;\n  for (let i = 0; i < items.length; i++) {\n    sum += items[i].price * items[i].count;\n  }\n  return sum * (1 - discountRate);\n}\n```',
    expected_output:
      '定义清晰的 TypeScript 接口（如 OrderItem），对 items 数组和 discountRate 进行边界校验（判空、非负数、折扣率在 0~1 之间），严禁使用 any。',
    eval_rules: {
      requiredKeywords: ['interface', 'number'],
      forbiddenKeywords: [': any', 'as any'],
      regexPatterns: [
        'interface\\s+\\w+',
        'function\\s+\\w+|const\\s+\\w+\\s*=',
      ],
      minLength: 80,
      passThreshold: 75,
    },
    timeout_ms: 60000,
    order_num: 1,
  },
  {
    id: 'eval-case-02-nginx-sec',
    suite_id: SYSTEM_EVAL_SUITE_ID,
    name: 'Nginx 反向代理安全性与防护加固',
    category: 'ops',
    input_prompt:
      '以下是微服务反向代理的 Nginx 配置片段，请指出存在的 3 处安全或稳定性风险（如缺失客户端真实IP、未限制请求体体积、缺少安全响应头），并提供加固后的完整 Nginx 配置块：\n\n```nginx\nserver {\n    listen 80;\n    server_name api.example.com;\n    location / {\n        proxy_pass http://backend:8080;\n    }\n}\n```',
    expected_output:
      '指出至少三点安全风险：缺少 X-Forwarded-For/X-Real-IP、未设置 client_max_body_size、缺少安全响应头，并给出加固配置。',
    eval_rules: {
      requiredKeywords: ['proxy_set_header', 'client_max_body_size'],
      regexPatterns: [
        'X-Real-IP|X-Forwarded-For',
        'client_max_body_size\\s+\\d+',
      ],
      minLength: 100,
      passThreshold: 70,
    },
    timeout_ms: 60000,
    order_num: 2,
  },
  {
    id: 'eval-case-03-json-extract',
    suite_id: SYSTEM_EVAL_SUITE_ID,
    name: '非结构化监控日志清洗为标准 JSON',
    category: 'data',
    input_prompt:
      '请严格从以下非结构化运维巡检文本中提取关键指标，只输出一个严格合法的 JSON 对象，不要附加任何解释、markdown 代码块或其它文字：\n\n"Host node-prod-03 status: healthy. CPU usage: 18.5% user, 3.2% sys. Disk free: 380GB on /data. Abnormal processes: [zombie-worker, stale-log-flusher]. Reported at 2026-09-07T04:00:00Z."',
    expected_output:
      '严格 JSON 格式，包含 host, cpu, disk, abnormal_processes 等核心字段。',
    eval_rules: {
      requireJson: true,
      requiredJsonKeys: ['host', 'cpu', 'disk', 'abnormal_processes'],
      passThreshold: 80,
    },
    timeout_ms: 60000,
    order_num: 3,
  },
  {
    id: 'eval-case-04-log-root-cause',
    suite_id: SYSTEM_EVAL_SUITE_ID,
    name: '微服务级联超时与重试风暴根因分析',
    category: 'ops',
    input_prompt:
      '分析以下分布式 RPC 链路的超时报错日志，回答：1. 哪个底层依赖服务是故障根因？2. 重试机制为什么导致了上游服务雪崩与级联 504？3. 给出 2 点合理的熔断与超时治理方案。\n\n[trace:8f12a] order-service: POST /pay socket timeout 3000ms, retrying (attempt 1/3)\n[trace:8f12a] pay-gateway: calling bank-api POST /v1/auth failed with ETIMEDOUT\n[trace:8f12a] order-service: POST /pay attempt 3/3 exhausted, returned 504 Gateway Timeout',
    expected_output:
      '识别出底层 bank-api 响应超时是根因，无退避的短时盲目重试加剧拥塞导致级联超时，建议熔断器（Circuit Breaker）和指数退避+抖动策略。',
    eval_rules: {
      requiredKeywords: ['bank-api', '重试', '超时', '熔断'],
      regexPatterns: ['bank-api', '熔断|降级|circuit\\s*breaker'],
      minLength: 90,
      passThreshold: 75,
    },
    timeout_ms: 60000,
    order_num: 4,
  },
  {
    id: 'eval-case-05-sql-optimize',
    suite_id: SYSTEM_EVAL_SUITE_ID,
    name: '千万级订单表深分页慢查询优化',
    category: 'database',
    input_prompt:
      '现有订单表 orders (id bigint primary key, user_id int, status varchar, created_at datetime)。执行慢查询：\n`SELECT * FROM orders WHERE user_id = 10023 ORDER BY created_at DESC LIMIT 500000, 20;`\n耗时高达 8 秒。请解释深分页导致全表扫描的原因，并给出延迟关联（子查询延迟回表）或 Seek 游标的改写 SQL，以及最佳复合索引创建语句。',
    expected_output:
      '指出深分页需要扫描并抛弃前 50 万行数据的性能损耗，提供利用覆盖索引做子查询延迟回表优化，并给出 `CREATE INDEX idx_user_created ON orders (user_id, created_at DESC);`。',
    eval_rules: {
      requiredKeywords: ['INDEX', 'user_id', 'created_at'],
      regexPatterns: ['CREATE\\s+INDEX', 'LIMIT|WHERE|JOIN'],
      minLength: 100,
      passThreshold: 75,
    },
    timeout_ms: 60000,
    order_num: 5,
  },
  {
    id: 'eval-case-06-api-validation',
    suite_id: SYSTEM_EVAL_SUITE_ID,
    name: '用户注册接口入参严格防御与错误规范',
    category: 'security',
    input_prompt:
      '设计一个用户注册 API 的入参防守验证逻辑。入参字段包括：username (字母数字下划线 3-20 位), password (8-32 位，需包含大写、小写、数字、特殊字符中的至少 3 种), phone (中国大陆 11 位手机号)。请列出各字段的具体校验规则，并以 JSON 结构示例输出字段校验失败时的统一错误响应格式。',
    expected_output:
      '给出字段精确规则与正则表达式，并输出结构化的 JSON 错误格式（含 code, message, field 等属性）。',
    eval_rules: {
      requiredKeywords: ['username', 'password', 'phone', 'code', 'message'],
      regexPatterns: ['1[3-9]\\d{9}|手机号|phone', '\\{[\\s\\S]*"code"'],
      minLength: 120,
      passThreshold: 75,
    },
    timeout_ms: 60000,
    order_num: 6,
  },
  {
    id: 'eval-case-07-concurrency-race',
    suite_id: SYSTEM_EVAL_SUITE_ID,
    name: '高并发缓存击穿防御与 SingleFlight 方案',
    category: 'code',
    input_prompt:
      '当某个极高访问量的热点数据缓存失效瞬间，大量并发请求穿透至数据库可能导致服务宕机（缓存击穿）。请分析竞态条件，详细说明如何使用互斥锁或 SingleFlight（合并同请求）来解决，并解释为什么设置过期时间时需要加入随机抖动（Jitter）。',
    expected_output:
      '说明并发穿透现象，讲解 SingleFlight 仅允许一个 goroutine/协程查询 DB 其他并发请求复用结果的机制，指出随机 Jitter 避免集中同时过期的雪崩效应。',
    eval_rules: {
      requiredKeywords: ['SingleFlight', '互斥锁', '击穿', '抖动'],
      regexPatterns: ['SingleFlight|互斥锁|Mutex|mutex', '抖动|Jitter|jitter'],
      minLength: 100,
      passThreshold: 75,
    },
    timeout_ms: 60000,
    order_num: 7,
  },
  {
    id: 'eval-case-08-restful-standards',
    suite_id: SYSTEM_EVAL_SUITE_ID,
    name: 'RESTful API 规范性审查与重构设计',
    category: 'architecture',
    input_prompt:
      '审查以下 3 个不规范的接口设计：\n1. GET /api/user/deleteUser?id=123\n2. POST /api/get_order_detail_by_id\n3. POST /api/updateProductStatus\n请分别指出每个设计违反了什么 RESTful 核心原则（HTTP方法语义、URI资源化动词），并给出重构后的标准设计（包含 HTTP Method、规范 URI、推荐状态码）。',
    expected_output:
      '指出 GET 不可用于写操作，URI 中不应含有动词，重构为 DELETE /api/users/123 (204), GET /api/orders/:id (200), PATCH/PUT /api/products/:id/status (200)。',
    eval_rules: {
      requiredKeywords: ['DELETE', 'GET', '200', '204'],
      regexPatterns: ['DELETE\\s+/api/users', 'GET\\s+/api/orders'],
      minLength: 100,
      passThreshold: 75,
    },
    timeout_ms: 60000,
    order_num: 8,
  },
  {
    id: 'eval-case-09-doc-summary',
    suite_id: SYSTEM_EVAL_SUITE_ID,
    name: '技术方案核心收益与潜在风险精炼',
    category: 'doc',
    input_prompt:
      '请将以下段落精简提炼为结构化总结，严格包含【核心收益（3点）】与【潜在风险（2点）】，不要出现任何寒暄或客套话：\n\n“我们将网关系统由单体架构演进为边缘连接器层与中心路由分发层分离。边缘层负责海量长连接维持与协议解包，中心层处理权限、业务会话状态机与投递队列。该改造使得单渠道网络抖动不再波及全局，热重启时客户端连接可无缝保持，服务器内存降低30%。但改造后引入了跨进程 IPC 的通信延迟开销，全链路排查依赖分布式追踪，且运维部署复杂度有所上升。”',
    expected_output:
      '条目清晰地总结出3点收益（故障隔离、平滑重启无感、内存优化）和2点风险（IPC通信延迟增加、运维与追踪复杂度提升）。',
    eval_rules: {
      requiredKeywords: ['收益', '风险', '连接', 'IPC'],
      regexPatterns: ['收益', '风险'],
      minLength: 80,
      passThreshold: 75,
    },
    timeout_ms: 60000,
    order_num: 9,
  },
  {
    id: 'eval-case-10-cross-platform',
    suite_id: SYSTEM_EVAL_SUITE_ID,
    name: 'Node.js 跨平台路径与文件操作排查',
    category: 'code',
    input_prompt:
      "以下 Node.js 代码在 Linux 开发机上运行正常，但在 Windows 和容器环境报错：\n\n```js\nconst cachePath = process.cwd() + '/data/temp/' + fileName;\nfs.writeFileSync(cachePath, content);\n```\n\n请指出 3 个跨平台环境缺陷（硬编码路径分隔符、未递归创建目录、依赖当前工作目录 cwd 的不可靠性），并给出健壮的重构实现。",
    expected_output:
      '指出 `/` 在不同平台的兼容性问题，指出目录不存在时 writeFileSync 抛错，给出使用 path.join / path.resolve 及 fs.mkdirSync(..., { recursive: true }) 的安全写法。',
    eval_rules: {
      requiredKeywords: ['path.join', 'recursive', 'true'],
      regexPatterns: ['path\\.join|path\\.resolve', 'recursive:\\s*true'],
      minLength: 90,
      passThreshold: 75,
    },
    timeout_ms: 60000,
    order_num: 10,
  },
  {
    id: 'eval-case-11-payment-idempotency',
    suite_id: SYSTEM_EVAL_SUITE_ID,
    name: '外部支付异步回调幂等性与防重入设计',
    category: 'architecture',
    input_prompt:
      '第三方支付平台（如微信/支付宝）可能在短时间内发送多次重复的回调通知。请设计服务端订单处理的幂等机制，说明如何防范并发重复入账，涵盖：数据库唯一索引、状态机合法性流转校验、分布式锁粒度与事务边界。',
    expected_output:
      '详细说明通过支付单流水号作为唯一索引防重，状态机检查当前仅在 pending 状态下才能转为 paid，使用分布式锁并确保事务提交后才释放锁或触发下游发货通知。',
    eval_rules: {
      requiredKeywords: ['唯一', '状态机', '幂等', '事务'],
      regexPatterns: ['唯一索引|唯一键|UNIQUE', '状态机|状态'],
      minLength: 120,
      passThreshold: 75,
    },
    timeout_ms: 60000,
    order_num: 11,
  },
  {
    id: 'eval-case-12-dockerfile-multistage',
    suite_id: SYSTEM_EVAL_SUITE_ID,
    name: 'Node.js 生产环境 Docker 镜像多阶段构建',
    category: 'ops',
    input_prompt:
      '编写一个生产级 Node.js 应用的 Dockerfile。要求：\n1. 采用多阶段构建（构建阶段与生产运行阶段分离）；\n2. 最终运行镜像中严禁保留 devDependencies；\n3. 容器使用非 root 用户（如 node 用户）运行；\n4. 设置 NODE_ENV=production 并复制必要编译产物。',
    expected_output:
      '包含 AS builder 阶段进行 npm ci 和 build，最终运行阶段仅拷贝生产依赖与 dist，使用 USER node，设置 ENV NODE_ENV=production。',
    eval_rules: {
      requiredKeywords: ['FROM', 'AS', 'USER', 'NODE_ENV=production'],
      regexPatterns: ['AS\\s+builder|AS\\s+build', 'USER\\s+\\w+'],
      minLength: 100,
      passThreshold: 75,
    },
    timeout_ms: 60000,
    order_num: 12,
  },
  {
    id: 'eval-case-13-git-recovery',
    suite_id: SYSTEM_EVAL_SUITE_ID,
    name: 'Git 误操作丢失 Commit 通过 reflog 抢救',
    category: 'tooling',
    input_prompt:
      '一名开发者在执行 rebase 解决冲突时，误执行了 `git rebase --skip` 导致自己本应保留的关键 commit 被跳过丢失，之后又执行了新的 commit。请写出使用 `git reflog` 找回丢失提交的完整终端命令流程，并说明其原理解析。',
    expected_output:
      '列出 `git reflog` 查看历史游标变动，定位到丢失 commit 的 SHA，使用 `git cherry-pick <sha>` 或新建分支检出救回，解释 reflog 记录了本地全部 HEAD 移动历史。',
    eval_rules: {
      requiredKeywords: ['git reflog', 'git cherry-pick', 'HEAD@'],
      regexPatterns: ['git\\s+reflog', 'cherry-pick|reset'],
      minLength: 90,
      passThreshold: 75,
    },
    timeout_ms: 60000,
    order_num: 13,
  },
  {
    id: 'eval-case-14-privacy-masking',
    suite_id: SYSTEM_EVAL_SUITE_ID,
    name: '敏感信息日志脱敏与信息安全合规防御',
    category: 'security',
    input_prompt:
      '有团队成员建议将用户的 18 位身份证号、11 位手机号和银行卡号明文打印在服务日志中以便线上定位 bug。请从安全合规角度严肃说明此举的违规性质与泄露风险，并给出针对手机号与身份证号的通用脱敏掩码规则与 TypeScript 替换实现。',
    expected_output:
      '指出违反个人信息合规红线，容易导致泄露审计事故；提供手机号（保留前3后4，中间4位*）和身份证号（保留前6后4，中间8位*）的脱敏规则及正则表达式替换函数。',
    eval_rules: {
      requiredKeywords: ['合规', '脱敏', '掩码', '违规'],
      regexPatterns: ['脱敏|掩码|mask', '\\*{4,}'],
      minLength: 110,
      passThreshold: 75,
    },
    timeout_ms: 60000,
    order_num: 14,
  },
  {
    id: 'eval-case-15-i18n-format',
    suite_id: SYSTEM_EVAL_SUITE_ID,
    name: '国际化动态插值与参数容错模板函数',
    category: 'i18n',
    input_prompt:
      '编写一个国际化文案插值函数 `formatMessage(template: string, params?: Record<string, unknown>): string`。要求：\n1. 支持 `{name}` 命名占位符替换；\n2. 若 params 缺失某个参数，不可输出 undefined 或崩溃，需保留原占位符或优雅降级；\n3. 输出完整的 TypeScript 代码并包含 3 组代表性测试用例。',
    expected_output:
      '实现带有正则替换的 formatMessage，处理 params 为空或参数未定义的情况，给出正常匹配、缺失参数、空入参等用例。',
    eval_rules: {
      requiredKeywords: ['formatMessage', 'template', 'replace'],
      regexPatterns: ['formatMessage', 'replace|RegExp'],
      minLength: 90,
      passThreshold: 75,
    },
    timeout_ms: 60000,
    order_num: 15,
  },
];
