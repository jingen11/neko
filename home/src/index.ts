import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { device, place, snapshot, start, subscribe, zigbeeRequest } from "./broker.ts";
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
 * Change a device: any of
 *   name     rename it in Zigbee2MQTT (Zigbee devices only); its readings and place follow it to the new name
 *   label    what the dashboard calls it
 *   room     a room id from /api/areas, or null to take it out (clears opening)
 *   opening  a door or window id from /api/areas, or null (clears room)
 * e.g. PATCH /api/devices/0xa4c138117ddcffff {"name":"lobby_plug","label":"Lobby plug","room":"lobby"}
 * Saved to layout.json; the page updates straight away.
 */
app.patch<{ Params: { id: string }; Body: { name?: string; label?: string; room?: string | null; opening?: string | null } }>(
  "/api/devices/:id",
  {
    schema: {
      body: {
        type: "object",
        minProperties: 1,
        additionalProperties: false,
        properties: {
          // Zigbee2MQTT friendly names become MQTT topics: no "/", "#", "+" or surrounding spaces
          name: { type: "string", pattern: "^[A-Za-z0-9_-][A-Za-z0-9 _.-]{0,62}[A-Za-z0-9_.-]$|^[A-Za-z0-9_-]$" },
          label: { type: "string", minLength: 1, maxLength: 60 },
          room: { type: ["string", "null"] },
          opening: { type: ["string", "null"] },
        },
      },
    },
  },
  async (req, reply) => {
    let id = req.params.id;
    const b = req.body;
    const d = device(id);
    if (!d) return reply.code(404).send({ error: `no device "${id}" (see GET /api/devices)` });
    if (b.room && b.opening) return reply.code(400).send({ error: "a device goes in a room or on an opening, not both" });
    if (b.room && !isRoom(b.room)) return reply.code(400).send({ error: `unknown room "${b.room}" (see GET /api/areas)` });
    if (b.opening && !isOpening(b.opening)) return reply.code(400).send({ error: `unknown opening "${b.opening}" (see GET /api/areas)` });

    if (b.name !== undefined && b.name !== id) {
      if (!d.zigbee) return reply.code(400).send({ error: `"${id}" is not a Zigbee2MQTT device: rename ESPHome boards in their YAML` });
      if (device(b.name) || layout.devices[b.name]) return reply.code(409).send({ error: `"${b.name}" is already taken` });
      let r;
      try {
        r = await zigbeeRequest("device/rename", { from: id, to: b.name, homeassistant_rename: true });
      } catch (err) {
        return reply.code(504).send({ error: (err as Error).message });
      }
      if (r.status !== "ok") return reply.code(502).send({ error: `Zigbee2MQTT: ${String(r.error ?? "rename failed")}` });
      // the place belongs to the physical device: carry it over to the new name
      if (layout.devices[id]) {
        layout.devices[b.name] = layout.devices[id];
        delete layout.devices[id];
      }
      req.log.info(`renamed ${id} -> ${b.name} in Zigbee2MQTT`);
      id = b.name;
    }

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
    // after a rename Zigbee2MQTT's new discovery may not have arrived yet: the device is placed when it does
    return device(id) ?? { id, ...p };
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
