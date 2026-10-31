import { config } from "./config.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Call llama.cpp and get back JSON matching `schema`.
 * Thinking is turned off: pet replies and corrections need to be fast.
 */
/** Sampling options. top_k / top_p / min_p / seed are passed to llama.cpp only when set. */
export interface SampleOpts {
  temperature?: number;
  maxTokens?: number;
  topK?: number;
  topP?: number;
  minP?: number;
  seed?: number;
}

export async function chatJson<T>(messages: ChatMessage[], schema: object, opts: SampleOpts = {}): Promise<{ data: T; ms: number }> {
  const t0 = performance.now();
  const res = await fetch(`${config.llamaUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 800,
      ...(opts.topK !== undefined && { top_k: opts.topK }),
      ...(opts.topP !== undefined && { top_p: opts.topP }),
      ...(opts.minP !== undefined && { min_p: opts.minP }),
      ...(opts.seed !== undefined && { seed: opts.seed }),
      response_format: { type: "json_schema", json_schema: { schema } },
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`llama.cpp error ${res.status}: ${body?.error?.message ?? JSON.stringify(body)}`);
  const content: string = body.choices?.[0]?.message?.content ?? "";
  try {
    return { data: JSON.parse(content) as T, ms: Math.round(performance.now() - t0) };
  } catch {
    throw new Error(`llama.cpp returned invalid JSON: ${content.slice(0, 200)}`);
  }
}

/** Call llama.cpp for plain text (markdown allowed), thinking off. */
export async function chatText(messages: ChatMessage[], opts: { temperature?: number; maxTokens?: number } = {}): Promise<{ text: string; ms: number; model: string }> {
  const t0 = performance.now();
  const res = await fetch(`${config.llamaUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 700,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`llama.cpp error ${res.status}: ${body?.error?.message ?? JSON.stringify(body)}`);
  return { text: String(body.choices?.[0]?.message?.content ?? "").trim(), ms: Math.round(performance.now() - t0), model: String(body.model ?? "local model") };
}
