// streamSimple: pi context → ACP prompt (or continuation) → pi assistant events.
import { calculateCost, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEventStream, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { type Binding, type BindingFile, inputHash, matchBinding, newInputs, newResponseId, splitFresh } from "./bindings.ts";
import { mirrorCall, planMarkdown } from "./mirror.ts";
import { historyTranscript, inputsToBlocks, REPLAY_MAX_CHARS, type AcpBlock } from "./replay.ts";
import { type AcpSession, addUsage, type Runtime, type SessionOwner } from "./runtime.ts";
import { TIMEOUT, type Turn } from "./turn.ts";

const BATCH_MS = 150;
// agy maps only quota exhaustion to refusal; keep the raw reason as a fallback. Avoids pi's retry keywords.
const QUOTA_MESSAGE = "Antigravity quota exhausted (agy stopReason: refusal). Wait for the quota to reset or switch models.";
// agy never sees pi's tool list: a session without write-capable tools says so in words. Advisory, per request.
const READ_ONLY_NOTE = "[pi: read-only session. For this request, do not modify files or run commands that change anything.]";

/** What the provider needs from its extension instance. */
export interface Instance extends SessionOwner {
  runtime: Runtime;
  /** No write-capable pi tool is active (pi-web's read-only preset, explore subagents). */
  readOnly(): boolean;
  /** Remember which ACP session serves this pi session (for steer and questions). */
  attach(session: AcpSession | undefined, file: BindingFile | undefined, binding: Binding | undefined): void;
  session(): AcpSession | undefined;
}

class Writer {
  readonly msg: AssistantMessage;
  private open: { type: "text" | "thinking"; index: number } | undefined;
  private started = false;
  readonly stream: AssistantMessageEventStream;
  private readonly model: Model<any>;
  constructor(stream: AssistantMessageEventStream, model: Model<any>, responseId?: string) {
    this.stream = stream;
    this.model = model;
    this.msg = {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: "pending",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      ...(responseId ? { responseId } : {}),
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stream.push({ type: "start", partial: this.msg });
  }

  private close(): void {
    if (!this.open) return;
    const { type, index } = this.open;
    const block: any = this.msg.content[index];
    if (type === "text") this.stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: this.msg });
    else this.stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: this.msg });
    this.open = undefined;
  }

  append(type: "text" | "thinking", delta: string): void {
    if (!delta) return;
    this.start();
    if (this.open?.type !== type) {
      this.close();
      const index = this.msg.content.push(type === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" }) - 1;
      this.open = { type, index };
      this.stream.push({ type: type === "text" ? "text_start" : "thinking_start", contentIndex: index, partial: this.msg } as any);
    }
    const block: any = this.msg.content[this.open.index];
    if (type === "text") block.text += delta;
    else block.thinking += delta;
    this.stream.push({ type: type === "text" ? "text_delta" : "thinking_delta", contentIndex: this.open.index, delta, partial: this.msg } as any);
  }

  toolCall(id: string, name: string, args: Record<string, any>): void {
    this.start();
    this.close();
    const call = { type: "toolCall" as const, id, name, arguments: args };
    const index = this.msg.content.push(call) - 1;
    this.stream.push({ type: "toolcall_start", contentIndex: index, partial: this.msg });
    this.stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(args), partial: this.msg });
    this.stream.push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: this.msg });
  }

  done(reason: "stop" | "toolUse" | "length", usage?: Usage): void {
    this.start();
    this.close();
    this.applyUsage(usage);
    this.msg.stopReason = reason;
    this.stream.push({ type: "done", reason, message: this.msg });
    this.stream.end();
  }

  private applyUsage(usage?: Usage): void {
    // Cost is priced from agy's billed totals for the whole turn (all internal calls). Token fields then describe
    // the context: totalTokens = usage_update size, and the prompt classes are scaled to it (keeping the cache ratio),
    // because pi reads input+cacheRead of one message as a single request (silent-overflow check, context estimate).
    // shortcut: a turn with no usage_update (e.g. agy's own /compact) records nothing, as billed totals alone would pose as context size.
    if (usage?.used) {
      const u = this.msg.usage;
      u.input = usage.acp?.inputTokens ?? 0;
      u.cacheRead = usage.acp?.cachedReadTokens ?? 0;
      u.cacheWrite = usage.acp?.cachedWriteTokens ?? 0;
      u.output = usage.acp?.outputTokens ?? 0; // includes thoughtTokens (measured)
      u.totalTokens = usage.used;
      calculateCost(this.model, u);
      const prompt = u.input + u.cacheRead + u.cacheWrite;
      if (prompt > 0) {
        const k = usage.used / prompt;
        u.cacheRead = Math.round(u.cacheRead * k);
        u.cacheWrite = Math.min(Math.round(u.cacheWrite * k), usage.used - u.cacheRead); // rounding must not push input negative
        u.input = usage.used - u.cacheRead - u.cacheWrite;
      }
    }
  }

  /** `usage`: what agy billed before failing (pi leaves error messages out of its context estimate). */
  fail(reason: "error" | "aborted", message: string, usage?: Usage): void {
    this.close();
    this.applyUsage(usage);
    this.msg.stopReason = reason;
    this.msg.errorMessage = message;
    this.stream.push({ type: "error", reason, error: this.msg });
    this.stream.end();
  }
}

export function createStreamSimple(inst: Instance) {
  return (model: Model<any>, context: { messages: any[] }, options?: SimpleStreamOptions): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    // whatever goes wrong, the stream ends: pi waits on it forever otherwise
    run(inst, model, context.messages ?? [], options ?? {}, stream).catch((err) => new Writer(stream, model).fail("error", err instanceof Error ? err.message : String(err)));
    return stream;
  };
}

/**
 * The instance whose agent run this request is part of: it carries that run's abort signal. A
 * session id cannot tell: pi-web's subagents share their parent's model runtime (the last instance
 * to register receives everyone's requests), side chats send their parent's id, and auto-name sends
 * the session's own id from a temporary agent. No instance means maintenance (compaction, summaries,
 * titles); `cwd` is then the directory of the session with that id, else of the registered instance.
 */
function route(registered: Instance, options: SimpleStreamOptions): { inst?: Instance; cwd: string } {
  const instances = registered.runtime.instances as Set<Instance>;
  const sid = (options as any).sessionId as string | undefined;
  let sameId: string | undefined;
  let fallback: string | undefined;
  for (const i of new Set([registered, ...instances])) {
    try {
      const ctx = i.ctx();
      if (!ctx) continue;
      if (options.signal && ctx.signal === options.signal) return { inst: i, cwd: ctx.cwd };
      if (sid && i.sessionId() === sid) sameId = ctx.cwd;
      else if (i === registered) fallback = ctx.cwd;
    } catch {
      instances.delete(i); // a disposed session's ctx throws
    }
  }
  return { cwd: sameId ?? fallback ?? process.cwd() };
}

async function run(registered: Instance, model: Model<any>, messages: any[], options: SimpleStreamOptions, stream: AssistantMessageEventStream): Promise<void> {
  const rt = registered.runtime;
  // cache warming probe: never forward to a stateful agent
  if ((options as any).disableContinuation) return new Writer(stream, model).done("stop");
  const { inst, cwd } = route(registered, options);
  if (!inst) return runEphemeral(rt, model, messages, options, stream, cwd);
  const ctx = inst.ctx();
  const own = inst.sessionId()!;

  const signal = options.signal;
  let writer: Writer | undefined;
  let file: BindingFile | undefined;
  let b: Binding | undefined;
  try {
    file = rt.store.load(own);
    const match = matchBinding(file, messages);
    let session: AcpSession | undefined;
    let inputs: any[];
    let history: any[] = [];
    let notice: string | undefined;
    if (match) {
      b = match.binding;
      inputs = newInputs(messages, match.anchor);
      // a turn this instance is still draining (e.g. agy crashed during a mirror wait) comes first
      const attached = inst.session();
      session = attached?.id === b.acpSessionId && attached.activeTurn ? attached : await rt.resumeSession(b.acpSessionId, b.cwd);
      if (!session) {
        history = match.anchor >= 0 ? messages.slice(0, match.anchor + 1).filter((m) => m.role !== "system") : splitFresh(messages).history;
        notice = "The previous agy session no longer exists; started a new one with the earlier conversation transcript.";
        file.bindings = file.bindings.filter((x) => x !== b);
      }
    } else {
      ({ history, inputs } = splitFresh(messages));
    }
    if (!session) {
      session = await rt.newSession(ctx.cwd);
      b = { acpSessionId: session.id, cwd: ctx.cwd, createdAt: Date.now(), lastActive: Date.now(), produced: [] };
      file.bindings.unshift(b);
    }
    b!.lastActive = Date.now();
    session.owner = inst;
    inst.attach(session, file, b);
    if (notice) ctx.ui?.notify?.(notice, "warning");
    if (rt.versionNotice) {
      ctx.ui?.notify?.(rt.versionNotice, "warning");
      rt.versionNotice = undefined;
    }
    writer = new Writer(stream, model, newResponseId(session.id));

    let turn = session.activeTurn;
    const blocks = inputsToBlocks(inputs, { images: rt.supportsImages, delivered: turn?.delivered, history });
    if (turn?.ended && blocks.length) {
      // agy finished while pi was busy and new input arrived: show what is left, then start fresh
      for (const item of turn.queue.drain()) if (item.kind === "update") appendChunk(writer, item.update);
      turn.closed = true;
      turn = undefined;
    }
    if (!turn) {
      if (!blocks.length) return finish(rt, file, b!, writer, "stop"); // nothing new for agy
      const transcript = history.length ? historyTranscript(history, REPLAY_MAX_CHARS, messages) : "";
      const prompt: AcpBlock[] = [transcript, inst.readOnly() ? READ_ONLY_NOTE : ""].filter(Boolean).map((text) => ({ type: "text" as const, text }));
      prompt.push(...blocks);
      const key = inputHash(JSON.stringify([transcript, blocks])); // the user's input, not our note
      if (b!.failedKey === key) {
        // pi retries "transient" errors by resending; agy may already have acted on this prompt
        b!.failedKey = undefined;
        return failWith(rt, file, b!, writer, "error", "agy failed on the previous attempt (see the error above); not resending automatically so it does not repeat its actions. Send again to retry.");
      }
      await rt.applyConfig(session, { model: model.id, piLevel: (options as any).reasoning });
      const payload = await applyPayloadHook(options, { sessionId: session.id, prompt }, model);
      if (signal?.aborted) return failWith(rt, file, b!, writer, "aborted", "Cancelled");
      turn = await rt.prompt(session, payload.prompt);
      turn.promptKey = key;
    } else if (blocks.length && !turn.ended) {
      // pi delivered input at a tool boundary while agy is still working: native steer
      const payload = await applyPayloadHook(options, { sessionId: session.id, prompt: blocks }, model);
      if (!signal?.aborted) await rt.prompt(session, payload.prompt);
    }
    await pump(rt, session, turn, writer, file, b!, options, model);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // name, not instanceof: the shared runtime may come from another evaluation of this module
    if ((err as Error)?.name === "AuthRequiredError") ctx.ui?.notify?.(message, "error");
    if (writer && file && b) failWith(rt, file, b, writer, "error", message);
    else (writer ?? new Writer(stream, model)).fail("error", message);
  }
}

/** Text and thought chunks; returns false for anything else. */
function appendChunk(writer: Writer, u: any): boolean {
  if (u.content?.type !== "text") return false;
  if (u.sessionUpdate === "agent_message_chunk") writer.append("text", u.content.text);
  else if (u.sessionUpdate === "agent_thought_chunk") writer.append("thinking", u.content.text);
  else return false;
  return true;
}

async function applyPayloadHook(options: SimpleStreamOptions, payload: { sessionId: string; prompt: AcpBlock[] }, model: Model<any>) {
  const hook = (options as any).onPayload;
  if (typeof hook !== "function") return payload;
  const replaced = await hook(payload, model);
  return replaced && Array.isArray(replaced.prompt) ? replaced : payload;
}

/** How a turn ended, for chat and maintenance requests alike. */
function turnOutcome(turn: Turn, item: { result?: any; error?: Error }): { done: "stop" | "length" } | { fail: "error" | "aborted"; message: string } {
  const stop = item.result?.stopReason;
  if (turn.cancelled || stop === "cancelled") return { fail: "aborted", message: "Cancelled" };
  if (item.error) return { fail: "error", message: item.error.message };
  if (stop === "refusal") return { fail: "error", message: QUOTA_MESSAGE };
  return { done: stop === "max_tokens" || stop === "max_turn_requests" ? "length" : "stop" };
}

/** `used`: context size from the last usage_update; `acp`: the prompt result's usage. */
interface Usage {
  used?: number;
  acp?: { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number; cachedWriteTokens?: number };
}

function finish(rt: Runtime, file: BindingFile, b: Binding, writer: Writer, reason: "stop" | "toolUse" | "length", usage?: Usage): void {
  b.produced.push({ id: writer.msg.responseId!, discardable: false });
  rt.store.save(file);
  writer.done(reason, usage);
}

function failWith(rt: Runtime, file: BindingFile, b: Binding, writer: Writer, reason: "error" | "aborted", message: string, usage?: Usage): void {
  b.produced.push({ id: writer.msg.responseId!, discardable: true });
  rt.store.save(file);
  writer.fail(reason, message, usage);
}

async function pump(rt: Runtime, s: AcpSession, turn: Turn, writer: Writer, file: BindingFile, b: Binding, options: SimpleStreamOptions, model: Model<any>): Promise<void> {
  const signal = options.signal;
  turn.pumping = true;
  try {
    for (;;) {
      if (signal?.aborted) return await drainAborted(rt, s, turn, writer, file, b);
      const item = await turn.queue.next(undefined, signal);
      if (item === TIMEOUT) continue; // abort wake-up; handled at loop top
      // an immediate steer interrupted this reply: pi inserts the steer message next
      if (item.kind === "yield") return finish(rt, file, b, writer, "stop");
      if (item.kind === "end") {
        turn.closed = true;
        const usage = { used: s.usage.used, acp: addUsage(turn.carriedUsage, item.result?.usage) };
        const end = turnOutcome(turn, item);
        if ("fail" in end) {
          if (end.fail === "aborted") return failWith(rt, file, b, writer, "aborted", end.message);
          if (item.error) b.failedKey = turn.promptKey;
          return failWith(rt, file, b, writer, "error", end.message, usage);
        }
        b.failedKey = undefined;
        return finish(rt, file, b, writer, end.done, usage);
      }
      const u = item.update;
      await (options as any).onProviderStreamEvent?.(u, model);
      if (appendChunk(writer, u)) continue;
      if (u.sessionUpdate === "plan") {
        const md = planMarkdown(Array.isArray(u.entries) ? u.entries : []);
        if (!md || md === turn.lastPlan) continue;
        turn.lastPlan = md;
        const id = `agy_plan_${newResponseId(s.id).slice(-12)}`;
        s.tools.set(id, { id, kind: "plan", title: "Plan", status: "completed", content: [{ type: "content", content: { type: "text", text: md } }], locations: [] });
        s.emitted.add(id);
        writer.toolCall(id, "agy_todo", { entries: u.entries });
        return finish(rt, file, b, writer, "toolUse");
      }
      if (u.sessionUpdate !== "tool_call" && u.sessionUpdate !== "tool_call_update") continue;
      if (!emitMirror(s, writer, u.toolCallId)) continue;
      // short window: agy often announces parallel tools back to back
      for (;;) {
        const next = await turn.queue.next(BATCH_MS, signal);
        if (next === TIMEOUT) break;
        if (next.kind === "yield") continue; // the steer lands at this tool boundary anyway
        if (next.kind === "update" && (next.update.sessionUpdate === "tool_call" || next.update.sessionUpdate === "tool_call_update")) {
          emitMirror(s, writer, next.update.toolCallId);
          continue;
        }
        turn.queue.unshift(next);
        break;
      }
      if (signal?.aborted) return await drainAborted(rt, s, turn, writer, file, b);
      return finish(rt, file, b, writer, "toolUse");
    }
  } finally {
    turn.pumping = false;
  }
}

/** Emit a mirror call for a tool not yet shown. Questions (interaction_*) are not tools. */
function emitMirror(s: AcpSession, writer: Writer, id: string): boolean {
  if (!id || s.emitted.has(id) || id.startsWith("interaction_")) return false;
  const state = s.tools.get(id);
  if (!state) return false;
  s.emitted.add(id);
  const call = mirrorCall(state);
  writer.toolCall(id, call.name, call.args);
  return true;
}

async function drainAborted(rt: Runtime, s: AcpSession, turn: Turn, writer: Writer, file: BindingFile, b: Binding): Promise<void> {
  rt.cancel(s);
  const deadline = Date.now() + rt.timing.cancelWait;
  while (!turn.closed) {
    const left = deadline - Date.now();
    const item = left > 0 ? await turn.queue.next(left) : TIMEOUT;
    if (item === TIMEOUT) { s.broken = true; break; }
    if (item.kind === "end") turn.closed = true;
  }
  turn.closed = true;
  failWith(rt, file, b, writer, "aborted", "Cancelled");
}

/**
 * Run agy's own /compact in the ACP session the next request of this pi session would continue.
 * pi's compaction only shortens pi's history: the ACP session keeps its whole context until agy
 * compacts it. Returns "none" when there is no such session, "busy" while a reply is open in it.
 */
export async function compactAgy(inst: Instance, want: { model?: string; piLevel?: string }, signal?: AbortSignal): Promise<"done" | "none" | "busy"> {
  const rt = inst.runtime;
  const ctx = inst.ctx();
  const own = inst.sessionId();
  if (!ctx || !own) return "none";
  const file = rt.store.load(own);
  // the context as the next request carries it: anchors pi compacted away no longer count
  const match = matchBinding(file, ctx.sessionManager.buildSessionProjection().messages);
  if (!match || match.anchor < 0) return "none";
  const session = await rt.resumeSession(match.binding.acpSessionId, match.binding.cwd);
  if (!session) return "none";
  // not closed: pi is still showing that reply, and a prompt now would steer it
  if (session.activeTurn || session.command) return "busy";
  session.owner = inst;
  inst.attach(session, file, match.binding);
  const stop = (await rt.command(session, "/compact", want, signal))?.stopReason;
  if (stop === "end_turn") return "done";
  throw new Error(stop === "refusal" ? QUOTA_MESSAGE : stop === "cancelled" ? "Cancelled" : `agy ended /compact with ${stop}`);
}

/** Requests outside the pi session (compaction, summaries): one-shot session, text only, tools denied. */
async function runEphemeral(rt: Runtime, model: Model<any>, messages: any[], options: SimpleStreamOptions, stream: AssistantMessageEventStream, cwd: string): Promise<void> {
  const writer = new Writer(stream, model);
  const signal = options.signal;
  let session: AcpSession | undefined;
  try {
    session = await rt.newSession(cwd);
    session.ephemeral = true;
    await rt.applyConfig(session, { model: model.id, piLevel: (options as any).reasoning });
    const { history, inputs } = splitFresh(messages);
    const blocks = inputsToBlocks(inputs, { images: rt.supportsImages, history });
    const transcript = historyTranscript(history, REPLAY_MAX_CHARS, messages);
    const prompt: AcpBlock[] = transcript ? [{ type: "text", text: transcript }, ...blocks] : blocks;
    const payload = await applyPayloadHook(options, { sessionId: session.id, prompt }, model);
    if (signal?.aborted) return writer.fail("aborted", "Cancelled");
    const turn = await rt.prompt(session, payload.prompt);
    for (;;) {
      const item = await turn.queue.next(undefined, signal);
      if (item === TIMEOUT) return writer.fail("aborted", "Cancelled"); // aborted; closeSession cancels agy
      if (item.kind === "end") {
        turn.closed = true;
        const usage = { used: session.usage.used, acp: item.result?.usage };
        const end = turnOutcome(turn, item);
        // pi saves only a "stop" summary: a refused or cut-off one must not become a checkpoint
        if ("done" in end) writer.done(end.done, usage);
        else writer.fail(end.fail, end.message, end.fail === "aborted" ? undefined : usage);
        return;
      }
      if (item.kind === "update") appendChunk(writer, item.update);
    }
  } catch (err) {
    writer.fail("error", err instanceof Error ? err.message : String(err));
  } finally {
    if (session) void rt.closeSession(session.id);
  }
}
