/**
 * neko WebSocket protocol — shared by the server, the web app and (mirrored in C) the ESP32 board.
 *
 * One WebSocket per client at /ws.
 *  - Text frames: JSON messages below.
 *  - Binary frames: audio, 16-bit little-endian mono PCM.
 *      client → server: microphone audio between `listen_start` and `listen_end` (rate given in listen_start)
 *      server → client: the pet's voice between `audio_start` and `audio_end` (rate given in audio_start,
 *                       chosen from the client's `hello.audioRate`)
 *
 * Turn flow:
 *   listen_start → [binary mic frames] → listen_end
 *   ← heard {text}                      (speech-to-text result)
 *   confirm {text}                      (browser: after the user checks/edits it; board: immediately)
 *   ← state {anim:"think"}
 *   ← correction {...}                  (ねこ's own check of the sentence, from the same answer as its reply)
 *   ← say {ja, en, mood} → audio_start → [binary voice frames] → audio_end
 *   ← state {...}                       (stats updated: practising feeds the pet)
 *
 * Questions to Hermes, which reads the learner's vault (or the local model, if Hermes is down):
 *   ask_grammar {text}  →  ← state {anim:"think"}  →  ← answer {...}   Hermes on Claude
 *   ask_casual  {text}  →  ← state {anim:"think"}  →  ← answer {...}   Hermes on its local model (chat, "what have I learnt?")
 *
 * Every turn, correction, listening miss (repeat / reveal) and question is written to the vault.
 */

// ── client → server ──────────────────────────────────────────────────────────

export interface Hello {
  type: "hello";
  client: "web" | "board";
  deviceId: string;
  /** Sample rate the client wants the pet's voice in (web: 24000, board: 16000). */
  audioRate: number;
  token?: string; // required later for away-from-home board connections
  fw?: string;
}

export interface ListenStart {
  type: "listen_start";
  rate: number; // sample rate of the binary mic frames that follow
}

export interface ListenEnd {
  type: "listen_end";
}

/** Send text for the pet to respond to (confirmed transcript, or typed text). */
export interface Confirm {
  type: "confirm";
  text: string;
}

export interface Touch {
  type: "touch";
  gesture: "pet" | "tap" | "poke";
}

/** Ask the pet to repeat its last line, optionally slowly. */
export interface Repeat {
  type: "repeat";
  slow?: boolean;
}

/** The learner looked at the English of a pet line (recorded as a listening miss). */
export interface Reveal {
  type: "reveal";
  sayId: string;
}

/** A grammar question, in any language. Hermes answers it on Claude. */
export interface AskGrammar {
  type: "ask_grammar";
  text: string;
}

/** Anything else for Hermes: chat, or questions about your own progress. Hermes answers it on its local model. */
export interface AskCasual {
  type: "ask_casual";
  text: string;
}

export type ClientMessage = Hello | ListenStart | ListenEnd | Confirm | Touch | Repeat | Reveal | AskGrammar | AskCasual;

// ── server → client ──────────────────────────────────────────────────────────

export type Anim =
  | "idle" | "listen" | "think" | "talk" | "happy" | "sad" | "eat" | "sleep" | "petted"
  | "sleepy" // drowsy hour before bedtime and after waking (yawns now and then)
  | "sick" // starving
  | "angry"; // woken up by petting at night
export type Mood = "happy" | "curious" | "sleepy" | "excited" | "worried" | "hungry" | "sad";

export interface PetStats {
  name: string;
  hunger: number; // 0 = full, 100 = starving
  happiness: number; // 0..100
  streak: number; // consecutive days practised (including today if practised)
  practicedToday: number; // turns today
  level: string; // JLPT level the pet speaks at
}

export interface State {
  type: "state";
  anim: Anim;
  mood: Mood;
  stats: PetStats;
}

export interface Heard {
  type: "heard";
  text: string;
  ms: number;
}

export interface Say {
  type: "say";
  id: string;
  ja: string;
  en: string; // "" when ねこ answered in plain Japanese without a translation
  mood: Mood;
}

export interface AudioStart {
  type: "audio_start";
  sayId: string;
  rate: number;
}

export interface AudioEnd {
  type: "audio_end";
  sayId: string;
}

export interface CorrectionMistake {
  type: string;
  original: string;
  fix: string;
  grammar_point: string;
  explanation: string;
}

export interface CorrectionMsg {
  type: "correction";
  text: string; // what the learner said
  is_correct: boolean;
  corrected: string;
  mistakes: CorrectionMistake[];
  natural: string;
}

/** The answer to an ask_grammar or ask_casual question. */
export interface AnswerMsg {
  type: "answer";
  kind: "grammar" | "casual";
  question: string;
  text: string; // plain text with light markdown (**bold**, "- " lists)
  model: string; // the Hermes profile's model, e.g. "Claude Opus 5.5" or "Qwen3.6"
  ms: number;
}

export interface ErrorMsg {
  type: "error";
  message: string;
}

/** Home sensor events (through Zigbee2MQTT). */
export type SensorEvent = "front_door_open" | "front_window_1_vibrate";

/** A home sensor fired. ねこ also says a line about it (a normal "say"). */
export interface SensorMsg {
  type: "sensor";
  event: SensorEvent;
  device: string; // the Zigbee2MQTT device
  label: string; // e.g. "Front door opened"
  at: number; // ms since epoch
}

export type ServerMessage = State | Heard | Say | AudioStart | AudioEnd | CorrectionMsg | AnswerMsg | ErrorMsg | SensorMsg;

// ── translation challenge (HTTP, not the WebSocket) ──────────────────────────
//   GET  /api/challenge              → ChallengeState   today's current challenge (the daily one is made on first request)
//   POST /api/challenge/new          → ChallengeState   a fresh on-demand challenge
//   POST /api/challenge/:id/answer   {text} → ChallengeResult

export interface Challenge {
  id: number;
  kind: "daily" | "extra";
  day: string; // YYYY-MM-DD in the learner's time zone
  zh: string; // the sentence to translate, Simplified Chinese
  topic: string;
  grammar: string; // the grammar point the reference answer uses (shown as a hint)
}

export interface ChallengeResult {
  answer: string;
  total: number; // 0..100 = meaning + grammar + naturalness
  meaning: number; // 0..50
  grammar: number; // 0..30
  naturalness: number; // 0..20
  corrected: string; // the learner's answer with the fixes applied
  mistakes: (CorrectionMistake & { type: string })[];
  comment: string;
  reference: string; // one good Japanese translation (revealed after an attempt)
}

export interface ChallengeState {
  challenge: Challenge;
}

// ── review (HTTP) ────────────────────────────────────────────────────────────
// The Review panel only knows this visit: the page collects its own mistakes. To look further back,
// open the notes or ask Hermes.
//   POST /api/review/practice        ReviewAttempt → ReviewResult   ねこ checks your fix of an earlier sentence
//   GET  /api/notes                  → NoteFile[]                   the vault's markdown files, newest first
//   GET  /api/notes/file?path=       → text/markdown                one note, as written

export interface ReviewAttempt {
  point: string;
  said: string; // the sentence with the mistake
  original: string; // the wrong part
  fix: string;
  answer: string; // your corrected sentence
}

export interface ReviewResult {
  ok: boolean;
  answer: string;
  mistakes: CorrectionMistake[]; // what ねこ found in your answer
  still: boolean; // the old mistake is still in your answer
}

export interface NoteFile {
  path: string; // relative to the vault folder, e.g. "Daily/2026-11-02.md"
  mtime: number;
  size: number;
}
