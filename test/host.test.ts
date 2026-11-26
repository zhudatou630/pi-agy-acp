// How pi-web hosts the provider: shared model runtimes, side requests, tool presets, compaction.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { SEED_CATALOG } from "../src/catalog.ts";
import { assistants, createSession, lastText, runtime, setupEnv, sleep, until } from "./helpers.ts";

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
  // the finished child stays registered as the provider: its disposed ctx throws on any access
  child.session.dispose();
  await parent.session.prompt("parent four");
  assert.equal(promptSid(), parentAcp);
  const src = parent.session.agent;
  const side = new Agent({ initialState: { systemPrompt: "", model: src.state.model, thinkingLevel: "low", tools: [], messages: [...src.state.messages] }, convertToLlm: src.convertToLlm, streamFn: src.streamFunction, getApiKey: src.getApiKey, sessionId: src.sessionId } as any);
  await side.prompt("a maintenance request through the dead child's registration");
  assert.equal((side.state.messages.at(-1) as any).stopReason, "stop");
  assert.equal(env.frames().findLast((f) => f.method === "session/new").params.cwd, env.cwd, "it runs in the session's directory");
});

test("a subagent whose profile loads no extensions answers from throwaway sessions and leaves the parent alone", async () => {
  const parent = await createSession(env);
  await parent.session.prompt("parent one");
  const parentAcp = promptSid();
  // pi-web's built-in profiles: the parent's model runtime (and provider), but no instance of this extension
  const child = await createSession(env, { modelRuntime: parent.services.modelRuntime, extension: false });
  await child.session.prompt("child one");
  assert.match(lastText(child.session), /child one$/);
  assert.notEqual(promptSid(), parentAcp);
  assert.equal(assistants(child.session).at(-1).responseId, undefined, "no ACP session of its own to continue");
  await parent.session.prompt("parent two");
  assert.equal(promptSid(), parentAcp);
});

test("a side chat sends its parent's session id and still gets its own ACP session", async () => {
  const main = await createSession(env);
  await main.session.prompt("main one");
  const mainAcp = promptSid();
  const side = await createSession(env);
  side.session.agent.sessionId = main.session.sessionId; // pi-web: the parent's id is the side chat's cache key
  await side.session.prompt("side one");
  const sideAcp = promptSid();
  assert.notEqual(sideAcp, mainAcp);
  assert.match(assistants(side.session).at(-1).responseId, /^agy:/);
  await side.session.prompt("side two");
  assert.equal(promptSid(), sideAcp);
  await main.session.prompt("main two");
  assert.equal(promptSid(), mainAcp);
  assert.deepEqual(env.prompts().at(-1).params.prompt, [{ type: "text", text: "main two" }]);
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
  // the same while the session is busy: being busy does not make the request part of its run
  const run = session.prompt("SCRIPT:slow");
  await until(() => env.prompts().at(-1).params.sessionId === sid && JSON.stringify(env.prompts().at(-1).params.prompt).includes("SCRIPT:slow"), 5000);
  const busyNamer = new Agent({
    initialState: { systemPrompt: src.state.systemPrompt, model: src.state.model, thinkingLevel: src.state.thinkingLevel, tools: [], messages: src.state.messages.filter((m: any) => m.role !== "user" || !JSON.stringify(m.content).includes("SCRIPT:slow")) },
    convertToLlm: src.convertToLlm, transformContext: src.transformContext, streamFn: src.streamFunction, getApiKey: src.getApiKey, sessionId: src.sessionId,
  } as any);
  await busyNamer.prompt("Create a concise title for this session, again.");
  assert.notEqual(promptSid(), sid, "the running reply is not steered by the title request");
  await run;
  assert.match(lastText(session), /chunk29 $/, "the reply ran to its end");
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

test("/agy compact leaves Stop in force and waits for an open reply", async () => {
  const { session, mock } = await createSession(env);
  await session.prompt("one");
  const sid = promptSid();
  const slow = session.prompt("SCRIPT:slow");
  await until(() => JSON.stringify(env.prompts().at(-1).params.prompt).includes("SCRIPT:slow"), 5000);
  await session.prompt("/agy compact");
  assert.match(mock.calls.filter((c) => c.method === "notify").at(-1)!.args[0], /still working/);
  assert.equal(compacts(sid).length, 0);
  await slow;
  assert.match(lastText(session), /chunk29 $/, "the open reply kept its output");
  // Stop, then compact at once: what agy still does for the stopped work stays refused
  const run = session.prompt("SCRIPT:stoplate");
  await sleep(300);
  await session.abort();
  await run;
  await session.prompt("/agy compact");
  assert.equal(compacts(sid).length, 1);
  await until(() => env.frames().some((f) => f.lateOutcome), 5000);
  assert.equal(env.frames().find((f) => f.lateOutcome).lateOutcome, "deny");
  await sleep(300);
  assert.ok(!session.messages.some((m: any) => m.role === "custom" && m.customType === "agy-wake"));
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
