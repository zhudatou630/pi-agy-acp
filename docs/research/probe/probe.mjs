// Minimal ACP probe: spawn `agy acp`, run a scripted sequence, dump all traffic.
import { spawn } from "node:child_process";
import fs from "node:fs";

const log = fs.createWriteStream(process.env.OUT || "/tmp/agy-probe/traffic.ndjson");
const child = spawn(process.env.AGY || `${process.env.HOME}/.local/bin/agy`, ["acp"], {
  cwd: process.env.CWD || "/tmp/agy-probe/ws",
  stdio: ["pipe", "pipe", "pipe"],
  detached: true,
});
let id = 0;
const pending = new Map();
let buf = "";
const t0 = Date.now();
const rec = (dir, obj) => log.write(JSON.stringify({ t: Date.now() - t0, dir, msg: obj }) + "\n");
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { rec("stdout-nonjson", line); continue; }
    rec("in", msg);
    if (msg.id !== undefined && pending.has(msg.id) && !msg.method) {
      pending.get(msg.id)(msg); pending.delete(msg.id);
    } else if (msg.method === "session/request_permission") {
      const opt = msg.params.options.find((o) => o.kind === (process.env.PERM === "allow" ? "allow_once" : "reject_once")) || msg.params.options[0];
      send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: opt.optionId } } });
    } else if (msg.id !== undefined && msg.method) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported by probe" } });
    }
  }
});
child.stderr.on("data", (d) => rec("stderr", String(d)));
child.on("exit", (c, s) => rec("exit", { c, s }));
function send(obj) { rec("out", obj); child.stdin.write(JSON.stringify(obj) + "\n"); }
function req(method, params, timeout = 60000) {
  const myId = ++id;
  send({ jsonrpc: "2.0", id: myId, method, params });
  return new Promise((res) => {
    const t = setTimeout(() => { pending.delete(myId); res({ timeout: true }); }, timeout);
    pending.set(myId, (m) => { clearTimeout(t); res(m); });
  });
}
const steps = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const ctx = {};
try {
  for (const s of steps) {
    if (s.sleep) { await new Promise((r) => setTimeout(r, s.sleep)); continue; }
    const params = JSON.parse(JSON.stringify(s.params ?? {}).replaceAll("$SID", ctx.sid ?? ""));
    if (s.notify) { send({ jsonrpc: "2.0", method: s.method, params }); continue; }
    const p = req(s.method, params, s.timeout);
    if (s.noWait) continue;
    const r = await p;
    if (r.result?.sessionId) ctx.sid = r.result.sessionId; if (s.method==="session/load") ctx.sid = params.sessionId;
    console.log(s.method, JSON.stringify(r).slice(0, 300));
  }
} finally {
  await new Promise((r) => setTimeout(r, 500));
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  await new Promise((r) => setTimeout(r, 1500));
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  log.end();
  process.exit(0);
}
