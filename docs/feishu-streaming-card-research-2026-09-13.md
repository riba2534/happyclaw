# 飞书流式卡片调研与重构建议

调研日期：2026-09-13。代码基线：`16717bb4cd434a8bfeb8761fa6f8e7540a8abd8f`。

本次由三个 Agent 分别核查官方 API、官方 SDK 与组件能力、项目实现及测试。本文是研究方案；尚未实施重构、发送真实飞书消息或部署 Mac mini。

## 1. 建议结论

保留已有 CardKit 接入与可靠投递机制，优先改成“正文优先、详情按需出现、长文完整、完成时布局稳定”。先修复内容截断并核实批量更新契约，再逐步抽取状态、渲染、传输和分页模块。

项目已经具有原生打字机、辅助组件批量更新、序列与幂等、超时重开、三级降级、续卡及恢复机制。这些应作为重构必须保留的基线，不列作新功能。

## 2. 官方 API 当前能力

以下为抓取时官网和官方 SDK 已支持的能力，不代表它们都是近期新增。官方网页的 `.md` 导出提供了完整正文。

| 用途              | 官方 Node SDK 方法                         | 对本项目的意义                       |
| ----------------- | ------------------------------------------ | ------------------------------------ |
| 创建卡片实体      | `cardkit.v1.card.create`                   | 创建 JSON 2.0 卡片并开启流式         |
| 发送/回复卡片     | `im.v1.message.create` / `reply`           | 用 `card_id` 发送；保留当前话题路由  |
| 打字机正文        | `cardkit.v1.cardElement.content`           | 对指定文本元素传入累积全文           |
| 局部批量更新      | `cardkit.v1.card.batchUpdate`              | 一次请求更新状态、详情等多个组件     |
| 动态增删          | `cardkit.v1.cardElement.create` / `delete` | 有内容时再创建详情，移除无用操作     |
| 更新属性/替换组件 | `cardkit.v1.cardElement.patch` / `update`  | 精细更新属性；属性 PATCH 不能改 tag  |
| 配置/结束流式     | `cardkit.v1.card.settings`                 | 设置流式参数、关闭流式、修改消息摘要 |
| 整卡替换          | `cardkit.v1.card.update`                   | 保留作终态或降级需要时使用           |

来源：[官方 API 总览](https://open.feishu.cn/document/cardkit-v1/feishu-card-resource-overview)、[流式教程](https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview)、[组件属性更新](https://open.feishu.cn/document/cardkit-v1/card-element/patch)。

### 影响设计的边界

- **流式期间支持组件增删改。** 不能把本项目固定预置折叠面板的策略当作平台限制。动态插入的滚动位置和展开状态仍需客户端实测。[流式教程](https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview)
- **正文接口接收累积全文。** 只有旧文本是新文本的前缀时才继续打字机；修改已展示前文会直接整段上屏。因此应稳定已提交的正文前缀，避免每次重排整个 Markdown。[文本更新](https://open.feishu.cn/document/cardkit-v1/card-element/content)
- **区分网络刷新与客户端动画。** `print_frequency_ms`、`print_step` 和 `fast/delay` 控制客户端上屏；不能直接等同 HTTP 调用频率。`delay` 对快速输出可能积累显示延迟，首轮建议保留 `fast` 并实测步长。创建与超时重开应使用同一配置。[流式教程](https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview)
- **频率限制采用明确数值。** 官网写明单卡全部 CardKit 操作合计 10 次/秒，各接口另列 1000 次/分钟、50 次/秒；旧消息 patch 是单消息 5 QPS。官网同页还有“不会触发 QPS”的宽泛说法，存在文案冲突，不能据此取消限流，也没有找到流式 20 QPS 的官方依据。[流式教程](https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview)、[文本接口](https://open.feishu.cn/document/cardkit-v1/card-element/content)、[旧消息 patch](https://open.feishu.cn/document/server-docs/im-v1/message-card/patch)
- **生命周期要明确。** 距上次开启 10 分钟后自动关闭流式；普通内容心跳不应被当成延长该期限的保证。卡片实体可更新期限为创建后 14 天。结束要主动关闭流式，并显式修改自定义摘要，不能让消息列表一直写着“生成中”。[流式教程](https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview)、[设置接口](https://open.feishu.cn/document/cardkit-v1/card/settings)
- **单卡统一排序。** 同一卡片所有 CardKit 操作共享严格递增 sequence，uuid 提供操作幂等。保留现有确认序列和不确定 ACK 处理，降级、回调、usage 更新也要通过统一编排。[文本接口](https://open.feishu.cn/document/cardkit-v1/card-element/content)
- **交互需要协调更新。** 流式期间不能依靠卡片回调响应直接替换卡片；交互期间更新还可能返回 `200810`。停止/等待输入应先暂停流式写入并按官方流程关闭流式，再进入交互或终态，不能让回调与后台流各自覆盖消息。[流式教程](https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview)
- **按整卡预算分页。** 官方错误码说明卡片应控制在 30KB 内，JSON 2.0 最多 200 个元素/组件；正文参数允许 100000 字符不等于整卡可承载该长度。预算应计入 UTF-8、样式、JSON 开销和嵌套元素，预留服务端处理余量。[批量更新](https://open.feishu.cn/document/cardkit-v1/card/batch_update)
- **客户端与权限。** JSON 2.0 需飞书 7.20+，自定义流式参数需 7.23+。CardKit 要求创建实体的同一应用身份及 `cardkit:card:write`；发送还需机器人与对应消息权限。旧客户端展示升级提示，不会自动获得旧版布局。[流式教程](https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview)

### 组件选择

正文使用 Markdown，首期保持代码和 Markdown 表格的原始语义。详情使用一个浅色折叠区，内部按任务、工具、执行说明分组。官方折叠容器最多嵌套五层且不能包含 form；原生 table 只能放 body 根级，不能塞进折叠面板。因此不建议为了视觉统一而把所有表格强制转换成原生 table。[折叠面板](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/collapsible-panel)、[原生表格](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/table)

## 3. SDK 核查

- 项目声明 `@larksuiteoapi/node-sdk: ^1.58.0`，本地安装版本为 **1.71.1**。
- npm 调研时最新为 **1.73.3**，发布时间 **2026-09-04**。
- 对比最新官方发布包与本地类型定义，CardKit 的十个方法签名相同：卡片 create/settings/update/idConvert/batchUpdate，组件 content/create/delete/patch/update。
- SDK 已有 Channel / CardStreamController 高层封装，但其原生文本流预设单正文骨架，通用 card update 走消息级整卡 patch。现有 HappyClaw 的多区域流、持久化恢复和续卡不宜直接替换为该封装。

建议：SDK 升级单独评估，展示重构不以升级为前置。来源：[官方 SDK 仓库](https://github.com/larksuite/node-sdk)、[npm 发布信息](https://registry.npmjs.org/@larksuiteoapi%2fnode-sdk)。

封装实现依据：[官方 Markdown 流源码](https://github.com/larksuite/node-sdk/blob/main/channel/outbound/streaming/markdown-stream.ts)、[官方卡片流源码](https://github.com/larksuite/node-sdk/blob/main/channel/outbound/streaming/card-stream.ts)。上述 main 链接会随上游变化，版本判断以本次 1.71.1 / 1.73.3 发布包比较为准。

## 4. 本地实现核查

以下位置以本次代码基线为准。源码引用用于定位；尚未观测生产客户端。

| 优先级 | 发现                               | 证据与处理方向                                                                                                                                                                                                     |
| ------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1     | 终态正文可能被截断                 | `src/feishu-cards/length.ts` 将超过四箱的尾部截到 4000 字符。已复现五段各 2500 字符，原文 12508 字符、渲染正文 11506 字符；生成 JSON 12037B，低于定稿续卡保护阈值。分页必须无损。                                  |
| P1     | 批量更新 payload 与官网示例不同    | `src/feishu-streaming-card.ts:1621` 将 batch 内 `partial_element` 再次序列化；官网 batch 示例是对象，独立 PATCH 才要求字符串。现有 mock 测试还解析这层字符串。属于待真实接口验证的契约风险，不能断言生产必然失败。 |
| P2     | 五个空运行面板先于正文             | `src/feishu-cards/builder.ts:243` 和 `sections.ts` 固定预置任务、子 Agent、工具、思考、轨迹面板。短答案首屏负担明显，应正文优先、详情按需创建。                                                                    |
| P2     | 完成阶段改变结构                   | live 的面板在正文前，final 改成正文、元数据、思考/工具，usage 还可能再次整卡替换。建议稳定正文位置与组件 ID，普通收尾局部更新。                                                                                    |
| P2     | 工具耗时与总数失真                 | `feishu-streaming-card.ts:3347` 对已完成工具仍取 now-startTime；清理 Map 又按 startTime，终态计数从同一 Map 累计。需要结束时间、独立累计统计和滚动展示窗口。                                                       |
| P2     | 超长直播停在首段                   | live 在 30000 字符后保留固定前缀，新增内容等到定稿才展示。并且字符限额不代表整卡字节安全。应支持运行中的尾块/尾卡续写。                                                                                            |
| P2     | 动画与排版前后不一致               | builder 与 controller 各有一份不同 STREAMING_CONFIG；live 原文与 final Markdown 优化路径不同。需要统一配置和保持前缀的渲染策略。                                                                                   |
| 待测   | 降级交接和停止回调存在两个写入入口 | 降级先取序列再异步关闭旧 backend，停止回调还直接 message.patch。重构时合并到同一 session 写入编排；尚未复现服务端冲突。                                                                                            |

批量更新差异依据：[官方 batch 示例](https://open.feishu.cn/document/cardkit-v1/card/batch_update)、[独立 PATCH 示例](https://open.feishu.cn/document/cardkit-v1/card-element/patch)。

## 5. 推荐展示方案

布局示意，非飞书客户端实测截图：

```text
正在处理 / 已完成                       ← 单一状态入口

正文连续输出……                         ← 保持位置稳定
代码、列表、表格按内容自然排版

▸ 执行详情                              ← 有真实记录才出现
  任务进度 / 子 Agent / 工具 / 执行说明

停止回复                                ← 仅运行中可操作
运行信息 · 查看完整运行轨迹              ← 有真实信息和链接才展示
```

具体行为：

1. **短回答**：状态和正文即可，不创建空详情；状态变化不导致正文上下移动。
2. **执行中**：状态行给当前操作的简短说明；正文下面创建一个详情折叠区。默认折叠，不在每次更新中重设用户的展开状态。
3. **等待输入**：有真实问题才把问题提升到正文附近。第一阶段沿用已有回答入口；卡内选择/表单属于后续完整交互功能，需要接通回调、等待与恢复，不能只画按钮。
4. **完成**：正文与详情保持相对位置，更新状态和摘要、移除停止操作；usage 迟到时仅更新元数据区域。保留完整运行轨迹入口。
5. **中断/失败**：保留已经生成的正文，用状态与说明告诉用户发生了什么；停止回调不应把整个结果换成一句“操作完成”。
6. **长文**：固定已完成的段落，只对活动尾部流式追加；快到整卡预算时创建续卡。普通长回答可以一个卡片内分块，超过整卡预算才跨卡。不得靠尾部省略号静默丢正文。

首期不引入花哨的图表、假进度或无后端的重试/评价按钮。任务百分比只来自真实任务计数，显示数量不能随清理展示窗口而减少。

## 6. 技术重构建议

保持现有公共 StreamingSession 接口，按职责逐步抽取以下模块；名字仅为建议：

| 模块              | 职责                                                                   |
| ----------------- | ---------------------------------------------------------------------- |
| stream-state      | 消费现有流事件，维护阶段、工具结束时间、累计统计、任务和真实等待状态   |
| stream-view       | 将状态投影为统一 live/final 卡片；稳定元素 ID、按需组件、Markdown 渲染 |
| cardkit-transport | SDK payload、单卡队列、sequence/uuid、ACK、限流、错误分类与重试        |
| card-pagination   | 唯一无损分段规则、整卡字节/元素预算、围栏与表格边界、尾卡续写          |
| stream-session    | 创建、刷新、定稿、中断、恢复与后端切换；协调所有卡片写入               |

刷新策略建议：先保留当前正文 600ms、辅助 1500ms 的基线，核实 batch 正常工作并增加合并计数后，再试验正文 300–500ms、辅助 1000–1500ms。上述是候选实验参数，不是官方推荐或已验证最优值。阶段变化、停止、定稿优先；快速重复事件只保留待发送的最新状态。

正文用 `content` 保持打字机；状态和详情用 batch 属性更新，避免给每行工具状态加打字机。批次内嵌结构统一使用类型化对象，只在 SDK 边界按对应 API 要求序列化。动态增删确认成功后再更新本地组件清单。

限流同时考虑单卡和应用接口预算，给必要的终态更新留余量。对 `200810` 交互锁、限流、流式关闭、结构不合法、ACK 不确定分别处理，避免全部错误都触发重复批次或逐组件请求风暴。

定稿必须成为顺序屏障：停止调度 → 完成待确认写入 → 关闭流式 → 更新终态/摘要/操作区 → 确认成功。降级和恢复继续共享同一卡片的序列所有权；不再以独立队列同时操作它。

## 7. 实施顺序与验收

### 第一阶段：内容和接口正确性

- 修复无损分段与整卡预算，补入已复现的五段正文案例。
- 用官方 batch 示例验证对象契约，记录服务端响应；不把 mock 成功当作 API 已通过。
- 修复工具结束时间与累计统计，统一流式配置。
- 收敛中断、降级、usage 与完成的更新入口。

### 第二阶段：正文优先与动态详情

- 固定正文位置；空详情不创建，有内容后通过组件 API 插入。
- 普通收尾局部更新，保留用户展开状态；需要整卡替换的分支仍受同一生命周期控制。
- 对 PC、移动端、浅色/深色实际观察短回复、工具密集任务、等待输入和完成切换。

### 第三阶段：长输出和调度优化

- 将已有续卡能力统一到原生流式路径，按正文语义边界冻结历史并流式续写尾部。
- 实测不同输出速率下的客户端积压和更新频率；再调整网络刷新与动画参数。
- 记录首段可见延迟、终态确认延迟、单卡请求速率、batch 成功率、降级原因和内容保真，作为新旧比较依据。

### 已完成的本地验证

代码分析 Agent 执行下列现有测试，**5 个文件、136 个测试全部通过**：

```bash
npx vitest run tests/feishu-card.test.ts tests/feishu-cardkit-controller.test.ts tests/feishu-multicard-rollover.test.ts tests/feishu-thread-routing.test.ts tests/feishu-route-safety.test.ts
```

另执行纯 builder 的五段长文案例，已复现尾部截断。通过现有测试不代表该缺陷不存在，也不能证明官方 payload、客户端渲染或滚动体验正确。

### 后续必须完成的 Mac mini 验收

实现后按 [DEPLOYMENT.md](../DEPLOYMENT.md) 部署精确远程提交，保留运行数据和配置，遵循不创建部署备份的既定政策。分别报告本地测试与 Mac mini 检查，生产相关检查通过前不报告功能完成。

真实飞书验收至少覆盖：短答案、代码与表格、中英混合长文、跨卡完整性、并行工具与子 Agent、等待输入、停止保留正文、动态面板展开状态、超过十分钟重开、多会话并发、重启恢复、完成摘要和转发。真实收发测试应在后续实施阶段明确的测试会话中进行；本轮研究没有发送消息。

## 8. 实施记录

实现分支：`codex/feishu-streaming-card-refresh`。上述调研结论保留作为改动前基线。

- 正文置于首位，只有存在执行信息时才插入一个折叠详情区；完成态沿用相同顺序。
- 修正 batch 对象契约，统一创建与重开流式参数，每卡写入间隔至少 120ms。明确拒绝的交互锁、限流响应进行有界重试。
- 正文按 UTF-8 预算无损分页，原生流式及时续卡；代码围栏和表格保留结构，极端超宽结构保留原文分段。Markdown 格式优化保护代码内空行、图片字面量和未闭合围栏。
- 工具耗时固定于结束时间，累计调用数不受详情列表裁剪影响。停止回调只返回提示，由会话统一收尾并保留正文。
- 定稿仍有一次整卡更新以同步标题和最终状态；后续用量信息只局部更新。运行态保留原始 Markdown，完成态保留已有静态样式优化，因此两阶段不保证逐像素一致。

### 接口与本地验证

在 Mac mini 上使用现有应用凭据调用真实飞书 API：创建未发送卡片、流式期间插入折叠面板、更新嵌套 Markdown、batch 对象更新、删除面板、关闭流式均返回成功。新版运行态和完成态 JSON 也获服务端接受，严格离线 schema 校验通过。这些验证未向群发消息，也不等价于客户端视觉验收。

集成检查已通过全量单测（456 个文件，4,069 项通过、23 项跳过）、三个子项目类型检查和生产构建、生产依赖审计、Agent Runner 自检、两个上游失败 smoke 场景，以及九项移动浏览器交互测试。部署前独立审阅另补查续卡 ACK 不确定时的终态竞态，以及降级卡片的恢复正文投影，并以专项回归验证。

部署和真实群聊验收结果另行记录；在完成之前不将上述本地检查标为生产验收通过。

### 指定群的回复模式

目标群与其他会话共用 Home，因此新增可空的挂载级 `interaction_mode_override`，空值继承工作区默认。`PATCH /api/workspaces/:jid/channel-mounts/:channelJid` 在 owner 权限与运行中任务停止完成后修改该字段，GET 返回覆盖值与实际生效模式。

运行时按可信来源选择模式，混合来源按连续同模式前缀分批；热进程拒绝不同模式输入，定时任务保留冻结模式。切换时只重置对应 SDK 恢复标识并重建历史上下文，保留业务历史、群绑定及其他会话。schema 75 持久化挂载覆盖与 SDK 会话模式身份，重启保持设置。

此设计使指定群采用 Assistant 流式卡片，而 Home 的工作区默认和其他来源继续采用原模式。
