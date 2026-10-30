import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.ts";
import type { CallRecord, CallSummary, ChatMessage } from "./types.ts";

// Markdown notes live in <vault>/<folder>/calls/YYYY-MM-DD/.
// The stats index lives in <vault>/.neko/calls.jsonl (dot folders are hidden in Obsidian).
const indexDir = path.join(config.vaultPath, ".neko");
const indexFile = path.join(indexDir, "calls.jsonl");

const summaries: CallSummary[] = [];

export async function initVault(): Promise<void> {
  await mkdir(indexDir, { recursive: true });
  try {
    const raw = await readFile(indexFile, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        summaries.push(JSON.parse(line));
      } catch {
        // skip a corrupt line rather than refusing to start
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function getSummaries(): readonly CallSummary[] {
  return summaries;
}

/** Persist a call: a readable note (for chat calls) plus a line in the stats index. */
export async function saveCall(record: CallRecord): Promise<void> {
  if (record.messages) {
    const day = record.startedAt.slice(0, 10);
    const time = record.startedAt.slice(11, 19).replaceAll(":", "");
    const rel = path.join(config.vaultFolder, "calls", day, `${time}-${slug(record.client)}-${record.id.slice(0, 8)}.md`);
    const abs = path.join(config.vaultPath, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, renderNote(record), "utf8");
    record.note = rel;
  }
  const { messages: _m, response: _r, ...summary } = record;
  summaries.push(summary);
  await appendFile(indexFile, JSON.stringify(summary) + "\n", "utf8");
}

function renderNote(r: CallRecord): string {
  const fm: Record<string, unknown> = {
    id: r.id,
    date: r.startedAt,
    client: r.client,
    model: r.model,
    stream: r.stream,
    status: r.status,
    duration_ms: r.durationMs,
    ttft_ms: r.ttftMs,
    prompt_tokens: r.promptTokens,
    completion_tokens: r.completionTokens,
    tokens_per_sec: r.tokensPerSec,
    finish_reason: r.finishReason,
    error: r.error,
  };
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (v !== undefined && v !== null) lines.push(`${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`);
  }
  lines.push("tags:", "  - neko/call", "---", "");

  const firstUser = r.messages?.find((m) => m.role === "user");
  lines.push(`# ${oneLine(textOf(firstUser?.content)).slice(0, 80) || "LLM call"}`, "");

  for (const m of r.messages ?? []) {
    lines.push(`## ${m.role}${m.name ? ` (${m.name})` : ""}`, "", textOf(m.content) || "_(empty)_", "");
    if (m.tool_calls?.length) lines.push(codeBlock(m.tool_calls), "");
  }

  lines.push("## assistant (response)", "");
  if (r.error) lines.push(`> [!error] ${oneLine(r.error)}`, "");
  if (r.response?.reasoning) {
    lines.push("> [!note]- Reasoning", ...r.response.reasoning.split("\n").map((l) => `> ${l}`), "");
  }
  if (r.response?.content) lines.push(r.response.content, "");
  if (r.response?.toolCalls?.length) lines.push(codeBlock(r.response.toolCalls), "");
  return lines.join("\n");
}

function textOf(content: ChatMessage["content"]): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content.map((p) => (p.type === "text" ? (p.text ?? "") : `[${p.type}]`)).join("\n");
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
const codeBlock = (v: unknown) => "```json\n" + JSON.stringify(v, null, 2) + "\n```";
