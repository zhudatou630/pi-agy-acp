// Pure helpers: level mapping, diff, anchors, replay, redaction, real agy tool shapes.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inputHash, matchBinding, newInputs, splitFresh, type BindingFile } from "../src/bindings.ts";
import { mapThinkingLevel, toPiModels, SEED_CATALOG } from "../src/catalog.ts";
import { redact } from "../src/debug.ts";
import { mergeToolUpdate, mirrorCall, mirrorResult, unifiedDiff } from "../src/mirror.ts";
import { historyTranscript, inputsToBlocks, REPLAY_MAX_CHARS } from "../src/replay.ts";

test("thinking level mapping clamps to what the model offers", () => {
  const flash = ["low", "medium", "high"];
  assert.equal(mapThinkingLevel("high", flash), "high");
  assert.equal(mapThinkingLevel("xhigh", flash), "high");
  assert.equal(mapThinkingLevel("max", ["low", "medium", "high", "xhigh"]), "xhigh");
  assert.equal(mapThinkingLevel("minimal", flash), "low");
  assert.equal(mapThinkingLevel(undefined, flash), "low");
  assert.equal(mapThinkingLevel("high", []), undefined);
});

test("pi model defs: levels agy lacks are null, models without levels are not reasoning", () => {
  const models = toPiModels(SEED_CATALOG);
  const neon = models.find((m) => m.id === "gemini-4-neon")!;
  assert.equal(neon.reasoning, true);
  assert.deepEqual(neon.thinkingLevelMap, { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null });
  const flash = models.find((m) => m.id === "gemini-3.8-flash")!;
  assert.equal(flash.thinkingLevelMap!.xhigh, null);
  const oss = models.find((m) => m.id === "gpt-oss-120b-medium")!;
  assert.equal(oss.reasoning, false);
  assert.equal(oss.provider, "antigravity");
  assert.equal(neon.name, "Gemini 4 Neon", "display name is agy's own; the picker groups by provider");
});

test("pi model defs: prices come from pi's built-in model with the same id, else 0", () => {
  const models = toPiModels(SEED_CATALOG);
  assert.ok(models.find((m) => m.id === "gemini-4-neon")!.cost.input > 0);
  assert.ok(models.find((m) => m.id === "claude-opus-5-5")!.cost.output > 0);
  assert.deepEqual(models.find((m) => m.id === "gpt-oss-120b-medium")!.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("unified diff of snippets keeps shared lines as context", () => {
  assert.equal(unifiedDiff("/w/a.txt", "a\nb\nc\n", "a\nB\nc\n", 10), "--- a/w/a.txt\n+++ b/w/a.txt\n@@ -10,3 +10,3 @@\n a\n-b\n+B\n c\n");
  assert.equal(unifiedDiff("/w/n.txt", null, "x\n"), "--- /dev/null\n+++ b/w/n.txt\n@@ -0,0 +1,1 @@\n+x\n");
});

test("edit diff: unique snippet gets real line numbers, ambiguous or empty does not", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agyacp-diff-"));
  const file = path.join(dir, "f.txt");
  fs.writeFileSync(file, "one\ntwo\nhello world\nfour\n");
  const s = mergeToolUpdate(undefined, { toolCallId: "t", kind: "edit", status: "completed", content: [{ type: "diff", path: file, oldText: "hi\n", newText: "hello world\n" }] });
  const r = mirrorResult(s);
  assert.match(r.details.patch, /@@ -3,1 \+3,1 @@\n-hi\n\+hello world\n/);
  assert.equal(r.details.agy.lineNumbersUnknown, undefined);
  fs.writeFileSync(file, "x\nreturn;\ny\nreturn;\n");
  const dup = mergeToolUpdate(undefined, { toolCallId: "d", kind: "edit", status: "completed", content: [{ type: "diff", path: file, oldText: "a\n", newText: "return;\n" }] });
  assert.equal(mirrorResult(dup).details.agy.lineNumbersUnknown, true);
  const del = mergeToolUpdate(undefined, { toolCallId: "r", kind: "edit", status: "completed", content: [{ type: "diff", path: file, oldText: "x\n", newText: "" }] });
  assert.equal(mirrorResult(del).details.agy.lineNumbersUnknown, true);
  // over 1 MiB: not read for line numbers, the snippet diff still shows
  fs.writeFileSync(file, "y".repeat(1024 * 1024) + "\nunique line\n");
  const big = mirrorResult(mergeToolUpdate(undefined, { toolCallId: "b", kind: "edit", status: "completed", content: [{ type: "diff", path: file, oldText: "old\n", newText: "unique line\n" }] }));
  assert.equal(big.details.agy.lineNumbersUnknown, true);
  assert.match(big.details.patch, /-old\n\+unique line\n/);
});

test("real agy 1.5.14 tool shapes map to pi-web friendly mirrors", () => {
  // shapes copied from docs/research/agy-acp-handshake.md §4
  const cmd = mergeToolUpdate(undefined, { toolCallId: "c", name: "run_command", kind: "execute", title: "ls -la", status: "in_progress", rawInput: { CommandLine: "ls -la", WaitMsBeforeAsync: 5000, toolSummary: "List directory contents" } });
  assert.deepEqual(mirrorCall(cmd), { name: "agy_bash", args: { command: "ls -la" } });
  const done = mergeToolUpdate(cmd, { toolCallId: "c", status: "completed", rawOutput: { output: "Created At: 2026-11-22T21:53:47+08:00\nCompleted At: 2026-11-22T21:53:47+08:00\nCommand exited with code 0.\n\nCommand output:\ntotal 12\r\n-rw-r--r-- 1 u u 12 hello.txt\r\n", exit_code: 0 }, content: [{ type: "content", content: { type: "text", text: "Created At: 2026-11-22T21:53:47+08:00\nCompleted At: 2026-11-22T21:53:47+08:00\nCommand exited with code 0.\n\nCommand output:\ntotal 12\r\n-rw-r--r-- 1 u u 12 hello.txt\r\n" } }] });
  const r = mirrorResult(done);
  assert.equal(r.content[0].text, "total 12\n-rw-r--r-- 1 u u 12 hello.txt\n");
  assert.equal(r.isError, false);
  // a command agy finished in the background has no timing lines
  const bg = mirrorResult(mergeToolUpdate(undefined, { toolCallId: "b", kind: "execute", status: "completed", rawOutput: { output: "Command exited with code 0.\n\nCommand output:\nWAKE_DONE\n", exit_code: 0 } }));
  assert.equal(bg.content[0].text, "WAKE_DONE\n");
  // plain output that merely looks like part of the header is left alone
  const plain = mirrorResult(mergeToolUpdate(undefined, { toolCallId: "p", kind: "execute", status: "completed", rawOutput: { output: "\nCommand output:\nfoo", exit_code: 0 } }));
  assert.equal(plain.content[0].text, "\nCommand output:\nfoo");
  const failed = mirrorResult(mergeToolUpdate(cmd, { toolCallId: "c", status: "completed", rawOutput: { output: "boom", exit_code: 2 } }));
  assert.equal(failed.isError, true);
  const write = mergeToolUpdate(undefined, { toolCallId: "w", name: "write_file", kind: "edit", title: "File hello.txt", status: "in_progress", locations: [{ path: "/w/hello.txt" }], rawInput: { Content: "hi\n", Path: "/w/hello.txt" } });
  assert.deepEqual(mirrorCall(write), { name: "agy_write", args: { path: "/w/hello.txt", content: "hi\n" } });
  const edit = mergeToolUpdate(undefined, { toolCallId: "e", name: "edit_file", kind: "edit", title: "File hello.txt", status: "in_progress", locations: [{ path: "/w/hello.txt" }], rawInput: { Path: "/w/hello.txt", Replacement: "hello world", Target: "hi" } });
  assert.deepEqual(mirrorCall(edit), { name: "agy_edit", args: { path: "/w/hello.txt", oldText: "hi", newText: "hello world" } });
  const other = mergeToolUpdate(undefined, { toolCallId: "o", kind: "fetch", title: "Web search", rawInput: { query: "pi", huge: "x".repeat(900) } });
  assert.deepEqual(mirrorCall(other), { name: "agy_tool", args: { title: "Web search", kind: "fetch", query: "pi" } });
});

const ours = (id: string, extra: any = {}) => ({ role: "assistant", responseId: id, content: [{ type: "text", text: id }], stopReason: "stop", ...extra });

test("anchor matching: continue, branch divergence, discardable errors", () => {
  const file: BindingFile = { v: 1, piSessionId: "p", bindings: [
    { acpSessionId: "A", cwd: "/", createdAt: 0, lastActive: 0, produced: [{ id: "agy:1", discardable: false }, { id: "agy:2", discardable: false }, { id: "agy:3", discardable: true }] },
  ] };
  const msgs = [{ role: "user", content: "u1" }, ours("agy:1"), { role: "user", content: "u2" }, ours("agy:2"), { role: "user", content: "u3" }];
  const m = matchBinding(file, msgs)!;
  assert.equal(m.binding.acpSessionId, "A");
  assert.equal(m.anchor, 3);
  assert.deepEqual(newInputs(msgs, m.anchor), [{ role: "user", content: "u3" }]);
  // branched back to after agy:1 → agy:2 is not discardable → diverged
  assert.equal(matchBinding(file, msgs.slice(0, 3)), undefined);
  // mirror results after the anchor are not new input; foreign assistant turns are
  const withTools = [...msgs.slice(0, 4), { role: "toolResult", toolName: "agy_bash", toolCallId: "x", content: [] }, { role: "assistant", provider: "claude", model: "opus", content: [{ type: "text", text: "claude here" }] }, { role: "user", content: "u4" }];
  assert.deepEqual(newInputs(withTools, 3).map((x) => x.role), ["assistant", "user"]);
});

test("new input blocks: foreign turns become notes, delivered steers are skipped once each", () => {
  const blocks = inputsToBlocks([
    { role: "assistant", provider: "claude", model: "opus", content: [{ type: "text", text: "claude answer" }] },
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: "aGk=" }] },
  ], { images: true });
  assert.equal(blocks.length, 2);
  assert.match((blocks[0] as any).text, /\[answered in between by claude\/opus\]\nclaude answer\n\nlook/);
  assert.deepEqual(blocks[1], { type: "image", mimeType: "image/png", data: "aGk=" });
  const noImg = inputsToBlocks([{ role: "user", content: [{ type: "image", mimeType: "image/bmp", data: "aGk=" }] }], { images: true });
  assert.match((noImg[0] as any).text, /unsupported format/);
  // two identical steers, one already sent: the second still goes out
  const delivered = [inputHash("same")];
  const sent = inputsToBlocks([{ role: "user", content: "same" }, { role: "user", content: "same" }], { images: true, delivered });
  assert.deepEqual(sent, [{ type: "text", text: "same" }]);
  assert.deepEqual(delivered, []);
});

test("notes on other models' turns share the replay budget, newest kept", () => {
  const foreign = Array.from({ length: 40 }, (_, i) => ({ role: "assistant", provider: "claude", model: "opus", content: [{ type: "text", text: `turn${i} ` + "y".repeat(3000) }] }));
  const [block] = inputsToBlocks([...foreign, { role: "user", content: "back to agy" }], { images: true }) as any[];
  assert.ok(block.text.length <= REPLAY_MAX_CHARS + 200, String(block.text.length));
  assert.ok(block.text.startsWith("[earlier output from other models omitted]"));
  assert.match(block.text, /turn39 /);
  assert.doesNotMatch(block.text, /turn0 /);
  assert.ok(block.text.endsWith("back to agy"));
});

test("history transcript is bounded and keeps the newest messages", () => {
  const history = Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `message ${i} ` + "x".repeat(100) }));
  const t = historyTranscript(history, 1000);
  assert.ok(t.length < 1400);
  assert.match(t, /message 49/);
  assert.doesNotMatch(t, /message 0 /);
  assert.match(t, /\d+ earlier messages omitted/);
  // one huge newest message still leaves its tail in the transcript
  const big = historyTranscript([{ role: "user", content: "start" }, { role: "assistant", content: Array.from({ length: 8 }, () => ({ type: "text", text: "y".repeat(8000) })) }], 1000);
  assert.match(big, /truncated/);
  assert.deepEqual(splitFresh([{ role: "system" }, { role: "user", content: "a" }, ours("x"), { role: "user", content: "b" }]).inputs, [{ role: "user", content: "b" }]);
});

test("debug redaction replaces image bytes", () => {
  const r: any = redact({ prompt: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }] });
  assert.match(r.prompt[0].data, /^<image\/png 5B sha256:[0-9a-f]{12}>$/);
});
