import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { findPlace, weatherReport, type Place } from "./weather.ts";

/**
 * MCP server (stdio) with ねこ's tools for the world right now, for the Hermes neko profile.
 * Read-only.
 *
 *   where_am_i   where the learner is, from the neko server (the board's public IP, ip2location.io)
 *   get_weather  weather anywhere, by place name or coordinates (Open-Meteo, no key)
 *
 *   NEKO_URL     the neko server (default http://127.0.0.1:8081)
 */
const nekoUrl = (process.env.NEKO_URL ?? "http://127.0.0.1:8081").replace(/\/+$/, "");

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ ...text(t), isError: true });

const server = new McpServer({ name: "neko-world", version: "0.1.0" });

server.registerTool("where_am_i", {
  description:
    "Where the learner is right now: city, region, country, coordinates and time zone, and whether they are at home. " +
    "The date and time zone in your system prompt are the server's, not the learner's: the learner may be elsewhere. " +
    "Call this first whenever the answer depends on where the learner is or their local time (the time now, today's date, " +
    "the weather here), and use its time zone with the time tool and its coordinates (or place) with get_weather. " +
    "It comes from their device's internet address, so the city can be approximate.",
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => {
  let body: any;
  try {
    const res = await fetch(`${nekoUrl}/api/location`, { signal: AbortSignal.timeout(3000) });
    body = await res.json();
  } catch (err) {
    return fail(`The neko server can't be reached (${(err as Error).message}), so the learner's location is unknown.`);
  }
  const loc = body?.location;
  if (!loc) return text("The learner's location is not known yet (no device has been located).");

  const where = [loc.city, loc.region, loc.country].filter(Boolean).join(", ");
  const minutes = Math.round((Date.now() - loc.at) / 60000);
  return text(
    `The learner is ${loc.home ? "at home" : "away from home"}, in ${where} ` +
      `(latitude ${loc.latitude}, longitude ${loc.longitude}). ` +
      `Time zone: ${loc.timeZone || "unknown"} (UTC${loc.utcOffset}). ` +
      `From their ${body.client === "board" ? "board" : "device"}'s internet address, ${minutes} min ago.`,
  );
});

server.registerTool("get_weather", {
  description:
    "Weather now and a daily forecast for any place. Give either `place` or `latitude` and `longitude`. " +
    "`place` is a city or place name in English or romaji, optionally followed by its region and country to tell " +
    "same-named places apart (e.g. 'London', 'Tokyo', 'Shibuya, Tokyo, JP'); Japanese script like '東京' is not found. " +
    "For the learner's own location, use where_am_i's coordinates. Days are labelled today/tomorrow in that place's local time.",
  inputSchema: {
    place: z.string().optional().describe("Place name in English or romaji, optionally with region and country, e.g. 'Shibuya, Tokyo, JP'"),
    latitude: z.number().min(-90).max(90).optional().describe("Latitude, with longitude, instead of a place name"),
    longitude: z.number().min(-180).max(180).optional().describe("Longitude, with latitude"),
    days: z.number().int().min(1).max(7).optional().describe("Days of forecast, including today (default 3)"),
  },
  annotations: { readOnlyHint: true },
}, async ({ place, latitude, longitude, days }) => {
  try {
    let where: Place | null;
    if (latitude !== undefined && longitude !== undefined) {
      where = { name: place || "The given location", latitude, longitude };
    } else if (place) {
      where = await findPlace(place);
      if (!where) return fail(`No place called "${place}" was found. Try the city's name in English or romaji.`);
    } else {
      return fail("Give a place name, or both latitude and longitude (where_am_i has the learner's).");
    }
    return text(await weatherReport(where, days ?? 3));
  } catch (err) {
    return fail(`The weather service failed: ${(err as Error).message}`);
  }
});

await server.connect(new StdioServerTransport());
console.error(`neko-world: ready (neko server ${nekoUrl})`);
