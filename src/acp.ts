// JSON-RPC 2.0 over NDJSON stdio to `agy acp`, plus the process lifecycle.
import { spawn, type ChildProcess } from "node:child_process";
import type { DebugLog } from "./debug.ts";

export class AcpError extends Error {
  readonly code: number;
  readonly data: unknown;
  readonly method: string;
  constructor(method: string, code: number, message: string, data?: unknown) {
    super(message);
    this.name = "AcpError";
    this.method = method;
    this.code = code;
    this.data = data;
  }
}

export class AcpExitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpExitError";
  }
}

export interface SpawnOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  debug: DebugLog;
  onNotification: (method: string, params: any) => void;
  onRequest: (method: string, params: any) => Promise<unknown>;
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null; stderr: string }) => void;
}

type Pending = { method: string; resolve: (v: any) => void; reject: (e: Error) => void };

const STDERR_TAIL = 4000;

export class AcpProcess {
  readonly child: ChildProcess;
  readonly pid: number;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private buf = "";
  private stderrTail = "";
  private exited = false;
  private exitWaiters: Array<() => void> = [];
  private opts: SpawnOptions;

  constructor(opts: SpawnOptions) {
    this.opts = opts;
    // detached: own process group, so shutdown can signal agy and everything it spawned.
    this.child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    if (!this.child.pid) {
      // spawn failure surfaces via 'error'; give callers a pid-less handle that is already dead.
      this.pid = -1;
    } else {
      this.pid = this.child.pid;
    }
    opts.debug.write("spawn", { command: opts.command, args: opts.args, pid: this.pid });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL);
      opts.debug.write("stderr", chunk);
    });
    this.child.stdin!.on("error", () => {}); // EPIPE after exit is reported via 'exit'
    this.child.on("error", (err) => this.handleExit(null, null, `spawn error: ${err.message}`));
    this.child.on("exit", (code, signal) => this.handleExit(code, signal));
  }

  get alive(): boolean {
    return !this.exited;
  }

  /** Requests in flight (setup, resume, prompts). */
  get busy(): boolean {
    return this.pending.size > 0;
  }

  request<T = any>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (this.exited) return Promise.reject(new AcpExitError(`agy acp 进程已退出，无法调用 ${method}`));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (fn: () => void) => {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        fn();
      };
      this.pending.set(id, {
        method,
        resolve: (v) => done(() => resolve(v)),
        reject: (e) => done(() => reject(e)),
      });
      if (timeoutMs) {
        timer = setTimeout(() => this.pending.get(id)?.reject(new AcpError(method, -32001, `${method} 超时（${timeoutMs} ms）`)), timeoutMs);
      }
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.exited) return;
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** Close stdin, TERM the whole process group, KILL after graceMs. Resolves when exited. */
  async kill(graceMs = 2000): Promise<void> {
    if (this.exited) return;
    try { this.child.stdin!.end(); } catch {}
    this.signalGroup("SIGTERM");
    const exited = new Promise<void>((r) => this.exitWaiters.push(r));
    const timer = setTimeout(() => this.signalGroup("SIGKILL"), graceMs);
    await exited; // handleExit sweeps the group
    clearTimeout(timer);
  }

  /** Synchronous best-effort kill for process 'exit' handlers. */
  killSync(): void {
    this.signalGroup("SIGTERM");
  }

  private signalGroup(sig: NodeJS.Signals): void {
    if (this.pid <= 0) return;
    try { process.kill(-this.pid, sig); } catch {}
  }

  private send(msg: unknown): void {
    if (this.exited || this.child.stdin!.writableEnded) return;
    this.opts.debug.write("out", msg);
    this.child.stdin!.write(JSON.stringify(msg) + "\n");
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        this.opts.debug.write("stdout-nonjson", line.slice(0, 2000));
        continue;
      }
      this.opts.debug.write("in", msg);
      this.dispatch(msg);
    }
  }

  private dispatch(msg: any): void {
    if (msg.method && msg.id !== undefined) {
      // agent → client request
      this.opts.onRequest(msg.method, msg.params).then(
        (result) => this.send({ jsonrpc: "2.0", id: msg.id, result: result ?? null }),
        (err: unknown) => {
          const e = err instanceof AcpError ? err : new AcpError(msg.method, -32603, err instanceof Error ? err.message : String(err));
          this.send({ jsonrpc: "2.0", id: msg.id, error: { code: e.code, message: e.message } });
        },
      );
      return;
    }
    if (msg.method) {
      try { this.opts.onNotification(msg.method, msg.params); } catch (err) {
        this.opts.debug.write("handler-error", String(err));
      }
      return;
    }
    const p = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    if (msg.error) p.reject(new AcpError(p.method, msg.error.code ?? -32603, msg.error.message ?? "unknown error", msg.error.data));
    else p.resolve(msg.result);
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null, extra?: string): void {
    if (this.exited) return;
    this.exited = true;
    this.signalGroup("SIGKILL"); // agy is gone (crash or kill): take whatever it started with it
    const stderr = (extra ? extra + "\n" : "") + this.stderrTail;
    this.opts.debug.write("exit", { code, signal, stderr: stderr.slice(-500) });
    const err = new AcpExitError(`agy acp 进程已退出（code=${code}, signal=${signal}）${extra ? "：" + extra : ""}`);
    for (const p of [...this.pending.values()]) p.reject(err);
    this.pending.clear();
    for (const w of this.exitWaiters) w();
    this.opts.onExit({ code, signal, stderr });
  }
}
