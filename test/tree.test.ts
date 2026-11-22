// /tree navigation, model/effort switches and pi compaction keep the right ACP session.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSession, lastText, runtime, setupEnv } from "./helpers.ts";

const env = setupEnv("tree");
after(async () => { await runtime()?.shutdown(); });

const promptSid = () => env.prompts().at(-1).params.sessionId;

test("tree: edit an earlier message → new ACP session; back to the old leaf → original session", async () => {
  const { session } = await createSession(env);
  await session.prompt("first");
  const original = promptSid();
  const firstUser = session.sessionManager.getEntries().find((e: any) => e.type === "message" && e.message.role === "user");
  await session.prompt("second");
  const oldLeaf = session.sessionManager.getLeafId();
  // branch from before "first": re-ask differently
  await session.navigateTree(firstUser.id, { summarize: false } as any);
  await session.prompt("first, rephrased");
  const branched = promptSid();
  assert.notEqual(branched, original);
  // back to the original branch tip
  await session.navigateTree(oldLeaf, { summarize: false } as any);
  await session.prompt("third");
  assert.equal(promptSid(), original);
  assert.deepEqual(env.prompts().at(-1).params.prompt, [{ type: "text", text: "third" }]);
});

test("switching agy model / thinking level re-applies config on the same session", async () => {
  const { session, services } = await createSession(env);
  await session.prompt("one");
  const sid = promptSid();
  const neon = services.modelRuntime.getModel("antigravity", "gemini-4-neon");
  await session.setModel(neon);
  session.setThinkingLevel("xhigh");
  const before = env.frames().length;
  await session.prompt("two");
  assert.equal(promptSid(), sid);
  const sets = env.frames().slice(before).filter((f) => f.method === "session/set_config_option" && f.params.sessionId === sid).map((f) => `${f.params.configId}=${f.params.value}`);
  assert.deepEqual(sets, ["model=gemini-4-neon", "thought_level=xhigh"]);
  assert.match(lastText(session), /^echo\[gemini-4-neon\/xhigh\/default\]/);
});

test("pi compaction runs in a throwaway session and the chat keeps its ACP session", async () => {
  const { session } = await createSession(env, { settings: { compaction: { enabled: false, keepRecentTokens: 50, reserveTokens: 100 } } });
  for (const t of ["a", "b", "c", "d"]) await session.prompt(`turn ${t} ` + "lorem ipsum ".repeat(400));
  const sid = promptSid();
  const before = env.frames().length;
  await session.compact();
  const fresh = env.frames().slice(before);
  const summaryPrompt = fresh.find((f) => f.method === "session/prompt");
  assert.ok(summaryPrompt, "compaction reached agy");
  assert.notEqual(summaryPrompt.params.sessionId, sid);
  assert.ok(fresh.some((f) => f.method === "session/close" && f.params.sessionId === summaryPrompt.params.sessionId));
  await session.prompt("after compaction");
  assert.equal(promptSid(), sid);
  assert.deepEqual(env.prompts().at(-1).params.prompt, [{ type: "text", text: "after compaction" }]);
});
