// Helper agy runs on pi-agy-acp's behalf; it talks to the pi process over a unix socket.
//   mcp <socket>                     agy's stdio MCP server (token in PI_AGY_MCP_TOKEN), relayed to pi
//   wait --socket <socket> <id...>   wait for pi agents and print their reports
import net from "node:net";

const [mode, ...rest] = process.argv.slice(2);

if (mode === "mcp") {
  const sock = net.connect(rest[0], () => {
    sock.write(JSON.stringify({ mcp: process.env.PI_AGY_MCP_TOKEN ?? "" }) + "\n");
    process.stdin.pipe(sock);
  });
  sock.pipe(process.stdout);
  sock.on("error", (err) => { process.stderr.write(`pi-agent: ${err.message}\n`); process.exit(1); });
  sock.on("close", () => process.exit(0));
  process.stdin.on("end", () => sock.end());
} else if (mode === "wait") {
  const at = rest.indexOf("--socket");
  const socket = at >= 0 ? rest[at + 1] : undefined;
  const ids = rest.filter((_, i) => i !== at && i !== at + 1);
  if (!socket || ids.length === 0) {
    process.stderr.write("usage: pi-agent wait --socket <socket> <agent id...>\n");
    process.exit(2);
  }
  let buf = "";
  const sock = net.connect(socket, () => sock.write(JSON.stringify({ wait: ids }) + "\n"));
  sock.setEncoding("utf8");
  sock.on("data", (d) => { buf += d; });
  sock.on("error", (err) => {
    process.stderr.write(`pi-agent: cannot reach pi (${err.message}). The agents keep running in Pi Web; check them there.\n`);
    process.exit(1);
  });
  sock.on("close", () => {
    let msg;
    try { msg = JSON.parse(buf); } catch {}
    if (!msg) {
      process.stderr.write("pi-agent: lost the connection to pi before the report arrived. Run the same command again.\n");
      process.exit(1);
    }
    process.stdout.write(`${msg.text}\n`);
    process.exitCode = msg.ok ? 0 : 1; // no process.exit(): let a piped stdout drain first
  });
} else {
  process.stderr.write("usage: pi-agent mcp <socket> | pi-agent wait --socket <socket> <agent id...>\n");
  process.exit(2);
}
