import type { Challenge, ChallengeResult, ChallengeState } from "../../shared/protocol.ts";

/** The translation challenge card: one Chinese sentence, your Japanese, a score out of 100. */

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function initChallenge(demo: boolean, toast: (msg: string) => void) {
  const zh = $("chZh");
  const meta = $("chMeta");
  const hintBtn = $<HTMLButtonElement>("chHintBtn");
  const hint = $("chHint");
  const answer = $<HTMLTextAreaElement>("chAnswer");
  const checkBtn = $<HTMLButtonElement>("chCheck");
  const newBtn = $<HTMLButtonElement>("chNew");
  const result = $("chResult");
  let current: Challenge | null = null;
  let busy = false;

  const EMPTY = `<p class="empty">Your score appears here: meaning, grammar and naturalness.</p>`;

  function show(s: ChallengeState) {
    current = s.challenge;
    zh.classList.remove("skel");
    zh.textContent = s.challenge.zh;
    meta.textContent = s.challenge.kind === "daily" ? `Today's challenge · ${dateLabel(s.challenge.day)}` : "Extra challenge";
    hint.innerHTML = `Try <b lang="ja">${esc(s.challenge.grammar)}</b> · ${esc(s.challenge.topic)}`;
    hint.hidden = true;
    hintBtn.setAttribute("aria-pressed", "false");
    hintBtn.disabled = false;
    answer.disabled = false;
    answer.value = s.last?.answer ?? "";
    checkBtn.disabled = false;
    result.innerHTML = s.last ? renderResult(s.last) : EMPTY;
  }

  function showError(msg: string) {
    zh.classList.add("skel");
    zh.textContent = "今天的句子还没准备好。";
    meta.textContent = "Not ready";
    result.innerHTML = `<p class="empty">${esc(msg)} Try “New challenge” in a moment.</p>`;
  }

  async function load(url: string, init?: RequestInit) {
    const res = await fetch(url, init);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.message ?? body?.error ?? `server error ${res.status}`);
    return body;
  }

  hintBtn.addEventListener("click", () => {
    hint.hidden = !hint.hidden;
    hintBtn.setAttribute("aria-pressed", String(!hint.hidden));
  });

  async function check() {
    const text = answer.value.trim();
    if (!current || busy || !text) return;
    busy = true;
    checkBtn.disabled = newBtn.disabled = true;
    checkBtn.textContent = "Scoring…";
    try {
      const r: ChallengeResult = demo ? demoResult(text) : await load(`/api/challenge/${current.id}/answer`, post({ text }));
      result.innerHTML = renderResult(r);
    } catch (err) {
      toast(`Couldn't score that: ${(err as Error).message}`);
    } finally {
      busy = false;
      checkBtn.disabled = newBtn.disabled = false;
      checkBtn.textContent = "Check";
    }
  }
  checkBtn.addEventListener("click", check);
  answer.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      check();
    }
  });

  newBtn.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    checkBtn.disabled = newBtn.disabled = true;
    newBtn.textContent = "Writing…";
    try {
      show(demo ? demoState("extra") : await load("/api/challenge/new", post({})));
      answer.focus();
    } catch (err) {
      toast(`Couldn't make a new challenge: ${(err as Error).message}`);
    } finally {
      busy = false;
      newBtn.disabled = false;
      checkBtn.disabled = !current;
      newBtn.textContent = "New challenge";
    }
  });

  if (demo) show(demoState("daily"));
  else load("/api/challenge").then(show, (err) => showError((err as Error).message));
}

function renderResult(r: ChallengeResult): string {
  const bar = (label: string, n: number, max: number) =>
    `<div class="ch-part"><div class="ch-part-top"><span>${label}</span><span class="num">${n}<small>/${max}</small></span></div><div class="track"><i style="width:${(n / max) * 100}%"></i></div></div>`;
  const mistakes = r.mistakes.length
    ? `<p class="corrected" lang="ja">${esc(r.corrected)}</p><ul>${r.mistakes
        .map(
          (m) =>
            `<li><span lang="ja"><del>${esc(m.original)}</del> → <ins>${esc(m.fix)}</ins></span> <span class="point">${esc(m.grammar_point)}</span><br><span class="why">${esc(m.explanation)}</span></li>`,
        )
        .join("")}</ul>`
    : "";
  return `<div class="ch-score"><p class="kpi-value"><span class="num">${r.total}</span><small> /100</small></p><span class="pill ${r.total >= 80 ? "good" : r.total < 50 ? "bad" : ""}">${verdict(r.total)}</span></div>
    <div class="ch-parts">${bar("Meaning", r.meaning, 50)}${bar("Grammar", r.grammar, 30)}${bar("Naturalness", r.naturalness, 20)}</div>
    ${r.comment ? `<p class="ch-comment">${esc(r.comment)}</p>` : ""}
    <div class="check">${mistakes}<p class="natural">Reference: <span lang="ja">${esc(r.reference)}</span></p></div>`;
}

const verdict = (n: number) => (n >= 90 ? "Excellent" : n >= 80 ? "Good" : n >= 65 ? "Getting there" : n >= 50 ? "Partly right" : "Try again");

const post = (body: object): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function dateLabel(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ── ?demo: sample data for looking at the design without the server. Not real data. ──
function demoState(kind: "daily" | "extra"): ChallengeState {
  const today = new Date().toLocaleDateString("en-CA");
  return kind === "daily"
    ? { challenge: { id: 1, kind, day: today, zh: "我昨天把伞忘在电车上了。", topic: "a lost umbrella", grammar: "〜てしまう" }, last: demoResult("昨日、電車で傘を忘れてしまいました。") }
    : { challenge: { id: 2, kind, day: today, zh: "如果明天下雨的话，我们就在家看电影吧。", topic: "a movie night", grammar: "〜たら conditional" }, last: null };
}

function demoResult(answer: string): ChallengeResult {
  return {
    answer,
    total: 74,
    meaning: 42,
    grammar: 20,
    naturalness: 12,
    corrected: answer.replace("電車で", "電車に"),
    mistakes: [
      { type: "particle", original: "電車で", fix: "電車に", grammar_point: "ni for where things are left", explanation: "Use に for the place something is left behind with 忘れる." },
    ],
    comment: "The meaning comes through. Watch which particle marks where you leave something.",
    reference: "昨日、電車に傘を忘れてしまいました。",
  };
}
