# AGENTS.md

pi 扩展包：把官方 Antigravity CLI 的 `agy acp` 接成 pi 的 provider `antigravity`，主要针对 pi-web 优化。用户通过 `git:github.com/zhudatou630/pi-agy-acp` 安装，pi 每次启动或执行 `/reload` 时会同步到 `main` 的最新提交。

## 开发流程

- **`main` 只放测试通过的代码**。在分支上开发，验证通过后再合并到 `main` 并推送；不要直接往 `main` 推未验证的改动。
- 合并前必须通过：
  - `npm test`：单元测试，加上通过真实 pi SDK、用 `test/fake-agy` 模拟 agy 的端到端测试；
  - `npm run typecheck`。
- 改动涉及和 agy 的协议交互时，另跑 `npm run smoke`。它连接真实 agy（gemini-3.8-flash、low），会消耗少量额度，只在需要时运行。
- 改动影响 pi-web 显示时，用隔离的 pi-web 目测：
  - 把 `PI_CODING_AGENT_DIR` 设成一个临时目录，里面的 settings 让 `packages` 指向本地仓库路径；
  - 换一个端口启动 pi-web；
  - 不要改动日常使用中的 `~/.pi/agent`。
- 修 bug 时先补一个能复现问题的测试。fake agent 的脚本按 `SCRIPT:<name>` 来选择，需要新场景就在 `test/fake-agent.ts` 里加；真实抓包里的时序用 `SCRIPT:replay <文件>` 重放（`test/fixtures/`，放进仓库前把会话 id 换掉）。
- 涉及 pi-web 怎么调用 provider 的改动（子代理、side chat、自动命名、工具预设、压缩），在 `test/host.test.ts` 里按 pi-web 的做法复现。

## 版本与发布

- 共享运行时挂在 `globalThis` 上，键里带 `VERSION`；`/reload` 不会重建它。改了 `src/runtime.ts` 中运行时或会话对象的结构时，要同时更新 `src/runtime.ts` 的 `VERSION` 和 `package.json` 的 `version`，并在提交说明里写明"需要重启 pi-web"。
- 稳定版本打 `vX.Y.Z` 标签，用户可以用 `…@vX.Y.Z` 固定版本。
- 暂不发布到 npm（`"private": true`）。

## 不要改变的设计约定

详见 `docs/design.md`。改动以下任何一条之前，先和维护者确认：

- 权限完全放行：权限请求自动回复 `allow_once`；维护类的临时会话、以及用户已按停止的回合则拒绝。agy 的 `interaction_*` 提问仍然询问用户。
- 发给 agy 的只有用户输入、图片、其他模型插话的简短说明、必要时带标记的历史转录、只读会话的一行说明，以及压缩时代发的 `/compact`。不发送 pi 的 system prompt、工具清单或 skills。唯一的例外是 pi-web 里允许委派的会话会挂一个只有 `subagent` 工具的 MCP server。
- pi-web 子代理（design 3.14）：MCP 工具只负责发起和 `resume`，等待交给 agy 后台运行的 `pi-agent wait`（agy 的 MCP 调用最多 180 秒）。父会话按停止不停子代理；子代理会话不挂 MCP；不提供 steer/abort。运行全部交给 pi-web 的子代理桥，插件不自己实现子代理。
- agy 执行过的操作用隐藏的镜像工具（`agy_*`）展示，镜像工具只等待 ACP 的结果，绝不重新执行。
- 不把 agy 的 slash 命令注册到 pi，不提供 agy mode 切换；管理命令只有 `/agy`。
- 压缩不取消 pi 自己的流程：pi 的 `/compact` 先让 agy 压缩再照常做摘要，`/agy compact` 只压缩 agy。
- 请求归属看它属于谁的 agent run（`options.signal` 与实例的 `ctx.signal` 是同一个对象），不认“注册 provider 的那个实例”，也不认 `options.sessionId`；找不到归属的按维护类处理。
- agy 的 `/compact` 不走 turn，不解除“已停止”状态；聊天不排队等它，新消息直接接管。
- factory 和模型列表加载时不启动 agy；agy 进程在第一次真正请求时才懒启动。
- 只管理自己拉起的进程组；不扫描、不终止其他 agy、language_server 或 hub 进程。
- 只使用官方的登录流程。不读取、复制或上传 `~/.gemini` 下的凭证，不读写 agy 的私有数据库。

## 代码地图

- `src/index.ts`：注册 provider、镜像工具、`/agy` 命令；`input` 钩子负责立即 steer。
- `src/provider.ts`：streamSimple。负责锚点匹配后的续接、新开或 replay，并把事件泵成 pi 事件。
- `src/runtime.ts`：共享进程、ACP 会话、收发和权限应答、模型目录探测、空闲退出。
- `src/turn.ts`：一个 turn 的事件队列和阶段，agy 自己的工作何时算结束的判定。
- `src/acp.ts`：NDJSON JSON-RPC 和进程组生命周期。
- `src/subagents.ts` / `src/pi-agent.mjs`：pi-web 子代理。MCP 协议和 unix socket 在插件里，`pi-agent.mjs` 是 agy 拉起的中继和 `wait` 命令。
- `src/bindings.ts` / `src/replay.ts` / `src/mirror.ts` / `src/catalog.ts`：会话映射、历史转录、工具卡片形状、模型缓存。
- `docs/research/agy-acp-handshake.md`：agy 实测的协议形状。改协议处理前先对照这份文档；agy 升级后用 `docs/research/probe/` 重新实测。

## 文档与提交规范

- 仓库是公开的。代码、文档、测试、提交信息里不要出现个人路径、账号、邮箱、会话 id、订阅信息或本地私有配置。
- 文档写结论和约定，不写开发流水账。
