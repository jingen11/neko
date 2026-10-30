# neko 🐱

A Japanese-learning tamagotchi. The pet lives in a web app on the box and will travel with you on an ESP32-S3 board. It talks to you in Japanese at your JLPT level, corrects your grammar when you speak, and (later) records your mistakes in an Obsidian vault so Hermes Agent can coach you.

Design and decisions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Status

- **Phase 1 — speech loop: done.** Speech-to-text (ReazonSpeech) keeps learner mistakes (12/12 with a real voice); correction + pet reply via Qwen3.6; VOICEVOX voice. Test page at `/lab.html`.
- **Phase 2 — the pet: in progress.** PixiJS cat at `/`, WebSocket protocol (`shared/protocol.ts`) that the ESP32 board will also use, pet stats (hunger, happiness, streak) in SQLite.

Later phases: vault learning records + Hermes grammar Q&A, ESP32-S3 firmware, away-from-home access.

## Services

neko is a Fastify server that calls three local services:

| Service | Default URL | What for |
|---|---|---|
| llama.cpp (Qwen3.6) | `http://127.0.0.1:8080` | Grammar correction and pet replies (thinking off, JSON output) |
| sherpa-onnx offline WebSocket server | `ws://127.0.0.1:6006` | Japanese speech-to-text (ReazonSpeech or SenseVoice) |
| VOICEVOX engine | `http://127.0.0.1:50021` | The pet's voice |

Binaries live in `~/apps/`, speech models in `~/models/stt/`.

### Running as services (recommended)

`deploy/systemd/` has units for all three neko processes: `neko-stt` (ReazonSpeech on :6006), `neko-voicevox` (:50021) and `neko` (:8081). Install and start them with:

```bash
sudo ./deploy/install-services.sh
```

Then manage them with `systemctl status|restart neko neko-stt neko-voicevox` and read logs with `journalctl -u neko -f`. The manual commands below are for debugging or the bake-off.

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

### Pet protocol

The pet app and the ESP32 board talk to neko over one WebSocket at `/ws`: JSON messages plus binary 16-bit PCM audio. All message types and the turn flow are documented in [`shared/protocol.ts`](shared/protocol.ts).

### HTTP API (lab page and tools)

| Endpoint | |
|---|---|
| `POST /api/stt` | Raw 16-bit mono PCM (`x-sample-rate`, default 16000) → `{text, ms}` |
| `POST /api/reply` | `{text, history}` → pet reply `{ja, en, mood, ms}` |
| `POST /api/correct` | `{text, history}` → correction card `{is_correct, corrected, mistakes, natural, ms}` |
| `POST /api/tts` | `{text, slow}` → WAV in the pet's voice |
| `GET /api/voices` | VOICEVOX voices |
| `GET /api/voice-test` | The voice-test sentences (Japanese, romaji, intended mistake) |
| `POST /api/voice-test/:n` | Raw PCM of you reading sentence `n` → `{transcript, verdict, ms}`; recording saved to `server/data/voice-tests/` |
| `GET /api/health` | Status of llama.cpp, STT and VOICEVOX |

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
  src/                 hub (pet protocol), pet (stats, SQLite), tutor (correction + reply),
                       stt, tts, llm, audio, voicetest, index (routes)
  public/lab.html      Phase 1 test page (speech loop + voice test)
  scripts/             STT bake-off
  data/                pet database + voice-test recordings (not in git)
web/                   PixiJS pet app (Vite); build output in web/dist
deploy/systemd/        service units
```
