// pi-web sub-agents for agy: an MCP tool agy calls to start one, a command it runs to wait for it.
// agy gives an MCP call at most 180 s, so the tool returns at once; the wait runs as agy's own
// background command, which wakes agy with the report when the agent finishes.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { isSubagentTool, isTerminal } from "./mirror.ts";
import type { AcpSession } from "./runtime.ts";

/** pi-web's host bridge (lib/subagent-bridge.ts there). Absent in the pi TUI. */
const BRIDGE_KEY = Symbol.for("pi-web.subagent-bridge.v1");
const TOOL = "subagent";
const CLI = fileURLToPath(new URL("./pi-agent.mjs", import.meta.url));
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

interface BridgeRun { run: { sessionId: string; profile: string; description: string; status: string }; details: Record<string, any> }
interface Available { profiles: { name: string; description: string; model?: string; thinking?: string; inheritContext: boolean }[]; models: string[] }
interface Bridge {
  version: 1;
  available(parentSessionId: string): Available | null;
  start(r: { parentSessionId: string; parentToolCallId: string; profile: string; task: string; description: string; model?: string; thinking?: string }): Promise<BridgeRun>;
  resume(r: { parentSessionId: string; parentToolCallId: string; sessionId: string; task: string }): Promise<BridgeRun>;
  wait(sessionId: string): Promise<BridgeRun & { text: string }>;
}

function bridge(): Bridge | undefined {
  const b = (globalThis as any)[BRIDGE_KEY];
  return b?.version === 1 ? b : undefined;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** One per pi process (lives on the runtime): the socket agy's helper processes connect to. */
export class SubagentHost {
  readonly socket: string;
  private server: net.Server | undefined;
  /** MCP server token → the pi session it was started for. */
  private readonly tokens = new Map<string, string>();
  private readonly sessions: Map<string, AcpSession>;
  private readonly log: (kind: string, data: unknown) => void;

  constructor(home: string, sessions: Map<string, AcpSession>, log: (kind: string, data: unknown) => void) {
    this.socket = path.join(home, `agents-${process.pid}.sock`);
    this.sessions = sessions;
    this.log = log;
  }

  /** `mcpServers` for session/new or session/resume: ours where pi-web lets this pi session delegate. */
  mcpServers(piSessionId: string | undefined): any[] {
    const b = bridge();
    if (!b || !piSessionId || !b.available(piSessionId)) return [];
    this.listen();
    const token = crypto.randomUUID();
    this.tokens.set(token, piSessionId);
    return [{ name: "pi", command: process.execPath, args: [CLI, "mcp", this.socket], env: [{ name: "PI_AGY_MCP_TOKEN", value: token }] }];
  }

  waitCommand(ids: string[]): string {
    return [process.execPath, CLI, "wait", "--socket", this.socket].map(quote).concat(ids).join(" ");
  }

  private listen(): void {
    if (this.server) return;
    fs.rmSync(this.socket, { force: true }); // left by a crashed process with our pid
    const server = net.createServer((c) => this.connection(c));
    server.on("error", (err) => this.log("agents-socket", String(err)));
    server.listen(this.socket);
    server.unref();
    process.once("exit", () => fs.rmSync(this.socket, { force: true }));
    this.server = server;
  }

  private connection(c: net.Socket): void {
    c.on("error", () => {});
    let piSessionId: string | undefined;
    readline.createInterface({ input: c }).on("line", (line) => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return c.destroy(); }
      if (piSessionId) return void this.mcp(c, piSessionId, msg);
      // the first line says who is calling
      if (typeof msg?.mcp === "string" && this.tokens.has(msg.mcp)) piSessionId = this.tokens.get(msg.mcp);
      else if (Array.isArray(msg?.wait)) void this.wait(c, msg.wait.map(String));
      else c.destroy();
    });
  }

  private async mcp(c: net.Socket, piSessionId: string, msg: any): Promise<void> {
    if (msg?.id === undefined || typeof msg.method !== "string") return; // notifications
    const send = (body: object) => { if (!c.destroyed) c.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...body }) + "\n"); };
    switch (msg.method) {
      case "initialize":
        return send({ result: { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "pi", version: "1" } } });
      case "ping":
        return send({ result: {} });
      case "tools/list": {
        // shortcut: read when agy starts the server; profile or model changes apply from the next session/resume
        const available = bridge()?.available(piSessionId);
        return send({ result: { tools: available ? [toolSpec(available)] : [] } });
      }
      case "tools/call":
        return send({ result: await this.call(piSessionId, msg.params ?? {}) });
      default:
        return send({ error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
  }

  private async call(tokenSessionId: string, params: any): Promise<object> {
    const reply = (text: string, isError = false) => ({ content: [{ type: "text", text }], isError });
    const b = bridge();
    if (params.name !== TOOL) return reply(`Unknown tool: ${params.name}`, true);
    if (!b) return reply("Pi Web sub-agents are not available here.", true);
    const args = params.arguments ?? {};
    const meta = params._meta ?? {};
    const acp = this.sessions.get(meta["antigravity.google/root_conversation_id"] ?? meta["antigravity.google/conversation_id"]);
    let parentSessionId = tokenSessionId;
    try { parentSessionId = acp?.owner?.sessionId() ?? tokenSessionId; } catch {} // a disposed session's ctx throws
    // agy announces the call (tool_call, permission) before it reaches us, one call at a time:
    // that card is the parent tool call the child links back to
    const card = acp && [...acp.tools.values()].reverse().find((t) => isSubagentTool(t.name) && !t.subagent && !isTerminal(t));
    const parentToolCallId = card?.id ?? `agy-${crypto.randomUUID()}`;
    const prompt = str(args.prompt);
    const resume = str(args.resume);
    if (!prompt) return reply("prompt is required.", true);
    if (resume && (args.model || args.thinking)) return reply("resume keeps the agent's model and thinking; omit model and thinking, or start a new agent.", true);
    try {
      const started = resume
        ? await b.resume({ parentSessionId, parentToolCallId, sessionId: resume, task: prompt })
        : await b.start({
          parentSessionId,
          parentToolCallId,
          profile: str(args.subagent_type) ?? "general-purpose",
          task: prompt,
          description: str(args.description) ?? "",
          ...(str(args.model) ? { model: str(args.model) } : {}),
          ...(str(args.thinking) ? { thinking: str(args.thinking) } : {}),
        });
      if (card) card.subagent = started.details;
      const id = started.run.sessionId;
      return reply([
        `Started pi agent ${id}.`,
        "To get its report, run this shell command in the background. It prints the report and exits when the agent finishes (often several minutes), and you are notified then:",
        this.waitCommand([id]),
        `To wait for several agents, put all their ids at the end of one such command. To follow up after it finishes, call ${TOOL} again with resume: "${id}".`,
      ].join("\n"));
    } catch (err) {
      return reply(err instanceof Error ? err.message : String(err), true);
    }
  }

  private async wait(c: net.Socket, ids: string[]): Promise<void> {
    const b = bridge();
    const parts = b
      ? await Promise.all(ids.map(async (id) => {
        try {
          const { run, text } = await b.wait(id);
          return `## pi agent ${id} (${run.profile}: ${run.description}): ${run.status}\n\n${text}\n\n[To follow up, call ${TOOL} with resume: "${id}"]`;
        } catch (err) {
          return `## pi agent ${id}\n\n${err instanceof Error ? err.message : String(err)}`;
        }
      }))
      : ["Pi Web sub-agents are not available in this process."];
    if (!c.destroyed) c.end(JSON.stringify({ ok: !!b, text: parts.join("\n\n") }) + "\n");
  }
}

function toolSpec(a: Available): object {
  const types = a.profiles.map((p) => {
    const extra = [p.model && `default model ${p.model}`, p.thinking && `default thinking ${p.thinking}`, p.inheritContext ? "sees this conversation's text" : "sees only your prompt"].filter(Boolean);
    return `- ${p.name}: ${p.description} (${extra.join("; ")})`;
  });
  const names = a.profiles.map((p) => p.name);
  return {
    name: TOOL,
    description: [
      "Delegate a task to a pi agent: a separate pi session, inspectable by the user, that can use another model (Claude, GPT, ...).",
      "Only call this when the user explicitly asks for a pi agent or a model from pi. Never delegate on your own; a request for a subagent that does not mention pi is not for this tool.",
      "It returns at once with the agent's id and a shell command; run that command in the background to receive the report when the agent finishes.",
      "To give a finished agent a follow-up task, call this again with resume set to its id.",
      "",
      "Agent types:",
      ...types,
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The complete task. Unless the type sees this conversation, include the goal, file paths and what to focus on." },
        description: { type: "string", description: "Short label shown to the user." },
        subagent_type: { type: "string", enum: names, description: `Agent type. ${names.includes("general-purpose") ? "Default: general-purpose." : "Required."}` },
        model: { type: "string", ...(a.models.length ? { enum: a.models } : {}), description: "Pass only when the user names a model; otherwise the type's default is used. New agents only." },
        thinking: { type: "string", enum: THINKING, description: "Pass only when the user names a thinking level. New agents only." },
        resume: { type: "string", description: "Id of a finished agent to continue with a new prompt. It keeps its model and settings." },
      },
      required: ["prompt"],
    },
  };
}
