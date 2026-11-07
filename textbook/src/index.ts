import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Embedder, VectorCache, chunk, index, nearest, MODEL } from "./embed.ts";
import { findWords, loadTextbook, matchPart, search, toRuby, where, type Lesson, type Section } from "./textbook.ts";

/**
 * MCP server (stdio) over the learner's transcribed textbook, for Hermes profiles.
 * Read-only: it never writes anything.
 *
 *   NEKO_TEXTBOOK_DIR  data/textbook (default: ../data/textbook from this package)
 *   NEKO_VAULT_DIR     ~/vault/Japanese; progress is read from Notes/Textbook.md
 *   NEKO_EMBED_URL     BGE-M3 llama.cpp server for meaning search (default http://127.0.0.1:8082; empty = exact only)
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const textbookDir = process.env.NEKO_TEXTBOOK_DIR || path.resolve(here, "../../data/textbook");
const vaultDir = process.env.NEKO_VAULT_DIR || path.join(os.homedir(), "vault", "Japanese");
const progressFile = path.join(vaultDir, "Notes", "Textbook.md");

const embedUrl = process.env.NEKO_EMBED_URL ?? "http://127.0.0.1:8082";

const tb = loadTextbook(textbookDir);
const lessonList = [...tb.lessons.keys()].sort((a, b) => a - b);

// Meaning search: saved vectors load now; any missing ones (new or edited lessons) are made in the
// background, so the server answers at once. `npm run index` does the same ahead of time.
const chunks = chunk(tb);
const embedder = new Embedder(embedUrl);
const cache = new VectorCache(path.join(textbookDir, ".index", `${MODEL}.json`));
void index(chunks, cache, embedder).then((n) => {
  if (n) console.error(`neko-textbook: embedded ${n} new chunks`);
});

/** A vector hit below this is unrelated text (BGE-M3 cosine; related sections score ~0.5+). */
const MIN_SIMILARITY = 0.42;
/** Reciprocal rank fusion: each list adds 1/(K + rank), so a section high in either list ranks well. */
const RRF_K = 10;

interface Result { section: Section; lines: string[]; score: number }

async function hybridSearch(query: string, limit: number): Promise<Result[]> {
  const results = new Map<Section, Result>();
  search(tb, query, 20).forEach((h, rank) => {
    results.set(h.section, { section: h.section, lines: h.lines, score: 1 / (RRF_K + rank) });
  });
  const q = await embedder.embed([query], 3000);
  if (q) {
    nearest(chunks, q[0], 20).filter((h) => h.score >= MIN_SIMILARITY).forEach((h, rank) => {
      const cur = results.get(h.chunk.section);
      if (cur) { cur.score += 1 / (RRF_K + rank); return; }
      const lines = h.chunk.section.raw.split("\n").slice(h.chunk.from, h.chunk.to).filter((l) => l.trim()).slice(0, 4).map(toRuby);
      results.set(h.chunk.section, { section: h.chunk.section, lines, score: 1 / (RRF_K + rank) });
    });
  }
  return [...results.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const sectionTitle = (s: Section) => [s.part, s.heading].filter(Boolean).join(" › ");
const missingLesson = (n: number | string) =>
  text(`Lesson ${n} is not transcribed. Transcribed lessons: ${lessonList.join(", ") || "none"}.`);

// Lessons are numbered through the whole series (volume 2 starts where volume 1 ends), but the local
// model often writes them as "第40課" or "v2 40". Accept those too: the 第N課 number, else the last number.
const lessonArg = z.union([z.number().int(), z.string()]).describe("Lesson number (第N課), e.g. 40");
function lessonNumber(v: number | string): number | null {
  if (typeof v === "number") return v;
  const m = v.match(/第\s*(\d+)\s*[課课]/) ?? v.match(/(\d+)(?!.*\d)/);
  return m ? Number(m[1]) : null;
}

function outline(l: Lesson): string {
  const out = [`${l.book} 第${l.lesson}課 ${l.title} (book pages ${l.bookPages})`];
  let part = "";
  for (const s of l.sections) {
    if (!s.part) continue;
    if (s.part !== part) { part = s.part; out.push(`- ${part}${s.bookPage ? ` (p.${s.bookPage})` : ""}`); }
    if (s.heading) out.push(`  - ${s.heading}${s.bookPage ? ` (p.${s.bookPage})` : ""}`);
  }
  return out.join("\n");
}

const server = new McpServer({ name: "neko-textbook", version: "0.1.0" });

server.registerTool("search_textbook", {
  description:
    "Search the learner's own Japanese textbook (explanations are in Chinese). Use it to explain grammar " +
    "the way their book does, cite the page, or reuse the book's example sentences and words. " +
    "Query with Japanese (kanji or kana, e.g. 'あげます', 'から まで'), Chinese or English; it matches exact text and meaning, " +
    "so a whole question or sentence works too (e.g. 'how to say I gave my friend a present'). " +
    "Readings are shown as 漢字(かな).",
  inputSchema: {
    query: z.string().min(1).describe("Japanese or Chinese text to look for"),
    limit: z.number().int().min(1).max(10).optional().describe("Max sections to return (default 5)"),
  },
  annotations: { readOnlyHint: true },
}, async ({ query, limit }) => {
  const words = findWords(tb, query, 5);
  const hits = await hybridSearch(query, limit ?? 5);
  if (!words.length && !hits.length) return text(`Nothing in the textbook matches "${query}".`);
  const out: string[] = [];
  if (words.length) {
    out.push("Word list:");
    for (const w of words) out.push(`- ${w.kanji || w.reading}${w.kanji ? `(${w.reading})` : ""} [${w.pos}] ${w.meaning} — ${where({ ...w, title: "" })}`);
    out.push("");
  }
  for (const h of hits) {
    out.push(`## ${where(h.section)} — ${sectionTitle(h.section) || h.section.title}`);
    out.push(...h.lines);
    out.push("");
  }
  out.push("Use get_lesson with the lesson number and part to read a whole section.");
  return text(out.join("\n"));
});

server.registerTool("get_lesson", {
  description:
    "Read a lesson of the learner's textbook. Without `part`, returns the outline (parts and grammar points with pages). " +
    "With `part`, returns that part's full text: basic (基本课文), grammar (语法解释), notes (表达及词语讲解), " +
    "dialogue (应用课文), exercises (练习), vocab (生词表), column (专栏). `heading` narrows to one grammar point.",
  inputSchema: {
    lesson: lessonArg,
    part: z.string().optional().describe("Part name in English or Chinese, e.g. 'grammar' or '语法解释'"),
    heading: z.string().optional().describe("Text of a ### heading inside the part, e.g. 'から' or '2.'"),
  },
  annotations: { readOnlyHint: true },
}, async ({ lesson: arg, part, heading }) => {
  const lesson = lessonNumber(arg);
  const l = lesson === null ? undefined : tb.lessons.get(lesson);
  if (!l) return missingLesson(arg);
  if (!part) return text(outline(l));
  let secs = matchPart(l, part);
  if (!secs.length) return text(`No part "${part}" in lesson ${lesson}.\n\n${outline(l)}`);
  if (heading) {
    const h = heading.trim();
    const narrowed = secs.filter((s) => s.heading.includes(h) || s.heading.replace(/\([^()]*\)/g, "").includes(h));
    if (!narrowed.length) return text(`No heading matching "${heading}" in ${secs[0].part}.\n\n${outline(l)}`);
    secs = narrowed;
  }
  const out = [`${l.book} 第${l.lesson}課 ${l.title}`];
  for (const s of secs) out.push(`\n## ${sectionTitle(s)}${s.bookPage ? ` (p.${s.bookPage})` : ""}\n\n${s.text}`);
  return text(out.join("\n"));
});

const VOCAB_CAP = 300;

server.registerTool("lesson_vocab", {
  description: "The word list (生词表) of one textbook lesson, or of every lesson up to and including it with `through: true`.",
  inputSchema: {
    lesson: lessonArg,
    through: z.boolean().optional().describe("Include all earlier transcribed lessons too"),
  },
  annotations: { readOnlyHint: true },
}, async ({ lesson: arg, through }) => {
  const lesson = lessonNumber(arg);
  if (lesson === null || !tb.lessons.has(lesson)) return missingLesson(arg);
  const all = tb.words.filter((w) => (through ? w.lesson <= lesson : w.lesson === lesson));
  // Every word up to a late lesson is thousands of lines, too much for the local model: keep the latest.
  const words = all.slice(-VOCAB_CAP);
  const out = [`Word list, ${through ? `lessons up to ${lesson}` : `lesson ${lesson}`} (${all.length} words): reading | kanji | part of speech | meaning (Chinese)`];
  if (words.length < all.length) out.push(`Only the latest ${VOCAB_CAP} are listed, from lesson ${words[0].lesson}. Use search_textbook to check a single word.`);
  let cur = -1;
  for (const w of words) {
    if (w.lesson !== cur) { cur = w.lesson; out.push(`\n第${cur}課`); }
    out.push(`${w.reading} | ${w.kanji} | ${w.pos} | ${w.meaning}`);
  }
  return text(out.join("\n"));
});

/** `lesson: 5` (and optionally `book: v1`) in the frontmatter of Notes/Textbook.md. */
function readProgress(): { book?: string; lesson?: number } | null {
  if (!existsSync(progressFile)) return null;
  const src = readFileSync(progressFile, "utf8");
  const fm = src.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const lesson = fm.match(/^lesson:\s*(\d+)\s*$/m)?.[1];
  const book = fm.match(/^book:\s*(\S+)\s*$/m)?.[1];
  return { book, lesson: lesson ? Number(lesson) : undefined };
}

server.registerTool("where_am_i", {
  description:
    "Which textbook lesson the learner is on now, with its grammar points. Earlier lessons count as learned. " +
    "Use it to keep explanations and examples within what they have studied.",
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => {
  const p = readProgress();
  const transcribed = `Transcribed lessons: ${lessonList.join(", ") || "none"}.`;
  if (!p?.lesson) {
    return text(`The learner's current lesson is not recorded (set \`lesson: N\` in the frontmatter of ${progressFile}). ${transcribed}`);
  }
  const l = tb.lessons.get(p.lesson);
  const head = `The learner is on ${p.book ?? "v1"} 第${p.lesson}課; lessons before it count as learned. ${transcribed}`;
  return text(l ? `${head}\n\n${outline(l)}` : `${head}\nLesson ${p.lesson} itself is not transcribed yet.`);
});

await server.connect(new StdioServerTransport());
console.error(`neko-textbook: ${tb.lessons.size} lessons, ${tb.sections.length} sections, ${chunks.length} chunks, ${tb.words.length} words from ${textbookDir}`);
