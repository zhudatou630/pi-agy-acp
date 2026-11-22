// Manual smoke test against the real `agy acp` (costs a little quota: gemini-3.8-flash, low).
// Uses a temp workspace and temp extension state; your real bindings and catalog are untouched.
//   npm run smoke
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSession, lastText, runtime, sleep, until } from "./helpers.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agyacp-smoke-"));
const home = path.join(root, "home");
const cwd = path.join(root, "ws");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });
fs.writeFileSync(path.join(home, "config.json"), "{}");
process.env.PI_AGY_ACP_HOME = home;
process.env.ACP_DEBUG = path.join(root, "acp.ndjson");
const env: any = { root, cwd };

const frames = () => fs.readFileSync(process.env.ACP_DEBUG!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const step = (name: string) => console.log(`\n== ${name}`);

const { session } = await createSession(env, { model: "gemini-3.8-flash", thinking: "low" });
try {
  step("text + tools (write, edit, command)");
  await session.prompt("In the current directory: create notes.txt containing the line 'alpha', then change 'alpha' to 'beta', then run `cat notes.txt`. Reply with one short sentence.");
  const calls = session.messages.flatMap((m: any) => (m.role === "assistant" ? m.content.filter((c: any) => c.type === "toolCall") : []));
  console.log("mirror calls:", calls.map((c: any) => `${c.name} ${JSON.stringify(c.arguments).slice(0, 80)}`));
  const results = session.messages.filter((m: any) => m.role === "toolResult");
  console.log("patches:", results.filter((r: any) => r.details?.patch).map((r: any) => r.details.patch));
  console.log("answer:", lastText(session));
  assert.equal(fs.readFileSync(path.join(cwd, "notes.txt"), "utf8").trim(), "beta");
  assert.ok(calls.some((c: any) => c.name === "agy_bash"));

  step("image");
  const red = fs.readFileSync(new URL("../docs/research/probe/red.b64", import.meta.url), "utf8").trim();
  await session.prompt("What single color fills this image? One word.", { images: [{ type: "image", mimeType: "image/png", data: red }] });
  console.log("answer:", lastText(session));
  assert.match(lastText(session), /red/i);

  step("restart → resume");
  const sid = frames().filter((f) => f.dir === "out" && f.msg.method === "session/prompt").at(-1).msg.params.sessionId;
  await runtime().shutdown();
  await session.prompt("What file did you create earlier? Just the name.");
  const out = frames().filter((f) => f.dir === "out").map((f) => f.msg.method).filter(Boolean);
  console.log("answer:", lastText(session));
  assert.ok(out.includes("session/resume"));
  assert.equal(frames().filter((f) => f.dir === "out" && f.msg.method === "session/prompt").at(-1).msg.params.sessionId, sid);
  assert.match(lastText(session), /notes/i);

  step("steer mid-turn");
  const run = session.prompt("Count slowly from 1 to 40, one number per line, no tools.");
  await until(() => session.isStreaming, 10000);
  await sleep(4000);
  await session.prompt("Stop counting now and just say BANANA.", { streamingBehavior: "steer" });
  await run;
  await until(() => !session.isStreaming, 60000);
  console.log("answer:", lastText(session).slice(-200));

  step("cancel");
  const run2 = session.prompt("Run the shell command `sleep 20 && echo late` and wait for it.");
  await sleep(6000);
  await session.abort();
  await run2;
  console.log("stopReason:", session.messages.filter((m: any) => m.role === "assistant").at(-1).stopReason);
  assert.ok(frames().some((f) => f.dir === "out" && f.msg.method === "session/cancel"));
  console.log(`\nOK. ACP capture: ${process.env.ACP_DEBUG}`);
} finally {
  await runtime().shutdown();
  session.dispose();
}
