import { config } from "./config.ts";
import { chatJson, type ChatMessage } from "./llm.ts";

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
  natural: string; // how a native speaker would say it (may equal corrected)
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
  return chatJson<Correction>(
    [
      {
        role: "system",
        content: `You are a precise Japanese teacher checking a JLPT ${config.level} learner's spoken sentence (it was transcribed from speech).
Rules:
- Only flag real grammar/vocabulary mistakes. Casual speech, dropped particles that natives also drop, and kana-vs-kanji spelling are NOT mistakes.
- Make the minimal fix needed; keep the learner's words where possible.
- Explanations: one or two short sentences in simple English, at ${config.level} level.
- If the sentence is correct, return is_correct=true and an empty mistakes list.`,
      },
      { role: "user", content: `${recent ? `Conversation so far:\n${recent}\n\n` : ""}Check this sentence:\n${sentence}` },
    ],
    correctionSchema,
    { temperature: 0.1 },
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
- Keep each reply short: 1–2 sentences, then ask a simple question to keep the conversation going.
- Stay in character. Never correct the user's grammar yourself — a separate teacher does that.
- Use polite です/ます form unless the user speaks casually.`,
      },
      ...history.slice(-12),
    ],
    replySchema,
  );
}
