import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.ts";
import type { CallRecord } from "./types.ts";
import { saveCall } from "./vault.ts";

type Json = Record<string, any>;

/** Who is calling: `X-Neko-Client` header, else the OpenAI `user` field, else "unknown". */
function clientName(req: FastifyRequest, body?: Json): string {
  const h = req.headers["x-neko-client"];
  return (Array.isArray(h) ? h[0] : h) || (typeof body?.user === "string" ? body.user : "") || "unknown";
}

function newRecord(req: FastifyRequest, endpoint: string, body?: Json): CallRecord {
  return {
    id: randomUUID(),
    startedAt: new Date().toISOString(),
    client: clientName(req, body),
    endpoint,
    model: typeof body?.model === "string" ? body.model : undefined,
    stream: body?.stream === true,
    status: 0,
    durationMs: 0,
  };
}

function finish(req: FastifyRequest, record: CallRecord, t0: number): void {
  record.durationMs = Math.round(performance.now() - t0);
  const tokens = record.completionTokens != null ? ` ${record.promptTokens ?? "?"}→${record.completionTokens} tok` : "";
  const tps = record.tokensPerSec ? ` ${record.tokensPerSec} tok/s` : "";
  req.log.info(`${record.client} ${record.endpoint} ${record.status} ${record.durationMs}ms${tokens}${tps}${record.error ? ` error=${record.error}` : ""}`);
  saveCall(record).catch((err) => req.log.error({ err }, "failed to save call to vault"));
}

/** Fill token/speed fields from llama.cpp's `usage` and `timings` objects. */
function applyUsage(record: CallRecord, usage?: Json, timings?: Json): void {
  record.promptTokens = usage?.prompt_tokens ?? timings?.prompt_n ?? record.promptTokens;
  record.completionTokens = usage?.completion_tokens ?? timings?.predicted_n ?? record.completionTokens;
  if (typeof timings?.predicted_per_second === "number") {
    record.tokensPerSec = Math.round(timings.predicted_per_second * 10) / 10;
  }
}

function openaiError(message: string, type = "neko_error") {
  return { error: { message, type } };
}

/** Collects a streamed chat completion from SSE chunks so it can be logged. */
class SseAccumulator {
  private buf = "";
  content = "";
  reasoning = "";
  toolCalls: Json[] = [];
  finishReason?: string;
  model?: string;
  usage?: Json;
  timings?: Json;
  gotToken = false;

  push(text: string): void {
    this.buf += text;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        this.onEvent(JSON.parse(data));
      } catch {
        // ignore malformed event; the client still received the raw bytes
      }
    }
  }

  private onEvent(ev: Json): void {
    if (ev.model) this.model = ev.model;
    if (ev.usage) this.usage = ev.usage;
    if (ev.timings) this.timings = ev.timings;
    const choice = ev.choices?.[0];
    if (!choice) return;
    const d = choice.delta ?? {};
    if (d.content) this.content += d.content;
    if (d.reasoning_content) this.reasoning += d.reasoning_content;
    if (d.content || d.reasoning_content || d.tool_calls) this.gotToken = true;
    for (const tc of d.tool_calls ?? []) {
      const slot = (this.toolCalls[tc.index ?? 0] ??= { id: tc.id, type: "function", function: { name: "", arguments: "" } });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.function.name += tc.function.name;
      if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
    }
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
  }
}

/** POST /v1/chat/completions — forwarded to llama.cpp, fully logged to the vault. */
export async function chatCompletions(req: FastifyRequest, reply: FastifyReply) {
  const t0 = performance.now();
  let body: Json;
  try {
    body = JSON.parse((req.body as Buffer | undefined)?.toString("utf8") || "{}");
  } catch {
    return reply.code(400).send(openaiError("Request body must be valid JSON", "invalid_request_error"));
  }

  const record = newRecord(req, "/v1/chat/completions", body);
  record.messages = Array.isArray(body.messages) ? body.messages : [];

  // Stop generating upstream if the caller goes away.
  const abort = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableFinished) abort.abort();
  });

  let upstream: Response;
  try {
    upstream = await fetch(`${config.upstream}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
  } catch (err) {
    record.status = 502;
    record.error = `llama.cpp unreachable: ${(err as Error).message}`;
    finish(req, record, t0);
    return reply.code(502).header("x-neko-request-id", record.id).send(openaiError(record.error, "upstream_error"));
  }
  record.status = upstream.status;

  const isSse = upstream.headers.get("content-type")?.includes("text/event-stream");
  if (!isSse || !upstream.body) {
    const text = await upstream.text();
    try {
      const json = JSON.parse(text);
      const choice = json.choices?.[0];
      record.model = json.model ?? record.model;
      record.finishReason = choice?.finish_reason;
      record.response = {
        content: choice?.message?.content ?? "",
        reasoning: choice?.message?.reasoning_content,
        toolCalls: choice?.message?.tool_calls,
      };
      applyUsage(record, json.usage, json.timings);
      if (!upstream.ok) record.error = json.error?.message ?? text.slice(0, 500);
    } catch {
      if (!upstream.ok) record.error = text.slice(0, 500);
    }
    finish(req, record, t0);
    return reply
      .code(upstream.status)
      .header("content-type", upstream.headers.get("content-type") ?? "application/json")
      .header("x-neko-request-id", record.id)
      .send(text);
  }

  // Streaming: pass every byte straight through while reading the events on the side.
  reply.hijack();
  reply.raw.writeHead(upstream.status, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-neko-request-id": record.id,
  });
  const acc = new SseAccumulator();
  const decoder = new TextDecoder();
  try {
    for await (const chunk of upstream.body) {
      acc.push(decoder.decode(chunk, { stream: true }));
      if (record.ttftMs === undefined && acc.gotToken) record.ttftMs = Math.round(performance.now() - t0);
      if (!reply.raw.write(chunk)) await once(reply.raw, "drain", { signal: abort.signal });
    }
  } catch (err) {
    record.error = abort.signal.aborted ? "client disconnected" : `stream error: ${(err as Error).message}`;
  }
  reply.raw.end();

  record.model = acc.model ?? record.model;
  record.finishReason = acc.finishReason;
  record.response = { content: acc.content, reasoning: acc.reasoning || undefined, toolCalls: acc.toolCalls.length ? acc.toolCalls : undefined };
  applyUsage(record, acc.usage, acc.timings);
  finish(req, record, t0);
}

const HOP_HEADERS = new Set(["host", "connection", "content-length", "accept-encoding", "transfer-encoding", "keep-alive"]);

/** Everything else (/v1/models, /v1/embeddings, /completion, /tokenize, ...) — forwarded as-is. */
export async function passthrough(req: FastifyRequest, reply: FastifyReply) {
  const t0 = performance.now();
  const path = req.url.split("?")[0];
  const isWrite = req.method !== "GET" && req.method !== "HEAD";
  const record = newRecord(req, path);

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || HOP_HEADERS.has(k) || k === "x-neko-client") continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${config.upstream}${req.url}`, {
      method: req.method,
      headers,
      body: isWrite && req.body ? new Uint8Array(req.body as Buffer) : undefined,
    });
  } catch (err) {
    record.status = 502;
    record.error = `llama.cpp unreachable: ${(err as Error).message}`;
    if (isWrite) finish(req, record, t0);
    return reply.code(502).send(openaiError(record.error, "upstream_error"));
  }

  record.status = upstream.status;
  // Only log calls that do work (POSTs); GETs like /v1/models or /health would just be noise.
  if (isWrite) reply.raw.once("finish", () => finish(req, record, t0));

  reply.code(upstream.status);
  upstream.headers.forEach((v, k) => {
    if (k !== "content-encoding" && k !== "content-length" && k !== "transfer-encoding") reply.header(k, v);
  });
  reply.header("x-neko-request-id", record.id);
  return reply.send(upstream.body ? Readable.fromWeb(upstream.body as any) : "");
}
