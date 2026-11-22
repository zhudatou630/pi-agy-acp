// End-to-end through the real pi SDK agent loop against the fake agy.
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";
import { assistants, createSession, lastText, runtime, setupEnv, sleep, until } from "./helpers.ts";

const env = setupEnv("e2e");
after(async () => { await runtime()?.shutdown(); });

test("text + thinking stream; only the user's text reaches agy", async () => {
  const { session } = await createSession(env);
  await session.prompt("SCRIPT:text");
  const a = assistants(session).at(-1);
  assert.equal(lastText(session), "Hello world");
  assert.equal(a.content.find((c: any) => c.type === "thinking")?.thinking, "thinking about it");
  assert.equal(a.stopReason, "stop");
  assert.match(a.responseId, /^agy:/);
  assert.equal(a.usage.totalTokens, 1234, "context usage comes from usage_update, not the cumulative total");
  const frames = env.frames();
  const init = frames.find((f) => f.method === "initialize");
  assert.equal(init.params.clientInfo.name, "pi-agy-acp");
  assert.deepEqual(init.params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  const created = frames.find((f) => f.method === "session/new" && f.params.cwd === env.cwd);
  assert.deepEqual(Object.keys(created.params).sort(), ["cwd", "mcpServers"]);
  const prompt = env.prompts().at(-1);
  // (the background catalog probe uses its own session; only look at the chat session)
  const sets = frames.filter((f) => f.method === "session/set_config_option" && f.params.sessionId === prompt.params.sessionId).map((f) => `${f.params.configId}=${f.params.value}`);
  assert.deepEqual(sets, ["model=gemini-3.8-flash", "thought_level=low"]);
  assert.deepEqual(prompt.params.prompt, [{ type: "text", text: "SCRIPT:text" }]);

  // warm follow-up: same ACP session, only the new input is sent
  await session.prompt("second message");
  assert.equal(env.frames().filter((f) => f.method === "session/new" && f.params.cwd === env.cwd).length, 1);
  assert.deepEqual(env.prompts().at(-1).params.prompt, [{ type: "text", text: "second message" }]);
  assert.match(lastText(session), /^echo\[gemini-3\.8-flash\/low\/default\]: second message$/);
});

test("agy tools become mirror cards with diff and command; permissions are granted; pi executes nothing itself", async () => {
  const { session } = await createSession(env);
  await session.prompt("SCRIPT:tools");
  const calls = assistants(session).flatMap((m: any) => m.content.filter((c: any) => c.type === "toolCall"));
  assert.deepEqual(calls.map((c: any) => c.name), ["agy_write", "agy_edit", "agy_bash"]);
  assert.deepEqual(calls[0].arguments, { path: "/tmp/fake-ws/a.txt", content: "hi\n" });
  // args come from whatever agy had reported when the card opened: rawInput or the diff block
  assert.match(JSON.stringify(calls[1].arguments), /^\{"path":"\/tmp\/fake-ws\/a\.txt","oldText":"hi(\\n)?","newText":"hello(\\n)?"\}$/);
  assert.deepEqual(calls[2].arguments, { command: "ls -la" });
  const results = session.messages.filter((m: any) => m.role === "toolResult");
  assert.equal(results.length, 3);
  assert.match(results[0].details.patch, /^--- \/dev\/null\n\+\+\+ b\/tmp\/fake-ws\/a\.txt\n@@ -0,0 \+1,1 @@\n\+hi\n$/);
  assert.match(results[1].details.patch, /@@ -1,1 \+1,1 @@\n-hi\n\+hello\n/);
  assert.equal(results[2].isError, false);
  assert.match(results[2].content[0].text, /^total 0\n/);
  assert.equal(lastText(session), "All done.");
  const perm = env.frames().filter((f) => f.result?.outcome).at(-1);
  assert.deepEqual(perm.result, { outcome: { outcome: "selected", optionId: "allow" } });
  // one ACP turn, one prompt frame, no re-sends during the tool continuations
  assert.equal(env.prompts().filter((p) => JSON.stringify(p.params.prompt).includes("SCRIPT:tools")).length, 1);
});

test("mirror tools are callable but hidden from model tool declarations", async () => {
  const { session } = await createSession(env);
  await session.prompt("hi");
  assert.ok(session.getActiveToolNames().includes("agy_bash"));
  const projected = await session.agent.transformContext!(session.agent.state.messages as any);
  const declared = projected.flatMap((m: any) => (m.role === "system" ? (m.toolsAdded ?? []).map((t: any) => t.name) : []));
  assert.ok(declared.length > 0, "built-in tools are still declared");
  assert.ok(!declared.some((n: string) => n.startsWith("agy_")), `hidden: ${declared.join(",")}`);
});

test("parallel tool calls land in one assistant message", async () => {
  const { session } = await createSession(env);
  await session.prompt("SCRIPT:parallel");
  const withTools = assistants(session).filter((m: any) => m.content.some((c: any) => c.type === "toolCall"));
  assert.equal(withTools.length, 1);
  assert.deepEqual(withTools[0].content.filter((c: any) => c.type === "toolCall").map((c: any) => c.name), ["agy_read", "agy_read"]);
  assert.equal(lastText(session), "read both");
});

test("abort sends session/cancel; the next prompt works", async () => {
  const { session } = await createSession(env);
  const run = session.prompt("SCRIPT:slow");
  await sleep(400);
  await session.abort();
  await run;
  assert.equal(assistants(session).at(-1).stopReason, "aborted");
  await until(() => env.frames().some((f) => f.method === "session/cancel"));
  await session.prompt("after abort");
  assert.match(lastText(session), /after abort$/);
});

test("steer mid-turn is sent to agy immediately, exactly once, and lands in order", async () => {
  const { session } = await createSession(env);
  const run = session.prompt("SCRIPT:slow");
  await sleep(350);
  await session.prompt("banana", { streamingBehavior: "steer" });
  await run;
  await session.agent.waitForIdle?.();
  await until(() => !session.isStreaming, 8000);
  const sent = env.prompts().filter((p) => JSON.stringify(p.params.prompt).includes("banana"));
  assert.equal(sent.length, 1, "steer sent once");
  const roles = session.messages.filter((m: any) => m.role !== "system").map((m: any) => m.role);
  const iBanana = session.messages.findIndex((m: any) => m.role === "user" && JSON.stringify(m.content).includes("banana"));
  assert.ok(iBanana > 0);
  assert.equal(session.messages[iBanana - 1].role, "assistant", roles.join(","));
  assert.match(lastText(session), /steer-received:banana/);
});

test("question requests go to a select dialog even in yolo mode", async () => {
  const { session, mock } = await createSession(env);
  mock.answers.select = (options) => options.find((o) => o === "Blue");
  await session.prompt("SCRIPT:question");
  assert.ok(mock.calls.some((c) => c.method === "select"));
  assert.equal(lastText(session), "picked:b");
});

test("plan updates become an agy_todo card", async () => {
  const { session } = await createSession(env);
  await session.prompt("SCRIPT:plan");
  const result = session.messages.find((m: any) => m.role === "toolResult" && m.toolName === "agy_todo");
  assert.match(result.content[0].text, /- \[x\] step one\n- \[ \] \*\*进行中\*\* step two/);
  assert.equal(lastText(session), "planned");
});

test("session title from agy names the pi session", async () => {
  const { session } = await createSession(env);
  await session.prompt("SCRIPT:title");
  assert.equal(session.sessionManager.getSessionName(), "Fake Title");
});

test("background tool: card says still running; later output shows folded at the next turn, no toast", async () => {
  const { session, mock } = await createSession(env);
  await session.prompt("SCRIPT:background");
  const result = session.messages.find((m: any) => m.role === "toolResult" && m.toolCallId === "bg");
  assert.match(result.content[0].text, /仍在后台运行/);
  await sleep(600); // let the background completion arrive
  assert.ok(!mock.calls.some((c) => c.method === "notify"), "no toast");
  await session.prompt("what happened");
  const a = assistants(session).at(-1);
  const thinking = a.content.find((c: any) => c.type === "thinking")?.thinking ?? "";
  assert.match(thinking, /background job printed ok/);
});

test("restart: resume via list check, config re-applied, no new session", async () => {
  const { session } = await createSession(env);
  await session.prompt("before restart");
  const sid = env.frames().filter((f) => f.method === "session/prompt").at(-1).params.sessionId;
  await runtime().shutdown();
  const before = env.frames().length;
  await session.prompt("after restart");
  const fresh = env.frames().slice(before);
  const methods = fresh.filter((f) => f.method).map((f) => f.method);
  assert.ok(methods.includes("session/list"));
  assert.ok(!methods.includes("session/new"), methods.join(","));
  const resume = fresh.find((f) => f.method === "session/resume");
  assert.equal(resume.params.sessionId, sid);
  const sets = fresh.filter((f) => f.method === "session/set_config_option" && f.params.sessionId === sid).map((f) => `${f.params.configId}=${f.params.value}`);
  assert.deepEqual(sets, ["model=gemini-3.8-flash", "thought_level=low"]);
  assert.deepEqual(fresh.find((f) => f.method === "session/prompt").params.prompt, [{ type: "text", text: "after restart" }]);
});

test("lost ACP session: new session with a bounded history transcript", async () => {
  const { session, mock } = await createSession(env);
  await session.prompt("remember kiwi");
  await runtime().shutdown();
  fs.writeFileSync(env.stateFile, "[]"); // agy forgot every session
  await session.prompt("what fruit?");
  const prompt = env.prompts().at(-1).params.prompt;
  assert.match(prompt[0].text, /^<pi_conversation_history[\s\S]*remember kiwi[\s\S]*<\/pi_conversation_history>/);
  assert.equal(prompt.at(-1).text.endsWith("what fruit?"), true);
  assert.ok(mock.calls.some((c) => c.method === "notify" && /已不存在/.test(c.args[0])));
});

test("fork (new pi session id with copied history) gets its own ACP session plus replay", async () => {
  const { session } = await createSession(env);
  await session.prompt("parent says mango");
  const parentAcp = env.prompts().at(-1).params.sessionId;
  const entries = session.sessionManager.getEntries();
  const fork = await createSession(env, { entries });
  await fork.session.prompt("fork continues");
  const p = env.prompts().at(-1);
  assert.notEqual(p.params.sessionId, parentAcp);
  assert.match(p.params.prompt[0].text, /parent says mango/);
});

test("crash mid-turn: error, no automatic resend, next prompt recovers", async () => {
  const { session } = await createSession(env);
  await session.prompt("SCRIPT:crash");
  const a = assistants(session).at(-1);
  assert.equal(a.stopReason, "error");
  assert.match(a.errorMessage, /agy 进程退出/);
  await session.prompt("are you back?");
  assert.match(lastText(session), /are you back\?$/);
  assert.equal(env.prompts().filter((p) => JSON.stringify(p.params.prompt).includes("SCRIPT:crash")).length, 1);
});

test("agy's own slash commands pass through as plain text, nothing is registered", async () => {
  const { session } = await createSession(env);
  await session.prompt("/goal ship it");
  assert.deepEqual(env.prompts().at(-1).params.prompt, [{ type: "text", text: "/goal ship it" }]);
  assert.ok(!session.extensionRunner?.getRegisteredCommands?.().some((c: any) => String(c.name).startsWith("agy:")));
});

test("shutdown kills the whole process group, including grandchildren", async () => {
  const { session } = await createSession(env);
  await session.prompt("SCRIPT:grandchild");
  const pid = env.frames().find((f) => f.grandchild)?.grandchild;
  assert.ok(pid);
  process.kill(pid, 0); // alive
  await runtime().shutdown();
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 4000);
});
