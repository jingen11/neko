import { existsSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify from "fastify";
import { padSilence } from "./audio.ts";
import { config } from "./config.ts";
import { attach } from "./hub.ts";
import type { ChatMessage } from "./llm.ts";
import { int16ToFloat32, transcribe } from "./stt.ts";
import { listVoices, speak } from "./tts.ts";
import { correct, petReply } from "./tutor.ts";
import { saveRecording, score, testCases } from "./voicetest.ts";

const app = Fastify({ logger: { level: process.env.NEKO_LOG_LEVEL ?? "info" }, disableRequestLogging: true, bodyLimit: 20 * 1024 * 1024 });

app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

// The pet app (built from web/) at "/", the Phase 1 lab page at "/lab.html".
const webDist = path.resolve(import.meta.dirname, "../../web/dist");
if (!existsSync(webDist)) app.log.warn(`web app not built (${webDist} missing): run "npm run build" in web/`);
app.register(fastifyStatic, { root: [webDist, path.resolve(import.meta.dirname, "../public")].filter(existsSync) });

// The pet protocol (see shared/protocol.ts).
await app.register(fastifyWebsocket, { options: { maxPayload: 4 * 1024 * 1024 } });
app.get("/ws", { websocket: true }, (socket) => attach(socket, app.log));

/** Speech → text. Body: raw 16-bit mono PCM; sample rate in `x-sample-rate` (default 16000). */
app.post("/api/stt", async (req, reply) => {
  const pcm = req.body as Buffer;
  if (!Buffer.isBuffer(pcm) || pcm.length < 3200) return reply.code(400).send({ error: "send at least 0.1s of 16-bit PCM audio" });
  const rate = Number(req.headers["x-sample-rate"] ?? 16000);
  const result = await transcribe(padSilence(int16ToFloat32(pcm), rate), rate);
  req.log.info(`stt ${result.ms}ms (${(pcm.length / 2 / rate).toFixed(1)}s audio): ${result.text}`);
  return result;
});

// The page calls /api/reply and /api/correct at the same time, so the pet can start
// talking while the (slower) correction card is still being written.
type TurnBody = { Body: { text: string; history?: ChatMessage[] } };
const cleanHistory = (h?: ChatMessage[]) => (h ?? []).filter((m) => m.role === "user" || m.role === "assistant");

/** The pet's in-character reply to what the learner said. */
app.post<TurnBody>("/api/reply", async (req, reply) => {
  const text = req.body?.text?.trim();
  if (!text) return reply.code(400).send({ error: "text is required" });
  const pet = await petReply([...cleanHistory(req.body.history), { role: "user", content: text }]);
  req.log.info(`reply ${pet.ms}ms`);
  return { ...pet.data, ms: pet.ms };
});

/** Grammar correction card for what the learner said. */
app.post<TurnBody>("/api/correct", async (req, reply) => {
  const text = req.body?.text?.trim();
  if (!text) return reply.code(400).send({ error: "text is required" });
  const c = await correct(text, cleanHistory(req.body.history));
  req.log.info(`correct ${c.ms}ms`);
  return { ...c.data, ms: c.ms };
});

// ── voice test: read sentences with deliberate mistakes; does STT keep them? ──
const voiceTestDir = path.resolve(import.meta.dirname, "../data/voice-tests");

app.get("/api/voice-test", () => testCases.map(({ said, romaji, mistake }) => ({ said, romaji, mistake })));

app.post<{ Params: { n: string } }>("/api/voice-test/:n", async (req, reply) => {
  const index = Number(req.params.n) - 1;
  const c = testCases[index];
  if (!c) return reply.code(404).send({ error: "no such test sentence" });
  const pcm = req.body as Buffer;
  if (!Buffer.isBuffer(pcm) || pcm.length < 3200) return reply.code(400).send({ error: "send at least 0.1s of 16-bit PCM audio" });
  const rate = Number(req.headers["x-sample-rate"] ?? 16000);
  const result = await transcribe(padSilence(int16ToFloat32(pcm), rate), rate);
  const verdict = score(c, result.text);
  const file = await saveRecording(voiceTestDir, index, pcm, rate, result.text, verdict);
  req.log.info(`voice test #${index + 1}: ${verdict} (${result.ms}ms) saved ${file}`);
  return { transcript: result.text, verdict, ms: result.ms };
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
