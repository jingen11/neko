import { randomInt } from "node:crypto";
import type { Challenge, ChallengeResult, ChallengeState } from "../../shared/protocol.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { chatJson } from "./llm.ts";
import * as pet from "./pet.ts";
import { localDay } from "./pet.ts";
import * as records from "./records.ts";
import type { Mistake } from "./tutor.ts";

/**
 * Translation challenge: one Simplified Chinese sentence to translate into Japanese, then a score.
 *
 * Randomness comes from code, not from a hot model. A seeded generator picks a brief
 * (topic, grammar point, sentence type, politeness, length) from the lists below, and the model
 * only writes a sentence for that brief. Recently used topics and grammar points are picked less,
 * the learner's weak points more. The daily challenge's seed comes from the date, and it is stored
 * once made, so it stays the same all day. On-demand challenges get a fresh random seed.
 */

db.exec(`
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
  CREATE TABLE IF NOT EXISTS challenge_attempts (
    id INTEGER PRIMARY KEY,
    challenge_id INTEGER NOT NULL REFERENCES challenges(id),
    at INTEGER NOT NULL,
    day TEXT NOT NULL,
    answer TEXT NOT NULL,
    total INTEGER NOT NULL,
    result TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS challenge_attempts_challenge ON challenge_attempts(challenge_id);
`);

// ── what a challenge can be about ───────────────────────────────────────────

const TOPICS = [
  "buying groceries", "a late train", "a rainy weekend", "cooking dinner", "a birthday present", "visiting a doctor",
  "a job interview", "moving house", "a lost umbrella", "learning to swim", "a hotel check-in", "ordering at a café",
  "a broken phone", "a school festival", "cleaning the room", "a trip to the sea", "a noisy neighbour", "a library book",
  "a part-time job", "a hiking trip", "a new hairstyle", "a cold", "a convenience store", "a concert ticket",
  "a delayed flight", "a friend's wedding", "a cat at the window", "a cooking class", "a bicycle", "a summer festival",
  "a hot spring", "a homework deadline", "a phone call from mother", "a museum visit", "a missed bus", "a snowy morning",
  "a gym membership", "a dentist appointment", "a souvenir", "a picnic in the park", "a computer that won't start",
  "a karaoke night", "a train station announcement", "a recipe from grandmother", "a new colleague",
  "a garden", "a typhoon", "a camera", "a lost key", "a movie night", "a long queue", "a farewell party",
  "an English lesson", "a post office", "a rented apartment", "a bakery", "a sports day", "an early alarm",
  "a coffee spill", "a photo album", "a weekend market",
];

const GRAMMAR = [
  "〜てしまう", "〜たことがある", "〜ながら", "〜たり〜たりする", "〜つもりだ", "〜ようと思う", "〜てみる", "〜ておく",
  "〜ている (resulting state)", "〜てある", "〜ば conditional", "〜たら conditional", "〜と conditional", "〜なら",
  "〜のに", "〜ので", "〜し〜し", "〜そうだ (looks like)", "〜そうだ (I heard)", "〜らしい", "〜ようだ / 〜みたい",
  "〜はずだ", "〜かもしれない", "〜なければならない", "〜なくてもいい", "〜てもいい", "〜てはいけない", "〜たほうがいい",
  "〜すぎる", "〜やすい / 〜にくい", "potential form", "passive form", "causative form", "〜てくれる", "〜てもらう",
  "〜てあげる", "〜ように (so that)", "〜ようになる", "〜ことにする", "〜ことになる", "〜までに", "〜間に",
  "〜前に / 〜後で", "〜かどうか", "embedded question with 〜か", "〜とき", "〜ばかり", "〜しか〜ない",
  "comparison with より / ほど", "〜ところだ", "〜がする (sound, smell, taste)",
];

const TYPES = [
  "a plain statement", "a question to a friend", "a polite request", "a refusal with a reason", "a past experience",
  "a plan", "a small complaint", "a piece of advice", "an apology", "an invitation", "a comparison", "how someone feels",
  "a wish",
];

const POLITENESS = ["casual speech", "polite です/ます speech"];
const LENGTHS = ["short: one clause", "medium: two clauses"];

// ── seeded random ───────────────────────────────────────────────────────────

/** A 32-bit hash of a string, for turning "daily:2026-11-01" into a seed. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** mulberry32: a small, fast seeded generator returning numbers in [0, 1). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted<T>(rand: () => number, items: T[], weight: (item: T) => number): T {
  const ws = items.map(weight);
  let r = rand() * ws.reduce((a, b) => a + b, 0);
  for (let i = 0; i < items.length; i++) if ((r -= ws[i]) < 0) return items[i];
  return items[items.length - 1];
}

const RECENT_DAYS = 30;
const RECENT_WEIGHT = 0.15; // a topic or grammar point used in the last 30 days is ~7× less likely
const WEAK_POINT_CHANCE = 0.3; // how often the grammar comes from the learner's own mistakes

interface Brief {
  topic: string;
  grammar: string;
  type: string;
  politeness: string;
  length: string;
}

function makeBrief(rand: () => number): Brief {
  const since = Date.now() - RECENT_DAYS * 86_400_000;
  const recent = db.prepare("SELECT topic, grammar FROM challenges WHERE at >= ?").all(since) as { topic: string; grammar: string }[];
  const usedTopics = new Set(recent.map((r) => r.topic));
  const usedGrammar = new Set(recent.map((r) => r.grammar));
  const fresh = (used: Set<string>) => (x: string) => (used.has(x) ? RECENT_WEIGHT : 1);

  const weak = records.weakPoints(8, 60);
  const grammar =
    weak.length && rand() < WEAK_POINT_CHANCE
      ? pickWeighted(rand, weak, (w) => w.n * (usedGrammar.has(w.point) ? RECENT_WEIGHT : 1)).point
      : pickWeighted(rand, GRAMMAR, fresh(usedGrammar));
  return {
    topic: pickWeighted(rand, TOPICS, fresh(usedTopics)),
    grammar,
    type: pickWeighted(rand, TYPES, () => 1),
    politeness: pickWeighted(rand, POLITENESS, () => 1),
    length: pickWeighted(rand, LENGTHS, () => 1),
  };
}

// ── writing a challenge ─────────────────────────────────────────────────────

const KANA = /[぀-ヿ]/;

/** Character-bigram overlap (Jaccard), to catch a new sentence that is nearly a past one. */
function similarity(a: string, b: string): number {
  const grams = (s: string) => {
    const t = s.replace(/[\s。、！？!?,.]/g, "");
    return new Set(Array.from({ length: Math.max(0, t.length - 1) }, (_, i) => t.slice(i, i + 2)));
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const g of A) if (B.has(g)) both++;
  return both / (A.size + B.size - both);
}
const TOO_SIMILAR = 0.5;
const MAX_TRIES = 4;

const sentenceSchema = {
  type: "object",
  properties: {
    ja: { type: "string", maxLength: 60 },
    zh: { type: "string", maxLength: 60 },
  },
  required: ["ja", "zh"],
};

async function writeSentence(b: Brief, seed: number) {
  const { data } = await chatJson<{ ja: string; zh: string }>(
    [
      {
        role: "system",
        content: `You write translation exercises for a JLPT ${config.level} learner of Japanese whose first language is Chinese.
First write one Japanese sentence that fits the brief. Then translate it into Simplified Chinese.
- ja: natural Japanese a native speaker would say, at JLPT ${config.level} level. Use the grammar point naturally, as the heart of the sentence. Write it with normal kanji and kana. No romaji, no readings in brackets.
- zh: natural mainland Simplified Chinese with the same meaning, the way a Chinese speaker would say it — not a word-for-word copy of the Japanese. No Japanese kana, no notes.
- One sentence only. Everyday life; no real people's names.`,
      },
      {
        role: "user",
        content: `Brief:\n- topic: ${b.topic}\n- grammar point: ${b.grammar}\n- kind of sentence: ${b.type}\n- style: ${b.politeness}\n- length: ${b.length}`,
      },
    ],
    sentenceSchema,
    // Enough freedom to vary the wording; the brief does most of the varying.
    { temperature: 0.9, topK: 40, topP: 0.95, minP: 0.05, seed, maxTokens: 200 },
  );
  return { ja: data.ja.trim(), zh: data.zh.trim() };
}

async function create(kind: "daily" | "extra", day: string, baseSeed: number): Promise<Challenge> {
  const past = (db.prepare("SELECT ja FROM challenges ORDER BY at DESC LIMIT 100").all() as { ja: string }[]).map((r) => r.ja);
  let lastErr: unknown;
  for (let i = 0; i < MAX_TRIES; i++) {
    const seed = hash(`${baseSeed}:${i}`) & 0x7fffffff;
    const brief = makeBrief(rng(seed));
    try {
      const s = await writeSentence(brief, seed);
      if (!s.ja || !s.zh || !KANA.test(s.ja) || KANA.test(s.zh)) throw new Error(`bad sentence: ${s.ja} / ${s.zh}`);
      if (past.some((p) => similarity(p, s.ja) >= TOO_SIMILAR)) throw new Error(`too close to a past challenge: ${s.ja}`);
      const style = `${brief.type}; ${brief.politeness}; ${brief.length}`;
      const { lastInsertRowid } = db
        .prepare("INSERT INTO challenges (at, day, kind, seed, topic, grammar, style, zh, ja) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(Date.now(), day, kind, seed, brief.topic, brief.grammar, style, s.zh, s.ja);
      return { id: Number(lastInsertRowid), kind, day, zh: s.zh, topic: brief.topic, grammar: brief.grammar };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`couldn't write a challenge: ${(lastErr as Error)?.message ?? "unknown error"}`);
}

interface Row {
  id: number;
  kind: "daily" | "extra";
  day: string;
  zh: string;
  ja: string;
  topic: string;
  grammar: string;
}
const toChallenge = ({ id, kind, day, zh, topic, grammar }: Row): Challenge => ({ id, kind, day, zh, topic, grammar });

const inFlight = new Map<string, Promise<Challenge>>();

/** Today's daily challenge: made once (seeded by the date), then read back from the database. */
export function ensureDaily(day = localDay()): Promise<Challenge> {
  const row = db.prepare("SELECT * FROM challenges WHERE day = ? AND kind = 'daily'").get(day) as Row | undefined;
  if (row) return Promise.resolve(toChallenge(row));
  let p = inFlight.get(day);
  if (!p) {
    p = create("daily", day, hash(`daily:${day}`)).finally(() => inFlight.delete(day));
    inFlight.set(day, p);
  }
  return p;
}

/** The card's challenge: the latest one made today (an on-demand one replaces the daily on the card). */
export async function current(): Promise<ChallengeState> {
  const day = localDay();
  await ensureDaily(day);
  const row = db.prepare("SELECT * FROM challenges WHERE day = ? ORDER BY at DESC, id DESC LIMIT 1").get(day) as unknown as Row;
  return { challenge: toChallenge(row), last: lastResult(row.id) };
}

/** A fresh on-demand challenge with a random seed. */
export async function fresh(): Promise<ChallengeState> {
  const c = await create("extra", localDay(), randomInt(2 ** 31));
  return { challenge: c, last: null };
}

function lastResult(id: number): ChallengeResult | null {
  const row = db.prepare("SELECT result FROM challenge_attempts WHERE challenge_id = ? ORDER BY at DESC LIMIT 1").get(id) as
    | { result: string }
    | undefined;
  return row ? (JSON.parse(row.result) as ChallengeResult) : null;
}

// ── scoring ─────────────────────────────────────────────────────────────────

const KINDS = ["meaning", "omission", "particle", "conjugation", "tense", "vocabulary", "word_order", "politeness", "other"] as const;
/** Mistakes in how the Japanese is built — these go into the learning record. Meaning slips are about this one sentence. */
const GRAMMAR_KINDS = new Set<string>(["particle", "conjugation", "tense", "vocabulary", "word_order", "politeness", "other"]);

interface RawScore {
  source_meaning: string;
  answer_meaning: string;
  mistakes: { original: string; fix: string; type: (typeof KINDS)[number]; grammar_point: string; explanation: string }[];
  corrected: string;
  meaning_score: number;
  grammar_score: number;
  naturalness_score: number;
  comment: string;
}

// Field order matters: llama.cpp writes fields in schema order, so both meanings are worked out
// before any mistake is named, and the mistakes before any score.
const scoreSchema = {
  type: "object",
  properties: {
    source_meaning: { type: "string" },
    answer_meaning: { type: "string" },
    mistakes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          original: { type: "string" },
          fix: { type: "string" },
          type: { enum: KINDS },
          grammar_point: { type: "string" },
          explanation: { type: "string" },
        },
        required: ["original", "fix", "type", "grammar_point", "explanation"],
      },
    },
    corrected: { type: "string" },
    meaning_score: { type: "integer", minimum: 0, maximum: 50 },
    grammar_score: { type: "integer", minimum: 0, maximum: 30 },
    naturalness_score: { type: "integer", minimum: 0, maximum: 20 },
    comment: { type: "string", maxLength: 240 },
  },
  required: ["source_meaning", "answer_meaning", "mistakes", "corrected", "meaning_score", "grammar_score", "naturalness_score", "comment"],
};

const graderPrompt = `You grade a Chinese → Japanese translation by a JLPT ${config.level} learner whose first language is Chinese. Be fair and consistent: the same answer must always get the same score.

Work in this order — the output fields follow it.

1. source_meaning — what the Chinese sentence means, in one plain English sentence.
2. answer_meaning — what the learner's Japanese actually says, in one plain English sentence. Read it as written; do not mentally fix it.
3. mistakes — each real problem in the learner's Japanese:
   - original: the wrong part, exactly as written; fix: the corrected part, keeping the learner's other words.
   - type: "meaning" if it says something different from the Chinese, "omission" if part of the Chinese meaning is missing, otherwise the kind of grammar or vocabulary error.
   - grammar_point: 2–6 words. explanation: one sentence, max 20 words, simple English, agreeing with the fix.
   An empty list is right for a good translation.
4. corrected — the learner's sentence with only those fixes applied. If there are no mistakes, repeat it unchanged.
5. Scores, judged from the mistakes you listed:
   - meaning_score (0–50): 50 = says everything the Chinese says; 35 = one small detail lost or changed; 20 = the main idea survives but important parts are wrong or missing; 0–10 = a different meaning.
   - grammar_score (0–30): 30 = no grammar or vocabulary errors; take off about 5–8 per error, more for errors that block understanding.
   - naturalness_score (0–20): 20 = a native would say it this way; 12 = understandable but stiff or textbook-like; 5 = clearly foreign.
6. comment — one or two short sentences in English: what went well, and the one thing to work on next.

The reference is one good translation, not the only one. Any answer with the same meaning and correct, natural Japanese deserves full marks, even if it uses different words or grammar.
Not mistakes: kana instead of kanji (or the reverse), casual vs polite style (Chinese doesn't mark it), dropped pronouns or subjects that Japanese normally leaves out, punctuation.`;

export async function grade(id: number, answer: string): Promise<ChallengeResult> {
  answer = answer.trim();
  const row = db.prepare("SELECT * FROM challenges WHERE id = ?").get(id) as Row | undefined;
  if (!row) throw Object.assign(new Error("no such challenge"), { statusCode: 404 });
  if (!answer) throw Object.assign(new Error("answer is required"), { statusCode: 400 });

  const { data: raw } = await chatJson<RawScore>(
    [
      { role: "system", content: graderPrompt },
      { role: "user", content: `Chinese:\n${row.zh}\n\nReference Japanese:\n${row.ja}\n\nLearner's Japanese:\n${answer}` },
    ],
    scoreSchema,
    { temperature: 0.1, seed: 0, maxTokens: 700 },
  );

  const clamp = (n: number, max: number) => Math.max(0, Math.min(max, Math.round(Number(n) || 0)));
  const mistakes = raw.mistakes.filter((m) => m.original.trim() && m.original !== m.fix);
  const result: ChallengeResult = {
    answer,
    meaning: clamp(raw.meaning_score, 50),
    grammar: clamp(raw.grammar_score, 30),
    naturalness: clamp(raw.naturalness_score, 20),
    total: 0,
    corrected: mistakes.length ? raw.corrected.trim() || answer : answer,
    mistakes,
    comment: raw.comment.trim(),
    reference: row.ja,
  };
  result.total = result.meaning + result.grammar + result.naturalness;

  const at = Date.now();
  db.prepare("INSERT INTO challenge_attempts (challenge_id, at, day, answer, total, result) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    at,
    localDay(at),
    answer,
    result.total,
    JSON.stringify(result),
  );

  // Grammar mistakes join the learning record (review list, vault, future weak-point challenges),
  // and a translated sentence counts as practice, so it feeds the cat like a spoken one.
  const grammarMistakes = mistakes.filter((m) => GRAMMAR_KINDS.has(m.type)) as Mistake[];
  records.logTurn(answer, { is_correct: grammarMistakes.length === 0, corrected: result.corrected, mistakes: grammarMistakes, natural: "" });
  pet.recordPractice(answer, grammarMistakes.length === 0, grammarMistakes.length);
  return result;
}
