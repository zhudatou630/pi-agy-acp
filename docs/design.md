# pi-agy-acp 设计文档

本文记录设计决定和实现状态（2026-11-22）。调研过程见 [research/](research/README.md)，评审记录见 [review-2026-11-22.md](review-2026-11-22.md)。

目标：做一个 pi package，把官方 `agy acp`（协议形状实测于 1.5.14，冒烟测试通过于 1.5.17）接成 pi 的 provider，重点是在 pi-web 里用起来舒服。
依据：[调研汇总](research/README.md)、[agy 实测](research/agy-acp-handshake.md)。

## 0. 关键决定

| # | 决定 | 结论 | 代价 / 备选 |
|---|---|---|---|
| D1 | agy 执行的工具在 pi-web 里怎么显示 | **只读镜像工具**：provider 发出 `agy_bash` / `agy_edit` / `agy_write` / `agy_read` / `agy_tool` 这几种 toolCall，对应的 pi 工具只等待 ACP 的结果，从不重做操作。这样 pi-web 能显示原生命令卡和并排 diff | pi 的历史里会留下合成的 toolCall 和 toolResult；一个 ACP turn 会被拆成多条 pi assistant 消息。备选是写进正文或 thinking，实现简单，但显示效果差 |
| D2 | 进程模型 | **每个 pi 进程（pi-web server 或 TUI）共用一个 `agy acp`**，多个会话复用这个进程；空闲 30 分钟后退出（和 T3 Code 对 agy 的取值一致；常驻约 230 MB，重启后的第一个请求多等约 2.5 s 预热）。模型是按 ACP 会话设置的，所以共用一个进程也能同时跑多个模型。实测：同一个进程里，会话 A 用 flash、会话 B 用 claude-sonnet，同时各跑一个 `sleep 6` 工具，两个都在约 10.5 s 内完成，执行时间是重叠的 | 进程崩溃会影响所有会话（之后会自动 resume）。备选：`extraArgs: ["--process-per-session"]`，由 agy 自己按会话拆分 worker 进程 |
| D3 | 权限 | **完全放行**（v0.3 改）：自动回复 `allow_once`，没有审批模式，也没有开关；agy 主动提问时照常弹窗让用户回答 | 和 pi、T3 的 Full access 一致 |
| D4 | 发给 agy 的内容 | **只发用户输入和图片**，外加第 4 节列出的几类带标记的说明。不发 pi 的 system prompt，也不用 `systemPrompt.append` | agy 的约束由用户写在 agy 自己的规则文件里：项目级的 `AGENTS.md`/`GEMINI.md`/`.agents/rules/`，全局的在 `~/.gemini/` 下 |
| D5 | fork、分支不一致或会话丢失时怎么接上 | 新建 ACP 会话，把**有界的历史转录**（6 万字符，带明确标记）放在第一条 prompt 前面。对话优先，工具只留“做了什么、结果如何”的一行摘要 | agy 原生的上下文（之前读过的文件等）不会带过去；读文件、搜索和工具输出的细节靠 agy 自己重读。备选：不 replay，从空白开始 |
| D6 | 命名 | provider id 定为 **`antigravity`**，模型 id 用 agy 的基础模型 value（如 `antigravity/gemini-4-neon`），思考档位走 pi 的 thinking level。管理命令用较短的 `/agy` | 使用 `enabledModels` 时需要把这些模型加进去 |
| D7 | steering | 用户在运行中发消息时，**立即**作为新的 `session/prompt` 发给 agy（原生 steer），pi 这边在下一个边界插入这条用户消息 | 实现比“等 turn 结束”复杂一档；如果出问题可以退回到只在工具边界投递 |

## 1. 架构

```
pi-web Node 进程（多个 AgentSession）
 ├─ 扩展实例 × N（每个会话加载一次 factory）
 │    ├─ provider "antigravity"  streamSimple：pi 上下文 → ACP prompt → pi 事件流
 │    ├─ 镜像工具 agy_*     execute：等待 ACP 工具终态 → 结果 + diff
 │    ├─ 命令 /agy（管理用）
 │    └─ 事件：session_start 等（取 ctx）、input（steer）、context（剔除唤醒消息）、
 │           session_before_compact（压缩）、session_shutdown
 └─ globalThis[Symbol.for("pi-agy-acp")]  共享 Runtime（跨扩展实例只有一份）
      ├─ instances    活着的扩展实例，请求按 pi session id 找到自己的那个（见 3.1）
      ├─ AgyProcess   懒启动 `agy acp`，独立进程组，崩溃后标记重启
      ├─ AcpConnection  NDJSON JSON-RPC，双向请求，pending 在退出时全部 reject
      ├─ SessionHub   acpSessionId → 事件队列、当前 turn、工具状态表、配置缓存
      ├─ BindingStore ~/.pi/agent/pi-agy-acp/bindings/<piSessionId>.json
      ├─ Catalog      ~/.pi/agent/pi-agy-acp/catalog.json（模型、档位、slash 命令、版本）
      └─ DebugLog     ACP_DEBUG 抓包
```

源码布局（TypeScript，pi 通过 jiti 直接加载，不需要构建步骤）：

```
src/index.ts        入口：注册 provider、工具、命令、事件
src/acp.ts          JSON-RPC over stdio + 进程生命周期
src/runtime.ts      共享 Runtime：进程、ACP 会话表、收发和权限应答、模型目录
src/turn.ts         一个 turn 的事件队列、阶段，以及“agy 自己的工作何时算结束”的判定
src/provider.ts     streamSimple
src/mirror.ts       ACP tool_call → pi toolCall 参数、结果和 diff
src/bindings.ts     映射持久化 + 锚点匹配
src/catalog.ts      模型目录缓存 → pi 模型定义
src/replay.ts       pi 历史 → 有界文本转录
src/debug.ts        抓包与脱敏
test/fake-agent.ts  可编排的假 ACP agent
test/*.test.ts      node --test（Node 24 原生剥离类型）
```

## 2. 一轮对话的时序

```mermaid
sequenceDiagram
  participant W as pi-web / pi agent loop
  participant P as provider streamSimple
  participant R as Runtime / SessionHub
  participant A as agy acp
  W->>P: streamSimple(context, options)
  P->>R: 按 pi session id 找实例 → binding → 计算新输入
  R->>A: (懒启动/resume/set_config_option) session/prompt
  A-->>R: thought / text chunk
  R-->>P: 事件队列
  P-->>W: thinking_* / text_*
  A-->>R: tool_call (kind=execute)
  P-->>W: toolcall agy_bash{command}，done(toolUse)
  W->>R: 镜像工具 execute(toolCallId) 等待终态
  A->>R: request_permission
  R-->>A: allow_once（自动放行，见 3.8）
  A-->>R: tool_call_update completed
  R-->>W: 镜像返回 {content: 输出, details.patch}
  W->>P: streamSimple(…, toolResult)（续接：不向 agy 发送任何内容）
  A-->>R: text chunk… session/prompt 结果 end_turn + usage
  P-->>W: text_*，done(stop) + usage
```

## 3. 逐条功能设计

### 3.1 会话映射、恢复和 fork

**取得会话身份。** 每个 pi 会话有自己的扩展实例，实例从 `session_start`、`turn_start` 等事件拿到 ctx，也就知道真实的 pi session id、cwd 和 `ctx.ui`。活着的实例登记在共享 Runtime 的 `instances` 里。

provider 不能假定“注册它的那个实例”就是发请求的会话：provider 属于 ModelRuntime，而 pi-web 的子代理和父会话共用一个 ModelRuntime，后加载的实例会顶掉先注册的。所以每个请求按 `options.sessionId` 找实例：

1. 注册 provider 的实例匹配（id 相同，或者它是 pi-web 的 side chat、`header.piWebSide.parentSessionId` 等于这个 id）就用它。side chat 被 pi-web 有意设成父会话的 id 当缓存键，但它有自己的实例和 binding，不会和父会话混用 ACP 会话。
2. 否则在 `instances` 里找 id 完全相同的实例。
3. 都找不到就是维护类请求。

实例空闲（`ctx.isIdle()`）时到来的请求也算维护类：pi-web 的自动命名会拿会话的 stream 函数和 session id 另起一个临时 Agent，它不属于会话的 agent run。

维护类请求（压缩摘要、自动命名等）走一次性的临时 ACP 会话：只要文字，权限一律拒绝，用完就 `session/close`；stopReason 的映射和正常对话相同，所以被配额拒绝或被 token 上限截断的摘要不会被保存。`disableContinuation` 的缓存预热请求直接返回空结果，不发给 agy；我们本来也不声明 promptCache。

**持久化。** 每个 pi 会话一个旁路文件：`~/.pi/agent/pi-agy-acp/bindings/<piSessionId>.json`。

```jsonc
{ "v": 1, "piSessionId": "…", "bindings": [ {
  "acpSessionId": "…", "cwd": "…", "createdAt": 0, "lastActive": 0,
  // 本 ACP 会话产出的 pi assistant 消息（保留最近 200 条）；error / aborted 的标 discardable
  "produced": [ {"id": "agy:<acp8>:<随机>", "discardable": false}, … ],
  "failedKey": "<sha256 前 16 位>"         // 已到达 agy 但失败的 prompt：pi 自动重试时不重发
} ] }
```

steer 去重用的“已直接发给 agy 的输入”只放在内存里的 turn 上，不落盘。每个 pi 会话最多保留 5 个 binding，对应 `/tree` 的不同分支。文件写入用 tmp 文件加 rename；超过 60 天的文件在启动时清理。不用 `pi.appendEntry`，理由是：fork 会把 entry 复制到新会话，而 provider 拿不到可写的 session。

**锚点匹配（替代整段前缀 hash）。** provider 产出的每条 assistant 消息都设置 `responseId = "agy:<acp8>:<seq>"`。每次请求时：

1. 在 context 里找最后一条 `responseId` 以 `agy:` 开头的 assistant 消息，把它当作锚点。
2. 在本会话的各个 binding 里找包含这个锚点的那一个。如果锚点之后、本 binding 还产出过别的消息，那些消息必须都是 error 或 aborted 类型（pi 不会把这类消息重放进 context），否则视为分支不一致。
3. 锚点之后的消息就是“新输入”：
   - 跳过本 binding 发起的镜像 toolResult。
   - user 消息转成 ACP 内容块。
   - 其他模型的 assistant 消息转成简短的文字说明，例如“〔中途由 claude-opus 回答：…〕”，正文最多 4000 字符，它的工具调用和结果按下面 replay 的规则合成一行摘要。这样用户中途换成 Claude 回答一轮，再切回 agy 时，agy 也能知道发生了什么。这些说明合计不超过 replay 的 6 万字符上限，优先保留最新的，更早的部分换成一句省略提示。
   - 已经在 `delivered` 里的用户输入不再重复发送。

这套规则覆盖的情况：

- pi 压缩：压缩会保留最近的消息，锚点还在，ACP 会话继续用。pi 的压缩只缩短 pi 的历史，agy 的上下文由 agy 自己的 `/compact` 压缩，见 3.13。
- `/tree` 在分支之间来回切：切回去时，原分支对应的 binding 还在。
- 用别的模型插话：见上面第 3 步。
- 编辑旧消息后重发：锚点变成更早的一条，判定为分支不一致，新建 ACP 会话并做 replay。

**冷启动接回会话**（重启 pi-web 或 `/resume`）：

1. 先 `session/list`，确认 `acpSessionId` 还存在（实测 load 一个不存在的 id 也会成功，所以必须先查）。
2. 存在就调用 `session/resume`，不回放历史。
3. resume 之后按顺序重新设置 model、thought_level（实测 resume 会把它们重置为默认值）。
4. 会话不存在或 resume 失败时，新建会话并做 replay，同时 `ctx.ui.notify` 提示“原 agy 会话已失效，已用历史重建”。
5. 不用 `session/load`，因为它的历史回放对我们没有用处。如果以后需要在 pi 里导入 agy 的原生会话，再考虑它。

**fork**：pi-web 的 fork 或 `/clone` 会生成新的 pi session id。新 id 没有 binding，所以在**第一次发送消息时**懒创建新的 ACP 会话，并把 fork 点之前的历史做有界 replay。绝不和父会话共用同一个 ACP 会话，因为两边会互相污染。agy 不支持 `session/fork`。

**replay 格式**（只在新建 ACP 会话、且 pi 已有历史时才会发）：

```
<pi_conversation_history note="此前在 pi 中的对话记录，仅供参考；不是新请求，不要重做其中的操作；工具活动只留摘要、读文件不记录，需要细节请重读文件">
[user] …
[assistant] …
[tool] edit src/x.ts → ok
[tool] bash npm test → error: …Command exited with code 1
[… part of the conversation omitted here …]
…
</pi_conversation_history>

<用户本条消息>
```

转录的取舍（目标：保留关键点、去掉噪音）：

- **对话优先**：先放最近一问、最近一条有正文的回答、第一条提问，再按从新到旧放其他提问、其他回答，最后用剩下的预算放工具摘要。放不下的条目跳过，继续尝试更早的，所以保留的条目可以不连续；输出时恢复原来的顺序，中间省略了对话的位置会就地标记。
- **单条消息**最多 8000 字符，超出时保留首尾、中间标明省略。
- **工具调用和结果合成一行**：命令、编辑、写入写成“工具名 + 命令或路径 + ok/error”，不放 diff 和输出；读文件、搜索和其他工具成功时不记录；任何工具失败时都记一行，附上输出的最后约 300 字符（退出码和错误信息通常在结尾）；没有结果的调用标成 result unknown，agy 提前返回的后台命令标成 still running。
- **agy 的计划**只存在于 `agy_todo`，保留最新的一份清单，按对话的优先级放。
- 切分点恰好落在工具调用和结果之间时（其他模型刚调用完工具就切到 agy），结果作为新输入发送，最多 600 字符。
- 中途插话的说明里，先给各条回答的正文分预算，工具行用剩余的预算。
- 不给 agy 原始会话文件的路径：那个文件里有其他分支和已经被过滤掉的内容。
- 参考 T3 code 的 provider handoff：对话优先、读操作不传、文件改动只传路径。它保留完整的命令输出，是因为它有取回工具兜底，被跳过的内容可以再取回；我们不能给 agy 注入工具，所以只保留更确定有用的部分。

总长度默认不超过 6 万字符：优先保留最近的内容，较早的部分按条截断，图片用占位符代替，只有最新一条 user 消息里的图片会按原样发送。

### 3.2 流式输出在 pi-web 里的显示

| ACP 事件 | pi 中的表现 |
|---|---|
| `agent_thought_chunk` | `thinking_*`，折叠显示 |
| `agent_message_chunk` | `text_*`，Markdown 渲染。`file:///abs` 链接原样保留 |
| `tool_call`（第一次出现某个 id） | 结束当前 assistant 消息，生成镜像 toolCall，`done(toolUse)`。连续到达、中间没有文字的多个 tool_call，在 **150 ms 窗口**内合并进同一条消息，pi 会并行执行这些镜像，对应的卡片同时显示为“运行中” |
| `tool_call_update` | 直接由 Runtime 合并进工具状态表（**不经过** streamSimple，避免死锁），镜像 execute 通过 `onUpdate` 刷新状态，收到终态时 resolve |
| `plan` | 镜像卡 `agy_todo`，结果是 Markdown 勾选清单；同一个 turn 内内容没变就不重复出卡（实测还没见过 agy 发这个事件） |
| `session_info_update.title` | 如果 pi 会话还没有名字，用 `pi.setSessionName` 设置（只设置一次） |
| `usage_update` | 记下 `used` 和 `size`，用于用量（见 3.12）和该模型的 contextWindow |
| `available_commands_update` | 更新 slash 命令（见 3.7） |
| `current_mode_update` / `config_option_update` | 更新配置缓存 |

**镜像工具的形状**（为了匹配 pi-web 现有渲染器的约定）：

| agy kind / name | pi toolName | arguments（pi-web 的显示） | 结果 |
|---|---|---|---|
| execute（run_command） | `agy_bash` | `{command}`，显示为命令卡，可复制 | 去掉 "Created At…Command output:" 前缀后的输出；`exit_code≠0` 或 failed 时 `isError` |
| edit，同时有 oldText 和 newText（edit_file） | `agy_edit` | `{path, oldText, newText}` | `details.patch` 为统一 diff，pi-web 显示为并排 diff |
| edit，只有 newText（write_file） | `agy_write` | `{path, content}`，显示写入的内容 | `details.patch`（`/dev/null` → 新文件） |
| read | `agy_read` | `{path}`，可以打开文件 | 截断到 2 万字符 |
| search / fetch / think / other / MCP | `agy_tool` | `{title, kind, ...rawInput 里的简单字段}` | content 里的文本 |
| plan | `agy_todo` | `{entries}` | 勾选清单 |

补充说明：

- **diff 行号**：agy 给的是片段，不是整个文件。工具完成后，读一次当前文件内容（只读 1 MiB 以内的普通文件，免得在 pi 的事件循环上读大文件），定位 newText 的位置，算出 `@@` 的行号；定位不到时就用片段 diff，并在 details 里标注“行号未知”，不伪造行号（T3 的做法）。diff 由一个很小的内置函数生成，没有运行时依赖。
- **工具 schema**：全部是宽松的 object，镜像不使用参数，只按 toolCallId 查找状态。
- **toolCallId**：沿用 ACP 的 id；内部状态表的键是 `(acpSessionId, toolCallId)`。
- **对模型隐藏**：用 `prepareLoadout` 返回 `hiddenDeclarations`，让镜像工具仍然可以执行，但不出现在任何模型的工具声明里，所以 Claude 等其他模型看不到它们。实现时第一项测试就要验证这一点；如果不可行，退回到“只在当前模型属于 agy 时才激活这些工具”。
- **镜像的结束条件**：
  - 工具到达终态，正常返回。
  - daemon 或定时任务（`IsDaemon: true`、schedule）在 agy 结束这一轮时还在运行：返回“Still running in the background”，不标成成功。
  - 进程退出时返回错误。
  - pi 中止时发送 `session/cancel`，返回 aborted。
- **后台命令（v0.4）**：agy 的 `run_command` 超过 `WaitMsBeforeAsync` 后会转到后台，prompt 先以 `end_turn` 返回；命令跑完后，agy 会**不经 prompt 主动汇报**，以若干 chunk 加 `usage_update` 结束（实测见 `docs/research/agy-acp-handshake.md`）。处理方式和 pi 自己的 `bash` 一致：
  - **非 daemon 命令占住回复**：prompt 返回时如果还有这类命令在跑，turn 不结束，镜像卡片一直显示运行中。命令结束、agy 的汇报流进同一条回复。agy 常在命令结束后自己继续多步工作，步与步之间可能静默生成好几分钟，所以不按静默判断结束：agy 每次模型调用都以 `usage_update` 收尾，紧接着发出这次调用的工具调用（handshake §9）；`usage_update` 之后 2 秒内什么都没来、也没有在跑的工具，才结束回复。命令结束前 agy 已收尾的步（例如重跑命令后说"正在重跑"）不算数：命令一结束就重新等 agy 对它开口。兜底：agy 静默 120 秒也结束；命令结束后 20 秒内 agy 没开口也结束；agy 可能漏发命令的终态，所以命令看起来一直在跑、但连续 30 分钟没有任何事件时，也结束回复，卡片标为仍在后台运行，不发 cancel（命令之后真结束时，agy 的汇报会照常开新回复；T3 Code 同样用 30 分钟）。期间按停止会发 `session/cancel`（agy 会终止后台命令），并立即结束回复。
  - **daemon 和定时任务不占住回复**。之后 agy 如果主动开口，而 pi 里没有进行中的回复，插件用一条 `agy-wake` 自定义消息触发一轮新回复，把 agy 的话流式显示出来，不需要等用户发下一条消息。这条消息通过 pi 的 `context` 钩子从所有模型请求里剔除（按 customType 判断，不按文字）。pi 正忙时以 follow-up 排队。
  - 用户按了停止之后，agy 再说的话不会自动开新回复，再来的权限请求一律拒绝，直到用户下一次发消息。
  - 在 agy 主动汇报期间新启动的 daemon，也不占住回复；agy 主动提问时，回复会等用户回答，不会因为静默而结束。

### 3.3 模型和思考档位

- **来源**：`configOptions`，`model` 取它的 select 选项；`thought_level` 按模型逐个探测（实测见 handshake §2）。配置项先按 id 找，找不到再按 category 找，设置时用 agy 公布的 id；分组的选项会展开。
- **探测**：第一次真正启动进程之后（或 agy 版本变化、超过 24 小时、执行 `/agy models refresh` 时），在后台开一个临时会话，依次对每个模型调用 `set_config_option`，读出它的 thought_level 选项，然后 close 这个会话。这一步只走配置 RPC，不消耗额度。
- **缓存**：结果写进 `catalog.json`，内容是 `{agyVersion, fetchedAt, tier, models:[{id,name,levels[],contextWindow}], commands:[…]}`。
- **离线启动**：factory 同步读取 catalog 并注册 provider，**factory 不会拉起 agy**。没有缓存时，用今天实测的 9 个模型作为内置种子。目录更新后重新 `registerProvider`；pi-web 的模型列表最多 60 秒后刷新。
- **映射到 pi**：
  - 有 thought_level 的模型：`reasoning: true`，`thinkingLevelMap = {off:null, minimal:null, low:"low", medium:"medium", high:"high", xhigh: 支持时为 "xhigh" 否则 null, max:null}`。
  - 没有 thought_level 的模型：`reasoning: false`。
  - pi 选中某个档位后，`options.reasoning` 会给出 pi 的档位值，provider 用 `set_config_option(thought_level)` 设置；值和缓存一致时不重复发送。
  - 如果 `off: null` 没法排除 off 档，就把 off 映射到 low，并在 README 里说明。
- **其他字段**：`input: ["text","image"]`；`contextWindow` 用观察到的 `usage_update.size`，默认 1048576；`maxTokens` 设为 65536（仅供 pi 计算用）；`cost` 取 pi 内置模型数据里同 id 的 Google / Anthropic 模型的 API 标价（随 pi 版本更新，查不到为 0），只是估算，不是订阅的实际扣费；用户在 `models.json` 的 `modelOverrides` 里填了价格时以用户的为准，按 3.12 计算费用。
- **auth**：用 `createProvider` 写原生 Provider，`auth.apiKey.resolve` 在找到 agy 可执行文件时返回 `{auth:{}, source:"Antigravity CLI"}`。不需要伪造 key，pi 的模型列表也会把它当作“已配置”。

### 3.4 图片

- 只取锚点之后那些 user 消息里的 `ImageContent`，按顺序转成 `{type:"image", mimeType, data}`。
- 前提是握手时 `promptCapabilities.image === true`，且 MIME 是 png、jpeg、webp 或 gif。不满足时换成文字占位“〔图片未发送：格式不支持〕”。
- 单张超过 10 MiB 的也换成占位。pi-web 和 pi SDK 已经限过尺寸。
- replay 里的历史图片只保留占位，不重新发送。

### 3.5 取消

- pi 的 `options.signal`（streamSimple）或镜像 execute 收到的 signal 被中止时，发送 `session/cancel` 通知。
- 然后最多等 10 秒，等 prompt 返回（通常 stopReason 是 `cancelled`，也可能是 end_turn）。期间新到的事件丢弃。
- 结束时发 `error(aborted)`。正在等待的权限请求一律回 `{outcome:"cancelled"}`。
- 10 秒内没有收尾：把这个 ACP 会话标记为不可信，下一轮先 `session/close` 再 resume，不在这个会话上继续发送内容。

### 3.6 Steering（运行中继续发消息）

实测 agy 原生支持：同一会话再发一次 prompt，旧 prompt 会立刻 end_turn，生成过程无缝接上。

1. 用户在 pi-web 里发送 steer 时，`input` 事件（`streamingBehavior === "steer"`）会带着 ctx 立即触发。如果这个会话正有一个 ACP turn 在跑，**马上**把内容发给 agy（`session/prompt`，图片也一起发），并把内容的 hash 记进 `delivered`。
2. provider 在当前位置结束这条 assistant 消息（`done(stop)`）。pi 在 turn 边界插入这条 steer 用户消息，然后再次调用 streamSimple。provider 发现这条新输入已经发送过，就**不再发送**，直接接着消费同一个 ACP 会话的事件流。这样 pi 历史里的顺序是正确的：`[assistant 前半段] [你的 steer] [assistant 后半段]`。
3. 旧 prompt 提前返回的 end_turn 只结束它自己那个 RPC，不算作这一轮结束；这一轮的结束以最新那个 prompt 的结果为准。
4. 竞态兜底：如果 pi 刚好已经结束了这次 run，随后用 steer 开了一个新 run，streamSimple 的逻辑同样成立（已发送的内容不重发，继续读事件流；已经缓存的事件照常吐出）。
5. follow-up（排队，不打断）：不做特殊处理，pi 会在这一轮结束后把它当作新输入交给 provider，provider 正常发送。

### 3.7 agy 的 slash 命令（v0.3 改：不注册）

定位：在 pi 里**使用 Antigravity 的模型**，而不是在 pi 里套一个 Antigravity 客户端。所以不往 pi 的命令面板里注册 agy 的命令，也不提供 `/agy mode`。

- pi 不认识的 `/xxx` 会原样作为文本发给 provider。所以在 agy 模型下直接输入 `/goal …`，agy 照样能收到并展开（有 e2e 测试）。和 pi 自己的命令或 prompt 模板重名的（如 `/compact`）由 pi 处理。
- agy 的 skills 和规则由 agy 自己按需加载，不需要我们转发。
- 管理命令只保留 `/agy`：

| 子命令 | 作用 |
|---|---|
| `status` | 版本、tier、进程 pid、当前绑定的会话 |
| `models refresh` | 重新探测模型目录 |
| `login` | 见 3.10 |
| `new` | 放弃当前 ACP 会话，下次发送时新建 |
| `compact` | 只让 agy 压缩它自己的上下文（见 3.13） |
| `debug on\|off` | 开关抓包 |
| `restart` | 杀掉并重启 agy 进程 |

不带参数的 `/agy` 会弹出子命令列表（pi-web 没有参数补全）。

### 3.8 权限

**完全放行，和 pi、T3 的默认 Full access 一致（D3）。没有审批模式，也没有开关。**

- 收到 `session/request_permission` 时，直接回复 agy 给出的 `allow_once`（没有这一项时用 `allow_always`）。工具卡上不额外标注。
- 维护类请求（比如压缩时开的临时会话）回 `reject_once`，确保这类请求不会执行任何工具。
- 没有使用 `--dangerously-skip-permissions`：效果相同，但这样能在抓包里看到每一次放行。
- agy 主动**提问**（`interaction_*`，让用户在几个选项里挑一个）不算审批，仍然弹出 `select` 让用户回答，10 分钟内不选就算取消。
- **只读会话只靠一句话约束。** pi-web 的只读预设、explore / plan 子代理靠 pi 的工具清单生效，而工具清单不发给 agy。当前 pi 会话里没有激活任何写类内置工具（`bash`、`powershell`、`edit`、`write`，和 pi-web 的判断相同）时，每个新 prompt 前加一行 `[pi: read-only session. …]`。这只是建议：agy 在 default 模式下写工作区文件不请求权限，没有第二道闸。pi-web 的 side chat 自带一段边界说明，会作为用户文本到达 agy，不需要额外处理。

### 3.9 进程管理

- **懒启动**：factory 和模型列表都不会启动 agy；第一次真正的请求或 `/agy` 子命令才会。
- **启动参数**：`spawn(agyPath, ["acp"], {cwd: homedir, detached: true, stdio: pipe})`。
  - `detached: true` 让 agy 拥有独立的进程组，pgid 等于它的 pid。
  - 环境变量继承当前进程，但去掉 `PI_*`（不把 pi 的会话信息泄露给 agy 运行的命令）和 `NODE_OPTIONS`（pi-web 的 proxy bootstrap 不该注入到 agy 的 node 子进程里）；代理变量保留。
  - agyPath 的查找顺序：配置项 → `PI_AGY_BIN` → PATH 里的 `agy` → `~/.local/bin/agy`。
- **复用**：整个 pi 进程共用一个 agy 进程（挂在 `globalThis` 上），多个会话靠 sessionId 复用它。`initialize` 只做一次，结果缓存下来。model、thought_level 和 mode 都是**按 ACP 会话**设置的，所以不同的 pi 会话可以同时用不同的模型并行工作（已实测，见 D2）。
- **崩溃**：进程 `exit` 时，所有 pending RPC 都 reject；正在进行的 turn 结束为 `error`，提示“agy 进程退出（code/signal），下次发送会自动重启并接回会话”；所有 binding 标记为需要 resume。**不自动重发**那条 prompt，因为它可能已经产生了副作用。下一次请求时再重新拉起进程。
- **卡死保护**：一个 turn 在 10 分钟内没有任何事件，且没有正在进行的工具或待处理的权限请求时，判定为卡死：发 cancel，并以 error 结束。静默时长用单调时钟（`performance.now()`）计算：在 Linux 上主机休眠和手动调整系统时间都不算静默（agy 也在睡），pi 自己的事件循环被阻塞则照常计入；后台命令 30 分钟的上限同样如此。
- **版本变化**：agy 会自己更新。握手报告的版本和上次运行记下的不同时，在下一次对话里提示一次，提醒协议行为可能有变。
- **空闲退出**：没有活动 turn（已判定 broken 的会话不算，agy 可能永远不回它的 prompt）、超过 30 分钟既没有请求也没有 agy 的 `session/update` 时（agy 主动工作期间不会被回收），先 `session/close` 关闭所有会话，再结束进程。
- **退出清理**：
  - 正常路径：`session_shutdown`（最后一个实例退出时）→ 关闭会话 → 关闭 stdin → 对进程组发 `SIGTERM`（`kill(-pgid)`）→ 2 秒后还在就 `SIGKILL`。
  - 兜底：在 `process.on("exit")` 里同步执行 `kill(-pgid, SIGTERM)`。
  - 如果 pi 被 SIGKILL：stdin 的管道会断开，实测 agy 会因此自己退出。
- **不碰别人的进程**：只向自己拉起的那个 pgid 发信号，不用 `pkill`，不扫描进程名。`~/.antigravity-hub-server` 是另一个独立的进程树，实测 agy acp 不会连接它。

### 3.10 未登录和错误提示

- **发现未登录**：`session/new`、`list` 或 `resume` 返回 `-32000`，或者 `-32603` 且错误信息以 "No browser is available" 开头。这时这一轮以 error 结束，提示：
  > Antigravity 未登录。运行 `/agy login` 按提示完成 Google 登录；或在终端执行 `agy` 登录后重试。
  
  同时调用 `ctx.ui.notify(..., "error")`。错误文案会避开 pi 自动重试会匹配的那些字样（实现时对照 pi-ai 的 retry 规则确认），防止重复调用。
- **`/agy login`**：
  1. 运行 `agy acp --login`，环境里去掉 `DISPLAY` 和 `WAYLAND_DISPLAY`，让它打印登录链接，而不是尝试打开本地浏览器。
  2. 从输出里提取 Google 授权链接，用 `ctx.ui.input` 弹框：标题里放这个链接，用户打开、授权后把授权码粘贴回来。
  3. 把授权码写进它的 stdin，等进程退出。
  4. 重启共享进程，并用 `session/list` 验证登录是否成功。
  
  全程只使用官方的登录流程，不读取也不复制 token。输出的具体格式会在实现时用临时 HOME 实测确认，不会碰已经登录的 profile。
- **其他错误**：
  - 找不到 agy 可执行文件：提示安装方式。
  - 配额或 429（RESOURCE_EXHAUSTED、QUOTA_EXHAUSTED）：原文显示，不自动重试。agy 只在配额用尽时返回 `stopReason: refusal`（T3 Code 的结论），所以提示“配额已用完”并保留原始的 stopReason；文案避开 pi 自动重试的关键词。其他上游报错 agy 会作为正文加 `end_turn` 发出，只能从它的私有数据库识别，按约定不读，用户看到的就是报错原文。
  - 进程退出：见 3.9。
  - 未知的 JSON-RPC 错误：显示 `code` 和 `message`。

### 3.11 ACP_DEBUG 抓包

- **开启方式**：`ACP_DEBUG=1`（或者直接给一个文件路径），也可以用 `/agy debug on` 在运行时开启。
- **格式**：每帧一行 NDJSON，`{t, dir:"out"|"in"|"stderr"|"spawn"|"exit", piSessionId?, msg}`，写到 `~/.pi/agent/pi-agy-acp/logs/acp-<日期>-<pid>.ndjson`。开启时会通过 notify 显示文件路径。
- **脱敏**：图片的 base64 换成 `<image/png 12345B sha256:…>`；不记录环境变量；文件权限 0600。
- **pi 侧可见**：发送 `session/prompt` 之前，先 `await options.onPayload(params)`，所以 pi 自带的 debug-provider 等工具也能看到实际发出去的内容；每条 session/update 也会经过 `onProviderStreamEvent`。
- **核对用的辅助命令**：`npm run acp:tail` 只打印 `out` 方向的帧，方便检查“发给 agy 的内容是否干净”。

### 3.12 用量

- 在 ACP turn 的**最后一条** pi 消息上写用量，中间那些 toolUse 消息都写 0：
  - `cost` = `calculateCost(model, 计费累计)`，计费累计取 prompt 结果里的 `inputTokens` / `cachedReadTokens` / `cachedWriteTokens` / `outputTokens`，是这一轮所有内部调用之和；`outputTokens` 已含 `thoughtTokens`；价格取模型定义（含用户的 `modelOverrides`）；
  - `totalTokens` = 最后一次 `usage_update.used`，即上下文占用；
  - `input` / `cacheRead` / `cacheWrite` = 把计费累计的三项按比例缩放到 `totalTokens`（保留缓存命中比例）；`output` 保持计费值。
- 原因：pi 把单条消息的 `input + cacheRead` 当成一次请求的 prompt。若写入整轮累计，长回合会超过上下文窗口，被 pi 的静默溢出检查误判并触发压缩；写进 `totalTokens` 则会污染上下文估算（Zac #80 的教训）。代价是 token 分项不再是计费口径，费用仍是。
- 被 steer 接管的 prompt 返回的计费用量累加进本轮，和最后一个 prompt 的一起计费。以错误（含配额用尽）结束的一轮同样记下已报告的用量（取消的不记）：pi 估算上下文时跳过 error 消息，溢出检测看的是错误文案，不受影响。
- 没有 `usage_update` 的 turn（如 agy 自己的 `/compact`）不记用量：只有计费值时，pi 会把各项之和当成上下文占用。以下情况只会少算、不会多算，属于已接受的限制：agy 已结束但 pi 带着新输入另开 turn、或在后台等待期间 steer/停止时，前一个 prompt 的 usage 会被丢弃；回合中途在 pi 切换模型时，续接消息按新模型记名和计价；分档价格按整轮累计量选档（拿不到逐次调用的数）。

### 3.13 压缩

pi 的压缩只缩短 pi 自己的历史。锚点还在时 ACP 会话继续用，agy 那边的上下文一点没少，上下文占用（取自 agy 的 `usage_update`）也不会降。所以压缩分两路：

- **pi 的 `/compact` 和 pi-web 的压缩按钮**：`session_before_compact` 钩子先在当前分支的 ACP 会话里发 agy 自己的 `/compact` 并等它结束，然后 pi 照常做摘要（走临时会话）。两边都压缩，代价是两次请求。pi 的摘要留着有用：同一个会话之后切到别的模型，读的是 pi 的历史。agy 这一步失败时提示一下，pi 的压缩继续。
- **`/agy compact`**：只发 agy 的 `/compact`，pi 的历史不动，一次请求。agy 正在工作时拒绝执行（这时再发 prompt 会变成 steer）。

两路共用一段代码：用和 streamSimple 相同的锚点匹配找到当前分支的 ACP 会话，冷启动时先 resume 并重设模型，再发 `/compact`。当前模型不是 agy 时不做。

`/compact` 之后上下文占用要到下一轮回复才更新。这次调用的计费不记进 pi（没有消息承载它）。不取消 pi 的压缩，是因为扩展返回取消时 pi 会把它当成一次失败报给用户。

## 4. 发给 agy 的内容（干净性约定）

1. **会出现在 `session/prompt` 里的内容**：
   - 用户这一轮的文字和图片；
   - 中途其他模型回答的简短说明（3.1 第 3 步）；
   - 必要时的 replay 转录（3.1，有明确标签）；
   - 只读会话的一行说明（3.8）；
   - slash 命令的原文；压缩时由插件代发的 `/compact`（3.13）。

   除此以外没有别的。
2. **`session/new` 的参数**：`{cwd, mcpServers: []}`，不带 `_meta`。
3. **不会发送的**：pi 的 system prompt、工具清单、skills、AGENTS.md、时间戳、pi 内部 id。
4. **`initialize` 的参数**：`clientInfo` 如实写 `pi-agy-acp/<version>`；`fs` 和 `terminal` 都声明为 false，agy 用它自己的工具。
5. 以上全部可以通过 ACP_DEBUG 的 `out` 帧逐条核对。

## 5. 配置

用 `~/.pi/agent/pi-agy-acp/config.json`，可选，全部有默认值：

```jsonc
{ "agyPath": null, "extraArgs": [] }
```

replay 上限（6 万字符）、空闲退出（30 分钟）、卡死保护（10 分钟）、取消等待（10 秒）都是代码里的常量，没人需要调就不做成配置。turn 引擎的几个等待时长放在 Runtime 的 `timing` 上，只是为了让测试把它们调短。

`extraArgs` 留给 `--disable-telemetry`、`--sandbox`、`--process-per-session` 这类参数，默认为空。

## 6. 测试计划

**假 agent**（`test/fake-agent.ts`）：用 Node 写的 NDJSON 进程，按场景文件（JSON）编排，能做这些事：

- initialize 返回 agy 1.5.14 形状的 capabilities；
- new / list / resume / close / set_config_option，并且实现“resume 后配置重置”；
- 脚本化的 thought、text、tool_call、tool_call_update（包括 diff 和 execute 输出）、plan；
- 反向发起 request_permission；
- cancel 后把工具标成 failed，并回 `cancelled`；
- 第二个 prompt 取代第一个（steer）；
- 未登录时返回 -32000；
- 指定时刻退出（模拟崩溃）；
- 拉起一个孙子进程（用来测进程组清理）；
- 把收到的所有帧写到日志里，供断言使用。

| 层 | 覆盖 |
|---|---|
| 单元 | JSON-RPC 分帧和双向请求；ACP 事件 → pi 事件，包括 index 配对和唯一的终止事件；diff 生成；锚点匹配和 delivered 去重；replay 截断；权限选项映射 |
| 集成（provider + 假 agent） | 文本和思考流；tool → toolUse → 镜像 resolve → 续接；150 ms 内的并行合并；权限的允许、拒绝、超时、无 UI；取消；steer 不重发；进程重启后 resume 并重新设置配置；list 里没有该会话时 replay；未登录提示；崩溃不自动重发；进程组清理后不留孙子进程 |
| pi SDK 端到端 | 用 `createAgentSessionServices` 在进程内跑真实的 agent loop：验证镜像工具对模型隐藏但可以执行、toolResult 续接、fork 后新建 ACP 会话、压缩后保留 ACP 会话、responseId 能保存到下一轮 |
| 宿主行为（`test/host.test.ts`） | pi-web 的做法照搬到 SDK 上：子代理共用父会话的 ModelRuntime、自动命名的临时 Agent、只读工具集、压缩钩子、`/agy compact` |
| 实录回放（`test/fixtures/`） | 真实 agy 抓包里的一段（后台命令结束后 agy 自己读、写、跑命令）由假 agent 按原顺序重放，停顿按比例缩短 |
| 真机冒烟（手动，`npm run smoke`） | 真实的 agy，flash + low：一次带工具的对话；重启后 resume；图片；`/agy compact` 后上下文下降；取消；steer |
| pi-web 目测 | 在隔离的 pi-web 实例里截图核对：命令卡、diff、思考折叠 |

## 7. pi-web 改动建议（只列出来，不会去改）

pi-web 已经把 `<来源>_bash/read/edit/write` 这类镜像工具显示成对应的内置工具并带来源标签，`<来源>_tool` 用参数里的 `title` 和 `kind`。下面是还没对上的地方：

| 优先级 | 建议 | 不改的影响 |
|---|---|---|
| P2 | side chat 的工具守卫按原名放行 `read/grep/find/ls`，`agy_read` 等镜像卡会显示成“被拒绝”，而 agy 实际已经执行。建议按 `toolPresentation().as` 判断，或对镜像工具放行 | side chat 里用 agy 时卡片状态不对；agy 的行为不受影响 |
| P2 | 全局 Usage 页用 token 数重新计价。插件记的 token 分项是按上下文占用缩放过的（3.12），重算出来的金额和会话面板不一致。建议优先用消息里记录的费用 | 两处金额不同 |
| P2 | 渲染 `setStatus`，在 composer 旁边显示一行 agy 状态：后台任务数、tier | 状态只能通过 `/agy status` 和 notify 查看 |
| P3 | 回合活动统计（`lib/turn-activity.ts`）调用 `toolPresentation` 时带上参数，agy 的搜索和抓取才能归到“浏览 / 调研” | 它们被算成“其他工具” |
| P3 | `agy-wake` 这类“触发一轮回复的自定义消息”当作分组边界（现在只认 subagent-notification） | agy 主动汇报的回复并进上一个回合的分组 |
| P3 | 模型目录变化时通过 SSE 推送给 picker | 最多要等 60 秒 |

## 8. 合规自检清单

实现和发布前逐项打勾：

- [ ] 只调用用户机器上官方安装的 `agy` 和它公开的 `agy acp` 子命令；不下载或捆绑 `.par`，不替换、不修补 agy 的二进制和数据文件。
- [ ] 登录只走官方流程（`agy` 或 `agy acp --login`）；不读取、复制、导出或上传 `~/.gemini` 下的任何凭据或 token；不实现多账号轮换。
- [ ] `clientInfo` 如实写 `pi-agy-acp`，不冒充 zed、IDE 或其他客户端。
- [ ] 不读取或修改 agy 私有的 SQLite、对话库和 brain 目录。
- [ ] 权限走 agy 自己的 `request_permission` 流程，由客户端应答：按用户的决定完全放行（D3），只回 `allow_once`；维护类临时会话回拒绝；不改 agy 的权限配置。
- [ ] 不向 agy 注入隐藏指令：prompt 里只有第 4 节列出的内容，并且可以通过 ACP_DEBUG 核对。
- [ ] 不规避配额和限流：遇到 429 或配额错误不自动重试、不循环重试，原样告知用户；模型探测只用配置 RPC，不发 prompt。
- [ ] 只管理自己拉起的进程组；不碰 `~/.antigravity-hub-server`、`language_server` 或其他 agy 进程；退出时清理干净（有测试覆盖）。
- [ ] 不把 pi 的环境（`PI_*`）和会话信息泄露给 agy 执行的命令。
- [ ] 抓包默认关闭；开启后对图片脱敏、文件权限 0600、不记录环境变量，也不记录任何凭据。
- [ ] 不修改 agy 的遥测设置（是否加 `--disable-telemetry` 由用户通过 `extraArgs` 决定）。
- [ ] 遵守 Antigravity 的服务条款：ACP 是官方提供的客户端集成接口，正常的人机交互使用属于预期用途。**这只是判断，不是法律意见**；无人值守的批量自动化不在本扩展的设计目标之内。
- [ ] 不改动 pi-web 源码；需要 pi-web 配合的地方都放在第 7 节，单独列出。

## 9. 这一版不做的

- 把 pi 的工具或 MCP 暴露给 agy（反向桥）。
- 用 `session/load` 把 agy 的原生会话导入 pi。
- 支持 agy 的多个 `--agent`。
- TUI 专用的 renderCall/renderResult 美化：TUI 先用默认渲染，pi-web 是重点。
- 查询配额（`/usage`）。
- Windows。

## 10. 主要风险

0. **依赖宿主怎么调用 provider**：请求归属靠 `options.sessionId` 和 `ctx.isIdle()` 判断（3.1）。pi-web 改变子代理共用 ModelRuntime 的方式、side chat 的 id 约定，或者新增“借会话的 stream 函数发请求”的功能时，都要对照 `test/host.test.ts` 重新确认。
1. **镜像方案依赖 pi 的内部行为**：hiddenDeclarations 下的工具仍然能执行，这一点有源码依据，但还要靠 E2E 测试锁住；responseId 能否保存到下一轮也一样。pi 升级后可能失效，所以 E2E 测试要跟着 pi 版本一起跑。
2. **agy 1.5.x 的行为变化**：比如 steer 的语义、load 一个不存在的 id 也会成功。agy 会自己更新，版本变化时提示一次（3.9），需要时重新跑冒烟测试。
3. **压缩和维护类请求**走临时会话，结果质量取决于 agy。agy 自己有 1M 的上下文窗口，也能自动压缩，pi 的自动压缩很少会被触发；触发时和手动压缩走同一条路（3.13）。
4. **共享进程**：一个会话把进程搞崩，所有会话的当前 turn 都会失败（之后能自动 resume）。如果实际遇到，再开 `processPerSession`。

## 11. 实现状态与验证

| 项 | 状态 | 验证方式 |
|---|---|---|
| D1 镜像工具（隐藏声明但可执行） | 已实现 | e2e：工具卡片、diff；用 `transformContext` 确认镜像工具对模型不可见；pi-web 截图：命令卡、并排 diff |
| D2 共享进程、懒启动、空闲退出、进程组清理 | 已实现 | e2e：孙进程被清理；pi-web 退出后没有残留的 agy；hub 的 `language_server` 不受影响 |
| D3 完全放行 | 已实现 | e2e：命令执行时权限被自动放行 |
| 恢复：先 list 再 resume，并重新设置配置 | 已实现 | e2e；真实 agy：smoke 测试，以及 pi-web 重启后 agy 仍记得之前用过的工具 |
| 会话丢失、fork、/tree、压缩 | 已实现 | e2e（tree.test.ts / e2e.test.ts） |
| steer 即时发送 | 已实现 | e2e：只发送一次且顺序正确；真实 agy smoke |
| 取消、崩溃不自动重发、未登录提示、`/agy login` | 已实现 | e2e / auth.test.ts；登录输出格式用临时 HOME 实测过 |
| 图片 | 已实现 | 真实 agy smoke（能认出红色） |
| slash 命令 | v0.3 改为不注册，直接透传 | e2e：`/goal …` 原样到达 agy |
| ACP_DEBUG 抓包和 `npm run acp:tail` | 已实现 | smoke 抓包核对：只发送了用户输入 |
| 请求按 pi session id 找实例；会话空闲时的请求算维护类 | 已实现 | host.test.ts：子代理共用 ModelRuntime 后父子各自续接；自动命名不进聊天的 ACP 会话 |
| 只读会话的一行说明 | 已实现 | host.test.ts |
| 压缩：钩子先发 agy 的 `/compact`；`/agy compact` | 已实现 | host.test.ts；真实 agy 1.5.17：压缩后下一轮上下文占用下降，之前的内容还记得 |
| 截断或被拒的摘要不保存 | 已实现 | tree.test.ts |

与设计的偏差：

- ACP turn 中间的 toolUse 消息 usage 记为 0，只有最后一条消息带上上下文占用（避免 pi 的统计把用量重复累加）。
- 模型目录探测会在 `~` 下开一个临时会话，用完就 close；它仍然会出现在 agy 的会话列表里，每 24 小时最多一次。
