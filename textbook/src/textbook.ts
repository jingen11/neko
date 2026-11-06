import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The learner's textbook, transcribed into Markdown under data/textbook/<book>/<unit>/<file>.md
 * (one file per lesson, plus unit intro and unit-end files). Furigana is written {漢字|かな};
 * `<!-- pdf N / book M -->` marks where each page starts.
 *
 * The whole book is small (about 1 MB), so it is loaded into memory and searched by scanning.
 */

export interface Section {
  book: string;
  unit: number | null;
  /** Lesson number, or null for unit intro / unit-end pages. */
  lesson: number | null;
  /** The file's top heading (lesson title or unit-end topic), ruby form. */
  title: string;
  /** `##` heading, e.g. 语法解释, or "" before the first one. */
  part: string;
  /** `###` heading under the part, or "". */
  heading: string;
  bookPage: number | null;
  pdfPage: number | null;
  /** Body in ruby form: 起(お)きます. */
  text: string;
  /** Body as written in the file ({漢字|かな}). */
  raw: string;
  /** Normalised kanji form and kana form of heading + body, for matching. */
  plain: string;
  kana: string;
  /** Normalised part + heading (kanji form then kana form), and its words split on brackets and quotes. */
  head: string;
  headTokens: Set<string>;
}

export interface Word {
  book: string;
  lesson: number;
  reading: string;
  kanji: string;
  pos: string;
  meaning: string;
  bookPage: number | null;
}

export interface Lesson {
  book: string;
  unit: number | null;
  lesson: number;
  title: string;
  bookPages: string;
  pdfPages: string;
  sections: Section[];
}

export interface Textbook {
  sections: Section[];
  words: Word[];
  lessons: Map<number, Lesson>;
}

const RUBY = /\{([^|{}]+)\|([^|{}]+)\}/g;

/** 起(お)きます: readable for a model, keeps the reading. */
export const toRuby = (s: string) => s.replace(RUBY, "$1($2)").replace(/\\\*/g, "*");
const toPlain = (s: string) => s.replace(RUBY, "$1");
const toKana = (s: string) => s.replace(RUBY, "$2");

/** NFKC, lower case, no whitespace (the book puts spaces between phrases), no markdown punctuation. */
export const norm = (s: string) =>
  s.normalize("NFKC").toLowerCase().replace(/[\s*_`>#|\\]/g, "");

function frontmatter(src: string): { meta: Record<string, string>; body: string } {
  const m = src.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^"(.*)"$/, "$1");
  }
  return { meta, body: src.slice(m[0].length) };
}

const num = (s: string | undefined) => (s && /^\d+$/.test(s) ? Number(s) : null);

function parseFile(file: string, book: string, tb: Textbook) {
  const { meta, body } = frontmatter(readFileSync(file, "utf8"));
  const unit = num(meta.unit);
  const lesson = num(meta.lesson);
  let title = meta.title ? toRuby(meta.title) : "";
  let part = "";
  let heading = "";
  let pdfPage: number | null = null;
  let bookPage: number | null = null;
  let start: { pdfPage: number | null; bookPage: number | null } = { pdfPage, bookPage };
  let lines: string[] = [];
  const sections: Section[] = [];

  const flush = () => {
    const raw = lines.join("\n").trim();
    lines = [];
    if (!raw) return;
    const head = `${part} ${heading}`;
    // Pattern headings glue the particle to a placeholder (名を, 名1, 动ますか): index both forms.
    const tokens = (s: string) => s.normalize("NFKC").split(/[\s"'“”「」『』［］\[\]()（）／/、,.＋+~～:：]+/)
      .map(norm).flatMap((t) => [t, t.replace(/^(?:\d+|名\d*|动|形)+/, "")]).filter(Boolean);
    sections.push({
      book, unit, lesson, title, part: toRuby(part), heading: toRuby(heading),
      bookPage: start.bookPage, pdfPage: start.pdfPage,
      text: toRuby(raw), raw,
      plain: norm(toPlain(`${head}\n${raw}`)),
      kana: norm(toKana(`${head}\n${raw}`)),
      head: norm(toPlain(head)) + "\n" + norm(toKana(head)),
      headTokens: new Set([...tokens(toPlain(head)), ...tokens(toKana(head))]),
    });
  };

  for (const line of body.split("\n")) {
    const page = line.match(/^<!--\s*pdf\s+(\d+)\s*\/\s*book\s+(\d+)\s*-->$/);
    if (page) {
      pdfPage = Number(page[1]);
      bookPage = Number(page[2]);
      if (!lines.join("").trim()) start = { pdfPage, bookPage };
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flush();
      const level = h[1].length;
      if (level === 1) { part = ""; heading = ""; if (!title || lesson === null) title = toRuby(h[2]); }
      else if (level === 2) { part = h[2]; heading = ""; }
      else heading = h[2];
      start = { pdfPage, bookPage };
      continue;
    }
    // Word list rows: | reading | kanji | pos | meaning |
    if (lesson !== null && part.startsWith("生词表")) {
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (cells.length === 4 && cells[0] !== "词" && !/^-+$/.test(cells[0])) {
        const [reading, kanji, pos, meaning] = cells;
        tb.words.push({ book, lesson, reading, kanji, pos, meaning, bookPage });
      }
    }
    lines.push(line);
  }
  flush();
  tb.sections.push(...sections);

  if (lesson !== null) {
    tb.lessons.set(lesson, {
      book, unit, lesson, title,
      bookPages: meta.book_pages ?? "", pdfPages: meta.pdf_pages ?? "",
      sections,
    });
  }
}

function walk(dir: string): string[] {
  return readdirSync(dir).sort().flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : name.endsWith(".md") ? [p] : [];
  });
}

/** Load every book under `root` (data/textbook). Each top-level folder is a book (v1, v2…). */
export function loadTextbook(root: string): Textbook {
  const tb: Textbook = { sections: [], words: [], lessons: new Map() };
  for (const book of readdirSync(root).sort()) {
    if (book.startsWith(".")) continue; // .index/ holds the saved vectors
    const dir = path.join(root, book);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of walk(dir)) parseFile(file, book, tb);
  }
  return tb;
}

/** Parts the model may ask for by an English name. */
const PART_ALIASES: Record<string, string> = {
  basic: "基本课文", sentences: "基本课文", key: "基本课文",
  grammar: "语法解释",
  notes: "表达及词语讲解", expressions: "表达及词语讲解", usage: "表达及词语讲解",
  dialogue: "应用课文", conversation: "应用课文",
  exercises: "练习", practice: "练习",
  vocab: "生词表", vocabulary: "生词表", words: "生词表",
  column: "专栏", culture: "专栏",
};

export function matchPart(lesson: Lesson, want: string): Section[] {
  const key = PART_ALIASES[want.trim().toLowerCase()] ?? want.trim();
  return lesson.sections.filter((s) => s.part.startsWith(key));
}

export interface Hit { section: Section; score: number; lines: string[] }

/** Which parts explain things; a hit there beats a hit in an exercise. */
const PART_WEIGHT: Record<string, number> = { "语法解释": 3, "表达及词语讲解": 2, "基本课文": 1.5, "应用课文": 1.2 };

/**
 * Every whitespace-separated term must appear (in kanji or kana form). Score: heading hits count
 * most, then how often the terms appear, weighted by part. Returns the matching lines as snippets.
 */
export function search(tb: Textbook, query: string, limit = 5): Hit[] {
  const terms = query.split(/\s+/).map(norm).filter(Boolean);
  if (!terms.length) return [];
  // A one-character term (で, に, を) is in nearly every sentence: only a heading naming it counts,
  // unless no heading does.
  const strictTerms = new Set(terms.filter((t) => t.length === 1 && tb.sections.some((s) => s.headTokens.has(t))));
  const strict = (t: string) => strictTerms.has(t);
  const hits: Hit[] = [];
  for (const s of tb.sections) {
    let score = 0;
    let ok = true;
    for (const t of terms) {
      const n = count(s.plain, t) + count(s.kana, t);
      const named = s.headTokens.has(t);
      if (!n || (strict(t) && !named)) { ok = false; break; }
      score += Math.min(n, 6) + (named ? 30 : s.head.includes(t) ? 12 : 0);
    }
    if (!ok) continue;
    score *= PART_WEIGHT[s.part.split(/\s|　/)[0]] ?? 1;
    const lines = s.raw.split("\n")
      .filter((l) => terms.some((t) => norm(toPlain(l)).includes(t) || norm(toKana(l)).includes(t)))
      .map(toRuby);
    const shown = lines.length ? lines : s.text.split("\n").filter((l) => l.trim()).slice(0, 2);
    hits.push({ section: s, score, lines: shown.slice(0, 4) });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

function count(hay: string, needle: string) {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Word list entries whose reading or kanji equals or contains the term. */
export function findWords(tb: Textbook, query: string, limit = 5): Word[] {
  const t = norm(query);
  if (!t) return [];
  const exact = tb.words.filter((w) => norm(w.reading).split("／").includes(t) || norm(w.kanji).split("／").includes(t));
  const partial = t.length >= 2
    ? tb.words.filter((w) => !exact.includes(w) && (norm(w.reading).includes(t) || norm(w.kanji).includes(t) || norm(w.meaning) === t))
    : [];
  return [...exact, ...partial].slice(0, limit);
}

export const where = (s: { book: string; lesson: number | null; title: string; bookPage: number | null }) =>
  `${s.book}${s.lesson !== null ? ` 第${s.lesson}課` : ` ${s.title}`}${s.bookPage ? ` p.${s.bookPage}` : ""}`;
