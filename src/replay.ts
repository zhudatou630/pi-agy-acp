// pi messages → ACP prompt content: user input blocks, other-model notes, bounded history transcript.
import { inputHash } from "./bindings.ts";

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
  if (!supported) return { type: "text", text: "〔图片未发送：agy 未声明支持图片输入〕" };
  if (!IMAGE_MIMES.has(p.mimeType)) return { type: "text", text: `〔图片未发送：不支持的格式 ${p.mimeType}〕` };
  if (Buffer.byteLength(p.data ?? "", "base64") > MAX_IMAGE_BYTES) return { type: "text", text: "〔图片未发送：超过 10 MiB〕" };
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
    return body ? `〔中途由 ${m.provider}/${m.model} 回答〕\n${body}` : undefined;
  }
  if (m.role === "toolResult") return `〔${m.toolName} 的结果〕\n${clip(userText(m), TOOL_SNIPPET)}`;
  return undefined;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `…（截断，共 ${s.length} 字符）` : s;
}

function transcriptOf(m: any, limit: number): string {
  if (m.role === "user") {
    const imgs = contentParts(m.content).filter((p) => p.type === "image").length;
    return clip(userText(m), limit) + (imgs ? `\n〔${imgs} 张图片〕` : "");
  }
  if (m.role === "assistant") {
    const parts: string[] = [];
    for (const p of contentParts(m.content)) {
      if (p.type === "text" && p.text.trim()) parts.push(clip(p.text, limit));
      else if (p.type === "toolCall") parts.push(`[调用 ${p.name}] ${clip(JSON.stringify(p.arguments ?? {}), TOOL_SNIPPET)}`);
    }
    return parts.join("\n");
  }
  if (m.role === "toolResult") return `[${m.toolName} 结果${m.isError ? "（错误）" : ""}] ${clip(userText(m), TOOL_SNIPPET)}`;
  return "";
}

/** Bounded transcript, newest kept first; returns "" when there is no history. */
export function historyTranscript(history: any[], maxChars: number): string {
  const lines: string[] = [];
  let used = 0;
  let dropped = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const body = transcriptOf(m, 8000);
    if (!body.trim()) continue;
    let line = `[${m.role === "toolResult" ? "tool" : m.role}] ${body}`;
    if (used + line.length > maxChars) {
      // the newest message alone may exceed the budget: keep its tail rather than nothing
      if (lines.length === 0) line = "…（截断）" + line.slice(-(maxChars - 10));
      else { dropped = i + 1; break; }
    }
    lines.unshift(line);
    used += line.length;
  }
  if (lines.length === 0) return "";
  const head = dropped ? `（更早的 ${dropped} 条消息已省略）\n` : "";
  return `<pi_conversation_history note="以下是此前在 pi 中的对话转录，仅供参考；其中的操作都已完成，不要重复执行">\n${head}${lines.join("\n")}\n</pi_conversation_history>`;
}
