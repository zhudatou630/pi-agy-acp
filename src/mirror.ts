// ACP tool_call state → pi mirror tool calls/results shaped for pi-web's renderers.
import fs from "node:fs";

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export interface ToolState {
  id: string;
  kind?: string;
  name?: string;
  title?: string;
  status: ToolStatus;
  rawInput?: any;
  rawOutput?: any;
  content: any[];
  locations: { path: string; line?: number }[];
  /** The ACP turn ended while the tool was still running (agy keeps it in the background). */
  background?: boolean;
  /** Process exited or session was cancelled. */
  aborted?: string;
}

export const MIRROR_TOOLS = ["agy_bash", "agy_edit", "agy_write", "agy_read", "agy_tool", "agy_todo"] as const;

export function mergeToolUpdate(prev: ToolState | undefined, u: any): ToolState {
  const s: ToolState = prev ?? { id: u.toolCallId, status: "pending", content: [], locations: [] };
  if (u.kind) s.kind = u.kind;
  if (u.name) s.name = u.name;
  if (u.title) s.title = u.title;
  if (u.status) s.status = u.status;
  if (u.rawInput !== undefined) s.rawInput = u.rawInput;
  if (u.rawOutput !== undefined) s.rawOutput = u.rawOutput;
  if (Array.isArray(u.content)) s.content = u.content;
  if (Array.isArray(u.locations)) s.locations = u.locations;
  return s;
}

export function isTerminal(s: ToolState): boolean {
  return s.status === "completed" || s.status === "failed" || !!s.background || !!s.aborted;
}

function inputOf(s: ToolState): Record<string, any> {
  return s.rawInput && typeof s.rawInput === "object" ? s.rawInput : {};
}

function pick(obj: Record<string, any>, ...keys: string[]): any {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  return undefined;
}

function diffBlock(s: ToolState): { path: string; oldText?: string | null; newText: string } | undefined {
  return s.content.find((c) => c?.type === "diff");
}

function primaryPath(s: ToolState): string | undefined {
  return diffBlock(s)?.path ?? s.locations[0]?.path ?? pick(inputOf(s), "Path", "path", "AbsolutePath", "TargetFile", "file_path");
}

/** pi tool name + arguments for a mirror call. Arguments only drive pi-web's display. */
export function mirrorCall(s: ToolState): { name: string; args: Record<string, any> } {
  const input = inputOf(s);
  if (s.kind === "execute") {
    const command = pick(input, "CommandLine", "command", "Command", "cmd") ?? s.title ?? "";
    return { name: "agy_bash", args: { command: String(command) } };
  }
  if (s.kind === "edit") {
    const d = diffBlock(s);
    const path = primaryPath(s) ?? s.title ?? "";
    const oldText = d?.oldText ?? pick(input, "Target", "TargetContent", "old_string", "oldText");
    const newText = d?.newText ?? pick(input, "Replacement", "ReplacementContent", "new_string", "newText");
    if (oldText != null && oldText !== "") return { name: "agy_edit", args: { path, oldText: String(oldText), newText: String(newText ?? "") } };
    const content = d?.newText ?? pick(input, "Content", "content", "CodeContent") ?? "";
    return { name: "agy_write", args: { path, content: String(content) } };
  }
  if (s.kind === "read") return { name: "agy_read", args: { path: primaryPath(s) ?? s.title ?? "" } };
  const args: Record<string, any> = { title: s.title ?? s.name ?? s.kind ?? "tool" };
  if (s.kind) args.kind = s.kind;
  for (const [k, v] of Object.entries(input)) {
    if (k === "toolSummary") continue;
    if (["string", "number", "boolean"].includes(typeof v) && String(v).length <= 500) args[k] = v;
  }
  return { name: "agy_tool", args };
}

// agy prefixes command output with timing/exit lines (background commands omit the timing)
const COMMAND_PREAMBLE = /^(?:Created At:[^\n]*\n)?(?:Completed At:[^\n]*\n)?(?:Command exited with code -?\d+\.?\n)?\n?(?:Command output:\n)?/;
const MAX_RESULT = 20_000;
const LOCATE_MAX_BYTES = 1024 * 1024;

function textOf(s: ToolState): string {
  const parts: string[] = [];
  for (const c of s.content) {
    if (c?.type === "content" && c.content?.type === "text") parts.push(c.content.text);
  }
  if (parts.length === 0 && typeof s.rawOutput?.output === "string") parts.push(s.rawOutput.output);
  return parts.join("\n");
}

function clip(text: string): string {
  return text.length > MAX_RESULT ? text.slice(0, MAX_RESULT) + `\n… (truncated, ${text.length} chars total)` : text;
}

export interface MirrorResult {
  content: { type: "text"; text: string }[];
  details: Record<string, any>;
  isError: boolean;
}

export function mirrorResult(s: ToolState): MirrorResult {
  const details: Record<string, any> = { agy: { title: s.title, kind: s.kind, name: s.name, status: s.status } };
  const notes: string[] = [];
  if (s.aborted) return { content: [{ type: "text", text: s.aborted }], details, isError: true };
  if (s.background && s.status !== "completed" && s.status !== "failed") {
    return { content: [{ type: "text", text: "Still running in the background (managed by agy)." }], details, isError: false };
  }
  let text = textOf(s);
  let isError = s.status === "failed";
  if (s.kind === "execute") {
    if (/^(Created At:|Command exited with code)/.test(text)) text = text.replace(COMMAND_PREAMBLE, "");
    text = text.replace(/\r\n/g, "\n");
    const exit = s.rawOutput?.exit_code ?? s.rawOutput?.exitCode;
    if (typeof exit === "number") {
      details.agy.exitCode = exit;
      if (exit !== 0) { isError = true; notes.push(`exit ${exit}`); }
    }
    if (!text.trim()) text = "(no output)";
  } else if (s.kind === "edit") {
    const patch = patchFor(s);
    if (patch) { details.patch = patch.patch; if (!patch.located) details.agy.lineNumbersUnknown = true; }
    text = text.trim() || (isError ? "Edit failed" : `Edited ${primaryPath(s) ?? ""}`);
  } else if (!text.trim()) {
    const p = primaryPath(s);
    text = isError ? "Failed" : s.kind === "read" && p ? `Read ${p}` : "Done";
  }
  if (notes.length) text = `${text}\n${notes.join(" ")}`;
  return { content: [{ type: "text", text: clip(text) }], details, isError };
}

/** Unified diff for an ACP diff block; line numbers come from locating newText in the current file. */
export function patchFor(s: ToolState): { patch: string; located: boolean } | undefined {
  const d = diffBlock(s);
  if (!d) return undefined;
  let start = 1;
  let located = false;
  if (d.oldText) {
    try {
      // only trust a unique, non-empty match; otherwise show the snippet without line numbers
      // a big file is not read on pi's event loop just for line numbers
      const st = fs.statSync(d.path);
      const current = st.isFile() && st.size <= LOCATE_MAX_BYTES ? fs.readFileSync(d.path, "utf8") : "";
      const at = d.newText && current ? current.indexOf(d.newText) : -1;
      if (at >= 0 && current.indexOf(d.newText, at + 1) < 0) { start = current.slice(0, at).split("\n").length; located = true; }
    } catch {}
  } else {
    located = true;
  }
  return { patch: unifiedDiff(d.path, d.oldText ?? null, d.newText, start), located };
}

function lines(text: string): string[] {
  if (text === "") return [];
  const out = text.split("\n");
  if (out[out.length - 1] === "") out.pop();
  return out;
}

/** Single-hunk diff of a snippet: shared leading/trailing lines become context. */
export function unifiedDiff(file: string, oldText: string | null, newText: string, startLine = 1): string {
  const a = oldText === null ? [] : lines(oldText);
  const b = lines(newText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const body = [
    ...a.slice(0, pre).map((l) => " " + l),
    ...a.slice(pre, a.length - suf).map((l) => "-" + l),
    ...b.slice(pre, b.length - suf).map((l) => "+" + l),
    ...a.slice(a.length - suf).map((l) => " " + l),
  ];
  const oldStart = oldText === null ? 0 : startLine;
  const header = `--- ${oldText === null ? "/dev/null" : "a/" + file.replace(/^\//, "")}\n+++ b/${file.replace(/^\//, "")}\n`;
  return `${header}@@ -${oldStart},${a.length} +${startLine},${b.length} @@\n${body.join("\n")}\n`;
}

/** ACP plan entries → markdown checklist. */
export function planMarkdown(entries: any[]): string {
  return entries
    .map((e) => `- [${e?.status === "completed" ? "x" : " "}] ${e?.status === "in_progress" ? "**in progress** " : ""}${e?.content || "(unnamed step)"}`)
    .join("\n");
}
