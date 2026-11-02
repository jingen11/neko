import { config } from "./config.ts";
import { chatJson, chatText } from "./llm.ts";
import type { ChatMessage } from "./llm.ts";

/**
 * Questions from the Ask box. Hermes Agent answers them and can open the learner's vault notes
 * (Daily/ and anything else there) and its own wiki. Each kind has its own WebSocket message:
 * - ask_grammar: Hermes on a frontier model (HERMES_MODEL, default Claude Opus 5.5)
 * - ask_casual (chat, "what have I learnt this week?"): Hermes on its own default model, the local one
 * If Hermes is down or the model can't be reached, Qwen answers directly, so the button always
 * works (without the learner's record, which only Hermes reads).
 */

export interface Answer {
  text: string;
  source: "hermes" | "local";
  model: string; // display name of the model that actually answered, e.g. "Claude Opus 5.5"
  kind: QuestionKind;
  ms: number;
}

/** "claude-opus-5-5" → "Claude Opus 5.5"; "/models/Qwen3.6.gguf" → "Qwen3.6". */
export function modelName(id: string): string {
  const base = id
    .split("/")
    .pop()!
    .replace(/\.gguf$/i, "");
  const claude = base.match(/^claude-([a-z]+)-(\d+)-(\d+)/i);
  if (claude)
    return `Claude ${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}.${claude[3]}`;
  return base;
}

/** Which message the question came in as: ask_grammar goes to Hermes on Claude, ask_casual to Hermes's local model. */
export type QuestionKind = "grammar" | "casual";

/**
 * The language the question is written in, ignoring the Japanese it asks about. Named explicitly in
 * the answer prompt, because models otherwise drift into English. Fast: one short local call.
 */
async function questionLanguage(question: string): Promise<string> {
  try {
    const { data } = await chatJson<{ language: string }>(
      [
        {
          role: "system",
          content: `A Japanese learner typed a question. Name the language the question itself is written in, as an English name. Ignore the Japanese words or sentences it asks about. Only a question written entirely in Japanese is "Japanese".`,
        },
        { role: "user", content: question },
      ],
      { type: "object", properties: { language: { type: "string" } }, required: ["language"] },
      { temperature: 0, maxTokens: 20 },
    );
    return data.language.trim() || "the same language as the question";
  } catch {
    return "the same language as the question";
  }
}

const HERMES_TIMEOUT_MS = 180_000; // Hermes reads several notes first (slow if it's on the local model)

function brief(language: string, kind: QuestionKind): string {
  const lang =
    language === "Japanese"
      ? `Write the whole answer in easy Japanese at ${config.level} level.`
      : `Write the whole answer in ${language} (the language of the question), except any Japanese.`;
  const intro = `The learner is studying Japanese at JLPT ${config.level} and asked this through neko, their Japanese-practice pet.`;
  if (kind === "casual")
    return `${intro}
Answer the question:
- ${lang}
- If it is about their own practice (what they have learnt, practised or keep getting wrong), base the answer on their notes and name the dates and sentences you draw on.
- Earlier questions and answers from this learner come before the new question: use them for follow-ups, but answer only the newest question.
- About 250 words at most. Plain text; **bold** and "- " lists are fine, no headings or tables.`;
  return `${intro}
Answer the grammar question:
- ${lang}
- Include 1–3 short Japanese example sentences at ${config.level} level, each with a gloss in the answer's language.
- Where it helps, point to the learner's own past mistakes on this point.
- Earlier questions and answers from this learner come before the new question: use them for follow-ups ("and what about で?"), but answer only the newest question.
- Short: about 150 words (300 characters in Chinese or Japanese). Plain text; **bold** and "- " lists are fine, no headings or tables.`;
}

/** The new question, with the answer language repeated next to it: earlier turns in another language pull the model along otherwise. */
const questionTurn = (question: string, language: string): ChatMessage => ({
  role: "user",
  content: `${question}\n\n(Answer in ${language === "Japanese" ? `easy Japanese, ${config.level} level` : language}.)`,
});

// The last few questions and answers, kept in memory so follow-ups ("and what about で?") work.
// neko doesn't read them back from the vault; they're gone when the server restarts.
const recent: { at: number; question: string; answer: string }[] = [];
const FOLLOW_UPS = 4;
const FOLLOW_UP_HOURS = 12;

/** The last few questions and answers, as conversation turns before the new question. */
function followUps(): ChatMessage[] {
  const since = Date.now() - FOLLOW_UP_HOURS * 3_600_000;
  return recent.filter((r) => r.at >= since).flatMap(({ question, answer }) => [
    { role: "user" as const, content: question },
    { role: "assistant" as const, content: answer },
  ]);
}

async function askHermes(question: string, language: string, kind: QuestionKind): Promise<Answer> {
  const t0 = performance.now();
  const res = await fetch(`${config.hermesUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.hermesKey}`,
    },
    signal: AbortSignal.timeout(HERMES_TIMEOUT_MS),
    body: JSON.stringify({
      // Grammar questions name a model and provider (Claude), and Hermes uses it for the turn. Anything
      // else uses Hermes's own default model, the local one. Hermes's tools read the vault either way.
      ...(kind === "grammar" && config.hermesModel && config.hermesProvider
        ? { model: config.hermesModel, provider: config.hermesProvider }
        : { model: "hermes-agent" }),
      stream: false,
      messages: [
        {
          role: "system",
          content: `${brief(language, kind)}
The learner's record is in the Obsidian vault at ${config.vaultDir}: Daily/<date>.md holds every sentence they said that day with its mistakes, their translations, listening trouble and past questions. Read the notes relevant to the question before answering.`,
        },
        ...followUps(),
        questionTurn(question, language),
      ],
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok)
    throw new Error(
      `Hermes error ${res.status}: ${body?.error?.message ?? res.statusText}`,
    );
  const choice = body?.choices?.[0];
  const text = String(choice?.message?.content ?? "").trim();
  // "length" = Hermes ran out of steps but still wrote a usable wrap-up
  if (
    !text ||
    (choice?.finish_reason &&
      !["stop", "length"].includes(choice.finish_reason))
  )
    throw new Error(
      `Hermes gave no answer (${choice?.finish_reason ?? "empty"})`,
    );
  // runtime = the provider/model that actually served the turn (after any Hermes fallback)
  const served = body?.runtime?.model ?? body?.model ?? "hermes-agent";
  return {
    text,
    source: "hermes",
    model: modelName(served),
    kind,
    ms: Math.round(performance.now() - t0),
  };
}

async function askLocal(question: string, language: string, kind: QuestionKind): Promise<Answer> {
  const { text, ms, model } = await chatText([
    { role: "system", content: brief(language, kind) },
    ...followUps(),
    questionTurn(question, language),
  ]);
  if (!text) throw new Error("no answer from the local model");
  return { text, source: "local", model: modelName(model), kind, ms };
}

export async function answerQuestion(
  question: string,
  kind: QuestionKind,
  log?: { warn: (msg: string) => void },
): Promise<Answer> {
  const language = await questionLanguage(question);
  let answer: Answer | undefined;
  if (config.hermesKey) {
    try {
      answer = await askHermes(question, language, kind);
    } catch (err) {
      log?.warn(
        `Hermes unavailable, answering locally: ${(err as Error).message}`,
      );
    }
  }
  answer ??= await askLocal(question, language, kind);
  recent.push({ at: Date.now(), question, answer: answer.text });
  recent.splice(0, Math.max(0, recent.length - FOLLOW_UPS));
  return answer;
}

export async function hermesHealth(): Promise<void> {
  if (!config.hermesKey)
    throw new Error("HERMES_KEY not set (answering locally)");
  const r = await fetch(`${config.hermesUrl}/health`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!r.ok) throw new Error(`status ${r.status}`);
}
