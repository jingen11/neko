import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { snapshot, start, subscribe } from "./broker.ts";
import { addAway, alarms, alarmsSince, aways, clearOverride, events, isDate, isTime, onAlarm, periods, removeAway, sessions, setArmed, setPeriods, status } from "./alarm.ts";
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
  send({ type: "snapshot", ...snapshot(), alarm: status() });
  const off = subscribe(send);
  const offAlarm = onAlarm((alarm) => send({ type: "alarm", alarm }));
  const ping = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);
  req.raw.on("close", () => {
    off();
    offAlarm();
    clearInterval(ping);
  });
});

/** The alarm now, plus its schedule. */
app.get("/api/alarm", async () => ({ ...status(), periods: periods(), away: aways() }));

/** Arm or disarm by hand: {"armed": true|false}. Holds until the schedule next changes. */
app.post<{ Body: { armed: boolean } }>(
  "/api/alarm",
  { schema: { body: { type: "object", required: ["armed"], properties: { armed: { type: "boolean" } } } } },
  async (req) => setArmed(req.body.armed),
);

/** Drop a manual arm/disarm and follow the schedule again. */
app.delete("/api/alarm/override", async () => clearOverride());

/** Daily armed periods, replaced as a whole: [{"start":"23:00","end":"07:00"}, ...]. An end before the start runs past midnight. */
app.get("/api/alarm/periods", async () => periods());
app.put<{ Body: { start: string; end: string }[] }>(
  "/api/alarm/periods",
  {
    schema: {
      body: {
        type: "array",
        maxItems: 20,
        items: { type: "object", required: ["start", "end"], properties: { start: { type: "string" }, end: { type: "string" } }, additionalProperties: false },
      },
    },
  },
  async (req, reply) => {
    const bad = req.body.find((p) => !isTime(p.start) || !isTime(p.end) || p.start === p.end);
    if (bad) return reply.code(400).send({ error: `bad period ${bad.start}-${bad.end}: times are HH:MM and start differs from end` });
    return setPeriods(req.body);
  },
);

/** Days away from home, armed all day: {"from":"2026-12-20","to":"2026-12-27","note":"KL trip"} (dates inclusive). */
app.get("/api/alarm/away", async () => aways());
app.post<{ Body: { from: string; to: string; note?: string } }>(
  "/api/alarm/away",
  {
    schema: {
      body: {
        type: "object",
        required: ["from", "to"],
        properties: { from: { type: "string" }, to: { type: "string" }, note: { type: "string", maxLength: 200 } },
        additionalProperties: false,
      },
    },
  },
  async (req, reply) => {
    const { from, to, note } = req.body;
    if (!isDate(from) || !isDate(to) || from > to) return reply.code(400).send({ error: "from and to are YYYY-MM-DD, from on or before to" });
    return reply.code(201).send(addAway(from, to, note ?? null));
  },
);
app.delete<{ Params: { id: number } }>(
  "/api/alarm/away/:id",
  { schema: { params: { type: "object", properties: { id: { type: "integer" } } } } },
  async (req, reply) => (removeAway(req.params.id) ? reply.code(204).send() : reply.code(404).send({ error: "no such away entry" })),
);

/** Alarms (something turned on, or a board went offline, while armed), newest first. Next page: ?beforeAt=&beforeId= of the last one. */
app.get<{ Querystring: { limit?: number; beforeAt?: number; beforeId?: number; since?: number } }>(
  "/api/alarm/alarms",
  {
    schema: {
      querystring: {
        type: "object",
        properties: { limit: { type: "integer", minimum: 1, maximum: 200 }, beforeAt: { type: "integer" }, beforeId: { type: "integer" }, since: { type: "integer" } },
      },
    },
  },
  async (req) => {
    const { limit, beforeAt, beforeId, since } = req.query;
    const items = alarms(limit ?? 50, beforeAt !== undefined ? { at: beforeAt, id: beforeId ?? Number.MAX_SAFE_INTEGER } : undefined);
    return { items, since: since !== undefined ? alarmsSince(since) : null };
  },
);

/** Past arming sessions, newest first. */
app.get<{ Querystring: { limit?: number } }>(
  "/api/alarm/sessions",
  { schema: { querystring: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 500 } } } } },
  async (req) => sessions(req.query.limit),
);

/** What the sensors did during one session. */
app.get<{ Params: { id: number } }>(
  "/api/alarm/sessions/:id/events",
  { schema: { params: { type: "object", properties: { id: { type: "integer" } } } } },
  async (req) => events(req.params.id),
);

start(app.log);

await app.listen({ host: config.host, port: config.port });
