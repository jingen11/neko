import os from "node:os";
import path from "node:path";

const trim = (s: string) => s.replace(/\/+$/, "");

export const config = {
  host: process.env.NEKO_HOST ?? "127.0.0.1",
  port: Number(process.env.NEKO_PORT ?? 8081),
  llamaUrl: trim(process.env.LLAMA_URL ?? "http://127.0.0.1:8080"),
  sttUrl: process.env.STT_URL ?? "ws://127.0.0.1:6006",
  voicevoxUrl: trim(process.env.VOICEVOX_URL ?? "http://127.0.0.1:50021"),
  voicevoxSpeaker: Number(process.env.VOICEVOX_SPEAKER ?? 3),
  level: (process.env.NEKO_LEVEL ?? "N4").toUpperCase(),
  petName: process.env.NEKO_PET_NAME ?? "ねこ",
  dataDir: process.env.NEKO_DATA_DIR ?? path.resolve(import.meta.dirname, "../data"),
  /** Where neko writes learning records for you and Hermes (Obsidian vault folder). Empty string turns it off. */
  vaultDir: process.env.NEKO_VAULT_DIR ?? path.join(os.homedir(), "vault", "Japanese"),
  /** Hermes Agent API server. Every Ask box question goes through it; it reads the vault. */
  hermesUrl: trim(process.env.HERMES_URL ?? "http://127.0.0.1:8642"),
  /** Hermes's default profile (local model): casual questions. Key = API_SERVER_KEY in ~/.hermes/.env. */
  hermesKey: process.env.HERMES_KEY ?? "",
  /** Hermes profile on a frontier model, served at /p/<profile>/: grammar questions. */
  hermesProProfile: process.env.HERMES_PRO_PROFILE ?? "pro",
  /** Key = API_SERVER_KEY in ~/.hermes/profiles/<profile>/.env. */
  hermesProKey: process.env.HERMES_PRO_KEY ?? "",
  /** Hermes profile that writes ねこ's spoken replies, with tools for the world right now (time, weather). */
  hermesNekoProfile: process.env.HERMES_NEKO_PROFILE ?? "neko",
  /** Key = API_SERVER_KEY in ~/.hermes/profiles/<profile>/.env. */
  hermesNekoKey: process.env.HERMES_NEKO_KEY ?? "",
  /** Shown on answer cards only. Hermes doesn't report its model, so keep these in line with each profile's config. */
  hermesModelLabel: process.env.HERMES_MODEL_LABEL ?? "Qwen3.6",
  hermesProModelLabel: process.env.HERMES_PRO_MODEL_LABEL ?? "Claude Opus 5.5",
  /** MQTT broker that Zigbee2MQTT publishes to. Empty = MQTT off. */
  mqttUrl: process.env.MQTT_URL ?? "",
  mqttUsername: process.env.MQTT_USERNAME ?? "",
  mqttPassword: process.env.MQTT_PASSWORD ?? "",
  mqttBaseTopic: trim(process.env.MQTT_BASE_TOPIC ?? "zigbee2mqtt"),
  /** Zigbee2MQTT friendly names of the home sensors (sensors.ts). */
  doorSensor: process.env.NEKO_DOOR_SENSOR || "front_door",
  windowSensor: process.env.NEKO_WINDOW_SENSOR || "front_window_1",
  /** ip2location.io API key: where each client is, from its public IP (location.ts). Empty = off. */
  ip2locationKey: process.env.IP2LOCATION_KEY ?? "",
};
