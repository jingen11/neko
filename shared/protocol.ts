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
 *   ← say {ja, en, mood} → audio_start → [binary voice frames] → audio_end
 *   ← correction {...}                  (usually arrives a little after the pet starts talking)
 *   ← state {...}                       (stats updated: practising feeds the pet)
 *
 * Grammar question (answered by Hermes from the learner's vault record, or by the local model):
 *   ask {text}  →  ← state {anim:"think"}  →  ← answer {question, text, source}
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

/** A grammar question, in English or Japanese. */
export interface Ask {
  type: "ask";
  text: string;
}

export type ClientMessage = Hello | ListenStart | ListenEnd | Confirm | Touch | Repeat | Reveal | Ask;

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
  en: string;
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

export interface AnswerMsg {
  type: "answer";
  question: string;
  text: string; // plain text with light markdown (**bold**, "- " lists)
  source: "hermes" | "local"; // local = Hermes unavailable, answered by the pet's own model
  ms: number;
}

export interface ErrorMsg {
  type: "error";
  message: string;
}

export type ServerMessage = State | Heard | Say | AudioStart | AudioEnd | CorrectionMsg | AnswerMsg | ErrorMsg;
