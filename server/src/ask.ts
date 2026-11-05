import { config } from "./config.ts";

/**
 * Grammar questions from the Ask box (ask_grammar). They go to Hermes Agent's "pro" profile
 * (HERMES_PRO_PROFILE, served at /p/<profile>/, on Claude Opus 5.5), which can open the learner's vault
 * notes (Daily/ and anything else there) and its own wiki. neko never calls a model directly here.
 * If Hermes is down, the question fails with an error; there is no fallback.
 */

export interface Answer {
  text: string;
  model: string; // display name of the profile's model, e.g. "Claude Opus 5.5"
  ms: number;
}

/** The pro profile's API. Profiles other than default are served under /p/<profile>/. */
const base = () => `${config.hermesUrl}/p/${config.hermesProProfile}`;

const HERMES_TIMEOUT_MS = 180_000; // Hermes reads several notes before answering

// The language rule is spelled out, because models otherwise drift into English.
const LANGUAGE = `Write the whole answer in the language the question is written in, ignoring the Japanese words or sentences it asks about (an English question about は gets an English answer). Only a question written entirely in Japanese gets an answer in easy Japanese at ${config.level} level.`;

function brief(): string {
  const intro = `The learner is studying Japanese at JLPT ${config.level} and asked this through neko, their Japanese-practice pet.`;
  return `${intro}
Answer the grammar question:
- ${LANGUAGE}
- Include 1–3 short Japanese example sentences at ${config.level} level, each with a gloss in the answer's language.
- Where it helps, point to the learner's own past mistakes on this point.
- Earlier questions and answers from this learner come before the new question: use them for follow-ups ("and what about で?"), but answer only the newest question.
- Short: about 150 words (300 characters in Chinese or Japanese). Plain text; **bold** and "- " lists are fine, no headings or tables.`;
}

type Turn = { role: "system" | "user" | "assistant"; content: string };

/** The new question, with the language rule repeated next to it: earlier turns in another language pull the model along otherwise. */
const questionTurn = (question: string): Turn => ({
  role: "user",
  content: `${question}\n\n(Answer in the language this question is written in.)`,
});

// The last few questions and answers, kept in memory so follow-ups ("and what about で?") work.
// neko doesn't read them back from the vault; they're gone when the server restarts.
const recent: { at: number; question: string; answer: string }[] = [];
const FOLLOW_UPS = 4;
const FOLLOW_UP_HOURS = 12;

/** The last few questions and answers, as conversation turns before the new question. */
function followUps(): Turn[] {
  const since = Date.now() - FOLLOW_UP_HOURS * 3_600_000;
  return recent.filter((r) => r.at >= since).flatMap(({ question, answer }) => [
    { role: "user" as const, content: question },
    { role: "assistant" as const, content: answer },
  ]);
}

async function askHermes(question: string): Promise<Answer> {
  if (!config.hermesProKey) throw new Error("HERMES_PRO_KEY is not set in server/.env");
  const t0 = performance.now();
  const res = await fetch(`${base()}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.hermesProKey}` },
    signal: AbortSignal.timeout(HERMES_TIMEOUT_MS),
    body: JSON.stringify({
      // The profile decides the model; "hermes-agent" just means "this profile's agent".
      model: "hermes-agent",
      stream: false,
      messages: [
        {
          role: "system",
          content: `${brief()}
The learner's record is in the Obsidian vault at ${config.vaultDir}: Daily/<date>.md holds every sentence they said that day with its mistakes, their translations, listening trouble and past questions. Read the notes relevant to the question before answering.`,
        },
        ...followUps(),
        questionTurn(question),
      ],
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Hermes error ${res.status}: ${body?.error?.message ?? res.statusText}`);
  const choice = body?.choices?.[0];
  const text = String(choice?.message?.content ?? "").trim();
  // "length" = Hermes ran out of steps but still wrote a usable wrap-up
  if (!text || (choice?.finish_reason && !["stop", "length"].includes(choice.finish_reason)))
    throw new Error(`Hermes gave no answer (${choice?.finish_reason ?? "empty"})`);
  return { text, model: config.hermesProModelLabel, ms: Math.round(performance.now() - t0) };
}

export async function answerQuestion(question: string): Promise<Answer> {
  const answer = await askHermes(question);
  recent.push({ at: Date.now(), question, answer: answer.text });
  recent.splice(0, Math.max(0, recent.length - FOLLOW_UPS));
  return answer;
}

/** The pro profile answers with its key. /v1/models checks the key without running the agent. */
export async function hermesHealth(): Promise<void> {
  if (!config.hermesProKey) throw new Error("HERMES_PRO_KEY not set");
  const r = await fetch(`${base()}/v1/models`, {
    headers: { authorization: `Bearer ${config.hermesProKey}` },
    signal: AbortSignal.timeout(3000),
  });
  if (!r.ok) throw new Error(`HERMES_PRO_KEY: status ${r.status}`);
}
