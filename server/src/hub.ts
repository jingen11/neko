import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import type { Anim, ClientMessage, Hello, Mood, ServerMessage } from "../../shared/protocol.ts";
import { int16ToFloat32, padSilence, resample, wavToPcm16 } from "./audio.ts";
import type { ChatMessage } from "./llm.ts";
import * as pet from "./pet.ts";
import { transcribe } from "./stt.ts";
import { speak } from "./tts.ts";
import { answerQuestion, askHistory, resetConversation, type QuestionKind } from "./ask.ts";
import * as records from "./records.ts";
import type { SensorAlert } from "./sensors.ts";
import { petReply, petTurn } from "./tutor.ts";
import { isPrivate, locate, noteLocation, type Location } from "./location.ts";

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
  ip: string; // its public address (or LAN address at home), from the WebSocket request
  location?: Location; // where it is, from ip (location.ts)
  /** The board's `net` message: `arrived` settles when it comes, `located` when its address is looked up. */
  net: { arrived: Promise<void>; arrive: () => void; located?: Promise<void> };
}

// The Ask conversations are shared by every web client (a reload or a second tab sees the same one), so
// there's one question per conversation at a time, and its answer goes to every web client.
const asking = new Set<QuestionKind>();

const MAX_MIC_SECONDS = 30;
const AUDIO_CHUNK_SAMPLES = 4096;

const clients = new Set<Client>();
const history: ChatMessage[] = []; // shared conversation (the pet remembers the last few turns)
let lastSay: { ja: string; en: string; mood: Mood } | null = null;
/** Recent pet lines by id, so a later "reveal" can be recorded as a listening miss (once per line). */
const recentSays = new Map<string, { ja: string; en: string; revealed: boolean }>();
let revertTimer: NodeJS.Timeout | undefined;
let eatNext = false; // show the "eat" animation once the pet finishes talking
let log: FastifyBaseLogger;

const send = (c: Client, msg: ServerMessage) => c.ws.readyState === c.ws.OPEN && c.ws.send(JSON.stringify(msg));
const sendAll = (msg: ServerMessage) => clients.forEach((c) => send(c, msg));
const sendWeb = (msg: ServerMessage) => clients.forEach((c) => c.hello?.client === "web" && send(c, msg));

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
  sendAll({ type: "state", anim: anim ?? pet.restingAnim(resting, stats), mood: mood ?? resting, stats });
  if (holdMs) revertTimer = setTimeout(() => setState(), holdMs);
}

// Stats change with time (hunger, bedtime), so refresh resting clients every minute.
setInterval(() => {
  if (clients.size && !revertTimer) setState();
}, 60_000).unref();

/** The pet says `ja`: text to every client, voice to `to` (or to every client when `to` is null). */
async function say(to: Client | null, ja: string, en: string, mood: Mood, slow = false) {
  const id = randomUUID();
  lastSay = { ja, en, mood };
  recentSays.set(id, { ja, en, revealed: false });
  if (recentSays.size > 50) recentSays.delete(recentSays.keys().next().value!);
  sendAll({ type: "say", id, ja, en, mood });
  const { wav } = await speak(ja, { speed: slow ? 0.75 : undefined });
  const voice = wavToPcm16(wav);
  let seconds = voice.pcm.length / voice.rate;
  for (const c of to ? [to] : [...clients]) {
    const rate = c.hello?.audioRate ?? voice.rate;
    const pcm = resample(voice.pcm, voice.rate, rate);
    seconds = pcm.length / rate;
    send(c, { type: "audio_start", sayId: id, rate });
    for (let i = 0; i < pcm.length; i += AUDIO_CHUNK_SAMPLES) {
      const chunk = pcm.subarray(i, i + AUDIO_CHUNK_SAMPLES);
      if (c.ws.readyState === c.ws.OPEN) c.ws.send(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength), { binary: true });
    }
    send(c, { type: "audio_end", sayId: id });
  }
  setState("talk", mood, Math.round(seconds * 1000) + 300);
}

/** A home sensor fired (sensors.ts): every client gets a banner, and ねこ looks up and says so, even at night. */
export async function sensorAlert(a: SensorAlert) {
  if (!clients.size) return;
  sendAll({ type: "sensor", event: a.event, device: a.device, label: a.label, at: a.at });
  setState("listen", "worried", 1500);
  await say(null, a.ja, a.en, "worried");
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

/**
 * One conversation turn, two calls at once:
 * - the grammar check: llama.cpp, as before (petTurn; its own reply is only how it understood the sentence)
 * - what ねこ says: Hermes's neko profile, which can look things up (petReply)
 * If Hermes fails, the check still shows and ねこ looks sick instead of replying.
 */
async function onConfirm(c: Client, text: string) {
  text = text.trim();
  if (!text) return;
  if (c.busy) return send(c, { type: "error", message: "The pet is still thinking about your last sentence." });
  c.busy = true;
  setState("think", "curious", 130_000); // a Hermes reply can include tool calls
  try {
    const turn: ChatMessage[] = [...history.slice(-12), { role: "user", content: text }];
    const [checked, spoken] = await Promise.allSettled([petTurn(turn), petReply(turn)]);
    if (checked.status === "rejected") throw checked.reason;
    const { correction, ms } = checked.value;
    log.info({ said: text, mistakes: correction.mistakes }, `check ${ms}ms`);
    send(c, { type: "correction", text, ...correction });
    pet.recordPractice(correction.is_correct);
    if (spoken.status === "rejected") {
      log.error({ err: spoken.reason }, "Hermes reply failed");
      records.logTurn(text, correction);
      send(c, { type: "error", message: `ねこ is feeling sick and can't reply right now (${(spoken.reason as Error).message})` });
      setState("sick", "worried", 5000);
      return;
    }
    const { reply } = spoken.value;
    log.info({ reply: reply.ja }, `reply ${spoken.value.ms}ms`);
    history.push({ role: "user", content: text }, { role: "assistant", content: reply.ja });
    history.splice(0, Math.max(0, history.length - 24));
    records.logTurn(text, correction, reply);
    await say(c, reply.ja, reply.en, reply.mood);
    if (revertTimer) eatNext = true; // still talking: eat afterwards
    else setState("eat", "happy", 1800);
  } catch (err) {
    log.error({ err }, "turn failed");
    send(c, { type: "error", message: (err as Error).message });
    setState("sad", "worried", 2000);
  } finally {
    c.busy = false;
  }
}

/** A question (ask_grammar or ask_casual): the cat thinks meanwhile; the answer is sent back and written to the vault. */
async function onAsk(c: Client, question: string, kind: QuestionKind) {
  question = question.trim();
  if (!question) return;
  if (asking.has(kind)) return send(c, { type: "error", kind, message: "Still looking into your last question." });
  asking.add(kind);
  setState("think", "curious", 200_000);
  try {
    const a = await answerQuestion(question, kind);
    log.info(`${kind} question, answered by Hermes (${a.model}) in ${a.ms}ms`);
    sendWeb({ type: "answer", kind, question, text: a.text, model: a.model, ms: a.ms });
    records.logAsk(question, a.text, `Hermes (${a.model})`);
    setState("happy", "happy", 1500);
  } catch (err) {
    log.error({ err }, "question failed");
    sendWeb({ type: "error", kind, message: `Couldn't answer that: ${(err as Error).message}` });
    setState("sad", "worried", 2000);
  } finally {
    asking.delete(kind);
  }
}

async function onTouch(c: Client) {
  // petting it awake at night makes it grumpy, then it goes back to sleep
  if (pet.isBedtime()) return setState("angry", "worried", 1800);
  const counted = pet.petted();
  setState("petted", "happy", 2000);
  if (counted && !c.busy) await say(c, "にゃーん♪", "Meow♪", "happy");
}

async function onMessage(c: Client, msg: ClientMessage) {
  switch (msg.type) {
    case "hello": {
      c.hello = msg;
      if (c.location) noteLocation(c.location, msg.client); // located before it said what it is
      log.info(`${msg.client} connected (${msg.deviceId}), voice at ${msg.audioRate} Hz`);
      if (msg.client === "web") for (const kind of ["grammar", "casual"] as const) send(c, askHistory(kind, asking.has(kind)));
      // ねこ greets by the learner's hour, so wait until the board has said where it is
      if (msg.client === "board") await boardLocated(c);
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
    case "net":
      // only a public address says where the board is; a 100.x or LAN one from the connection doesn't
      if (typeof msg.publicIp === "string" && !isPrivate(msg.publicIp) && msg.publicIp !== c.ip) {
        c.ip = msg.publicIp;
        c.net.located = locateClient(c, msg.publicIp);
      }
      c.net.arrive();
      return;
    case "touch":
      return onTouch(c);
    case "repeat":
      if (!lastSay) return;
      records.logListening(msg.slow ? "slow" : "repeat", lastSay);
      return say(c, lastSay.ja, lastSay.en, lastSay.mood, msg.slow);
    case "reveal": {
      const line = recentSays.get(msg.sayId);
      if (line && !line.revealed) {
        line.revealed = true;
        records.logListening("english", line);
      }
      return;
    }
    case "ask_grammar":
      return onAsk(c, msg.text, "grammar");
    case "ask_casual":
      return onAsk(c, msg.text, "casual");
    case "ask_reset":
      if (msg.kind === "grammar" || msg.kind === "casual") resetConversation(msg.kind);
      return;
  }
}

let lastLocated: Client | null = null;

/**
 * A board sends `net` (its public IP) right after hello, and the box looks it up. Wait for both before
 * choosing the greeting, which goes by the learner's hour: up to 1 s for the message (none comes when
 * the board isn't on Tailscale), then up to 2 s for the lookup.
 */
async function boardLocated(c: Client) {
  const arrived = await Promise.race([c.net.arrived.then(() => true), sleep(1000).then(() => false)]);
  if (arrived && c.net.located) await Promise.race([c.net.located, sleep(2000)]);
}

/** Locate a client by an address: the connection's, or the public IP the board reports (`net`). */
function locateClient(c: Client, ip: string): Promise<void> {
  return locate(ip)
    .then((loc) => {
      if (!loc) return;
      c.location = loc;
      lastLocated = c;
      noteLocation(loc, c.hello?.client);
      const where = [loc.city, loc.region, loc.country].filter(Boolean).join(", ");
      log.info(`${c.hello?.client ?? "client"} (${ip}) is ${loc.home ? "at home" : "away"}: ${where} (${loc.timeZone || `UTC${loc.utcOffset}`})`);
    })
    .catch((err) => log.warn({ err }, `couldn't locate ${ip}`));
}

/**
 * Where the learner is: the connected board's location (it travels with them), else the client located
 * most recently. For the world tools' where_am_i (GET /api/location).
 */
export function learnerLocation(): { client: string; location: Location } | null {
  const board = [...clients].find((c) => c.hello?.client === "board" && c.location);
  const c = board ?? lastLocated;
  return c?.location ? { client: c.hello?.client ?? "web", location: c.location } : null;
}

export function attach(ws: WebSocket, logger: FastifyBaseLogger, ip: string) {
  log = logger;
  let arrive = () => {};
  const arrived = new Promise<void>((resolve) => (arrive = resolve));
  const c: Client = { id: randomUUID(), ws, mic: null, micRate: 16000, micBytes: 0, busy: false, ip, net: { arrived, arrive } };
  clients.add(c);
  locateClient(c, ip);
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
