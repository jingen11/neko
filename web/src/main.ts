import { Application } from "pixi.js";
import type { AnswerMsg, Anim, CorrectionMsg, Mood, PetStats, ServerMessage } from "../../shared/protocol.ts";

type AskKind = AnswerMsg["kind"];
import { AudioIO } from "./audio.ts";
import { initChallenge } from "./challenge.ts";
import { initReview } from "./review.ts";
import { Net } from "./net.ts";
import { Pet } from "./pet.ts";
import "./style.css";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const textEl = $<HTMLTextAreaElement>("text");
const talkBtn = $<HTMLButtonElement>("talk");
const sendBtn = $<HTMLButtonElement>("send");
const askBtn = $<HTMLButtonElement>("askBtn");
const chatBtn = $<HTMLButtonElement>("chatBtn");
const chat = $("chat");

// Mirrors server/src/pet.ts: one practised sentence takes FEED_PER_TURN off hunger; below SAD_BELOW happiness it's sad.
const FEED_PER_TURN = 15;
const SAD_BELOW = 30;

const params = new URLSearchParams(location.search);
const demo = params.has("demo");
const audio = new AudioIO();
let pet: Pet | undefined;
let awake = false;
let recording = false;
let thinking = false;
let mood: Mood = "sleepy";
let anim: Anim = "sleep";
let lastUserEntry: HTMLElement | null = null;
let askMode: AskKind | null = null; // the composer sends a question instead of a practice sentence
let pendingAnswer: HTMLElement | null = null; // the answer card waiting for Hermes

// ── the cat: PixiJS starts at once so the sleeping cat shows before waking ──
(async () => {
  const app = new Application();
  await app.init({ resizeTo: $("stage"), backgroundAlpha: 0, antialias: true, resolution: devicePixelRatio, autoDensity: true });
  $("stage").appendChild(app.canvas);
  pet = new Pet(app, () => (awake && !demo ? audio.level() : 0), petCat);
  pet.setState(anim, mood); // whatever the server last said (or asleep before waking)
})();

function petCat() {
  if (awake) net.send({ type: "touch", gesture: "pet" });
}
$("petBtn").addEventListener("click", petCat);

// ── title: greeting by time of day, the date, and the one fact that matters now ──
function greet(h = new Date().getHours()) {
  return h >= 5 && h < 11 ? "おはよう" : h >= 11 && h < 18 ? "こんにちは" : "こんばんは";
}
$("greeting").firstChild!.textContent = `${greet()}、`;
$("date").textContent = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

function finding(s: PetStats): string {
  const toFull = Math.ceil(s.hunger / FEED_PER_TURN);
  if (mood === "sleepy") return `${s.name} is sleepy. A sentence or two, then let ${s.name} rest.`;
  if (s.hunger >= 70) return `${s.name} is hungry: ${plural(toFull, "sentence")} will fill ${s.name} up.`;
  if (s.practicedToday === 0)
    return s.streak ? `No practice yet today. One sentence makes it a ${s.streak + 1}-day streak.` : "No practice yet today.";
  return `${plural(s.practicedToday, "sentence")} today. ` + (toFull ? `${toFull} more and ${s.name} is full.` : `${s.name} is full.`);
}

function renderStats(s: PetStats) {
  for (const el of document.querySelectorAll(".petName")) el.textContent = s.name;
  const full = 100 - s.hunger;
  const toFull = Math.ceil(s.hunger / FEED_PER_TURN);
  for (const id of ["full", "joy", "streak", "today"]) $(id).classList.remove("skel");
  $("full").textContent = String(full);
  $("fullBar").style.width = `${full}%`;
  $("fullCap").textContent = toFull ? `${plural(toFull, "sentence")} to full` : "Full";
  $("fullCap").classList.toggle("low", s.hunger >= 70);
  $("joy").textContent = String(s.happiness);
  $("joyBar").style.width = `${s.happiness}%`;
  $("joyCap").textContent = s.happiness < SAD_BELOW ? `Sad below ${SAD_BELOW}` : `Sad below ${SAD_BELOW} · pet or practise to lift`;
  $("joyCap").classList.toggle("low", s.happiness < SAD_BELOW);
  $("streak").textContent = String(s.streak);
  $("streakUnit").textContent = s.streak === 1 ? " day" : " days";
  $("streakCap").textContent = s.practicedToday ? "Including today" : s.streak ? `Practise today to make it ${s.streak + 1}` : "Starts with your first sentence";
  $("today").textContent = String(s.practicedToday);
  $("todayUnit").textContent = s.practicedToday === 1 ? " sentence" : " sentences";
  $("finding").textContent = finding(s);
  if (s.level) {
    $("level").textContent = `JLPT ${s.level}`;
    $("level").hidden = false;
  }
}

/** What the cat is doing, in words, under the picture. */
function caption(anim: Anim, m: Mood): string {
  switch (anim) {
    case "listen": return "Listening";
    case "think": return "Thinking";
    case "talk": return "Talking";
    case "happy": return "Happy";
    case "eat": return "Eating";
    case "sleep": return "Asleep";
    case "petted": return "Purring";
    case "sleepy": return "Drowsy";
    case "sick": return "Weak with hunger";
    case "angry": return "Grumpy: woken up";
    case "sad": return m === "hungry" ? "Hungry" : "Sad";
    default: return "Sitting with you";
  }
}

// ── wake: audio needs a user gesture ─────────────────────────
function setAwake() {
  awake = true;
  $("wakeBtn").hidden = true;
  $("petBtn").hidden = false;
  for (const el of [talkBtn, sendBtn, askBtn, chatBtn, textEl]) el.disabled = false;
  $("chatEmpty").textContent = "Listening for the first line…";
}

$("wakeBtn").addEventListener("click", async () => {
  if (demo) return setAwake();
  await audio.init();
  setAwake();
  net.connect();
});

const net = new Net({
  status: (on) => {
    $("conn").dataset.state = on ? "on" : "retry";
    $("conn").textContent = on ? "Connected" : "Reconnecting…";
  },
  audio: (frame) => audio.voicePush(frame),
  message: onMessage,
});

function onMessage(m: ServerMessage) {
  switch (m.type) {
    case "state":
      mood = m.mood;
      anim = m.anim;
      renderStats(m.stats);
      pet?.setState(m.anim, m.mood);
      $("catState").textContent = caption(m.anim, m.mood);
      break;
    case "say":
      petEntry(m.id, m.ja, m.en);
      break;
    case "audio_start":
      audio.voiceStart(m.rate);
      break;
    case "audio_end":
      audio.voiceEnd();
      break;
    case "heard":
      setTalk("idle");
      if (!m.text) return toast("I didn't catch that. Try again?");
      textEl.value = m.text;
      textEl.focus();
      break;
    case "correction":
      thinking = false;
      sendBtn.disabled = false;
      showCorrection(m);
      break;
    case "answer":
      showAnswer(m);
      break;
    case "error":
      if (pendingAnswer?.classList.contains("wait") && m.message.startsWith("Couldn't answer")) {
        pendingAnswer.remove();
        pendingAnswer = null;
        if (askMode) sendBtn.disabled = false;
      }
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
  if (recording || !awake || demo) return;
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
    toast("Microphone unavailable: " + (err as Error).message + ". Open the page via http://localhost (SSH tunnel if remote).");
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
  talkBtn.textContent = s === "rec" ? "Listening… release to stop" : s === "wait" ? "Transcribing…" : "Hold to talk";
}

talkBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  startTalk();
});
for (const ev of ["pointerup", "pointerleave", "pointercancel"]) talkBtn.addEventListener(ev, stopTalk);
// Space anywhere but a text box or a button holds to talk
const ownsSpace = (t: EventTarget | null) => t instanceof HTMLElement && ["TEXTAREA", "INPUT", "BUTTON"].includes(t.tagName);
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !ownsSpace(e.target) && !e.repeat) {
    e.preventDefault();
    startTalk();
  }
});
document.addEventListener("keyup", (e) => {
  if (e.code === "Space" && recording) {
    e.preventDefault();
    stopTalk();
  }
});

// ── ask mode: the composer sends a question to Hermes instead of a practice sentence ──
// Ask grammar → ask_grammar (Hermes on Claude). Ask Hermes → ask_casual (Hermes on its local model), for
// chat and questions about your own progress ("what have I learnt this week?").
const ASK = {
  grammar: { btn: askBtn, label: "Grammar question", placeholder: "Ask about grammar, in English or Japanese… e.g. when do I use に vs で?", sr: "Your grammar question" },
  casual: { btn: chatBtn, label: "Question for Hermes", placeholder: "Ask Hermes anything… e.g. what have I learnt this week?", sr: "Your question for Hermes" },
} as const;

function setAskMode(kind: AskKind | null) {
  askMode = kind;
  for (const [k, v] of Object.entries(ASK)) v.btn.setAttribute("aria-pressed", String(k === kind));
  textEl.closest(".composer")!.classList.toggle("asking", !!kind);
  textEl.placeholder = kind ? ASK[kind].placeholder : "話してみて… or type here";
  textEl.lang = kind ? "" : "ja";
  $("text").previousElementSibling!.textContent = kind ? ASK[kind].sr : "Your reply in Japanese";
  sendBtn.textContent = kind ? "Ask" : "Send";
  sendBtn.disabled = kind ? !!pendingAnswer : thinking;
}
for (const [k, v] of Object.entries(ASK))
  v.btn.addEventListener("click", () => {
    setAskMode(askMode === k ? null : (k as AskKind));
    textEl.focus();
  });

function ask(text: string, kind: AskKind = "grammar") {
  if (pendingAnswer) return toast("Still looking into your last question.");
  net.send({ type: kind === "grammar" ? "ask_grammar" : "ask_casual", text });
  $("chatEmpty").hidden = true;
  const q = document.createElement("div");
  q.className = "msg me q";
  q.innerHTML = `<p class="label">${ASK[kind].label}</p><p class="text">${esc(text)}</p>`;
  const a = document.createElement("div");
  a.className = "msg answer wait";
  a.innerHTML = `<p class="label">Answer</p><div class="body"><p>Looking through your notes…</p></div>`;
  chat.append(q, a);
  pendingAnswer = a;
  scrollChat();
}

function showAnswer(m: AnswerMsg) {
  const a = pendingAnswer ?? chat.appendChild(Object.assign(document.createElement("div"), { className: "msg answer" }));
  pendingAnswer = null;
  a.classList.remove("wait");
  const from = m.source === "hermes" ? `Hermes · <b>${esc(m.model)}</b>, from your notes` : `<b>${esc(m.model)}</b>, the pet's own model (Hermes is unavailable)`;
  a.innerHTML = `<p class="label">Answer</p><div class="body">${markdown(m.text)}</div><p class="src">From ${from} · ${(m.ms / 1000).toFixed(1)} s</p>`;
  if (askMode) sendBtn.disabled = false;
  scrollChat();
}

// ── send a sentence ──────────────────────────────────────────
function send() {
  const text = textEl.value.trim();
  if (text && askMode && awake) {
    if (pendingAnswer) return toast("Still looking into your last question.");
    textEl.value = "";
    ask(text, askMode);
    setAskMode(null); // back to practice; the answer arrives in the thread
    return;
  }
  if (!text || thinking || !awake) return;
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

/** The correction goes under your own message: a small mark when it's right, the fix when it isn't. */
function showCorrection(c: CorrectionMsg) {
  const e = lastUserEntry;
  if (!e) return;
  e.querySelector(".check")?.remove();
  const natural =
    c.natural && c.natural !== c.corrected && c.natural !== c.text ? `<p class="natural">More natural: <span lang="ja">${esc(c.natural)}</span></p>` : "";
  const n = c.mistakes.length;
  const html = c.is_correct
    ? `<div class="check"><span class="pill good">Correct</span>${natural}</div>`
    : `<div class="check"><span class="pill bad">${n === 1 ? "1 fix" : `${n} fixes`}</span><p class="corrected" lang="ja">${esc(c.corrected)}</p><ul>${c.mistakes
        .map(
          (m) =>
            `<li><span lang="ja"><del>${esc(m.original)}</del> → <ins>${esc(m.fix)}</ins></span> <span class="point">${esc(m.grammar_point)}</span><br><span class="why">${esc(m.explanation)}</span></li>`,
        )
        .join("")}</ul>${natural}</div>`;
  e.insertAdjacentHTML("beforeend", html);
  if (!c.is_correct) review.add(c.text, c.corrected, c.mistakes);
  scrollChat();
}

// ── chat thread ──────────────────────────────────────────────
let sentences = 0;

function userEntry(text: string) {
  $("chatEmpty").hidden = true;
  const e = document.createElement("div");
  e.className = "msg me";
  e.innerHTML = `<p class="ja" lang="ja">${esc(text)}</p><p class="check wait">Checking…</p>`;
  chat.append(e);
  $("turnCount").textContent = `${plural(++sentences, "sentence")} this visit`;
  scrollChat();
  return e;
}

/** The cat's line: Japanese, with the English behind a tap and replay on the latest line only. */
function petEntry(id: string, ja: string, en: string) {
  $("chatEmpty").hidden = true;
  chat.querySelectorAll(".msg.pet .replay").forEach((r) => r.remove());
  const e = document.createElement("div");
  e.className = "msg pet";
  e.innerHTML = `<p class="ja" lang="ja">${esc(ja)}</p>
    <p class="en" hidden>${esc(en)}</p>
    <div class="msg-tools"><button class="chip-btn enBtn" type="button" aria-pressed="false">English</button><button class="chip-btn replay again" type="button">Again</button><button class="chip-btn replay slow" type="button">Slowly</button></div>`;
  const enBtn = e.querySelector<HTMLButtonElement>(".enBtn")!;
  enBtn.addEventListener("click", () => {
    const p = e.querySelector<HTMLElement>(".en")!;
    p.hidden = !p.hidden;
    enBtn.setAttribute("aria-pressed", String(!p.hidden));
    if (!p.hidden) net.send({ type: "reveal", sayId: id }); // recorded as a listening miss
  });
  e.querySelector(".again")!.addEventListener("click", () => net.send({ type: "repeat" }));
  e.querySelector(".slow")!.addEventListener("click", () => net.send({ type: "repeat", slow: true }));
  chat.append(e);
  scrollChat();
}

function scrollChat() {
  chat.scrollTop = chat.scrollHeight;
}

// ── debug: force animations (open /?debug) ───────────────────
if (params.has("debug")) {
  $("debug").hidden = false;
  const anims: Anim[] = ["idle", "listen", "think", "talk", "happy", "sad", "eat", "sleep", "petted", "sleepy", "sick", "angry"];
  const btns = $("debugBtns");
  const add = (label: string, fn: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip-btn";
    b.textContent = label;
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => {
      btns.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", "true");
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
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 4000);
}

/** The little markdown answers use: paragraphs, "- " lists, **bold**, `code`. Escapes everything else. */
function markdown(src: string): string {
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
  const out: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join("")}</ul>`);
    list = [];
  };
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    const item = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (item) list.push(item[1]);
    else {
      flush();
      if (line) out.push(`<p>${inline(line.replace(/^#+\s*/, ""))}</p>`);
    }
  }
  flush();
  return out.join("");
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// This visit's mistakes, from the conversation and the translation card. Asking about a point goes to
// the conversation once ねこ is awake.
const review = initReview(demo, toast, (q) => (awake ? ask(q) : toast(`Wake ねこ first to ask about it.`)));
// The translation challenge card works over HTTP, so it loads before the cat is woken.
initChallenge(demo, toast, (zh, r) => review.add(r.answer, r.corrected, r.mistakes, zh));

// ?demo fills the screen with sample messages, for looking at the design without the server.
if (demo) import("./demo.ts").then((d) => d.run(onMessage, setAwake, (t) => (lastUserEntry = userEntry(t)), ask));
