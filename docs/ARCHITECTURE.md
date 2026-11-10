# neko — architecture

neko is a Japanese-learning tamagotchi. The pet lives in a web app on the box, and travels with you on a small ESP32-S3 board. Everything you practise, and every mistake you make, is written to the Obsidian vault so Hermes Agent can coach you with real context.

## Features

1. **Listening** — the pet speaks Japanese (TTS) at your level; comprehension misses are recorded.
2. **Speaking** — you talk to the pet; it answers in character and checks your grammar in the same answer, shown as a correction card.
3. **Translation** — a Chinese sentence to put into Japanese, on a random grammar point at your level; scored with a corrected answer.
4. **Review** — this visit's mistakes grouped by grammar point; practise fixing them and the pet checks you.
5. **Questions** — grammar questions go to Hermes on Claude; anything else ("what have I learnt this week?") goes to Hermes on the local model. Hermes reads the vault for both.

## System

```
                           ┌──────────────── the box ─────────────────────────┐
 ESP32-S3 board        ◀──▶│ neko server (Fastify + WebSocket)                │
  (mic/speaker/touch,  WS  │  ├─ pet engine (mood, hunger, streak) ── SQLite  │
   GPS add-on)             │  ├─ location (latest fix, in memory)             │
                           │  ├─ STT  sherpa-onnx server (native, own service)│
 browser (PixiJS pet)  ◀──▶│  ├─ TTS  VOICEVOX engine (:50021)                │
                           │  ├─ llama.cpp :8080 — grammar check, challenges  │
                           │  ├─ llama.cpp :8082 — BGE-M3 textbook embeddings │
                           │  ├─ Hermes API :8642 — ねこ's replies (time and   │
                           │  │    weather tools), questions, weekly review   │
                           │  └─ learning records ──▶ ~/vault/Japanese/ (md)  │
                           └──────────────────────────────────────────────────┘
```

| Concern | Choice | Notes |
|---|---|---|
| Frontend | PixiJS (Vite) | Pixel-art GIFs in `web/public/pet/` (one per animation); the same frames will be converted to RGB565 for the board. |
| Backend | Node + TypeScript, Fastify, `@fastify/websocket` | No Hono. |
| Speech → text | sherpa-onnx **native binary** (prebuilt `sherpa-onnx-offline-websocket-server`), run as a systemd service | neko talks to it over a local WebSocket. No Node native bindings. Candidates below; must not "fix" learner grammar. |
| Text → speech | VOICEVOX engine (native Linux CPU build, :50021) | Free; credit `VOICEVOX:<character>`. Real Japanese reading/accent dictionary (OpenJTalk). Load only the pet's one voice to keep RAM down. 24 kHz → resample to 16 kHz for board. |
| Grammar check | llama.cpp Qwen3.6, thinking **off**, one JSON answer (temperature 0.7) | The model writes a reply first (ja, en, mood), then the mistakes, corrected and natural sentences: judging the sentence from the same understanding beat a separate teacher call (a separate checker invented mistakes; thinking on was right but took 75–124 s, see `server/experiment.md`). Fixes that change nothing or change the meaning are dropped in code. This reply is **not spoken**; it only anchors the check. |
| ねこ's spoken reply | Hermes `neko` profile (local Qwen), in parallel with the check | ねこ is a pet and tutor with a brain but no memory: it gets only the recent conversation, and its tools are this repo's `world/` MCP server: **time** and **weather** (Open-Meteo), both defaulting to where the learner is, and **where_am_i**. No file, skill, memory or session tools, no background review, Hermes memory off — only the neko server writes the record. The JSON shape (ja, en, mood) is asked for in the prompt (Hermes can't enforce a schema): a plain-Japanese reply is spoken without English; anything else is retried once. If Hermes fails, the check still shows and ねこ looks sick. A turn takes ~5–25 s (tool calls add time). |
| Questions | Hermes Agent API server | `ask_grammar` → Hermes's `pro` profile (Claude Opus 5.5, `/p/pro/`); `ask_casual` → its `default` profile (local Qwen). Hermes reads the vault itself. neko never calls a model directly for questions; if Hermes is down, the question fails. |
| Textbook | `textbook/` MCP server (stdio), started by Hermes | The learner's own book, transcribed into Markdown in `data/textbook/` (not in git, copyright). Loaded into memory; each search merges exact text (scanning, a book is ~1 MB) and meaning (BGE-M3 embeddings from the `neko-embed` llama.cpp service on CPU, ~0.6 GB; section vectors saved once in `data/textbook/.index/`, only the question is embedded per search). No database: comparing with ~1,200 vectors takes under 1 ms. Falls back to exact text if `neko-embed` is down. Tools: `search_textbook`, `get_lesson`, `lesson_vocab`, `where_am_i` (current lesson from `Notes/Textbook.md`). Only in the `default` profile (casual questions). Read-only. |
| Weekly review | Hermes cron job | Reads the week's daily notes and writes `Notes/Weekly/<date>.md`. Prompt in `deploy/hermes/weekly-review-prompt.txt`. |
| Pet state | SQLite | Pet stats, practice days (streak and today's count), generated translation challenges. No learning history. |
| Learning records | `~/vault/Japanese/Daily/<date>.md` | The only copy. neko appends each event and never reads it back. Hermes and the learner write in `Notes/`. The web app shows only the current visit; the Notes page (`/notes.html`) shows the vault. |
| Home sensors | MQTT → Zigbee2MQTT (optional) | `mqtt.ts` wraps the protocol; `sensors.ts` turns device messages into events (`front_door_open`, `front_window_1_vibrate`). neko only subscribes. On an event every client gets a `sensor` message (banner) and ねこ says a line. Off while `MQTT_URL` is empty. |
| Level | Config `level: N4` (N5–N1) | Limits vocab/grammar in prompts, furigana above level, explanation depth. |

## Speech-to-text: no auto-correction

Whisper (and Whisper-derived models like kotoba-whisper) has a large text decoder that acts as a language model: it tends to output what you *should* have said, which hides the mistakes we want to catch. Models that follow the audio more literally:

- **ReazonSpeech k2 v2** — Japanese-only Zipformer transducer, ~160M params, trained on ~35k hours of Japanese TV. Runs on CPU via sherpa-onnx. Primary candidate.
- **SenseVoice Small** — non-autoregressive (CTC-style), multilingual incl. Japanese, very fast, via sherpa-onnx.
- **Whisper large-v3-turbo** — kept only as a comparison baseline.

Both candidates run on sherpa-onnx's prebuilt native binaries: `sherpa-onnx-offline` (CLI) for the bake-off, and `sherpa-onnx-offline-websocket-server` as the long-running service. If the bake-off shows both lose too many mistakes, the fallbacks are SenseVoice.cpp (native ggml port, Vulkan-capable) or the larger official ReazonSpeech NeMo model (Python).

No model is perfectly verbatim: mumbled particles (は/が/を) are acoustically ambiguous. So the UI always shows the transcript and lets you confirm or edit it before correction. **Bake-off result (2026-10-30):** VOICEVOX spoke 10 N4 sentences with deliberate mistakes + 2 correct controls. With 0.3 s of silence padding, **ReazonSpeech k2 v2 (int8) kept 12/12 exactly** (~40 ms per sentence, ~400 MB RAM); SenseVoice kept 11/12 with two small mishearings (~60 ms). Neither model auto-corrected grammar. Without padding ReazonSpeech dropped the first word of clips that start instantly, so neko pads all push-to-talk audio. **ReazonSpeech is the chosen model.** Confirmed with the user's own voice (2026-10-30): 12/12 kept in the Voice test tab.

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
- **No GPS on the board.** Location comes from an add-on module (below).

### Add-on: GPS module (planned, replaces the IP location)

**Decided (backlog, waiting on the module):** the IP-based location (ip2location.io, `server/src/location.ts`) is dropped. It gives the network's exit point, not where the learner is: Starlink at home shares addresses (CGNAT), and so do mobile carriers away, so the city can be far off. Location comes from the board's GPS instead.

The board has no GNSS receiver, so location comes from a small external module wired to the board's spare pads (Waveshare lists 1× UART, 1× I2C, 1× USB pad; the exact pins are only in the pinout image and schematic — check them before buying or soldering).

- **Module:** a small 3.3 V GNSS module with a built-in patch antenna, speaking NMEA over **UART** (e.g. a u-blox M10 or ATGM336H type). Multi-constellation (GPS + Galileo + BeiDou + QZSS) gets a fix faster in cities; QZSS helps in Japan.
- **Wiring:** module TX → board UART RX, module RX → board UART TX, 3.3 V, GND. Firmware parses NMEA (`$GxGGA` / `$GxRMC`) for latitude, longitude, fix quality and satellites.
- **Power:** GPS draws more than anything but the screen and audio. Power it from a switchable rail or an enable pin so firmware can turn it off at home (home Wi-Fi seen = no GPS needed) and between fixes. Expect a slow first fix (30 s+ from cold) and weak or no fix indoors.
- **Fallback:** when there is no fix (indoors, underground), the board sends nothing; the box keeps the last known location with its age.
- **Privacy:** location goes only to the box, over the tailnet. The box keeps the **latest fix in memory only** — no location history, and nothing written to the vault — unless that is decided later.
- **Uses:** weather for where you are (the Hermes `neko` profile), time zone when travelling, and place-aware practice later (ねこ notices you're at a station or a café and suggests phrases).

**How the code changes:**

- **Box first (works before the module arrives):** remove ip2location, `IP2LOCATION_KEY`, the connection-address logic and the `net {publicIp}` message. The board sends `location {lat, lon, accuracy_m, sats, at}`; the box keeps the latest fix in memory. **Home comes from Wi-Fi, not GPS** (GPS rarely works indoors): the board says it's on home Wi-Fi and the box uses a configured home location (`NEKO_HOME_LAT` / `NEKO_HOME_LON`). Trust order: a fresh fix, then home, then the last fix with its age, else unknown.
- **Place names** by reverse geocoding with **Nominatim** (OpenStreetMap, no key): only after ~200 m of movement (well under its 1 request/s limit), names in English and Japanese (`accept-language`, e.g. 渋谷区、東京都), identifying as the app (`neko-pet`); if it fails, coordinates only. The time zone stays offline (`@photostructure/tz-lookup`).
- **World tools** (`where_am_i`, `get_time`, `get_weather`) keep reading `GET /api/location`; they gain the fix's accuracy and age, and the weather uses exact coordinates.
- **Firmware:** `gps.c` reads NMEA (GGA, RMC) from the UART (ESP-IDF's nmea_parser example); GPS off on home Wi-Fi and in deep sleep, duty-cycled away (on until a fix, then a fix every few minutes); `location` sent on a new fix, at most every few minutes or after ~100 m; a GPS icon in the status row; GPS time can set the clock when there's no network.
- **Shopping:** 3.3 V supply and UART, built-in patch antenna, GPS + Galileo + BeiDou + QZSS (u-blox M10, e.g. Beitian BE-180/BE-220/BE-880 or SparkFun MAX-M10S; budget: ATGM336H mini), ideally a backup battery / V_BAT pin for fast re-fixes.

### Travelling: the time zone follows the learner (planned)

neko's own clock (the pet's bedtime, "today" for the streak, note times) now follows the board (step 2). Hermes's clock is still fixed to the box at home (KL): `timezone: Asia/Kuala_Lumpur` in each Hermes profile's `config.yaml` (under the multiplexed gateway Hermes ignores `HERMES_TIMEZONE` in `.env`), and Hermes puts that date and zone in ねこ's system prompt. The model trusted it, so ねこ's time and weather tools (`world/`) default to where the learner is instead of taking a zone.

The box keeps its own zone; the **learner's current zone** travels with the board:

1. **Board reports where you are.** From the GPS add-on, or, for the zone alone, something coarser: Wi-Fi positioning or the phone hotspot's IP location (the right country or region is enough). The browser app can also send its own zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`).
2. **The box works out the zone.** *(Done for the IP route: `server/src/location.ts` locates the board's public IP with ip2location.io and names the zone from its coordinates offline with `@photostructure/tz-lookup`, e.g. `Asia/Tokyo`, cached 6 h per address in memory. The board's zone wins over a browser's; before anything is located, the box's own zone. `NEKO_TZ` is gone: the pet's bedtime, "today" for the streak and note times all use it.)*
3. **ねこ's tools know it.** *(Done, differently from first planned: nothing goes into the prompt.)* `get_time()` and `get_weather()` in `world/` default to the learner's location from `GET /api/location`, so the model never needs a zone. Hermes's own `timezone` stays KL, for cron and the box.
4. **ねこ follows it too:** bedtime (23:00–07:00) and greetings use the learner's current zone.

**Open decision — the streak while travelling.** Changing zones can repeat or skip a calendar day. Proposed rule: count days in the learner's current zone, but a zone change never breaks the streak (a day lost to a jump counts as kept; a repeated day counts once).

### Board ↔ box protocol (one WebSocket)

- **Binary frames:** audio, 16 kHz 16-bit mono PCM both directions (~32 KB/s). Opus later if bandwidth matters.
- **Text frames:** JSON events.

```
board → box: hello{deviceId, fw, token}  listen_start  listen_end  touch{x,y,gesture}  imu{event}
             location{lat, lon, accuracy_m, sats, at}   (GPS add-on: on a new fix, at most every few minutes)
box → board: state{mood, anim, hunger, streak}  say{text, furigana}
             audio_start{rate}  audio_end  correction{original, fixed, notes}
```

The board renders the pet from sprite frames in flash, driven by `state.anim`. No video is streamed.

## Using the board away from home: Tailscale

The board joins the tailnet itself and reaches the box at its tailnet address (`ws://<box tailnet IP>:8081/ws`), at home and away alike. Nothing on the box is exposed to the internet, so the WebSocket needs no login of its own: being on the tailnet is the login. (A Cloudflare Tunnel with a per-device token was the earlier plan; Tailscale needs no public endpoint.)

- **On the board:** [microlink](https://github.com/Csontikka/microlink) (Csontikka's fork, the one under `esphome-tailscale`), vendored in `firmware/components/`. It gives lwIP a WireGuard interface, so the ordinary WebSocket client reaches 100.x addresses. Two local changes, listed in `components/microlink/UPSTREAM`: four of its task stacks live in PSRAM (with them in internal RAM, ねこ's voice arriving over WireGuard used up the internal RAM and the screen task hung), and the relay netcheck is skipped (it blocked every join for 25 s). The home relay is fixed (Singapore); it's only used when a direct path can't be made. Joining takes ~7.5 s after Wi-Fi.
- **Location:** over Tailscale the box sees the board's 100.x address, so the board reports the public IP its STUN probe saw (`net` message) and the box locates it by that; the box's own public IP means home.
- **Wi-Fi away:** the board's second network is the phone's hotspot (home first, see `firmware/README.md`).
- **To check:** waking from deep sleep and switching between home and the hotspot (the tailnet has to follow), and latency over mobile data (audio may want Opus instead of raw PCM).

## Build order (riskiest first)

1. **Speech loop in the browser** — mic → STT bake-off → correction → VOICEVOX → playback. Measure latency and memory.
2. **Pet engine + PixiJS pet + WebSocket protocol**, browser as the first client. *(Done: protocol in `shared/protocol.ts`; pet drawn from pixel-art GIFs (`web/public/pet/<anim>.gif`, anchored at the feet automatically; drowsy hour around bedtime with yawns, sick when starving, grumpy if petted awake at night); stats in SQLite — practising feeds the pet, petting cheers it up, it sleeps 23:00–07:00 in the learner's time zone.)*
3. **Vault learning records + Hermes grammar Q&A.** *(Built, being checked on the box: every turn, translation, listening miss, question and review attempt is appended to `~/vault/Japanese/Daily/<date>.md`; listening misses = repeat / slow / opened the English; questions only through the Hermes API server (Hermes reads the notes itself): grammar to the `pro` profile, casual to `default`, no fallback; Review panel and Notes page; weekly review by Hermes cron. Protocol: `ask_grammar` / `ask_casual` → `answer`, `reveal`.)*
4. **ESP32-S3 firmware** — WebSocket client, audio via ES8311/ES7210, sprite rendering, touch and IMU. *(In progress, `firmware/`: ESP-IDF 5.5 + Waveshare BSP + LVGL 9; the web app's GIFs embedded and played at 3x anchored at the feet; Japanese through TinyTTF + DotGothic16; voice buffered in PSRAM and played at 16 kHz with lip-sync; push-to-talk by holding the screen, the transcript confirmed straight away; correction shown as a card. Not yet: IMU, battery, Wi-Fi provisioning.)*
5. **Away-from-home access** — Tailscale on the board (above). *(Working at home over the tailnet; being tested on the hotspot.)*
6. **GPS add-on** — replaces the IP location (see the add-on section): first the box (drop ip2location, home by Wi-Fi, `location` message, Nominatim names), then pick the module and confirm the UART pads from the schematic, wire it, parse NMEA in firmware, send `location`. *(Backlog: waiting on the module.)*
7. **Time zone follows the learner** — coordinates → zone on the box, the learner's zone in every Hermes request, ねこ's bedtime and greetings in that zone, and the streak rule above. Works with GPS or a coarser location source; the browser can send its zone before the board exists.

## Constraints

- Box: Ryzen 9 8945HS, Radeon 780M iGPU, 26 GB shared RAM. Qwen3.6 uses ~20 GB, leaving ~8 GB for STT, TTS, neko and Hermes.
- llama.cpp has 4 parallel slots shared by neko and Hermes.
