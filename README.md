# neko 🐱

A Japanese-learning tamagotchi. The pet lives in a web app on the box and will travel with you on an ESP32-S3 board. It talks to you in Japanese at your JLPT level, corrects your grammar when you speak, and records your practice and mistakes in an Obsidian vault so Hermes Agent can answer your grammar questions with real context.

Design and decisions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Status

- **Phase 1 — speech loop: done.** Speech-to-text (ReazonSpeech) keeps learner mistakes (12/12 with a real voice); correction + pet reply via Qwen3.6; VOICEVOX voice. Test page at `/lab.html`.
- **Phase 2 — the pet: done.** PixiJS cat at `/` (sample screen at `/?demo`, animation switch at `/?debug`), WebSocket protocol (`shared/protocol.ts`) that the ESP32 board will also use, pet stats (hunger, happiness, streak) in SQLite.
- **Phase 3 — learning records + questions: built, being checked on the box.** Every sentence, correction, translation, listening miss, question and review attempt is appended to the day's note in `~/vault/Japanese/` (see [Learning records](#learning-records)); the **Notes** page shows them, and Hermes writes a weekly review. **Ask grammar** in the composer (or **Ask about this** on a review card) sends a grammar question to Hermes on Claude. **Ask Hermes** sends anything else (chat, "what have I learnt this week?") to Hermes on its local model. Hermes reads those notes either way; if it's down, the pet's own model answers.

- **Phase 4 — the board: in progress.** Firmware in [`firmware/`](firmware/README.md) for the Waveshare ESP32-S3-Touch-LCD-1.83: the same pixel-art cat as the web app, Japanese and English lines (DotGothic16), ねこ's voice on the speaker with lip-sync, push-to-talk (hold the screen), the grammar check as a card, tap to pet, battery level and deep sleep (touch to wake), Wi-Fi bars, home Wi-Fi with the phone's hotspot as a fallback. Still to do: IMU reactions, Wi-Fi setup without rebuilding.

- **Phase 5 — away from home: done.** The board joins the tailnet itself (microlink) and reaches the box at its tailnet address, from home Wi-Fi or the phone's hotspot, switching between them; see [Using the board away from home](docs/ARCHITECTURE.md#using-the-board-away-from-home-tailscale).

Later phases: GPS add-on.

## Services

neko is a Fastify server that calls these local services:

| Service | Default URL | What for |
|---|---|---|
| llama.cpp (Qwen3.6) | `http://127.0.0.1:8080` | The grammar check of each sentence, translation challenges (thinking off, JSON output) |
| sherpa-onnx offline WebSocket server | `ws://127.0.0.1:6006` | Japanese speech-to-text (ReazonSpeech or SenseVoice) |
| VOICEVOX engine | `http://127.0.0.1:50021` | The pet's voice |
| Hermes Agent API server | `http://127.0.0.1:8642` | ねこ's spoken replies (`neko` profile, with time and weather tools); questions (grammar on Claude, casual on the local model), answered from the vault (no fallback) |
| llama.cpp (BGE-M3, `neko-embed`) | `http://127.0.0.1:8082` | Meaning search in the textbook tools (used by Hermes's textbook MCP server, not by neko; optional, exact search without it) |
| MQTT broker (Zigbee2MQTT) | `MQTT_URL`, e.g. `mqtt://127.0.0.1:1883` | Home sensors: ねこ reacts when the front door opens or the window shakes (optional: off while `MQTT_URL` is empty) |
| ip2location.io | `https://api.ip2location.io` | Where each client is, from its public IP (`server/src/location.ts`): the address comes from `CF-Connecting-IP` behind the Cloudflare Tunnel, else the socket; a LAN address means home, so the box locates itself. Cached 6 h per address, logged on connect (optional: off while `IP2LOCATION_KEY` is empty) |

Binaries live in `~/apps/`, speech models in `~/models/stt/`.

### Running as services (recommended)

`deploy/systemd/` has units for all three neko processes: `neko-stt` (ReazonSpeech on :6006), `neko-voicevox` (:50021) and `neko` (:8081). Install and start them with:

```bash
sudo ./deploy/install-services.sh
```

Then manage them with `systemctl status|restart neko neko-stt neko-voicevox` and read logs with `journalctl -u neko -f`. The manual commands below are for debugging or the bake-off.

### Hermes API server (grammar questions)

Every Ask box question goes through Hermes; neko never calls a model directly for them. One Hermes gateway on :8642 serves two profiles, each with its own model and its own API key:

| Profile | Model | Address | Key in `server/.env` |
|---|---|---|---|
| `default` | local Qwen (llama.cpp) | `/v1/...` | `HERMES_KEY` = `API_SERVER_KEY` in `~/.hermes/.env` |
| `pro` | Claude Opus 5.5 (Anthropic) | `/p/pro/v1/...` | `HERMES_PRO_KEY` = `API_SERVER_KEY` in `~/.hermes/profiles/pro/.env` |

The `pro` profile was cloned from `default` (`hermes profile create pro --clone`), then set to `model.provider anthropic` / `model.default claude-opus-5-5`; it needs `ANTHROPIC_API_KEY` in its own `.env`. Run the Hermes gateway as a boot-time service:

```bash
sudo hermes gateway install --system --run-as-user jedev --start-now
curl http://127.0.0.1:8642/health      # {"status": "ok", ...}
```

There are two WebSocket messages. `ask_grammar` (**Ask grammar**) goes to the `pro` profile (`HERMES_PRO_PROFILE`), so Claude Opus 5.5 answers. `ask_casual` (**Ask Hermes**) goes to the `default` profile, the local Qwen; it's for chat and questions about your own progress, and allows a longer answer. The pet's live conversation, corrections and challenges stay on llama.cpp directly, for speed. If Hermes is unreachable, the question fails with an error in the app; there is no fallback.

Answers come back in the language the question was written in (English, Chinese, Malay, Japanese, ...): the prompt says so, and repeats it next to the question. The last 4 questions and answers from the past 12 hours go along with each question, so follow-ups like "and what about で?" work. Each answer card names the profile's model (e.g. "Hermes · Claude Opus 5.5"), from `HERMES_MODEL_LABEL` / `HERMES_PRO_MODEL_LABEL`: Hermes doesn't report which model served a turn, so keep these in line with the profiles.

### ねこ's replies (Hermes `neko` profile)

Each conversation turn makes two calls at once. The **grammar check** stays on llama.cpp (`petTurn`, unchanged): the model writes its own reply and judges your sentence from that same understanding, but that reply isn't spoken. **What ねこ says** comes from Hermes's `neko` profile (`/p/neko/`, `HERMES_NEKO_PROFILE` / `HERMES_NEKO_KEY`), which can look up the world right now: the time anywhere ("ロンドンはいま何時？") and the weather.

ねこ is a pet and tutor with a brain but no memory: it gets only the recent conversation that neko sends. Only the neko server writes your record. The `neko` profile is set up for that, in `~/.hermes/profiles/neko/`:

- cloned from `default`, on the local model; `SOUL.md` replaced with a short note (follow the app's instructions and format, use tools for real-world facts)
- MCP server: `neko_world` only (this repo's `world/`, see [World tools](#world-tools-mcp-server)): time, weather, where the learner is. Not `mcp-server-time`: with it, the model took the zone from the system prompt (the server's, not the learner's) and misread 24-hour times. Keep MCP server names unique (`neko_world`, not `world`): one gateway shares MCP servers by name across profiles, so a same-named server in another profile takes its place (and its failures).
- no file, skill, memory or session tools (`agent.disabled_toolsets`), all skills off, `auxiliary.background_review.enabled: false`, `memory.memory_enabled` / `user_profile_enabled: false`, `max_turns: 20`

Hermes can't enforce a JSON schema, so the reply's shape (ja, en, mood) is in the prompt and checked in code: a reply in plain Japanese is spoken as is (no English that turn), anything else is retried once. If Hermes fails, the check still shows, ねこ looks sick and the page says why. A turn takes about 5–25 s; tool calls add time.

### World tools (MCP server)

`world/` is a small MCP server (stdio) with ねこ's tools for the world right now. ねこ decides when to use them; nothing about the learner's location goes into its prompt.

- `get_time`: the date and time now, as plain data: ISO 8601 with a 24-hour clock and UTC offset, the weekday and the IANA zone (`2026-11-10T07:23+08:00 (Tuesday, 24-hour clock)`), no language or regional formatting. Without `place`, the learner's own local time; with `place`, that place's (its zone from its coordinates, offline with `@photostructure/tz-lookup`). If the learner hasn't been located, home time.
- `get_weather`: now and a daily forecast (1–7 days, today/tomorrow in the place's own time) from Open-Meteo (no key). Without `place`, where the learner is; else a `place` name or `latitude`/`longitude`.
- `where_am_i`: where the learner is (city, region, country, coordinates, IANA time zone, home or away). It reads `GET /api/location` on the neko server, which locates the connected board from its public IP with ip2location.io (`server/src/location.ts`, needs `IP2LOCATION_KEY`).

Time and weather default to where the learner is because Hermes puts the profile's date and time zone in the system prompt, and the model trusted it over `where_am_i` (with the profile set to New York, "what time is it?" came back in New York time).

The coordinates come from ip2location.io's answer; the neko server names the IANA time zone from them offline (`@photostructure/tz-lookup`). A name goes through Open-Meteo's place search first, because its forecast takes coordinates.

"What time is it?" is `get_time()`; "the time in Tokyo?" is `get_time("Tokyo")`; "the weather here?" is `get_weather()`; "the weather in London?" is `get_weather("London")`.

Open-Meteo's servers are in Europe and can take more than Node's 250 ms per address to connect from home (and IPv6 doesn't route), so the server allows 2 s per attempt.

Setup on the box: `cd world && npm install`, then in `~/.hermes/profiles/neko/config.yaml` make `neko_world` the only MCP server (remove `weather` and `neko_time`):

```yaml
  neko_world:
    command: node
    args:
      - /home/jedev/neko/world/src/index.ts   # this repo's path on the box
    env:
      NEKO_URL: http://127.0.0.1:8081
    enabled: true
```

and restart the Hermes gateway. Keep the name unique (`neko_world`): the gateway shares MCP servers by name across profiles.

### Textbook tools (MCP server)

`textbook/` is a small MCP server (stdio) over your own textbook, transcribed into Markdown under `data/textbook/<book>/<unit>/` (not in git: the book is copyrighted, and so are the PDFs in `docs/`). One file per lesson follows the book's parts (基本课文, 语法解释, 表达及词语讲解, 应用课文, 练习, 生词表, 专栏); furigana is written `{起|お}きます` and `<!-- pdf 85 / book 68 -->` marks each page. The server loads every file into memory when it starts. Each search runs two ways and merges the rankings (reciprocal rank fusion):

- **Exact text**, by scanning (a whole book is about 1 MB; a search takes a few ms). Best for particles and specific words.
- **Meaning**, with BGE-M3 embeddings, for questions in other words, English or Chinese, and other verb forms ("我给了朋友礼物" finds the あげます grammar point). Each section, or each ~1200-character piece of a long one, is embedded once and saved in `data/textbook/.index/bge-m3.json`, keyed by a hash of its text. A search embeds only the question (~25 ms) and compares it with the saved vectors. Word lists and unit intros are left out of meaning search; grammar explanations get a small lift.

The model runs as its own service, `neko-embed` (llama.cpp `llama-server --embedding`, `~/models/bge-m3-Q8_0.gguf` from `gpustack/bge-m3-GGUF`, CPU only, `127.0.0.1:8082`, about 0.6 GB RAM). If it is down, search falls back to exact text. After adding or editing lessons, run `cd textbook && npm run index` (about 75 ms a piece; 48 lessons ≈ 1,200 pieces ≈ 90 s); the MCP server also fills in missing vectors in the background when it starts.

| Tool | What it returns |
|---|---|
| `search_textbook(query)` | Matching word-list entries, then the best sections with their lesson, page and matching lines. Japanese (kanji or kana) or Chinese; space-separated terms must all match. A one-character particle (で, を) only matches grammar headings that name it. |
| `get_lesson(lesson, part?, heading?)` | The lesson outline with pages, or the full text of one part (`grammar`, `notes`, `dialogue`, `exercises`, `vocab`, …), or of one grammar point |
| `lesson_vocab(lesson, through?)` | A lesson's word list, or every word up to that lesson |
| `where_am_i()` | Your current lesson (`lesson: N` in the frontmatter of `~/vault/Japanese/Notes/Textbook.md`) and its outline |

It is only in the `default` Hermes profile (`mcp_servers.textbook`: `command: node`, `args: [<repo>/textbook/src/index.ts]`). Hermes starts it, so after adding lessons, restart the gateway (`sudo hermes gateway restart`). ねこ (`neko`) and grammar questions (`pro`) don't have it; casual questions in the Ask box can check the book and cite lesson and page. Setup: `cd textbook && npm install && npm run index`; test with `hermes mcp test textbook`. `lesson_vocab` with `through` lists at most the latest 300 words, so it fits the local model's context.

### Weekly review (Hermes cron)

A Hermes cron job, "neko weekly Japanese review", runs **Sundays at 20:00** (`HERMES_TIMEZONE=Asia/Kuala_Lumpur` in `~/.hermes/.env`) on the local model. It reads the week's daily notes and writes `~/vault/Japanese/Notes/Weekly/<date>.md`: the week in numbers, 2–3 focus grammar points with your own wrong sentences and new examples, review practice, listening trouble spots, the questions you asked, and sentences to try on the pet. Its prompt is kept in [`deploy/hermes/weekly-review-prompt.txt`](deploy/hermes/weekly-review-prompt.txt); it explains the daily note format, so update it when that format changes. Manage the job with `hermes cron list` / `hermes cron run <id>` / `hermes cron edit <id>` (see `hermes cron edit --help` for the flag that sets the prompt).

### Home sensors (Zigbee2MQTT)

With `MQTT_URL` set, neko listens to two Zigbee sensors through Zigbee2MQTT. It only listens; it never changes a device.

| Event | Device (friendly name) | Fires when |
|---|---|---|
| `front_door_open` | `front_door` (`NEKO_DOOR_SENSOR`) | the door opens: `contact` changes to `false` (at most once per 10 s) |
| `front_window_1_vibrate` | `front_window_1` (`NEKO_WINDOW_SENSOR`) | the window is hit: `vibration: true` or `action` `vibration` / `tilt` / `drop` (at most once a minute) |

Messages arrive on `zigbee2mqtt/<friendly name>`. Name the devices in Zigbee2MQTT (web page → device → Rename, or a `bridge/request/device/rename` request), or set the two variables to the names they already have. To see what a sensor sends: `mosquitto_sub -h 127.0.0.1 -t 'zigbee2mqtt/#' -v`.

When one fires, every open page (once ねこ is awake) shows a banner on the stage with the time, and ねこ looks up and says a short line about it, even at night. Retained messages replayed on connect, and repeat reports while the door stays open, don't count. Nothing is written to the vault. The events are in `server/src/sensors.ts`; adding a sensor is one entry there and one name in `SensorEvent` (`shared/protocol.ts`).

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
cp .env.example .env     # set IP2LOCATION_KEY, VOICEVOX_SPEAKER, NEKO_LEVEL, ...
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
| `IP2LOCATION_KEY` | (off) | ip2location.io key. Locates the board from its public IP; its time zone (e.g. `Asia/Tokyo`) is the learner's: the pet sleeps 23:00–07:00 there, and it decides "today" for the streak and the times in notes. Without it, or before the board is located, the box's own time zone |
| `NEKO_VAULT_DIR` | `~/vault/Japanese` | Where learning records are written; empty turns it off |
| `HERMES_URL` | `http://127.0.0.1:8642` | Hermes API server |
| `HERMES_KEY` | (none) | `API_SERVER_KEY` of Hermes's default profile (`~/.hermes/.env`); casual questions |
| `HERMES_PRO_PROFILE` | `pro` | Hermes profile for grammar questions, served at `/p/<profile>/` |
| `HERMES_PRO_KEY` | (none) | `API_SERVER_KEY` of that profile (`~/.hermes/profiles/<profile>/.env`) |
| `HERMES_NEKO_PROFILE` | `neko` | Hermes profile for ねこ's spoken replies, served at `/p/<profile>/` |
| `HERMES_NEKO_KEY` | (none) | `API_SERVER_KEY` of that profile; without it ねこ can't reply (it looks sick) |
| `HERMES_MODEL_LABEL` / `HERMES_PRO_MODEL_LABEL` | `Qwen3.6` / `Claude Opus 5.5` | Model names shown on answer cards (display only) |
| `MQTT_URL` | (none) | MQTT broker Zigbee2MQTT uses, e.g. `mqtt://127.0.0.1:1883`; empty = no sensors. `MQTT_USERNAME` / `MQTT_PASSWORD` if it needs a login, `MQTT_BASE_TOPIC` (`zigbee2mqtt`) |
| `NEKO_DOOR_SENSOR` / `NEKO_WINDOW_SENSOR` | `front_door` / `front_window_1` | Zigbee2MQTT names of the [home sensors](#home-sensors-zigbee2mqtt) |
| `NEKO_DATA_DIR` | `server/data` | SQLite database folder (point it elsewhere for tests) |

## Learning records

The Obsidian vault is the only copy of your learning record. neko appends each event to the day's note in `~/vault/Japanese/` once, and never rewrites or rebuilds it (it reads the vault only to show the Notes page). Hermes (or you) can reorganise the vault freely:

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
| `POST /api/reply` | `{text, history}` → the check of the sentence with llama.cpp's own reply `{ja, en, mood, correction: {is_correct, corrected, mistakes, natural}, ms}` (lab page; the app's spoken reply comes from Hermes) |
| `POST /api/review/practice` | `{point, said, original, fix, answer}` → ねこ's check of your fix `{ok, still, mistakes}` |
| `GET /api/notes` | the vault's markdown files `[{path, mtime, size}]`, newest first |
| `GET /api/notes/file?path=` | one note's markdown, as written |
| `POST /api/tts` | `{text, slow}` → WAV in the pet's voice |
| `GET /api/voices` | VOICEVOX voices |
| `GET /api/voice-test` | The voice-test sentences (Japanese, romaji, intended mistake) |
| `POST /api/voice-test/:n` | Raw PCM of you reading sentence `n` → `{transcript, verdict, ms}`; recording saved to `server/data/voice-tests/` |
| `GET /api/health` | Status of llama.cpp, STT, VOICEVOX, Hermes (`hermes`: the Ask profiles; `hermes_neko`: ねこ's replies) |

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
  src/                 hub (pet protocol), pet (stats), records (appends to the daily notes),
                       notes (reads the vault for the Notes page), ask (questions via Hermes),
                       tutor (grammar check; ねこ's reply via Hermes), hermes (Hermes profile client), challenge (translation), mqtt (Zigbee2MQTT client),
                       sensors (door and window events),
                       db, stt, tts, llm, audio, voicetest, index (routes)
  public/lab.html      Phase 1 test page (speech loop + voice test)
  scripts/             STT bake-off, reset-records
  experiment.md        results of the grammar-checking experiment
  data/                SQLite database (pet stats, streak, challenges) and voice-test recordings (not in git)
web/                   PixiJS pet app (Vite): index.html (practice), notes.html (Notes); build output in web/dist
textbook/              MCP server: search the transcribed textbook (data/textbook/, not in git)
deploy/systemd/        service units
deploy/hermes/         Hermes weekly review prompt
```
