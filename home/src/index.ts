import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { snapshot, start, subscribe } from "./broker.ts";
import { config } from "./config.ts";

const app = Fastify({ logger: { level: "info" } });

await app.register(fastifyStatic, { root: config.publicDir });

app.get("/health", async () => ({ status: "ok", mqtt: snapshot().connected }));

/** Everything the page needs to draw itself. */
app.get("/api/state", async () => snapshot());

/** Live updates as server-sent events: one JSON `Update` per message. */
app.get("/api/events", (req, reply) => {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (data: unknown) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  send({ type: "snapshot", ...snapshot() });
  const off = subscribe(send);
  const ping = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);
  req.raw.on("close", () => {
    off();
    clearInterval(ping);
  });
});

start(app.log);

await app.listen({ host: config.host, port: config.port });
