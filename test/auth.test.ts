// Not logged in → actionable error; /agy login drives the official `agy acp --login` flow.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { assistants, createSession, lastText, runtime, setupEnv } from "./helpers.ts";

const env = setupEnv("auth");
process.env.FAKE_AUTH = "0";
after(async () => { await runtime()?.shutdown(); });

test("unauthenticated prompt fails with login guidance and does not retry", async () => {
  const { session, mock } = await createSession(env);
  await session.prompt("hello");
  const a = assistants(session).at(-1);
  assert.equal(a.stopReason, "error");
  assert.match(a.errorMessage, /未登录[\s\S]*\/agy login/);
  assert.ok(mock.calls.some((c) => c.method === "notify" && c.args[1] === "error"));
  assert.equal(env.frames().filter((f) => f.method === "session/new").length, 1);
});

test("/agy login shows the URL, sends the pasted code, then works", async () => {
  const { session, mock } = await createSession(env);
  mock.answers.input = "good-code";
  await session.prompt("/agy login");
  const input = mock.calls.find((c) => c.method === "input");
  assert.match(input!.args[0], /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?client_id=fake/);
  assert.ok(env.frames().some((f) => f.login === "good-code"));
  assert.ok(mock.calls.some((c) => c.method === "notify" && /登录成功/.test(c.args[0])), JSON.stringify(mock.calls));
  await session.prompt("hello again");
  assert.match(lastText(session), /hello again$/);
});
