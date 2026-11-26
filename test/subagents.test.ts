// pi-web sub-agents offered to agy: its MCP tool starts one through pi-web's bridge, its wait command delivers the report.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSession, lastText, runtime, setupEnv, sleep } from "./helpers.ts";

const env = setupEnv("subagents", {}, { wakeSettle: 400 });
after(async () => { await runtime()?.shutdown(); });

/** pi-web's bridge (lib/subagent-bridge.ts): only sessions in `allowed` may delegate. */
const allowed = new Set<string>();
const calls: { method: string; request: any }[] = [];
const run = (description: string, status: string) => ({ sessionId: "child-1", profile: "explore", description, status });
(globalThis as any)[Symbol.for("pi-web.subagent-bridge.v1")] = {
  version: 1,
  available: (id: string) => (allowed.has(id) ? { profiles: [{ name: "explore", description: "Read code", inheritContext: false }], models: ["claude/opus"] } : null),
  start: async (request: any) => {
    calls.push({ method: "start", request });
    return { run: run(request.description, "queued"), details: { kind: "pi-web-subagent", sessionId: "child-1", status: "queued" } };
  },
  resume: async (request: any) => {
    calls.push({ method: "resume", request });
    return { run: run("review a.ts", "queued"), details: { kind: "pi-web-subagent", sessionId: "child-1", status: "queued" } };
  },
  wait: async (id: string) => {
    await sleep(300); // the agent works for a while
    return { run: run("review a.ts", "completed"), details: {}, text: `report of ${id}: looks fine` };
  },
};

/** session/new requests from `from` on (the catalog probe opens throwaway ones too). */
const news = (from: number) => env.frames().slice(from).filter((f) => f.method === "session/new");

test("agy starts a pi-web sub-agent through its MCP tool and gets the report from the wait command", async () => {
  const { session } = await createSession(env);
  const sid = session.sessionManager.getSessionId();
  allowed.add(sid);
  const from = env.frames().length;
  await session.prompt("SCRIPT:subagent");

  assert.deepEqual(news(from).map((f) => f.params.mcpServers[0]?.name).filter(Boolean), ["pi"], "only the chat's session gets it, not the catalog probe");
  const tools = env.frames().findLast((f) => f.mcpTools).mcpTools;
  assert.deepEqual(tools.map((t: any) => t.name), ["subagent"]);
  assert.match(tools[0].description, /Only call this when the user explicitly asks/);
  assert.deepEqual(tools[0].inputSchema.properties.subagent_type.enum, ["explore"]);
  assert.deepEqual(tools[0].inputSchema.properties.model.enum, ["claude/opus"]);

  const start = calls.findLast((c) => c.method === "start")!.request;
  assert.equal(start.parentSessionId, sid);
  assert.equal(start.parentToolCallId, "call_sub", "agy's tool card is the parent tool call");
  assert.deepEqual([start.profile, start.task, start.model], ["explore", "review a.ts", "claude/opus"]);

  const card = session.messages.find((m: any) => m.role === "toolResult" && m.toolCallId === "call_sub");
  assert.equal(card.details.kind, "pi-web-subagent", "pi-web links the card to the child session");
  assert.equal(card.details.sessionId, "child-1");
  const call = session.messages.flatMap((m: any) => (m.role === "assistant" ? m.content : [])).find((c: any) => c.id === "call_sub");
  assert.equal(call.arguments.title, "pi agent: review a.ts");
  assert.match(lastText(session), /report received: ## pi agent child-1 \(explore: review a\.ts\): completed\n\nreport of child-1: looks fine/);
});

test("a follow-up resumes the finished agent", async () => {
  const { session } = await createSession(env);
  allowed.add(session.sessionManager.getSessionId());
  await session.prompt("SCRIPT:subagent resume");
  const resume = calls.findLast((c) => c.method === "resume")!.request;
  assert.deepEqual([resume.sessionId, resume.task], ["child-1", "and now the tests"]);
  assert.match(lastText(session), /report of child-1/);
});

test("a session pi-web does not let delegate gets no MCP server", async () => {
  const { session } = await createSession(env);
  const from = env.frames().length;
  await session.prompt("SCRIPT:subagent");
  assert.deepEqual(news(from).map((f) => f.params.mcpServers), [[]]);
  assert.equal(lastText(session), "no pi tool");
});

test("on a fresh install the socket's directory is created, and waiting for an unknown agent fails", async () => {
  const { SubagentHost } = await import("../src/subagents.ts");
  const { execFile } = await import("node:child_process");
  const home = `${env.root}/fresh/home`; // does not exist yet
  allowed.add("fresh");
  const host = new SubagentHost(home, new Map(), () => {});
  assert.equal(host.mcpServers("fresh")[0].name, "pi");
  (globalThis as any)[Symbol.for("pi-web.subagent-bridge.v1")].wait = async (id: string) => { throw new Error(`Unknown subagent: ${id}`); };
  const [cmd, ...args] = host.waitCommand(["nope"]).split(" ").map((a: string) => a.replace(/^'|'$/g, ""));
  const result = await new Promise<{ code: number | null; out: string }>((r) => execFile(cmd, args, (err, out) => r({ code: err ? (err as any).code : 0, out })));
  assert.equal(result.code, 1);
  assert.match(result.out, /Unknown subagent: nope/);
});
