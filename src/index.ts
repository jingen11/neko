import Fastify from "fastify";
import { config } from "./config.ts";
import { chatCompletions, passthrough } from "./proxy.ts";
import { computeStats } from "./stats.ts";
import { getSummaries, initVault } from "./vault.ts";

const app = Fastify({
  logger: { level: process.env.NEKO_LOG_LEVEL ?? "info" },
  disableRequestLogging: true, // proxy.ts logs one line per LLM call instead
  bodyLimit: 64 * 1024 * 1024, // room for long contexts / base64 images
});

// Keep every body as a raw Buffer so passthrough forwards exactly what the client sent.
app.removeAllContentTypeParsers();
app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

// neko's own endpoints
app.get("/neko/health", async () => {
  let upstream: unknown;
  try {
    const res = await fetch(`${config.upstream}/health`, { signal: AbortSignal.timeout(3000) });
    upstream = await res.json();
  } catch (err) {
    upstream = { status: "unreachable", error: (err as Error).message };
  }
  return { status: "ok", upstream: config.upstream, llama: upstream, vault: config.vaultPath };
});

app.get<{ Querystring: { since?: string } }>("/neko/stats", async (req) => computeStats(getSummaries(), req.query.since));

// LLM traffic
app.post("/v1/chat/completions", chatCompletions);
app.all("/*", passthrough);

await initVault();
await app.listen({ host: config.host, port: config.port });
app.log.info(`neko → ${config.upstream} | vault: ${config.vaultPath}`);
