// Shared runtime: one lazily started `agy acp` per pi process, multiplexing ACP sessions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcpError, AcpExitError, AcpProcess } from "./acp.ts";
import { BindingStore } from "./bindings.ts";
import { type Catalog, loadCatalog, mapThinkingLevel, saveCatalog } from "./catalog.ts";
import { DebugLog } from "./debug.ts";
import { isTerminal, mergeToolUpdate, type ToolState } from "./mirror.ts";

export const VERSION = "0.2.4";

/** ~/.pi/agent/pi-agy-acp/config.json */
export interface RuntimeConfig {
  agyPath?: string;
  /** Extra `agy acp` flags, e.g. --disable-telemetry. */
  extraArgs: string[];
}

export const CANCEL_WAIT_MS = 10_000;
/** Resume after a restart is lossless but pays agy's ~2.5 s warmup; one idle process is ~230 MB. */
const IDLE_SHUTDOWN_MS = 30 * 60_000;
const WATCHDOG_MS = 600_000;
/** After a background command finishes, how long agy may take to start its own report. */
const WAKE_GRACE_MS = 20_000;
/** agy ends every model call with usage_update, followed at once by that call's tool calls, if any.
 *  When nothing follows for this long, agy's own work is over (it sends no prompt response). */
const WAKE_SETTLE_MS = 2_000;
/** Fallback when agy goes quiet without a closing usage_update. It can generate silently for minutes. */
const WAKE_QUIET_MS = 120_000;
/** agy can drop a background command's final status: stop holding the reply after this much silence. */
const HOLD_SILENT_MS = 30 * 60_000;

/** Sum of two ACP prompt usages (field by field); either may be missing. */
export function addUsage(a: any, b: any): any {
  if (!a || !b) return a ?? b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) if (typeof v === "number") out[k] = (typeof out[k] === "number" ? out[k] : 0) + v;
  return out;
}

export class AuthRequiredError extends Error {
  constructor() {
    super("Not signed in to Antigravity. Run /agy login, or sign in with `agy` in a terminal, then send again.");
    this.name = "AuthRequiredError";
  }
}

export class AgyMissingError extends Error {
  constructor() {
    super("agy executable not found. Install the Antigravity CLI (check `agy --version`), or set agyPath in ~/.pi/agent/pi-agy-acp/config.json.");
    this.name = "AgyMissingError";
  }
}

export function isAuthError(err: unknown): boolean {
  return err instanceof AcpError && (err.code === -32000 || (err.code === -32603 && /^No browser is available/.test(err.message)));
}

// ---------------------------------------------------------------------------

// Symbol.for: extension instances (and /reload) re-evaluate this module, the shared runtime does not.
const TIMEOUT = Symbol.for("pi-agy-acp.timeout");

export class AsyncQueue<T> {
  private items: T[] = [];
  private waiter: ((v: T | typeof TIMEOUT) => void) | undefined;

  push(item: T): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w(item);
    } else this.items.push(item);
  }

  unshift(item: T): void {
    this.items.unshift(item);
  }

  /** Queue before a not-yet-consumed end (late output joins the reply it belongs to). */
  insertBeforeEnd(item: T): void {
    const at = this.items.findIndex((x: any) => x?.kind === "end");
    if (at < 0) this.push(item);
    else this.items.splice(at, 0, item);
  }

  /** Take whatever is queued right now. */
  drain(): T[] {
    return this.items.splice(0);
  }

  next(timeoutMs?: number, signal?: AbortSignal): Promise<T | typeof TIMEOUT> {
    if (this.items.length) return Promise.resolve(this.items.shift()!);
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (v: T | typeof TIMEOUT) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiter = undefined;
        resolve(v);
      };
      const onAbort = () => finish(TIMEOUT);
      this.waiter = finish;
      if (timeoutMs !== undefined) timer = setTimeout(() => finish(TIMEOUT), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
export { TIMEOUT };

export type TurnItem =
  | { kind: "update"; update: any }
  | { kind: "end"; result?: any; error?: Error }
  | { kind: "yield" };

export class Turn {
  readonly queue = new AsyncQueue<TurnItem>();
  latestPrompt = 0;
  ended = false;
  /** The end item has been consumed by a provider stream. */
  closed = false;
  cancelled = false;
  /** A provider stream is consuming the queue (steer may interrupt it). */
  pumping = false;
  pendingPermissions = 0;
  /** Hashes of user inputs sent to agy directly by an immediate steer, one entry per send. */
  readonly delivered: string[] = [];
  /** Hash of the prompt that opened the turn (retry guard). */
  promptKey = "";
  lastPlan = "";
  /**
   * The prompt has returned but agy still owes a reply: a command it moved to the background is
   * running (it reports when done), or agy started talking on its own. Ends on silence.
   */
  awaitingWake = false;
  /** agy has started its own report. */
  woke = false;
  /** During its own report, agy's last model call ended (usage_update) and nothing followed yet. */
  stepDone = false;
  endResult: any;
  /** Usage reported by prompts a steer superseded; added to the final prompt's. */
  carriedUsage: any;
  wakeTimer: NodeJS.Timeout | undefined;
  readonly abort = new AbortController();
  /** Monotonic (performance.now): host sleep and wall-clock changes are not agy silence. */
  lastActivity = performance.now();
}

/** Daemons and timers: they may never finish, so nothing waits for them. */
function runsForever(t: ToolState): boolean {
  return (t.kind === "execute" && t.rawInput?.IsDaemon === true)
    || t.name === "schedule" || t.title === "Run schedule" || t.title === "Running schedule";
}

/** A command agy moved to the background that finishes on its own. */
function holdsTurn(t: ToolState): boolean {
  return !isTerminal(t) && t.kind === "execute" && !runsForever(t);
}

/** What the runtime needs from the pi side of a session (one extension instance). */
export interface SessionOwner {
  ctx(): any | undefined;
  onTitle?(title: string): void;
  /** agy started talking on its own (a background command finished) with no reply open in pi. */
  onWake?(): void;
}

export class AcpSession {
  readonly id: string;
  readonly cwd: string;
  configOptions: any[] = [];
  tools = new Map<string, ToolState>();
  /** Tool ids already mirrored into pi. */
  emitted = new Set<string>();
  private toolWaiters = new Map<string, Set<() => void>>();
  turn: Turn | undefined;
  owner: SessionOwner | undefined;
  usage: { used?: number; size?: number } = {};
  /** The user pressed Stop: nothing agy says or asks afterwards opens a reply, until the next prompt. */
  stopped = false;
  /** Cancel never settled: do not reuse without close + resume. */
  broken = false;
  ephemeral = false;

  constructor(id: string, cwd: string, setup: any) {
    this.id = id;
    this.cwd = cwd;
    this.setConfigOptions(setup?.configOptions);
  }

  setConfigOptions(options: any): void {
    if (Array.isArray(options)) this.configOptions = options;
  }

  current(id: string): string | undefined {
    return this.configOptions.find((o) => o.id === id)?.currentValue;
  }

  values(id: string): string[] {
    const opt = this.configOptions.find((o) => o.id === id);
    if (!opt || !Array.isArray(opt.options)) return [];
    return opt.options.flatMap((o: any) => (Array.isArray(o.options) ? o.options : [o])).map((o: any) => o.value);
  }

  get activeTurn(): Turn | undefined {
    return this.turn && !this.turn.closed ? this.turn : undefined;
  }

  notifyTool(id: string): void {
    for (const w of this.toolWaiters.get(id) ?? []) w();
  }

  /** Resolve when the tool reaches a terminal state (or onChange on every update). */
  waitTool(id: string, signal: AbortSignal | undefined, onChange: (s: ToolState) => void): Promise<ToolState> {
    return new Promise((resolve) => {
      const check = () => {
        const s = this.tools.get(id);
        if (!s) return;
        onChange(s);
        if (isTerminal(s)) {
          set.delete(check);
          signal?.removeEventListener("abort", onAbort);
          resolve(s);
        }
      };
      const onAbort = () => {
        const s = this.tools.get(id);
        if (s && !isTerminal(s)) s.aborted = "Cancelled";
        check();
      };
      const set = this.toolWaiters.get(id) ?? new Set<() => void>();
      this.toolWaiters.set(id, set);
      set.add(check);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else check();
    });
  }

  /** Forget finished, already-mirrored tools (called when a new turn starts). Background ones stay:
   *  agy still reports on them, and their ids must keep mapping to the card already shown. */
  pruneTools(): void {
    for (const [id, s] of this.tools) {
      if ((s.status === "completed" || s.status === "failed" || s.aborted) && this.emitted.has(id)) {
        this.tools.delete(id);
        this.emitted.delete(id);
        this.toolWaiters.delete(id);
      }
    }
  }

  /** Mark every non-terminal tool and wake waiters. */
  settleTools(mark: (s: ToolState) => void): void {
    for (const s of this.tools.values()) {
      if (!isTerminal(s)) {
        mark(s);
        this.notifyTool(s.id);
      }
    }
  }
}

// ---------------------------------------------------------------------------

export class Runtime {
  readonly home: string;
  readonly config: RuntimeConfig;
  readonly debug: DebugLog;
  readonly store: BindingStore;
  catalog: Catalog;
  readonly catalogFile: string;
  proc: AcpProcess | undefined;
  init: any;
  private starting: Promise<AcpProcess> | undefined;
  readonly sessions = new Map<string, AcpSession>();
  /** Catalog-change callbacks of live sessions. */
  readonly listeners = new Set<() => void>();
  private idleTimer: NodeJS.Timeout | undefined;
  private catalogRefresh: Promise<Catalog> | undefined;
  lastExit: string | undefined;

  constructor(home: string) {
    this.home = home;
    this.config = { extraArgs: [], ...readJson(path.join(home, "config.json")) };
    this.debug = new DebugLog(path.join(home, "logs"));
    if (process.env.ACP_DEBUG) this.debug.enable(process.env.ACP_DEBUG);
    this.store = new BindingStore(path.join(home, "bindings"));
    this.store.prune(60 * 24 * 3600_000);
    this.catalogFile = path.join(home, "catalog.json");
    this.catalog = loadCatalog(this.catalogFile);
    process.once("exit", () => this.proc?.killSync());
  }

  agyPath(): string | undefined {
    const candidates = [this.config.agyPath, process.env.PI_AGY_BIN];
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) if (dir) candidates.push(path.join(dir, "agy"));
    candidates.push(path.join(os.homedir(), ".local/bin/agy"));
    for (const c of candidates) {
      if (!c) continue;
      try { fs.accessSync(c, fs.constants.X_OK); if (fs.statSync(c).isFile()) return c; } catch {}
    }
    return undefined;
  }

  childEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      // pi session details and pi-web's Node bootstrap do not belong in agy's tool environment.
      if (k.startsWith("PI_") || k === "NODE_OPTIONS") continue;
      env[k] = v;
    }
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    return env;
  }

  async ensure(): Promise<AcpProcess> {
    this.armIdle(); // every use pushes idle shutdown back
    if (this.proc?.alive && this.init) return this.proc;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const command = this.agyPath();
      if (!command) throw new AgyMissingError();
      const proc = new AcpProcess({
        command,
        args: ["acp", ...this.config.extraArgs],
        env: this.childEnv(),
        cwd: os.homedir(),
        debug: this.debug,
        onNotification: (method, params) => this.onNotification(method, params),
        onRequest: (method, params) => this.onRequest(method, params),
        onExit: (info) => this.onExit(proc, info),
      });
      this.proc = proc;
      this.init = await proc.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "pi-agy-acp", version: VERSION },
      }, 30_000);
      return proc;
    })();
    try {
      return await this.starting;
    } catch (err) {
      // a process whose handshake failed would otherwise stay alive, unreachable
      const failed = this.proc;
      this.proc = undefined;
      this.init = undefined;
      void failed?.kill();
      throw err;
    } finally {
      this.starting = undefined;
    }
  }

  get agyVersion(): string | undefined {
    return this.init?.agentInfo?.version;
  }

  get supportsImages(): boolean {
    return this.init?.agentCapabilities?.promptCapabilities?.image === true;
  }

  // -- sessions --------------------------------------------------------------

  async listSessionIds(): Promise<Set<string>> {
    const proc = await this.ensure();
    const ids = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const res = await proc.request("session/list", cursor ? { cursor } : {}, 30_000);
      for (const s of res?.sessions ?? []) ids.add(s.sessionId);
      cursor = res?.nextCursor;
      if (!cursor) break;
    }
    return ids;
  }

  async newSession(cwd: string): Promise<AcpSession> {
    const proc = await this.ensure();
    try {
      const res = await proc.request("session/new", { cwd, mcpServers: [] }, 60_000);
      const s = new AcpSession(res.sessionId, cwd, res);
      this.sessions.set(s.id, s);
      this.afterSetup(res);
      return s;
    } catch (err) {
      if (isAuthError(err)) throw new AuthRequiredError();
      throw err;
    }
  }

  /**
   * Reattach a persisted ACP session. Uses session/list first because agy "loads" unknown ids
   * as empty sessions instead of failing. Returns undefined when the session is gone.
   */
  async resumeSession(id: string, cwd: string): Promise<AcpSession | undefined> {
    const live = this.sessions.get(id);
    if (live && !live.broken) return live;
    const proc = await this.ensure();
    try {
      if (live?.broken) {
        this.sessions.delete(id);
        await proc.request("session/close", { sessionId: id }, 10_000).catch(() => {});
      }
      const ids = await this.listSessionIds();
      if (!ids.has(id)) return undefined;
      const res = await proc.request("session/resume", { sessionId: id, cwd, mcpServers: [] }, 60_000);
      const s = new AcpSession(id, cwd, res);
      this.sessions.set(id, s);
      this.afterSetup(res);
      return s;
    } catch (err) {
      if (isAuthError(err)) throw new AuthRequiredError();
      if (err instanceof AcpExitError) throw err;
      this.debug.write("resume-failed", String(err));
      return undefined;
    }
  }

  async closeSession(id: string): Promise<void> {
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    if (s) {
      this.cancel(s);
      this.endTurnNow(s, new Error("agy session closed"));
      s.settleTools((t) => { t.aborted = "agy session closed"; });
    }
    if (this.proc?.alive) await this.proc.request("session/close", { sessionId: id }, 10_000).catch(() => {});
  }

  /** Bring model / thought_level to the wanted values (agy resets them on resume). */
  async applyConfig(s: AcpSession, want: { model?: string; piLevel?: string }): Promise<void> {
    if (want.model && s.current("model") !== want.model) await this.setOption(s, "model", want.model);
    const levels = s.values("thought_level");
    const level = mapThinkingLevel(want.piLevel, levels);
    if (level && s.current("thought_level") !== level) await this.setOption(s, "thought_level", level);
  }

  private async setOption(s: AcpSession, configId: string, value: string): Promise<void> {
    const proc = await this.ensure();
    try {
      const res = await proc.request("session/set_config_option", { sessionId: s.id, configId, value }, 30_000);
      s.setConfigOptions(res?.configOptions);
    } catch (err) {
      if (err instanceof AcpError) throw new AcpError(err.method, err.code, `agy rejected ${configId}=${value}: ${err.message}`);
      throw err;
    }
  }

  /** Start a turn, or steer the running one: agy supersedes the previous prompt natively. */
  async prompt(s: AcpSession, blocks: any[]): Promise<Turn> {
    const proc = await this.ensure();
    let turn = s.activeTurn && !s.activeTurn.ended ? s.activeTurn : undefined;
    if (!turn) {
      s.turn = turn = new Turn();
      s.pruneTools();
      s.usage.used = undefined; // turns without usage_update (e.g. /compact) must not reuse the last value
      this.armWatchdog(s, turn);
    }
    const n = ++turn.latestPrompt;
    turn.lastActivity = performance.now();
    turn.awaitingWake = false; // a prompt is in flight again (steer)
    turn.woke = false;
    turn.stepDone = false;
    clearTimeout(turn.wakeTimer);
    s.stopped = false;
    proc.request("session/prompt", { sessionId: s.id, prompt: blocks }).then(
      (result) => this.endTurn(s, turn, n, { result }),
      (error: Error) => this.endTurn(s, turn, n, { error: isAuthError(error) ? new AuthRequiredError() : error }),
    );
    return turn;
  }

  private endTurn(s: AcpSession, turn: Turn, n: number, item: { result?: any; error?: Error }): void {
    if (turn.latestPrompt !== n || turn.ended) {
      // superseded by a steer: agy still billed that prompt
      if (!turn.ended) turn.carriedUsage = addUsage(turn.carriedUsage, item.result?.usage);
      return;
    }
    if (!s.ephemeral && !turn.cancelled && item.result?.stopReason === "end_turn" && [...s.tools.values()].some(holdsTurn)) {
      // agy moved a command to the background and reports when it is done: keep the pi reply
      // open, like pi's own bash. Daemons and schedules do not hold it.
      turn.awaitingWake = true;
      turn.endResult = item.result;
      s.settleTools((t) => { if (!holdsTurn(t)) t.background = true; });
      return;
    }
    this.finishTurn(s, turn, item);
  }

  private finishTurn(s: AcpSession, turn: Turn, item: { result?: any; error?: Error }): void {
    if (turn.ended) return;
    clearTimeout(turn.wakeTimer);
    turn.ended = true;
    s.settleTools((t) => {
      if (item.error) t.aborted = item.error.message;
      else if (turn.cancelled) t.aborted = "Cancelled";
      else t.background = true;
    });
    turn.abort.abort();
    turn.queue.push({ kind: "end", ...item });
  }

  /** End the running turn locally (watchdog, close, exit) and ignore whatever agy returns later. */
  private endTurnNow(s: AcpSession, error: Error): void {
    const turn = s.turn;
    if (!turn || turn.ended) return;
    turn.latestPrompt++;
    clearTimeout(turn.wakeTimer);
    turn.ended = true;
    turn.abort.abort();
    turn.queue.push({ kind: "end", error });
  }

  /** A reply agy starts on its own (no prompt): opened in pi through the owner. */
  private startWake(s: AcpSession): Turn {
    const turn = new Turn();
    turn.awaitingWake = true;
    turn.woke = true;
    turn.endResult = { stopReason: "end_turn" };
    s.turn = turn;
    s.pruneTools();
    s.usage.used = undefined;
    this.armWatchdog(s, turn);
    s.owner?.onWake?.();
    return turn;
  }

  /** While agy owes a reply: end it once nothing runs and agy has been quiet for a moment. */
  private wakeCheck(s: AcpSession, turn: Turn): void {
    if (!turn.awaitingWake || turn.ended) return;
    clearTimeout(turn.wakeTimer);
    turn.wakeTimer = undefined;
    if (turn.pendingPermissions > 0 || [...s.tools.values()].some((t) => !isTerminal(t))) return;
    const wait = !turn.woke ? WAKE_GRACE_MS : turn.stepDone ? WAKE_SETTLE_MS : WAKE_QUIET_MS;
    turn.wakeTimer = setTimeout(() => this.finishTurn(s, turn, { result: turn.endResult }), wait);
  }

  cancel(s: AcpSession): void {
    const turn = s.activeTurn;
    if (!turn || turn.ended || turn.cancelled) return;
    turn.cancelled = true;
    s.stopped = true;
    turn.abort.abort(); // dismiss permission dialogs
    this.proc?.notify("session/cancel", { sessionId: s.id });
    // no prompt in flight to return "cancelled": end it here (agy stops the background command)
    if (turn.awaitingWake) this.finishTurn(s, turn, { result: turn.endResult });
  }

  private armWatchdog(s: AcpSession, turn: Turn): void {
    const tick = () => { if (this.watchdog(s, turn)) setTimeout(tick, 30_000).unref(); };
    setTimeout(tick, 30_000).unref();
  }

  /** One watchdog check; false once the turn is over. */
  watchdog(s: AcpSession, turn: Turn): boolean {
    if (turn.ended) return false;
    const silent = performance.now() - turn.lastActivity;
    if (turn.awaitingWake && turn.pendingPermissions === 0 && silent > HOLD_SILENT_MS) {
      // no cancel: the command may still be running, and agy's later report opens a new reply
      this.finishTurn(s, turn, { result: turn.endResult });
      return false;
    }
    const busy = turn.pendingPermissions > 0 || [...s.tools.values()].some((t) => !isTerminal(t));
    if (!busy && silent > WATCHDOG_MS) {
      this.cancel(s);
      this.endTurnNow(s, new Error(`agy produced no output for ${WATCHDOG_MS / 60000} minutes; cancelled this turn`));
      s.broken = true;
      return false;
    }
    return true;
  }

  // -- inbound ---------------------------------------------------------------

  private onNotification(method: string, params: any): void {
    if (method !== "session/update") return;
    const s = this.sessions.get(params?.sessionId);
    const u = params?.update;
    if (!u || !s) return;
    if (!s.ephemeral) this.armIdle(); // agy working on its own (no prompt in flight) is use too
    let turn = s.turn && !s.turn.ended ? s.turn : undefined;
    const speaks = ["agent_message_chunk", "agent_thought_chunk", "plan"].includes(u.sessionUpdate)
      || (u.sessionUpdate === "tool_call" && !s.tools.has(u.toolCallId));
    if (!turn && speaks && !s.ephemeral && !s.stopped) {
      const prev = s.turn;
      if (prev && !prev.closed) {
        // pi has not finished the previous reply yet: let this join it, before its end
        if (u.sessionUpdate === "tool_call") s.tools.set(u.toolCallId, mergeToolUpdate(undefined, u));
        prev.queue.insertBeforeEnd({ kind: "update", update: u });
        return;
      }
      // agy talking with no reply open (e.g. a background command finished): open one
      turn = this.startWake(s);
    }
    if (turn) {
      turn.lastActivity = performance.now();
      if (speaks && turn.awaitingWake) turn.woke = true;
      if (u.sessionUpdate === "usage_update") turn.stepDone = turn.woke;
      else if (speaks) turn.stepDone = false;
    }
    switch (u.sessionUpdate) {
      case "tool_call":
      case "tool_call_update": {
        const prev = s.tools.get(u.toolCallId);
        const held = !!prev && holdsTurn(prev); // before the merge, which updates prev in place
        const state = mergeToolUpdate(prev, u);
        s.tools.set(state.id, state);
        // agy reports on a finished command in new model calls: steps closed before it ended do not count
        if (turn?.awaitingWake && held && isTerminal(state)) turn.woke = turn.stepDone = false;
        // nothing waits for daemons/timers once agy has handed control back, or for tools outside a reply
        if (!isTerminal(state) && (!turn || (turn.awaitingWake && runsForever(state)))) state.background = true;
        s.notifyTool(state.id);
        // updates of shown tools go straight to their mirror waiters, not through the stream
        if (turn && !s.emitted.has(state.id)) turn.queue.push({ kind: "update", update: u });
        break;
      }
      case "agent_message_chunk":
      case "agent_thought_chunk":
      case "plan":
        turn?.queue.push({ kind: "update", update: u });
        break;
      case "usage_update":
        s.usage = { used: u.used, size: u.size };
        this.noteContextWindow(s, u.size);
        break;
      case "config_option_update":
        s.setConfigOptions(u.configOptions);
        break;
      case "current_mode_update": {
        const mode = s.configOptions.find((o) => o.id === "mode");
        if (mode) mode.currentValue = u.currentModeId;
        break;
      }
      case "session_info_update":
        if (u.title) s.owner?.onTitle?.(u.title);
        break;
      default:
        break; // user_message_chunk only appears in load replays, which we do not use
    }
    if (turn?.awaitingWake) this.wakeCheck(s, turn);
  }

  private async onRequest(method: string, params: any): Promise<unknown> {
    if (method !== "session/request_permission") throw new AcpError(method, -32601, `pi-agy-acp does not support ${method}`);
    const s = this.sessions.get(params?.sessionId);
    const cancelled = { outcome: { outcome: "cancelled" } };
    if (!s) return cancelled;
    const tc = params.toolCall ?? {};
    const isQuestion = typeof tc.toolCallId === "string" && tc.toolCallId.startsWith("interaction_");
    if (tc.toolCallId && !isQuestion) { // a question is not a tool: it would never get a terminal update
      const state = mergeToolUpdate(s.tools.get(tc.toolCallId), tc);
      s.tools.set(state.id, state);
    }
    const options: any[] = Array.isArray(params.options) ? params.options : [];
    if (!isQuestion) {
      // Full access, like pi itself. Maintenance (ephemeral) sessions never run tools,
      // and nothing more runs once the user pressed Stop.
      const pick = s.ephemeral || s.stopped
        ? options.find((o) => o.kind === "reject_once")
        : options.find((o) => o.kind === "allow_once") ?? options.find((o) => o.kind === "allow_always");
      return pick ? { outcome: { outcome: "selected", optionId: pick.optionId } } : cancelled;
    }
    // agy asking the user a question (pick one of its options) is not an approval: ask.
    const turn = s.activeTurn;
    if (turn) {
      turn.pendingPermissions++;
      clearTimeout(turn.wakeTimer); // a reply waiting on the user does not end on silence
      turn.wakeTimer = undefined;
      turn.stepDone = false; // after the answer agy generates its next step
    }
    try {
      const ctx = s.owner?.ctx();
      if (!ctx?.hasUI || !ctx.ui) return cancelled;
      const choice = await askQuestion(ctx, tc, options, turn?.abort.signal);
      return choice ? { outcome: { outcome: "selected", optionId: choice } } : cancelled;
    } catch {
      return cancelled;
    } finally {
      if (turn) { turn.pendingPermissions--; turn.lastActivity = performance.now(); this.wakeCheck(s, turn); }
    }
  }

  private onExit(proc: AcpProcess, info: { code: number | null; signal: string | null; stderr: string }): void {
    if (this.proc !== proc) return;
    this.proc = undefined;
    this.init = undefined;
    this.lastExit = `code=${info.code} signal=${info.signal}`;
    const err = new AcpExitError(`agy process exited (${this.lastExit}). It restarts and resumes the session on your next message; this turn is not resent automatically so it does not repeat actions.`);
    for (const s of this.sessions.values()) {
      s.settleTools((t) => { t.aborted = "agy process exited"; });
      this.endTurnNow(s, err);
    }
    this.sessions.clear();
    this.clearIdle();
  }

  // -- catalog ---------------------------------------------------------------

  private afterSetup(res: any): void {
    const tier = res?._meta?.antigravity?.tier?.name;
    if (tier) this.catalog.tier = tier;
    const stale = !this.catalog.fetchedAt || this.catalog.agyVersion !== this.agyVersion || Date.now() - this.catalog.fetchedAt > 24 * 3600_000;
    if (stale) void this.refreshCatalog().catch((err) => this.debug.write("catalog-error", String(err)));
  }

  /** Probe every model's thought_level options in a throwaway session (config RPCs only, no prompts). */
  refreshCatalog(): Promise<Catalog> {
    this.catalogRefresh ??= this.probeCatalog().finally(() => { this.catalogRefresh = undefined; });
    return this.catalogRefresh;
  }

  private async probeCatalog(): Promise<Catalog> {
    let probe: AcpSession | undefined;
    try {
      const proc = await this.ensure();
      const res = await proc.request("session/new", { cwd: os.homedir(), mcpServers: [] }, 60_000);
      probe = new AcpSession(res.sessionId, os.homedir(), res);
      probe.ephemeral = true;
      this.sessions.set(probe.id, probe);
      const modelOpt = probe.configOptions.find((o) => o.id === "model");
      const models: Catalog["models"] = [];
      const old = new Map(this.catalog.models.map((m) => [m.id, m]));
      for (const o of modelOpt?.options ?? []) {
        const r = await proc.request("session/set_config_option", { sessionId: probe.id, configId: "model", value: o.value }, 30_000);
        probe.setConfigOptions(r?.configOptions);
        models.push({ id: o.value, name: o.name ?? o.value, levels: probe.values("thought_level"), contextWindow: old.get(o.value)?.contextWindow });
      }
      if (models.length) {
        this.catalog = { ...this.catalog, v: 1, models, agyVersion: this.agyVersion, fetchedAt: Date.now() };
        saveCatalog(this.catalogFile, this.catalog);
        this.emitCatalog();
      }
      return this.catalog;
    } finally {
      if (probe) await this.closeSession(probe.id);
    }
  }

  private noteContextWindow(s: AcpSession, size: unknown): void {
    if (typeof size !== "number" || size <= 0) return;
    const m = this.catalog.models.find((x) => x.id === s.current("model"));
    if (!m || m.contextWindow === size) return;
    m.contextWindow = size;
    saveCatalog(this.catalogFile, this.catalog);
    this.emitCatalog();
  }

  private emitCatalog(): void {
    for (const l of this.listeners) {
      try { l(); } catch { this.listeners.delete(l); } // a disposed session's pi API throws
    }
  }

  // -- lifecycle -------------------------------------------------------------

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  armIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      if (this.busy()) return this.armIdle();
      void this.shutdown();
    }, IDLE_SHUTDOWN_MS);
    this.idleTimer.unref();
  }

  /** Work that keeps agy alive. A broken session's turn (Stop never settled) does not: agy may never end it. */
  busy(): boolean {
    return !!this.starting || !!this.proc?.busy || [...this.sessions.values()].some((s) => !s.broken && s.turn && !s.turn.ended);
  }

  async shutdown(): Promise<void> {
    this.clearIdle();
    const proc = this.proc;
    if (!proc) return;
    await Promise.all([...this.sessions.keys()].map((id) => this.closeSession(id)));
    if (this.proc === proc) { this.proc = undefined; this.init = undefined; } // new work starts a fresh process
    await proc.kill();
  }
}

/** agy asks the user to pick one of its options (toolCallId interaction_*). */
async function askQuestion(ctx: any, tc: any, options: any[], signal?: AbortSignal): Promise<string | undefined> {
  const seen = new Map<string, number>();
  const labels = options.map((o) => {
    const l = String(o.name || o.optionId);
    const n = (seen.get(l) ?? 0) + 1;
    seen.set(l, n);
    return n > 1 ? `${l} (${n})` : l;
  });
  const picked = await ctx.ui.select(`agy asks: ${tc.title || "choose one"}`, labels, { timeout: 600_000, signal });
  return picked === undefined ? undefined : options[labels.indexOf(picked)]?.optionId;
}

function readJson(file: string): Record<string, any> {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

/** One runtime per pi process, shared by every extension instance (jiti reloads modules per session). */
export function getRuntime(): Runtime {
  const key = Symbol.for(`pi-agy-acp.runtime.${VERSION}`);
  const g = globalThis as any;
  if (!g[key]) {
    const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent");
    const home = process.env.PI_AGY_ACP_HOME ?? path.join(agentDir, "pi-agy-acp");
    g[key] = new Runtime(home);
  }
  return g[key];
}
