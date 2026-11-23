// Print what pi-agy-acp sent to agy (out frames) from an ACP_DEBUG capture.
//   npm run acp:tail            # newest capture in ~/.pi/agent/pi-agy-acp/logs
//   npm run acp:tail -- <file>  # a specific capture; add --all to include inbound frames
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const all = args.includes("--all");
let file = args.find((a) => !a.startsWith("--"));
if (!file) {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent");
  const dir = path.join(process.env.PI_AGY_ACP_HOME ?? path.join(agentDir, "pi-agy-acp"), "logs");
  const logs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".ndjson")).sort() : [];
  if (!logs.length) {
    console.error(`No capture files in ${dir} (start pi with ACP_DEBUG=1, or run /agy debug on)`);
    process.exit(1);
  }
  file = path.join(dir, logs[logs.length - 1]);
}
console.error(`# ${file}`);
for (const line of fs.readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const f = JSON.parse(line);
  if (!all && f.dir !== "out") continue;
  const m = f.msg ?? {};
  const what = m.method ?? (m.result !== undefined ? `result#${m.id}` : m.error ? `error#${m.id}` : f.dir);
  const body = m.params ?? m.result ?? m.error ?? m;
  console.log(`${f.t.slice(11, 23)} ${f.dir.padEnd(6)} ${what}  ${JSON.stringify(body)}`);
}
