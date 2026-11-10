import tzlookup from "@photostructure/tz-lookup";
import { config } from "./config.ts";

/**
 * Where a client is, from its public IP address (ip2location.io).
 *
 * The board only knows its LAN address; its public address is the router's or the phone hotspot's,
 * which only the box sees. So the box works it out from the WebSocket request:
 *  - behind the Cloudflare Tunnel: the CF-Connecting-IP header (then X-Forwarded-For)
 *  - otherwise: the socket's own address
 * A private address means the client is on the home network: then ip2location.io is asked without an
 * IP, so it locates the box itself, which is home.
 *
 * Mobile carriers share public addresses across a region, so on a hotspot the country and time zone
 * are right but the city can be off.
 */

export interface Location {
  ip: string; // the public address looked up (the box's own when home)
  home: boolean; // the client is on the home network
  city: string;
  region: string;
  country: string; // ISO code, e.g. "JP"
  latitude: number;
  longitude: number;
  utcOffset: string; // e.g. "+09:00"
  timeZone: string; // IANA name from the coordinates, e.g. "Asia/Tokyo" ("" if unknown)
  at: number; // ms since epoch
}

type Headers = Record<string, string | string[] | undefined>;

const CACHE_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, Location>(); // public IP ("" = home) → location

const first = (h: string | string[] | undefined) => (Array.isArray(h) ? h[0] : h)?.split(",")[0]?.trim() || "";

/** The client's address as the internet sees it (or its LAN address when it's at home). */
export function clientIp(headers: Headers, remoteAddress: string | undefined): string {
  const ip = first(headers["cf-connecting-ip"]) || first(headers["x-forwarded-for"]) || remoteAddress || "";
  return ip.replace(/^::ffff:/, ""); // IPv4 seen through an IPv6 socket
}

/** LAN, loopback, link-local and 100.64/10 (carrier NAT, Tailscale) addresses: not locatable, so treated as home. */
export function isPrivate(ip: string): boolean {
  if (!ip) return true;
  const v4 = ip.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  return v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

/** Locate a client by its address. Returns null when ip2location.io isn't set up or fails. */
export async function locate(ip: string): Promise<Location | null> {
  if (!config.ip2locationKey) return null;
  if (!isPrivate(ip)) {
    // the board on the home Wi-Fi reports the same public IP as the box's own: that's home
    const homeLoc = await locate("");
    if (homeLoc && homeLoc.ip === ip) return homeLoc;
  }
  const home = isPrivate(ip);
  const key = home ? "" : ip;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached;

  const url = new URL("https://api.ip2location.io/");
  url.searchParams.set("key", config.ip2locationKey);
  if (!home) url.searchParams.set("ip", ip); // no ip: locate the caller, i.e. the box, i.e. home
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.error) {
    throw new Error(`ip2location.io: ${body?.error?.error_message ?? res.statusText}`);
  }
  const latitude = Number(body.latitude), longitude = Number(body.longitude);
  const loc: Location = {
    ip: String(body.ip ?? ip),
    home,
    city: String(body.city_name ?? ""),
    region: String(body.region_name ?? ""),
    country: String(body.country_code ?? ""),
    latitude,
    longitude,
    utcOffset: String(body.time_zone ?? ""),
    timeZone: zoneAt(latitude, longitude),
    at: Date.now(),
  };
  cache.set(key, loc);
  return loc;
}

/**
 * The IANA zone at some coordinates, offline (tz-lookup's coarse map: right except within a few km of a
 * border, far finer than an IP location). ip2location.io's free plan gives only a UTC offset, which misses
 * daylight saving.
 */
function zoneAt(latitude: number, longitude: number): string {
  try {
    return tzlookup(latitude, longitude);
  } catch {
    return ""; // not valid coordinates
  }
}

// ── the learner's time zone ──────────────────────────────────────────────────

const boxZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
let learnerZone: { zone: string; fromBoard: boolean } | null = null;

/** A client was located: its zone becomes the learner's. The board's wins over a browser's (it travels with them). */
export function noteLocation(loc: Location, client: string | undefined) {
  if (!loc.timeZone) return;
  const fromBoard = client === "board";
  if (fromBoard || !learnerZone?.fromBoard) learnerZone = { zone: loc.timeZone, fromBoard };
}

/**
 * The learner's time zone, for bedtime, "today" and note times: where the board was last located, else a
 * browser, else the box's own zone (nothing located yet, e.g. right after a restart or without IP2LOCATION_KEY).
 */
export const learnerTimeZone = () => learnerZone?.zone || boxZone;
