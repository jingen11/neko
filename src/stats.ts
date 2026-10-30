import type { CallSummary } from "./types.ts";

interface Bucket {
  calls: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  avgDurationMs: number;
  avgTokensPerSec: number | null;
}

function bucket(rows: readonly CallSummary[]): Bucket {
  const tps = rows.filter((r) => r.tokensPerSec).map((r) => r.tokensPerSec!);
  const sum = (f: (r: CallSummary) => number | undefined) => rows.reduce((a, r) => a + (f(r) ?? 0), 0);
  return {
    calls: rows.length,
    errors: rows.filter((r) => r.status >= 400 || r.error).length,
    promptTokens: sum((r) => r.promptTokens),
    completionTokens: sum((r) => r.completionTokens),
    avgDurationMs: rows.length ? Math.round(sum((r) => r.durationMs) / rows.length) : 0,
    avgTokensPerSec: tps.length ? Math.round((tps.reduce((a, b) => a + b, 0) / tps.length) * 10) / 10 : null,
  };
}

function groupBy(rows: readonly CallSummary[], key: (r: CallSummary) => string): Record<string, Bucket> {
  const groups = new Map<string, CallSummary[]>();
  for (const r of rows) {
    const k = key(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  return Object.fromEntries([...groups].map(([k, v]) => [k, bucket(v)]));
}

/** Aggregate stats, optionally limited to calls since an ISO timestamp. */
export function computeStats(all: readonly CallSummary[], since?: string) {
  const rows = since ? all.filter((r) => r.startedAt >= since) : all;
  return {
    since: since ?? rows[0]?.startedAt ?? null,
    total: bucket(rows),
    byClient: groupBy(rows, (r) => r.client),
    byEndpoint: groupBy(rows, (r) => r.endpoint),
    byDay: groupBy(rows, (r) => r.startedAt.slice(0, 10)),
    recent: rows.slice(-20).reverse(),
  };
}
