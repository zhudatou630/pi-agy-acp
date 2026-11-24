// pi messages → ACP prompt content: user input blocks, other-model notes, bounded history transcript.
import { inputHash } from "./bindings.ts";

export type AcpBlock = { type: "text"; text: string } | { type: "image"; mimeType: string; data: string };

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Budget for the history transcript, and for notes on other models' turns in one prompt. */
export const REPLAY_MAX_CHARS = 60_000;
const MESSAGE_MAX = 8000;
const NOTE_MAX = 4000;
const TARGET_MAX = 200;
const ERROR_TAIL = 300;
// Only these keep a line on success: what changed and what ran. Reads, searches and other tools leave
// nothing behind that agy cannot re-check, and the answer text carries what mattered.
const LOGGED_TOOLS = new Set(["bash", "agy_bash", "edit", "write", "agy_edit", "agy_write"]);
const GAP = "[… part of the conversation omitted here …]";
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

/** One line per tool call, paired with its result; undefined when it is not worth keeping. */
function toolLine(call: any, result: any): string | undefined {
  if (!result?.isError && !LOGGED_TOOLS.has(call.name)) return undefined;
  const a = call.arguments ?? {};
  const target = oneLine(String(a.command ?? a.path ?? a.file_path ?? a.title ?? ""), TARGET_MAX);
  // exit codes and error messages sit at the end of the output
  const status = !result ? "result unknown" : result.isError ? `error: ${oneLine(userText(result).slice(-ERROR_TAIL), ERROR_TAIL)}` : "ok";
  return `[tool] ${call.name}${target ? " " + target : ""} → ${status}`;
}

function toolLines(m: any, results: Map<string, any>): string[] {
  return contentParts(m.content)
    .filter((p) => p.type === "toolCall")
    .map((p) => toolLine(p, results.get(p.id)))
    .filter((l): l is string => !!l);
}

/**
 * Convert new-input messages (after the anchor) to ACP blocks. A user input already sent by an
 * immediate steer is skipped once per entry in `delivered` (the entry is consumed).
 */
export function inputsToBlocks(inputs: any[], opts: { images: boolean; delivered?: string[] }): AcpBlock[] {
  const notes = foreignNotes(inputs);
  let omitted = false;
  const blocks: AcpBlock[] = [];
  for (const m of inputs) {
    if (m.role === "user") {
      const at = opts.delivered?.indexOf(inputHash(userText(m))) ?? -1;
      if (at >= 0) {
        opts.delivered!.splice(at, 1);
        continue;
      }
      for (const p of contentParts(m.content)) {
        if (p.type === "text" && p.text) blocks.push({ type: "text", text: p.text });
        else if (p.type === "image") blocks.push(imageBlock(p, opts.images));
      }
    } else if (notes.has(m)) {
      const note = notes.get(m);
      if (note) blocks.push({ type: "text", text: note });
      else if (!omitted) {
        omitted = true;
        blocks.push({ type: "text", text: "[earlier output from other models omitted]" });
      }
    }
  }
  return mergeText(blocks);
}

/** Notes for other models' turns, newest first within the budget; older ones map to undefined. */
function foreignNotes(inputs: any[]): Map<any, string | undefined> {
  const out = new Map<any, string | undefined>();
  const results = resultsById(inputs);
  let left = REPLAY_MAX_CHARS;
  for (let i = inputs.length - 1; i >= 0; i--) {
    const m = inputs[i];
    if (m.role !== "assistant") continue; // tool results are folded into their call's line
    const body = [headTail(answerText(m), NOTE_MAX), ...toolLines(m, results)].filter((s) => s.trim()).join("\n");
    if (!body) continue;
    const note = `[answered in between by ${m.provider}/${m.model}]\n${body}`;
    const fits = note.length <= left;
    left = fits ? left - note.length : 0;
    out.set(m, fits ? note : undefined);
  }
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

function transcriptItems(history: any[], perMessage: number): Item[] {
  const results = resultsById(history);
  const items: Item[] = [];
  for (const m of history) {
    if (m.role === "user") {
      const text = userText(m);
      const imgs = contentParts(m.content).filter((p) => p.type === "image").length;
      if (text.trim() || imgs) items.push({ kind: "user", text: `[user] ${headTail(text, perMessage)}${imgs ? `\n[${imgs} image(s)]` : ""}` });
    } else if (m.role === "assistant") {
      const text = answerText(m);
      if (text) items.push({ kind: "answer", text: `[assistant] ${headTail(text, perMessage)}` });
      for (const line of toolLines(m, results)) items.push({ kind: "tool", text: line });
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
 */
export function historyTranscript(history: any[], maxChars: number): string {
  const items = transcriptItems(history, Math.min(MESSAGE_MAX, Math.floor(maxChars / 4)));
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
