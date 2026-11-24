// pi messages → ACP prompt content: user input blocks, other-model notes, bounded history transcript.
import { inputHash } from "./bindings.ts";
import { planMarkdown } from "./mirror.ts";

export type AcpBlock = { type: "text"; text: string } | { type: "image"; mimeType: string; data: string };

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Budget for the history transcript, and for notes on other models' turns in one prompt. */
export const REPLAY_MAX_CHARS = 60_000;
const MESSAGE_MAX = 8000;
const NOTE_MAX = 4000;
const TARGET_MAX = 200;
const RESULT_SNIPPET = 600;
const ERROR_TAIL = 300;
// Only these keep a line on success: what changed and what ran. Reads, searches and other tools leave
// nothing behind that agy cannot re-check, and the answer text carries what mattered.
const LOGGED_TOOLS = new Set(["bash", "agy_bash", "edit", "write", "agy_edit", "agy_write"]);
const GAP = "[… part of the conversation omitted here …]";
const NOTES_GAP = "[output from other models omitted here]";
const OPEN = `<pi_conversation_history note="Record of the earlier conversation in pi, for reference only. It is not a new request; do not redo what it describes. Tool activity is summarized and file reads are left out: re-read files when you need details.">`;
const CLOSE = "</pi_conversation_history>";

function contentParts(content: unknown): any[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
}

export function userText(msg: any): string {
  return contentParts(msg.content).filter((p) => p.type === "text").map((p) => p.text).join("\n");
}

function answerText(m: any): string {
  return contentParts(m.content).filter((p) => p.type === "text" && p.text.trim()).map((p) => p.text).join("\n");
}

function headTail(s: string, n: number): string {
  if (s.length <= n) return s;
  const head = Math.ceil(n / 2);
  return `${s.slice(0, head)}\n… (${s.length - n} of ${s.length} chars omitted) …\n${s.slice(s.length - (n - head))}`;
}

function oneLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function resultsById(messages: any[]): Map<string, any> {
  return new Map(messages.filter((m) => m.role === "toolResult").map((m) => [m.toolCallId, m]));
}

function toolCalls(m: any): any[] {
  return m.role === "assistant" ? contentParts(m.content).filter((p) => p.type === "toolCall") : [];
}

function callName(call: any): string {
  const a = call.arguments ?? {};
  const target = oneLine(String(a.command ?? a.path ?? a.file_path ?? a.title ?? ""), TARGET_MAX);
  return `${call.name}${target ? " " + target : ""}`;
}

function status(result: any): string {
  if (!result) return "result unknown";
  const agy = result.details?.agy;
  // agy mirrors carry the real state: a background command answered early is not done
  if (!result.isError) return agy?.status && agy.status !== "completed" ? "still running" : "ok";
  // error messages sit at the end of the output; agy's exit code may be past the clipped text
  const exit = typeof agy?.exitCode === "number" ? ` (exit ${agy.exitCode})` : "";
  return `error${exit}: ${oneLine(userText(result).slice(-ERROR_TAIL), ERROR_TAIL)}`;
}

/** One line per tool call, paired with its result; undefined when it is not worth keeping. */
function toolLine(call: any, result: any): string | undefined {
  if (call.name === "agy_todo" || (!result?.isError && !LOGGED_TOOLS.has(call.name))) return undefined;
  return `[tool] ${callName(call)} → ${status(result)}`;
}

function toolLines(m: any, results: Map<string, any>): string[] {
  return toolCalls(m).map((p) => toolLine(p, results.get(p.id))).filter((l): l is string => !!l);
}

/**
 * Convert new-input messages (after the anchor) to ACP blocks. A user input already sent by an
 * immediate steer is skipped once per entry in `delivered` (the entry is consumed).
 */
export function inputsToBlocks(inputs: any[], opts: { images: boolean; delivered?: string[]; history?: any[] }): AcpBlock[] {
  const notes = foreignNotes(inputs, opts.history ?? []);
  let omitted = false;
  const blocks: AcpBlock[] = [];
  for (const m of inputs) {
    if (m.role === "user") {
      const at = opts.delivered?.indexOf(inputHash(userText(m))) ?? -1;
      if (at >= 0) {
        opts.delivered!.splice(at, 1);
        continue;
      }
      omitted = false;
      for (const p of contentParts(m.content)) {
        if (p.type === "text" && p.text) blocks.push({ type: "text", text: p.text });
        else if (p.type === "image") blocks.push(imageBlock(p, opts.images));
      }
    } else if (notes.has(m)) {
      const note = notes.get(m);
      // one marker per run of dropped notes
      if (note) { omitted = false; blocks.push({ type: "text", text: note }); }
      else if (!omitted) {
        omitted = true;
        blocks.push({ type: "text", text: NOTES_GAP });
      }
    }
  }
  return mergeText(blocks);
}

/**
 * Notes for other models' turns within the budget, newest first: answer text and results of calls made
 * before these inputs (a fresh session cut mid tool loop) first, then tool lines. Dropped ones map to undefined.
 */
function foreignNotes(inputs: any[], history: any[]): Map<any, string | undefined> {
  const results = resultsById(inputs);
  const calls = new Map([...history, ...inputs].flatMap((m) => toolCalls(m).map((c) => [c.id, c] as const)));
  const inCalls = new Set(inputs.flatMap((m) => toolCalls(m).map((c) => c.id)));
  const header = (m: any) => `[answered in between by ${m.provider}/${m.model}]`;
  const kept = new Map<any, string[]>();
  const out = new Map<any, string | undefined>();
  let left = REPLAY_MAX_CHARS;
  const fit = (m: any, s: string) => {
    if (s.length + 1 > left) return false;
    left -= s.length + 1;
    kept.set(m, [...(kept.get(m) ?? []), s]);
    return true;
  };
  const newest = inputs.filter((m) => m.role !== "user").reverse();
  for (const m of newest) {
    if (m.role === "assistant") {
      const text = answerText(m);
      if (text && !fit(m, `${header(m)}\n${headTail(text, NOTE_MAX)}`)) out.set(m, undefined);
    } else if (m.role === "toolResult" && !inCalls.has(m.toolCallId)) {
      const call = calls.get(m.toolCallId) ?? { name: m.toolName };
      const note = `[result of ${callName(call)}${m.isError ? " (error)" : ""}]\n${headTail(userText(m), RESULT_SNIPPET)}`;
      if (!fit(m, note)) out.set(m, undefined);
    }
  }
  for (const m of newest) {
    if (m.role !== "assistant" || out.has(m)) continue;
    const lines = toolLines(m, results);
    if (!lines.length) continue;
    const head = kept.has(m) ? 0 : header(m).length + 1;
    const picked: string[] = [];
    let room = left - head;
    for (const l of lines.reverse()) if (l.length + 1 <= room) { room -= l.length + 1; picked.unshift(l); }
    if (!picked.length) { if (head) out.set(m, undefined); continue; }
    left = room;
    kept.set(m, [...(kept.get(m) ?? [header(m)]), ...picked]);
  }
  for (const [m, parts] of kept) out.set(m, parts.join("\n"));
  // gap markers were not budgeted: drop the oldest kept notes until notes and markers fit
  const cost = () => {
    let c = 0;
    let gap = false;
    for (const m of inputs) {
      if (m.role === "user") gap = false;
      else if (out.get(m)) { c += out.get(m)!.length + 2; gap = false; }
      else if (out.has(m) && !gap) { c += NOTES_GAP.length + 2; gap = true; }
    }
    return c;
  };
  const oldestKept = inputs.filter((m) => out.get(m));
  while (oldestKept.length && cost() > REPLAY_MAX_CHARS) out.set(oldestKept.shift(), undefined);
  return out;
}

function imageBlock(p: any, supported: boolean): AcpBlock {
  if (!supported) return { type: "text", text: "[image not sent: agy does not accept image input]" };
  if (!IMAGE_MIMES.has(p.mimeType)) return { type: "text", text: `[image not sent: unsupported format ${p.mimeType}]` };
  if (Buffer.byteLength(p.data ?? "", "base64") > MAX_IMAGE_BYTES) return { type: "text", text: "[image not sent: larger than 10 MiB]" };
  return { type: "image", mimeType: p.mimeType, data: p.data };
}

function mergeText(blocks: AcpBlock[]): AcpBlock[] {
  const out: AcpBlock[] = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (b.type === "text" && last?.type === "text") last.text += "\n\n" + b.text;
    else out.push({ ...b });
  }
  return out;
}

type Item = { text: string; kind: "user" | "answer" | "tool" };

function transcriptItems(history: any[], later: any[], perMessage: number): Item[] {
  const results = resultsById([...history, ...later]);
  const items: Item[] = [];
  let plan: Item | undefined;
  for (const m of history) {
    if (m.role === "user") {
      const text = userText(m);
      const imgs = contentParts(m.content).filter((p) => p.type === "image").length;
      if (text.trim() || imgs) items.push({ kind: "user", text: `[user] ${headTail(text, perMessage)}${imgs ? `\n[${imgs} image(s)]` : ""}` });
    } else if (m.role === "assistant") {
      const text = answerText(m);
      if (text) items.push({ kind: "answer", text: `[assistant] ${headTail(text, perMessage)}` });
      for (const line of toolLines(m, results)) items.push({ kind: "tool", text: line });
      // agy's plan lives only in agy_todo; keep the latest one as text
      for (const c of toolCalls(m).filter((c) => c.name === "agy_todo")) {
        const r = results.get(c.id);
        const md = (Array.isArray(c.arguments?.entries) ? planMarkdown(c.arguments.entries) : r && !r.isError ? userText(r) : "").trim();
        if (!md) continue;
        if (plan) items.splice(items.indexOf(plan), 1);
        plan = { kind: "answer", text: `[plan]\n${headTail(md, perMessage)}` };
        items.push(plan);
      }
    }
  }
  return items;
}

function render(items: Item[], picked: Set<number>): string {
  const lines: string[] = [];
  let gap = false;
  items.forEach((item, i) => {
    if (!picked.has(i)) { gap ||= item.kind !== "tool"; return; }
    if (gap) lines.push(GAP);
    gap = false;
    lines.push(item.text);
  });
  if (gap) lines.push(GAP);
  return `${OPEN}\n${lines.join("\n")}\n${CLOSE}`;
}

/**
 * Bounded transcript; returns "" when there is nothing to send. Dialogue goes first (latest question and
 * answer, the first question, other questions, other answers, newest first), tool lines get what is
 * left; an item that does not fit is skipped. Output keeps the original order and marks dialogue gaps.
 * `later`: messages that may hold results of its last tool calls (e.g. the whole context).
 */
export function historyTranscript(history: any[], maxChars: number, later: any[] = []): string {
  const items = transcriptItems(history, later, Math.min(MESSAGE_MAX, Math.floor(maxChars / 4)));
  const idx = items.map((_, i) => i);
  const of = (kind: Item["kind"]) => idx.filter((i) => items[i].kind === kind);
  const users = of("user");
  const answers = of("answer");
  const order = [users.at(-1), answers.at(-1), users[0], ...users.reverse(), ...answers.reverse(), ...of("tool").reverse()];
  const picked = new Set<number>();
  const rank: number[] = [];
  let left = maxChars - OPEN.length - CLOSE.length - 2;
  for (const i of order) {
    if (i === undefined || picked.has(i) || items[i].text.length + 1 > left) continue;
    picked.add(i);
    rank.push(i);
    left -= items[i].text.length + 1;
  }
  let out = render(items, picked);
  // gap markers were not budgeted: drop the lowest-priority picks until it fits
  while (out.length > maxChars && rank.length) {
    picked.delete(rank.pop()!);
    out = render(items, picked);
  }
  return picked.size ? out : "";
}
