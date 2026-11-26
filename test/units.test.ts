// Pure helpers: level mapping, diff, anchors, replay, redaction, real agy tool shapes, turn phases.
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
import { AcpSession } from "../src/runtime.ts";
import { TIMING, Turn } from "../src/turn.ts";

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
  assert.ok(block.text.startsWith("[output from other models omitted here]"));
  assert.match(block.text, /turn39 /);
  assert.doesNotMatch(block.text, /turn0 /);
  assert.ok(block.text.endsWith("back to agy"));
});

test("history transcript is bounded: latest exchange, first question, then newest; gaps marked", () => {
  const history = Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `message ${i} ` + "x".repeat(100) }));
  const t = historyTranscript(history, 1000);
  assert.ok(t.length <= 1000, String(t.length));
  assert.match(t, /message 49/);
  assert.match(t, /message 0 /);
  assert.doesNotMatch(t, /message 1 /);
  assert.match(t, /message 0 x+\n\[… part of the conversation omitted here …\]\n/);
  // one huge message is clipped head and tail instead of dropped
  const big = historyTranscript([{ role: "user", content: "start" }, { role: "assistant", content: Array.from({ length: 8 }, () => ({ type: "text", text: "y".repeat(8000) })) }], 1000);
  assert.match(big, /chars omitted/);
  assert.match(big, /\[user\] start/);
  assert.deepEqual(splitFresh([{ role: "system" }, { role: "user", content: "a" }, ours("x"), { role: "user", content: "b" }]).inputs, [{ role: "user", content: "b" }]);
});

test("tool activity: one paired line for edits and commands, reads dropped, errors keep their tail", () => {
  const call = (id: string, name: string, args: any) => ({ type: "toolCall", id, name, arguments: args });
  const result = (id: string, name: string, text: string, isError = false) => ({ role: "toolResult", toolCallId: id, toolName: name, isError, content: [{ type: "text", text }] });
  const history = [
    { role: "user", content: "fix it" },
    { role: "assistant", content: [{ type: "text", text: "looking" }, call("1", "read", { path: "a.ts" }), call("2", "edit", { path: "a.ts", oldText: "x".repeat(5000), newText: "y" }), call("3", "bash", { command: "npm test" }), call("4", "grep", { pattern: "q" }), call("5", "bash", { command: "sleep 9" })] },
    result("1", "read", "SECRET FILE BODY"), result("2", "edit", "ok"), result("3", "bash", "noise ".repeat(500) + "\nCommand exited with code 1", true), result("4", "grep", "no such dir", true),
  ];
  const t = historyTranscript(history, REPLAY_MAX_CHARS);
  assert.doesNotMatch(t, /SECRET|read a\.ts|xxxx/);
  assert.match(t, /\[tool\] edit a\.ts → ok\n/);
  assert.match(t, /\[tool\] bash npm test → error: .*Command exited with code 1\n/);
  assert.ok(t.length < 1200, String(t.length));
  assert.match(t, /\[tool\] grep → error: no such dir/);
  assert.match(t, /\[tool\] bash sleep 9 → result unknown/);
  // dialogue outranks tool lines: many tool turns cannot push out the first question
  const busy = [{ role: "user", content: "the goal" }, ...Array.from({ length: 200 }, (_, i) => ({ role: "assistant", content: [call(`c${i}`, "bash", { command: `step ${i} ` + "z".repeat(150) })] })), { role: "user", content: "next" }];
  const b = historyTranscript(busy, 5000);
  assert.match(b, /\[user\] the goal/);
  assert.match(b, /\[user\] next/);
  assert.match(b, /step 199 /);
  assert.doesNotMatch(b, /step 0 /);
  // a foreign turn's tools are summarized inside its note
  const [note] = inputsToBlocks([{ role: "assistant", provider: "claude", model: "opus", content: [call("9", "read", { path: "b.ts" }), call("8", "write", { path: "b.ts", content: "..." })] }, result("9", "read", "BODY"), result("8", "write", "done")], { images: true }) as any[];
  assert.equal(note.text, "[answered in between by claude/opus]\n[tool] write b.ts → ok");
});

test("replay edge cases: cut mid tool loop, background and exit codes, note budget, agy plan", () => {
  const call = (id: string, name: string, args: any) => ({ type: "toolCall", id, name, arguments: args });
  const result = (id: string, name: string, text: string, isError = false, details?: any) => ({ role: "toolResult", toolCallId: id, toolName: name, isError, content: [{ type: "text", text }], details });
  const claude = (content: any[]) => ({ role: "assistant", provider: "claude", model: "opus", content });
  // fresh session cut right after another model's tool call: its result is new input, not lost
  const msgs = [{ role: "user", content: "run tests" }, claude([call("1", "bash", { command: "npm test" })]), result("1", "bash", "boom\nCommand exited with code 1", true)];
  for (const tail of [[{ role: "user", content: "why?" }], []]) {
    const { history, inputs } = splitFresh([...msgs, ...tail]);
    assert.match(historyTranscript(history, REPLAY_MAX_CHARS, inputs), /bash npm test → error: boom/);
    const [b] = inputsToBlocks(inputs, { images: true, history }) as any[];
    assert.match(b.text, /^\[result of bash npm test \(error\)\]\nboom/);
  }
  // agy mirrors: a background command answered early is still running; exit code comes from details
  const bg = historyTranscript([{ role: "user", content: "go" }, { role: "assistant", content: [call("a", "agy_bash", { command: "make" }), call("b", "agy_bash", { command: "make test" })] },
    result("a", "agy_bash", "Still running in the background (managed by agy).", false, { agy: { status: "in_progress" } }),
    result("b", "agy_bash", "x".repeat(2000), true, { agy: { status: "completed", exitCode: 2 } })], REPLAY_MAX_CHARS);
  assert.match(bg, /agy_bash make → still running/);
  assert.match(bg, /agy_bash make test → error \(exit 2\): x/);
  // tool lines of a newer note cannot push out the answer text of older notes
  const noisy = claude([{ type: "text", text: "new conclusion" }, ...Array.from({ length: 400 }, (_, i) => call(`n${i}`, "bash", { command: `cmd ${i} ` + "z".repeat(200) }))]);
  const [nb] = inputsToBlocks([claude([{ type: "text", text: "old conclusion" }]), noisy, { role: "user", content: "continue" }], { images: true }) as any[];
  assert.match(nb.text, /old conclusion[\s\S]*new conclusion\n\[tool\] bash cmd \d+ [\s\S]*cmd 399 [^\n]*\n\ncontinue$/);
  assert.doesNotMatch(nb.text, /cmd 0 /);
  assert.ok(nb.text.length <= REPLAY_MAX_CHARS + 200, String(nb.text.length));
  // agy's plan survives as text; only the latest one
  const plan = historyTranscript([{ role: "user", content: "do it" },
    { role: "assistant", content: [call("p1", "agy_todo", {})] }, result("p1", "agy_todo", "- [ ] step one\n- [ ] step two"),
    { role: "assistant", content: [call("p2", "agy_todo", {})] }, result("p2", "agy_todo", "- [x] step one\n- [ ] **in progress** step two")], REPLAY_MAX_CHARS);
  assert.equal(plan.match(/\[plan\]/g)?.length, 1);
  // the plan comes from the call's entries, so a failed mirror result does not replace it
  const fromArgs = historyTranscript([{ role: "user", content: "do it" },
    { role: "assistant", content: [call("p3", "agy_todo", { entries: [{ content: "ship", status: "in_progress" }] })] }, result("p3", "agy_todo", "No state for this agy tool call", true)], REPLAY_MAX_CHARS);
  assert.match(fromArgs, /\[plan\]\n- \[ \] \*\*in progress\*\* ship/);
  assert.doesNotMatch(fromArgs, /No state/);
  // every run of dropped notes gets its own marker
  const long = () => claude([{ type: "text", text: "L".repeat(5000) }]);
  const short = (t: string) => claude([{ type: "text", text: t }]);
  const gaps = inputsToBlocks([long(), { role: "user", content: "q0" }, short("s1"), long(), { role: "user", content: "q1" }, short("s2"), long(), { role: "user", content: "q2" }, ...Array.from({ length: 14 }, long), { role: "user", content: "go" }], { images: true }) as any[];
  assert.equal(gaps[0].text.match(/omitted here/g)?.length, 3);
  // markers count against the budget too: hundreds of alternating turns stay within it
  const many = Array.from({ length: 379 }, (_, i) => [{ role: "user", content: `q${i}` }, short("a".repeat(4000))]).flat();
  const [mb] = inputsToBlocks(many, { images: true }) as any[];
  const userChars = many.filter((m: any) => m.role === "user").reduce((s: number, m: any) => s + m.content.length + 2, 0);
  assert.ok(mb.text.length - userChars <= REPLAY_MAX_CHARS, String(mb.text.length - userChars));
  assert.match(gaps[0].text, /omitted here\]\n\nq0\n\n[^\n]+\ns1\n\n\[output from other models omitted here\]\n\nq1/);
  assert.match(plan, /\[plan\]\n- \[x\] step one\n- \[ \] \*\*in progress\*\* step two/);
});

test("long command output keeps its end and the exit note; other results keep their start", () => {
  const long = "x".repeat(30_000) + "\nError: build failed";
  const failed = mirrorResult({ id: "c", kind: "execute", status: "completed", rawOutput: { output: long, exit_code: 2 }, content: [], locations: [] });
  assert.match(failed.content[0].text, /^… \(truncated, 30020 chars total; the end is shown\)\n/);
  assert.match(failed.content[0].text, /Error: build failed\nexit 2$/);
  const read = mirrorResult({ id: "r", kind: "read", status: "completed", content: [{ type: "content", content: { type: "text", text: "head" + "y".repeat(30_000) } }], locations: [] });
  assert.match(read.content[0].text, /^head/);
  assert.match(read.content[0].text, /truncated, 30004 chars total\)$/);
});

test("config options are found by id, else by category, with grouped choices flattened", () => {
  const s = new AcpSession("s", "/x", { configOptions: [
    { id: "model", category: "model", currentValue: "a", options: [{ name: "Group", options: [{ value: "a" }, { value: "b" }] }, { value: "c" }] },
    { id: "thinking_level", category: "thought_level", currentValue: "low", options: [{ value: "low" }, { value: "high" }] },
  ] });
  assert.deepEqual(s.values("model"), ["a", "b", "c"]);
  assert.deepEqual(s.values("thought_level"), ["low", "high"]);
  assert.equal(s.current("thought_level"), "low");
  assert.equal(s.option("thought_level").id, "thinking_level", "set_config_option sends the id agy announced");
  assert.deepEqual(s.values("mode"), []);
});

test("turn phases: agy's own work ends on silence, sized by what it did last", () => {
  const t = new Turn();
  assert.equal(t.wakeDelay(false, TIMING), undefined, "a prompt in flight ends the turn itself");
  t.note("speaks");
  assert.equal(t.phase, "prompt", "nothing agy does during a prompt starts the silence rules");
  t.phase = "grace"; // the prompt returned while a background command runs
  assert.equal(t.wakeDelay(true, TIMING), undefined, "the command is still running");
  t.note("usage");
  assert.equal(t.phase, "grace", "a model call closed before the command ended is not the report");
  assert.equal(t.wakeDelay(false, TIMING), TIMING.wakeGrace);
  t.note("speaks");
  assert.equal(t.wakeDelay(false, TIMING), TIMING.wakeQuiet, "generating: agy may be silent for minutes");
  t.note("usage");
  assert.equal(t.wakeDelay(false, TIMING), TIMING.wakeSettle, "model call closed: tool calls would follow at once");
  t.note("question");
  t.pendingPermissions = 1;
  assert.equal(t.wakeDelay(false, TIMING), undefined, "waiting on the user");
  t.pendingPermissions = 0;
  assert.equal(t.wakeDelay(false, TIMING), TIMING.wakeQuiet, "after the answer agy generates again");
  t.note("usage");
  t.note("command-done");
  assert.equal(t.wakeDelay(false, TIMING), TIMING.wakeGrace, "a command that just ended: wait for agy to report on it");
  t.ended = true;
  assert.equal(t.wakeDelay(false, TIMING), undefined);
});

test("watchdog: a held reply is released after long silence, a silent prompt is stuck; tools and questions wait", () => {
  const t = new Turn();
  const at = (minutes: number) => t.lastActivity + minutes * 60_000;
  assert.equal(t.watchdog(false, at(9), TIMING), "ok");
  assert.equal(t.watchdog(false, at(11), TIMING), "stuck");
  assert.equal(t.watchdog(true, at(11), TIMING), "ok", "a running tool is not silence");
  t.pendingPermissions = 1;
  assert.equal(t.watchdog(false, at(11), TIMING), "ok", "an open question is not silence");
  t.pendingPermissions = 0;
  t.phase = "grace";
  assert.equal(t.watchdog(true, at(29), TIMING), "ok", "the background command may take this long");
  assert.equal(t.watchdog(true, at(31), TIMING), "release", "its final status was probably dropped");
});

test("debug redaction replaces image bytes", () => {
  const r: any = redact({ prompt: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }] });
  assert.match(r.prompt[0].data, /^<image\/png 5B sha256:[0-9a-f]{12}>$/);
});
