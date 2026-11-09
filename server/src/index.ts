import { existsSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify from "fastify";
import { hermesHealth } from "./ask.ts";
import { nekoProfile, profileHealth } from "./hermes.ts";
import { padSilence } from "./audio.ts";
import * as challenge from "./challenge.ts";
import { config } from "./config.ts";
import { attach, learnerLocation, sensorAlert } from "./hub.ts";
import type { ChatMessage } from "./llm.ts";
import { mqttHealth } from "./mqtt.ts";
import { startSensors } from "./sensors.ts";
import { listNotes, readNote } from "./notes.ts";
import { logReview } from "./records.ts";
import { int16ToFloat32, transcribe } from "./stt.ts";
import { listVoices, speak } from "./tts.ts";
import { petTurn } from "./tutor.ts";
import { saveRecording, score, testCases } from "./voicetest.ts";
import type { ReviewAttempt, ReviewResult } from "../../shared/protocol.ts";
import { clientIp } from "./location.ts";

const app = Fastify({ logger: { level: process.env.NEKO_LOG_LEVEL ?? "info" }, disableRequestLogging: true, bodyLimit: 20 * 1024 * 1024 });

app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

// The pet app (built from web/) at "/", the Phase 1 lab page at "/lab.html".
const webDist = path.resolve(import.meta.dirname, "../../web/dist");
if (!existsSync(webDist)) app.log.warn(`web app not built (${webDist} missing): run "npm run build" in web/`);
app.register(fastifyStatic, { root: [webDist, path.resolve(import.meta.dirname, "../public")].filter(existsSync) });

// The pet protocol (see shared/protocol.ts).
await app.register(fastifyWebsocket, { options: { maxPayload: 4 * 1024 * 1024 } });
app.get("/ws", { websocket: true }, (socket, req) => attach(socket, app.log, clientIp(req.headers, req.socket.remoteAddress)));

/** Where the learner is (from the board's public IP), for the world tools' where_am_i. null = not known yet. */
app.get("/api/location", async () => learnerLocation() ?? { client: null, location: null });

/** Speech → text. Body: raw 16-bit mono PCM; sample rate in `x-sample-rate` (default 16000). */
app.post("/api/stt", async (req, reply) => {
  const pcm = req.body as Buffer;
  if (!Buffer.isBuffer(pcm) || pcm.length < 3200) return reply.code(400).send({ error: "send at least 0.1s of 16-bit PCM audio" });
  const rate = Number(req.headers["x-sample-rate"] ?? 16000);
  const result = await transcribe(padSilence(int16ToFloat32(pcm), rate), rate);
  req.log.info(`stt ${result.ms}ms (${(pcm.length / 2 / rate).toFixed(1)}s audio): ${result.text}`);
  return result;
});

type TurnBody = { Body: { text: string; history?: ChatMessage[] } };
const cleanHistory = (h?: ChatMessage[]) => (h ?? []).filter((m) => m.role === "user" || m.role === "assistant");

/** The pet's in-character reply to what the learner said, with its check of the sentence. */
app.post<TurnBody>("/api/reply", async (req, reply) => {
  const text = req.body?.text?.trim();
  if (!text) return reply.code(400).send({ error: "text is required" });
  const turn = await petTurn([...cleanHistory(req.body.history), { role: "user", content: text }]);
  req.log.info(`reply + check ${turn.ms}ms`);
  return { ...turn.reply, correction: turn.correction, ms: turn.ms };
});

// ── translation challenge (see shared/protocol.ts) ──
app.get("/api/challenge", () => challenge.current());
app.post("/api/challenge/new", () => challenge.fresh());
app.post<{ Params: { id: string }; Body: { text?: string } }>("/api/challenge/:id/answer", async (req) => {
  const r = await challenge.grade(Number(req.params.id), String(req.body?.text ?? ""));
  req.log.info(`challenge #${req.params.id} scored ${r.total}`);
  return r;
});

// ── review and notes (see shared/protocol.ts) ──
// The page sends the earlier sentence along: neko keeps no history to look it up in.
app.post<{ Body: Partial<ReviewAttempt> }>("/api/review/practice", async (req, reply) => {
  const b = req.body ?? {};
  const answer = String(b.answer ?? "").trim();
  const [point, said, original, fix] = [b.point, b.said, b.original, b.fix].map((v) => String(v ?? "").trim());
  if (!answer || !said) return reply.code(400).send({ error: "said and answer are required" });
  // ねこ checks the answer the same way it checks a sentence in conversation.
  const { correction } = await petTurn([{ role: "user", content: answer }]);
  // The old wrong part is still there (and the fix isn't just a longer version of it).
  const still = !!original && answer.includes(original) && !fix.includes(original);
  const ok = correction.is_correct && !still;
  logReview(point, said, answer, ok);
  req.log.info(`review "${point}": ${ok ? "right" : "not yet"}`);
  const result: ReviewResult = { ok, answer, mistakes: correction.mistakes, still };
  return result;
});
app.get("/api/notes", () => listNotes());
app.get<{ Querystring: { path?: string } }>("/api/notes/file", async (req, reply) => {
  const text = await readNote(String(req.query.path ?? ""));
  if (text === null) return reply.code(404).send({ error: "no such note" });
  return reply.type("text/markdown; charset=utf-8").send(text);
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
    check("hermes", hermesHealth),
    check("hermes_neko", () => profileHealth(nekoProfile())),
    ...(config.mqttUrl ? [check("zigbee2mqtt", mqttHealth)] : []),
  ]);
  return { level: config.level, ...Object.fromEntries(results) };
});

await app.listen({ host: config.host, port: config.port });

// Make today's challenge ahead of time so the card loads at once; check again every half hour for a new day.
const makeDaily = () => challenge.ensureDaily().catch((err) => app.log.warn(`daily challenge not ready: ${(err as Error).message}`));
makeDaily();
setInterval(makeDaily, 30 * 60_000).unref();

if (config.vaultDir) app.log.info(`learning records are appended to ${config.vaultDir}/Daily/`);

// Home sensors through Zigbee2MQTT: ねこ reacts when the front door opens or the window shakes.
if (config.mqttUrl) startSensors(sensorAlert, app.log);
