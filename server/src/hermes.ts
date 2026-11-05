import { config } from "./config.ts";
import type { ChatMessage } from "./llm.ts";

/**
 * JSON from a Hermes profile (served at /p/<profile>/). Unlike llama.cpp, Hermes can't enforce a JSON
 * schema, so the schema goes into the system message and the reply is parsed and checked for its
 * required fields, with one retry. `fromText` can accept a plain-text reply instead (no retry). The
 * profile's tools run inside Hermes before the reply comes back.
 */

const TIMEOUT_MS = 120_000; // a reply may include tool calls on the local model

type Schema = { required?: string[] };

const formatRule = (schema: object) => `

Reply with ONLY one JSON object that matches this JSON Schema, with its fields in this order. Nothing before or after it, no code fences:
${JSON.stringify(schema)}`;

/** The JSON object in the reply (models sometimes wrap it in a code fence), with every required field. */
function parse<T>(text: string, schema: Schema): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`no JSON object in the reply: ${text.slice(0, 120)}`);
  const data = JSON.parse(text.slice(start, end + 1));
  const missing = (schema.required ?? []).filter((k) => !(k in data));
  if (missing.length) throw new Error(`reply is missing ${missing.join(", ")}`);
  return data as T;
}

export interface Profile {
  name: string;
  key: string;
  keyName: string; // the server/.env setting, for error messages
}

export const nekoProfile = (): Profile => ({ name: config.hermesNekoProfile, key: config.hermesNekoKey, keyName: "HERMES_NEKO_KEY" });

const base = (p: Profile) => `${config.hermesUrl}/p/${p.name}`;

/**
 * Ask a Hermes profile for JSON matching `schema`. `messages` starts with the system message. Thinking is off.
 * `fromText` turns a reply that isn't JSON into a usable result (or undefined to retry).
 */
export async function hermesJson<T>(
  p: Profile,
  messages: ChatMessage[],
  schema: Schema & object,
  fromText?: (text: string) => T | undefined,
): Promise<{ data: T; ms: number }> {
  if (!p.key) throw new Error(`${p.keyName} is not set in server/.env`);
  const t0 = performance.now();
  const [first, ...rest] = messages;
  const system = first?.role === "system" ? first.content : "";
  const others = first?.role === "system" ? rest : messages;
  let problem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    // On the retry, say what was wrong. (This also changes the system message, so Hermes starts a fresh session.)
    const note = problem ? `\n\nYour previous reply could not be used (${problem}). Reply with the JSON object only.` : "";
    const res = await fetch(`${base(p)}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${p.key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        model: "hermes-agent", // the profile decides the model
        stream: false,
        model_options: { reasoning: { enabled: false } },
        messages: [{ role: "system", content: system + formatRule(schema) + note }, ...others],
      }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Hermes error ${res.status}: ${body?.error?.message ?? res.statusText}`);
    const text = String(body?.choices?.[0]?.message?.content ?? "");
    const ms = () => Math.round(performance.now() - t0);
    try {
      return { data: parse<T>(text, schema), ms: ms() };
    } catch (err) {
      problem = (err as Error).message;
      const plain = fromText?.(text);
      if (plain !== undefined) return { data: plain, ms: ms() };
    }
  }
  throw new Error(`Hermes gave no usable reply twice: ${problem}`);
}

/** The profile answers with its key. /v1/models checks the key without running the agent. */
export async function profileHealth(p: Profile): Promise<void> {
  if (!p.key) throw new Error(`${p.keyName} not set`);
  const r = await fetch(`${base(p)}/v1/models`, {
    headers: { authorization: `Bearer ${p.key}` },
    signal: AbortSignal.timeout(3000),
  });
  if (!r.ok) throw new Error(`${p.keyName}: status ${r.status}`);
}
