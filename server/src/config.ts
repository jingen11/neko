import os from "node:os";
import path from "node:path";

const trim = (s: string) => s.replace(/\/+$/, "");

/** NEKO_TZ must be an IANA name like "Asia/Kuala_Lumpur"; an invalid one falls back to the box's zone instead of crashing. */
function timeZone(): string {
  const system = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const wanted = process.env.NEKO_TZ?.trim();
  if (!wanted) return system;
  try {
    new Intl.DateTimeFormat("en", { timeZone: wanted });
    return wanted;
  } catch {
    console.warn(`NEKO_TZ="${wanted}" is not a valid time zone (expected an IANA name like "Asia/Kuala_Lumpur"); using ${system}`);
    return system;
  }
}

export const config = {
  host: process.env.NEKO_HOST ?? "127.0.0.1",
  port: Number(process.env.NEKO_PORT ?? 8081),
  llamaUrl: trim(process.env.LLAMA_URL ?? "http://127.0.0.1:8080"),
  sttUrl: process.env.STT_URL ?? "ws://127.0.0.1:6006",
  voicevoxUrl: trim(process.env.VOICEVOX_URL ?? "http://127.0.0.1:50021"),
  voicevoxSpeaker: Number(process.env.VOICEVOX_SPEAKER ?? 3),
  level: (process.env.NEKO_LEVEL ?? "N4").toUpperCase(),
  petName: process.env.NEKO_PET_NAME ?? "ねこ",
  /** Your time zone: decides the pet's bedtime and what counts as "today" for the streak. */
  tz: timeZone(),
  dataDir: process.env.NEKO_DATA_DIR ?? path.resolve(import.meta.dirname, "../data"),
  /** Where neko writes learning records for you and Hermes (Obsidian vault folder). Empty string turns it off. */
  vaultDir: process.env.NEKO_VAULT_DIR ?? path.join(os.homedir(), "vault", "Japanese"),
  /** Hermes Agent API server, which answers grammar questions using the vault. */
  hermesUrl: trim(process.env.HERMES_URL ?? "http://127.0.0.1:8642"),
  hermesKey: process.env.HERMES_KEY ?? "",
  /** Model Hermes uses for grammar questions; both empty = Hermes's own default model. */
  hermesModel: process.env.HERMES_MODEL ?? "claude-opus-5-5",
  hermesProvider: process.env.HERMES_PROVIDER ?? "anthropic",
};
