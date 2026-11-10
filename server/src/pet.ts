import type { Anim, Mood, PetStats } from "../../shared/protocol.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { learnerTimeZone } from "./location.ts";

/**
 * The pet's persistent state. Stats change with time (computed lazily from timestamps):
 * it gets hungrier and a little less happy every hour, and practising Japanese feeds it.
 */
const HUNGER_PER_HOUR = 4; // full → starving in ~25 h
const HAPPINESS_LOSS_PER_HOUR = 2;
const FEED_PER_TURN = 15;
const JOY_PER_TURN = 5;
const JOY_CORRECT_BONUS = 3;
const JOY_PER_PET = 3;
const PET_COOLDOWN_MS = 10_000;
const BEDTIME = { from: 23, to: 7 }; // local hours

db.exec(`
  CREATE TABLE IF NOT EXISTS pet (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    hunger REAL NOT NULL,
    happiness REAL NOT NULL,
    updated_at INTEGER NOT NULL
  );
  -- how many sentences you practised each day: enough for the streak and today's count.
  -- What you said lives only in the vault.
  CREATE TABLE IF NOT EXISTS practice_days (
    day TEXT PRIMARY KEY,
    n INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO pet (id, hunger, happiness, updated_at) VALUES (1, 30, 70, ${Date.now()});
`);

// Older versions kept every sentence in a "practice" table: keep its counts per day, drop the text.
if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'practice'").get()) {
  db.exec(`
    BEGIN;
    INSERT INTO practice_days (day, n) SELECT day, COUNT(*) FROM practice GROUP BY day
      ON CONFLICT(day) DO UPDATE SET n = n + excluded.n;
    DROP TABLE practice;
    COMMIT;
  `);
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));
// Two clocks (docs/ARCHITECTURE.md, "Travelling"):
// - "today" (the streak, practice per day, the daily challenge, the vault notes) is on the box's own zone,
//   so travelling can't repeat or skip a day;
// - the hour for what ねこ does (bedtime, drowsy hour, greetings) is the learner's, which follows the board.
const boxZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const boxDayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: boxZone, year: "numeric", month: "2-digit", day: "2-digit" });
const hourFmt = (zone: string) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hourCycle: "h23" });
export const boxDay = (t = Date.now()) => boxDayFmt.format(t); // YYYY-MM-DD
const learnerHour = (t = Date.now()) => Number(hourFmt(learnerTimeZone()).format(t));

interface Row {
  hunger: number;
  happiness: number;
  updated_at: number;
}

/** Load the pet with time-based decay applied, and save it back. */
function load(): Row {
  const row = db.prepare("SELECT hunger, happiness, updated_at FROM pet WHERE id = 1").get() as unknown as Row;
  const now = Date.now();
  const hours = (now - row.updated_at) / 3_600_000;
  const next = {
    hunger: clamp(row.hunger + hours * HUNGER_PER_HOUR),
    happiness: clamp(row.happiness - hours * HAPPINESS_LOSS_PER_HOUR),
    updated_at: now,
  };
  save(next);
  return next;
}

function save(r: Row) {
  db.prepare("UPDATE pet SET hunger = ?, happiness = ?, updated_at = ? WHERE id = 1").run(r.hunger, r.happiness, r.updated_at);
}

function streak(): number {
  const days = (db.prepare("SELECT day FROM practice_days WHERE n > 0 ORDER BY day DESC LIMIT 400").all() as { day: string }[]).map((r) => r.day);
  if (!days.length) return 0;
  const oneDay = 86_400_000;
  // The streak is alive if you practised today or yesterday.
  let cursor = Date.now();
  if (days[0] !== boxDay(cursor)) {
    cursor -= oneDay;
    if (days[0] !== boxDay(cursor)) return 0;
  }
  let n = 0;
  for (const d of days) {
    if (d !== boxDay(cursor)) break;
    n++;
    cursor -= oneDay;
  }
  return n;
}

export function stats(): PetStats {
  const r = load();
  const today = db.prepare("SELECT n FROM practice_days WHERE day = ?").get(boxDay()) as { n: number } | undefined;
  return {
    name: config.petName,
    hunger: Math.round(r.hunger),
    happiness: Math.round(r.happiness),
    streak: streak(),
    practicedToday: today?.n ?? 0,
    level: config.level,
  };
}

export const isBedtime = (t = Date.now()) => {
  const h = learnerHour(t);
  return h >= BEDTIME.from || h < BEDTIME.to;
};

/** The pet's mood when nothing is happening. */
export function restingMood(s = stats()): Mood {
  if (isBedtime()) return "sleepy";
  if (s.hunger >= 70) return "hungry";
  if (s.happiness < 30) return "sad";
  return "happy";
}

/** Drowsy hour on each side of bedtime. */
export const isDrowsy = (t = Date.now()) => {
  const h = learnerHour(t);
  return h === (BEDTIME.from + 23) % 24 || h === BEDTIME.to;
};

export function restingAnim(mood: Mood, s = stats()): Anim {
  if (mood === "sleepy") return "sleep";
  if (s.hunger >= 90) return "sick";
  if (isDrowsy()) return "sleepy";
  if (mood === "hungry" || mood === "sad") return "sad";
  return "idle";
}

/** A practice turn feeds the pet, and counts towards today. */
export function recordPractice(correct: boolean) {
  const r = load();
  r.hunger = clamp(r.hunger - FEED_PER_TURN);
  r.happiness = clamp(r.happiness + JOY_PER_TURN + (correct ? JOY_CORRECT_BONUS : 0));
  save(r);
  db.prepare("INSERT INTO practice_days (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1").run(boxDay());
}

let lastPetAt = 0;
/** Petting makes it happier (with a cooldown so it can't be farmed). Returns false while on cooldown. */
export function petted(): boolean {
  const now = Date.now();
  if (now - lastPetAt < PET_COOLDOWN_MS) return false;
  lastPetAt = now;
  const r = load();
  r.happiness = clamp(r.happiness + JOY_PER_PET);
  save(r);
  return true;
}

/** Fixed greetings (no LLM call, so they're instant). */
export function greeting(mood: Mood, s: PetStats, t = Date.now()): string {
  switch (mood) {
    case "sleepy":
      return "ふわぁ…ねむいよ。あしたまた話そうね。";
    case "hungry":
      return "おなかがすいたよ…。日本語で話して、ごはんをちょうだい！";
    case "sad":
      return "さびしかったよ…。いっしょに話そう？";
    default: {
      if (s.practicedToday > 0) return "おかえり！また話そう！";
      // by the learner's hour: bedtime (23:00–07:00) is the sleepy greeting above
      const h = learnerHour(t);
      const hello = h >= 5 && h < 10 ? "おはよう" : h >= 10 && h < 17 ? "こんにちは" : "こんばんは";
      return `${hello}！今日も日本語で話そう！`;
    }
  }
}

export const greetingEn: Record<string, string> = {
  "ふわぁ…ねむいよ。あしたまた話そうね。": "Yawn… I'm sleepy. Let's talk again tomorrow.",
  "おなかがすいたよ…。日本語で話して、ごはんをちょうだい！": "I'm hungry… Talk to me in Japanese and feed me!",
  "さびしかったよ…。いっしょに話そう？": "I was lonely… Shall we talk?",
  "おかえり！また話そう！": "Welcome back! Let's talk again!",
  "おはよう！今日も日本語で話そう！": "Good morning! Let's speak Japanese today too!",
  "こんばんは！今日も日本語で話そう！": "Good evening! Let's speak Japanese today too!",
  "こんにちは！今日も日本語で話そう！": "Hello! Let's speak Japanese today too!",
};
