// Model / effort catalog, cached for offline startup.
import fs from "node:fs";
import path from "node:path";

export const PROVIDER_ID = "antigravity";
export const API_ID = "antigravity-acp";

export interface CatalogModel {
  id: string;
  name: string;
  /** agy thought_level values; empty = model has no thought_level option. */
  levels: string[];
  contextWindow?: number;
}

export interface Catalog {
  v: 1;
  agyVersion?: string;
  fetchedAt?: number;
  tier?: string;
  models: CatalogModel[];
}

// Seed observed from agy 1.5.14 on 2026-11-22 (docs/research/agy-acp-handshake.md §2).
export const SEED_CATALOG: Catalog = {
  v: 1,
  models: [
    { id: "gemini-4-neon", name: "Gemini 4 Neon", levels: ["low", "medium", "high", "xhigh"] },
    { id: "gemini-4-argon", name: "Gemini 4 Argon", levels: ["low", "medium", "high"] },
    { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", levels: ["low", "medium", "high", "xhigh"] },
    { id: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)", levels: [] },
    { id: "gemini-pro-orchestrator-g1-pro", name: "Orchestrator (Argon)", levels: [] },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", levels: ["low", "medium", "high"] },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5", levels: ["low", "medium", "high"] },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", levels: ["low", "medium", "high"] },
    { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", levels: [] },
  ],
};

const DEFAULT_CONTEXT = 1_048_576;

export function loadCatalog(file: string): Catalog {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Catalog;
    if (parsed?.v === 1 && Array.isArray(parsed.models) && parsed.models.length > 0) {
      return parsed;
    }
  } catch {}
  return structuredClone(SEED_CATALOG);
}

export function saveCatalog(file: string, catalog: Catalog): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(catalog, null, 2));
  fs.renameSync(tmp, file);
}

const PI_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** pi model definitions for the provider. */
export function toPiModels(catalog: Catalog) {
  return catalog.models.map((m) => {
    const reasoning = m.levels.length > 0;
    const thinkingLevelMap: Record<string, string | null> = { off: null };
    for (const level of PI_LEVELS) thinkingLevelMap[level] = m.levels.includes(level) ? level : null;
    return {
      id: m.id,
      name: m.name,
      api: API_ID,
      provider: PROVIDER_ID,
      baseUrl: "acp://agy",
      reasoning,
      ...(reasoning ? { thinkingLevelMap } : {}),
      input: ["text", "image"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow ?? DEFAULT_CONTEXT,
      maxTokens: 65_536,
    };
  });
}

/**
 * Pick the agy thought_level for a pi level: exact match, else the nearest supported level,
 * preferring the next one up. `undefined` (pi "off") maps to the lowest level agy offers.
 */
export function mapThinkingLevel(piLevel: string | undefined, levels: string[]): string | undefined {
  if (levels.length === 0) return undefined;
  if (piLevel && levels.includes(piLevel)) return piLevel;
  const order = ["low", "medium", "high", "xhigh"];
  const want = piLevel === "minimal" || !piLevel ? 0 : piLevel === "max" ? order.length - 1 : Math.max(0, order.indexOf(piLevel));
  const ranked = levels
    .map((l) => ({ l, i: order.indexOf(l) }))
    .filter((x) => x.i >= 0)
    .sort((a, b) => a.i - b.i);
  if (ranked.length === 0) return levels[0];
  return (ranked.find((x) => x.i >= want) ?? ranked[ranked.length - 1]).l;
}
