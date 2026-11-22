// ACP_DEBUG capture: one NDJSON line per frame, images redacted, file mode 0600.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class DebugLog {
  file: string | undefined;
  private fd: number | undefined;
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  get enabled(): boolean {
    return this.fd !== undefined;
  }

  /** `spec`: "1"/"true" → default file under dir; any other non-empty value → that path. */
  enable(spec = "1"): string {
    if (this.fd !== undefined) return this.file!;
    const file = spec === "1" || spec === "true"
      ? path.join(this.dir, `acp-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.ndjson`)
      : spec;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.fd = fs.openSync(file, "a", 0o600);
    this.file = file;
    return file;
  }

  disable(): void {
    if (this.fd !== undefined) fs.closeSync(this.fd);
    this.fd = undefined;
  }

  write(dir: string, msg: unknown, extra?: Record<string, unknown>): void {
    if (this.fd === undefined) return;
    const line = JSON.stringify({ t: new Date().toISOString(), dir, ...extra, msg: redact(msg) });
    try { fs.writeSync(this.fd, line + "\n"); } catch {}
  }
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  if (obj.type === "image" && typeof obj.data === "string") {
    const bytes = Buffer.byteLength(obj.data, "base64");
    const sha = createHash("sha256").update(obj.data).digest("hex").slice(0, 12);
    return { ...obj, data: `<${obj.mimeType ?? "image"} ${bytes}B sha256:${sha}>` };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = redact(v);
  return out;
}
