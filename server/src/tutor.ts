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
    .map((m) => `${m.role === "user" ? "Learner (owner)" : "ねこ (cat)"}: ${m.content}`)
    .join("\n");
  // Reusing names lets the vault group repeat mistakes under one grammar note.
  const known = knownPoints();
  const reuse = known.length
    ? `\n- Grammar points already on record: ${known.join("; ")}. When you find a mistake that matches one, use that name exactly. This list is only for naming — it does not mean the sentence has that mistake.`
    : "";
  return chatJson<Correction>(
    [
      {
        role: "system",
        content: `You are a precise Japanese teacher checking a JLPT ${config.level} learner's spoken sentence (transcribed from speech).
${SCENE}
Judge the sentence as something said TO the pet, using the conversation for context:
- Who is who: "I" (implied or explicit) is the learner; "you" (implied or explicit) is the cat. Japanese often drops both, so work out the giver and receiver from this scene and the conversation, not from the words alone.
- Giving and receiving verbs depend on direction, not on politeness:
  - あげる / 〜てあげる: the speaker (or their side) gives to, or does something for, someone else. When the learner gives the cat something or does something for it, this is the right verb.
  - くれる / 〜てくれる: someone else gives to, or does something for, the speaker. Use it when the cat (or anyone) does something for the learner.
  - もらう / 〜てもらう: the speaker receives from someone, seen from the receiver's side.
  - A sentence with no giving verb is also fine, but it is a different sentence: it no longer says the action was for the cat. Never drop or swap a giving verb just to make a sentence plainer.
- The cat is the learner's pet, so the slight "doing you a favour" tone that 〜てあげる can carry towards a superior does not apply. Do not treat it as a politeness mistake.
- Flag a giving verb only when it points the wrong way for the people involved, for example くれる for something the learner did for the cat.
- Do not "fix" a sentence by changing who it is for or who does it.
- Do flag a clear tense mistake given the context.
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
      {
        role: "user",
        content: `${recent ? `Conversation so far:\n${recent}\n\n` : ""}Check this sentence, said by the learner (owner) to ねこ (cat):\n${sentence}`,
      },
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
