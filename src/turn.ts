// One ACP turn as pi consumes it: the event queue, and the rules for when agy's own work is over.
import { isTerminal, type ToolState } from "./mirror.ts";

/** Waits of the turn engine, in ms. Each runtime holds a copy; tests shorten theirs. */
export const TIMING = {
  /** After Stop: how long agy may take to end the turn before the session counts as broken. */
  cancelWait: 10_000,
  /** No output, no running tool and no open question for this long: the turn is stuck. */
  watchdog: 600_000,
  /** After a background command finishes, how long agy may take to start its own report. */
  wakeGrace: 20_000,
  /** agy ends every model call with usage_update, followed at once by that call's tool calls, if any.
   *  When nothing follows for this long, agy's own work is over (it sends no prompt response). */
  wakeSettle: 2_000,
  /** Fallback when agy goes quiet without a closing usage_update. It can generate silently for minutes. */
  wakeQuiet: 120_000,
  /** agy can drop a background command's final status: stop holding the reply after this much silence. */
  holdSilent: 30 * 60_000,
};
export type Timing = typeof TIMING;

// Symbol.for: extension instances (and /reload) re-evaluate this module, the shared runtime does not.
export const TIMEOUT = Symbol.for("pi-agy-acp.timeout");

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

export type TurnItem =
  | { kind: "update"; update: any }
  | { kind: "end"; result?: any; error?: Error }
  | { kind: "yield" };

/**
 * Where the turn stands with agy:
 * - prompt: a session/prompt is in flight; its result ends the turn.
 * - grace:  the prompt returned but a background command holds the reply; agy has not started its report.
 * - quiet:  agy is working on its own, with no prompt in flight; it may generate silently for minutes.
 * - settle: agy's last model call closed (usage_update) and nothing has followed yet.
 * Outside "prompt" agy sends nothing that says "done": the turn ends on silence, see wakeDelay().
 */
export type Phase = "prompt" | "grace" | "quiet" | "settle";

/** What agy did while it owes a reply: said or started something, closed a model call,
 *  finished the command that held the reply, or asked the user a question. */
export type WakeEvent = "speaks" | "usage" | "command-done" | "question";

export class Turn {
  readonly queue = new AsyncQueue<TurnItem>();
  latestPrompt = 0;
  phase: Phase = "prompt";
  /** agy is done with the turn (the end item is queued). */
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
  /** Result to end with once agy's own work is over. */
  endResult: any;
  /** Usage reported by prompts a steer superseded; added to the final prompt's. */
  carriedUsage: any;
  wakeTimer: NodeJS.Timeout | undefined;
  readonly abort = new AbortController();
  /** Monotonic (performance.now): host sleep and wall-clock changes are not agy silence. */
  lastActivity = performance.now();

  /** The prompt has returned but agy still owes a reply. */
  get awaitingWake(): boolean {
    return this.phase !== "prompt";
  }

  note(event: WakeEvent): void {
    if (this.phase === "prompt") return;
    if (event === "speaks") this.phase = "quiet";
    else if (event === "usage") { if (this.phase === "quiet") this.phase = "settle"; }
    // agy reports on a finished command in new model calls: steps it closed before do not count
    else if (event === "command-done") this.phase = "grace";
    // after the answer agy generates its next step
    else if (this.phase === "settle") this.phase = "quiet";
  }

  /** Silence after which agy's own work counts as over; undefined while a tool runs, a question is open, or a prompt is in flight. */
  wakeDelay(toolsRunning: boolean, timing: Timing): number | undefined {
    if (this.phase === "prompt" || this.ended || this.pendingPermissions > 0 || toolsRunning) return undefined;
    return this.phase === "grace" ? timing.wakeGrace : this.phase === "settle" ? timing.wakeSettle : timing.wakeQuiet;
  }

  /** "release": stop holding the reply, without a cancel. "stuck": cancel the turn. `now` is monotonic. */
  watchdog(toolsRunning: boolean, now: number, timing: Timing): "ok" | "release" | "stuck" {
    const silent = now - this.lastActivity;
    if (this.awaitingWake && this.pendingPermissions === 0 && silent > timing.holdSilent) return "release";
    if (!toolsRunning && this.pendingPermissions === 0 && silent > timing.watchdog) return "stuck";
    return "ok";
  }
}

/** Daemons and timers: they may never finish, so nothing waits for them. */
export function runsForever(t: ToolState): boolean {
  return (t.kind === "execute" && t.rawInput?.IsDaemon === true)
    || t.name === "schedule" || t.title === "Run schedule" || t.title === "Running schedule";
}

/** A command agy moved to the background that finishes on its own. */
export function holdsTurn(t: ToolState): boolean {
  return !isTerminal(t) && t.kind === "execute" && !runsForever(t);
}
