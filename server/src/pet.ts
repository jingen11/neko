import type { Anim, Mood, PetStats } from "../../shared/protocol.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";

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
  CREATE TABLE IF NOT EXISTS practice (
    at INTEGER NOT NULL,
    day TEXT NOT NULL,
    text TEXT NOT NULL,
    correct INTEGER NOT NULL,
    mistakes INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS practice_day ON practice(day);
  INSERT OR IGNORE INTO pet (id, hunger, happiness, updated_at) VALUES (1, 30, 70, ${Date.now()});
`);

const clamp = (n: number) => Math.max(0, Math.min(100, n));
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: config.tz, year: "numeric", month: "2-digit", day: "2-digit" });
const hourFmt = new Intl.DateTimeFormat("en-GB", { timeZone: config.tz, hour: "2-digit", hourCycle: "h23" });
export const localDay = (t = Date.now()) => dayFmt.format(t); // YYYY-MM-DD
const localHour = (t = Date.now()) => Number(hourFmt.format(t));

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
  const days = (db.prepare("SELECT DISTINCT day FROM practice ORDER BY day DESC LIMIT 400").all() as { day: string }[]).map((r) => r.day);
  if (!days.length) return 0;
  const oneDay = 86_400_000;
  // The streak is alive if you practised today or yesterday.
  let cursor = Date.now();
  if (days[0] !== localDay(cursor)) {
    cursor -= oneDay;
    if (days[0] !== localDay(cursor)) return 0;
  }
  let n = 0;
  for (const d of days) {
    if (d !== localDay(cursor)) break;
    n++;
    cursor -= oneDay;
  }
  return n;
}

export function stats(): PetStats {
  const r = load();
  const today = db.prepare("SELECT COUNT(*) AS n FROM practice WHERE day = ?").get(localDay()) as { n: number };
  return {
    name: config.petName,
    hunger: Math.round(r.hunger),
    happiness: Math.round(r.happiness),
    streak: streak(),
    practicedToday: today.n,
    level: config.level,
  };
}

export const isBedtime = (t = Date.now()) => {
  const h = localHour(t);
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
  const h = localHour(t);
  return h === (BEDTIME.from + 23) % 24 || h === BEDTIME.to;
};

export function restingAnim(mood: Mood, s = stats()): Anim {
  if (mood === "sleepy") return "sleep";
  if (s.hunger >= 90) return "sick";
  if (isDrowsy()) return "sleepy";
  if (mood === "hungry" || mood === "sad") return "sad";
  return "idle";
}

/** A practice turn feeds the pet. */
export function recordPractice(text: string, correct: boolean, mistakes: number) {
  const r = load();
  r.hunger = clamp(r.hunger - FEED_PER_TURN);
  r.happiness = clamp(r.happiness + JOY_PER_TURN + (correct ? JOY_CORRECT_BONUS : 0));
  save(r);
  const now = Date.now();
  db.prepare("INSERT INTO practice (at, day, text, correct, mistakes) VALUES (?, ?, ?, ?, ?)").run(now, localDay(now), text, correct ? 1 : 0, mistakes);
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
export function greeting(mood: Mood, s: PetStats): string {
  switch (mood) {
    case "sleepy":
      return "ふわぁ…ねむいよ。あしたまた話そうね。";
    case "hungry":
      return "おなかがすいたよ…。日本語で話して、ごはんをちょうだい！";
    case "sad":
      return "さびしかったよ…。いっしょに話そう？";
    default:
      return s.practicedToday > 0 ? "おかえり！また話そう！" : "こんにちは！今日も日本語で話そう！";
  }
}

export const greetingEn: Record<string, string> = {
  "ふわぁ…ねむいよ。あしたまた話そうね。": "Yawn… I'm sleepy. Let's talk again tomorrow.",
  "おなかがすいたよ…。日本語で話して、ごはんをちょうだい！": "I'm hungry… Talk to me in Japanese and feed me!",
  "さびしかったよ…。いっしょに話そう？": "I was lonely… Shall we talk?",
  "おかえり！また話そう！": "Welcome back! Let's talk again!",
  "こんにちは！今日も日本語で話そう！": "Hello! Let's speak Japanese today too!",
};
