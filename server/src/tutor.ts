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

const teacherPrompt = (known: string[]) => `You are a careful Japanese teacher. A JLPT ${config.level} learner is practising by talking to their pet cat, ねこ. You check each sentence the learner says to the cat. Sentences come from speech recognition.

${SCENE}

Work in this order — the output fields follow it.

1. meaning — In one plain English sentence, say what the learner means, as said to ねこ. Name who does what for whom ("I", "you" = the cat, or someone the learner mentions). Japanese often leaves out the subject and the receiver; fill them in from the scene and the conversation. Read the sentence the way the cat would: as a message to it from its owner.

2. mistakes — Only real grammar or vocabulary errors in what the learner said, judged against that meaning. For each one:
   - original: the wrong part, exactly as the learner said it. fix: the corrected part.
   - keeps_meaning: true only if the fixed sentence still means exactly what you wrote in "meaning" — the same people, the same action, the same direction of giving. A fix that changes who something is for, or who does it, is not a correction; set false.
   - type, grammar_point (2–6 words, e.g. "i-adjective past tense"), explanation (one sentence, max 20 words, simple English, agreeing with the fix).
   If the sentence has no mistakes, return an empty list. That is the normal case for a sentence that is fine.

3. corrected — the whole sentence with only the fixes above applied, keeping the learner's words. If there are no mistakes, repeat the sentence unchanged.

4. natural — how a native would say it, only if that is quite different from "corrected"; otherwise "".

How giving and receiving verbs work here. They mark direction — who benefits — not politeness:
- あげる / 〜てあげる: the speaker gives to someone, or does something for them. When the learner gives the cat something or does something for it, this is the correct verb.
- くれる / 〜てくれる: someone gives to the speaker, or does something for the speaker — for example the cat doing something for the learner.
- もらう / 〜てもらう: the speaker receives something, told from the receiver's side.
- Textbooks warn that saying 〜てあげる to the person you are talking to can sound condescending. That warning is about superiors, strangers and polite relationships. It does not apply to an owner talking to their own pet, so it is never a mistake here.
- Removing a giving verb, or swapping it for another, changes who the action is for. Only flag one that points the wrong way for the people in "meaning".

Not mistakes:
- missing punctuation, kana-vs-kanji spelling, or other speech-recognition artifacts
- casual speech, or mixing casual and polite forms
- particles native speakers also drop in speech
- anything that is only a style preference${
  known.length
    ? `

Naming: these grammar point names are already on record: ${known.join("; ")}. After you have found a mistake, if one of these names describes it, use that name exactly. The list says nothing about whether this sentence has a mistake.`
    : ""
}`;

export async function correct(sentence: string, context: ChatMessage[] = []): Promise<{ data: Correction; ms: number }> {
  const recent = context
    .slice(-4)
    .map((m) => `${m.role === "user" ? "Learner (owner)" : "ねこ (cat)"}: ${m.content}`)
    .join("\n");
  // Reusing names lets the vault group repeat mistakes under one grammar note.
  const { data: raw, ms } = await chatJson<RawCorrection>(
    [
      { role: "system", content: teacherPrompt(knownPoints()) },
      {
        role: "user",
        content: `${recent ? `Conversation so far:\n${recent}\n\n` : ""}The learner (owner) now says to ねこ (cat):\n${sentence}`,
      },
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
