// How pi-web hosts the provider: shared model runtimes, side requests, tool presets, compaction.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { SEED_CATALOG } from "../src/catalog.ts";
import { assistants, createSession, lastText, runtime, setupEnv } from "./helpers.ts";

const env = setupEnv("host");
// the catalog remembers the agy version of the last run; the fake reports another one
fs.writeFileSync(path.join(env.home, "catalog.json"), JSON.stringify({ ...SEED_CATALOG, agyVersion: "1.0.0", fetchedAt: Date.now() }));
after(async () => { await runtime()?.shutdown(); });

const promptSid = () => env.prompts().at(-1).params.sessionId;
const compacts = (sid: string) => env.prompts().filter((p) => p.params.sessionId === sid && p.params.prompt[0]?.text === "/compact");

test("an agy update since the last run is announced once", async () => {
  const { session, mock } = await createSession(env);
  await session.prompt("one");
  await session.prompt("two");
  const notices = mock.calls.filter((c) => c.method === "notify" && /agy updated from 1\.0\.0 to 1\.5\.14-fake/.test(c.args[0]));
  assert.equal(notices.length, 1);
});

test("a bare /agy offers its subcommands", async () => {
  const { session, mock } = await createSession(env);
  mock.answers.select = (options) => options.find((o) => o === "status");
  await session.prompt("/agy");
  assert.deepEqual(mock.calls.find((c) => c.method === "select")!.args[1].slice(0, 2), ["status", "models refresh"]);
  assert.match(mock.calls.filter((c) => c.method === "notify").at(-1)!.args[0], /^agy: .*\nProcess: /);
});

test("a subagent that loads the extension into its parent's model runtime does not take over the parent", async () => {
  const parent = await createSession(env);
  await parent.session.prompt("parent one");
  const parentAcp = promptSid();
  // pi-web creates the child's services on the parent's ModelRuntime: its provider registration replaces the parent's
  const child = await createSession(env, { modelRuntime: parent.services.modelRuntime });
  await parent.session.prompt("SCRIPT:tools");
  assert.equal(promptSid(), parentAcp, "the parent keeps its ACP session");
  assert.match(assistants(parent.session).at(-1).responseId, /^agy:/);
  assert.equal(lastText(parent.session), "All done.", "tools run with permission, as in any chat");
  assert.equal(parent.session.messages.filter((m: any) => m.role === "toolResult").length, 3, "mirror cards");
  await child.session.prompt("child one");
  const childAcp = promptSid();
  assert.notEqual(childAcp, parentAcp, "the child has its own ACP session");
  assert.match(assistants(child.session).at(-1).responseId, /^agy:/);
  await parent.session.prompt("parent three");
  assert.equal(promptSid(), parentAcp);
  assert.deepEqual(env.prompts().at(-1).params.prompt, [{ type: "text", text: "parent three" }]);
});

test("a request made with the session's id outside its agent run (pi-web auto-name) stays out of the ACP session", async () => {
  const { session } = await createSession(env);
  await session.prompt("first question");
  const sid = promptSid();
  const src = session.agent;
  // lib/session-title.ts: a temporary Agent with the session's stream function and session id
  const namer = new Agent({
    initialState: { systemPrompt: src.state.systemPrompt, model: src.state.model, thinkingLevel: src.state.thinkingLevel, tools: [], messages: [...src.state.messages] },
    convertToLlm: src.convertToLlm, transformContext: src.transformContext, streamFn: src.streamFunction, getApiKey: src.getApiKey, sessionId: src.sessionId,
  } as any);
  await namer.prompt("Create a concise title for this session.");
  const title: any = namer.state.messages.at(-1);
  assert.equal(title.stopReason, "stop");
  assert.notEqual(promptSid(), sid, "the title request ran in a throwaway session");
  await session.prompt("second question");
  assert.equal(promptSid(), sid, "the chat continues its ACP session");
  assert.deepEqual(env.prompts().at(-1).params.prompt, [{ type: "text", text: "second question" }]);
});

test("a session without write-capable tools tells agy so on every prompt", async () => {
  const { session } = await createSession(env);
  await session.prompt("with default tools");
  assert.deepEqual(env.prompts().at(-1).params.prompt, [{ type: "text", text: "with default tools" }]);
  // like pi-web's read-only preset: built-ins are replaced, extension tools (the mirrors) stay active
  const mirrors = session.getActiveToolNames().filter((n: string) => n.startsWith("agy_"));
  session.setActiveToolsByName(["read", "grep", "find", "ls", ...mirrors]);
  await session.prompt("look around");
  const sent = env.prompts().at(-1).params.prompt;
  assert.match(sent[0].text, /^\[pi: read-only session\./);
  assert.match(sent.at(-1).text, /look around$/);
  session.setActiveToolsByName(["read", "bash", "edit", "write", ...mirrors]);
  await session.prompt("write again");
  assert.deepEqual(env.prompts().at(-1).params.prompt, [{ type: "text", text: "write again" }]);
});

test("pi compaction also compacts the agy session, then summarizes as before", async () => {
  const { session } = await createSession(env, { settings: { compaction: { enabled: false, keepRecentTokens: 50, reserveTokens: 100 } } });
  for (const t of ["a", "b", "c", "d"]) await session.prompt(`turn ${t} ` + "lorem ipsum ".repeat(400));
  const sid = promptSid();
  const before = env.frames().length;
  await session.compact();
  assert.equal(compacts(sid).length, 1, "agy's own /compact ran in the chat's ACP session");
  const fresh = env.frames().slice(before).filter((f) => f.method === "session/prompt");
  assert.equal(fresh[0].params.sessionId, sid, "agy compacts first");
  const summary = fresh.find((f) => f.params.sessionId !== sid);
  assert.ok(summary, "pi's summary still runs, in a throwaway session");
  assert.ok(env.frames().some((f) => f.method === "session/close" && f.params.sessionId === summary.params.sessionId));
  assert.ok(session.sessionManager.getEntries().some((e: any) => e.type === "compaction"));
  await session.prompt("after compaction");
  assert.equal(promptSid(), sid);
  assert.deepEqual(env.prompts().at(-1).params.prompt, [{ type: "text", text: "after compaction" }]);
});

test("/agy compact compacts only the agy session", async () => {
  const { session, mock } = await createSession(env);
  await session.prompt("/agy compact");
  assert.match(mock.calls.filter((c) => c.method === "notify").at(-1)!.args[0], /No agy session/);
  await session.prompt("one");
  const sid = promptSid();
  const entries = session.sessionManager.getEntries().length;
  const sessionsBefore = env.frames().filter((f) => f.method === "session/new").length;
  await session.prompt("/agy compact");
  assert.equal(compacts(sid).length, 1);
  assert.equal(env.frames().filter((f) => f.method === "session/new").length, sessionsBefore, "no summary session");
  assert.equal(session.sessionManager.getEntries().length, entries, "pi's history is untouched");
  assert.match(mock.calls.filter((c) => c.method === "notify").at(-1)!.args[0], /compacted/i);
  await session.prompt("two");
  assert.equal(promptSid(), sid);
  assert.deepEqual(env.prompts().at(-1).params.prompt, [{ type: "text", text: "two" }]);
});

test("/agy compact after a restart resumes the chat's ACP session first", async () => {
  const { session } = await createSession(env);
  await session.prompt("one");
  const sid = promptSid();
  await runtime().shutdown();
  const before = env.frames().length;
  await session.prompt("/agy compact");
  const fresh = env.frames().slice(before);
  assert.ok(fresh.some((f) => f.method === "session/resume" && f.params.sessionId === sid));
  assert.ok(fresh.some((f) => f.method === "session/set_config_option" && f.params.configId === "model" && f.params.value === "gemini-3.8-flash"), "resume resets the model: set it before compacting");
  assert.equal(compacts(sid).length, 1);
});
