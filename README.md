# neko 🐱

A Japanese-learning tamagotchi. The pet lives in a web app on the box and will travel with you on an ESP32-S3 board. It talks to you in Japanese at your JLPT level, corrects your grammar when you speak, and (later) records your mistakes in an Obsidian vault so Hermes Agent can coach you.

Design and decisions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Status

**Phase 1 — speech loop (in progress).** Browser test page: hold to talk → speech-to-text → grammar correction + pet reply → pet speaks. Plus a bake-off to pick the speech-to-text model that keeps learner mistakes instead of auto-correcting them.

Later phases: PixiJS pet and WebSocket protocol, vault learning records + Hermes grammar Q&A, ESP32-S3 firmware, away-from-home access.

## Services

neko is a Fastify server that calls three local services:

| Service | Default URL | What for |
|---|---|---|
| llama.cpp (Qwen3.6) | `http://127.0.0.1:8080` | Grammar correction and pet replies (thinking off, JSON output) |
| sherpa-onnx offline WebSocket server | `ws://127.0.0.1:6006` | Japanese speech-to-text (ReazonSpeech or SenseVoice) |
| VOICEVOX engine | `http://127.0.0.1:50021` | The pet's voice |

Binaries live in `~/apps/`, speech models in `~/models/stt/`.

### Starting the speech-to-text server

ReazonSpeech (Zipformer transducer):

```bash
SHERPA=~/apps/sherpa-onnx-v2.0.1-linux-x64-shared
M=~/models/stt/sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01
LD_LIBRARY_PATH=$SHERPA/lib $SHERPA/bin/sherpa-onnx-offline-websocket-server \
  --port=6006 --num-threads=4 \
  --tokens=$M/tokens.txt --encoder=$M/encoder-*.onnx --decoder=$M/decoder-*.onnx --joiner=$M/joiner-*.onnx
```

SenseVoice:

```bash
M=~/models/stt/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17
LD_LIBRARY_PATH=$SHERPA/lib $SHERPA/bin/sherpa-onnx-offline-websocket-server \
  --port=6007 --num-threads=4 \
  --tokens=$M/tokens.txt --sense-voice-model=$M/model.int8.onnx --sense-voice-language=ja
```

(Exact model file names are confirmed once the downloads finish; these will move into systemd units.)

### Starting VOICEVOX

```bash
~/apps/voicevox/<extracted engine>/run --host 127.0.0.1 --port 50021
```

Voice credit: `VOICEVOX:<character name>` for whichever voice the pet uses.

## Running neko

```bash
cd server
cp .env.example .env     # set VOICEVOX_SPEAKER, NEKO_LEVEL, service URLs
npm install
npm start                # http://127.0.0.1:8081
```

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

### API

| Endpoint | |
|---|---|
| `POST /api/stt` | Raw 16-bit mono PCM (`x-sample-rate`, default 16000) → `{text, ms}` |
| `POST /api/respond` | `{text, history}` → `{correction, reply, timings}` |
| `POST /api/tts` | `{text, slow}` → WAV in the pet's voice |
| `GET /api/voices` | VOICEVOX voices |
| `GET /api/health` | Status of llama.cpp, STT and VOICEVOX |

## STT bake-off

Checks whether each speech-to-text model keeps deliberate grammar mistakes (VOICEVOX speaks 10 N4-level wrong sentences + 2 correct controls):

```bash
cd server
npm run bakeoff -- reazonspeech=ws://127.0.0.1:6006 sensevoice=ws://127.0.0.1:6007
```

## Layout

```
docs/ARCHITECTURE.md   design and decisions
server/                Fastify server, clients for llama.cpp / sherpa-onnx / VOICEVOX
  src/                 config, stt, tts, llm, tutor (correction + pet reply), index (routes)
  public/              Phase 1 browser test page
  scripts/             STT bake-off
```
