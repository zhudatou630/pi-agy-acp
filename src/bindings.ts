// pi session ↔ ACP session mapping, persisted per pi session, matched by response-id anchors.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MIRROR_PREFIX = "agy_";
const RESPONSE_PREFIX = "agy:";
const MAX_BINDINGS = 5;
const MAX_PRODUCED = 200;

export interface Produced {
  id: string;
  /** error/aborted messages: pi may drop them from later contexts. */
  discardable: boolean;
}

export interface Binding {
  acpSessionId: string;
  cwd: string;
  createdAt: number;
  lastActive: number;
  produced: Produced[];
  /** Hash of a prompt whose turn failed after it reached agy: pi's automatic retry must not resend it. */
  failedKey?: string;
}

export interface BindingFile {
  v: 1;
  piSessionId: string;
  bindings: Binding[];
}

export class BindingStore {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  private file(piSessionId: string): string {
    return path.join(this.dir, `${piSessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  }

  load(piSessionId: string): BindingFile {
    try {
      const data = JSON.parse(fs.readFileSync(this.file(piSessionId), "utf8")) as BindingFile;
      if (data?.v === 1 && Array.isArray(data.bindings)) return data;
    } catch {}
    return { v: 1, piSessionId, bindings: [] };
  }

  save(data: BindingFile): void {
    data.bindings.sort((a, b) => b.lastActive - a.lastActive);
    data.bindings = data.bindings.slice(0, MAX_BINDINGS);
    for (const b of data.bindings) b.produced = b.produced.slice(-MAX_PRODUCED);
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.file(data.piSessionId);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  /** Delete mapping files untouched for maxAgeMs. */
  prune(maxAgeMs: number): void {
    let names: string[];
    try { names = fs.readdirSync(this.dir); } catch { return; }
    const cutoff = Date.now() - maxAgeMs;
    for (const name of names) {
      const file = path.join(this.dir, name);
      try { if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file); } catch {}
    }
  }
}

export function newResponseId(acpSessionId: string): string {
  return `${RESPONSE_PREFIX}${acpSessionId.slice(0, 8)}:${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

export function isOurResponse(msg: any): boolean {
  return msg?.role === "assistant" && typeof msg.responseId === "string" && msg.responseId.startsWith(RESPONSE_PREFIX);
}

export function inputHash(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);
}

export interface Match {
  binding: Binding;
  /** Index of the anchor message in the context; -1 when agy has not replied in this context yet. */
  anchor: number;
}

/**
 * Find the binding that produced the last agy assistant message in `messages`.
 * Returns undefined when there is no agy message, or the anchor's binding has produced
 * non-discardable messages after it (the context took a different branch).
 */
export function matchBinding(file: BindingFile, messages: readonly any[]): Match | undefined {
  if (!messages.some(isOurResponse)) {
    // nothing from agy in the context yet: reuse a session whose replies were all dropped
    // (first-turn errors), so a retry does not open a new ACP session
    const binding = file.bindings.find((b) => b.produced.length > 0 && b.produced.every((p) => p.discardable));
    return binding ? { binding, anchor: -1 } : undefined;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isOurResponse(messages[i])) continue;
    const id = messages[i].responseId as string;
    for (const binding of file.bindings) {
      const at = binding.produced.findIndex((p) => p.id === id);
      if (at < 0) continue;
      const later = binding.produced.slice(at + 1);
      if (later.every((p) => p.discardable)) return { binding, anchor: i };
      return undefined;
    }
    return undefined;
  }
  return undefined;
}

/** Messages after the anchor that agy has not seen: drop mirror results and our own discardable replies. */
export function newInputs(messages: readonly any[], anchor: number): any[] {
  const after = anchor >= 0 ? messages.slice(anchor + 1) : splitFresh(messages).inputs;
  return after.filter((m) => {
    if (m.role === "system") return false;
    if (m.role === "toolResult" && typeof m.toolName === "string" && m.toolName.startsWith(MIRROR_PREFIX)) return false;
    if (isOurResponse(m)) return false;
    return true;
  });
}

/** For a fresh ACP session: history to replay + trailing new input (after the last assistant). */
export function splitFresh(messages: readonly any[]): { history: any[]; inputs: any[] } {
  const conv = messages.filter((m) => m.role !== "system");
  let lastAssistant = -1;
  for (let i = conv.length - 1; i >= 0; i--) {
    if (conv[i].role === "assistant") { lastAssistant = i; break; }
  }
  return { history: conv.slice(0, lastAssistant + 1), inputs: conv.slice(lastAssistant + 1) };
}
