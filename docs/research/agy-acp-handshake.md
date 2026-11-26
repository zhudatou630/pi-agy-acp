# `agy acp` 1.5.14 实测记录

日期 2026-11-22，测试机上的 `~/.local/bin/agy`（ELF 原生 Go 版，`agentInfo.version = 1.5.14`）。探测脚本和场景在 `docs/research/probe/`（`node probe.mjs s1.json`，`OUT=` 指定抓包文件，`PERM=allow` 自动允许权限）。所有探测都在 `/tmp/agy-probe/ws` 里跑，模型用 `gemini-3.8-flash` + `low`。以下内容都来自真实抓包，不是从文档推出来的。

## 1. initialize

请求：`protocolVersion: 1`，`clientCapabilities: {fs:{readTextFile:false,writeTextFile:false}, terminal:false}`，`clientInfo: {name:"pi-agy-acp-probe"}`。agy 不检查 client 名字，自报真实名字就行。

```jsonc
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true, "load_session": true,            // 驼峰和下划线两种写法都有
    "promptCapabilities": {"image": true, "audio": false, "embeddedContext": true},
    "sessionCapabilities": {"resume":{}, "close":{}, "load":{}, "list":{}, "additionalDirectories":{}},
    "auth": {"logout": {}},
    "_meta": {"antigravity": {"tier": true, "systemPrompt": {"append": true}}}
  },
  "agentInfo": {"name": "Antigravity ACP Server", "version": "1.5.14"},
  "authMethods": [
    {"id":"oauth-personal","name":"Log in with Google"},
    {"id":"oauth-business","name":"Log in with Gemini Enterprise"},
    {"id":"gemini-api-key","name":"Gemini API key"},
    {"id":"agent-platform","name":"Gemini Enterprise Agent Platform"}
  ]
}
```

- 没有 `sessionCapabilities.fork`。实际调用 `session/fork` 返回 `-32601 Method not found`。
- 冷启动 initialize 大约 90 ms。**每个进程的第一个会话类请求**（new、list、resume 都一样）要 2.3–2.8 s，这是 agy 收到请求后才做的一次性预热，initialize 后空等几秒也不会提前完成。之后 `session/new` 约 36 ms（两个并发约 85 ms），`set_config_option` 约 1 ms，`session/list` 约 25 ms，`session/resume` 约 2 ms。所以冷启动的代价在进程，不在会话数。
- 单进程常驻内存约 230 MB。空闲时没有子进程，也不会拉起 `language_server`，和正在运行的 `~/.antigravity-hub-server` 进程树没有交集。
- stdin 收到 EOF 后，agy 自己以 exit 0 退出。SIGTERM 发给进程组也能干净退出。
- 运行期间 stderr 没有任何输出，stdout 全是 JSON-RPC。日志写在 `~/.gemini/antigravity-cli/log/acp-server-*.log`。
- 数据目录是 `~/.gemini/antigravity-cli/`，和 IDE/hub 用的 `~/.gemini/antigravity/` 是分开的。

## 2. session/new 的结果

`{cwd, mcpServers: []}` 会返回 `sessionId`，以及三套描述模型的结构：

- 旧式 `models.availableModels[]`：23 个“模型+档位”组合 ID，例如 `gemini-4-neon-high`、`gemini-3.8-flash-low`，另有 `currentModelId`。
- `modes`：`default` / `accept-edits` / `auto` / `plan`。
- `configOptions`（权威来源，id 和 category 一致）：

| id | 当前值 | options |
|---|---|---|
| `model` | `gemini-4-neon` | gemini-4-neon, gemini-4-argon, gemini-4-hydrogen, gemini-pro-orchestrator-neon, gemini-pro-orchestrator-g1-pro, gemini-3.8-flash, claude-opus-5-5, claude-sonnet-5-5, gpt-oss-120b-medium |
| `thought_level` | `high` | 随模型变化，见下表 |
| `mode` | `default` | default, accept-edits, auto, plan（带 description） |

逐个模型执行 `set_config_option(model)` 后看到的 `thought_level`（这一步只走配置 RPC，不消耗额度）：

| model | thought_level 选项 |
|---|---|
| gemini-4-neon, gemini-4-hydrogen | low, medium, high, xhigh（xhigh 显示名为 "Extra"） |
| gemini-4-argon, gemini-3.8-flash, claude-opus-5-5, claude-sonnet-5-5 | low, medium, high |
| gemini-pro-orchestrator-neon / -g1-pro, gpt-oss-120b-medium | 没有 thought_level 这一项 |

- `_meta.antigravity.tier = {name, id, upgradeUri}`：账号的订阅档位。
- 紧接着会推送 `available_commands_update`，共 13 个命令：goal, compact, schedule, browser, plan, grill-me, teamwork, learn, boost, agy-customizations, antigravity-guide, run-workflow, swarm。同一份列表在一次 prompt 里会重复推送好几次。
- 还会推送 `usage_update {used:0, size:1048576}`，说明上下文窗口是 1M。

## 3. 配置

- `session/set_config_option {sessionId, configId, value}` 返回完整的新 `configOptions`。下一次 prompt 开始时还会再推一次 `config_option_update`。
- 换模型时，旧的 thought_level 如果新模型也支持就保留，否则回落到默认值，所以每次都应该显式设置。
- 旧方法 `session/set_model {modelId:"gemini-3.8-flash-low"}` 也能用（返回 `{}`），但不需要。
- 设置 mode 时会推送 `current_mode_update`。
- **load 或 resume 之后，model、thought_level、mode 都会重置为默认值**（neon / high / default）。每次接回会话后必须重新设置一遍。

## 4. prompt 期间的事件（真实形状）

```jsonc
// 先是会话标题（第一轮），然后是工具
{"sessionUpdate":"session_info_update","title":"Create And Edit Text File"}
{"sessionUpdate":"tool_call","toolCallId":"call_1057…","name":"write_file","args":{…},
 "status":"in_progress","kind":"edit","title":"File hello.txt",
 "locations":[{"path":"/tmp/agy-probe/ws/hello.txt"}],"rawInput":{"Content":"hi\n","Path":"…"}}
{"sessionUpdate":"tool_call_update","toolCallId":"call_1057…","status":"completed",…,
 "rawOutput":{},"content":[{"type":"diff","path":"…/hello.txt","newText":"hi\n"}]}
// edit_file：diff 同时带 oldText 和 newText，内容是片段而不是整个文件
{"content":[{"type":"diff","path":"…","newText":"hello world\n","oldText":"hi\n"}]}
// run_command：kind=execute，title 就是命令本身
{"sessionUpdate":"tool_call","name":"run_command","kind":"execute","title":"ls -la",
 "rawInput":{"CommandLine":"ls -la","WaitMsBeforeAsync":5000,"toolSummary":"List directory contents"}}
{"sessionUpdate":"tool_call_update","status":"pending",…}          // 等权限
// ← session/request_permission（id 是字符串 "1"）
{"toolCall":{…同上…},"options":[{"optionId":"allow","name":"Allow","kind":"allow_once"},
                                 {"optionId":"deny","name":"Deny","kind":"reject_once"}]}
// → {"outcome":{"outcome":"selected","optionId":"allow"}}
{"sessionUpdate":"tool_call_update","status":"completed",
 "rawOutput":{"output":"Created At: …\nCommand exited with code 0.\n\nCommand output:\n…","exit_code":0},
 "content":[{"type":"content","content":{"type":"text","text":"…同 output…"}}]}
{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"…"}}
{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Created and updated [hello.txt](file:///…)"}}
{"sessionUpdate":"usage_update","used":9118,"size":1048576}
// session/prompt 的响应
{"stopReason":"end_turn","usage":{"inputTokens":13158,"outputTokens":148,"cachedReadTokens":13247,
 "cachedWriteTokens":0,"thoughtTokens":0,"totalTokens":26553}}
```

要点：

- tool_call 里除了标准字段，还带非标准的 `name` / `args`（agy 内部工具名，例如 write_file、edit_file、run_command）。
- 在 default 模式下，工作区内写文件没有弹权限，只有 run_command 请求了权限。
- 输出不是流式的。命令结果在 completed 那一帧一次性给出，文本前面带有 "Created At / Completed At / exit code" 前缀。
- 正文里的文件引用写成 `[name](file:///abs/path)` 形式。
- `totalTokens` 是这一轮里多次内部模型调用的累计值（26553），比实际上下文占用（`usage_update.used` = 9118）大很多，不能直接当作上下文用量。
- prompt 结果的 usage 满足 `totalTokens = inputTokens + outputTokens + cachedReadTokens`，`inputTokens` 不含缓存部分；`thoughtTokens` 包含在 `outputTokens` 里（flash high 实测：output 608、thought 606）。同一会话第二轮 `cachedReadTokens` 6720 / 输入 9528，说明隐式缓存生效。
- 这几次探测里都没有出现 `plan` 通知。thought 只有在档位较高时才会出现（neon high 的 `thoughtTokens` 是 109）。

## 5. 图片

prompt 里放 `{"type":"image","mimeType":"image/png","data":"<base64>"}`，模型能正确认出“红色”。

## 6. session/load、resume、list、close

- `session/load`：**在返回结果之前**，先用 `session/update` 把整段历史回放一遍（user_message_chunk、已完成的 tool_call、thought、agent_message_chunk），然后才回 result。客户端在 load 期间必须把这些回放和实时输出隔离开。
- `session/resume`：不回放历史，只推 `session_info_update`；耗时见 §1（进程已预热时约 2 ms）。适合冷启动接回会话。
- **用一个不存在的 sessionId 调 load 也会成功**（空会话，不报错），换一个 cwd 去 load 同样成功。所以不能靠报错判断会话是否丢失，必须先用 `session/list` 确认会话还在（list 会返回所有 cwd 下的会话，带 title 和 updatedAt）。
- `session/close` 返回 `{}`。

## 7. 取消

一个后台命令 `sleep 25` 在运行中，此时发 `session/cancel`（notification）。agy 立刻把这个工具更新为 `status:"failed"`，output 为空。

## 8. 运行中继续发消息（steering）

第一个 prompt（id 5，长文本生成）还在跑，这时同一会话再发 `session/prompt`（id 6，"stop the list now and just say banana"）。结果：**id 5 立即以 `end_turn` 返回，且没有 usage 字段**；后面所有的流式输出都属于 id 6，并把 steer 的内容合进了同一次生成（列表写完后接着输出 "banana"）。也就是说 agy 原生支持“用新 prompt 接管当前这一轮”，旧 prompt 被新 prompt 取代。

## 9. 后台命令会超出本轮

`WaitMsBeforeAsync: 500` 的命令被放到后台。本轮在约 9.7 s 时以 end_turn 结束，这时工具状态还停在 `in_progress`（之后被 cancel 标成 failed）。所以 **tool_call 可能比所在的这一轮活得更久**。

后续实测（`sleep 20 && echo WAKE_DONE`，tool_call 里带 `IsDaemon:false, WaitMsBeforeAsync:500`）：prompt 在 9.6 s 以 `end_turn` 返回；26 s 时工具更新为 completed；随后 agy **在没有任何 prompt 的情况下主动发出** agent_message_chunk（"The background task has finished… WAKE_DONE"），最后发一条 `usage_update`。这段主动汇报没有对应的 prompt 响应。

多步主动工作（agy 1.5.14，`probe/s9.json`：后台命令结束后读文件、写文件、跑命令、再回复）：命令结束约 6 s 后 agy 开口，没有 prompt 响应。**每次模型调用都以一条 `usage_update` 收尾，这次调用的 tool_call 紧随其后（同一毫秒级）**；最后一次调用只有正文，之后的 `usage_update` 后面什么都不再来。prompt 内的多步工作形状相同，最后的 `usage_update` 紧挨着 prompt 结果。所以 `usage_update` 不是“整段结束”的唯一信号，插件据此推定：`usage_update` 之后短时间内没有新的 tool_call 或正文，就是结束（ACP 本身没有主动工作的结束信号）。模型生成期间（usage_update 之前）可能长时间完全静默。

## 10. slash 命令

`session/prompt` 里直接发文本 `/compact` 就能生效：没有任何 update，只回 end_turn 和 usage。

1.5.17 复测（`npm run smoke`）：`/compact` 期间会推一条 `usage_update`，数值是压缩这次调用自己的输入量，不是压缩后的占用；结果里带 usage（一次实测：input 2824、output 496、cachedRead 11496）。压缩后的下一个 prompt `cachedReadTokens` 为 0（上下文被改写，缓存前缀失效），`usage_update.used` 下降，一次实测从 14386 降到 11716，之前创建过的文件名仍然答得出。新会话第一轮的占用约 9000，是 agy 自己的系统提示和工具，压缩不会低于这个数。

## 11. 未登录

用空 HOME 启动：initialize 正常，`session/new` 和 `session/list` 都返回 `{"code":-32000,"message":"Authentication required"}`。
`agy acp --login` 的说明是 "Log in with Google interactively, then exit (ACP terminal auth)"，这是官方的终端登录入口（本次没有在真实 profile 上执行）。

## 12. 其他 flag（`agy acp --help`）

`--process-per-session`、`--sandbox`、`--disable-telemetry`、`--dangerously-skip-permissions`、`--add-dir`、`--gemini-dir`、`--app-data-dir`、`--log-file`、`--login`。

## 13. 客户端传入的 MCP server（agy 1.5.17，2026-11-26）

用探测脚本加一个记录收发的 stdio MCP 桩实测，场景都在 `/tmp` 里跑，模型 flash + low。

- `session/new` 和 `session/resume` 的 `mcpServers` 里放 `{name, command, args, env:[{name,value}]}`，agy 会为这个会话拉起该进程并带上这份 env，依次发 `server/discover`（回 -32601 也不影响）、`initialize`（`protocolVersion: "2025-11-25"`）、`notifications/initialized`、`tools/list`。这一步不发 prompt，不耗额度。每次 resume 都重新拉起一个；同一个 agy 进程里旧的那个要等 agy 退出才结束。
- 工具在 agy 里叫 `mcp_<server>_<tool>`；agy 已经知道另一个同名 server 时，会在 server 名后加一段哈希，例如 `mcp_pi_9f9e3b21_subagent`（pi-web 里实测）。ACP 里依次是 `tool_call`（`name` 为这个名字，`kind: "other"`，`rawInput` 是参数加 agy 自加的 `toolSummary`）、`request_permission`（带 toolCallId）、客户端应答，约 1 ms 后 MCP 才收到 `tools/call`。`tools/call` 的 `params._meta` 带 `antigravity.google/conversation_id` 和 `root_conversation_id`（ACP 会话 id），不带 ACP 的 toolCallId。
- 让 agy 在一步里并行调两次同一个工具，实际是串行的：第一个返回后才发第二个。
- **一次 MCP 调用最多 180 秒**：到时 agy 发 `notifications/cancelled`（`reason: "context deadline exceeded"`），工具记为 failed。每 20 秒发一次 `notifications/progress` 不续期；在 mcpServers 条目上加 `timeoutSeconds`、`timeout`（数字或 `"600s"`）、`_meta` 里的同名字段都无效。
- 发 `notifications/tools/list_changed` 后 agy 立即重新 `tools/list`。
- agy 把工具 schema 缓存在 `~/.gemini/antigravity-cli/mcp/<server>/<tool>.json`（agy 自己写的，插件不碰）。
- 对比：`run_command` 跑 `sleep 300 && echo …`，agy 自己填 `WaitMsBeforeAsync: 500`、`NotificationTimeoutSeconds: 330`，回一句“完成后会通知我”；300 秒后命令 completed，agy 不经 prompt 醒来，直接报出输出（没有再调工具）。所以长时间的等待交给后台命令，不放在 MCP 调用里。
