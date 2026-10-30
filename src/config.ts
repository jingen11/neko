import path from "node:path";

export const config = {
  host: process.env.NEKO_HOST ?? "127.0.0.1",
  port: Number(process.env.NEKO_PORT ?? 8081),
  upstream: (process.env.LLAMA_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, ""),
  vaultPath: path.resolve(process.env.NEKO_VAULT ?? "./vault"),
  vaultFolder: process.env.NEKO_VAULT_FOLDER ?? "neko",
};
