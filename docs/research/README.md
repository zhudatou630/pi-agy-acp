# 调研报告（汇总）

本页是 5 份材料的结论汇总，每条都可以在对应的详细报告里查到出处（file:line）。

| 文件 | 内容 |
|---|---|
| [agy-acp-handshake.md](agy-acp-handshake.md) | **`agy acp` 1.5.14 的实测结果**：握手、模型、档位、工具事件、load/resume、取消、steer、未登录 |
| [t3code.md](t3code.md) | T3 Code（HEAD 620cf47）的 Antigravity/ACP 实现 |
| [pi-acp-plugins.md](pi-acp-plugins.md) | pi 生态里约 20 个 ACP / agy 插件的对比和踩坑记录 |
| [pi-extension-api.md](pi-extension-api.md) | pi 1.6.0 的 provider、扩展、会话、工具机制 |
| [pi-web.md](pi-web.md) | pi-web 1.8.3 的渲染、ctx.ui、恢复与 fork、模型选择器、steer |

## 1. 实测出来的关键事实（不是看文档猜的）

1. 模型和档位以 `configOptions` 为准。`model` 有 9 个基础模型；`thought_level` **随模型变化**：neon 和 hydrogen 有 low/medium/high/xhigh，argon、flash、claude 只有 low/medium/high，orchestrator 和 gpt-oss 没有这一项。
2. **load 或 resume 之后，model、thought_level、mode 都会被重置为默认值**，接回会话后必须重新设置。
3. `session/load` 会在返回结果之前先回放整段历史；`session/resume` 不回放，耗时约 2.5 s。**用不存在的 sessionId 去 load 也会“成功”**，所以必须先用 `session/list` 确认会话还在。
4. 没有 `session/fork`。
5. 同一会话在运行中再发一次 `session/prompt`，agy 会让旧的 prompt 立刻以 `end_turn` 返回（不带 usage），后续的输出都归新 prompt，并把 steer 的内容合进去。这是**原生的 steering**。
6. `session/cancel` 会把进行中的工具标成 failed。后台命令可以在这一轮结束（end_turn）之后还处于 in_progress。
7. 工具事件里带 `kind`、`title`、`rawInput`，还有非标准的 `name`/`args`。edit 类的 diff 是 `{path, oldText?, newText}` 的**片段**；execute 类的输出在 completed 时一次性给出（不是流式），并带 `exit_code`。
8. 未登录时返回 `-32000 Authentication required`。官方的登录入口是 `agy acp --login`。
9. 单进程约 230 MB，不会拉起或连接 hub 的 `language_server`。stdin 关闭后 agy 自己退出。stderr 是空的，stdout 很干净。
10. prompt 返回的 `usage.totalTokens` 是这一轮多次内部调用的累计值，比实际上下文占用（`usage_update.used`）大得多。

## 2. T3 Code：值得照抄的做法

- 每个会话懒启动、复用连接；只清理自己拉起的进程组，不扫描、不 kill hub 或 language_server。
- 持久化原生 `sessionId`。冷启动优先用 `session/resume`，load 的回放和实时输出分开处理。恢复失败时说清楚，**不盲目重发可能已经执行过的 prompt**。
- 模型和档位都从 live `configOptions` 里取真实的 id 和 value，换模型后再设置档位，不用常量表。
- 权限按 `optionId` 回复。取消、超时、未知情况一律当作拒绝。
- 工具按 ID 合并更新。diff 无法定位行号时就如实显示片段，不伪造行号。
- agy 版本 ≥1.5.0 时，steer 用“同一会话再发一次 prompt”实现，和排队（queue）分开处理。
- 区分未登录（-32000）、配额（429 / RESOURCE_EXHAUSTED）和进程退出这几类错误。
- 测试分两层：可编排的假 agent，加上一层真实抓包回放。

## 3. pi 生态插件：教训

- **最常见的坑**：把 ACP 已经执行过的工具当成 pi 的 `toolCall` 发出去，pi 会再执行一遍。光把 `stopReason` 改成 `stop` 拦不住，因为 pi 是按内容里有没有 toolCall 来决定执行的。
- 工具展示有三种做法：
  1. 写进正文或 thinking（R-Dson、Zac）。最简单，但在 pi-web 里很难看。
  2. 只读“镜像工具”（onprs 的 `agy_*`、elvizlai）：pi 执行的是一个只等待 ACP 结果的工具，从不重做操作。能得到 pi 原生的工具卡。
  3. TUI 专用的 entry renderer（Chunyoupeng）。**pi-web 不渲染**这种方式。
- 镜像方案踩过的坑（onprs 的 CHANGELOG）：
  - 镜像必须由 ACP reader 直接 resolve，不能等下一次 streamSimple，否则会死锁。
  - 没有收到终态时要标成“未确认”，不能当作成功。
  - 状态要按 `(session, toolCallId)` 做键。
- 会话恢复：在分支上保存锚点或前缀指纹；能 resume 就 resume；对不上时有界地重建（fresh 会话 + 有限的历史 replay）。不要去改 agy 的 SQLite，也不要复制 OAuth token。
- 其他坑：
  - 启动时就拉起 agy（fdkevin0 #43）。
  - 把每轮累计的 usage 当成上下文占用，污染其他 provider（Zac #80）。
  - 默认 yolo。
  - 用 option name 而不是 optionId 回复权限。
  - 连续多条 user 消息时前面的被丢掉（Esteban #24）。

## 4. pi 的机制：决定设计的几条

- provider 的 `streamSimple` 拿不到 `ctx`，但能拿到 `options.sessionId`。注意 pi-web 的 side chat 会把它设成主会话的 id。`before_provider_headers` 会在每次请求前带着**该会话的 ctx** 触发，可以借它把真实的会话身份和 UI 关联到这次请求上。
- `prepareLoadout().hiddenDeclarations` 可以让工具**仍然可执行，但不出现在任何模型的工具声明里**（已核对 `agent-session.js:1255-1290,1416-1436`）。
- 扩展的 `ctx.sessionManager` 是只读的；持久化可以用 `pi.appendEntry` 或自己的旁路文件。
- pi-web 在同一个 Node 进程里承载多个会话，扩展 factory 每个会话加载一次（jiti 不缓存模块）。共享状态要挂在 `globalThis` 上。
- steer 和 follow-up 都要等到 turn 边界（assistant 消息结束且其中的工具执行完）才会交给 provider。`input` 事件能在用户提交 steer 时立即拿到内容。

## 5. pi-web：什么能显示好

- 能直接用的：
  - thinking 流（折叠显示）。
  - Markdown 正文。
  - 工具卡：`{command}` 显示成命令卡；名字带 `_edit` / `_write` 的工具有对应的展示；任何工具的结果只要带 `details.patch`（统一 diff）就会显示成并排 diff。
  - `ctx.ui.confirm/select/input`（窗格内对话框，可设超时）。
  - `notify`。
  - 用户图片（base64，每条最多 10 张）。
- 不渲染的：`setStatus` / `setWidget`、扩展的 renderCall/renderResult、`registerEntryRenderer`。
- 会话行为：
  - fork 会得到新的 session id 和新的 JSONL 文件，复制截断点之前的历史。
  - `/tree` 不改 session id。
  - 冷启动打开会话时，`session_start.reason` 总是 `startup`。
- 模型列表来自一个独立的 runtime：扩展 factory 里注册的模型才会出现，缓存 60 s，不会主动去网络发现。
