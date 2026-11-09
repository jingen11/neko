import net from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { timeReport, zoneAt } from "./time.ts";
import { findPlace, weatherReport, type Place } from "./weather.ts";

/**
 * MCP server (stdio) with ねこ's tools for the world right now, for the Hermes neko profile.
 * Read-only.
 *
 *   get_time     the time now: the learner's own by default, or any place's (written as 午前7時23分)
 *   get_weather  weather now and ahead: the learner's location by default, or any place (Open-Meteo, no key)
 *   where_am_i   where the learner is, from the neko server (the board's public IP, ip2location.io)
 *
 * The time and weather default to where the learner is, so the model never needs the date and zone in
 * its system prompt, which are the server's (Hermes puts them there), not the learner's.
 *
 *   NEKO_URL     the neko server (default http://127.0.0.1:8081)
 */
const nekoUrl = (process.env.NEKO_URL ?? "http://127.0.0.1:8081").replace(/\/+$/, "");

// Node gives each of a host's addresses 250 ms to connect before trying the next. From home, Open-Meteo's
// servers (in Europe) can take longer than that, and IPv6 doesn't route, so requests failed at random.
net.setDefaultAutoSelectFamilyAttemptTimeout(2000);
const boxZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ ...text(t), isError: true });

interface Located {
  home: boolean;
  city: string;
  region: string;
  country: string;
  latitude: number;
  longitude: number;
  utcOffset: string;
  timeZone?: string;
  at: number;
}

/** Where the learner is, from the neko server; null when no device has been located yet. */
async function learner(): Promise<{ loc: Located; client: string } | null> {
  const res = await fetch(`${nekoUrl}/api/location`, { signal: AbortSignal.timeout(3000) });
  const body = await res.json();
  return body?.location ? { loc: body.location, client: body.client } : null;
}

const placeName = (loc: Located) => [loc.city, loc.region, loc.country].filter(Boolean).join(", ");

const server = new McpServer({ name: "neko-world", version: "0.2.0" });

server.registerTool("get_time", {
  description:
    "The time and date now, written out in Japanese (e.g. 午前7時23分) to say exactly as given. " +
    "Without `place` it is the learner's own local time, wherever they are: use this for 'what time is it' and " +
    "'what's the date'. The date and time zone in your system prompt are the server's, not the learner's, so " +
    "don't work the time out from them. With `place` it is that place's time.",
  inputSchema: {
    place: z.string().optional().describe("Another place, in English or romaji (e.g. 'Tokyo', 'London'). Leave out for the learner's own time."),
  },
  annotations: { readOnlyHint: true },
}, async ({ place }) => {
  try {
    if (place) {
      const p = await findPlace(place);
      if (!p) return fail(`No place called "${place}" was found. Try the city's name in English or romaji.`);
      const zone = zoneAt(p.latitude, p.longitude);
      if (!zone) return fail(`The time zone of ${p.name} could not be worked out.`);
      return text(timeReport(zone, `in ${p.name}`));
    }
    const l = await learner().catch(() => null);
    if (!l) return text(timeReport(boxZone, "at the learner's home (where they are now is not known, so this is home time)"));
    const zone = l.loc.timeZone || zoneAt(l.loc.latitude, l.loc.longitude) || boxZone;
    return text(timeReport(zone, `where the learner is, ${l.loc.home ? "at home in" : "away from home in"} ${placeName(l.loc)}`));
  } catch (err) {
    return fail(`The time could not be found: ${(err as Error).message}`);
  }
});

server.registerTool("get_weather", {
  description:
    "Weather now and a daily forecast. Without `place` it is the weather where the learner is: use this for " +
    "'the weather here' or 'will it rain tomorrow'. With `place` (a city or place name in English or romaji, " +
    "optionally followed by its region and country to tell same-named places apart, e.g. 'London', 'Shibuya, Tokyo, JP'; " +
    "Japanese script like '東京' is not found) or `latitude` and `longitude`, it is that place's. " +
    "Days are labelled today/tomorrow in that place's local time.",
  inputSchema: {
    place: z.string().optional().describe("Another place, in English or romaji. Leave out for where the learner is."),
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
      const l = await learner().catch(() => null);
      if (!l) return fail("Where the learner is is not known yet, so give a place.");
      where = { name: `Where the learner is: ${placeName(l.loc)}`, latitude: l.loc.latitude, longitude: l.loc.longitude };
    }
    return text(await weatherReport(where, days ?? 3));
  } catch (err) {
    return fail(`The weather service failed: ${(err as Error).message}`);
  }
});

server.registerTool("where_am_i", {
  description:
    "Where the learner is right now: city, region, country, coordinates and time zone, and whether they are at home. " +
    "For the time or weather there, get_time and get_weather already default to the learner's location. " +
    "It comes from their device's internet address, so the city can be approximate.",
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => {
  let l: Awaited<ReturnType<typeof learner>>;
  try {
    l = await learner();
  } catch (err) {
    return fail(`The neko server can't be reached (${(err as Error).message}), so the learner's location is unknown.`);
  }
  if (!l) return text("The learner's location is not known yet (no device has been located).");
  const { loc, client } = l;
  const minutes = Math.round((Date.now() - loc.at) / 60000);
  return text(
    `The learner is ${loc.home ? "at home" : "away from home"}, in ${placeName(loc)} ` +
      `(latitude ${loc.latitude}, longitude ${loc.longitude}). ` +
      `Time zone: ${loc.timeZone || "unknown"} (UTC${loc.utcOffset}). ` +
      `From their ${client === "board" ? "board" : "device"}'s internet address, ${minutes} min ago.`,
  );
});

await server.connect(new StdioServerTransport());
console.error(`neko-world: ready (neko server ${nekoUrl})`);
