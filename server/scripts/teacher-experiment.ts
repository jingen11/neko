/**
 * Teacher experiment: why does ねこ understand the owner while the teacher "corrects" correct sentences?
 *
 * Runs the same sentences (each inside a short conversation with ねこ) through several teacher variants,
 * a few times each, against the real llama.cpp server, and counts:
 *   - false alarms: a correct sentence got a fix (e.g. 魚を買ってあげました said to the cat)
 *   - misses: a sentence with a real mistake got none
 *
 *   node --env-file-if-exists=.env scripts/teacher-experiment.ts [--runs 3] [--only current,thinking]
 *
 * Prints a summary table and writes every answer (meaning, fixes, explanations, thinking excerpt)
 * to <data dir>/teacher-experiment-<time>.md (server/data by default) — paste that file back.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../src/config.ts";
import type { ChatMessage } from "../src/llm.ts";
import { knownPoints } from "../src/records.ts";
import { correctionSchema, petReply, type RawCorrection, teacherPrompt } from "../src/tutor.ts";

// ── test sentences, each said to ねこ after a short conversation ───────────────

interface Case {
  said: string;
  expect: "ok" | "flag";
  why: string;
  ctx: ChatMessage[];
}

const greet: ChatMessage[] = [{ role: "assistant", content: "おかえり！今日は何をしたの？" }];
const chat: ChatMessage[] = [
  { role: "assistant", content: "こんにちは！今日も日本語で話そう！" },
  { role: "user", content: "うん、話そう" },
  { role: "assistant", content: "昨日は何をしましたか？" },
];

const cases: Case[] = [
  { said: "今朝市場で魚を買ってあげました", expect: "ok", why: "owner bought fish for the cat: あげる is right", ctx: greet },
  { said: "あとでブラシで毛をとかしてあげるね", expect: "ok", why: "owner will brush the cat: あげる is right", ctx: greet },
  { said: "今日は雨だったから、家で本を読みました", expect: "ok", why: "plain correct sentence", ctx: greet },
  { said: "今朝市場で魚を買ってくれました", expect: "flag", why: "owner did it, so くれる points the wrong way", ctx: greet },
  { said: "市場を魚を買いました", expect: "flag", why: "particle: 市場で", ctx: greet },
  { said: "昨日友達と公園に行きます", expect: "flag", why: "tense: 行きました", ctx: chat },
  { said: "昨日すしを食べるました", expect: "flag", why: "conjugation: 食べました", ctx: chat },
];

// ── teacher variants ────────────────────────────────────────────────────────

interface Variant {
  name: string;
  what: string;
  thinking: boolean;
  schema: boolean; // constrain the output with the JSON schema (production does)
  system: (known: string[], reply: string) => string;
  judgeFirst?: boolean;
}

const AGERU_LINE = "〜てあげる / あげる is the right verb";
const withoutAgeru = (p: string) =>
  p
    .split("\n")
    .filter((l) => !l.includes(AGERU_LINE))
    .join("\n");
const replyNote = (reply: string) => `\nねこ has already answered the learner's latest message with 「${reply}」. That answer shows how ねこ understood it.`;
const JUDGE = `\nBefore listing mistakes, decide natural_for_owner: would a native speaker find the latest message a correct, natural thing for an owner to say to their cat at this point in the conversation? If true, mistakes must be empty.`;
const PLAIN_JSON = `\nReply with only a JSON object, no other text: {"meaning": string, "mistakes": [{"original": string, "fix": string, "keeps_meaning": boolean, "type": string, "grammar_point": string, "explanation": string}], "corrected": string, "natural": string}`;

const variants: Variant[] = [
  { name: "current", what: "production prompt, thinking off", thinking: false, schema: true, system: (k) => teacherPrompt(k) },
  { name: "no-list", what: "without the saved grammar-point list", thinking: false, schema: true, system: () => teacherPrompt([]) },
  { name: "no-ageru", what: "without the あげる/くれる/もらう line", thinking: false, schema: true, system: (k) => withoutAgeru(teacherPrompt(k)) },
  { name: "sees-reply", what: "also told ねこ's reply to the sentence", thinking: false, schema: true, system: (k, r) => teacherPrompt(k) + replyNote(r) },
  { name: "judge-first", what: "decides 'natural for owner to say?' before listing fixes", thinking: false, schema: true, judgeFirst: true, system: (k) => teacherPrompt(k) + JUDGE },
  { name: "thinking", what: "production prompt, thinking ON, JSON schema", thinking: true, schema: true, system: (k) => teacherPrompt(k) },
  { name: "thinking-free", what: "thinking ON, JSON asked for in the prompt (no schema)", thinking: true, schema: false, system: (k) => teacherPrompt(k) + PLAIN_JSON },
  { name: "thinking-no-list", what: "thinking ON, no schema, no grammar-point list", thinking: true, schema: false, system: () => teacherPrompt([]) + PLAIN_JSON },
];

// ── running ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const RUNS = Number(arg("--runs") ?? 3);
const only = arg("--only")?.split(",");
const chosen = only ? variants.filter((v) => only.includes(v.name)) : variants;
if (!chosen.length) {
  console.error(`no such variant; choose from: ${variants.map((v) => v.name).join(", ")}`);
  process.exit(1);
}

type Raw = RawCorrection & { natural_for_owner?: boolean };
interface Run {
  ok: boolean; // the request worked and parsed
  error?: string;
  raw?: Raw;
  rawFlags: number; // fixes the model listed
  keptFlags: number; // fixes left after production drops the ones with keeps_meaning = false
  flagged: boolean; // what the learner would see
  ms: number;
  thinking: string;
}

async function ask(v: Variant, c: Case, known: string[], reply: string, seed: number): Promise<Run> {
  const schema = v.judgeFirst
    ? {
        ...correctionSchema,
        properties: { meaning: correctionSchema.properties.meaning, natural_for_owner: { type: "boolean" }, ...correctionSchema.properties },
        required: ["meaning", "natural_for_owner", ...correctionSchema.required.filter((f) => f !== "meaning")],
      }
    : correctionSchema;
  const t0 = performance.now();
  try {
    const res = await fetch(`${config.llamaUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(v.thinking ? 300_000 : 60_000),
      body: JSON.stringify({
        messages: [{ role: "system", content: v.system(known, reply) }, ...c.ctx, { role: "user", content: c.said }],
        // thinking: Qwen's recommended sampling for thinking mode; otherwise production's
        ...(v.thinking ? { temperature: 0.6, top_p: 0.95, top_k: 20 } : { temperature: 0.1 }),
        seed,
        max_tokens: v.thinking ? 6000 : 700,
        ...(v.schema && { response_format: { type: "json_schema", json_schema: { schema } } }),
        chat_template_kwargs: { enable_thinking: v.thinking },
      }),
    });
    const body = await res.json();
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) return { ok: false, error: `llama.cpp ${res.status}: ${body?.error?.message ?? ""}`, rawFlags: 0, keptFlags: 0, flagged: false, ms, thinking: "" };
    const msg = body.choices?.[0]?.message ?? {};
    let content: string = msg.content ?? "";
    // thinking comes back in reasoning_content, or inline as <think>…</think> depending on the server's settings
    let thinking: string = msg.reasoning_content ?? "";
    const inline = content.match(/<think>([\s\S]*?)<\/think>/);
    if (inline) {
      thinking ||= inline[1];
      content = content.replace(inline[0], "");
    }
    const json = content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
    const raw = JSON.parse(json) as Raw;
    const kept = (raw.mistakes ?? []).filter((m) => m.keeps_meaning && m.original?.trim() && m.original !== m.fix);
    const judgedFine = v.judgeFirst && raw.natural_for_owner === true;
    return {
      ok: true,
      raw,
      rawFlags: raw.mistakes?.length ?? 0,
      keptFlags: judgedFine ? 0 : kept.length,
      flagged: !judgedFine && kept.length > 0,
      ms,
      thinking: thinking.trim(),
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message, rawFlags: 0, keptFlags: 0, flagged: false, ms: Math.round(performance.now() - t0), thinking: "" };
  }
}

const known = knownPoints();
console.log(`llama.cpp at ${config.llamaUrl} · ${chosen.length} variants × ${cases.length} sentences × ${RUNS} runs`);
console.log(`saved grammar points shown to the teacher (${known.length}): ${known.join("; ") || "(none)"}\n`);

// ねこ's reply to each sentence, once, for the "sees-reply" variant (and for the report)
const replies: string[] = [];
for (const c of cases) {
  try {
    replies.push((await petReply([...c.ctx, { role: "user", content: c.said }])).data.ja);
  } catch (err) {
    replies.push(`(reply failed: ${(err as Error).message})`);
  }
}

const results = new Map<string, Run[][]>(); // variant → case → runs
for (const v of chosen) {
  const perCase: Run[][] = [];
  for (const [i, c] of cases.entries()) {
    const runs: Run[] = [];
    for (let r = 0; r < RUNS; r++) {
      const run = await ask(v, c, known, replies[i], r + 1);
      runs.push(run);
      const mark = !run.ok ? "E" : run.flagged === (c.expect === "flag") ? "." : "X";
      process.stdout.write(mark);
    }
    perCase.push(runs);
  }
  results.set(v.name, perCase);
  process.stdout.write(`  ${v.name}\n`);
}

// ── summary ─────────────────────────────────────────────────────────────────

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "-");
const rows: string[] = [];
rows.push("| variant | right | false alarms (ok sentences fixed) | misses (mistakes not caught) | errors | avg time |", "|---|---|---|---|---|---|");
for (const v of chosen) {
  const perCase = results.get(v.name)!;
  let right = 0, total = 0, fa = 0, okRuns = 0, miss = 0, flagRuns = 0, errors = 0, ms = 0;
  perCase.forEach((runs, i) => {
    for (const run of runs) {
      total++;
      ms += run.ms;
      if (!run.ok) {
        errors++;
        continue;
      }
      if (cases[i].expect === "ok") {
        okRuns++;
        if (run.flagged) fa++;
        else right++;
      } else {
        flagRuns++;
        if (run.flagged) right++;
        else miss++;
      }
    }
  });
  rows.push(`| ${v.name} | ${right}/${total} | ${fa}/${okRuns} (${pct(fa, okRuns)}) | ${miss}/${flagRuns} (${pct(miss, flagRuns)}) | ${errors} | ${(ms / total / 1000).toFixed(1)} s |`);
}
console.log("\n" + rows.join("\n"));

// ── details file ────────────────────────────────────────────────────────────

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const md: string[] = [
  `# Teacher experiment ${new Date().toISOString()}`,
  "",
  `llama.cpp: ${config.llamaUrl} · level ${config.level} · ${RUNS} runs per sentence`,
  "",
  `Saved grammar points shown to the teacher: ${known.join("; ") || "(none)"}`,
  "",
  "## Summary",
  "",
  ...rows,
  "",
  "## Variants",
  "",
  ...chosen.map((v) => `- **${v.name}**: ${v.what}`),
  "",
  "## Details",
];
cases.forEach((c, i) => {
  md.push("", `### ${c.said}`, "", `Expected: **${c.expect}** (${c.why}). ねこ replied: ${replies[i]}`);
  for (const v of chosen) {
    md.push("", `**${v.name}**`);
    for (const [r, run] of results.get(v.name)![i].entries()) {
      const verdict = !run.ok ? "ERROR" : run.flagged === (c.expect === "flag") ? "right" : "WRONG";
      if (!run.ok) {
        md.push(`- run ${r + 1}: ERROR ${run.error}`);
        continue;
      }
      const raw = run.raw!;
      md.push(
        `- run ${r + 1}: ${verdict} · ${(run.ms / 1000).toFixed(1)} s · fixes listed ${run.rawFlags}, kept ${run.keptFlags}` +
          (raw.natural_for_owner !== undefined ? ` · natural_for_owner=${raw.natural_for_owner}` : ""),
        `  - meaning: ${oneLine(raw.meaning ?? "")}`,
      );
      for (const m of raw.mistakes ?? [])
        md.push(`  - fix: ${m.original} → ${m.fix} (keeps_meaning=${m.keeps_meaning}) · ${m.grammar_point} · ${oneLine(m.explanation ?? "")}`);
      if (run.thinking) md.push(`  - thinking (${run.thinking.length} chars): ${oneLine(run.thinking).slice(0, 600)}${run.thinking.length > 600 ? " …" : ""}`);
      else if (v.thinking) md.push("  - thinking: (none came back)");
    }
  }
});

mkdirSync(config.dataDir, { recursive: true });
const file = path.join(config.dataDir, `teacher-experiment-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
writeFileSync(file, md.join("\n") + "\n");
console.log(`\nEvery answer is in ${file}`);
