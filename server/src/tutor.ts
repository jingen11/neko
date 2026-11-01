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

/**
 * What the model returns. Field order matters: llama.cpp generates fields in schema order, so the
 * model writes down what the learner means *before* judging it, and checks each fix against that.
 * `is_correct` is not asked for — it is worked out from the mistakes that survive.
 */
export interface RawCorrection {
  meaning: string;
  mistakes: (Mistake & { keeps_meaning: boolean })[];
  corrected: string;
  natural: string;
}

export const correctionSchema = {
  type: "object",
  properties: {
    meaning: { type: "string" },
    mistakes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          original: { type: "string" },
          fix: { type: "string" },
          keeps_meaning: { type: "boolean" },
          type: {
            enum: [
              "particle",
              "conjugation",
              "tense",
              "vocabulary",
              "word_order",
              "politeness",
              "other",
            ],
          },
          grammar_point: { type: "string" },
          explanation: { type: "string" },
        },
        required: [
          "original",
          "fix",
          "keeps_meaning",
          "type",
          "grammar_point",
          "explanation",
        ],
      },
    },
    corrected: { type: "string" },
    natural: { type: "string" },
  },
  required: ["meaning", "mistakes", "corrected", "natural"],
};

export const teacherPrompt =
  () => `You are a Japanese teacher reviewing a transcript after the fact. Your student, a JLPT ${config.level} learner, was speaking Japanese to their pet cat, ねこ. You were not part of the conversation. You are an outside observer checking the student's Japanese.
${SCENE}

## The transcript
You will receive a transcript with two speakers:
- Owner: your student. These lines came from speech recognition, so expect small transcription noise.
- ねこ: the cat. Its lines are context only. Never check or correct them.
The line marked [CHECK] is the only one you review. Earlier lines are there so you understand the situation.

## Step 1: Understand the line before judging it
Read the [CHECK] line the way ねこ would hear it: the owner talking to their cat, right after the previous lines.
- The speaker is always the owner. The listener is always ねこ.
- Japanese often drops 私 and あなた. Fill them in from context:
  - A question to ねこ (e.g. ごはん食べた？) is usually about ねこ.
  - A statement about the owner's own action (e.g. 今日は仕事に行った) is about the owner.
  - If ねこ just asked or said something, the owner's line is most likely a reply to it.
- When a line could be read several ways, pick the most natural reading for an owner talking to their cat in this moment. Never invent a mistake that only exists under an odd reading.

## Step 2: Check the giving/receiving direction
- Owner gives to, or does something for, ねこ: あげる / 〜てあげる (やる / 〜てやる is also fine in casual speech).
- ねこ gives to, or does something for, the owner: くれる / 〜てくれる.
- Owner receives from ねこ: もらう / 〜てもらう.
A giving/receiving verb is wrong only if its direction contradicts the meaning from Step 1.

## Step 3: Find real mistakes
Flag only real grammar or vocabulary mistakes.
These are NOT mistakes: punctuation, kana vs kanji, casual speech, mixed casual/polite, particles natives drop in speech, word-order or style preferences, likely speech-recognition noise.

## Output, in this order
- meaning: one plain English sentence describing what the owner is saying to ねこ (who does what for whom).
- mistakes: each real mistake, with:
  - original: the wrong part, as said
  - fix: the corrected part
  - keeps_meaning: true only if the fixed sentence still means exactly your "meaning" (same people, same action, same direction)
  - type
  - grammar_point: 2–6 words
  - explanation: one sentence, max 20 words, simple English
  An empty list is normal for a fine sentence.
- corrected: the whole [CHECK] line with only those fixes, keeping the student's words (unchanged if there are no mistakes).
- natural: how a native would say it to their cat, only if quite different; otherwise "".`;

type Turn = { role: "user" | "assistant"; content: string };

const MAX_CONTEXT = 12;

function buildTranscript(sentence: string, context: ChatMessage[]): string {
  const lines = context
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-MAX_CONTEXT)
    .map((m) => `${m.role === "user" ? "Owner" : "ねこ"}: ${m.content}`);

  lines.push(`Owner [CHECK]: ${sentence}`);

  return `<transcript>\n${lines.join("\n")}\n</transcript>\n\nReview the [CHECK] line.`;
}

export async function correct(
  sentence: string,
  context: ChatMessage[] = [],
): Promise<{ data: Correction; ms: number }> {
  const { data: raw, ms } = await chatJson<RawCorrection>(
    [
      { role: "system", content: teacherPrompt() },
      { role: "user", content: buildTranscript(sentence, context) },
    ],
    correctionSchema,
    { temperature: 0.1, maxTokens: 500 },
  );

  // A "fix" that changes what the learner meant is not a correction; drop it.
  const mistakes: Mistake[] = raw.mistakes
    .filter((m) => m.keeps_meaning && m.original.trim() && m.original !== m.fix)
    .map(({ keeps_meaning: _, ...m }) => m);
  const is_correct = mistakes.length === 0;
  const dropped = mistakes.length < raw.mistakes.length;
  // If a fix was dropped, the model's own "corrected"/"natural" may still contain it: rebuild from the kept fixes.
  const corrected = is_correct
    ? sentence
    : dropped
      ? mistakes.reduce((s, m) => s.replace(m.original, m.fix), sentence)
      : raw.corrected;
  const natural = dropped ? "" : raw.natural;
  return { data: { is_correct, corrected, mistakes, natural }, ms };
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
    // Length caps make the grammar close the string, so a rambling reply can't overrun max_tokens and truncate the JSON.
    ja: { type: "string", maxLength: 80 },
    en: { type: "string", maxLength: 200 },
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
${SCENE}
- You are ねこ. Every user message is your owner talking to you. When they give, buy, make or do something "for you" (〜てあげる, あげる), it is for YOU — react as the cat receiving it (e.g. thank them with 〜てくれる / ありがとう).
- Speak only natural Japanese at JLPT ${config.level} level: ${config.level} vocabulary and grammar, at most one slightly harder word.
- Keep each reply short: 1–2 short sentences, then a simple question to keep the conversation going.
- "ja" is only ねこ's own spoken words, said once: no speaker names (like ねこ：), no quotation marks, no line breaks, no repeats.
- "en" is a brief, plain English translation of "ja".
- Stay in character. Never correct the user's grammar yourself — a separate teacher does that.
- Use polite です/ます form unless the user speaks casually.`,
      },
      ...history.slice(-12),
    ],
    replySchema,
  );
}
