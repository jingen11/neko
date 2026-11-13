import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { device, place, snapshot, start, subscribe } from "./broker.ts";
import { isOpening, isRoom, openings, rooms } from "./areas.ts";
import { addAway, alarms, alarmsSince, aways, clearOverride, events, isDate, isTime, onAlarm, periods, removeAway, sessions, setArmed, setPeriods, status } from "./alarm.ts";
import { config, layout, saveLayout } from "./config.ts";

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

/** Where a device can go: room ids for presence boards and plugs, opening ids (doors, window panes) for contact/vibration sensors. */
app.get("/api/areas", async () => ({ rooms, openings }));

/** Every device found through discovery, with its label and place. */
app.get("/api/devices", async () => snapshot().devices);

/**
 * Change where a device is shown: any of
 *   label    what the dashboard calls it
 *   room     a room id from /api/areas, or null to take it out (clears opening)
 *   opening  a door or window id from /api/areas, or null (clears room)
 * e.g. PATCH /api/devices/lobby_plug {"label":"Lobby plug","room":"lobby"}
 * Saved to layout.json; the page updates straight away. The device's name (its id) belongs to Zigbee2MQTT or ESPHome:
 * rename it there; a Zigbee2MQTT rename carries its readings and its place in layout.json over to the new name.
 */
app.patch<{ Params: { id: string }; Body: { label?: string; room?: string | null; opening?: string | null } }>(
  "/api/devices/:id",
  {
    schema: {
      body: {
        type: "object",
        minProperties: 1,
        additionalProperties: false,
        properties: {
          label: { type: "string", minLength: 1, maxLength: 60 },
          room: { type: ["string", "null"] },
          opening: { type: ["string", "null"] },
        },
      },
    },
  },
  async (req, reply) => {
    const id = req.params.id;
    const b = req.body;
    const d = device(id);
    if (!d) return reply.code(404).send({ error: `no device "${id}" (see GET /api/devices)` });
    // unknown fields (e.g. "name": renames happen in Zigbee2MQTT) are stripped by validation, which can leave nothing
    if (b.label === undefined && b.room === undefined && b.opening === undefined)
      return reply.code(400).send({ error: "nothing to change: send label, room or opening (rename the device in Zigbee2MQTT)" });
    if (b.room && b.opening) return reply.code(400).send({ error: "a device goes in a room or on an opening, not both" });
    if (b.room && !isRoom(b.room)) return reply.code(400).send({ error: `unknown room "${b.room}" (see GET /api/areas)` });
    if (b.opening && !isOpening(b.opening)) return reply.code(400).send({ error: `unknown opening "${b.opening}" (see GET /api/areas)` });

    const p = { ...(layout.devices[id] ?? { label: device(id)?.label ?? id }) };
    if (b.label !== undefined) p.label = b.label;
    if (b.room !== undefined) {
      if (b.room) p.room = b.room;
      else delete p.room;
      if (b.room) delete p.opening;
    }
    if (b.opening !== undefined) {
      if (b.opening) p.opening = b.opening;
      else delete p.opening;
      if (b.opening) delete p.room;
    }
    layout.devices[id] = p;
    saveLayout();
    place(id);
    return device(id);
  },
);

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
