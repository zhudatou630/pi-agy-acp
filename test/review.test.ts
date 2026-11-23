// Regression tests for the review findings (concurrency, steer order, retry, crash, close).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { assistants, createSession, lastText, runtime, setupEnv, sleep, until } from "./helpers.ts";

const env = setupEnv("review");
after(async () => { await runtime()?.shutdown(); });

const promptsWith = (s: string) => env.prompts().filter((p) => JSON.stringify(p.params.prompt).includes(s));

test("two pi sessions with colliding agy tool ids each get their own results", async () => {
  const a = await createSession(env);
  const b = await createSession(env);
  await Promise.all([a.session.prompt("SCRIPT:parallel"), b.session.prompt("SCRIPT:parallel")]);
  for (const { session } of [a, b]) {
    const results = session.messages.filter((m: any) => m.role === "toolResult");
    assert.deepEqual(results.map((r: any) => [r.toolCallId, r.content[0].text]).sort(), [["p1", "X"], ["p2", "Y"]]);
    assert.equal(lastText(session), "read both");
  }
});

test("pi's automatic retry does not resend a prompt agy already received", async () => {
  const { session } = await createSession(env, { settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 } } });
  await session.prompt("SCRIPT:fail429");
  await until(() => !session.isStreaming, 5000);
  assert.equal(promptsWith("SCRIPT:fail429").length, 1);
  assert.match(assistants(session).at(-1).errorMessage, /not resending automatically/);
});

test("steer before agy said anything: answer comes after the steer message", async () => {
  const { session } = await createSession(env);
  const run = session.prompt("SCRIPT:quiet");
  await sleep(150);
  await session.prompt("kiwi", { streamingBehavior: "steer" });
  await run;
  await until(() => !session.isStreaming, 5000);
  const conv = session.messages.filter((m: any) => m.role === "user" || m.role === "assistant");
  const iSteer = conv.findIndex((m: any) => m.role === "user" && JSON.stringify(m.content).includes("kiwi"));
  const answer = conv.findIndex((m: any) => m.role === "assistant" && JSON.stringify(m.content).includes("steer-received:kiwi"));
  assert.ok(iSteer > 0 && answer > iSteer, conv.map((m: any) => m.role + ":" + JSON.stringify(m.content).slice(0, 40)).join(" | "));
  assert.equal(promptsWith("kiwi").length, 1);
});

test("steer while a mirror tool is running is sent once and answered after it", async () => {
  const { session } = await createSession(env);
  const run = session.prompt("SCRIPT:longtool");
  await until(() => session.messages.some((m: any) => m.role === "assistant" && m.content.some((c: any) => c.type === "toolCall")), 5000);
  await session.prompt("mango", { streamingBehavior: "steer" });
  await run;
  await until(() => !session.isStreaming, 8000);
  assert.equal(promptsWith("mango").length, 1);
  assert.match(lastText(session), /steer-received:mango/);
});

test("agy crashes during a mirror wait: the error shows, no restart without new input", async () => {
  const { session } = await createSession(env);
  const run = session.prompt("SCRIPT:longtool");
  await until(() => session.messages.some((m: any) => m.role === "assistant" && m.content.some((c: any) => c.type === "toolCall")), 5000);
  const spawnsBefore = runtime().proc ? 1 : 0;
  process.kill(runtime().proc.pid, "SIGKILL");
  await run;
  const last = assistants(session).at(-1);
  assert.equal(last.stopReason, "error");
  assert.match(last.errorMessage, /agy process exited/);
  assert.equal(runtime().proc, undefined, "not restarted just to drain");
  assert.equal(spawnsBefore, 1);
});

test("/agy new while agy is working ends the turn instead of hanging", async () => {
  const { session } = await createSession(env);
  const run = session.prompt("SCRIPT:slow");
  await sleep(300);
  await session.prompt("/agy new");
  await Promise.race([run, sleep(4000).then(() => { throw new Error("hung"); })]);
  assert.notEqual(assistants(session).at(-1).stopReason, "stop");
});

test("agy max_tokens maps to pi length", async () => {
  const { session } = await createSession(env);
  await session.prompt("SCRIPT:maxtokens");
  assert.equal(assistants(session).at(-1).stopReason, "length");
});

test("after /reload (module re-evaluated, runtime kept) tool turns still work", async () => {
  const { session } = await createSession(env);
  await session.prompt("hi");
  await session.reload();
  await session.prompt("SCRIPT:parallel");
  assert.equal(lastText(session), "read both");
});
