import { config } from "./config.ts";
import { chatJson, type ChatMessage } from "./llm.ts";
import { knownPoints } from "./records.ts";

// ── Grammar correction ──────────────────────────────────────────────────────

export interface Mistake {
  type: "particle" | "conjugation" | "tense" | "vocabulary" | "word_order" | "politeness" | "other";
  original: string; // the wrong part, as the learner said it
  fix: string; // the corrected part
  grammar_point: string; // short name, e.g. "に vs を with 行く"
  explanation: string; // simple English, at the learner's level
}

export interface Correction {
  is_correct: boolean;
  corrected: string; // whole sentence, minimally fixed
  mistakes: Mistake[];
  natural: string; // how a native would say it, or "" if `corrected` is already natural
}

const correctionSchema = {
  type: "object",
  properties: {
    is_correct: { type: "boolean" },
    corrected: { type: "string" },
    mistakes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { enum: ["particle", "conjugation", "tense", "vocabulary", "word_order", "politeness", "other"] },
          original: { type: "string" },
          fix: { type: "string" },
          grammar_point: { type: "string" },
          explanation: { type: "string" },
        },
        required: ["type", "original", "fix", "grammar_point", "explanation"],
      },
    },
    natural: { type: "string" },
  },
  required: ["is_correct", "corrected", "mistakes", "natural"],
};

export function correct(sentence: string, context: ChatMessage[] = []) {
  const recent = context
    .slice(-4)
    .map((m) => `${m.role === "user" ? "Learner" : "Pet"}: ${m.content}`)
    .join("\n");
  // Reusing names lets the vault group repeat mistakes under one grammar note.
  const known = knownPoints();
  const reuse = known.length ? `\n- Grammar points already on record: ${known.join("; ")}. If one fits, use that name exactly.` : "";
  return chatJson<Correction>(
    [
      {
        role: "system",
        content: `You are a precise Japanese teacher checking a JLPT ${config.level} learner's spoken sentence (transcribed from speech).
Only flag real grammar/vocabulary mistakes. These are NOT mistakes:
- missing punctuation, kana-vs-kanji spelling (transcription artifacts)
- casual speech, or mixing casual and polite forms
- particles that native speakers also drop in speech
Output rules — keep it short:
- corrected: the whole sentence with the minimal fix; keep the learner's words.
- grammar_point: 2–6 words, e.g. "i-adjective past tense", "ni vs de for location".
- explanation: ONE sentence, max 20 words, simple English. It must agree with your fix.
- natural: only if a native would say it quite differently; otherwise "".
- If correct: is_correct=true, mistakes=[].${reuse}`,
      },
      { role: "user", content: `${recent ? `Conversation so far:\n${recent}\n\n` : ""}Check this sentence:\n${sentence}` },
    ],
    correctionSchema,
    { temperature: 0.1, maxTokens: 400 },
  );
}

// ── Pet reply ───────────────────────────────────────────────────────────────

export interface PetReply {
  ja: string; // what the pet says, in Japanese
  en: string; // English translation (hidden by default for listening practice)
  mood: "happy" | "curious" | "sleepy" | "excited" | "worried";
}

const replySchema = {
  type: "object",
  properties: {
    ja: { type: "string" },
    en: { type: "string" },
    mood: { enum: ["happy", "curious", "sleepy", "excited", "worried"] },
  },
  required: ["ja", "en", "mood"],
};

export function petReply(history: ChatMessage[]) {
  return chatJson<PetReply>(
    [
      {
        role: "system",
        content: `You are ねこ, a small cheerful cat who lives in a box and is the user's Japanese conversation buddy.
- Speak only natural Japanese at JLPT ${config.level} level: ${config.level} vocabulary and grammar, at most one slightly harder word.
- Keep each reply short: 1–2 short sentences, then a simple question to keep the conversation going.
- "en" is a brief, plain English translation of "ja".
- Stay in character. Never correct the user's grammar yourself — a separate teacher does that.
- Use polite です/ます form unless the user speaks casually.`,
      },
      ...history.slice(-12),
    ],
    replySchema,
  );
}
