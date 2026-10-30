import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import type { Anim, ClientMessage, Hello, Mood, ServerMessage } from "../../shared/protocol.ts";
import { int16ToFloat32, padSilence, resample, wavToPcm16 } from "./audio.ts";
import type { ChatMessage } from "./llm.ts";
import * as pet from "./pet.ts";
import { transcribe } from "./stt.ts";
import { speak } from "./tts.ts";
import { correct, petReply } from "./tutor.ts";

/**
 * The pet's "brain" for connected clients (browser now, ESP32 board later).
 * There is one pet: its state is broadcast to every client; a conversation turn's
 * voice goes to the client that started it.
 */

interface Client {
  id: string;
  ws: WebSocket;
  hello?: Hello;
  mic: Buffer[] | null;
  micRate: number;
  micBytes: number;
  busy: boolean;
}

const MAX_MIC_SECONDS = 30;
const AUDIO_CHUNK_SAMPLES = 4096;

const clients = new Set<Client>();
const history: ChatMessage[] = []; // shared conversation (the pet remembers the last few turns)
let lastSay: { ja: string; en: string; mood: Mood } | null = null;
let revertTimer: NodeJS.Timeout | undefined;
let eatNext = false; // show the "eat" animation once the pet finishes talking
let log: FastifyBaseLogger;

const send = (c: Client, msg: ServerMessage) => c.ws.readyState === c.ws.OPEN && c.ws.send(JSON.stringify(msg));
const sendAll = (msg: ServerMessage) => clients.forEach((c) => send(c, msg));

/** Broadcast the pet's state. With `holdMs`, return to the resting state afterwards. */
function setState(anim?: Anim, mood?: Mood, holdMs?: number) {
  clearTimeout(revertTimer);
  revertTimer = undefined;
  const stats = pet.stats();
  const resting = pet.restingMood(stats);
  if (!anim && eatNext) {
    // finished talking after a practice turn: eat, then rest
    eatNext = false;
    return setState("eat", "happy", 1800);
  }
  sendAll({ type: "state", anim: anim ?? pet.restingAnim(resting), mood: mood ?? resting, stats });
  if (holdMs) revertTimer = setTimeout(() => setState(), holdMs);
}

// Stats change with time (hunger, bedtime), so refresh resting clients every minute.
setInterval(() => {
  if (clients.size && !revertTimer) setState();
}, 60_000).unref();

/** The pet says `ja`: text to every client, voice to `to`. */
async function say(to: Client, ja: string, en: string, mood: Mood, slow = false) {
  const id = randomUUID();
  lastSay = { ja, en, mood };
  sendAll({ type: "say", id, ja, en, mood });
  const { wav } = await speak(ja, { speed: slow ? 0.75 : undefined });
  const voice = wavToPcm16(wav);
  const rate = to.hello?.audioRate ?? voice.rate;
  const pcm = resample(voice.pcm, voice.rate, rate);
  send(to, { type: "audio_start", sayId: id, rate });
  for (let i = 0; i < pcm.length; i += AUDIO_CHUNK_SAMPLES) {
    const chunk = pcm.subarray(i, i + AUDIO_CHUNK_SAMPLES);
    if (to.ws.readyState === to.ws.OPEN) to.ws.send(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength), { binary: true });
  }
  send(to, { type: "audio_end", sayId: id });
  setState("talk", mood, Math.round((pcm.length / rate) * 1000) + 300);
}

async function onListenEnd(c: Client) {
  const parts = c.mic;
  c.mic = null;
  if (!parts) return;
  const buf = Buffer.concat(parts);
  setState();
  if (buf.length < c.micRate * 0.2) return send(c, { type: "heard", text: "", ms: 0 }); // < 0.1 s
  const pcm = new Int16Array(buf.length >> 1);
  for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(i * 2);
  const r = await transcribe(padSilence(int16ToFloat32(pcm), c.micRate), c.micRate);
  log.info(`heard (${r.ms}ms): ${r.text}`);
  send(c, { type: "heard", text: r.text, ms: r.ms });
}

/** One conversation turn: the pet replies (and speaks) while the correction is prepared in parallel. */
async function onConfirm(c: Client, text: string) {
  text = text.trim();
  if (!text) return;
  if (c.busy) return send(c, { type: "error", message: "The pet is still thinking about your last sentence." });
  c.busy = true;
  setState("think", "curious", 60_000);
  const ctx = history.slice(-12);
  const t0 = performance.now();
  try {
    await Promise.all([
      petReply([...ctx, { role: "user", content: text }]).then(async ({ data, ms }) => {
        history.push({ role: "user", content: text }, { role: "assistant", content: data.ja });
        history.splice(0, Math.max(0, history.length - 24));
        log.info(`reply ${ms}ms`);
        await say(c, data.ja, data.en, data.mood);
        log.info(`pet speaking after ${Math.round(performance.now() - t0)}ms`);
      }),
      correct(text, ctx).then(({ data, ms }) => {
        log.info(`correction ${ms}ms`);
        send(c, { type: "correction", text, ...data });
        pet.recordPractice(text, data.is_correct, data.mistakes.length);
        if (revertTimer) eatNext = true; // still talking: eat afterwards
        else setState("eat", "happy", 1800);
      }),
    ]);
  } catch (err) {
    log.error({ err }, "turn failed");
    send(c, { type: "error", message: (err as Error).message });
    setState("sad", "worried", 2000);
  } finally {
    c.busy = false;
  }
}

async function onTouch(c: Client) {
  const counted = pet.petted();
  setState("petted", "happy", 2000);
  if (counted && !pet.isBedtime() && !c.busy) await say(c, "にゃーん♪", "Meow♪", "happy");
}

async function onMessage(c: Client, msg: ClientMessage) {
  switch (msg.type) {
    case "hello": {
      c.hello = msg;
      log.info(`${msg.client} connected (${msg.deviceId}), voice at ${msg.audioRate} Hz`);
      const stats = pet.stats();
      const mood = pet.restingMood(stats);
      setState();
      const g = pet.greeting(mood, stats);
      return say(c, g, pet.greetingEn[g] ?? "", mood);
    }
    case "listen_start":
      c.mic = [];
      c.micBytes = 0;
      c.micRate = msg.rate || 16000;
      return setState("listen", "curious", MAX_MIC_SECONDS * 1000);
    case "listen_end":
      return onListenEnd(c);
    case "confirm":
      return onConfirm(c, msg.text);
    case "touch":
      return onTouch(c);
    case "repeat":
      if (lastSay) return say(c, lastSay.ja, lastSay.en, lastSay.mood, msg.slow);
      return;
  }
}

export function attach(ws: WebSocket, logger: FastifyBaseLogger) {
  log = logger;
  const c: Client = { id: randomUUID(), ws, mic: null, micRate: 16000, micBytes: 0, busy: false };
  clients.add(c);
  ws.on("message", (data, isBinary) => {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    if (isBinary) {
      // microphone audio
      if (c.mic && c.micBytes + buf.length <= MAX_MIC_SECONDS * c.micRate * 2) {
        c.mic.push(buf);
        c.micBytes += buf.length;
      }
      return;
    }
    let msg: ClientMessage;
    try {
      msg = JSON.parse(buf.toString("utf8"));
    } catch {
      return send(c, { type: "error", message: "invalid JSON" });
    }
    onMessage(c, msg).catch((err) => {
      log.error({ err }, `failed to handle ${msg.type}`);
      send(c, { type: "error", message: (err as Error).message });
    });
  });
  ws.on("close", () => {
    clients.delete(c);
    log.info(`${c.hello?.client ?? "client"} disconnected`);
  });
}
