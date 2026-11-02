import { config } from "./config.ts";
import { chatJson, type ChatMessage } from "./llm.ts";

/** Who is talking to whom — both prompts need this to read giving/receiving verbs and "you" correctly. */
export const SCENE = `Scene: a conversation between exactly two parties, who never change.
- Every user message is always the learner: the owner of a pet cat named ねこ, speaking directly to the cat. The learner feeds, pets and cares for ねこ.
- Every assistant message is always ねこ, the cat, played by the model. ねこ speaks only to the learner.
No one else speaks, though the learner may talk about other people.`;

// ── Grammar correction ──────────────────────────────────────────────────────

export interface Mistake {
  type:
    | "particle"
    | "conjugation"
    | "tense"
    | "vocabulary"
    | "word_order"
    | "politeness"
    | "other";
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

// ── Pet reply ───────────────────────────────────────────────────────────────

export interface PetReply {
  ja: string; // what the pet says, in Japanese
  en: string; // English translation (hidden by default for listening practice)
  mood: "happy" | "curious" | "sleepy" | "excited" | "worried";
}

/**
 * ねこ replies and checks the owner's Japanese in one answer: the line ねこ speaks and the check come
 * from the same understanding of the message. (A separate teacher, and then a separate low-temperature
 * check call, both kept "correcting" sentences ねこ had understood fine.) Field order matters:
 * llama.cpp writes fields in schema order, so ねこ replies first and then judges the message the way
 * it just understood it.
 */
interface RawTurn extends PetReply {
  mistakes: (Mistake & { keeps_meaning: boolean })[];
  corrected: string;
  natural: string;
}

const KINDS = ["particle", "conjugation", "tense", "vocabulary", "word_order", "politeness", "other"];

const turnSchema = {
  type: "object",
  properties: {
    // Length caps make the grammar close the string, so a rambling reply can't overrun max_tokens and truncate the JSON.
    ja: { type: "string", maxLength: 80 },
    en: { type: "string", maxLength: 200 },
    mood: { enum: ["happy", "curious", "sleepy", "excited", "worried"] },
    mistakes: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          original: { type: "string", maxLength: 60 },
          fix: { type: "string", maxLength: 60 },
          keeps_meaning: { type: "boolean" },
          type: { enum: KINDS },
          grammar_point: { type: "string", maxLength: 60 },
          explanation: { type: "string", maxLength: 200 },
        },
        required: ["original", "fix", "keeps_meaning", "type", "grammar_point", "explanation"],
      },
    },
    corrected: { type: "string", maxLength: 200 },
    natural: { type: "string", maxLength: 200 },
  },
  required: ["ja", "en", "mood", "mistakes", "corrected", "natural"],
};

const petPrompt = () => `You are ねこ, a small cheerful cat who lives in a box and is the user's Japanese conversation buddy.
${SCENE}
- You are ねこ. Every user message is your owner talking to you. When they give, buy, make or do something for you (〜てあげる, あげる), it is for you: react as the cat receiving it.
- Speak only natural Japanese at JLPT ${config.level} level: ${config.level} vocabulary and grammar, at most one slightly harder word.
- Keep each reply short: 1–2 short sentences, then a simple question to keep the conversation going.
- "ja" is only ねこ's own spoken words, said once: no speaker names, no quotation marks, no line breaks, no repeats.
- "en" is a brief, plain English translation of "ja".
- Use polite です/ます form unless the user speaks casually.
- Stay in character in "ja" and "en": never talk about grammar or mistakes there.

Your owner is a JLPT ${config.level} learner, and their messages come from speech recognition. After replying, you also quietly check their latest message, in the fields after "mood". The owner sees this check as a small note under their message.
- Judge the message exactly as you understood it when you replied. If what they said made sense to you, the words already carried their meaning; do not change who does what for whom.
- Flag only real grammar or vocabulary mistakes. Not mistakes: punctuation, kana vs kanji, casual speech or mixed casual/polite, particles natives drop in speech, style preferences. Most messages have no mistakes, and an empty list is the normal answer.
- mistakes: each real mistake. original: the wrong part as said; fix: the corrected part; keeps_meaning: true only if the fixed message still means what you understood and your reply still fits it; type; grammar_point: a short English name, 2–6 words; explanation: one sentence, max 20 words, simple English.
- corrected: the whole message with only those fixes, keeping the owner's words (unchanged if there are none).
- natural: how a native would say it, only if quite different; otherwise "".`;

const messages = (history: ChatMessage[]): ChatMessage[] => [{ role: "system", content: petPrompt() }, ...history.slice(-13)];

/** ねこ's spoken reply and its check of the owner's latest message, from one answer. */
export async function petTurn(history: ChatMessage[]): Promise<{ reply: PetReply; correction: Correction; ms: number }> {
  const said = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  const { data: raw, ms } = await chatJson<RawTurn>(messages(history), turnSchema, { temperature: 0.7 });

  // A "fix" that changes what the owner meant, or changes nothing, is not a correction; drop it.
  const mistakes: Mistake[] = raw.mistakes
    .filter((m) => m.keeps_meaning && m.original.trim() && m.original !== m.fix)
    .map(({ keeps_meaning: _, ...m }) => m);
  const is_correct = mistakes.length === 0;
  const dropped = mistakes.length < raw.mistakes.length;
  // If a fix was dropped, the model's own "corrected"/"natural" may still contain it: rebuild from the kept fixes.
  const corrected = is_correct
    ? said
    : dropped
      ? mistakes.reduce((s, m) => s.replace(m.original, m.fix), said)
      : raw.corrected;
  const natural = dropped ? "" : raw.natural;
  return { reply: { ja: raw.ja, en: raw.en, mood: raw.mood }, correction: { is_correct, corrected, mistakes, natural }, ms };
}
