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

test("a prompt agy never answers after Stop does not keep agy from idle shutdown", { timeout: 20_000 }, async () => {
  const { session } = await createSession(env);
  const run = session.prompt("SCRIPT:hang");
  await until(() => promptsWith("SCRIPT:hang").length === 1, 5000);
  await sleep(200);
  await session.abort();
  await run; // gives up after CANCEL_WAIT_MS
  const rt = runtime();
  assert.equal(assistants(session).at(-1).stopReason, "aborted");
  assert.equal(rt.busy(), false, "the abandoned prompt must not hold the process");
  await session.prompt("after hang");
  assert.match(lastText(session), /echo\[.*\]: after hang/, "the broken session is replaced and works");
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

// --- background / wake (review of c054a70) ---

test("after Stop, late agy output opens no reply and late permission requests are refused", async () => {
  const { session } = await createSession(env);
  const run = session.prompt("SCRIPT:stoplate");
  await sleep(300);
  await session.abort();
  await run;
  await until(() => env.frames().some((f) => f.lateOutcome), 5000);
  assert.equal(env.frames().find((f) => f.lateOutcome).lateOutcome, "deny");
  await sleep(500);
  assert.ok(!session.messages.some((m: any) => m.role === "custom" && m.customType === "agy-wake"));
});

test("a daemon started during agy's own report does not hold that reply open", async () => {
  const { session } = await createSession(env);
  await session.prompt("SCRIPT:wakedaemon");
  await until(() => session.messages.some((m: any) => m.role === "custom" && m.customType === "agy-wake"), 5000);
  await until(() => !session.isStreaming && session.messages.some((m: any) => m.role === "toolResult" && m.toolCallId === "wd2"), 10000);
  const card = session.messages.find((m: any) => m.role === "toolResult" && m.toolCallId === "wd2");
  assert.match(card.content[0].text, /Still running in the background/);
});

test("a question during agy's own report waits for the user instead of ending on silence", async () => {
  const { session, mock } = await createSession(env);
  let silenceTimerWhileAsking: unknown = "unchecked";
  mock.answers.select = (async (options: string[]) => {
    // a real wait would have to outlast WAKE_QUIET_MS; check the silence timer is off instead
    const turn = [...runtime().sessions.values()].map((s: any) => s.activeTurn).find((t: any) => t?.pendingPermissions > 0);
    silenceTimerWhileAsking = turn ? turn.wakeTimer : "no waiting turn";
    return options.find((o) => o === "Blue");
  }) as any;
  await session.prompt("SCRIPT:wakequestion");
  await until(() => !session.isStreaming && session.messages.some((m: any) => m.role === "assistant" && JSON.stringify(m.content).includes("picked:b")), 10000);
  assert.equal(silenceTimerWhileAsking, undefined, "no silence timer runs while agy waits on the user");
  // the answer belongs to the same reply: the question did not end it on silence
  assert.equal(session.messages.filter((m: any) => m.role === "custom" && m.customType === "agy-wake").length, 1);
});

test("agy's own multi-step work after a background command stays one reply and keeps agy alive", async () => {
  const { session } = await createSession(env);
  const rt = runtime();
  const armed: number[] = [];
  const orig = rt.armIdle;
  rt.armIdle = function (this: any) { armed.push(Date.now()); return orig.call(this); };
  const t0 = Date.now();
  try {
    await session.prompt("SCRIPT:bgsteps");
  } finally {
    rt.armIdle = orig;
  }
  assert.ok(Date.now() - t0 < 10_000, "agy's closing usage_update ends the reply soon, not the silence fallback");
  assert.ok(!session.messages.some((m: any) => m.role === "custom" && m.customType === "agy-wake"), "a silent step must not split the work into wake replies");
  assert.match(lastText(session), /all steps done/);
  assert.ok(armed.some((t) => t - t0 > 3500), "agy's unprompted updates push idle shutdown back");
});

test("a command agy reruns on its own holds the reply until agy reports on it", async () => {
  const { session } = await createSession(env);
  await session.prompt("SCRIPT:bgrerun");
  assert.ok(!session.messages.some((m: any) => m.role === "custom" && m.customType === "agy-wake"), "the report after the rerun must not open a wake reply");
  assert.match(lastText(session), /rerun reported/);
});

test("a normal command whose title mentions 'schedule' still holds the reply", async () => {
  const { session } = await createSession(env);
  await session.prompt("SCRIPT:schedtitle");
  const card = session.messages.find((m: any) => m.role === "toolResult" && m.toolCallId === "st");
  assert.equal(card.content[0].text, "3 passed");
  assert.match(lastText(session), /tests pass/);
});

test("a user who literally types the wake text still reaches agy", async () => {
  const { session } = await createSession(env);
  await session.prompt("[agy] Background task update");
  assert.match(lastText(session), /\[agy\] Background task update$/);
});
