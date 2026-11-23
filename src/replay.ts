// pi messages → ACP prompt content: user input blocks, other-model notes, bounded history transcript.
import { inputHash } from "./bindings.ts";

/** Content of the custom message that opens a pi reply when agy talks on its own; never sent to agy. */
export const WAKE_MARKER = "[agy] Background task update";

export type AcpBlock = { type: "text"; text: string } | { type: "image"; mimeType: string; data: string };

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TOOL_SNIPPET = 600;

function contentParts(content: unknown): any[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
}

export function userText(msg: any): string {
  return contentParts(msg.content).filter((p) => p.type === "text").map((p) => p.text).join("\n");
}

/**
 * Convert new-input messages (after the anchor) to ACP blocks. A user input already sent by an
 * immediate steer is skipped once per entry in `delivered` (the entry is consumed).
 */
export function inputsToBlocks(inputs: any[], opts: { images: boolean; delivered?: string[] }): AcpBlock[] {
  const blocks: AcpBlock[] = [];
  for (const m of inputs) {
    if (m.role === "user") {
      if (userText(m) === WAKE_MARKER) continue;
      const at = opts.delivered?.indexOf(inputHash(userText(m))) ?? -1;
      if (at >= 0) {
        opts.delivered!.splice(at, 1);
        continue;
      }
      for (const p of contentParts(m.content)) {
        if (p.type === "text" && p.text) blocks.push({ type: "text", text: p.text });
        else if (p.type === "image") blocks.push(imageBlock(p, opts.images));
      }
    } else {
      const note = noteFor(m);
      if (note) blocks.push({ type: "text", text: note });
    }
  }
  return mergeText(blocks);
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

/** A turn agy did not take part in (another model answered in between). */
function noteFor(m: any): string | undefined {
  if (m.role === "assistant") {
    const body = transcriptOf(m, 4000);
    return body ? `[answered in between by ${m.provider}/${m.model}]\n${body}` : undefined;
  }
  if (m.role === "toolResult") return `[result of ${m.toolName}]\n${clip(userText(m), TOOL_SNIPPET)}`;
  return undefined;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `… (truncated, ${s.length} chars total)` : s;
}

function transcriptOf(m: any, limit: number): string {
  if (m.role === "user") {
    const imgs = contentParts(m.content).filter((p) => p.type === "image").length;
    return clip(userText(m), limit) + (imgs ? `\n[${imgs} image(s)]` : "");
  }
  if (m.role === "assistant") {
    const parts: string[] = [];
    for (const p of contentParts(m.content)) {
      if (p.type === "text" && p.text.trim()) parts.push(clip(p.text, limit));
      else if (p.type === "toolCall") parts.push(`[call ${p.name}] ${clip(JSON.stringify(p.arguments ?? {}), TOOL_SNIPPET)}`);
    }
    return parts.join("\n");
  }
  if (m.role === "toolResult") return `[${m.toolName} result${m.isError ? " (error)" : ""}] ${clip(userText(m), TOOL_SNIPPET)}`;
  return "";
}

/** Bounded transcript, newest kept first; returns "" when there is no history. */
export function historyTranscript(history: any[], maxChars: number): string {
  const lines: string[] = [];
  let used = 0;
  let dropped = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "user" && userText(m) === WAKE_MARKER) continue;
    const body = transcriptOf(m, 8000);
    if (!body.trim()) continue;
    let line = `[${m.role === "toolResult" ? "tool" : m.role}] ${body}`;
    if (used + line.length > maxChars) {
      // the newest message alone may exceed the budget: keep its tail rather than nothing
      if (lines.length === 0) line = "…(truncated) " + line.slice(-(maxChars - 10));
      else { dropped = i + 1; break; }
    }
    lines.unshift(line);
    used += line.length;
  }
  if (lines.length === 0) return "";
  const head = dropped ? `(${dropped} earlier messages omitted)\n` : "";
  return `<pi_conversation_history note="Transcript of the earlier conversation in pi, for reference only. Everything in it has already been done; do not repeat it.">\n${head}${lines.join("\n")}\n</pi_conversation_history>`;
}
