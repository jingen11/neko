import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { localDay } from "./pet.ts";
import type { ChallengeResult } from "../../shared/protocol.ts";
import type { Correction } from "./tutor.ts";

/**
 * Learning records. Every practice turn, listening miss and grammar question is stored in SQLite,
 * and the vault notes are rendered from it (so they can always be rebuilt):
 *
 *   <vault>/Japanese/Index.md            totals, weakest grammar points, recent days
 *   <vault>/Japanese/Daily/<date>.md     everything practised that day, translation challenges included
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
  -- translation challenges (written by challenge.ts)
  CREATE TABLE IF NOT EXISTS challenges (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    day TEXT NOT NULL,
    kind TEXT NOT NULL,
    seed INTEGER NOT NULL,
    topic TEXT NOT NULL,
    grammar TEXT NOT NULL,
    style TEXT NOT NULL,
    zh TEXT NOT NULL,
    ja TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS challenges_daily ON challenges(day) WHERE kind = 'daily';
  CREATE INDEX IF NOT EXISTS challenges_day ON challenges(day);
  CREATE TABLE IF NOT EXISTS challenge_attempts (
    id INTEGER PRIMARY KEY,
    challenge_id INTEGER NOT NULL REFERENCES challenges(id),
    turn_id INTEGER REFERENCES turns(id), -- the turn holding this answer's grammar mistakes
    at INTEGER NOT NULL,
    day TEXT NOT NULL,
    answer TEXT NOT NULL,
    total INTEGER NOT NULL,
    result TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS challenge_attempts_challenge ON challenge_attempts(challenge_id);
`);

// Attempts saved before turn_id existed: add the column and link each to the turn logged with it
// (same answer, a moment apart), so translations stop showing up as spoken sentences.
if (!(db.prepare("PRAGMA table_info(challenge_attempts)").all() as { name: string }[]).some((c) => c.name === "turn_id")) {
  db.exec("ALTER TABLE challenge_attempts ADD COLUMN turn_id INTEGER REFERENCES turns(id)");
  const find = db.prepare("SELECT id FROM turns WHERE said = ? AND at BETWEEN ? AND ? ORDER BY ABS(at - ?) LIMIT 1");
  const link = db.prepare("UPDATE challenge_attempts SET turn_id = ? WHERE id = ?");
  for (const a of db.prepare("SELECT id, at, answer FROM challenge_attempts").all() as { id: number; at: number; answer: string }[]) {
    const t = find.get(a.answer, a.at - 10_000, a.at + 10_000, a.at) as { id: number } | undefined;
    if (t) link.run(t.id, a.id);
  }
}
db.exec("CREATE INDEX IF NOT EXISTS challenge_attempts_turn ON challenge_attempts(turn_id)");

/** Grammar point names from the model vary a little ("Ni vs de." / "ni vs de"); this groups them. */
export const pointKey = (p: string) =>
  p
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[.。、,!?！？"'「」]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// ── writing records ─────────────────────────────────────────────────────────

/** Record a practised sentence and its mistakes; returns the turn's id. */
export function logTurn(said: string, c: Correction, reply?: { ja: string; en: string }): number {
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
  return Number(lastInsertRowid);
}

/** Something on `day` changed outside this module (a translation challenge): rewrite that day's note. */
export function noteChanged(day: string) {
  queueWrite(day);
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

/** The latest grammar questions and answers (oldest first), so follow-up questions keep their context. */
export function recentAsks(limit = 4, withinHours = 12): { question: string; answer: string }[] {
  const since = Date.now() - withinHours * 3_600_000;
  const rows = db.prepare("SELECT question, answer FROM asks WHERE at >= ? ORDER BY at DESC LIMIT ?").all(since, limit) as {
    question: string;
    answer: string;
  }[];
  return rows.reverse();
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
const dayLink = (day: string, sep = "|") => `[[${ns()}/Daily/${day}${sep}${day}]]`;
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
  const days = (db.prepare("SELECT day FROM turns UNION SELECT day FROM listening UNION SELECT day FROM asks UNION SELECT day FROM challenges").all() as { day: string }[]).map((r) => r.day);
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

interface ChallengeRow {
  id: number;
  at: number;
  day: string;
  kind: "daily" | "extra";
  topic: string;
  grammar: string;
  style: string;
  zh: string;
  ja: string;
}
interface AttemptRow {
  challenge_id: number;
  at: number;
  day: string;
  total: number;
  result: string;
}

/** One translation challenge and every attempt at it, for the daily note. */
function challengeLines(c: ChallengeRow, attempts: AttemptRow[]): string[] {
  const out = [
    `### ${hhmm(c.at)} ${c.kind === "daily" ? "Daily challenge" : "Extra challenge"}` + (attempts.length ? ` · best ${Math.max(...attempts.map((a) => a.total))}/100` : ""),
    `- Chinese: ${oneLine(c.zh)}`,
    `- Reference: ${oneLine(c.ja)}`,
    `- Brief: ${c.topic} · ${c.grammar} · ${c.style}` + (c.day !== attempts[0]?.day && attempts.length ? ` · set on ${dayLink(c.day)}` : ""),
  ];
  if (!attempts.length) out.push("- Not attempted.");
  attempts.forEach((a, i) => {
    const r = JSON.parse(a.result) as ChallengeResult;
    out.push(
      "",
      `#### Attempt ${i + 1} · ${hhmm(a.at)}${a.day !== c.day ? ` (${a.day})` : ""} · ${r.total}/100`,
      `- Answer: ${oneLine(r.answer)}`,
      `- Score: meaning ${r.meaning}/50 · grammar ${r.grammar}/30 · naturalness ${r.naturalness}/20`,
    );
    if (r.mistakes.length) out.push(`- Corrected: ${oneLine(r.corrected)}`);
    for (const m of r.mistakes) {
      // grammar mistakes link to their grammar note; meaning slips are about this sentence only
      const point = m.type === "meaning" || m.type === "omission" ? m.grammar_point : grammarLink(pointName(pointKey(m.grammar_point)) ?? m.grammar_point);
      out.push(`- Mistake (${m.type}): ${oneLine(m.original)} → ${oneLine(m.fix)} · ${point} · ${oneLine(m.explanation)}`);
    }
    if (!r.mistakes.length) out.push("- No mistakes.");
    if (r.comment) out.push(`- Comment: ${oneLine(r.comment)}`);
  });
  out.push("");
  return out;
}

function dailyNote(day: string): string {
  // Translation answers are turns too (for their grammar mistakes) but get their own section below.
  const turns = db
    .prepare("SELECT * FROM turns WHERE day = ? AND id NOT IN (SELECT turn_id FROM challenge_attempts WHERE turn_id IS NOT NULL) ORDER BY at")
    .all(day) as unknown as TurnRow[];
  const challenges = db.prepare("SELECT * FROM challenges WHERE day = ? ORDER BY at").all(day) as unknown as ChallengeRow[];
  const attempts = db
    .prepare("SELECT a.* FROM challenge_attempts a JOIN challenges c ON c.id = a.challenge_id WHERE c.day = ? OR a.day = ? ORDER BY a.at")
    .all(day, day) as unknown as AttemptRow[];
  // a challenge from an earlier day attempted today still belongs in today's note
  for (const id of new Set(attempts.map((a) => a.challenge_id)))
    if (!challenges.some((c) => c.id === id)) challenges.push(db.prepare("SELECT * FROM challenges WHERE id = ?").get(id) as unknown as ChallengeRow);
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
    `translations: ${attempts.length}`,
    ...(attempts.length ? [`best_translation_score: ${Math.max(...attempts.map((a) => a.total))}`] : []),
    "tags: [neko, japanese/daily]",
    "---",
    `# Japanese practice ${day}`,
    "",
    `${OWNED} See [[${ns()}/Index|Index]] for the overall picture.`,
    "",
    `**${turns.length} ${turns.length === 1 ? "sentence" : "sentences"}** spoken, ${correct} correct` +
      (attempts.length ? `; **${attempts.length} ${attempts.length === 1 ? "translation" : "translations"}**, best ${Math.max(...attempts.map((a) => a.total))}/100` : "") +
      `; ${mistakes.length} grammar ${mistakes.length === 1 ? "mistake" : "mistakes"}.` +
      (points.length ? ` Points: ${points.map((p) => grammarLink(p)).join(", ")}.` : ""),
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

  if (challenges.length) {
    out.push("## Translation", "", "Chinese → Japanese challenges, with every attempt.", "");
    for (const c of challenges) out.push(...challengeLines(c, attempts.filter((a) => a.challenge_id === c.id)));
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

/** SQL condition: a turn that was spoken (or typed) to the cat, not a translation answer. */
const SPOKEN = "id NOT IN (SELECT turn_id FROM challenge_attempts WHERE turn_id IS NOT NULL)";

function grammarNote(key: string): { point: string; body: string } | null {
  const rows = db
    .prepare(
      `SELECT m.*, t.said, t.corrected, c.zh FROM mistakes m JOIN turns t ON t.id = m.turn_id
       LEFT JOIN challenge_attempts a ON a.turn_id = t.id
       LEFT JOIN challenges c ON c.id = a.challenge_id
       WHERE m.point_key = ? ORDER BY m.at DESC`,
    )
    .all(key) as unknown as (MistakeRow & { said: string; corrected: string; zh: string | null })[];
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
      ...(r.zh ? [`  - Translating: ${oneLine(r.zh)}`, `  - Wrote: ${oneLine(r.said)}`] : [`  - Said: ${oneLine(r.said)}`]),
      `  - Fixed: ${oneLine(r.corrected)}`,
      `  - Why: ${oneLine(r.explanation)}`,
    );
  }
  return { point, body: out.join("\n") + "\n" };
}

function indexNote(): string {
  const totals = db.prepare(`SELECT COUNT(*) AS n, SUM(is_correct) AS ok, COUNT(DISTINCT day) AS days FROM turns WHERE ${SPOKEN}`).get() as {
    n: number;
    ok: number | null;
    days: number;
  };
  const weak = weakPoints(15);
  const recent = db
    .prepare(
      `SELECT day, SUM(${SPOKEN}) AS n, SUM(is_correct AND ${SPOKEN}) AS ok, SUM(NOT ${SPOKEN}) AS tr
       FROM turns GROUP BY day ORDER BY day DESC LIMIT 14`,
    )
    .all() as { day: string; n: number; ok: number; tr: number }[];
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
    "- `Daily/<date>.md`: every sentence said that day, its correction, listening misses, grammar questions and translation challenges.",
    "- `Grammar/<point>.md`: every mistake on one grammar point, with the sentence it came from.",
    "- `Notes/`: free for Hermes and the learner; neko never writes there.",
    "",
    `**${totals.n} ${totals.n === 1 ? "sentence" : "sentences"}** spoken over ${dayCount(totals.days)}, ${pct}% correct.`,
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
  const translations = db
    .prepare(
      `SELECT a.at, a.day, a.total, a.answer, c.zh FROM challenge_attempts a JOIN challenges c ON c.id = a.challenge_id
       ORDER BY a.at DESC LIMIT 10`,
    )
    .all() as { at: number; day: string; total: number; answer: string; zh: string }[];
  if (translations.length) {
    out.push("", "## Recent translations", "", "| Day | Score | Chinese | Answer |", "|---|---|---|---|");
    for (const t of translations) out.push(`| ${dayLink(t.day, "\\|")} | ${t.total}/100 | ${oneLine(t.zh)} | ${oneLine(t.answer)} |`);
  }
  out.push("", "## Recent days", "");
  for (const r of recent) out.push(`- ${dayLink(r.day)}: ${r.n} spoken, ${r.ok} correct` + (r.tr ? `, ${r.tr} ${r.tr === 1 ? "translation" : "translations"}` : ""));
  return out.join("\n") + "\n";
}
