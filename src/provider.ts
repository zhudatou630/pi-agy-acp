// streamSimple: pi context → ACP prompt (or continuation) → pi assistant events.
import { calculateCost, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEventStream, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { type Binding, type BindingFile, inputHash, matchBinding, newInputs, newResponseId, splitFresh } from "./bindings.ts";
import { mirrorCall, planMarkdown } from "./mirror.ts";
import { historyTranscript, inputsToBlocks, type AcpBlock } from "./replay.ts";
import { type AcpSession, CANCEL_WAIT_MS, REPLAY_MAX_CHARS, type Runtime, type SessionOwner, TIMEOUT, type Turn } from "./runtime.ts";

const BATCH_MS = 150;

/** What the provider needs from its extension instance. */
export interface Instance extends SessionOwner {
  runtime: Runtime;
  /** pi session id this instance serves, when a session is bound. */
  sessionId(): string | undefined;
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
    // Token classes are agy's billed totals for the whole turn (all internal calls); totalTokens stays the
    // context size from usage_update, which pi reads for its context estimate.
    // shortcut: a turn with no usage_update (e.g. agy's own /compact) records nothing, as billed totals alone would pose as context size.
    if (usage?.used) {
      const u = this.msg.usage;
      u.input = usage.acp?.inputTokens ?? 0;
      u.cacheRead = usage.acp?.cachedReadTokens ?? 0;
      u.cacheWrite = usage.acp?.cachedWriteTokens ?? 0;
      u.output = usage.acp?.outputTokens ?? 0; // includes thoughtTokens (measured)
      u.totalTokens = usage.used;
      calculateCost(this.model, u);
    }
    this.msg.stopReason = reason;
    this.stream.push({ type: "done", reason, message: this.msg });
    this.stream.end();
  }

  fail(reason: "error" | "aborted", message: string): void {
    this.close();
    this.msg.stopReason = reason;
    this.msg.errorMessage = message;
    this.stream.push({ type: "error", reason, error: this.msg });
    this.stream.end();
  }
}

export function createStreamSimple(inst: Instance) {
  return (model: Model<any>, context: { messages: any[] }, options?: SimpleStreamOptions): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    void run(inst, model, context.messages ?? [], options ?? {}, stream);
    return stream;
  };
}

async function run(inst: Instance, model: Model<any>, messages: any[], options: SimpleStreamOptions, stream: AssistantMessageEventStream): Promise<void> {
  const rt = inst.runtime;
  // cache warming probe: never forward to a stateful agent
  if ((options as any).disableContinuation) return new Writer(stream, model).done("stop");
  const ctx = inst.ctx();
  const own = inst.sessionId();
  const sid = (options as any).sessionId as string | undefined;
  // pi-web side chats route with their parent's id; any other id (compaction, summaries) is maintenance
  const isSession = !!ctx && !!own && !!sid && (sid === own || sid === ctx.sessionManager?.getHeader?.()?.piWebSide?.parentSessionId);
  if (!isSession) return runEphemeral(rt, model, messages, options, stream, ctx?.cwd ?? process.cwd());

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
    writer = new Writer(stream, model, newResponseId(session.id));

    let turn = session.activeTurn;
    const blocks = inputsToBlocks(inputs, { images: rt.supportsImages, delivered: turn?.delivered });
    if (turn?.ended && blocks.length) {
      // agy finished while pi was busy and new input arrived: show what is left, then start fresh
      for (const item of turn.queue.drain()) if (item.kind === "update") appendChunk(writer, item.update);
      turn.closed = true;
      turn = undefined;
    }
    if (!turn) {
      if (!blocks.length) return finish(rt, file, b!, writer, "stop"); // nothing new for agy
      const transcript = history.length ? historyTranscript(history, REPLAY_MAX_CHARS) : "";
      const prompt: AcpBlock[] = transcript ? [{ type: "text", text: transcript }, ...blocks] : blocks;
      const key = inputHash(JSON.stringify(prompt));
      if (b!.failedKey === key) {
        // pi retries "transient" errors by resending; agy may already have acted on this prompt
        b!.failedKey = undefined;
        return failWith(rt, file, b!, writer, "error", "agy failed on the previous attempt; not resending automatically so it does not repeat its actions. Send again to retry.");
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

function failWith(rt: Runtime, file: BindingFile, b: Binding, writer: Writer, reason: "error" | "aborted", message: string): void {
  b.produced.push({ id: writer.msg.responseId!, discardable: true });
  rt.store.save(file);
  writer.fail(reason, message);
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
        const stop = item.result?.stopReason;
        if (turn.cancelled || stop === "cancelled") return failWith(rt, file, b, writer, "aborted", "Cancelled");
        if (item.error) {
          b.failedKey = turn.promptKey;
          return failWith(rt, file, b, writer, "error", item.error.message);
        }
        if (stop === "refusal") return failWith(rt, file, b, writer, "error", "agy refused this request (refusal)");
        b.failedKey = undefined;
        const reason = stop === "max_tokens" || stop === "max_turn_requests" ? "length" : "stop";
        return finish(rt, file, b, writer, reason, { used: s.usage.used, acp: item.result?.usage });
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
  const deadline = Date.now() + CANCEL_WAIT_MS;
  while (!turn.closed) {
    const left = deadline - Date.now();
    const item = left > 0 ? await turn.queue.next(left) : TIMEOUT;
    if (item === TIMEOUT) { s.broken = true; break; }
    if (item.kind === "end") turn.closed = true;
  }
  turn.closed = true;
  failWith(rt, file, b, writer, "aborted", "Cancelled");
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
    const blocks = inputsToBlocks(inputs, { images: rt.supportsImages });
    const transcript = historyTranscript(history, REPLAY_MAX_CHARS);
    const prompt: AcpBlock[] = transcript ? [{ type: "text", text: transcript }, ...blocks] : blocks;
    const payload = await applyPayloadHook(options, { sessionId: session.id, prompt }, model);
    if (signal?.aborted) return writer.fail("aborted", "Cancelled");
    const turn = await rt.prompt(session, payload.prompt);
    for (;;) {
      const item = await turn.queue.next(undefined, signal);
      if (item === TIMEOUT) return writer.fail("aborted", "Cancelled"); // aborted; closeSession cancels agy
      if (item.kind === "end") {
        turn.closed = true;
        if (item.error || turn.cancelled) writer.fail(turn.cancelled ? "aborted" : "error", item.error?.message ?? "Cancelled");
        else writer.done("stop", { used: session.usage.used, acp: item.result?.usage });
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
