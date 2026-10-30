import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { config } from "./config.ts";
import type { ChatMessage } from "./llm.ts";
import { int16ToFloat32, transcribe } from "./stt.ts";
import { listVoices, speak } from "./tts.ts";
import { correct, petReply } from "./tutor.ts";

const app = Fastify({ logger: { level: process.env.NEKO_LOG_LEVEL ?? "info" }, bodyLimit: 20 * 1024 * 1024 });

app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
app.register(fastifyStatic, { root: path.resolve(import.meta.dirname, "../public") });

/** Speech → text. Body: raw 16-bit mono PCM; sample rate in `x-sample-rate` (default 16000). */
app.post("/api/stt", async (req, reply) => {
  const pcm = req.body as Buffer;
  if (!Buffer.isBuffer(pcm) || pcm.length < 3200) return reply.code(400).send({ error: "send at least 0.1s of 16-bit PCM audio" });
  const rate = Number(req.headers["x-sample-rate"] ?? 16000);
  const result = await transcribe(int16ToFloat32(pcm), rate);
  req.log.info(`stt ${result.ms}ms (${(pcm.length / 2 / rate).toFixed(1)}s audio): ${result.text}`);
  return result;
});

/** The learner said `text`: correct it and get the pet's in-character reply, in parallel. */
app.post<{ Body: { text: string; history?: ChatMessage[] } }>("/api/respond", async (req, reply) => {
  const text = req.body?.text?.trim();
  if (!text) return reply.code(400).send({ error: "text is required" });
  const history = (req.body.history ?? []).filter((m) => m.role === "user" || m.role === "assistant");
  const t0 = performance.now();
  const [correction, pet] = await Promise.all([correct(text, history), petReply([...history, { role: "user", content: text }])]);
  const ms = Math.round(performance.now() - t0);
  req.log.info(`respond ${ms}ms (correct ${correction.ms}ms, reply ${pet.ms}ms)`);
  return { correction: correction.data, reply: pet.data, timings: { correctMs: correction.ms, replyMs: pet.ms, totalMs: ms } };
});

/** Japanese text → WAV in the pet's voice. */
app.post<{ Body: { text: string; slow?: boolean } }>("/api/tts", async (req, reply) => {
  const text = req.body?.text?.trim();
  if (!text) return reply.code(400).send({ error: "text is required" });
  const { wav, ms } = await speak(text, { speed: req.body.slow ? 0.75 : undefined });
  req.log.info(`tts ${ms}ms: ${text}`);
  return reply.header("content-type", "audio/wav").header("x-tts-ms", ms).send(wav);
});

app.get("/api/voices", () => listVoices());

app.get("/api/health", async () => {
  const check = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      return [name, "ok"];
    } catch (err) {
      return [name, (err as Error).message];
    }
  };
  const results = await Promise.all([
    check("llama", async () => {
      const r = await fetch(`${config.llamaUrl}/health`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw new Error(`status ${r.status}`);
    }),
    check("voicevox", async () => {
      const r = await fetch(`${config.voicevoxUrl}/version`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw new Error(`status ${r.status}`);
    }),
    check("stt", () => transcribe(new Float32Array(1600), 16000)),
  ]);
  return { level: config.level, ...Object.fromEntries(results) };
});

await app.listen({ host: config.host, port: config.port });
