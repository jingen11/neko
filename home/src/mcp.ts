import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { rooms } from "./areas.ts";
import { command, setSpeed, snapshot } from "./broker.ts";
import { LOAD_KINDS } from "./config.ts";

/**
 * MCP server (Streamable HTTP, at /mcp) for ねこ, so the pet can work the lights and fans by voice through
 * the Hermes `neko` profile. It is part of neko-home because neko-home holds the live MQTT connection and
 * knows what each switch drives (layout.json `loads`).
 *
 *   list_appliances  every light and fan: name, kind, room, on or off, online or not
 *   set_appliance    turn lights or fans on or off, or set a fan's speed, picked by id, or by room, kind and name
 *
 * Only switches given an appliance on the Devices tab are here; a plug with nothing assigned isn't.
 * No key: the dashboard, and so /mcp, is only reachable on the tailnet.
 */

interface Appliance {
  id: string; // the switch entity id, e.g. 0x54ef44100196dcde/switch_center
  name: string;
  kind: (typeof LOAD_KINDS)[number];
  room: string | null; // room id
  roomName: string | null;
  floor: string | null;
  on: boolean | null; // null until the switch has reported
  online: boolean;
  /** a fan with speeds (an ESPHome fan entity): its speed and how many it has; null otherwise */
  speed: number | null;
  speeds: number | null;
}

const ROOM = new Map(rooms.map((r) => [r.id, r]));
const FLOOR: Record<string, string> = { g: "ground floor", u: "upper floor", out: "outside" };
const KIND_NAME = { light: "Light", fan: "Fan" } as const;

/** Every switch with an appliance, with the appliance's own room when it has one (a lobby light on the living room's switch). */
function appliances(): Appliance[] {
  const { connected, devices, entities } = snapshot();
  const byId = new Map(devices.map((d) => [d.id, d]));
  return entities
    .filter((e) => e.command)
    .flatMap((e) => {
      const d = byId.get(e.device);
      const load = d?.loads[e.id.split("/").at(-1)!];
      if (!d || !load) return [];
      const room = ROOM.get(load.room ?? d.room ?? "") ?? null;
      return [{
        id: e.id,
        name: load.label ?? KIND_NAME[load.kind],
        kind: load.kind,
        room: room?.id ?? null,
        roomName: room?.name ?? null,
        floor: room ? FLOOR[room.floor] : null,
        on: typeof e.value === "boolean" ? e.value : null,
        online: connected && d.available !== false,
        speed: e.speed,
        speeds: e.speeds,
      }];
    })
    .sort((a, b) => (a.roomName ?? "").localeCompare(b.roomName ?? "") || a.name.localeCompare(b.name));
}

const where = (a: Appliance) => (a.roomName ? `${a.roomName}, ${a.floor}` : "no room");
const speedOf = (a: Appliance) => (a.speeds ? `, speed ${a.speed ?? "?"} of ${a.speeds}` : "");
const line = (a: Appliance) =>
  `- ${a.name} (${a.kind}) in ${where(a)}: ${!a.online ? "offline" : a.on === null ? "state unknown" : a.on ? `on${speedOf(a)}` : "off"}` +
  `${a.speeds ? ` (speeds 1-${a.speeds})` : ""} [id ${a.id}]`;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ ...text(t), isError: true });

const roomIds = rooms.map((r) => r.id) as [string, ...string[]];
const roomList = rooms.map((r) => `${r.id} = ${r.name} (${FLOOR[r.floor]})`).join("; ");

function build() {
  const server = new McpServer({ name: "neko-home", version: "0.1.0" });

  server.registerTool("list_appliances", {
    description:
      "The lights and fans in the house that can be switched, each with its room, whether it is on or off (and a fan's " +
      "speed, when it has speeds), and whether its switch is online. Use it to answer 'is the light on?' or to find " +
      "the right one before switching. A fan's on/off and speed are what was last sent or heard from its remote.",
    annotations: { readOnlyHint: true },
  }, async () => {
    const list = appliances();
    return text(list.length ? list.map(line).join("\n") : "No lights or fans have been set up yet.");
  });

  server.registerTool("set_appliance", {
    description:
      "Turn lights or fans on or off, or set a fan's speed (which also turns it on). Pick them by `id` (from " +
      "list_appliances), or by `room`, `kind` and/or `name`: " +
      "every appliance that matches all the ones given is switched, so room 'living' with kind 'light' switches every " +
      "light in the living area. Give at least one. Says what was switched and what couldn't be (an offline switch). " +
      `Rooms: ${roomList}.`,
    inputSchema: {
      on: z.boolean().optional().describe("true to turn on, false to turn off; can be left out when giving a speed"),
      speed: z.number().int().min(1).optional().describe("A fan's speed, 1 (slowest) up to its number of speeds; turns it on"),
      id: z.string().optional().describe("One appliance's id from list_appliances"),
      room: z.enum(roomIds).optional().describe("A room id"),
      kind: z.enum(LOAD_KINDS).optional().describe("light or fan"),
      name: z.string().optional().describe("Part of the appliance's name, e.g. 'lobby'"),
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  }, async ({ on, speed, id, room, kind, name }) => {
    if (!id && !room && !kind && !name) return fail("Say which: give an id, a room, a kind or a name.");
    if (on === undefined && speed === undefined) return fail("Say what to do: give on (true or false) or a speed.");
    // a speed turns the fan on, so "off at speed 3" is just off
    const bySpeed = speed !== undefined && on !== false;
    const all = appliances();
    const q = name?.trim().toLowerCase();
    const picked = all.filter((a) =>
      (!id || a.id === id) && (!room || a.room === room) && (!kind || a.kind === kind) && (!q || a.name.toLowerCase().includes(q)) &&
      // a speed only goes to fans with speeds: "the living room to 3" mustn't also switch its light
      (!bySpeed || !!a.speeds),
    );
    if (!picked.length)
      return fail(`Nothing matches. The lights and fans are:\n${all.map(line).join("\n") || "(none set up)"}`);
    const done: string[] = [];
    const failed: string[] = [];
    for (const a of picked) {
      const r = await (bySpeed ? setSpeed(a.id, speed!) : command(a.id, on!)).catch(() => "offline" as const);
      if (r === "ok") done.push(`${a.name} in ${where(a)}`);
      else
        failed.push(`${a.name} in ${where(a)} (${r === "offline" ? "its switch is offline" : r === "range" ? `its speeds are 1 to ${a.speeds}` : "not found"})`);
    }
    const out = [
      done.length ? (bySpeed ? `Set to speed ${speed}: ${done.join("; ")}.` : `Turned ${on ? "on" : "off"}: ${done.join("; ")}.`) : "",
      failed.length ? `Could not switch: ${failed.join("; ")}.` : "",
    ].filter(Boolean).join("\n");
    return done.length ? text(out) : fail(out);
  });

  return server;
}

/** Stateless: a fresh server and transport per request, so a Hermes restart or a dropped connection leaves nothing behind. */
export function registerMcp(app: FastifyInstance) {
  app.post("/mcp", async (req, reply) => {
    const server = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  // no server-sent stream or sessions in stateless mode
  const notAllowed = { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null };
  app.get("/mcp", async (_req, reply) => reply.code(405).header("allow", "POST").send(notAllowed));
  app.delete("/mcp", async (_req, reply) => reply.code(405).header("allow", "POST").send(notAllowed));
}
