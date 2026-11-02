import type { CorrectionMistake, ReviewAttempt, ReviewResult } from "../../shared/protocol.ts";

/**
 * The Review panel: this visit's mistakes, grouped by grammar point (most frequent first).
 * Nothing is loaded from the server: a refresh starts empty. Older mistakes are in the notes.
 * "Practise" brings back one of the sentences you got wrong; you fix it and ねこ checks it.
 */

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface Item {
  said: string; // the whole sentence as you said (or wrote) it
  original: string;
  fix: string;
  corrected: string;
  explanation: string;
  translating: string | null; // the Chinese sentence, for a translation answer
  right: number; // times fixed correctly in practice
}

interface Point {
  key: string;
  point: string;
  kind: string;
  items: Item[]; // newest first
  practised: number;
  right: number;
}

/** Grammar kinds worth practising; meaning slips in a translation are about that sentence only. */
const GRAMMAR = new Set(["particle", "conjugation", "tense", "vocabulary", "word_order", "politeness", "other"]);

/** Point names from the model vary a little ("Ni vs de." / "ni vs de"); this groups them. */
const keyOf = (p: string) =>
  p
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[.。、,!?！？"'「」]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function initReview(demo: boolean, toast: (msg: string) => void, askAbout: (question: string) => void) {
  const list = $("review");
  const empty = $("reviewEmpty");
  const meta = $("reviewMeta");
  const drillEl = $("drill");
  const drillPoint = $("drillPoint");
  const drillSaid = $("drillSaid");
  const drillZh = $("drillZh");
  const drillHintBtn = $<HTMLButtonElement>("drillHintBtn");
  const drillHint = $("drillHint");
  const drillAnswer = $<HTMLTextAreaElement>("drillAnswer");
  const drillCheck = $<HTMLButtonElement>("drillCheck");
  const drillNext = $<HTMLButtonElement>("drillNext");
  const drillResult = $("drillResult");

  const points = new Map<string, Point>();
  const open = new Set<string>(); // cards showing every mistake
  let drill: { p: Point; item: Item } | null = null;
  let busy = false;

  /** Add mistakes from a checked sentence or a scored translation. */
  function add(said: string, corrected: string, mistakes: CorrectionMistake[], translating: string | null = null) {
    for (const m of mistakes) {
      if (!GRAMMAR.has(m.type) || !m.original.trim()) continue;
      const key = keyOf(m.grammar_point) || "other";
      let p = points.get(key);
      if (!p) points.set(key, (p = { key, point: m.grammar_point.trim() || "other", kind: m.type, items: [], practised: 0, right: 0 }));
      p.items.unshift({ said, original: m.original, fix: m.fix, corrected, explanation: m.explanation, translating, right: 0 });
    }
    render();
  }

  function render() {
    const all = [...points.values()].sort((a, b) => b.items.length - a.items.length);
    const total = all.reduce((n, p) => n + p.items.length, 0);
    meta.textContent = all.length ? `This visit · ${plural(total, "mistake")} on ${plural(all.length, "grammar point")}` : "This visit";
    empty.hidden = all.length > 0;
    list.innerHTML = all.map(card).join("");
  }

  function card(p: Point): string {
    const latest = p.items[0];
    const isOpen = open.has(p.key);
    const practised = p.practised ? `Practised ${p.practised} · ${p.right} right` : "Not practised yet";
    const all = isOpen
      ? `<ol class="rv-all">${p.items
          .map(
            (i) =>
              `<li><p class="rv-said" lang="ja">${esc(i.said)}</p>${i.translating ? `<p class="rv-zh">Translating <span lang="zh-CN">${esc(i.translating)}</span></p>` : ""}<p lang="ja"><del>${esc(i.original)}</del> → <ins>${esc(i.fix)}</ins></p><p class="why">${esc(i.explanation)}</p></li>`,
          )
          .join("")}</ol>`
      : "";
    return `<li class="${isOpen ? "open" : ""}" data-key="${esc(p.key)}">
      <div class="top"><span>${esc(p.point)}</span><span class="n">×${p.items.length}</span></div>
      <p class="rv-meta">${esc(p.kind.replace("_", " "))} · ${practised}</p>
      <p class="eg" lang="ja"><del>${esc(latest.original)}</del> → <ins>${esc(latest.fix)}</ins></p>
      <div class="rv-tools">
        <button class="chip-btn" type="button" data-act="practise">Practise</button>
        ${p.items.length > 1 ? `<button class="chip-btn" type="button" data-act="all" aria-expanded="${isOpen}">${isOpen ? "Hide" : `All ${p.items.length}`}</button>` : ""}
        <button class="chip-btn" type="button" data-act="ask">Ask about this</button>
      </div>${all}
    </li>`;
  }

  list.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
    const p = points.get(btn?.closest<HTMLElement>("li[data-key]")?.dataset.key ?? "");
    if (!btn || !p) return;
    if (btn.dataset.act === "all") {
      if (open.has(p.key)) open.delete(p.key);
      else open.add(p.key);
      render();
    } else if (btn.dataset.act === "practise") startDrill(p);
    else askAbout(`Explain "${p.point}". I said ${p.items[0].original} but it should be ${p.items[0].fix}. Why?`);
  });

  /** One of the point's sentences: the one fixed right least often, picking at random among ties. */
  function startDrill(p: Point) {
    if (busy) return;
    const least = Math.min(...p.items.map((i) => i.right));
    const pool = p.items.filter((i) => i.right === least && i !== drill?.item);
    const item = (pool.length ? pool : p.items)[Math.floor(Math.random() * (pool.length || p.items.length))];
    drill = { p, item };
    drillEl.hidden = false;
    drillPoint.textContent = p.point;
    drillSaid.textContent = item.said;
    drillZh.hidden = !item.translating;
    drillZh.innerHTML = item.translating ? `Translating <span lang="zh-CN">${esc(item.translating)}</span>` : "";
    drillHint.textContent = item.explanation;
    drillHint.hidden = true;
    drillHintBtn.setAttribute("aria-pressed", "false");
    drillAnswer.value = item.said; // start from your own sentence and fix it
    drillResult.innerHTML = "";
    drillCheck.disabled = false;
    drillEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    drillAnswer.focus();
  }

  drillHintBtn.addEventListener("click", () => {
    drillHint.hidden = !drillHint.hidden;
    drillHintBtn.setAttribute("aria-pressed", String(!drillHint.hidden));
  });

  async function check() {
    const answer = drillAnswer.value.trim();
    if (!drill || busy || !answer) return;
    const { p, item } = drill;
    busy = true;
    drillCheck.disabled = drillNext.disabled = true;
    drillCheck.textContent = "Checking…";
    try {
      const body: ReviewAttempt = { point: p.point, said: item.said, original: item.original, fix: item.fix, answer };
      const r: ReviewResult = demo ? { ok: true, answer, mistakes: [], still: false } : await post("/api/review/practice", body);
      p.practised++;
      if (r.ok) {
        p.right++;
        item.right++;
      }
      drillResult.innerHTML = result(r, item);
      render();
    } catch (err) {
      toast(`Couldn't check that: ${(err as Error).message}`);
    } finally {
      busy = false;
      drillCheck.disabled = drillNext.disabled = false;
      drillCheck.textContent = "Check";
    }
  }

  function result(r: ReviewResult, item: Item): string {
    const head = r.ok ? `<span class="pill good">Right</span>` : `<span class="pill bad">Not yet</span>`;
    const still = r.still ? `<p>The old mistake is still there: <span lang="ja"><del>${esc(item.original)}</del></span>.</p>` : "";
    const found = r.mistakes.length
      ? `<ul>${r.mistakes
          .map((m) => `<li><span lang="ja"><del>${esc(m.original)}</del> → <ins>${esc(m.fix)}</ins></span> <span class="point">${esc(m.grammar_point)}</span><br><span class="why">${esc(m.explanation)}</span></li>`)
          .join("")}</ul>`
      : "";
    return `<div class="check">${head}${still}${found}<p class="natural">Earlier fix: <span lang="ja">${esc(item.corrected)}</span></p></div>`;
  }

  drillCheck.addEventListener("click", check);
  drillAnswer.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      check();
    }
  });
  drillNext.addEventListener("click", () => drill && startDrill(drill.p));
  $("drillClose").addEventListener("click", () => {
    drillEl.hidden = true;
    drill = null;
  });

  render();
  return { add };
}

async function post(url: string, body: object) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message ?? data?.error ?? `server error ${res.status}`);
  return data;
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
