// Shared harness: a temp home, the fake agy, and real pi SDK sessions with this extension loaded.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/runtime.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_AGY = path.join(here, "fake-agy");
export const EXTENSION = path.join(here, "../src/index.ts");

export interface Env {
  /** Shortened turn-engine waits for this test file (the fake agy paces itself by FAKE_SETTLE_MS). */
  timing?: Record<string, number>;
  root: string;
  home: string;
  cwd: string;
  logFile: string;
  stateFile: string;
  frames(): any[];
  prompts(): any[];
}

/** Must run before the extension is loaded: the runtime singleton reads these once. */
export function setupEnv(name: string, config: Record<string, unknown> = {}, timing?: Record<string, number>): Env {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agyacp-${name}-`));
  const home = path.join(root, "home");
  const cwd = path.join(root, "ws");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ agyPath: FAKE_AGY, ...config }));
  const logFile = path.join(root, "frames.ndjson");
  const stateFile = path.join(root, "fake-state.json");
  process.env.PI_AGY_ACP_HOME = home;
  process.env.FAKE_LOG = logFile;
  process.env.FAKE_STATE = stateFile;
  if (timing?.wakeSettle) process.env.FAKE_SETTLE_MS = String(timing.wakeSettle);
  const frames = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { timing, root, home, cwd, logFile, stateFile, frames, prompts: () => frames().filter((f) => f.method === "session/prompt") };
}

export interface MockUI {
  calls: { method: string; args: any[] }[];
  answers: { confirm?: boolean; select?: (options: string[]) => string | undefined; input?: string };
}

export function mockUI(): { ui: any; mock: MockUI } {
  const mock: MockUI = { calls: [], answers: {} };
  const base: Record<string, any> = {
    select: async (title: string, options: string[]) => { mock.calls.push({ method: "select", args: [title, options] }); return mock.answers.select?.(options); },
    confirm: async (title: string, message: string) => { mock.calls.push({ method: "confirm", args: [title, message] }); return mock.answers.confirm ?? false; },
    input: async (title: string) => { mock.calls.push({ method: "input", args: [title] }); return mock.answers.input; },
    notify: (message: string, level?: string) => { mock.calls.push({ method: "notify", args: [message, level] }); },
  };
  const ui = new Proxy(base, { get: (t, p: string) => (p in t ? t[p] : () => undefined) });
  return { ui, mock };
}

/** `modelRuntime`: share another session's runtime, as pi-web does for subagents; `extension: false`: a profile that loads none. */
export async function createSession(env: Env, opts: { entries?: any[]; model?: string; thinking?: string; settings?: Record<string, unknown>; modelRuntime?: unknown; extension?: boolean } = {}) {
  const sdk = await import("@earendil-works/pi-coding-agent");
  const agentDir = path.join(env.root, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, ...opts.settings } as any);
  const services = await sdk.createAgentSessionServices({
    cwd: env.cwd,
    agentDir,
    settingsManager,
    ...(opts.modelRuntime ? { modelRuntime: opts.modelRuntime as any } : {}),
    resourceLoaderOptions: opts.extension === false ? { noExtensions: true } : { additionalExtensionPaths: [EXTENSION] },
  });
  if (env.timing) Object.assign(runtime().timing, env.timing);
  const model = services.modelRuntime.getModel("antigravity", opts.model ?? "gemini-3.8-flash");
  if (!model) throw new Error("antigravity model not registered");
  const sessionManager = sdk.SessionManager.inMemory(env.cwd, undefined, opts.entries);
  const { session } = await sdk.createAgentSessionFromServices({ services, sessionManager, model, thinkingLevel: (opts.thinking ?? "low") as any });
  const { ui, mock } = mockUI();
  await session.bindExtensions({ uiContext: ui, mode: "rpc" } as any);
  return { session: session as any, mock, sdk, services: services as any };
}

export function assistants(session: any): any[] {
  return session.messages.filter((m: any) => m.role === "assistant");
}

export function lastText(session: any): string {
  const a = assistants(session).at(-1);
  return (a?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(fn: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await sleep(20);
  }
}

export function runtime(): any {
  return (globalThis as any)[Symbol.for(`pi-agy-acp.runtime.${VERSION}`)];
}
