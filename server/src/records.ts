import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { localDay } from "./pet.ts";
import type { Correction } from "./tutor.ts";

/**
 * Learning records. Every practice turn, listening miss and grammar question is stored in SQLite,
 * and the vault notes are rendered from it (so they can always be rebuilt):
 *
 *   <vault>/Japanese/Index.md            totals, weakest grammar points, recent days
 *   <vault>/Japanese/Daily/<date>.md     everything practised that day
 *   <vault>/Japanese/Grammar/<point>.md  every mistake on one grammar point
 *
 * neko owns these files and overwrites them. Hermes writes its own notes elsewhere (Japanese/Notes/).
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    day TEXT NOT NULL,
    said TEXT NOT NULL,
    is_correct INTEGER NOT NULL,
    corrected TEXT NOT NULL,
    natural TEXT NOT NULL,
    reply_ja TEXT NOT NULL DEFAULT '',
    reply_en TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS turns_day ON turns(day);
  CREATE TABLE IF NOT EXISTS mistakes (
    turn_id INTEGER NOT NULL REFERENCES turns(id),
    at INTEGER NOT NULL,
    day TEXT NOT NULL,
    kind TEXT NOT NULL,
    original TEXT NOT NULL,
    fix TEXT NOT NULL,
    point TEXT NOT NULL,
    point_key TEXT NOT NULL,
    explanation TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS mistakes_point ON mistakes(point_key);
  CREATE INDEX IF NOT EXISTS mistakes_day ON mistakes(day);
  CREATE TABLE IF NOT EXISTS listening (
    at INTEGER NOT NULL,
    day TEXT NOT NULL,
    kind TEXT NOT NULL,
    ja TEXT NOT NULL,
    en TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS listening_day ON listening(day);
  CREATE TABLE IF NOT EXISTS asks (
    at INTEGER NOT NULL,
    day TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    source TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS asks_day ON asks(day);
`);

/** Grammar point names from the model vary a little ("Ni vs de." / "ni vs de"); this groups them. */
export const pointKey = (p: string) =>
  p
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[.。、,!?！？"'「」]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// ── writing records ─────────────────────────────────────────────────────────

export function logTurn(said: string, c: Correction, reply?: { ja: string; en: string }) {
  const at = Date.now();
  const day = localDay(at);
  const { lastInsertRowid } = db
    .prepare("INSERT INTO turns (at, day, said, is_correct, corrected, natural, reply_ja, reply_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(at, day, said, c.is_correct ? 1 : 0, c.corrected, c.natural, reply?.ja ?? "", reply?.en ?? "");
  const insert = db.prepare(
    "INSERT INTO mistakes (turn_id, at, day, kind, original, fix, point, point_key, explanation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const keys = new Set<string>();
  for (const m of c.mistakes) {
    const point = m.grammar_point.trim() || "other";
    const key = pointKey(point);
    keys.add(key);
    // reuse the first name seen for this point so the vault note keeps one title
    insert.run(lastInsertRowid, at, day, m.type, m.original, m.fix, pointName(key) ?? point, key, m.explanation);
  }
  queueWrite(day, keys);
}

export type ListeningKind = "repeat" | "slow" | "english";

/** The learner needed help to understand a line: asked to hear it again, slowly, or looked at the English. */
export function logListening(kind: ListeningKind, line: { ja: string; en: string }) {
  const at = Date.now();
  const day = localDay(at);
  db.prepare("INSERT INTO listening (at, day, kind, ja, en) VALUES (?, ?, ?, ?, ?)").run(at, day, kind, line.ja, line.en);
  queueWrite(day);
}

export function logAsk(question: string, answer: string, source: string) {
  const at = Date.now();
  const day = localDay(at);
  db.prepare("INSERT INTO asks (at, day, question, answer, source) VALUES (?, ?, ?, ?, ?)").run(at, day, question, answer, source);
  queueWrite(day);
}

// ── reading records ─────────────────────────────────────────────────────────

function pointName(key: string): string | undefined {
  const row = db.prepare("SELECT point FROM mistakes WHERE point_key = ? ORDER BY at LIMIT 1").get(key) as { point: string } | undefined;
  return row?.point;
}

export interface WeakPoint {
  point: string;
  key: string;
  kind: string;
  n: number;
  last: number;
  original: string;
  fix: string;
  said: string;
  corrected: string;
}

/** Grammar points with the most mistakes since `sinceDays` ago, with the latest example of each. */
export function weakPoints(limit = 10, sinceDays = 30): WeakPoint[] {
  const since = Date.now() - sinceDays * 86_400_000;
  return db
    .prepare(
      `SELECT m.point_key AS key, COUNT(*) AS n, MAX(m.at) AS last,
              (SELECT point FROM mistakes WHERE point_key = m.point_key ORDER BY at LIMIT 1) AS point,
              l.kind, l.original, l.fix, t.said, t.corrected
       FROM mistakes m
       JOIN mistakes l ON l.rowid = (SELECT rowid FROM mistakes WHERE point_key = m.point_key ORDER BY at DESC LIMIT 1)
       JOIN turns t ON t.id = l.turn_id
       WHERE m.at >= ?
       GROUP BY m.point_key
       ORDER BY n DESC, last DESC
       LIMIT ?`,
    )
    .all(since, limit) as unknown as WeakPoint[];
}

/** Names of grammar points already on record, so the correction model can reuse them. */
export function knownPoints(limit = 40): string[] {
  return weakPoints(limit, 3650).map((p) => p.point);
}

/** A short plain-text summary of the learner's record, for prompts. */
export function recordSummary(): string {
  const w = weakPoints(8);
  const totals = db.prepare("SELECT COUNT(*) AS n, SUM(is_correct) AS ok, COUNT(DISTINCT day) AS days FROM turns").get() as {
    n: number;
    ok: number | null;
    days: number;
  };
  if (!totals.n) return "No practice recorded yet.";
  const lines = [`${totals.n} sentences practised over ${dayCount(totals.days)}, ${Math.round(((totals.ok ?? 0) / totals.n) * 100)}% correct.`];
  if (w.length) {
    lines.push("Most frequent mistakes (last 30 days):");
    for (const p of w) lines.push(`- ${p.point} (${p.kind}) x${p.n}, latest: ${p.said} -> ${p.corrected}`);
  }
  return lines.join("\n");
}

// ── vault notes ─────────────────────────────────────────────────────────────

const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: config.tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const hhmm = (t: number) => timeFmt.format(t);
/** Characters Obsidian or the filesystem don't allow in a note name. */
const fileName = (p: string) => p.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "other";
/** Links use the folder's own name ("Japanese/...") so they resolve from anywhere in the vault. */
const ns = () => path.basename(config.vaultDir);
const grammarLink = (point: string, sep = "|") => `[[${ns()}/Grammar/${fileName(point)}${sep}${point}]]`;
const dayLink = (day: string) => `[[${ns()}/Daily/${day}|${day}]]`;
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();
const quote = (s: string) => s.trim().split("\n").map((l) => `> ${l}`).join("\n");

const dayCount = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;
const OWNED = "Written by neko from its records; edits here are overwritten.";

let chain: Promise<void> = Promise.resolve();
let pending: { days: Set<string>; points: Set<string> } | null = null;

/** Rewrite the affected notes. Writes run one at a time; bursts collapse into one write. */
function queueWrite(day: string, points: Iterable<string> = []) {
  if (!config.vaultDir) return;
  if (!pending) {
    pending = { days: new Set(), points: new Set() };
    chain = chain.then(() => {
      const job = pending!;
      pending = null;
      return writeNotes(job.days, job.points).catch((err) => console.warn(`vault write failed: ${(err as Error).message}`));
    });
  }
  pending.days.add(day);
  for (const p of points) pending.points.add(p);
}

/** Resolves once every queued vault write has finished (for tests and shutdown). */
export const flushed = () => chain;

async function writeNote(rel: string, body: string) {
  const file = path.join(config.vaultDir, rel);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.neko-tmp`;
  await writeFile(tmp, body);
  await rename(tmp, file);
}

async function writeNotes(days: Set<string>, points: Set<string>) {
  for (const d of days) await writeNote(`Daily/${d}.md`, dailyNote(d));
  for (const k of points) {
    const note = grammarNote(k);
    if (note) await writeNote(`Grammar/${fileName(note.point)}.md`, note.body);
  }
  await writeNote("Index.md", indexNote());
}

/** Rebuild every note from the database. */
export async function rebuildVault() {
  const days = (db.prepare("SELECT day FROM turns UNION SELECT day FROM listening UNION SELECT day FROM asks").all() as { day: string }[]).map((r) => r.day);
  const points = (db.prepare("SELECT DISTINCT point_key FROM mistakes").all() as { point_key: string }[]).map((r) => r.point_key);
  await writeNotes(new Set(days), new Set(points));
}

interface TurnRow {
  id: number;
  at: number;
  said: string;
  is_correct: number;
  corrected: string;
  natural: string;
  reply_ja: string;
  reply_en: string;
}
interface MistakeRow {
  turn_id: number;
  at: number;
  day: string;
  kind: string;
  original: string;
  fix: string;
  point: string;
  explanation: string;
}

function dailyNote(day: string): string {
  const turns = db.prepare("SELECT * FROM turns WHERE day = ? ORDER BY at").all(day) as unknown as TurnRow[];
  const mistakes = db.prepare("SELECT * FROM mistakes WHERE day = ? ORDER BY at").all(day) as unknown as MistakeRow[];
  const listening = db.prepare("SELECT * FROM listening WHERE day = ? ORDER BY at").all(day) as unknown as { at: number; kind: ListeningKind; ja: string; en: string }[];
  const asks = db.prepare("SELECT * FROM asks WHERE day = ? ORDER BY at").all(day) as unknown as { at: number; question: string; answer: string; source: string }[];
  const correct = turns.filter((t) => t.is_correct).length;
  const points = [...new Set(mistakes.map((m) => m.point))];

  const out = [
    "---",
    `date: ${day}`,
    `level: ${config.level}`,
    `sentences: ${turns.length}`,
    `correct: ${correct}`,
    `mistakes: ${mistakes.length}`,
    `listening_misses: ${listening.length}`,
    `questions: ${asks.length}`,
    "tags: [neko, japanese/daily]",
    "---",
    `# Japanese practice ${day}`,
    "",
    `${OWNED} See [[${ns()}/Index|Index]] for the overall picture.`,
    "",
    `**${turns.length} sentences**, ${correct} correct, ${mistakes.length} mistakes.` + (points.length ? ` Points: ${points.map((p) => grammarLink(p)).join(", ")}.` : ""),
    "",
  ];

  if (turns.length) {
    out.push("## Speaking", "");
    for (const t of turns) {
      out.push(`### ${hhmm(t.at)} ${t.is_correct ? "✓" : "✗"}`, `- Said: ${oneLine(t.said)}`);
      if (!t.is_correct) out.push(`- Fixed: ${oneLine(t.corrected)}`);
      if (t.natural && t.natural !== t.corrected && t.natural !== t.said) out.push(`- More natural: ${oneLine(t.natural)}`);
      for (const m of mistakes.filter((m) => m.turn_id === t.id))
        out.push(`- Mistake (${m.kind}): ${oneLine(m.original)} → ${oneLine(m.fix)} · ${grammarLink(m.point)} · ${oneLine(m.explanation)}`);
      if (t.reply_ja) out.push(`- ${config.petName} replied: ${oneLine(t.reply_ja)}` + (t.reply_en ? ` (${oneLine(t.reply_en)})` : ""));
      out.push("");
    }
  }

  if (listening.length) {
    const what = { repeat: "Asked to hear again", slow: "Asked to hear slowly", english: "Looked at the English" };
    out.push("## Listening", "", "Lines the learner needed help to understand.", "");
    for (const l of listening) out.push(`- ${hhmm(l.at)} ${what[l.kind] ?? l.kind}: ${oneLine(l.ja)} (${oneLine(l.en)})`);
    out.push("");
  }

  if (asks.length) {
    out.push("## Grammar questions", "");
    for (const a of asks) out.push(`### ${hhmm(a.at)} ${oneLine(a.question)}`, "", quote(a.answer), "", `*Answered by ${a.source}.*`, "");
  }
  return out.join("\n");
}

function grammarNote(key: string): { point: string; body: string } | null {
  const rows = db
    .prepare(
      `SELECT m.*, t.said, t.corrected FROM mistakes m JOIN turns t ON t.id = m.turn_id
       WHERE m.point_key = ? ORDER BY m.at DESC`,
    )
    .all(key) as unknown as (MistakeRow & { said: string; corrected: string })[];
  if (!rows.length) return null;
  const point = rows[rows.length - 1].point;
  const kinds = [...new Set(rows.map((r) => r.kind))];
  const out = [
    "---",
    `grammar_point: "${point.replace(/"/g, "'")}"`,
    `type: ${kinds.join(", ")}`,
    `mistakes: ${rows.length}`,
    `first_seen: ${rows[rows.length - 1].day}`,
    `last_seen: ${rows[0].day}`,
    "tags: [neko, japanese/grammar]",
    "---",
    `# ${point}`,
    "",
    `Every mistake neko recorded on this point, newest first. ${OWNED}`,
    "",
  ];
  for (const r of rows) {
    out.push(
      `- ${r.day} ${hhmm(r.at)} · ${oneLine(r.original)} → ${oneLine(r.fix)} · ${dayLink(r.day)}`,
      `  - Said: ${oneLine(r.said)}`,
      `  - Fixed: ${oneLine(r.corrected)}`,
      `  - Why: ${oneLine(r.explanation)}`,
    );
  }
  return { point, body: out.join("\n") + "\n" };
}

function indexNote(): string {
  const totals = db.prepare("SELECT COUNT(*) AS n, SUM(is_correct) AS ok, COUNT(DISTINCT day) AS days FROM turns").get() as {
    n: number;
    ok: number | null;
    days: number;
  };
  const weak = weakPoints(15);
  const recent = db
    .prepare(
      `SELECT day, COUNT(*) AS n, SUM(is_correct) AS ok FROM turns GROUP BY day ORDER BY day DESC LIMIT 14`,
    )
    .all() as { day: string; n: number; ok: number }[];
  const pct = totals.n ? Math.round(((totals.ok ?? 0) / totals.n) * 100) : 0;
  const out = [
    "---",
    `level: ${config.level}`,
    `sentences: ${totals.n}`,
    `days_practised: ${totals.days}`,
    `updated: ${new Date().toISOString()}`,
    "tags: [neko, japanese]",
    "---",
    "# Japanese learning record",
    "",
    `Kept by neko, the learner's Japanese-practice pet. Level: JLPT ${config.level}. ${OWNED}`,
    "",
    "- `Daily/<date>.md`: every sentence said that day, its correction, listening misses and grammar questions.",
    "- `Grammar/<point>.md`: every mistake on one grammar point, with the sentence it came from.",
    "- `Notes/`: free for Hermes and the learner; neko never writes there.",
    "",
    `**${totals.n} sentences** over ${dayCount(totals.days)}, ${pct}% correct.`,
    "",
    "## Weakest grammar points (last 30 days)",
    "",
  ];
  if (weak.length) {
    out.push("| Point | Type | Mistakes | Last seen | Latest example |", "|---|---|---|---|---|");
    for (const w of weak)
      // inside a table the link's alias pipe must be escaped
      out.push(`| ${grammarLink(w.point, "\\|")} | ${w.kind} | ${w.n} | ${localDay(w.last)} | ${oneLine(w.original)} → ${oneLine(w.fix)} |`);
  } else out.push("No mistakes recorded in the last 30 days.");
  out.push("", "## Recent days", "");
  for (const r of recent) out.push(`- ${dayLink(r.day)}: ${r.n} sentences, ${r.ok} correct`);
  return out.join("\n") + "\n";
}
