# neko 🐱

A Japanese-learning tamagotchi. The pet lives in a web app on the box and will travel with you on an ESP32-S3 board. It talks to you in Japanese at your JLPT level, corrects your grammar when you speak, and records your practice and mistakes in an Obsidian vault so Hermes Agent can answer your grammar questions with real context.

Design and decisions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Status

- **Phase 1 — speech loop: done.** Speech-to-text (ReazonSpeech) keeps learner mistakes (12/12 with a real voice); correction + pet reply via Qwen3.6; VOICEVOX voice. Test page at `/lab.html`.
- **Phase 2 — the pet: done.** PixiJS cat at `/` (sample screen at `/?demo`, animation switch at `/?debug`), WebSocket protocol (`shared/protocol.ts`) that the ESP32 board will also use, pet stats (hunger, happiness, streak) in SQLite.
- **Phase 3 — learning records + grammar Q&A: in progress.** Every sentence, correction, listening miss and question is written to `~/vault/Japanese/` (see [Learning records](#learning-records)). **Ask grammar** in the composer (or **Ask about this** on a review card) sends a grammar question to Hermes on Claude. **Ask Hermes** sends anything else (chat, "what have I learnt this week?") to Hermes on its local model. Hermes reads those notes either way; if it's down, the pet's own model answers.

Later phases: ESP32-S3 firmware, away-from-home access.

## Services

neko is a Fastify server that calls these local services:

| Service | Default URL | What for |
|---|---|---|
| llama.cpp (Qwen3.6) | `http://127.0.0.1:8080` | Grammar correction and pet replies (thinking off, JSON output) |
| sherpa-onnx offline WebSocket server | `ws://127.0.0.1:6006` | Japanese speech-to-text (ReazonSpeech or SenseVoice) |
| VOICEVOX engine | `http://127.0.0.1:50021` | The pet's voice |
| Hermes Agent API server | `http://127.0.0.1:8642` | Questions (grammar on Claude, casual on the local model), answered from the vault (optional: falls back to llama.cpp) |

Binaries live in `~/apps/`, speech models in `~/models/stt/`.

### Running as services (recommended)

`deploy/systemd/` has units for all three neko processes: `neko-stt` (ReazonSpeech on :6006), `neko-voicevox` (:50021) and `neko` (:8081). Install and start them with:

```bash
sudo ./deploy/install-services.sh
```

Then manage them with `systemctl status|restart neko neko-stt neko-voicevox` and read logs with `journalctl -u neko -f`. The manual commands below are for debugging or the bake-off.

### Hermes API server (grammar questions)

Hermes's OpenAI-compatible API is turned on in `~/.hermes/.env` (`API_SERVER_ENABLED=true`, `API_SERVER_KEY=...`); neko sends the same key as `HERMES_KEY` in `server/.env`. Run the Hermes gateway as a boot-time service:

```bash
sudo hermes gateway install --system --run-as-user jedev --start-now
curl http://127.0.0.1:8642/health      # {"status": "ok", ...}
```

There are two WebSocket messages. `ask_grammar` (**Ask grammar**) has Hermes answer with **Claude Opus 5.5** (`HERMES_MODEL` / `HERMES_PROVIDER`), which needs `ANTHROPIC_API_KEY` in `~/.hermes/.env`. `ask_casual` (**Ask Hermes**) names no model, so Hermes answers with its own default model, the local Qwen; it's for chat and questions about your own progress, and allows a longer answer. Hermes's own default model stays the local Qwen, and live corrections stay on llama.cpp. If Hermes or the API is unreachable, llama.cpp answers in ~10 s, marked in the app as "the pet's own model".

Answers come back in the language the question was written in (English, Chinese, Malay, Japanese, ...): a quick local call names the language first, and the prompt states it outright. The last 4 questions and answers from the past 12 hours go along with each question, so follow-ups like "and what about で?" work. Every answer card shows which model actually wrote it (e.g. "Hermes · Claude Opus 5.5"), taken from Hermes's `runtime` field, so a silent Hermes fallback to another model is visible.

### Weekly review (Hermes cron)

A Hermes cron job, "neko weekly Japanese review", runs **Sundays at 20:00** (`HERMES_TIMEZONE=Asia/Kuala_Lumpur` in `~/.hermes/.env`) on the local model. It reads the week's notes and writes `~/vault/Japanese/Notes/Weekly/<date>.md`: the week in numbers, 2–3 focus grammar points with your own wrong sentences and new examples, listening trouble spots, and sentences to try on the pet. Manage it with `hermes cron list` / `hermes cron run <id>` / `hermes cron edit <id>`.

### Starting the speech-to-text server

ReazonSpeech (Zipformer transducer, int8) — the model neko uses:

```bash
SHERPA=~/apps/sherpa-onnx-v2.0.1-linux-x64-shared
M=~/models/stt/sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01
LD_LIBRARY_PATH=$SHERPA/lib $SHERPA/bin/sherpa-onnx-offline-websocket-server \
  --port=6006 --num-threads=4 --num-work-threads=2 --max-batch-size=2 --model-type=transducer \
  --tokens=$M/tokens.txt \
  --encoder=$M/encoder-epoch-99-avg-1.int8.onnx \
  --decoder=$M/decoder-epoch-99-avg-1.int8.onnx \
  --joiner=$M/joiner-epoch-99-avg-1.int8.onnx
```

SenseVoice (bake-off comparison only):

```bash
M=~/models/stt/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17
LD_LIBRARY_PATH=$SHERPA/lib $SHERPA/bin/sherpa-onnx-offline-websocket-server \
  --port=6007 --num-threads=4 \
  --tokens=$M/tokens.txt --sense-voice-model=$M/model.int8.onnx --sense-voice-language=ja
```

### Starting VOICEVOX

```bash
~/apps/voicevox/engine/run --host 127.0.0.1 --port 50021 --cpu_num_threads 4
```

Voice credit: `VOICEVOX:<character name>` for whichever voice the pet uses.

## Running neko

```bash
cd web && npm install && npm run build      # builds the pet app into web/dist (served by neko)
cd ../server
cp .env.example .env     # set NEKO_TZ, VOICEVOX_SPEAKER, NEKO_LEVEL, ...
npm install
npm start                # http://127.0.0.1:8081  (pet at /, lab page at /lab.html)
```

After changing web code, run `npm run build` in `web/` again. For live reload while developing the pet, run `npm run dev` in `web/` (Vite on :5173, forwarding `/api` and `/ws` to the neko server).

The microphone only works on a secure origin, so open the page as `http://localhost:8081`. If the box is remote, tunnel it first:

```bash
ssh -L 8081:localhost:8081 <box>
```

### Config (`server/.env`)

| Var | Default | |
|---|---|---|
| `NEKO_HOST` / `NEKO_PORT` | `127.0.0.1` / `8081` | |
| `LLAMA_URL` | `http://127.0.0.1:8080` | |
| `STT_URL` | `ws://127.0.0.1:6006` | sherpa-onnx server |
| `VOICEVOX_URL` | `http://127.0.0.1:50021` | |
| `VOICEVOX_SPEAKER` | `3` | style id; list with `GET /api/voices` |
| `NEKO_LEVEL` | `N4` | JLPT level the pet speaks at (N5–N1) |
| `NEKO_PET_NAME` | `ねこ` | The pet's name |
| `NEKO_TZ` | box time zone | Your time zone (e.g. `Asia/Tokyo`): the pet sleeps 23:00–07:00 local time, and "today" for the streak |
| `NEKO_VAULT_DIR` | `~/vault/Japanese` | Where learning records are written; empty turns it off |
| `HERMES_URL` | `http://127.0.0.1:8642` | Hermes API server |
| `HERMES_KEY` | (none) | Same as `API_SERVER_KEY` in `~/.hermes/.env`; without it, questions go straight to llama.cpp |
| `HERMES_MODEL` / `HERMES_PROVIDER` | `claude-opus-5-5` / `anthropic` | Model Hermes answers grammar questions with; both empty = Hermes's default model |
| `NEKO_DATA_DIR` | `server/data` | SQLite database folder (point it elsewhere for tests) |

## Learning records

The Obsidian vault is the only copy of your learning record. neko appends each event to the day's note in `~/vault/Japanese/` once, and never reads, rewrites or rebuilds it. Hermes (or you) can reorganise the vault freely:

```
Daily/<date>.md          every sentence with its fix and the pet's reply, translations, listening misses, questions, review practice
Notes/                   free for you and Hermes; neko never writes here (Hermes's weekly reviews go in Notes/Weekly/)
```

neko keeps no learning history of its own. The page shows only the current visit and starts empty after a refresh. To look back:
- The **Notes** page (`/notes.html`) lists every markdown file in the vault and shows each one as written, with buttons to copy or download it.
- **Ask Hermes** sends the question to Hermes on the local model, which reads the notes. For example, "what have I been getting wrong this week?"

The database holds only the pet's stats and streak, and the generated translation challenge sentences.

The **Review your mistakes** panel groups this visit's mistakes by grammar point, from both the conversation and the translation card. **Practise** brings back one of those sentences for you to fix, and ねこ checks it. Each attempt is appended to the day's note.

To clear test records, stop neko and run `npm run reset-records` in `server/`. It only reports what it would delete. Add `--yes` to delete the daily notes, `--before YYYY-MM-DD` to keep that day and later, and `--pet` to also reset ねこ's stats and streak. It also removes what older versions left behind: `Index.md`, `Grammar/` and the old record tables in the database, which it backs up to `server/data/neko-backup-<time>.db` first. `Notes/` is never touched.

### Pet protocol

The pet app and the ESP32 board talk to neko over one WebSocket at `/ws`: JSON messages plus binary 16-bit PCM audio. All message types and the turn flow are documented in [`shared/protocol.ts`](shared/protocol.ts).

### HTTP API (lab page and tools)

| Endpoint | |
|---|---|
| `POST /api/stt` | Raw 16-bit mono PCM (`x-sample-rate`, default 16000) → `{text, ms}` |
| `POST /api/reply` | `{text, history}` → pet reply and its check of the sentence `{ja, en, mood, correction: {is_correct, corrected, mistakes, natural}, ms}` |
| `POST /api/review/practice` | `{point, said, original, fix, answer}` → ねこ's check of your fix `{ok, still, mistakes}` |
| `GET /api/notes` | the vault's markdown files `[{path, mtime, size}]`, newest first |
| `GET /api/notes/file?path=` | one note's markdown, as written |
| `POST /api/tts` | `{text, slow}` → WAV in the pet's voice |
| `GET /api/voices` | VOICEVOX voices |
| `GET /api/voice-test` | The voice-test sentences (Japanese, romaji, intended mistake) |
| `POST /api/voice-test/:n` | Raw PCM of you reading sentence `n` → `{transcript, verdict, ms}`; recording saved to `server/data/voice-tests/` |
| `GET /api/health` | Status of llama.cpp, STT, VOICEVOX and Hermes |

## STT bake-off

Result (2026-10-30, synthetic VOICEVOX speech with 0.3 s padding): **ReazonSpeech kept 12/12** sentences exactly, ~40 ms each; SenseVoice 11/12 with two small mishearings, ~60 ms. Neither model auto-corrected any grammar. ReazonSpeech is the default.

Checks whether each speech-to-text model keeps deliberate grammar mistakes (VOICEVOX speaks 10 N4-level wrong sentences + 2 correct controls):

```bash
cd server
npm run bakeoff -- reazonspeech=ws://127.0.0.1:6006 sensevoice=ws://127.0.0.1:6007   # add --ja to print Japanese transcripts
```

To test with **your own voice**, open the **Voice test** tab in the web page: it walks through the same sentences (with romaji and the mistake to make), scores each recording, and saves it in `server/data/voice-tests/` for re-testing later.

## Layout

```
docs/ARCHITECTURE.md   design and decisions
shared/protocol.ts     WebSocket protocol (server, web app, and later the board)
server/                Fastify server
  src/                 hub (pet protocol), pet (stats), records (learning records + vault notes),
                       ask (grammar questions via Hermes), tutor (correction + reply), db,
                       stt, tts, llm, audio, voicetest, index (routes)
  public/lab.html      Phase 1 test page (speech loop + voice test)
  scripts/             STT bake-off
  data/                SQLite database (pet + records) and voice-test recordings (not in git)
web/                   PixiJS pet app (Vite); build output in web/dist
deploy/systemd/        service units
```
