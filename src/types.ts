/** One logged LLM call. Everything except `messages`/`response` goes in the stats index. */
export interface CallRecord {
  id: string;
  startedAt: string;
  client: string;
  endpoint: string;
  model?: string;
  stream: boolean;
  status: number;
  durationMs: number;
  ttftMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  tokensPerSec?: number;
  finishReason?: string;
  error?: string;
  note?: string; // vault-relative path of the markdown note, if one was written
  messages?: ChatMessage[];
  response?: { content: string; reasoning?: string; toolCalls?: unknown[] };
}

export interface ChatMessage {
  role: string;
  content?: string | Array<{ type: string; text?: string }> | null;
  reasoning_content?: string;
  tool_calls?: unknown[];
  name?: string;
}

export type CallSummary = Omit<CallRecord, "messages" | "response">;
