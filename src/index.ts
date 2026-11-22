// pi-agy-acp: Antigravity CLI (`agy acp`) as the pi provider "antigravity".
import { spawn } from "node:child_process";
import { createProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type Binding, type BindingFile, inputHash } from "./bindings.ts";
import { PROVIDER_ID, toPiModels } from "./catalog.ts";
import { MIRROR_TOOLS, mirrorResult } from "./mirror.ts";
import { createStreamSimple, type Instance } from "./provider.ts";
import { type AcpSession, getRuntime, type Runtime } from "./runtime.ts";

const MIRROR_LABELS: Record<string, string> = {
  agy_bash: "agy 命令",
  agy_edit: "agy 编辑",
  agy_write: "agy 写文件",
  agy_read: "agy 读文件",
  agy_tool: "agy 工具",
  agy_todo: "agy 计划",
};

export default function piAgyAcp(pi: ExtensionAPI) {
  const rt = getRuntime();
  let ctx: any;
  let session: AcpSession | undefined;
  let file: BindingFile | undefined;
  let binding: Binding | undefined;

  const inst: Instance = {
    runtime: rt,
    ctx: () => ctx,
    sessionId: () => ctx?.sessionManager?.getSessionId?.(),
    onTitle: (title) => {
      try { if (!pi.getSessionName()) pi.setSessionName(title); } catch {}
    },
    attach: (s, f, b) => { session = s; file = f; binding = b; },
    session: () => session,
  };

  const isOurModel = () => ctx?.model?.provider === PROVIDER_ID;

  // -- provider ---------------------------------------------------------------
  const streamSimple = createStreamSimple(inst);
  const registerProvider = () => {
    pi.registerProvider(createProvider({
      id: PROVIDER_ID,
      name: "Antigravity",
      auth: {
        apiKey: {
          name: "Antigravity CLI",
          // Ambient: the official CLI owns the login; we only report whether it is installed.
          resolve: async () => (rt.agyPath() ? { auth: {}, source: "Antigravity CLI (agy)" } : undefined),
        },
      },
      models: toPiModels(rt.catalog) as any,
      api: { stream: streamSimple as any, streamSimple: streamSimple as any },
    }));
  };
  registerProvider();

  // -- mirror tools: executable for pi's loop, hidden from every model --------
  const params = Type.Object({}, { additionalProperties: true });
  for (const name of MIRROR_TOOLS) {
    pi.registerTool({
      name,
      label: MIRROR_LABELS[name],
      description: "Internal display mirror of an action Antigravity (agy) already performed. Never call this tool.",
      parameters: params,
      // each mirror hides itself, so deactivating one never exposes the others
      prepareLoadout: () => ({ hiddenDeclarations: [name] }),
      async execute(toolCallId, _params, signal, onUpdate, toolCtx) {
        ctx = toolCtx ?? ctx;
        const owner = session?.tools.has(toolCallId) ? session : undefined;
        if (!owner) {
          return { content: [{ type: "text", text: "找不到这次 agy 工具调用的状态（可能 agy 进程已重启）。" }], details: {}, isError: true };
        }
        const onAbort = () => rt.cancel(owner);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        let lastStatus = "";
        try {
          const state = await owner.waitTool(toolCallId, signal, (s) => {
            const status = s.status;
            if (status === lastStatus || !onUpdate) return;
            lastStatus = status;
            const note = s.status === "pending" ? "等待授权…" : s.status === "in_progress" ? "agy 正在执行…" : "";
            if (note) onUpdate({ content: [{ type: "text", text: note }], details: undefined as any });
          });
          return mirrorResult(state) as any;
        } finally {
          signal?.removeEventListener("abort", onAbort);
        }
      },
    });
  }

  // -- context capture --------------------------------------------------------
  const capture = (_event: unknown, c: any) => { ctx = c; };
  pi.on("session_start", capture);
  pi.on("before_agent_start", capture);
  pi.on("turn_start", capture);
  pi.on("model_select", capture);

  // Immediate steer: send to agy now; pi inserts the message at the next boundary and the
  // provider recognises it as already delivered.
  pi.on("input", (event: any, c: any) => {
    ctx = c;
    if (event.streamingBehavior !== "steer" || !isOurModel()) return { action: "continue" };
    const s = session;
    const turn = s?.activeTurn;
    const text = String(event.text ?? "").trim();
    // Only plain text goes out early: templates/skills expand after this hook and images still
    // need pi's normalisation, so those wait for pi's own delivery at the next boundary.
    if (!s || !turn || turn.ended || !text || text.startsWith("/") || event.images?.length) return { action: "continue" };
    const hash = inputHash(text);
    turn.delivered.push(hash);
    if (turn.pumping) turn.queue.push({ kind: "yield" });
    rt.debug.write("steer", { sessionId: s.id });
    rt.prompt(s, [{ type: "text", text }]).catch(() => {
      const at = turn.delivered.indexOf(hash);
      if (at >= 0) turn.delivered.splice(at, 1); // not sent: let pi's delivery send it
    });
    return { action: "continue" };
  });

  // live sessions follow catalog changes; services-only loads (pi-web's model list) never subscribe
  const onCatalog = () => registerProvider();
  pi.on("session_start", () => { rt.listeners.add(onCatalog); });

  pi.registerCommand("agy", {
    description: "Antigravity：status | models refresh | login | new | debug on|off | restart",
    getArgumentCompletions: (prefix: string) => {
      const items = ["status", "models refresh", "login", "new", "debug on", "debug off", "restart"];
      return items.filter((i) => i.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    handler: async (args, c) => {
      ctx = c;
      const [sub, ...rest] = args.trim().split(/\s+/);
      const arg = rest.join(" ");
      const notify = (msg: string, level: "info" | "warning" | "error" = "info") => c.ui.notify(msg, level);
      try {
        switch (sub || "status") {
          case "status": return notify(status(rt, session));
          case "models": {
            notify("正在探测 agy 模型和思考档位…");
            const cat = await rt.refreshCatalog();
            return notify(`已更新 ${cat.models.length} 个模型：${cat.models.map((m) => m.id).join(", ")}`);
          }
          case "login": return await login(rt, c);
          case "new": {
            const f = ensureFile();
            const old = session;
            f.bindings = [];
            rt.store.save(f);
            binding = undefined;
            session = undefined;
            if (old) await rt.closeSession(old.id);
            return notify("已断开当前 agy 会话；下次发送会新建会话并附上对话转录。");
          }
          case "debug": {
            if (arg === "off") { rt.debug.disable(); return notify("ACP 抓包已关闭"); }
            return notify(`ACP 抓包已开启：${rt.debug.enable()}`);
          }
          case "restart": {
            await rt.shutdown();
            return notify("agy 进程已停止，下次发送时会自动重启并接回会话。");
          }
          default: return notify(`未知子命令：${sub}`, "warning");
        }
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
  });

  const ensureFile = (): BindingFile => {
    const id = inst.sessionId() ?? "unbound";
    if (file?.piSessionId !== id) file = rt.store.load(id);
    return file;
  };

  pi.on("session_shutdown", () => {
    rt.listeners.delete(onCatalog);
    if (session?.owner === inst) session.owner = undefined;
    rt.armIdle();
  });
}

function status(rt: Runtime, session: AcpSession | undefined): string {
  const lines = [
    `agy：${rt.agyPath() ?? "未找到"}${rt.agyVersion ? ` v${rt.agyVersion}` : ""}`,
    `进程：${rt.proc?.alive ? `运行中 pid ${rt.proc.pid}` : "未启动"}${rt.lastExit ? `（上次退出 ${rt.lastExit}）` : ""}`,
    `订阅：${rt.catalog.tier ?? "未知"}`,
    `当前会话：${session ? session.id : "未绑定"}${session ? `，model=${session.current("model")} thought=${session.current("thought_level") ?? "-"}` : ""}`,
    `ACP 抓包：${rt.debug.enabled ? rt.debug.file : "关闭"}`,
  ];
  return lines.join("\n");
}

/** Official terminal login (`agy acp --login`): show the URL, collect the code, verify. */
async function login(rt: Runtime, c: any): Promise<void> {
  const command = rt.agyPath();
  if (!command) return c.ui.notify("找不到 agy 可执行文件。", "error");
  // Without a display agy prints the URL instead of opening a local browser.
  const child = spawn(command, ["acp", "--login"], { env: rt.childEnv({ DISPLAY: undefined, WAYLAND_DISPLAY: undefined, BROWSER: undefined }), stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {}); // EPIPE if it already exited; reported via the exit code
  let out = "";
  const exited = new Promise<number | null>((r) => {
    child.on("exit", (code) => r(code));
    child.on("error", (err) => { out += String(err); r(-1); });
  });
  try {
    await loginFlow(rt, c, child, exited, () => out, (s) => { out += s; });
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

async function loginFlow(rt: Runtime, c: any, child: ReturnType<typeof spawn>, exited: Promise<number | null>, output: () => string, append: (s: string) => void): Promise<void> {
  const url = await new Promise<string | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 20_000);
    const onData = (d: Buffer) => {
      append(d.toString());
      const m = output().match(/https:\/\/accounts\.google\.com\/\S+/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    void exited.then(() => { clearTimeout(timer); resolve(undefined); });
  });
  if (!url) return c.ui.notify(`agy acp --login 没有给出登录链接：\n${output().slice(-500)}`, "error");
  c.ui.notify(`在浏览器中打开并登录：${url}`, "info");
  const code = await c.ui.input(`在浏览器打开下面的链接，用 Google 账号登录，把授权码（或最后跳转页面的完整 URL）粘贴到这里：\n\n${url}`, "授权码或回调 URL", { timeout: 600_000 });
  if (!code?.trim()) return c.ui.notify("已取消登录。", "warning");
  child.stdin!.write(code.trim() + "\n");
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([exited, new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), 120_000); })]);
  clearTimeout(timer);
  if (result === "timeout") return c.ui.notify("等待 agy 完成登录超时。", "error");
  if (result !== 0) return c.ui.notify(`登录失败（exit ${result}）：\n${output().slice(-500)}`, "error");
  await rt.shutdown(); // next start picks up the new credentials
  try {
    await rt.listSessionIds();
    c.ui.notify("Antigravity 登录成功。", "info");
  } catch (err) {
    c.ui.notify(`登录后验证失败：${err instanceof Error ? err.message : String(err)}`, "error");
  }
}
