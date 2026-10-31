import { config } from "./config.ts";
import { chatJson, chatText } from "./llm.ts";
import type { ChatMessage } from "./llm.ts";
import { recentAsks, recordSummary } from "./records.ts";

/**
 * Grammar questions. Hermes Agent answers them, on a frontier model (HERMES_MODEL, default
 * Claude Opus 5.5): it can open the learner's vault notes (Index, Grammar/, Daily/) and its own
 * wiki. If Hermes is down or the model can't be reached, Qwen answers directly from a summary of
 * the record, so the button always works.
 */

export interface Answer {
  text: string;
  source: "hermes" | "local";
  model: string; // display name of the model that actually answered, e.g. "Claude Opus 5.5"
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

/**
 * The language the question is written in, ignoring the Japanese it asks about
 * ("为什么用に？" → Chinese). Named explicitly in the prompt, because models
 * otherwise drift into English. Fast: one short local call.
 */
async function questionLanguage(question: string): Promise<string> {
  try {
    const { data } = await chatJson<{ language: string }>(
      [
        // {
        //   role: "system",
        //   content:
        //     'Name the language a learner wrote their question in, as an English name (e.g. "English", "Chinese", "Malay", "Japanese"). Ignore Japanese words or sentences the question is asking about: "why に here?" is English. Only a question written entirely in Japanese is "Japanese". Chinese words such as 那, 呢, 吗, 什么, 为什么, 怎么, 和, 的 around a particle mean Chinese: "那で呢？" is Chinese. Japanese questions use kana grammar such as は, ですか, の, ちがい.',
        // },
        { role: "user", content: question },
      ],
      {
        type: "object",
        properties: { language: { type: "string" } },
        required: ["language"],
      },
      { temperature: 0, maxTokens: 20 },
    );
    return data.language.trim() || "the same language as the question";
  } catch {
    return "the same language as the question";
  }
}

const HERMES_TIMEOUT_MS = 180_000; // Hermes reads several notes first (slow if it's on the local model)

function brief(language: string): string {
  const lang =
    language === "Japanese"
      ? `Write the whole answer in easy Japanese at ${config.level} level.`
      : `Write the whole answer in ${language} (the language of the question), except the Japanese examples.`;
  return `The learner is studying Japanese at JLPT ${config.level} and asked this through neko, their Japanese-practice pet.
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

/** The last few questions and answers, as conversation turns before the new question. */
function followUps(): ChatMessage[] {
  return recentAsks().flatMap(({ question, answer }) => [
    { role: "user" as const, content: question },
    { role: "assistant" as const, content: answer },
  ]);
}

async function askHermes(
  question: string,
  summary: string,
  language: string,
): Promise<Answer> {
  const t0 = performance.now();
  const res = await fetch(`${config.hermesUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.hermesKey}`,
    },
    signal: AbortSignal.timeout(HERMES_TIMEOUT_MS),
    body: JSON.stringify({
      // with an explicit provider, Hermes uses this model for the turn (and its own tools still read the vault)
      ...(config.hermesModel && config.hermesProvider
        ? { model: config.hermesModel, provider: config.hermesProvider }
        : { model: "hermes-agent" }),
      stream: false,
      messages: [
        {
          role: "system",
          content: `${brief(language)}
The learner's record is in the Obsidian vault at ${config.vaultDir}: Index.md (weakest points), Grammar/<point>.md (every past mistake on a point) and Daily/<date>.md. Read the notes relevant to the question before answering. Do not edit those files; neko rewrites them.

Summary of the record:
${summary}`,
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
    ms: Math.round(performance.now() - t0),
  };
}

async function askLocal(
  question: string,
  summary: string,
  language: string,
): Promise<Answer> {
  const { text, ms, model } = await chatText([
    {
      role: "system",
      content: `${brief(language)}\n\nSummary of the learner's record:\n${summary}`,
    },
    ...followUps(),
    questionTurn(question, language),
  ]);
  if (!text) throw new Error("no answer from the local model");
  return { text, source: "local", model: modelName(model), ms };
}

export async function answerQuestion(
  question: string,
  log?: { warn: (msg: string) => void },
): Promise<Answer> {
  const summary = recordSummary();
  const language = await questionLanguage(question);
  if (config.hermesKey) {
    try {
      return await askHermes(question, summary, language);
    } catch (err) {
      log?.warn(
        `Hermes unavailable, answering locally: ${(err as Error).message}`,
      );
    }
  }
  return askLocal(question, summary, language);
}

export async function hermesHealth(): Promise<void> {
  if (!config.hermesKey)
    throw new Error("HERMES_KEY not set (answering locally)");
  const r = await fetch(`${config.hermesUrl}/health`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!r.ok) throw new Error(`status ${r.status}`);
}
