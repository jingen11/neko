import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { device, snapshot } from "./broker.ts";
import { config } from "./config.ts";

/**
 * Temperature and humidity history, in home.db.
 *
 * Once a minute, on the minute, every device with a temperature or humidity sensor (not a diagnostic one:
 * a switch's own chip temperature doesn't count) gets one row with its latest values. Zigbee sensors only
 * report when a value changes, so a row repeats the last reading until the next one arrives.
 * Nothing is written for a device that's offline, or while the MQTT broker is down: a gap in the history means "unknown".
 */

mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(path.join(config.dataDir, "home.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS climate_readings (
    device      TEXT NOT NULL,         -- e.g. porch_sensor
    at          INTEGER NOT NULL,      -- ms since epoch, on the minute
    temperature REAL,                  -- °C; null if the device has none or hasn't reported
    humidity    REAL,                  -- % relative humidity; likewise
    PRIMARY KEY (device, at)
  ) WITHOUT ROWID;
`);

const MINUTE = 60_000;
const qInsert = db.prepare("INSERT OR IGNORE INTO climate_readings (device, at, temperature, humidity) VALUES (?, ?, ?, ?)");
// node:sqlite binds JS numbers as REAL: the bucket is cast so `at / bucket` is integer division
const qRange = db.prepare(`
  SELECT (at / CAST(?1 AS INTEGER)) * CAST(?1 AS INTEGER) AS t, AVG(temperature) AS temperature, AVG(humidity) AS humidity
  FROM climate_readings WHERE device = ?2 AND at >= ?3
  GROUP BY at / CAST(?1 AS INTEGER) ORDER BY t
`);

export interface ClimateReading {
  at: number;
  temperature: number | null;
  humidity: number | null;
}

/** devices whose temperature/humidity is worth recording, with their latest values */
function current() {
  const out = new Map<string, { temperature: number | null; humidity: number | null }>();
  for (const e of snapshot().entities) {
    if (e.diagnostic || (e.deviceClass !== "temperature" && e.deviceClass !== "humidity")) continue;
    const row = out.get(e.device) ?? { temperature: null, humidity: null };
    if (typeof e.value === "number" && Number.isFinite(e.value)) row[e.deviceClass] = e.value;
    out.set(e.device, row);
  }
  return out;
}

function sample(at: number) {
  if (!snapshot().connected) return;
  for (const [id, r] of current()) {
    if (device(id)?.available === false) continue;
    if (r.temperature === null && r.humidity === null) continue;
    qInsert.run(id, at, r.temperature, r.humidity);
  }
}

/** Readings of one device since `since`, averaged into buckets of `bucket` ms (one minute = the raw rows). */
export function readings(deviceId: string, since: number, bucket = MINUTE): ClimateReading[] {
  const b = Math.max(MINUTE, Math.round(bucket / MINUTE) * MINUTE);
  return (qRange.all(b, deviceId, since) as Record<string, number | null>[]).map((r) => ({
    at: Number(r.t),
    temperature: r.temperature === null ? null : Math.round(Number(r.temperature) * 100) / 100,
    humidity: r.humidity === null ? null : Math.round(Number(r.humidity) * 100) / 100,
  }));
}

/** Devices that have climate history or a climate sensor right now. */
export function climateDevices(): string[] {
  const ids = new Set(current().keys());
  for (const r of db.prepare("SELECT DISTINCT device FROM climate_readings").all() as { device: string }[]) ids.add(r.device);
  return [...ids].sort();
}

/** Start sampling, on each minute boundary. */
export function startClimate(log: { warn: (m: string) => void }) {
  const tick = () => {
    const at = Math.floor(Date.now() / MINUTE) * MINUTE;
    try {
      sample(at);
    } catch (err) {
      log.warn(`climate: couldn't record readings: ${(err as Error).message}`);
    }
    setTimeout(tick, at + MINUTE - Date.now() + 50);
  };
  setTimeout(tick, MINUTE - (Date.now() % MINUTE) + 50);
}
