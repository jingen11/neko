import { config } from "./config.ts";

/**
 * Questions from the Ask box. Every one goes through Hermes Agent, which can open the learner's
 * vault notes (Daily/ and anything else there) and its own wiki. neko never calls a model directly here.
 * - ask_grammar: Hermes's "pro" profile (HERMES_PRO_PROFILE), on a frontier model (Claude Opus 5.5)
 * - ask_casual (chat, "what have I learnt this week?"): Hermes's default profile, on the local model
 * If Hermes is down, the question fails with an error; there is no fallback.
 */

export interface Answer {
  text: string;
  model: string; // display name of the profile's model, e.g. "Claude Opus 5.5"
  kind: QuestionKind;
  ms: number;
}

/** Which message the question came in as: ask_grammar goes to the pro profile, ask_casual to the default one. */
export type QuestionKind = "grammar" | "casual";

/** Where each kind of question goes in Hermes. Profiles other than default are served under /p/<profile>/. */
function route(kind: QuestionKind) {
  return kind === "grammar"
    ? {
        base: `${config.hermesUrl}/p/${config.hermesProProfile}`,
        key: config.hermesProKey,
        keyName: "HERMES_PRO_KEY",
        model: config.hermesProModelLabel,
      }
    : { base: config.hermesUrl, key: config.hermesKey, keyName: "HERMES_KEY", model: config.hermesModelLabel };
}

const HERMES_TIMEOUT_MS = 180_000; // Hermes reads several notes first (slow if it's on the local model)

// The language rule is spelled out, because models otherwise drift into English.
const LANGUAGE = `Write the whole answer in the language the question is written in, ignoring the Japanese words or sentences it asks about (an English question about は gets an English answer). Only a question written entirely in Japanese gets an answer in easy Japanese at ${config.level} level.`;

function brief(kind: QuestionKind): string {
  const intro = `The learner is studying Japanese at JLPT ${config.level} and asked this through neko, their Japanese-practice pet.`;
  if (kind === "casual")
    return `${intro}
Answer the question:
- ${LANGUAGE}
- If it is about their own practice (what they have learnt, practised or keep getting wrong), base the answer on their notes and name the dates and sentences you draw on.
- Earlier questions and answers from this learner come before the new question: use them for follow-ups, but answer only the newest question.
- About 250 words at most. Plain text; **bold** and "- " lists are fine, no headings or tables.`;
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

// Only the default profile (casual questions) has the textbook MCP server.
const textbookNote = `
Their textbook (explanations in Chinese) is searchable with the textbook tools. For a grammar or vocabulary question, check how the book explains it and say which lesson and page. where_am_i tells you their current lesson; keep examples within what they have reached.`;

async function askHermes(question: string, kind: QuestionKind): Promise<Answer> {
  const { base, key, keyName, model } = route(kind);
  if (!key) throw new Error(`${keyName} is not set in server/.env`);
  const t0 = performance.now();
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(HERMES_TIMEOUT_MS),
    body: JSON.stringify({
      // The profile decides the model; "hermes-agent" just means "this profile's agent".
      model: "hermes-agent",
      stream: false,
      messages: [
        {
          role: "system",
          content: `${brief(kind)}
The learner's record is in the Obsidian vault at ${config.vaultDir}: Daily/<date>.md holds every sentence they said that day with its mistakes, their translations, listening trouble and past questions. Read the notes relevant to the question before answering.${kind === "casual" ? textbookNote : ""}`,
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
  return { text, model, kind, ms: Math.round(performance.now() - t0) };
}

export async function answerQuestion(question: string, kind: QuestionKind): Promise<Answer> {
  const answer = await askHermes(question, kind);
  recent.push({ at: Date.now(), question, answer: answer.text });
  recent.splice(0, Math.max(0, recent.length - FOLLOW_UPS));
  return answer;
}

/** Both profiles answer with their keys. /v1/models checks the key without running the agent. */
export async function hermesHealth(): Promise<void> {
  for (const kind of ["casual", "grammar"] as const) {
    const { base, key, keyName } = route(kind);
    if (!key) throw new Error(`${keyName} not set`);
    const r = await fetch(`${base}/v1/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) throw new Error(`${keyName}: status ${r.status}`);
  }
}
