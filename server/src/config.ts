const trim = (s: string) => s.replace(/\/+$/, "");

export const config = {
  host: process.env.NEKO_HOST ?? "127.0.0.1",
  port: Number(process.env.NEKO_PORT ?? 8081),
  llamaUrl: trim(process.env.LLAMA_URL ?? "http://127.0.0.1:8080"),
  sttUrl: process.env.STT_URL ?? "ws://127.0.0.1:6006",
  voicevoxUrl: trim(process.env.VOICEVOX_URL ?? "http://127.0.0.1:50021"),
  voicevoxSpeaker: Number(process.env.VOICEVOX_SPEAKER ?? 3),
  level: (process.env.NEKO_LEVEL ?? "N4").toUpperCase(),
};
