import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { command, device, entity, place, setSpeed, snapshot, start, subscribe } from "./broker.ts";
import { isOpening, isRoom, openings, rooms } from "./areas.ts";
import { addAway, alarms, alarmsSince, aways, clearOverride, DAYS, type Day, events, isDate, isTime, onAlarm, periods, removeAway, sessions, setArmed, setPeriods, status } from "./alarm.ts";
import { config, layout, LOAD_KINDS, saveLayout, type Load } from "./config.ts";
import { registerMcp } from "./mcp.ts";

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
 *   loads    what its switches drive, by the switch's object id: {"switch_top": {"kind":"light","label":"Ceiling light"}, "switch_center": null};
 *            each may name its own "room" when it isn't in the switch's
 *            (null forgets one; switches left out keep theirs)
 * e.g. PATCH /api/devices/lobby_plug {"label":"Lobby plug","room":"lobby"}
 * Saved to layout.json; the page updates straight away. The device's name (its id) belongs to Zigbee2MQTT or ESPHome:
 * rename it there; a Zigbee2MQTT rename carries its readings and its place in layout.json over to the new name.
 */
app.patch<{ Params: { id: string }; Body: { label?: string; room?: string | null; opening?: string | null; loads?: Record<string, Load | null> } }>(
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
          loads: {
            type: "object",
            additionalProperties: {
              type: ["object", "null"],
              required: ["kind"],
              additionalProperties: false,
              properties: {
                kind: { type: "string", enum: [...LOAD_KINDS] },
                label: { type: "string", minLength: 1, maxLength: 60 },
                room: { type: "string" },
              },
            },
          },
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
    if (b.label === undefined && b.room === undefined && b.opening === undefined && b.loads === undefined)
      return reply.code(400).send({ error: "nothing to change: send label, room, opening or loads (rename the device in Zigbee2MQTT)" });
    if (b.room && b.opening) return reply.code(400).send({ error: "a device goes in a room or on an opening, not both" });
    if (b.room && !isRoom(b.room)) return reply.code(400).send({ error: `unknown room "${b.room}" (see GET /api/areas)` });
    if (b.opening && !isOpening(b.opening)) return reply.code(400).send({ error: `unknown opening "${b.opening}" (see GET /api/areas)` });
    const switches = new Set(snapshot().entities.filter((e) => e.device === id && e.command).map((e) => e.id.split("/").at(-1)));
    const badLoad = Object.keys(b.loads ?? {}).find((k) => !switches.has(k));
    if (badLoad !== undefined)
      return reply.code(400).send({ error: `"${id}" has no switch "${badLoad}"${switches.size ? ` (it has ${[...switches].join(", ")})` : ""}` });
    const badRoom = Object.values(b.loads ?? {}).find((l) => l?.room && !isRoom(l.room))?.room;
    if (badRoom) return reply.code(400).send({ error: `unknown room "${badRoom}" (see GET /api/areas)` });

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
    if (b.loads) {
      const loads = { ...p.loads };
      for (const [k, v] of Object.entries(b.loads)) {
        if (v) loads[k] = { kind: v.kind, ...(v.label?.trim() ? { label: v.label.trim() } : {}), ...(v.room ? { room: v.room } : {}) };
        else delete loads[k];
      }
      if (Object.keys(loads).length) p.loads = loads;
      else delete p.loads;
    }
    layout.devices[id] = p;
    saveLayout();
    place(id);
    return device(id);
  },
);

/**
 * Turn a switch (a wall switch rocker, a plug) or a fan on or off: POST /api/switches/0x54ef44100196dcde/switch_top {"on": true}.
 * A fan with speeds also takes {"speed": 3} (1..its `speeds`), which turns it on at that speed.
 * The id is an entity id from /api/state with `command: true`. Answers once the command is sent; the new state
 * arrives on /api/events when the device reports it.
 */
app.post<{ Params: { node: string; object: string }; Body: { on?: boolean; speed?: number } }>(
  "/api/switches/:node/:object",
  {
    schema: {
      body: {
        type: "object",
        minProperties: 1,
        additionalProperties: false,
        properties: { on: { type: "boolean" }, speed: { type: "integer", minimum: 1 } },
      },
    },
  },
  async (req, reply) => {
    const id = `${req.params.node}/${req.params.object}`;
    const { on, speed } = req.body;
    // a speed turns the fan on, so "off at speed 3" is just off
    const r = speed !== undefined && on !== false ? await setSpeed(id, speed) : await command(id, on ?? true);
    if (r === "unknown")
      return reply.code(404).send({
        error: speed !== undefined ? `no fan with speeds "${id}" (see GET /api/state, entities with speeds)` : `no switch "${id}" (see GET /api/state, entities with command: true)`,
      });
    if (r === "range") return reply.code(400).send({ error: `"${id}" has speeds 1 to ${entity(id)?.speeds}` });
    if (r === "offline") return reply.code(409).send({ error: "the switch or the MQTT broker is offline" });
    return reply.code(202).send(entity(id));
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

/**
 * Armed periods, replaced as a whole: [{"start":"23:00","end":"07:00","days":["mon","tue","wed","thu","fri"]}, ...].
 * An end before the start runs past midnight, and belongs to the day it starts on. Without days it runs every day.
 */
app.get("/api/alarm/periods", async () => periods());
app.put<{ Body: { start: string; end: string; days?: Day[] }[] }>(
  "/api/alarm/periods",
  {
    schema: {
      body: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          required: ["start", "end"],
          properties: {
            start: { type: "string" },
            end: { type: "string" },
            days: { type: "array", minItems: 1, maxItems: 7, uniqueItems: true, items: { type: "string", enum: [...DAYS] } },
          },
          additionalProperties: false,
        },
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

/** ねこ's tools for the lights and fans, for the Hermes neko profile (see mcp.ts). */
registerMcp(app);

start(app.log);

await app.listen({ host: config.host, port: config.port });
