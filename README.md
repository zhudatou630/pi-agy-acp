# pi-agy-acp

一个 [pi](https://pi.dev) 扩展包：通过官方 Antigravity CLI 自带的 ACP 服务端（`agy acp`），把 Antigravity 的模型接成 pi 的 provider `antigravity`，主要针对 pi-web 优化。

定位是“在 pi 里用 Antigravity 的模型”，而不是在 pi 里再套一个 Antigravity 客户端：

- agy 执行过的命令、读写的文件、做过的编辑，都显示成 pi 原生的工具卡片（命令和输出、并排 diff）。
- 模型和思考档位直接取自 agy。
- 会话能在重启后接上。
- 运行中可以继续发消息，也可以随时停止。

> 非官方项目，与 Google 无关。使用时请遵守 Antigravity 的服务条款。

## 前提

- 已安装 Antigravity CLI（`agy --version` 为 1.5.x 或更高），并且已经在终端里用 `agy` 登录过。插件直接复用 CLI 的登录状态，不另外保存或读取任何凭证。
- pi 1.6.x；用 pi-web 或终端里的 pi 都可以。

## 安装

在 `~/.pi/agent/settings.json` 的 `packages` 里加上本仓库。如果你用了 `enabledModels`，再把 antigravity 的模型加进去：

```jsonc
{
  "packages": [
    "git:github.com/zhudatou630/pi-agy-acp",
    // …原有条目
  ],
  "enabledModels": [
    "antigravity/*",          // 或者只列需要的模型，例如 "antigravity/gemini-4-neon"
    // …原有条目
  ]
}
```

也可以先 `git clone` 到本地，再把 `packages` 里那一项写成本地绝对路径。

然后重启 pi-web（或者在 pi 里执行 `/reload`），在模型选择器的 antigravity 分组里选 `Gemini 4 Neon` 等模型。思考档位用 pi 自带的 thinking level，模型不支持的档位会显示为不可选。

如果 agy 没有登录，在 pi 里执行 `/agy login`（走的是官方的 `agy acp --login` 流程），或者在终端里运行 `agy` 登录。

## 用法

- **权限**：完全放行，和 pi 一样没有审批，agy 会直接执行命令和修改文件，请只在你信任的目录里使用。agy 主动提问（让你在几个选项里挑一个）时会弹出选择框。
- **只读只是建议**：pi-web 的只读预设、side chat、只读的子代理靠 pi 的工具清单生效，对 agy 不起作用。这些场合插件会告诉 agy“本次请求不要改文件、不要运行会改动东西的命令”，但没有强制手段。
- **工具卡片**：`agy_bash`（命令及输出）、`agy_edit` / `agy_write`（并排 diff）、`agy_read`、`agy_tool`、`agy_todo`（计划）。这些卡片只用来展示，pi 不会把这些操作再执行一遍。
- **运行中发消息**：在 agy 工作时发的消息会立刻转给 agy。停止按钮会向 agy 发送 `session/cancel`。
- **后台命令**：agy 把耗时命令转到后台时，回复会一直等到命令结束，agy 的结果汇报会接在同一条回复里，和 pi 自己的 bash 一样。dev server 这类常驻进程不会占住回复；之后 agy 如果主动汇报，插件会自动开一轮回复显示出来。
- **语言**：插件自身的提示文字都是英文；agy 的回答语言跟随你提问的语言。
- **会话**：每个 pi 会话对应一个 agy 会话，重启后自动接上。fork 出来的会话会新开一个 agy 会话，并附上之前的对话转录。这些会话也会出现在 agy CLI 的会话列表里，可以用 `agy --conversation <id>` 接着聊（`/agy status` 可以看到 id），但不要两边同时用同一个会话。
- **压缩**：pi 的 `/compact`（和 pi-web 的压缩按钮）会先让 agy 压缩自己的上下文，再照常压缩 pi 的历史，比原来多一次请求。只想压缩 agy 那边就用 `/agy compact`，一次请求，pi 的历史不动。上下文占用在下一轮回复后更新。
- **pi-web 子代理**：子代理要用 antigravity 的模型，它的 profile 需要打开 `load_extensions`。pi-web 内置的 profile 默认没开，那样的子代理只能得到纯文字回答：没有工具卡片，命令会被拒绝，每轮之间也不共享上下文。
- **规则和约束**：插件不会把 pi 的 system prompt 发给 agy。agy 的规则写在 agy 自己的位置：项目里的 `AGENTS.md` / `GEMINI.md` / `.agents/rules/`，或者全局的 `~/.gemini/`。
- **agy 自带的 slash 命令**：不会注册到 pi。真要用的话，在 agy 模型下直接输入 `/goal …`，会原样发给 agy。
- **管理命令**：`/agy status | models refresh | login | new | compact | debug on|off | restart`。只输入 `/agy` 会列出这些子命令。

## 抓包核对

- 开启方式：用 `ACP_DEBUG=1` 启动 pi / pi-web，或者在 pi 里执行 `/agy debug on`。
- 抓包写到 `~/.pi/agent/pi-agy-acp/logs/acp-*.ndjson`，每帧一行，图片已脱敏。
- 只看发给 agy 的内容：`npm run acp:tail`；连同 agy 的回复一起看：`npm run acp:tail -- --all`。

## 文件位置

都在 `~/.pi/agent/pi-agy-acp/` 下（如果设置了 `PI_CODING_AGENT_DIR`，则跟随它）：

- `bindings/<pi会话id>.json`：pi 会话和 agy 会话的映射。
- `catalog.json`：模型和思考档位的缓存，离线启动时使用。
- `config.json`：可选配置，只有 `agyPath`（agy 不在 PATH 里时指定路径）和 `extraArgs`（额外的 `agy acp` 参数）两项。
- `logs/`：抓包文件。

## 开发与测试

```sh
npm install
npm test            # 单元测试 + 通过真实 pi SDK 跑的端到端测试（用 test/fake-agy 模拟 agy）
npm run typecheck
npm run smoke       # 连真实 agy 的冒烟测试（gemini-3.8-flash、low，会消耗少量额度）
```

设计见 [docs/design.md](docs/design.md)，调研见 [docs/research/](docs/research/README.md)，评审记录见 [docs/review-2026-11-22.md](docs/review-2026-11-22.md)。

## 许可证

[MIT](LICENSE)
