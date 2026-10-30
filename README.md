# neko

Central gateway for every LLM call to the local llama.cpp server. Apps talk to neko instead of llama.cpp directly; neko forwards the request unchanged, then logs it to an Obsidian vault and to usage stats.

```
your apps ──▶ neko :8081 ──▶ llama.cpp :8080
                 │
                 └──▶ Obsidian vault (one note per chat call + stats index)
```

## Run

```bash
cp .env.example .env   # set NEKO_VAULT to your Obsidian vault
npm start              # or: npm run dev (restarts on file changes)
```

Requires Node 23.6+ (runs the TypeScript directly). `npm run typecheck` checks types.

## Using it from an app

Point any OpenAI-compatible client at `http://127.0.0.1:8081/v1`. The API key can be any string. Send an `X-Neko-Client` header so the logs and stats show which app made the call; if it's missing, neko uses the OpenAI `user` field, then `unknown`.

```ts
import OpenAI from "openai";
const llm = new OpenAI({
  baseURL: "http://127.0.0.1:8081/v1",
  apiKey: "none",
  defaultHeaders: { "X-Neko-Client": "my-app" },
});
```

## Endpoints

| Path | What it does |
| --- | --- |
| `POST /v1/chat/completions` | Proxied (streaming and non-streaming); saved as a vault note + stats entry |
| `GET /neko/health` | neko status plus llama.cpp's `/health` |
| `GET /neko/stats?since=<ISO date>` | Totals, by client, by endpoint, by day, and the 20 most recent calls |
| anything else | Passed through to llama.cpp (`/v1/models`, `/v1/embeddings`, `/tokenize`, ...). Non-GET calls go into the stats index |

Each response has an `x-neko-request-id` header that matches the `id` in the vault note.

## Vault layout

```
<NEKO_VAULT>/
  neko/calls/2026-10-30/000146-my-app-66875b59.md   # one note per chat call
  .neko/calls.jsonl                                  # stats index (hidden in Obsidian)
```

Notes carry frontmatter (`client`, `model`, `prompt_tokens`, `completion_tokens`, `tokens_per_sec`, `ttft_ms`, `duration_ms`, `status`, ...) and the tag `#neko/call`, so they can be queried with Dataview. Model reasoning is stored in a collapsed callout above the answer.

## Config (`.env`)

| Var | Default |
| --- | --- |
| `NEKO_HOST` / `NEKO_PORT` | `127.0.0.1` / `8081` |
| `LLAMA_URL` | `http://127.0.0.1:8080` |
| `NEKO_VAULT` | `./vault` |
| `NEKO_VAULT_FOLDER` | `neko` |
| `NEKO_LOG_LEVEL` | `info` |
