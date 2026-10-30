# neko — architecture

neko is a Japanese-learning tamagotchi. The pet lives in a web app on the box, and travels with you on a small ESP32-S3 board. Everything you practise, and every mistake you make, is written to the Obsidian vault so Hermes Agent can coach you with real context.

## Features

1. **Listening** — the pet speaks Japanese (TTS) at your level; comprehension misses are recorded.
2. **Speaking** — you talk to the pet; it answers in character and gives a separate grammar correction card.
3. **Grammar questions** — ask about grammar you've learnt; answered by Hermes using your vault history.

## System

```
                           ┌──────────────── the box ─────────────────────────┐
 ESP32-S3 board        ◀──▶│ neko server (Fastify + WebSocket)                │
  (mic/speaker/touch)  WS  │  ├─ pet engine (mood, hunger, streak) ── SQLite  │
                           │  ├─ STT  sherpa-onnx server (native, own service)│
 browser (PixiJS pet)  ◀──▶│  ├─ TTS  VOICEVOX engine (:50021)                │
                           │  ├─ llama.cpp :8080 — pet chat + corrections     │
                           │  ├─ Hermes API — grammar Q&A                     │
                           │  └─ learning records ──▶ ~/vault/Japanese/       │
                           └──────────────────────────────────────────────────┘
```

| Concern | Choice | Notes |
|---|---|---|
| Frontend | PixiJS (Vite) | Same sprite sheets exported for web (PNG) and board (RGB565). |
| Backend | Node + TypeScript, Fastify, `@fastify/websocket` | No Hono. |
| Speech → text | sherpa-onnx **native binary** (prebuilt `sherpa-onnx-offline-websocket-server`), run as a systemd service | neko talks to it over a local WebSocket. No Node native bindings. Candidates below; must not "fix" learner grammar. |
| Text → speech | VOICEVOX engine (native Linux CPU build, :50021) | Free; credit `VOICEVOX:<character>`. Real Japanese reading/accent dictionary (OpenJTalk). Load only the pet's one voice to keep RAM down. 24 kHz → resample to 16 kHz for board. |
| Pet chat | llama.cpp Qwen3.6, thinking **off** | Low latency, stays in character. |
| Grammar correction | llama.cpp Qwen3.6, JSON output | Separate call from the chat reply. Frontier model is a possible later upgrade. |
| Grammar Q&A | Hermes Agent API server | Reads vault mistakes; writes grammar notes (llm-wiki). |
| Pet state | SQLite | |
| Learning records | `~/vault/Japanese/` | neko writes records; Hermes writes summaries only. |
| Level | Config `level: N4` (N5–N1) | Limits vocab/grammar in prompts, furigana above level, explanation depth. |

## Speech-to-text: no auto-correction

Whisper (and Whisper-derived models like kotoba-whisper) has a large text decoder that acts as a language model: it tends to output what you *should* have said, which hides the mistakes we want to catch. Models that follow the audio more literally:

- **ReazonSpeech k2 v2** — Japanese-only Zipformer transducer, ~160M params, trained on ~35k hours of Japanese TV. Runs on CPU via sherpa-onnx. Primary candidate.
- **SenseVoice Small** — non-autoregressive (CTC-style), multilingual incl. Japanese, very fast, via sherpa-onnx.
- **Whisper large-v3-turbo** — kept only as a comparison baseline.

Both candidates run on sherpa-onnx's prebuilt native binaries: `sherpa-onnx-offline` (CLI) for the bake-off, and `sherpa-onnx-offline-websocket-server` as the long-running service. If the bake-off shows both lose too many mistakes, the fallbacks are SenseVoice.cpp (native ggml port, Vulkan-capable) or the larger official ReazonSpeech NeMo model (Python).

No model is perfectly verbatim: mumbled particles (は/が/を) are acoustically ambiguous. So the UI always shows the transcript and lets you confirm or edit it before correction. Phase 1 is a bake-off: record sentences with deliberate mistakes and see which model preserves them.

## Text-to-speech: correct pronunciation

The pet's voice is what you learn pronunciation from, so correct kanji readings and pitch accent matter more than anything else.

- **VOICEVOX (chosen)** — uses OpenJTalk, a real Japanese reading/accent dictionary, and its character voices suit a pet. Runs as its own native engine process. To keep RAM down, only the pet's voice model is loaded.
- **Rejected: Supertonic 3 (sherpa-onnx)** — would have shared the runtime with STT and saved RAM, but it is multilingual and character-based with no Japanese dictionary, so kanji readings and pitch accent can be wrong — not acceptable for listening practice.

## Board: Waveshare ESP32-S3-Touch-LCD-1.83

- ESP32-S3R8, 8 MB PSRAM, 16 MB flash, Wi-Fi + BLE 5.
- 1.83" 240×284 IPS (ST7789P, SPI), capacitive touch (CST816D) — **pet the pet**.
- Audio: ES8311 codec + **ES7210 ADC with echo-cancellation reference**, dual mics — the board can hear you while the pet talks (ESP-SR AFE), so push-to-talk is optional rather than required.
- Speaker: MX1.25 header — **speaker not included**, buy a small 8 Ω 1–2 W speaker.
- QMI8658 IMU (shake / pick-up reactions), PCF85063 RTC, AXP2101 battery management, TF slot.

### Board ↔ box protocol (one WebSocket)

- **Binary frames:** audio, 16 kHz 16-bit mono PCM both directions (~32 KB/s). Opus later if bandwidth matters.
- **Text frames:** JSON events.

```
board → box: hello{deviceId, fw, token}  listen_start  listen_end  touch{x,y,gesture}  imu{event}
box → board: state{mood, anim, hunger, streak}  say{text, furigana}
             audio_start{rate}  audio_end  correction{original, fixed, notes}
```

The board renders the pet from sprite frames in flash, driven by `state.anim`. No video is streamed.

## ⚠️ Open issue: using the board away from home

On home Wi-Fi the board connects straight to the box's LAN address. Away from home it has no route to the box:

- Tailscale/WireGuard clients are not practical on the ESP32-S3, so a VPN-only setup won't work.
- The box will need a public `wss://` endpoint, most likely a **Cloudflare Tunnel** (no open ports on the router).
- Once public, the WebSocket **must** authenticate: a per-device token in `hello`, rejected otherwise. (The rest of neko currently has no auth.)
- Wi-Fi away from home: the board needs to join a phone hotspot — plan a way to configure Wi-Fi credentials (captive-portal provisioning or a list of known networks).
- Latency over mobile data will be higher; audio may need Opus instead of raw PCM.

Decide this before Phase 5.

## Build order (riskiest first)

1. **Speech loop in the browser** — mic → STT bake-off → correction → VOICEVOX → playback. Measure latency and memory.
2. **Pet engine + PixiJS pet + WebSocket protocol**, browser as the first client.
3. **Vault learning records + Hermes grammar Q&A.**
4. **ESP32-S3 firmware** — WebSocket client, audio via ES8311/ES7210, sprite rendering, touch and IMU.
5. **Away-from-home access** — see open issue above.

## Constraints

- Box: Ryzen 9 8945HS, Radeon 780M iGPU, 26 GB shared RAM. Qwen3.6 uses ~20 GB, leaving ~8 GB for STT, TTS, neko and Hermes.
- llama.cpp has 4 parallel slots shared by neko and Hermes.
