# Pi ↔ ACP 扩展调研：以 `agy acp` 为目标

快照：2026-11-22。结论来自 npm 发布包、GitHub 源码与 issue，以及只读检查旧插件遗留状态文件的结构；不是实机兼容性测试。没有运行扩展、登录、调模型或全局安装。以下把 npm 发布版与 `main` 区分；代码片段是节录，省略周边逻辑。

## 怎么找的、什么算相关

- [pi.dev/packages](https://pi.dev/packages)：`?q=acp` 与 `?q=antigravity` 返回字节相同的默认第一页。HTML 的 GET 表单字段其实是 **`name`**。读取了 [`?name=acp`](https://pi.dev/packages?name=acp)、[第 2 页](https://pi.dev/packages?name=acp&page=2)和 [`?name=antigravity`](https://pi.dev/packages?name=antigravity)、[第 2 页](https://pi.dev/packages?name=antigravity&page=2)；第 3 页被夹到第 2 页。唯一在页面脚本中发现的包 JSON 请求 `/api/packages/preview-media` 是预览媒体，不是目录搜索。过滤是服务端 HTML，匹配关键字和描述，有不少误报。
- npm：`npm view` 查精确包名与仓库，`npm search keywords:pi-package acp --searchlimit=120` 在本环境返回空，不能当作没包；进一步用 `npm search 'pi acp'`、`npm search 'pi antigravity'` 并核对 manifest、README 和入口。GitHub 用 `gh search repos` 查目标名、`pi antigravity acp`、`pi acp in:name`、`antigravity acp pi in:description` 等，再查 `R-Dson` 仓库、指纹字段、安装清单文件名；用 `gh issue list --state all` 逐仓查询并打开关键 issue 正文和评论。
- 纳入：Pi 作为 ACP **客户端**的 provider、委派/控制工具和小范围工具；另列同名、代理、反向适配器等边界结果。不用 GitHub 排名推断完整生态；以下列出这次搜索识别出的相关项，分为深读与扩展索引。Gallery 不是 npm 的全集，例如 `pi-acp-delegate` 用精确 npm/GitHub 找到，未在上述 gallery 过滤结果中出现。

## 先看工具所有权：不能只看事件类型

Pi 本地 `@earendil-works/pi-agent-core/dist/agent-loop.js:146–189`：非 `error`/`aborted` 回复之后按 **内容**找 `toolCall`；`length` 会生成失败结果而不执行。把 `stopReason` 写成 `stop` **不能**把一个真实 `toolCall` 变成只读卡片。

```js
const toolCalls = message.content.filter((c) => c.type === "toolCall");
// ...
const executedToolBatch = message.stopReason === "length"
    ? await failToolCallsFromTruncatedMessage(toolCalls, emit)
    : await executeToolCalls(currentContext, message, config, signal, emit);
```

区分三条通路：① **原生 ACP 工具活动**（只显示）；② **真正发给 Pi 的 MCP 调用**（Pi 执行一次，结果交还挂起的 ACP 请求）；③ **只读镜像工具**（Pi 确实执行镜像的 `execute()`，但它仅查/等 ACP 结果，不再执行文件/命令）。`session/request_permission` 是第四种事件，不是重新执行工具的授权；有些 provider 也用一个专用 Pi 工具把弹窗接入当前 Pi 上下文。

| 项目 / 样本 | 架构；原生 ACP 工具怎么显示 | 会话连续性 | agy 关系 / 主要代价 |
|---|---|---|---|
| `pi-acp-provider` 1.2.1 | 通用 provider；正文短通知，零 native `toolCall` | 内存；新 Pi 会话/崩溃后不续也不补历史 | 可配置 `agy acp`，未证明 agy 兼容；简单，丢上下文 |
| `pi-acp-delegate` 0.2.0 | 一个委派工具；卡片只有任务/状态/终稿 | Pi 分支 custom entry；能力门控 `session/resume` | 默认 Codex；适合委派，不是 `/model` |
| `pi-antigravity-acp-provider` 0.1.21 | provider；原生工具/plan → thinking；MCP → 真工具 | JSON sidecar + 前缀 SHA-256；resume → load → new | Zac 的独立官方 `.par`；状态扎实，默认 `yolo` |
| `@ackneal/pi-agy-bridge` 0.6.3 | provider；原生异常活动单独警告；仅 MCP 发真工具 | Pi custom checkpoint + 兼容键；load/rebuild | 独立 `.par` 或已安装 `agy acp --stdio`；图像 offload、429 |
| `pi-agy-acp` 0.2.1（fdkevin0） | provider；真 Pi 工具来自 MCP；ACP 工具更新核对权限 | 活进程按 Pi ID；消息 ID 前缀/系统摘要；改写时重建 | 直接 `agy acp`；驻留开销、长工具和多账户边界 |
| `pi-antigravity-bridge` 0.1.13（onprs） | provider；`agy_*` 镜像等终态；另有真 MCP 调用 | 分支锚点、digest、resume、可选 SQLite fork；文本回退 | 直接 `agy acp`；三模式、steer、复杂度最高 |
| `elvizlai/pi-antigravity` `697424a` | provider；`antigravity` 镜像重放完成结果，另有 MCP | 分支 marker + `session/resume`；失败回退 | 直接 `agy acp`；代码分层清楚；权限默认值得复核 |
| EstebanForge / FireSpoon / Thoth / 3d24rd0 / pipod | 同族 provider；镜像卡片或显示；真实 MCP 提交 Pi | 绑定 native ID，ACP `load` 时抑制回放；分叉则重建/重放（各版本不同） | 混合 `.par`/CLI；长工具 `bridge_poll_result`；分支差异不可混用 |
| `@timmyjl12/pi-agy-bridge` 0.1.5 | provider；模型写文本工具协议，Pi 解析并执行；没有挂起 ACP MCP 请求 | 内存池、prefix；失配新会话重放 | 直接 `agy acp`；长工具不受 MCP 超时，文本误触发风险 |
| `pi-antigravity-acp-subagent` 1.7.1 | 委派工具；任务结果/审计，不转原生调用给 Pi | 独立任务记录/恢复，不跟 Pi 聊天前缀 | 官方 standalone；默认无人值守 `yolo` |

## 1. `pi-acp-provider` — R-Dson

证据：[README](https://github.com/R-Dson/pi-acp-provider/blob/ac6b30f/README.md)、[`provider.ts`](https://github.com/R-Dson/pi-acp-provider/blob/ac6b30f/src/provider.ts)、[`index.ts`](https://github.com/R-Dson/pi-acp-provider/blob/ac6b30f/src/index.ts)、[`acp-client.ts`](https://github.com/R-Dson/pi-acp-provider/blob/ac6b30f/src/acp-client.ts)、`src/acp.ts`。npm `1.2.1` 与检出 `ac6b30f` 一致；未见 CHANGELOG 或 open/closed issues；仓库有假 Agent 测试。

**流与工具。** `pi.registerProvider(handle.provider)`；`stream` 与 `streamSimple` 用同一入口，ACP v1 手写 NDJSON。`createMessageWriter` 切换块时补全 `*_start/delta/end`。`parseSessionUpdate` 只把两种文本 chunk、两类工具更新交给 writer；`plan` 无显示（raw `onProviderStreamEvent` 仍能观察）。工具标题按 ID 关联；开始写 `⚙️ Executing […]`，终态写 `✓/✗` 加首行摘要（约 200 字符），不发 `toolcall_*`。通知成为普通助手正文，不是独立卡片；切到别的 provider 时可能连正文一起进入 Pi 上下文。

```ts
const renderTool = createToolRenderer((text) => writer.append("text", text));
// inside acp.prompt(...)
onUpdate: (update) => {
    if (update.type === "agent_message_chunk") writer.append("text", update.text);
    else if (update.type === "agent_thought_chunk") writer.append("thinking", update.text);
    else renderTool(update);
},
```

**会话。** 每 agent 一个进程、一个当前 ACP session（`ensureSession` 缓存 promise）；`session_start` reset，`session_shutdown` dispose。`/resume`、`/fork`、agent 崩溃重启后都重新 `session/new`，不存 ACP ID、无前缀指纹、无 `load/resume/fork`、不重放。每次只取最后一个 user（同一批连续 user 前面的也丢）；不传 Pi system 或工具声明，换到其他 agent 不移交历史；同 agent 换 model 则是同一 native 会话。网络 discovery 可先开一个空 session，未使用且 cwd 相同可继续用。

**功能。** `acp/<agent>` 等于初始默认模型，`acp/<agent>/<model>` 从 `configOptions` 或旧 `models` 列举。Pi `refreshModels` 存盘、离线复用、错误保留旧目录；按 `thought_level` 映射 Pi 级别（`off/none/disabled` 同义），切模型后再读选项；目录是按探测 session 的档位生成，不保证每个模型都一致。`input: ["text"]`；图片仅提示未转发。`/<agent> …` 根据 `available_commands_update` 补全；需要时切 provider 再发普通 slash prompt。`session/new` 收 `auth_required` 才用配置的 `authMethod` authenticate 一次；discovery 不调交互认证；Pi ambient auth、ACP agent 持有账号。`ACP_DEBUG=1` 把诊断和子进程 stderr 写到 stderr。无 ACP fs/terminal handler，无 turn 内 steering。

**陷阱。** 默认自动选 `allow_once`；关闭后用 `ctx.ui.select`，无 UI 拒绝，但用可重名的 option **name** 回查，弱于 delegate 的 ID 标签。中断立即发 `session/cancel`，下次等最多 5 秒；未确认不强制换 session，因此同 session 的超迟旧 chunk 仍可能串到下轮（静态推断）。`initialize/new/config` 有 deadline，主 prompt 和 `authenticate` 没有自己的总 deadline。POSIX 独立进程组 TERM→KILL，Windows 是 child kill，不能据此保证后代退出。交互启动或开 `/model` 可并行启动所有 agent（不是真正零成本 lazy）；usage 为零、context/maxTokens 固定；没有 Antigravity 的 slash、授权组件、409/429、图像/usage 适配。若只想做 ACP-native 最小 provider，借它的写流骨架，不要继承这些语义缺口。

## 2. `pi-acp-delegate` — SyJarvis

证据：[README](https://github.com/SyJarvis/pi-acp-delegate/blob/283ad5f/README.md)、[`index.ts`](https://github.com/SyJarvis/pi-acp-delegate/blob/283ad5f/index.ts)、[`acp-runner.ts`](https://github.com/SyJarvis/pi-acp-delegate/blob/283ad5f/src/acp-runner.ts)、`src/{session-binding,tool-renderer,permissions,update-collector,acp-process}.ts`。npm `0.2.0` = `283ad5f`；未见 CHANGELOG 或 open/closed issues；有 SDK 假 Agent fixture。

**不是 provider。** 主模型可执行一次 `acp_delegate({task})`；工具内部启动 ACP 子进程。只把 `agent_message_chunk` 文本拼成最终 Pi `toolResult`（50,000 字符）；最近 64 条事件存 `details`，单条约 500 字符。thought、tool start/update、plan 仅保留有限元数据，不变成主模型 `AssistantMessage` 或可执行调用；plan 的 `entries` 未投影。TUI 自定义 `renderCall/renderResult`，`onUpdate` 标 Starting/Running/Permission 等状态，不直播正文/命令 stdout。

```ts
if (value.sessionUpdate === "agent_message_chunk") {
  const text = textFromContent(value.content);
  if (text) this.#appendMessage(text);
}
// index.ts: execute() 的返回值；不是 AssistantMessage
return { content: [{ type: "text" as const, text: result.text }], details: result.details };
```

**分支与恢复。** `pi.appendEntry("pi-acp-delegate/session", …)` 保存 version/kind、ACP `sessionId`、绝对 cwd、agentKey（`source/command/args` 的 SHA-256；不含 env/账号）。`getBranch()` 从叶往前找最近记录；不匹配、无效、reset 都挡住旧记录复活。只有 `sessionCapabilities.resume` 才存，首次 open 成功即存；后续每次重启 child 后 `session/resume`，不调 `session/load`。不能 resume 或 resume 失败时明确报错，不悄悄转新会话；未声明能力的 agent 每 task 新开。Pi fork/tree 写 reset；`/acp new` 空闲时写 reset，不删除远端 thread。没有转录指纹也不需要重放：边界本来就是任务串，初次 task 必须自足；换仅由 `PI_ACP_ENV` 决定的账号/数据目录却不改变绑定身份，属于配置陷阱。

**权限/生命周期。** SDK ACP v1；动态 `ctx.ui.select` 标签含名称、ID、kind，headless、取消、stale 一律 `cancelled`；无 ACP fs/terminal 能力不等于沙箱。默认用 package-local `@agentclientprotocol/codex-acp@1.12.0`，可用 `PI_ACP_COMMAND/ARGS/ENV/LABEL` 配已登录 agy；无 Pi model/thinking discovery/cache、无图片、无 auth RPC、无当轮 steering、无 agent slash 代理。串行队列防首次重复绑定。Abort 通知 + 300ms grace，按能力 `session/close`（300ms），关闭传输，stdin EOF→TERM→KILL，shutdown 等待活动调用并 fence 迟到回调。stderr 末 8,000 字符仅进失败诊断，没独立 debug 开关。未见正常 RPC 自身的 hard timeout；直接 `child.kill()` 不保证后代都死；代码最后一阶可等待 `exit`，不是绝对 deadline。`stopReason` 在 details，不会自动把 refusal 映射成 Pi 模型错误。适合把「另一个 Agent」保留成明确任务边界。

## 3. 常见遗留状态文件分别属于哪个插件

- **`antigravity-acp-provider/sessions.json` 高置信匹配 `zacbemis/pi-antigravity-acp-provider`。** `sessions.json` 是记录数组，目录名、字段集合、可选 `expectedAssistantFingerprint` 与 [`src/acp/session-store.ts`](https://github.com/zacbemis/pi-antigravity-acp-provider/blob/8a1b0ff/src/acp/session-store.ts) 一致；[`persistBinding`](https://github.com/zacbemis/pi-antigravity-acp-provider/blob/8a1b0ff/src/runtime.ts) 写出同一结构。没有名为 `antigravity-acp-provider` 的现行 npm 包（404）；`antigravity-acp` 是 provider ID，`antigravity-acp-provider` 是数据目录。fork 继承过相同格式，因此不能仅凭这个 JSON 确认安装来源或精确版本。
- **`.pi-agy-installation.json` 更明确指向 `@ackneal/pi-agy-bridge` 系。** `0.6.3` 发布包的 `src/extension/drivers/acp/installation.ts` 使用同一文件名及 `schema/version/platform/sha256/files` inventory；同包 `registry.json` 里的 Linux x64 1.4.5 archive SHA-256 与这类遗留文件记录的一致。Zac 也批准了**同一个 Google archive**，但它写的是 `install-integrity.json`，不是这个文件名。两个 `agy_acp_server.par` 安装线索不能合并成同一插件。两类文件可能同时存在；`1.4.5` 是 Google runtime 版本，不是 npm 版本。
- **npm `pi-agy@0.6.1` 并不是它。** [shakthi-sagar 包](https://github.com/shakthi-sagar/pi-extensions/tree/main/packages/pi-agy)的 README、`index.ts`、`src/utils/http.ts`、CHANGELOG 都指向直接 OAuth + Cloud Code Assist HTTP streaming（多账户，pre-stream 429 failover）；Pi 常规工具循环，不启动 ACP，没有此 session mapping。其 [#4](https://github.com/shakthi-sagar/pi-extensions/issues/4) 报 npm undici dispatcher 与 Node 内置 `fetch` 不兼容（SDK embed 失败）；[#1](https://github.com/shakthi-sagar/pi-extensions/issues/1) 是第二账号远程认证 URL。不要把同名 GitHub `pi-agy` 项目和 npm 包归为一物。

## 4. Zac Bemis — `pi-antigravity-acp-provider`

证据：npm `0.1.21` `8a1b0ff`，`main` `6d6135d`；[README](https://github.com/zacbemis/pi-antigravity-acp-provider/blob/main/README.md)、[release notes](https://github.com/zacbemis/pi-antigravity-acp-provider/tree/main/docs/releases)（未见单独 CHANGELOG）、`extensions/index.ts`、[`runtime.ts`](https://github.com/zacbemis/pi-antigravity-acp-provider/blob/main/src/runtime.ts)、`src/{stream/context,stream/pi-events,acp/connection,acp/events,mcp/bridge}.ts`。以下 runtime 细节以检出源码为准。

**原生活动是 thinking，不是镜像。** `agent_message_chunk`→text，thought→thinking，plan→格式化 thinking；native `tool_call/tool_call_update` 按 `off/compact/full` 转 thinking（默认 compact 只显示开始）。真正的 Pi `toolCall` 来自 loopback HTTP MCP `requestPiTool` 或权限代理，**不**来自 ACP 工具活动。MCP 认证、tool schema 过滤；请求 scoped 到 active writer，按批 `done("toolUse")`，同一 ACP prompt 尚未结束；下一 Pi `stream` 从 `toolResult` 按 id/name 找回结果并 resolve 原 MCP 请求，继续 drain ACP。ACP 僵死或提前结束时不能 replay 副作用；late Pi result 会进后续新 prompt。权限也用专用内部 Pi 工具停靠后调用 `ctx.ui.select`，返回 exact option ID，缺失/失效就取消。

```ts
else if (activity.type === "plan") binding.writer.thinking(activity.text);
else if (activity.type === "tool") {
    if (this.toolActivityMode === "full") binding.writer.thinking(activity.text);
    else if (this.toolActivityMode === "compact" && !activity.isUpdate) {
        binding.writer.thinking(activity.compactText);
    }
}
// requestPiTool()（不是 consumeUpdate()）
binding.pendingTools.set(invocation.id, { invocation, resolve: (result) => { held(); resolve(result); } });
batchWriter.toolCall(invocation.id, invocation.name, invocation.arguments);
```

**checkpoint/replay。** 以 Pi `sessionId` 为持久键（临时/无 retention 路径不持久）。每条记录含上节所列字段；锁、临时文件 rename、256 条/30 天读期限。相同 cwd 尝试 `session/resume`，再按能力 `session/load`（过滤回放通知），无合用结果才 `new`。复用前比 `messageCount` 和已消费前缀 hash；逐 message 用排序 canonical JSON + SHA-256，含角色、内容、system tools delta、tool ID 等，不含 volatile timestamp/usage。`expectedAssistantFingerprint` 单独匹配已由 ACP 产生而刚写回 Pi 的 assistant，匹配才跳过；不是按角色盲跳。权限模式/工具签名/系统指令变化也影响重建；工具轮中的系统更新留到下次重建。Pi fork 拿新 ID，不共用旧 sidecar；同 ID 改写或 compaction 触发前缀检查；无 ACP `session/fork`。失配移除旧记录并 new：受信指令单独限 256 KiB，最多 32k 字符的旧对话作不受信 ACP embedded resource，有预算地裁老内容、保留活跃 tool identity 和最新请求；warm 则发 unseen delta + latest user 或 tool continuation，不重复发送已接受的图像/任务。不是完整逐轮 RPC 回放。

```ts
context.messages.length < binding.messageCount ||
messagesFingerprint(context.messages.slice(0, binding.messageCount)) !== binding.historyFingerprint
// ...另有 mode / toolFingerprint / reconstruction guard
if (!fresh && expected?.role === "assistant" &&
    binding.expectedAssistantFingerprint === messageFingerprint(expected)) unseenStart += 1;
```

**agy 适配。** 使用独立 `agy_acp_server.par`/`.exe`，不要求 `agy` CLI；`AGY_ACP_BIN` 可指定 runtime。签名 catalog、尺寸/哈希、双文件权限及启动确认；代理保留且对本机 MCP bypass。Pi `/login`、SSH OAuth relay、可选 API key；令牌归 ACP runtime，macOS keychain/file mismatch 检测；不能假定 CLI 与 `.par` 共用登录。动态模型 discovery、Pi 模型缓存和 offline seeds；按 base/effort 合并，确认 model/effort 选择后才 prompt；advertised 不代表账户可推理。最新 image 按 `promptCapabilities.image`，旧图片通常只是文字占位。模式 `default/auto-edit/yolo` 必须确认，**默认请求 `yolo`**；native 不受 Pi hooks 约束，MCP 走 Pi hooks。`/antigravity-acp setup/doctor/status/quota/update/...`；ACP `/usage` 用独立短进程（缓存 60s），普通用户 slash 做字面处理。未见通用 active-turn steer 消息；真 Pi 工具边界能续接，不等于能随时注入。doctor 有 verbose、进程/路由/错误详情；非默认全量 wire 日志。

**进程与坑。** supervisor/进程树清退，warm 默认 4 项、5 分钟 idle TTL；inactivity watchdog（普通 10m、已知 work 60m，不是无限）；cancel grace 1.5s 后断不响应连接。ACP runtime 自己还有约 180s MCP deadline，不能靠调大本地 watchdog 改掉。项目 issues：[ #1](https://github.com/zacbemis/pi-antigravity-acp-provider/issues/1) OAuth Chromium stdout 一行噪声，修复仅白名单该行；[#4](https://github.com/zacbemis/pi-antigravity-acp-provider/issues/4) helper 落盘缺执行位，OAuth 成功但 `session/new -32603`；[#6](https://github.com/zacbemis/pi-antigravity-acp-provider/issues/6) SSH relay；[#49](https://github.com/zacbemis/pi-antigravity-acp-provider/issues/49) print/RPC 下 split model+effort 无法确认（历史 issue 已关闭）；[#61](https://github.com/zacbemis/pi-antigravity-acp-provider/issues/61) 同进程 subagent 的 shutdown 泄漏；[#65](https://github.com/zacbemis/pi-antigravity-acp-provider/issues/65) 签名 manifest 落后官方发布。开放 [#80](https://github.com/zacbemis/pi-antigravity-acp-provider/issues/80)：每轮 prompt 计费累计不是最后占用；数百万错误 usage 随 Pi history 流到别的 provider，把输出预算压到 1 token。评论有 1.4.5 与 1.5.0 wire 对照，0.1.20/21 已补缓解；不要把 upstream 剩余问题当成全解决。

## 5. Ack Neal — `@ackneal/pi-agy-bridge`

证据：[仓库](https://github.com/ackneal/pi-agy-bridge)、npm `0.6.3`（包内固定 ACP 1.4.5），`main` `804f6f8`（README/registry 更新到 1.5.0）；README、`src/extension/{drivers/acp/session,drivers/acp/events,drivers/acp/permissions,drivers/cli/events,provider/turn,provider/events,session/state,session/history}.ts`；无单独 CHANGELOG，版本边界以包内容为准。

**所有权。** provider 支持两个 ACP driver：`acp`（管理官方独立发行包）和 `cli`（本机 `agy acp --stdio`），不是把 `cli` 当旧 stream-json。text/thought delta 正常映射；`tool_call/update` 按 ID 合并仅用于工具身份/警告/授权核对；未见 `plan` 到 assistant 的映射。配置尝试关闭 native workspace 工具；真 Pi `toolcall_*` 来自本机 MCP 进程经 IPC 请求 Pi，挂起同一 ACP turn，不按 update 执行。同样要区分 native 工具警告、允许的 ACP client read，以及调用 Pi 工具。

```ts
// drivers/acp/session.ts：不要把 load 的历史当本轮输出
if (!this.preparing && notification.sessionId === this.sessionId) {
  return options.onUpdate(notification);
}
// session/state.ts：有停在中途的工具不能冷恢复
if (checkpoint.hasPendingToolCalls === true) return false;
// provider/turn.ts：只有 IPC 的 MCP batch 切到 Pi 工具循环
this.options.adapter.handleBridgeToolCalls(batch.calls);
```

**会话。** Pi 分支 custom entry checkpoint，记 native `sessionId`、`messageCount`、序列化消息前缀 SHA-256、兼容键等；live `WeakMap<LiveSession, string[]>` 精确比较前缀，有 unseen assistant、兼容键不符、挂起 transport 已死就不续。能复用 active runtime 则 continue，否则匹配 checkpoint 才 resume（standalone driver 用 `session/load`，prepare 阶段隔离 replay）；fork、compaction、切 driver 或无法安全恢复时，根据新分支重建，而非在共享 native 轨迹上盲追加。重建用 chronological JSON history + `currentMessage`，旧 `toolResult` 保留元数据但剥大 body，未完成的工具链保留结果（见 [#5](https://github.com/ackneal/pi-agy-bridge/issues/5)）。

**体验与缺口。** `/login`、`/agy-bridge:driver`、`/agy-bridge:doctor`；discovery 缓存及 model/effort 确认，登录显式进行，startup/doctor 不开浏览器。运行时区分两个 driver 的 auth/capabilities；不能混用账号状态。文件/命令政策主要由 Pi 真工具和严格限制的 client read/observer 路径控制，非通用 `ctx.ui` 原生审批；未知 permission 取消/拒绝。取消 native prompt、破损 transport 和 shutdown 走 dispose；`AGY_BRIDGE_DEBUG=1` 除 stderr 还会在私有目录落诊断 JSON（代码会保存 assistant message，分享前应脱敏），CLI driver 可看 quota。ACP driver 自动装载引用图片、observer 处理 offload（增加延时/模型用量）；CLI 支持通过工具读特定产物，不自动加载引用图；没有看到对忙轮任意位置的实时 steering 保证。macOS/Linux，native Windows 不支持。开放 [#33](https://github.com/ackneal/pi-agy-bridge/issues/33) 仍需 live matrix；[#20](https://github.com/ackneal/pi-agy-bridge/issues/20) 大一些的 MCP 图片被 agy offload 为路径，`read_resource` 不一定可用，不能因此白名单普通路径；[#22](https://github.com/ackneal/pi-agy-bridge/issues/22) 是双 driver/保留 Pi 工具边界的设计动机；开放 [#46](https://github.com/ackneal/pi-agy-bridge/issues/46) 有额度也 429，作者只称**可能**是上游策略/提示差异，不是证实的限额机制。

## 6. fdkevin0 — `pi-agy-acp`（npm 同名的那个）

证据：[仓库](https://github.com/fdkevin0/pi-agy-acp)、npm `0.2.1` `df0804f`，`main` `4016234`；[CHANGELOG](https://github.com/fdkevin0/pi-agy-acp/blob/main/CHANGELOG.md)、[reference](https://github.com/fdkevin0/pi-agy-acp/blob/main/docs/reference.md)、`index.ts`、`src/{runtime,conversation,pi-stream,history,catalog,acp-process,mcp-bridge}.ts`。

**所有权。** `antigravity-acp` provider，受限 custom agent、loopback MCP，真正的 `tools/call` → `toolUse` → Pi 工具 → resolve；`agent_message_chunk`→text、thought→reasoning，ACP `tool_call/update` 记录和合并结构化身份，用于决定 ACP permission，不据此生成同名 Pi 调用；plan 不做 Pi assistant block。`answerPermission` 按当前 session、可信 host-reported ID/结构化路由元数据等匹配，仅合规的请求才允许一次，拒绝依靠 title/rawInput 猜权限；Pi 工具本身仍过 Pi hooks。长工具超过 hold 阈值会先回告知，通过 `pi_await_result` 请求结果；这是 **bridge-local** poll/relay protocol，不是重新发起真实工具。多条 relay 与文本缓冲需要准确收口。

```ts
// runtime.ts：warm 复用依赖顺序一致的 message IDs + 系统指纹
if (conv.knownIds === undefined || conv.systemHash !== digest(system)) return false;
const known = conv.knownIds;
return known.length <= messages.length && known.every((id, index) => messages[index]?.id === id);
```

**会话。** `options.sessionId` 为 in-memory conversation key；ACP ID 不是持久恢复映射，不用 load/resume；重启、fork/compact/tree 或 dirty/prefix、system 不符会 `session/new` 并重建。开头打包有界（160,000 bytes）历史与当前请求，旧图降级文字，最新图片按能力 AST；暖路径只传未见的连续 user/system，跳过本 provider 自己的 assistant 与 issued tool IDs。`knownIds` 是 ID 比对，不是每一块内容的 canonical hash；同 ID 内容被改写需另靠 Pi 导致的清理/校验，不能等同于 Zac 指纹。停靠续接另检查完整 tool results、model/effort、前缀；尾随的用户 steering 可在工具边界推迟/合并，不是 ACP 原生任意时刻 interrupt。SQLite 用于观测 `max_context_tokens`/占用 metadata，而非分叉写库恢复。

**生命周期。** 本地 `agy`、隔离 `PI_AGY_HOME`、`--process-per-session`；默认 home 可能安全复制现有 file-backed token，显式 home 不复制；认证/刷新归 agy。默认 home 清理假定独占，多个 Pi 实例共用存在竞争；`/usage` 子命令不能传 `--gemini-dir`，可能查到与隔离 session 不同账号。目录 `catalog.json` 以 binary fingerprint 做 context window 失效，动态分组 effort、image 和套餐模型；`/agy-acp status/quota/reset`，`PI_AGY_DEBUG=1` stderr，agent 也有日志。取消和 dispose 回收 worker/tenant，避免 orphan new/parked turn；区分上下文错误、quota、进程失效。

**issues。** [#43](https://github.com/fdkevin0/pi-agy-acp/issues/43) 开放：Pi 自动 refresh 会在不用 provider 时也起共享 front、开重 discovery worker；不要据 README “加载不启动”推断日常 Pi 启动不启动。[#24](https://github.com/fdkevin0/pi-agy-acp/issues/24) 旧版登录后直接 `agy acp` 正常、扩展首 prompt 挂；0.1.4 CHANGELOG 记录改 system 传递策略，不能把所有 429/hang 都判成同一原因。[#5](https://github.com/fdkevin0/pi-agy-acp/issues/5) cancel/提前关闭 generator 导致 parked turns 吃满容量；[#7](https://github.com/fdkevin0/pi-agy-acp/issues/7) parked 续接用旧 model/effort 或 relay 吞正文；[#33](https://github.com/fdkevin0/pi-agy-acp/issues/33) agy 不 poll 改发新调用使最终回答被缓冲丢掉（0.2.1 重构 liveness/relay）。0.1.4 也修了 agy 扁平 `mcp_pi_<tool>` 名字变动；别用显示标题当协议身份。

## 7. onprs — `pi-antigravity-bridge`：最贴题的镜像实现

证据：[onprs/Pi-Antigravity-Bridge](https://github.com/onprs/Pi-Antigravity-Bridge)，npm `0.1.13` = `5a13417`；[README](https://github.com/onprs/Pi-Antigravity-Bridge/blob/5a13417/README.md)、[CHANGELOG](https://github.com/onprs/Pi-Antigravity-Bridge/blob/5a13417/CHANGELOG.md)、`src/{index,session/turn-coordinator,session/checkpoint-sync,session/reconcile,tools/agy-mirror-tools,tools/agy-renderers,acp/process-manager,stream/event-mapper}.ts`；issue 列表为空，不等于没有已知问题。

**三模式。** `pi-tools` 默认（真实 host MCP），`agy-tools`（agy 执行），`hybrid`（两者）。`tool_call` 先识别 host MCP 公告，按 structured name/namespace 和 ID 去重，等真实 MCP 请求再发 Pi 真工具。native `tool_call` 分类为 `agy_read/agy_bash/…` 的非同名镜像，用原 `toolCallId` 发 `toolcall_*` 并结束 Pi slice；ACP 后台 pump 不停，`tool_call_update` **直接**合并到 mirror broker（不能等 Pi 下一次 stream 才读，否则死锁）。`executeMirrorCall` 只等 terminal status 或取早已完成结果并 `onUpdate`，携带结果/diff 给 Pi 渲染器，从不重做读写/执行。`agent_message_chunk`/thought→text/thinking；普通 `plan` 不是可执行 tool，主 pump 没专门 plan block，规划模式和 elicitation 是另一路 UI。

```ts
// turn-coordinator.ts: native ACP event → synthetic Pi call
await writer.appendToolCallStreaming({
    id: update.toolCallId, name: classified.mirrorToolName, arguments: classified.arguments,
}, writer.hasEmittedAnyDelta ? 0 : 2);
// ... short parallel batching, then finishWithToolUse(...)
// agy-mirror-tools.ts: only resolve the wait on completion
const isTerminal = payload.status === "completed" || payload.status === "failed";
// ... if a waiter exists: resolver(this.buildToolResult(state));
```

**会话/steer。** 每个 Pi 会话有 warm ledger，分支 custom 锚点跟随 Pi history（消息 count/digest，工具模式、system/工具及挂载等摘要）；精确末尾锚点 `session/resume`，中间锚点可 `VACUUM INTO` 克隆 agy SQLite、验证已知 steps 前缀 fingerprint、截断并续接。找不到锚点/schema 不合用则 fresh + 历史结构化文本；超长 replay 可分段写 checkpoint，失败回退单步预算并保留最新提问。`session/load` 主要是 `/agy sessions` 收回放并导入 Pi，而非 normal resume；不是用 ACP `session/fork` 做数据库操作。热工具边界可 cancel 前一 prompt、收敛后把 steer 以用户输入投到同一 session；`Alt+Enter` follow-up 仍等整轮。分叉时不应共享可变 trajectory；SQLite 路径最丰富但绑 agy 私有 schema/WAL，版本漂移和恢复配置失效必须有降级。

**操作面与坑。** 动态模型/effort 聚合、6h 背景刷新、图片与工具结果大图补送、`/agy status/mode/bridge/agent-mode/refresh/sessions/login/logout`；auth 由本机 agy，不搬令牌。native `session/request_permission` FIFO `ctx.ui`；还有结构化 `elicitation`，正常 headless 应保守；`default/accept-edits/plan` 是 agent mode，不是 OS sandbox（sandbox 需要独立配置）。`processPerSession` 默认开启，清理迟到的 new/resume worker、取消及跨平台树清理；status/遥测和错误输出可排查，但不要当成通用 raw wire logger。CHANGELOG 特别值得看：0.1.1 没有终态会让镜像死锁，代码在下一 thought/text 或 turn end 时隐式结算（可能把缺证据的并发工具误标成功，宜显示未确认）；0.1.7 状态缺 title、diff 丢正文、steer cancel 边界和 WAL/Windows；0.1.10 恢复模板失去禁用 native 工具策略；0.1.12 >10 KB 工具图片不可见。镜像 map 按裸 tool ID 查找，若并发 ACP sessions 可碰 ID，建议用 session/turn/tool 三元键；缺记录直接 `(completed)` 也掩盖异常。

## 8. 其他 agy 设计：选有参考价值的机制

### `elvizlai/pi-antigravity`（GitHub `697424a`，不是 npm 同名 OAuth）

[README](https://github.com/elvizlai/pi-antigravity/blob/697424a/README.md)、`index.ts`、`src/provider/{runtime,turn,state,stream}.ts`、`src/acp/{events,client}.ts`。provider 启动本机 `agy acp`；`pi` 默认/MCP 与 `agy` 两模式。native tool 已有结果后从 `AgyReplayStore` 返回，Pi 只执行显示 wrapper；不使用原生业务工具名，真 MCP tool 则由 Pi 执行、在同一 ACP prompt 内续接。ACP text/thought 转正常块，native start/progress/status→replay/卡片，未见标准 plan→assistant block。`state.ts` 通过 `antigravity-state` branch marker 验 Pi ID/cwd、在 marker 后有不可忽略条目就停，fork 新 ID 无继承；不是全文 hash。`session/resume`，讨论与剪枝/失效时走新会话 prompt（可重放可用历史）；还需考虑同一 Pi turn 内 tool wave 与下一真实用户边界。核心镜像路径：

```ts
appendToolCall(replayId, WRAPPER_TOOL_NAME, {
  tool: activity.title,
  // ... kind/locations
  input: activity.rawInput ?? {},
});
```

模型/effort 来自本地 agy（`/agy-models` 可刷新、Pi refresh provider），有 `/agy-tools`、`/agy-plan`、`/agy-reset`、`/agy-doctor`、`/agy-usage`；最新图进入 prompt 构造，查 `src/provider/prompt.ts` 的能力/转换，不把历史图还原当成保证。本机 auth，首 event 默认 60s watchdog、之后允许长任务；每 RPC deadline、EOF→TERM→KILL、session shutdown，读 stderr/doctor 和 quota；无公开 issues/CHANGELOG。launcher 用 `--dangerously-skip-permissions`，`client.ts` 会优先挑 allow_once，不是通用 fail-closed broker；原生 `/swarm` 等可工作并不意味着 steering/审批等价 Pi 原生体验。适合借鉴分层和轻量镜像，不建议照搬权限默认值。

### EstebanForge 同系：长工具与历史 load 语义

| npm 包 | 已读源码 / 区别 |
|---|---|
| [`@estebanforge/pi-antigravity-bridge` 1.13.1](https://github.com/EstebanForge/pi-extensions/tree/main/packages/pi-antigravity-bridge) | README/CHANGELOG、`src/{provider,sessions,acp/driver,acp/connection}.ts`；双引擎（现代 agy ACP / 受支持的 standalone 与 stream-json 选项）；native tool 走 wrapper replay 或受控 shadow 路径，真 Pi MCP 走 round trip。`AskAntigravity` 是辅助入口，不是 provider 字面工具回显。 |
| [`@firespoon/pi-antigravity-bridge` 1.10.12](https://github.com/FireSpoonYZ/pi-extensions/tree/main/packages/pi-antigravity-bridge) | 同源 README/CHANGELOG + `src/{provider,acp/home,acp/driver}.ts`；默认受限 custom agent、清理桥接内容、Hindsight 投影；ACP 下仍保留底层 MCP/resource/task 设施，非裸模型。 |
| [`@thoth-agents/pi-antigravity-bridge` 0.9.0](https://github.com/EremesNG/thoth-agents/tree/main/pi-packages/pi-antigravity-bridge) | 发布包 `dist/index.ts`、README、CHANGELOG、UPSTREAM-CHANGELOG；同族 vendored provider，不能把 Esteban 最新修复自动归给它。 |
| [`@3d24rd0/pi-antigravity-bridge` 1.4.1](https://github.com/3d24rd0/antigravity-bridge) | README/CHANGELOG、`src/{provider,session-ui,tool-roundtrips,acp/connection}.ts`；MCP 桥外有 background delegation/approval、独立 runtime 更新。[#31](https://github.com/3d24rd0/antigravity-bridge/issues/31) Windows 非管理员 symlink EPERM 开放；[#9](https://github.com/3d24rd0/antigravity-bridge/issues/9) 异步 handler 读旧 Pi ctx 已关闭。 |
| [`@pipod/pi-antigravity-bridge` 1.11.1](https://github.com/pi-pod/pi-antigravity-bridge) | README/CHANGELOG、`src/{display-renderers,provider,acp/connection}.ts`；Pi/pipod 双宿主、客户端负责登录、同类 MCP round trips；GitHub issues disabled。 |
| [`reedjosh/ant-bridge` `e21cfcf`](https://github.com/reedjosh/ant-bridge) | GitHub-only，README/CHANGELOG、`src/{provider,sessions,acp/driver}.ts`；Pi 工具 MCP、native action/result 由 `tool_start/done/error` presentation + wrapper 处理，`session/load` 冷续并隔离 replay；另有 skills/background/日志。 |

**共同机制而非共同保证。** 都能在 Pi 选模型、将 ACP text/thought 转块；native `tool_call/update` 归一化为 activity，wrapper 可拿已记录结果；不是把 ACP 名称直接变成 Pi 工具。`plan` 并无统一的 assistant-block 映射。真 MCP call parked，Pi 真 tool/result 接回来；长 call 早回“仍在运行”+ ID，`bridge_poll_result` 查询，时间与并发预算单算。会话存 native conversation ID，ACP load/replay 隔离；Esteban `sessions.ts` 用 `lastMessageCount` + `role:timestamp` 边界标记，不是强内容前缀 hash；分叉/改写/权限 gate 变化时可触发 bounded digest/rebuild，不能依赖该标记发现所有同 timestamp 的内容变化。最新图片走 ACP block；fallback stream-json 路径可 staging，历史图和多 user 有限制。模型/effort、权限 gate、debug、slash、auth 及 cleanup 在各自配置分支：主系有 `/agy` 诊断/切 driver、native approval/shadow gate、MCP token 校验、cancel 后 teardown、Pi session hook 回收，某些版本支持队列 fold/长工具边界，不应视为稳定的 active-turn steer 或 OS 隔离。

**项目故障证据。** Esteban [#21](https://github.com/EstebanForge/pi-extensions/issues/21) 同一 child 内每 turn 重 load 已开 session 会误结束下一 prompt，新版有 `already-open` 路径；[#24](https://github.com/EstebanForge/pi-extensions/issues/24) 连续 user 的较早文本/图片丢失仍开放；[#23](https://github.com/EstebanForge/pi-extensions/issues/23) 字符串 `"false"`/`"off"` 误转真仍开放。历史 [#20](https://github.com/EstebanForge/pi-extensions/issues/20) 多步计费冒充 context、压缩与 ephemeral process 泄漏；[#18](https://github.com/EstebanForge/pi-extensions/issues/18) ACP engine 漏加载 shadow gate，native write/edit 的字段名也漂移；[#14](https://github.com/EstebanForge/pi-extensions/issues/14) 全局 MCP 让别的 Pi 会话看到错误 bridge；[#9](https://github.com/EstebanForge/pi-extensions/issues/9) `.par` 无输出、registry args、`session/new` 仅浅层 auth probe。尤其不能把 plan mode 或所谓“ToS safe”描述当保证。

### 独立工具协议、原生显示、委派

- **`@timmyjl12/pi-agy-bridge@0.1.5`**（[npm](https://www.npmjs.com/package/@timmyjl12/pi-agy-bridge)，`gitHead 58724a0`；GitHub issue 查询未能解析仓库）：README、ARCHITECTURE、`src/{stream,session-pool,transcript,tool-protocol,model-catalog}.ts`。受限 `agy acp` 作生成器，把工具清单/格式写进提示，扫描模型**正文里的标记 JSON**而非 ACP `tool_call`，生成真 Pi toolCall；每 Pi step 一个 ACP prompt，工具结果下一 step 进 prompt；无 parked MCP、长工具不占 ACP prompt。native 工具关闭；thought→thinking，普通 native update 不驱动 Pi，未见 plan UI。会话池用 Pi ID、ctx 前缀/工具/system 串联；失配/TTL/重启 new + bounded replay，不承诺长期 native restore；冷历史上限默认 8 MiB。动态 Gemini/第三方 catalog/effort，`/agy-bridge status/doctor/reset`、可选 trace、静默 watchdog、idle 回收、使用现有登录不读/复制；没有 ACP native 交互审批或外部实时 steering。README 自承 Markdown code fence 内的调用示例也会被执行，不能把有损文本 parser 当真工具协议。
- **[`st0nie/realagy`](https://github.com/st0nie/realagy) `922a7b1`**：GitHub-only；README、`src/{provider,transcript,acp/driver,acp/connection}.ts`。provider + 真 MCP、native 状态以展示行而非 Pi 可执行 native call；`registerMessageRenderer` 用于背景任务卡，不意味着所有 native 工具都是 custom message。分角色/工具 ID/图像内容 hash 做前缀、resume 优先，否则 load 丢 replay，对未知 ID 成功但空会话设 guard；前缀不匹配重建而非 fork native snapshot。动态模型/工具 loadout、平行批与取消/后台管理是好参考；有可选依赖 runtime 内部行为/patch 的功能，更新风险高，不建议作为首版基础。
- **[`chunyoupeng/pi-antigravity-acp-provider`](https://github.com/chunyoupeng/pi-antigravity-acp-provider)**（GitHub fork；README 所列 scoped 名在本次 npm 精确查询为 404）：Zac fork；`extensions/tool-activity.ts` 用 `pi.registerEntryRenderer` + `pi.appendEntry("antigravity-acp-tool-activity", …)`，按 `(sessionId,toolCallId)` 合并更新；绘制 native shell/file 卡和 diff、恢复可见活动，**不用假工具**，显示数据不进入 prompt。工具依然可区分 Pi MCP 与挂在 agy 的 native；README 与源码同时有权限模式、`/antigravity-acp sessions` attach、恢复、官方 standalone 运行时。是「有 TUI 卡但无 Pi 二次执行」最值得借鉴的那条路；核对目标 Pi 版本 renderer API，RPC/print 不会天然得到这些卡。
- **`pi-antigravity-acp-subagent@1.7.1`**（[npm](https://www.npmjs.com/package/pi-antigravity-acp-subagent)，未声明 GitHub 仓库）：README、`index.ts`。`ask_antigravity`/`resume_antigravity`/`await_antigravity_task`、doctor 等；工具更新做 task/file audit，最终文本/结构化数据回单一 `toolResult`，不写 Pi AssistantMessage native calls。自有持久 task 状态、checkpoint/恢复/一次修复；不是 Pi branch hash。官方 ACP 运行时首用下载、动态 model/reasoning 设置、按工作区队列、日志脱敏和进程组清理，取消/超时/输出界限。权限默认固定无人值守 `yolo`、无 `ctx.ui` 审批或 OS sandbox；没有普通 provider 的 model picker、实时 steer 或图像流保证。

- **[`@agimon-ai/po-antigravity-bridge@0.1.1-alpha.162`](https://www.npmjs.com/package/@agimon-ai/po-antigravity-bridge)**：README、`dist/index.mjs`，仓库 issue 查询未能解析。每 Pi session 一个 `agy acp`，前缀或工具集不符就新建并发送带标签的旧对话文本，不 native fork；只把真实 loopback MCP 调用做 Pi `toolCall`，native `read_file` 用于见到 offload 图像，也确实绕过 Pi read hook。模型先有 offline seeds 后刷新，按公布 effort；本机 auth 或 API key，默认隔离 home 下可复制 file-backed token；有取消/空闲超时和 `ANTIGRAVITY_BRIDGE_DEBUG` log sink，未见通用原生审批 UI 或 in-flight steer。自定义 `args` 会替换受限 launcher，不能继续假定 native 工具集不变。

## 9. 其余发现：不和同名 npm、反向 ACP、非 ACP 混算

以下为**扩展索引（较浅审阅）**，链接指向包或检出的仓库。对薄 wrapper 或候选 fork 不把未核实的分叉、图像、权限/调试行为写成已支持。重点包见前文。

| 方向 | 找到的相关包/仓库；可复用或需避开的设计 |
|---|---|
| 通用 ACP 委派/控制 | [`pi-acp-agents`](https://github.com/buihongduc132/pi-acp-agents)（npm unscoped README 显示旧 `@walodayeet`；另有当前 `@buihongduc132/pi-acp-agents@0.5.1`）：`acp_spawn`/`acp_msg` 等、档案/IPC、DAG，不是 provider；[#48](https://github.com/buihongduc132/pi-acp-agents/issues/48) published `workspace:*` 安装失败，[#50](https://github.com/buihongduc132/pi-acp-agents/issues/50) 命名会话 reopen 不一致。另有同仓高级编排入口。 [`lluz55/pi-acp-subagents`](https://github.com/lluz55/pi-acp-subagents) 的 `index.ts`/`run.mjs` 是 ACP delegation + TUI progress/后台控制；[`billion-context-pi-subagents@0.1.1`](https://github.com/ranxianglei/billion-context-pi-subagents) 提供 `acp_delegate`/fleet、watchdog（非 SyJarvis 包）；`billion-context`/`billion-context-pi` 是原上下文/编排家族，不能把整个产品算成 provider。 |
| 通用 ACP 的部分路径 | [`@0xkobold/pi-cursor@0.1.0`](https://www.npmjs.com/package/@0xkobold/pi-cursor) 是 `cursor_agent` 委派工具，走本机 `agent acp`，不要与 Zac 的 Cursor provider 混为一谈。 [`pi-harness-delegate@0.9.0`](https://github.com/yorch/pi-harness-delegate) 的 `extensions/acp-runner.ts` 只有部分 harness（Devin/OpenCode）走 ACP，任务事件→工具卡和结果；CLI drivers 不是 ACP。 [`@black942026/harness-acp-bridge-pi-extension@0.1.11`](https://github.com/black-94/harness-acp-bridge-pi-extension) 是 Pi 工具的 HTTP client，ACP/session/auth 在服务端；sync wait/reverse request，不是本地 provider。 [`@junghanacs/pi-shell-acp@0.11.1`](https://github.com/junghan0611/pi-shell-acp) 是 provider 与 Entwurf 协同；`acp-bridge.ts`/`event-mapper.ts` 将活动路由，并非通用 Pi 执行远端命令；项目后续 [`entwurf` #167](https://github.com/junghan0611/entwurf/issues/167) 直接 agy、[#168](https://github.com/junghan0611/entwurf/issues/168) backend parity、[#171](https://github.com/junghan0611/entwurf/issues/171) native resume/load、[#163](https://github.com/junghan0611/entwurf/issues/163) busy 排队不是 interrupt，应区分发布包与迁移后的仓库进展。 |
| 对照 provider：Cursor/Devin | [`pi-cursor-acp-provider@0.1.4`](https://github.com/zacbemis/pi-cursor-acp-provider)：Zac 的思路移植到 Cursor；text/thought + tool/plan/status→thinking，真实 MCP 与 permission/question/plan approval 专用工具另走 `toolUse`，load 回放抑制与前缀校验。 [`@tian.zuo/pi-devin-acp`](https://www.npmjs.com/package/@tian.zuo/pi-devin-acp)：ACP tool 显示卡/plan 状态，`session/load` 和 Pi custom binding，不假设 Devin 支持 resume/fork/close；注意 `load` 不回放 plan。另有 [`Davidcreador/pi-devin-acp`](https://github.com/Davidcreador/pi-devin-acp) 轻量 provider，`src/stream.ts`/`src/acp.ts`，不要与前者混同。 |
| 对照 provider：Gemini/Grok/Kiro/Junie | [`pi-gemini-acp@0.13.2`](https://github.com/brandonkramer/pi-gemini-acp)：provider + Gemini 任务，chat 复用 ACP client 但 `buildAcpPromptRequest` 每次把受配置上限约束的 transcript 平铺为标签文本，chat stream 只出 text，不出 thinking/native toolCall/plan；不要把另外的 image-analysis 工具等同于 provider 图像保真。可预热、有多账号。[#18](https://github.com/brandonkramer/pi-gemini-acp/issues/18) `Auto` 模型选择不等价 Gemini CLI，[#35](https://github.com/brandonkramer/pi-gemini-acp/issues/35) agent 工具 schema 的 enum 没 type。 [`@skdev-ai/pi-gemini-cli-search@0.2.0`](https://github.com/skdev-ai/pi-gemini-cli-search)：搜索工具 A2A 优先、warm Gemini ACP fallback，不是 full model provider。 [`pi-grok-agent@0.1.9`](https://github.com/JangMan-J/pi-grok-agent)、[`pi-grok-sdk@0.2.1`](https://github.com/ankitchouhan1020/pi-grok-sdk) 都是 Pi provider 接 Grok stdio ACP 子进程；前者 Grok 自执行工具（有策略、图像/路径显示），后者另有 modes/capabilities。 [`pi-kiro-agent@0.4.0`](https://github.com/randiskull/pi-kiro-agent)：provider、按版本使用 ACP/stream-json/text 路径，Pi MCP bridge；[#57](https://github.com/randiskull/pi-kiro-agent/issues/57) 各 transport 不重复绘制的问题、[#63](https://github.com/randiskull/pi-kiro-agent/issues/63) profile `.bak` 遗留 token 教训。 [`@thoth-agents/pi-junie-bridge@0.1.1`](https://www.npmjs.com/package/@thoth-agents/pi-junie-bridge)：Junie stdio provider，模型/effort、工具与交互桥，非 agy。 |
| agy ACP：其他 provider / fork | [`michaelcosj/pi-agy-acp`](https://github.com/michaelcosj/pi-agy-acp) (`src/translate.ts`,`src/mcp.ts`) Pi-tool MCP provider；[`w-3-g/pi-agy-acp`](https://github.com/w-3-g/pi-agy-acp) (`src/stream.ts`,`src/acp-client.ts`) 小型 provider；[`jiuai233/pi-antigravity-acp`](https://github.com/jiuai233/pi-antigravity-acp) (`plugin/src/runtime.ts`) 用户会话继续、工具等待/私有适配；[`z21100644/pi-antigravity-acp`](https://github.com/z21100644/pi-antigravity-acp) (`pi-antigravity-acp/lib/`) provider、恢复及可选独立 runtime patch，非推荐路径；[`DeRep311/pi-antigravity-bridge`](https://github.com/DeRep311/pi-antigravity-bridge) (`src/engine.ts`) Pi/Gentle Shell Gemini MCP 路线，拒 native；[`kyraneth/pi-agy-tether`](https://github.com/kyraneth/pi-agy-tether) (`src/event-bridge.ts`) Gemini-only provider、Pi MCP、workspace recipe proof、冷启动可能丢 native cache；[`Necsus/pi-gemini`](https://github.com/Necsus/pi-gemini) 搜索命中 ACP 客户端但 clone 为空，不计有效实现。 |
| agy ACP：其他委派 | [`dahehua/pi-agy-acp`](https://github.com/dahehua/pi-agy-acp)：`index.ts`/`src/acp-client.ts` 注册编排工具、unattended 多轮，不是 fdkevin0 的 provider；`pi-antigravity-acp-subagent` 见上。 |
| 名字像 ACP，方向/transport 不同 | [`Coder6pack/pi-agy-acp`](https://github.com/Coder6pack/pi-agy-acp) 的 Zed server **说 ACP**，但 `pi-extension/index.ts` 到 agy 的传输是 **stream-json**；Pi provider 让 agy 原生执行，不能当直接 `agy acp` 实例。`pi-acp`、`@geohar/pi-acp`、`@gugu-acp/pi-acp`、`acp-pi`、`pi-acp-zz`、`@wierdbytes/pi-acp`、`@frmhd/pi-sdk-acp-adapter`、`pi-acp-jetbrain`/`@wbline/pi-acp-jetbrain`/`@wbline/pi-acp-openidea` 和 T3 bridges 是把 Pi 暴露给其他 ACP client 或 IDE 的方向；`Pi-Desktop-Acp`、`antigravity-acp-pidesktop`、`omp-antigravity-acp-provider`、`@n1netynine99/omp-antigravity-acp-provider` 是其他宿主，不是 `@earendil-works/pi-coding-agent` 扩展目标。 |
| agy 非 ACP 邻居 | `pi-agy`（npm）、`pi-antigravity`（npm unscoped）、`pi-provider-antigravity`/`2`、`@cortexkit/pi-antigravity-auth`、`@inhyoe/pi-antigravity-auth`、`@specode/pi-antigravity`、`@heyhuynhgiabuu/pi-oauth-antigravity`、`@zhexin/pi-agy` 等是 direct OAuth/HTTP 族。`pi-agy-provider`、`@tian.zuo/pi-antigravity`、`14NGiestas/pi-agy`、`@juanbenjumea/pi-agy`（`huaxel/pi-agy`）、`xjw2005/pi-agy`、`@estebanforge/pi-ask-antigravity` 是 CLI stream-json/print 或委派，不等于 ACP；`agy-crew`、`gemwork`/`gemworks`（含 `@geml/`）、`@freibergergarcia/phone-a-friend`、配额/图像/Guard 等关键词命中也不计作已证 ACP provider。 |

## 教训与可借鉴点

1. **先做 `agy acp` 原生所有权的一种模式。** Pi 只注册一个 provider，把 text、thinking 如实转流；把工具、plan、diff 放进 branch-aware 的独立活动记录/renderer（借 Chunyoupeng；无 renderer 就降级为短的只读文本/状态）。不要把原生 `tool_call` 投到活跃 `bash/read/write` 名字。必须有原生 Pi tool 卡且没有 renderer API 时，才考虑 onprs 的只读镜像；明示来源，按 `(sessionId, turnId, toolCallId)` 去重；未收到 terminal 显示“未确认”，不能伪造成功。
2. **把真 Pi 工具留作另一项功能。** 只有真实、已验证的 MCP 请求才发 executable `toolCall`。需要时采用 bounded 批处理、active turn ownership、明确同轮结果匹配、失效拒绝与 deadline；默认不暴露全工具或其他委派工具，不写全局 MCP 配置。若非做长工具不可，优先验证 agy 支持的延迟结果契约；不能靠延长 Pi 的 timer 越过 agy 的 ~180s，不能自动重试未知是否已产生副作用的调用。
3. **Pi transcript 是恢复真相，不是 agy 缓存。** 在分支日志存最小 versioned checkpoint：agent/runtime/data profile/cwd、Pi branch/session、native ID、accepted-prefix count/hash，必要时另存 expected assistant hash（不含时间、usage 等易变字段）。只记录已确认提交的 prefix；fork/tree/compaction/工具模式/系统提示/账号变化严格 invalidation；capability-aware `resume` 优先、`load` 隔离 replay，遇到“成功但空历史”要检查。回退 fresh + 有界 untrusted replay，当前多条 user 文本和图片及 task 优先；不要默认整历史重放、修改 agy SQLite 或导入旧副作用。
4. **权限和进程必须是硬边界。** ACP 权限选项用原始 ID，unknown/headless 默认拒绝；ACP 不提供 fs/terminal client callbacks 并不限制 agy 本机权限。显式声明选择 native 或 Pi policy，校验生效；plan 不是沙箱。取消：发 `session/cancel`，回复所有待审批/工具，有限 drain，无法收敛就重开（含进程树）。对短命 Pi SDK sessions、并发、迟到通知分别 fence。冷启动 model catalog 从本地读，不因非本 provider 的 startup refresh 常驻一份 front/worker；需要时刷新并保留 offline cache。
5. **每个 agy runtime 都需要实测，不能用另一种代替。** `agy acp` 与独立 `.par` 的 auth、参数、slash、configOptions、模型账户资格、读取回调不一定相同。先用用户已安装的 CLI，不下载 `.par`、不复制 OAuth、不碰私有 SQLite；显式区分 auth/unsupported/missing binary/timeout/quota/overflow/429，禁止无界 retry。遵守上游许可和账户条款；“官方 CLI”不代表第三方用法必获授权。日志默认关，不写原始 prompt / token / credentials；debug redaction、上下文占用与计费合计分开，不能让一条 usage 污染下一个 provider。
6. **验证计划（本次没跑）。** 假 ACP stdio 矩阵：分帧/错帧、cancel 后迟到、load replay、同 ID/不同 session、纯 status diff、重复 terminal/无 terminal、授权超时和 headless、连续多条 user+图片、fork/compact、动态模型或工具集合、真 MCP 与镜像各一次、工具跨超时、usage 在切 provider 后不压垮上下文；然后用用户授权的真实 `agy acp` 版本分别测 TUI/RPC/print、恢复、并行与长工具、图像 offload、登录与进程树。报告只提供代码与 issue 证据，未验证 Google 今日服务策略或本地账号权限。
