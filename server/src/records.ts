import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { ChallengeResult } from "../../shared/protocol.ts";
import { config } from "./config.ts";
import { boxDay } from "./pet.ts";
import type { Correction, Mistake } from "./tutor.ts";

/**
 * Learning records go to the Obsidian vault only. neko appends each event to the day's note once and
 * never reads, rewrites or rebuilds it, so Hermes (or you) can reorganise the vault freely:
 *
 *   <vault>/Japanese/Daily/<date>.md   every sentence, translation, listening miss, question and review
 *
 * neko keeps no learning history of its own. The page shows only the current visit; to look back,
 * open the notes (the Notes page) or ask Hermes.
 */

const DAILY = "Daily";

// Note times on the box's zone, like the note's date (boxDay): one timeline, wherever the learner is.
const clockFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const clock = (t: number) => clockFmt.format(t);
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();

/** Append one entry to the day's note, starting the note if it's the first entry today. */
function append(at: number, title: string, lines: string[], body = "") {
  if (!config.vaultDir) return;
  const day = boxDay(at);
  const file = path.join(config.vaultDir, DAILY, `${day}.md`);
  mkdirSync(path.dirname(file), { recursive: true });
  const head = existsSync(file) ? "" : `---\ndate: ${day}\nlevel: ${config.level}\ntags: [neko, japanese/daily]\n---\n# Japanese practice ${day}\n\n`;
  appendFileSync(file, `${head}### ${clock(at)} · ${title}\n${lines.filter(Boolean).join("\n")}\n${body ? `\n${body}\n` : ""}\n`);
}

const mistakeLine = (m: Mistake | ChallengeResult["mistakes"][number]) =>
  `- Mistake (${m.type}): ${oneLine(m.original)} → ${oneLine(m.fix)} · ${oneLine(m.grammar_point)} · ${oneLine(m.explanation)}`;

/** A sentence said (or typed) to the cat, with ねこ's check and reply. */
export function logTurn(said: string, c: Correction, reply?: { ja: string; en: string }) {
  append(Date.now(), `Said ${c.is_correct ? "✓" : "✗"}`, [
    `- Said: ${oneLine(said)}`,
    c.is_correct ? "" : `- Fixed: ${oneLine(c.corrected)}`,
    c.natural && c.natural !== c.corrected && c.natural !== said ? `- More natural: ${oneLine(c.natural)}` : "",
    ...c.mistakes.map(mistakeLine),
    reply?.ja ? `- ${config.petName} replied: ${oneLine(reply.ja)}${reply.en ? ` (${oneLine(reply.en)})` : ""}` : "",
  ]);
}

export interface ChallengeInfo {
  id: number;
  kind: "daily" | "extra";
  zh: string;
  ja: string;
  topic: string;
  grammar: string;
  style: string;
}

/** One attempt at a translation challenge: the whole result, every mistake included. */
export function logTranslation(c: ChallengeInfo, r: ChallengeResult) {
  append(Date.now(), `Translation ${r.total}/100`, [
    `- Challenge: ${c.id} (${c.kind})`,
    `- Chinese: ${oneLine(c.zh)}`,
    `- Reference: ${oneLine(c.ja)}`,
    `- Brief: ${c.topic} · ${c.grammar} · ${c.style}`,
    `- Answer: ${oneLine(r.answer)}`,
    `- Score: meaning ${r.meaning}/50 · grammar ${r.grammar}/30 · naturalness ${r.naturalness}/20`,
    r.mistakes.length ? `- Corrected: ${oneLine(r.corrected)}` : "",
    ...r.mistakes.map(mistakeLine),
    r.comment ? `- Comment: ${oneLine(r.comment)}` : "",
  ]);
}

export type ListeningKind = "repeat" | "slow" | "english";
const LISTENING: Record<ListeningKind, string> = { repeat: "Asked to hear again", slow: "Asked to hear slowly", english: "Looked at the English" };

/** The learner needed help to understand a line: asked to hear it again, slowly, or looked at the English. */
export function logListening(kind: ListeningKind, line: { ja: string; en: string }) {
  append(Date.now(), "Listening", [`- ${LISTENING[kind]}: ${oneLine(line.ja)}`, `- English: ${oneLine(line.en)}`]);
}

export function logAsk(question: string, answer: string, source: string) {
  const quoted = answer.trim().split("\n").map((l) => `> ${l}`).join("\n");
  append(Date.now(), "Question", [`- Question: ${oneLine(question)}`, `- Answered by: ${oneLine(source)}`], quoted);
}

/** A practice attempt from the Review panel: fixing a sentence from earlier in the visit. */
export function logReview(point: string, said: string, answer: string, ok: boolean) {
  append(Date.now(), `Review ${ok ? "✓" : "✗"}`, [`- Point: ${oneLine(point)}`, `- Fixing: ${oneLine(said)}`, `- Answer: ${oneLine(answer)}`]);
}
