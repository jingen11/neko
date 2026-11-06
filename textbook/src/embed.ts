import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Section, Textbook } from "./textbook.ts";

/**
 * Meaning search. Each chunk of the book (a section, or a piece of a long one) is turned into a
 * vector by BGE-M3 once and saved; a search only embeds the question and compares it with the
 * saved vectors (cosine). Vectors are keyed by a hash of the chunk's text, so editing a lesson
 * re-embeds only the chunks that changed.
 *
 * The model runs as its own llama.cpp server (deploy/systemd/neko-embed.service).
 */

export const MODEL = "bge-m3";
/** Long sections (exercises, dialogues) are split so a match points at the right part. */
const MAX_CHARS = 1200;
const BATCH = 8;

export interface Chunk {
  section: Section;
  /** Lines of section.raw / section.text this chunk covers. */
  from: number;
  to: number;
  /** Text sent to the model: where it is in the book, then the body without furigana. */
  input: string;
  hash: string;
  vec?: Float32Array;
}

const plain = (s: string) => s.replace(/\{([^|{}]+)\|[^|{}]+\}/g, "$1").replace(/\\\*/g, "");

export function chunk(tb: Textbook): Chunk[] {
  const out: Chunk[] = [];
  for (const s of tb.sections) {
    const lines = s.raw.split("\n");
    const where = [s.lesson !== null ? `第${s.lesson}課 ${s.title}` : s.title, s.part, s.heading].filter(Boolean).join(" / ");
    let from = 0;
    let size = 0;
    const push = (to: number) => {
      const body = plain(lines.slice(from, to).join("\n")).trim();
      if (body) {
        const input = `${plain(where)}\n${body}`;
        out.push({ section: s, from, to, input, hash: createHash("sha1").update(`${MODEL}\n${input}`).digest("hex") });
      }
      from = to;
      size = 0;
    };
    lines.forEach((l, i) => {
      // Split at a blank line once the piece is big enough, or anywhere if it gets far too big.
      if ((size > MAX_CHARS && !l.trim()) || size > MAX_CHARS * 2) push(i);
      size += l.length + 1;
    });
    push(lines.length);
  }
  return out;
}

export class Embedder {
  private down = 0;
  private url: string;
  constructor(url: string) { this.url = url; }

  /** Normalised vectors, or null if the server is off or failing (then retried after a minute). */
  async embed(texts: string[], timeoutMs: number): Promise<Float32Array[] | null> {
    if (!this.url || Date.now() - this.down < 60_000) return null;
    try {
      const res = await fetch(`${this.url}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: texts, model: MODEL }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      return json.data.sort((a, b) => a.index - b.index).map((d) => normalise(Float32Array.from(d.embedding)));
    } catch (err) {
      this.down = Date.now();
      console.error(`neko-textbook: embedding server unavailable (${(err as Error).message}); exact search only`);
      return null;
    }
  }
}

function normalise(v: Float32Array) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

export function dot(a: Float32Array, b: Float32Array) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Saved vectors: { model, vectors: { hash: base64 float32 } }. */
export class VectorCache {
  private vectors = new Map<string, string>();
  private file: string;
  constructor(file: string) {
    this.file = file;
    if (!existsSync(file)) return;
    try {
      const json = JSON.parse(readFileSync(file, "utf8")) as { model: string; vectors: Record<string, string> };
      if (json.model === MODEL) this.vectors = new Map(Object.entries(json.vectors));
    } catch {
      console.error(`neko-textbook: ignoring unreadable ${file}`);
    }
  }

  get(hash: string) {
    const b = this.vectors.get(hash);
    if (!b) return undefined;
    const buf = Buffer.from(b, "base64");
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }

  set(hash: string, v: Float32Array) {
    this.vectors.set(hash, Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64"));
  }

  /** Keep only the given hashes (drops vectors of deleted or edited text) and write atomically. */
  save(keep: Set<string>) {
    for (const h of this.vectors.keys()) if (!keep.has(h)) this.vectors.delete(h);
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ model: MODEL, vectors: Object.fromEntries(this.vectors) }));
    renameSync(tmp, this.file);
  }
}

/**
 * Fill in every chunk's vector: from the cache, else from the model (in batches), then save.
 * Returns how many were embedded, or null if the server was unavailable before finishing.
 */
export async function index(chunks: Chunk[], cache: VectorCache, embedder: Embedder, onProgress?: (done: number, total: number) => void) {
  const missing: Chunk[] = [];
  for (const c of chunks) {
    c.vec = cache.get(c.hash);
    if (!c.vec) missing.push(c);
  }
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    const vecs = await embedder.embed(batch.map((c) => c.input), 120_000);
    if (!vecs) return null;
    batch.forEach((c, j) => { c.vec = vecs[j]; cache.set(c.hash, vecs[j]); });
    onProgress?.(i + batch.length, missing.length);
  }
  if (missing.length || chunks.length) cache.save(new Set(chunks.map((c) => c.hash)));
  return missing.length;
}

export interface VectorHit { chunk: Chunk; score: number }

/**
 * Word lists and unit intros mention everything, so they crowd out the explanation a question
 * is after; words are found by exact search instead. Related sections score within a few
 * hundredths of each other, so explanations get a small lift.
 */
const SKIP = (s: Section) => s.part.startsWith("生词表") || (s.lesson === null && /^第\d+单元/.test(s.title));
const LIFT: Record<string, number> = { "语法解释": 0.03, "表达及词语讲解": 0.015 };

/** Best chunk per section, most similar first. */
export function nearest(chunks: Chunk[], q: Float32Array, limit: number): VectorHit[] {
  const best = new Map<Section, VectorHit>();
  for (const c of chunks) {
    if (!c.vec || SKIP(c.section)) continue;
    const score = dot(q, c.vec) + (LIFT[c.section.part] ?? 0);
    const cur = best.get(c.section);
    if (!cur || score > cur.score) best.set(c.section, { chunk: c, score });
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
