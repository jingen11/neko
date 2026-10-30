import { Application } from "pixi.js";
import type { Anim, CorrectionMsg, ServerMessage } from "../../shared/protocol.ts";
import { AudioIO } from "./audio.ts";
import { Net } from "./net.ts";
import { Pet } from "./pet.ts";
import "./style.css";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const textEl = $<HTMLTextAreaElement>("text");
const talkBtn = $<HTMLButtonElement>("talk");
const sendBtn = $<HTMLButtonElement>("send");

const audio = new AudioIO();
let pet: Pet;
let recording = false;
let thinking = false;
let lastUserEntry: HTMLElement | null = null;

// ── start: audio needs a user gesture, so wait for a tap ─────
$("wakeBtn").addEventListener("click", async () => {
  $("wake").classList.add("hidden");
  await audio.init();
  const app = new Application();
  await app.init({ resizeTo: $("stage"), backgroundAlpha: 0, antialias: true, resolution: devicePixelRatio, autoDensity: true });
  $("stage").appendChild(app.canvas);
  pet = new Pet(app, () => audio.level(), () => net.send({ type: "touch", gesture: "pet" }));
  net.connect();
});

const net = new Net({
  status: (on) => {
    $("conn").className = "dot " + (on ? "on" : "off");
    $("conn").title = on ? "connected" : "reconnecting…";
  },
  audio: (frame) => audio.voicePush(frame),
  message: onMessage,
});

function onMessage(m: ServerMessage) {
  switch (m.type) {
    case "state":
      pet?.setState(m.anim, m.mood);
      $("petName").textContent = $("wakeName").textContent = m.stats.name;
      $("fullBar").style.width = `${100 - m.stats.hunger}%`;
      $("joyBar").style.width = `${m.stats.happiness}%`;
      $("streak").textContent = String(m.stats.streak);
      $("today").textContent = String(m.stats.practicedToday);
      break;
    case "say":
      petEntry(m.ja, m.en);
      break;
    case "audio_start":
      audio.voiceStart(m.rate);
      break;
    case "audio_end":
      audio.voiceEnd();
      break;
    case "heard":
      setTalk("idle");
      if (!m.text) return toast("I didn't catch that — try again?");
      textEl.value = m.text;
      textEl.focus();
      break;
    case "correction":
      thinking = false;
      sendBtn.disabled = false;
      showCorrection(m);
      break;
    case "error":
      lastUserEntry?.querySelector(".check.wait")?.remove();
      thinking = false;
      sendBtn.disabled = false;
      setTalk("idle");
      toast(m.message);
      break;
  }
}

// ── push to talk ─────────────────────────────────────────────
async function startTalk() {
  if (recording || !pet) return;
  recording = true;
  audio.stopVoice(); // interrupt the pet
  setTalk("rec");
  try {
    net.send({ type: "listen_start", rate: audio.sampleRate });
    await audio.startMic((pcm) => net.sendAudio(pcm));
  } catch (err) {
    recording = false;
    setTalk("idle");
    net.send({ type: "listen_end" });
    toast("Microphone unavailable: " + (err as Error).message + " — open the page via http://localhost (SSH tunnel if remote).");
  }
}

function stopTalk() {
  if (!recording) return;
  recording = false;
  audio.stopMic();
  net.send({ type: "listen_end" });
  setTalk("wait");
}

function setTalk(s: "idle" | "rec" | "wait") {
  talkBtn.classList.toggle("rec", s === "rec");
  talkBtn.disabled = s === "wait";
  talkBtn.textContent = s === "rec" ? "🔴 Listening… release to stop" : s === "wait" ? "⏳ Transcribing…" : "🎤 Hold to talk";
}

talkBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  startTalk();
});
for (const ev of ["pointerup", "pointerleave", "pointercancel"]) talkBtn.addEventListener(ev, stopTalk);
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && e.target !== textEl && !e.repeat) {
    e.preventDefault();
    startTalk();
  }
});
document.addEventListener("keyup", (e) => {
  if (e.code === "Space" && e.target !== textEl) {
    e.preventDefault();
    stopTalk();
  }
});

// ── send a sentence ──────────────────────────────────────────
function send() {
  const text = textEl.value.trim();
  if (!text || thinking) return;
  thinking = true;
  sendBtn.disabled = true;
  textEl.value = "";
  net.send({ type: "confirm", text });
  lastUserEntry = userEntry(text);
}
sendBtn.addEventListener("click", send);
textEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});

/** The correction goes under your own message: a small tick when it's right, the fix when it isn't. */
function showCorrection(c: CorrectionMsg) {
  const e = lastUserEntry;
  if (!e) return;
  e.querySelector(".check")?.remove();
  const natural = c.natural && c.natural !== c.corrected && c.natural !== c.text ? `<div class="natural">💡 ${esc(c.natural)}</div>` : "";
  const html = c.is_correct
    ? `<div class="check good">✅ correct${natural}</div>`
    : `<div class="check bad"><div class="corrected">✏️ ${esc(c.corrected)}</div><ul>${c.mistakes
        .map((m) => `<li><del>${esc(m.original)}</del> → <ins>${esc(m.fix)}</ins> <b>${esc(m.grammar_point)}</b><br>${esc(m.explanation)}</li>`)
        .join("")}</ul>${natural}</div>`;
  e.insertAdjacentHTML("beforeend", html);
  scrollChat();
}

// ── chat thread ──────────────────────────────────────────────
const chat = $("chat");

function userEntry(text: string) {
  const e = document.createElement("div");
  e.className = "msg me";
  e.innerHTML = `<div class="ja">${esc(text)}</div><div class="check wait">checking…</div>`;
  chat.append(e);
  scrollChat();
  return e;
}

/** The pet's line: Japanese, with the English hidden behind a tap and replay buttons on the latest line. */
function petEntry(ja: string, en: string) {
  chat.querySelectorAll(".msg.pet .replay").forEach((r) => r.remove()); // only the latest line can be replayed
  const e = document.createElement("div");
  e.className = "msg pet";
  e.innerHTML = `<div class="ja">${esc(ja)}</div>
    <div class="row small"><button class="enBtn">EN</button><button class="replay again">🔊</button><button class="replay slow">🐢</button></div>
    <div class="en hidden">${esc(en)}</div>`;
  e.querySelector(".enBtn")!.addEventListener("click", () => e.querySelector(".en")!.classList.toggle("hidden"));
  e.querySelector(".again")!.addEventListener("click", () => net.send({ type: "repeat" }));
  e.querySelector(".slow")!.addEventListener("click", () => net.send({ type: "repeat", slow: true }));
  chat.append(e);
  scrollChat();
}

function scrollChat() {
  chat.scrollTop = chat.scrollHeight;
}

// ── debug: force animations (open /?debug) ───────────────────
if (new URLSearchParams(location.search).has("debug")) {
  $("debug").classList.remove("hidden");
  const anims: Anim[] = ["idle", "listen", "think", "talk", "happy", "sad", "eat", "sleep", "petted", "sleepy", "sick", "angry"];
  const btns = $("debugBtns");
  const add = (label: string, fn: () => void) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", () => {
      btns.querySelectorAll("button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      fn();
    });
    btns.append(b);
  };
  add("auto", () => pet?.force(null));
  for (const a of anims) add(a, () => pet?.force(a));
  add("yawn now", () => pet?.yawnNow());
}

// ── helpers ──────────────────────────────────────────────────
let toastTimer: number | undefined;
function toast(msg: string) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.add("hidden"), 4000);
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
