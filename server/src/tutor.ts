import { config } from "./config.ts";
import { chatJson, type ChatMessage } from "./llm.ts";
import { knownPoints } from "./records.ts";

/** Who is talking to whom — both prompts need this to read giving/receiving verbs and "you" correctly. */
const SCENE = `Scene: a conversation between exactly two parties, who never change.
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
interface RawCorrection {
  meaning: string;
  mistakes: (Mistake & { keeps_meaning: boolean })[];
  corrected: string;
  natural: string;
}

const correctionSchema = {
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
            enum: ["particle", "conjugation", "tense", "vocabulary", "word_order", "politeness", "other"],
          },
          grammar_point: { type: "string" },
          explanation: { type: "string" },
        },
        required: ["original", "fix", "keeps_meaning", "type", "grammar_point", "explanation"],
      },
    },
    corrected: { type: "string" },
    natural: { type: "string" },
  },
  required: ["meaning", "mistakes", "corrected", "natural"],
};

// The teacher sees the conversation exactly as ねこ does: the same system scene, the same chat
// turns (user = the owner, assistant = ねこ), and the owner's sentence as the latest user message.
// ねこ reads context well this way; a flattened transcript made the teacher lose who was talking to whom.
const teacherPrompt = (known: string[]) => `You are the Japanese teacher of a JLPT ${config.level} learner. You sit beside them while they talk to their pet cat, ねこ.
${SCENE}
- The messages below are that conversation. The assistant messages are ねこ's lines, not yours. Do not reply to the learner or continue the conversation.
- Your job is to check the learner's latest message. It came from speech recognition.
- First understand it the way ねこ does: as the owner talking to their cat, in the flow of the conversation. "I" is the owner; "you" is ねこ. Japanese often leaves both out — fill them in from the conversation.
- When the owner gives ねこ something or does something for it, 〜てあげる / あげる is the right verb. くれる / 〜てくれる is for things done for the owner, もらう / 〜てもらう for receiving. A giving verb is only wrong when it points the wrong way.
- Flag only real grammar or vocabulary mistakes. Not mistakes: punctuation, kana vs kanji, casual speech or mixed casual/polite, particles natives drop in speech, style preferences.

Output, in this order:
- meaning: one plain English sentence — what ねこ understands the owner to be saying to it (who does what for whom).
- mistakes: each real mistake. original: the wrong part as said; fix: the corrected part; keeps_meaning: true only if the fixed sentence still means exactly your "meaning" (same people, same action, same direction); type; grammar_point (2–6 words); explanation (one sentence, max 20 words, simple English). An empty list is normal for a fine sentence.
- corrected: the whole sentence with only those fixes, keeping the learner's words (unchanged if there are none).
- natural: how a native would say it, only if quite different; otherwise "".${
  known.length
    ? `
Grammar point names already on record (use one exactly if it names a mistake you found; the list does not mean this sentence has that mistake): ${known.join("; ")}.`
    : ""
}`;

export async function correct(sentence: string, context: ChatMessage[] = []): Promise<{ data: Correction; ms: number }> {
  // Reusing names lets the vault group repeat mistakes under one grammar note.
  const { data: raw, ms } = await chatJson<RawCorrection>(
    [
      { role: "system", content: teacherPrompt(knownPoints()) },
      ...context.filter((m) => m.role !== "system").slice(-12),
      { role: "user", content: sentence },
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
