/**
 * agent-crystalball: make your agent look psychic. Memoize tool calls so
 * repeated questions are free, learn the order tools tend to be called in
 * (Markov prophecy), and warm the cache with speculative executions before
 * the agent even knows it wants them.
 *
 *   const oracle = createOracle({ tools: [weather, geocode], ttlMs: 60_000 });
 *   const t = oracle.wrap(weather);
 *   await t.execute({ city: "Oslo" }, {});           // live call
 *   await t.execute({ city: "Oslo" }, {});           // cache hit, zero cost
 *   const guess = oracle.prophecy();                 // "geocode" comes next
 *   await oracle.warm({ tool: "geocode", input: { q: "Oslo" } });
 */
import {
  failure,
  isFailure,
  runTool,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "agent-tools";

export type OracleOptions = {
  /** Tools the oracle may wrap and speculate about. */
  tools: Array<Tool<never, unknown>>;
  /** How long a cached answer stays true. Default 30s. */
  ttlMs?: number;
  /** Max cached entries before oldest are evicted. Default 500. */
  maxEntries?: number;
  /** Called when a speculation resolves (hit or miss). */
  onSpeculation?: (event: { tool: string; input: unknown; hit: boolean }) => void;
};

export type CacheEntry = {
  tool: string;
  input: unknown;
  value: unknown;
  storedAt: number;
  hits: number;
};

export type Prophecy = {
  /** Predicted next tool name ("" when the oracle has no vision). */
  tool: string;
  /** Confidence in [0..1]. */
  confidence: number;
  /** Last observed tool, if any. */
  basedOn?: string;
};

export type WarmResult = {
  tool: string;
  input: unknown;
  hit: boolean;
  value?: unknown;
};

export type WrappedTool<I, O> = Tool<I, ToolResult<O>> & {
  /** Entries currently cached for this tool. */
  cacheSize: () => number;
  /** Drop this tool's cached answers. */
  clearCache: () => void;
};

export type Oracle = {
  /** Wrap a tool with memoization + transition tracking. */
  wrap<I, O>(t: Tool<I, O>): WrappedTool<I, O>;
  /** Predict the next tool call from the learned call sequence. */
  prophecy(): Prophecy;
  /** Speculatively execute a call to warm the cache. */
  warm<I, O>(call: { tool: string; input: I }): Promise<WarmResult>;
  /** All cached entries (inspection/debugging). */
  entries(): CacheEntry[];
  stats(): { hits: number; misses: number; speculations: number; size: number };
};

export function createOracle(options: OracleOptions): Oracle {
  const ttlMs = options.ttlMs ?? 30_000;
  const maxEntries = options.maxEntries ?? 500;
  const byName = new Map<string, Tool<never, unknown>>();
  for (const t of options.tools) byName.set(t.name, t);

  const cache = new Map<string, CacheEntry>();
  const transitions = new Map<string, Map<string, number>>();
  let lastTool: string | undefined;
  let hits = 0;
  let misses = 0;
  let speculations = 0;

  const keyOf = (tool: string, input: unknown) => `${tool}:${stableStringify(input)}`;

  function remember(tool: string, input: unknown, value: unknown): void {
    const key = keyOf(tool, input);
    if (!cache.has(key) && cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { tool, input, value, storedAt: Date.now(), hits: 0 });
  }

  function lookup(tool: string, input: unknown): CacheEntry | undefined {
    const entry = cache.get(keyOf(tool, input));
    if (!entry) return undefined;
    if (Date.now() - entry.storedAt > ttlMs) {
      cache.delete(keyOf(tool, input));
      return undefined;
    }
    entry.hits += 1;
    return entry;
  }

  function trackTransition(tool: string): void {
    if (lastTool) {
      const row = transitions.get(lastTool) ?? new Map<string, number>();
      row.set(tool, (row.get(tool) ?? 0) + 1);
      transitions.set(lastTool, row);
    }
    lastTool = tool;
  }

  return {
    wrap<I, O>(t: Tool<I, O>): WrappedTool<I, O> {
      return {
        name: t.name,
        description: `${t.description} (oracle-wrapped)`,
        schema: t.schema,
        ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}),
        cacheSize: () => [...cache.values()].filter((e) => e.tool === t.name).length,
        clearCache: () => {
          for (const [key, entry] of cache) {
            if (entry.tool === t.name) cache.delete(key);
          }
        },
        async execute(input: I, ctx: ToolContext): Promise<ToolResult<O>> {
          const cached = lookup(t.name, input);
          if (cached) {
            hits += 1;
            trackTransition(t.name);
            return cached.value as O;
          }
          misses += 1;
          const outcome = await runTool(t, input, ctx);
          trackTransition(t.name);
          if (outcome.ok) remember(t.name, input, outcome.value);
          return outcome.ok ? outcome.value : outcome;
        },
      };
    },

    prophecy(): Prophecy {
      if (!lastTool) return { tool: "", confidence: 0 };
      const row = transitions.get(lastTool);
      if (!row || row.size === 0) return { tool: "", confidence: 0, basedOn: lastTool };
      let bestTool = "";
      let bestCount = 0;
      let total = 0;
      for (const [name, count] of row) {
        total += count;
        if (count > bestCount) {
          bestCount = count;
          bestTool = name;
        }
      }
      return { tool: bestTool, confidence: total > 0 ? bestCount / total : 0, basedOn: lastTool };
    },

    async warm<I, O>(call: { tool: string; input: I }): Promise<WarmResult> {
      speculations += 1;
      const cached = lookup(call.tool, call.input);
      if (cached) {
        options.onSpeculation?.({ tool: call.tool, input: call.input, hit: true });
        return { tool: call.tool, input: call.input, hit: true, value: cached.value };
      }
      const target = byName.get(call.tool);
      if (!target) {
        options.onSpeculation?.({ tool: call.tool, input: call.input, hit: false });
        return { tool: call.tool, input: call.input, hit: false };
      }
      const outcome = await runTool(target as Tool<unknown, unknown>, call.input, {});
      if (outcome.ok) {
        remember(call.tool, call.input, outcome.value);
        options.onSpeculation?.({ tool: call.tool, input: call.input, hit: true });
        return { tool: call.tool, input: call.input, hit: true, value: outcome.value };
      }
      options.onSpeculation?.({ tool: call.tool, input: call.input, hit: false });
      return { tool: call.tool, input: call.input, hit: false };
    },

    entries(): CacheEntry[] {
      return [...cache.values()];
    },

    stats() {
      return { hits, misses, speculations, size: cache.size };
    },
  };
}

/**
 * One-shot memoizer for a single tool — the lazy cousin of createOracle().
 * Failures are never cached, so a retry can succeed.
 */
export function memoize<I, O>(t: Tool<I, O>, ttlMs = 30_000): WrappedTool<I, O> {
  return createOracle({ tools: [t as unknown as Tool<never, unknown>], ttlMs }).wrap(t);
}

/** True when a value looks like a structured tool failure (never cache those). */
export function isCacheable(value: unknown): boolean {
  return !isFailure(value);
}

/** Stable stringify so `{a:1,b:2}` and `{b:2,a:1}` share one cache entry. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

/** Re-exported so callers can build structured failures from missed prophecies. */
export { failure };