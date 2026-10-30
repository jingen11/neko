import { config } from "./config.ts";
import { chatText } from "./llm.ts";
import { recordSummary } from "./records.ts";

/**
 * Grammar questions. Hermes Agent answers them: it can open the learner's vault notes
 * (Index, Grammar/, Daily/) and its own wiki. If Hermes is down or not set up, Qwen answers
 * directly from a summary of the record, so the button always works.
 */

export interface Answer {
  text: string;
  source: "hermes" | "local";
  ms: number;
}

const HERMES_TIMEOUT_MS = 180_000; // Hermes may read several notes on the local model first

function brief(): string {
  return `The learner is studying Japanese at JLPT ${config.level} and asked this through neko, their Japanese-practice pet.
Answer the grammar question:
- Simple English, with 1–3 short Japanese example sentences at ${config.level} level (each with an English gloss).
- Where it helps, point to the learner's own past mistakes on this point.
- At most about 150 words. Plain text; **bold** and "- " lists are fine, no headings or tables.`;
}

async function askHermes(question: string, summary: string): Promise<Answer> {
  const t0 = performance.now();
  const res = await fetch(`${config.hermesUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.hermesKey}` },
    signal: AbortSignal.timeout(HERMES_TIMEOUT_MS),
    body: JSON.stringify({
      model: "hermes-agent",
      stream: false,
      messages: [
        {
          role: "system",
          content: `${brief()}
The learner's record is in the Obsidian vault at ${config.vaultDir}: Index.md (weakest points), Grammar/<point>.md (every past mistake on a point) and Daily/<date>.md. Read the notes relevant to the question before answering. Do not edit those files; neko rewrites them.

Summary of the record:
${summary}`,
        },
        { role: "user", content: question },
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
  return { text, source: "hermes", ms: Math.round(performance.now() - t0) };
}

async function askLocal(question: string, summary: string): Promise<Answer> {
  const { text, ms } = await chatText([
    { role: "system", content: `${brief()}\n\nSummary of the learner's record:\n${summary}` },
    { role: "user", content: question },
  ]);
  if (!text) throw new Error("no answer from the local model");
  return { text, source: "local", ms };
}

export async function answerQuestion(question: string, log?: { warn: (msg: string) => void }): Promise<Answer> {
  const summary = recordSummary();
  if (config.hermesKey) {
    try {
      return await askHermes(question, summary);
    } catch (err) {
      log?.warn(`Hermes unavailable, answering locally: ${(err as Error).message}`);
    }
  }
  return askLocal(question, summary);
}

export async function hermesHealth(): Promise<void> {
  if (!config.hermesKey) throw new Error("HERMES_KEY not set (answering locally)");
  const r = await fetch(`${config.hermesUrl}/health`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`status ${r.status}`);
}
