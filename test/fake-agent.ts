// Scriptable fake of `agy acp` 1.5.14 (shapes taken from docs/research/agy-acp-handshake.md).
// Env: FAKE_LOG (NDJSON of inbound frames), FAKE_STATE (persisted session ids, survives restarts),
//      FAKE_AUTH=0 (every session call returns -32000).
// Prompt text containing SCRIPT:<name> selects a script; anything else is echoed.
import { spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";

const LOG = process.env.FAKE_LOG;
const STATE = process.env.FAKE_STATE;
const AUTH_FLAG = STATE ? `${STATE}.authed` : undefined;
const AUTHED = process.env.FAKE_AUTH !== "0" || (!!AUTH_FLAG && fs.existsSync(AUTH_FLAG));
const args = process.argv.slice(2);

if (args.includes("--login")) {
  process.stdout.write("Open this link in a browser to log in with Google:\n\n  https://accounts.google.com/o/oauth2/auth?client_id=fake&state=x\n\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\n");
  readline.createInterface({ input: process.stdin }).once("line", (line) => {
    if (LOG) fs.appendFileSync(LOG, JSON.stringify({ login: line }) + "\n");
    const ok = line.trim() === "good-code";
    if (ok && AUTH_FLAG) fs.writeFileSync(AUTH_FLAG, "1");
    process.exit(ok ? 0 : 1);
  });
} else {
  serve();
}

const MODELS: Record<string, string[]> = {
  "gemini-4-neon": ["low", "medium", "high", "xhigh"],
  "gemini-3.8-flash": ["low", "medium", "high"],
  "gpt-oss-120b-medium": [],
};

function serve() {
  const sessions = new Map<string, { model: string; level: string; mode: string }>();
  const known = new Set<string>(STATE && fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : []);
  let counter = 0;
  let reqId = 0;
  const waiting = new Map<string | number, (v: any) => void>();
  const running = new Map<string, { promptId: number | string; cancelled: boolean; steers: string[] }>();
  const cancelledSessions = new Set<string>();

  const send = (m: any) => process.stdout.write(JSON.stringify(m) + "\n");
  const update = (sessionId: string, u: any) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const persist = () => { if (STATE) fs.writeFileSync(STATE, JSON.stringify([...known])); };
  const ask = (method: string, params: any) => new Promise<any>((resolve) => {
    const id = String(++reqId);
    waiting.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });

  const configOptions = (s: { model: string; level: string; mode: string }) => {
    const levels = MODELS[s.model] ?? [];
    return [
      { id: "model", name: "Model", category: "model", type: "select", currentValue: s.model, options: Object.keys(MODELS).map((value) => ({ value, name: value })) },
      ...(levels.length ? [{ id: "thought_level", name: "Thinking Level", category: "thought_level", type: "select", currentValue: s.level, options: levels.map((value) => ({ value, name: value })) }] : []),
      { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: s.mode, options: ["default", "accept-edits", "auto", "plan"].map((value) => ({ value, name: value })) },
    ];
  };
  const setup = (id: string) => {
    const s = { model: "gemini-4-neon", level: "high", mode: "default" }; // agy resets config on resume
    sessions.set(id, s);
    setTimeout(() => update(id, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "goal", description: "Run until the goal is done." }, { name: "compact", description: "Compact now." }] }), 5);
    return { sessionId: id, configOptions: configOptions(s), _meta: { antigravity: { tier: { name: "Fake Tier" } } } };
  };

  async function runPrompt(id: number | string, sessionId: string, text: string) {
    const prev = running.get(sessionId);
    if (prev) {
      // native steer: the earlier prompt returns at once, the running script continues for the new one
      prev.steers.push(text);
      // like agy, the superseded prompt reports what it billed
      send({ jsonrpc: "2.0", id: prev.promptId, result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 7, totalTokens: 107 } } });
      prev.promptId = id;
      return;
    }
    cancelledSessions.delete(sessionId);
    const run = { promptId: id, cancelled: false, steers: [] as string[] };
    running.set(sessionId, run);
    const u = (x: any) => update(sessionId, x);
    const finish = (stopReason: string) => {
      running.delete(sessionId);
      u({ sessionUpdate: "usage_update", used: 1234, size: 1048576 });
      send({ jsonrpc: "2.0", id: run.promptId, result: { stopReason, usage: { inputTokens: 900, outputTokens: 34, cachedReadTokens: 6000, cachedWriteTokens: 50, thoughtTokens: 20, totalTokens: 99999 } } });
    };
    if (text.trim() === "/compact") {
      // like agy 1.5.14: no updates at all, only the prompt result
      running.delete(sessionId);
      return send({ jsonrpc: "2.0", id: run.promptId, result: { stopReason: "end_turn", usage: { inputTokens: 500, outputTokens: 80, totalTokens: 580 } } });
    }
    const script = /SCRIPT:(\w+)/.exec(text)?.[1];
    const cwd = "/tmp/fake-ws";
    switch (script) {
      case "refusal": // agy maps quota exhaustion to refusal
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } });
        finish("refusal");
        break;
      case "text":
        u({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking about it" } });
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } });
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } });
        return finish("end_turn");
      case "tools": {
        u({ sessionUpdate: "tool_call", toolCallId: "call_w", name: "write_file", kind: "edit", title: "File a.txt", status: "in_progress", locations: [{ path: `${cwd}/a.txt` }], rawInput: { Path: `${cwd}/a.txt`, Content: "hi\n" } });
        await sleep(20);
        u({ sessionUpdate: "tool_call_update", toolCallId: "call_w", status: "completed", kind: "edit", title: "File a.txt", content: [{ type: "diff", path: `${cwd}/a.txt`, newText: "hi\n" }] });
        await sleep(300);
        u({ sessionUpdate: "tool_call", toolCallId: "call_e", name: "edit_file", kind: "edit", title: "File a.txt", status: "in_progress", locations: [{ path: `${cwd}/a.txt` }], rawInput: { Path: `${cwd}/a.txt`, Target: "hi", Replacement: "hello" } });
        u({ sessionUpdate: "tool_call_update", toolCallId: "call_e", status: "completed", kind: "edit", content: [{ type: "diff", path: `${cwd}/a.txt`, oldText: "hi\n", newText: "hello\n" }] });
        await sleep(300);
        const cmd = { toolCallId: "call_x", name: "run_command", kind: "execute", title: "ls -la", rawInput: { CommandLine: "ls -la" } };
        u({ sessionUpdate: "tool_call", ...cmd, status: "in_progress" });
        u({ sessionUpdate: "tool_call_update", ...cmd, status: "pending" });
        const res = await ask("session/request_permission", { sessionId, toolCall: { sessionUpdate: "tool_call", ...cmd, status: "pending" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] });
        const allowed = res?.outcome?.optionId === "allow";
        u({ sessionUpdate: "tool_call_update", ...cmd, status: allowed ? "completed" : "failed", rawOutput: { output: "Created At: x\nCompleted At: y\nCommand exited with code 0.\n\nCommand output:\ntotal 0\r\n", exit_code: allowed ? 0 : 1 }, content: [{ type: "content", content: { type: "text", text: allowed ? "Created At: x\nCompleted At: y\nCommand exited with code 0.\n\nCommand output:\ntotal 0\r\n" : "denied" } }] });
        await sleep(20);
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: allowed ? "All done." : "Command was denied." } });
        return finish("end_turn");
      }
      case "parallel":
        u({ sessionUpdate: "tool_call", toolCallId: "p1", kind: "read", title: "Read x", status: "in_progress", locations: [{ path: "/tmp/x" }] });
        u({ sessionUpdate: "tool_call", toolCallId: "p2", kind: "read", title: "Read y", status: "in_progress", locations: [{ path: "/tmp/y" }] });
        await sleep(400);
        u({ sessionUpdate: "tool_call_update", toolCallId: "p2", status: "completed", content: [{ type: "content", content: { type: "text", text: "Y" } }] });
        u({ sessionUpdate: "tool_call_update", toolCallId: "p1", status: "completed", content: [{ type: "content", content: { type: "text", text: "X" } }] });
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "read both" } });
        return finish("end_turn");
      case "slow":
        for (let i = 0; i < 30 && !run.cancelled; i++) {
          u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `chunk${i} ` } });
          await sleep(100);
          if (run.steers.length) {
            u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `steer-received:${run.steers.splice(0).join("|")} ` } });
            await sleep(100);
            break;
          }
        }
        return finish(run.cancelled ? "cancelled" : "end_turn");
      case "longtool": {
        u({ sessionUpdate: "tool_call", toolCallId: "lt", kind: "execute", title: "sleep 30", status: "in_progress", rawInput: { CommandLine: "sleep 30" } });
        for (let i = 0; i < 100 && !run.cancelled && !run.steers.length; i++) await sleep(50);
        if (run.cancelled) {
          u({ sessionUpdate: "tool_call_update", toolCallId: "lt", status: "failed", rawOutput: { output: "" }, content: [{ type: "content", content: { type: "text", text: "" } }] });
          return finish("cancelled");
        }
        u({ sessionUpdate: "tool_call_update", toolCallId: "lt", status: "completed", rawOutput: { output: "done", exit_code: 0 } });
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: run.steers.length ? `steer-received:${run.steers.join("|")}` : "finished" } });
        return finish("end_turn");
      }
      case "background": {
        // like agy 1.5.14: WaitMsBeforeAsync moves the command to the background, the prompt
        // returns, and when the command finishes agy reports on its own (no prompt response)
        const bgCmd = { toolCallId: "bg", kind: "execute", title: "sleep 1 && echo ok", rawInput: { CommandLine: "sleep 1 && echo ok", IsDaemon: false, WaitMsBeforeAsync: 500 } };
        u({ sessionUpdate: "tool_call", ...bgCmd, status: "in_progress" });
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "started in background. " } });
        finish("end_turn");
        await sleep(400);
        u({ sessionUpdate: "tool_call_update", ...bgCmd, status: "completed", rawOutput: { output: "ok", exit_code: 0 } });
        await sleep(100);
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "background job printed ok" } });
        u({ sessionUpdate: "usage_update", used: 1300, size: 1048576 });
        return;
      }
      case "bgsteps": {
        // agy keeps working on its own after a background command, thinking silently between steps
        const cmd = { toolCallId: "bgs", kind: "execute", title: "sleep 1", rawInput: { CommandLine: "sleep 1", IsDaemon: false } };
        u({ sessionUpdate: "tool_call", ...cmd, status: "in_progress" });
        finish("end_turn");
        await sleep(300);
        u({ sessionUpdate: "tool_call_update", ...cmd, status: "completed", rawOutput: { output: "ok", exit_code: 0 } });
        // like agy 1.5.14: each model call ends with usage_update, then at once its tool calls
        u({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "step one" } });
        u({ sessionUpdate: "usage_update", used: 1400, size: 1048576 });
        u({ sessionUpdate: "tool_call", toolCallId: "bgs-w", kind: "edit", title: "File notes.md", status: "in_progress", rawInput: { Path: "notes.md", Content: "x" } });
        u({ sessionUpdate: "tool_call_update", toolCallId: "bgs-w", status: "completed" });
        await sleep(4000); // generating the next step silently
        u({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "step two" } });
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "all steps done" } });
        u({ sessionUpdate: "usage_update", used: 1500, size: 1048576 });
        return;
      }
      case "bgrerun": {
        // during its own work agy reruns a command that goes to the background, and says so in a
        // closing model call (usage_update) before the rerun ends; its report comes seconds later
        const first = { toolCallId: "bgr1", kind: "execute", title: "check", rawInput: { CommandLine: "check", IsDaemon: false } };
        u({ sessionUpdate: "tool_call", ...first, status: "in_progress" });
        finish("end_turn");
        await sleep(300);
        u({ sessionUpdate: "tool_call_update", ...first, status: "completed", rawOutput: { output: "bad", exit_code: 1 } });
        u({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "fix and rerun" } });
        u({ sessionUpdate: "usage_update", used: 1400, size: 1048576 });
        const rerun = { toolCallId: "bgr2", kind: "execute", title: "check", rawInput: { CommandLine: "check", IsDaemon: false } };
        u({ sessionUpdate: "tool_call", ...rerun, status: "in_progress" });
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "rerunning check " } });
        u({ sessionUpdate: "usage_update", used: 1450, size: 1048576 });
        await sleep(300);
        u({ sessionUpdate: "tool_call_update", ...rerun, status: "completed", rawOutput: { output: "ok", exit_code: 0 } });
        await sleep(3000); // generating the report silently, longer than the settle window
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "rerun reported" } });
        u({ sessionUpdate: "usage_update", used: 1500, size: 1048576 });
        return;
      }
      case "bglong": {
        const longCmd = { toolCallId: "bgl", kind: "execute", title: "sleep 600", rawInput: { CommandLine: "sleep 600", IsDaemon: false } };
        u({ sessionUpdate: "tool_call", ...longCmd, status: "in_progress" });
        finish("end_turn");
        // the background command only stops on session/cancel
        for (let i = 0; i < 200; i++) {
          await sleep(50);
          if (run.cancelled || cancelledSessions.has(sessionId)) {
            u({ sessionUpdate: "tool_call_update", ...longCmd, status: "failed", rawOutput: { output: "" } });
            return;
          }
        }
        return;
      }
      case "stoplate": {
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working " } });
        for (let i = 0; i < 100 && !run.cancelled; i++) await sleep(50);
        finish("cancelled");
        await sleep(200);
        // agy keeps going briefly after Stop: neither may open a reply or get permission
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late chunk" } });
        const late = await ask("session/request_permission", { sessionId, toolCall: { toolCallId: "late", kind: "execute", title: "rm -rf build", rawInput: { CommandLine: "rm -rf build" } }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] });
        if (LOG) fs.appendFileSync(LOG, JSON.stringify({ lateOutcome: late?.outcome?.optionId ?? late?.outcome?.outcome }) + "\n");
        return;
      }
      case "wakedaemon":
        u({ sessionUpdate: "tool_call", toolCallId: "wd1", kind: "execute", title: "npm run dev", status: "in_progress", rawInput: { CommandLine: "npm run dev", IsDaemon: true } });
        finish("end_turn");
        await sleep(400);
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "restarting watcher " } });
        u({ sessionUpdate: "usage_update", used: 1400, size: 1048576 });
        u({ sessionUpdate: "tool_call", toolCallId: "wd2", kind: "execute", title: "npm run watch", status: "in_progress", rawInput: { CommandLine: "npm run watch", IsDaemon: true } });
        await sleep(200);
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "watcher up" } });
        u({ sessionUpdate: "usage_update", used: 1450, size: 1048576 });
        return;
      case "wakequestion": {
        u({ sessionUpdate: "tool_call", toolCallId: "wq", kind: "execute", title: "npm run dev", status: "in_progress", rawInput: { CommandLine: "npm run dev", IsDaemon: true } });
        finish("end_turn");
        await sleep(400);
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "need input " } });
        u({ sessionUpdate: "usage_update", used: 1350, size: 1048576 });
        const res = await ask("session/request_permission", { sessionId, toolCall: { toolCallId: "interaction_9", title: "Pick a color" }, options: [{ optionId: "r", name: "Red", kind: "allow_once" }, { optionId: "b", name: "Blue", kind: "allow_once" }] });
        await sleep(2500); // generating after the answer, longer than the settle window
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `picked:${res?.outcome?.optionId ?? res?.outcome?.outcome}` } });
        u({ sessionUpdate: "usage_update", used: 1400, size: 1048576 });
        return;
      }
      case "schedtitle": {
        const t = { toolCallId: "st", name: "run_command", kind: "execute", title: "pytest test_schedule.py", rawInput: { CommandLine: "pytest test_schedule.py", IsDaemon: false } };
        u({ sessionUpdate: "tool_call", ...t, status: "in_progress" });
        finish("end_turn");
        await sleep(300);
        u({ sessionUpdate: "tool_call_update", ...t, status: "completed", rawOutput: { output: "3 passed", exit_code: 0 } });
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "tests pass" } });
        u({ sessionUpdate: "usage_update", used: 1400, size: 1048576 });
        return;
      }
      case "daemon":
        u({ sessionUpdate: "tool_call", toolCallId: "dm", kind: "execute", title: "npm run dev", status: "in_progress", rawInput: { CommandLine: "npm run dev", IsDaemon: true } });
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "dev server started" } });
        finish("end_turn");
        await sleep(600);
        // later, unprompted
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "daemon says hi" } });
        u({ sessionUpdate: "usage_update", used: 1400, size: 1048576 });
        return;
      case "question": {
        const res = await ask("session/request_permission", { sessionId, toolCall: { toolCallId: "interaction_1", title: "Pick a color" }, options: [{ optionId: "r", name: "Red", kind: "allow_once" }, { optionId: "b", name: "Blue", kind: "allow_once" }] });
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `picked:${res?.outcome?.optionId ?? res?.outcome?.outcome}` } });
        return finish("end_turn");
      }
      case "plan":
        u({ sessionUpdate: "plan", entries: [{ content: "step one", status: "completed" }, { content: "step two", status: "in_progress" }] });
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "planned" } });
        return finish("end_turn");
      case "bgstuck":
        // agy drops the background command's final status: it never completes
        u({ sessionUpdate: "tool_call", toolCallId: "bgx", kind: "execute", title: "make", status: "in_progress", rawInput: { CommandLine: "make", IsDaemon: false } });
        return finish("end_turn");
      case "bigframe":
        // one frame far larger than a pipe read, split across many stdout chunks
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x".repeat(3_000_000) + "END" } });
        return finish("end_turn");
      case "hang":
        // a stuck agy: ignores session/cancel and never answers this prompt
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "stuck " } });
        return;
      case "crash":
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "about to crash" } });
        await sleep(50);
        process.exit(3);
      case "grandchild": {
        const child = spawn("sleep", ["600"], { stdio: "ignore" });
        if (LOG) fs.appendFileSync(LOG, JSON.stringify({ grandchild: child.pid }) + "\n");
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `spawned ${child.pid}` } });
        return finish("end_turn");
      }
      case "fail429":
        running.delete(sessionId);
        return send({ jsonrpc: "2.0", id: run.promptId, error: { code: -32603, message: "429 Too Many Requests" } });
      case "maxtokens":
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } });
        return finish("max_tokens");
      case "quiet":
        // nothing streamed yet when a steer arrives
        for (let i = 0; i < 20 && !run.steers.length; i++) await sleep(50);
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: run.steers.length ? `steer-received:${run.steers.join("|")}` : "no steer" } });
        return finish("end_turn");
      case "title":
        u({ sessionUpdate: "session_info_update", title: "Fake Title" });
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "titled" } });
        return finish("end_turn");
      default: {
        const s = sessions.get(sessionId)!;
        u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `echo[${s.model}/${s.level}/${s.mode}]: ${text}` } });
        return finish("end_turn");
      }
    }
  }

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (LOG) fs.appendFileSync(LOG, JSON.stringify(msg) + "\n");
    if (!msg.method) {
      waiting.get(msg.id)?.(msg.result);
      waiting.delete(msg.id);
      return;
    }
    const reply = (result: any) => send({ jsonrpc: "2.0", id: msg.id, result });
    const fail = (code: number, message: string) => send({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
    const p = msg.params ?? {};
    const needAuth = !AUTHED && msg.method.startsWith("session/");
    if (needAuth && msg.id !== undefined) return fail(-32000, "Authentication required");
    switch (msg.method) {
      case "initialize":
        return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true }, sessionCapabilities: { resume: {}, close: {}, list: {} } }, agentInfo: { name: "Antigravity ACP Server", version: "1.5.14-fake" }, authMethods: [{ id: "oauth-personal", name: "Log in with Google" }] });
      case "session/new": {
        const id = `fake-${process.pid}-${++counter}`;
        known.add(id);
        persist();
        return reply(setup(id));
      }
      case "session/list":
        return reply({ sessions: [...known].map((sessionId) => ({ sessionId, cwd: "/tmp", title: "t" })) });
      case "session/resume":
        if (!known.has(p.sessionId)) return reply(setup(p.sessionId)); // like agy: unknown ids "succeed"
        return reply(setup(p.sessionId));
      case "session/close":
        sessions.delete(p.sessionId);
        running.delete(p.sessionId); // a closed session's work (even a stuck prompt) is gone
        return reply({});
      case "session/set_config_option": {
        const s = sessions.get(p.sessionId);
        if (!s) return fail(-32602, "unknown session");
        if (p.configId === "model") {
          if (!(p.value in MODELS)) return fail(-32602, `unknown model ${p.value}`);
          s.model = p.value;
          const levels = MODELS[s.model];
          if (!levels.includes(s.level)) s.level = levels.includes("medium") ? "medium" : levels[0] ?? "";
        } else if (p.configId === "thought_level") s.level = p.value;
        else if (p.configId === "mode") s.mode = p.value;
        return reply({ configOptions: configOptions(s) });
      }
      case "session/prompt": {
        const text = (p.prompt ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        void runPrompt(msg.id, p.sessionId, text);
        return;
      }
      case "session/cancel": {
        const run = running.get(p.sessionId);
        if (run) run.cancelled = true;
        cancelledSessions.add(p.sessionId); // also stops background commands
        return;
      }
      default:
        if (msg.id !== undefined) fail(-32601, `Method not found: ${msg.method}`);
    }
  });
  rl.on("close", () => process.exit(0));
}
