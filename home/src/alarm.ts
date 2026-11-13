import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { subscribe, type Update } from "./broker.ts";
import { config, layout } from "./config.ts";

/**
 * The alarm, kept in home.db so a restart doesn't drop it.
 *
 * It arms itself from a schedule, in the box's local time:
 *   - armed periods: daily windows like 23:00-07:00 (an end before the start runs past midnight)
 *   - away days: date ranges, armed all day long
 * Arming or disarming by hand overrides the schedule until the schedule itself next changes
 * (e.g. disarm at 23:30 inside a 23:00-07:00 period -> stays disarmed until 07:00, then follows the schedule).
 *
 * Each armed stretch is a session; while one is open, every live sensor change and every board going
 * online/offline is written to alarm_events. Retained values replayed on (re)connect are skipped:
 * they are old readings, not something that happened while armed.
 */

mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(path.join(config.dataDir, "home.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS alarm_periods (
    id    INTEGER PRIMARY KEY,
    start TEXT NOT NULL,               -- HH:MM local
    end   TEXT NOT NULL                -- HH:MM local; before start = runs past midnight
  );
  CREATE TABLE IF NOT EXISTS alarm_away (
    id        INTEGER PRIMARY KEY,
    from_date TEXT NOT NULL,           -- YYYY-MM-DD local, inclusive
    to_date   TEXT NOT NULL,           -- YYYY-MM-DD local, inclusive
    note      TEXT
  );
  -- one row: a manual arm/disarm, and what the schedule said when it was made
  CREATE TABLE IF NOT EXISTS alarm_override (
    id        INTEGER PRIMARY KEY CHECK (id = 1),
    armed     INTEGER NOT NULL,
    scheduled TEXT NOT NULL,           -- 'away' | 'schedule' | 'off'
    at        INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS alarm_sessions (
    id          INTEGER PRIMARY KEY,
    armed_at    INTEGER NOT NULL,      -- ms since epoch
    disarmed_at INTEGER,               -- null while still armed
    reason      TEXT NOT NULL          -- 'away' | 'schedule' | 'manual'
  );
  CREATE TABLE IF NOT EXISTS alarm_events (
    id         INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES alarm_sessions(id),
    at         INTEGER NOT NULL,       -- ms since epoch
    kind       TEXT NOT NULL,          -- 'entity' (a reading changed) | 'availability' (board online/offline)
    device     TEXT NOT NULL,          -- e.g. presence-gf
    entity     TEXT,                   -- e.g. presence-gf/occupied; null for availability
    name       TEXT,                   -- entity name, e.g. Occupied
    room       TEXT,                   -- from layout.json at the time
    opening    TEXT,
    value      TEXT,                   -- JSON: true/false, a number, a string
    unit       TEXT
  );
  CREATE INDEX IF NOT EXISTS alarm_events_session ON alarm_events(session_id, at);
`);

// ---- types ----

export interface Period {
  id: number;
  start: string;
  end: string;
}
export interface Away {
  id: number;
  from: string;
  to: string;
  note: string | null;
}
export interface AlarmSession {
  id: number;
  armedAt: number;
  disarmedAt: number | null;
  reason: Reason;
}
export interface AlarmEvent {
  id: number;
  sessionId: number;
  at: number;
  kind: "entity" | "availability";
  device: string;
  entity: string | null;
  name: string | null;
  room: string | null;
  opening: string | null;
  value: unknown;
  unit: string | null;
}
type Reason = "away" | "schedule" | "manual";
/** what the schedule alone says right now */
type Scheduled = "away" | "schedule" | "off";

export interface AlarmStatus {
  armed: boolean;
  /** why it's armed; null when disarmed */
  reason: Reason | null;
  /** what the schedule says, ignoring any manual override */
  scheduled: Scheduled;
  /** a manual arm/disarm in force, or null when following the schedule */
  override: { armed: boolean; at: number } | null;
  session: AlarmSession | null;
}

type Row = Record<string, string | number | null>;

const toSession = (r: Row): AlarmSession => ({
  id: Number(r.id),
  armedAt: Number(r.armed_at),
  disarmedAt: r.disarmed_at === null ? null : Number(r.disarmed_at),
  reason: r.reason as Reason,
});
const toEvent = (r: Row): AlarmEvent => ({
  id: Number(r.id),
  sessionId: Number(r.session_id),
  at: Number(r.at),
  kind: r.kind as AlarmEvent["kind"],
  device: String(r.device),
  entity: r.entity as string | null,
  name: r.name as string | null,
  room: r.room as string | null,
  opening: r.opening as string | null,
  value: r.value === null ? null : JSON.parse(String(r.value)),
  unit: r.unit as string | null,
});

// ---- schedule ----

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const isTime = (s: string) => HHMM.test(s);
export const isDate = (s: string) => DATE.test(s) && !Number.isNaN(Date.parse(s));

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const qPeriods = db.prepare("SELECT id, start, end FROM alarm_periods ORDER BY start, id");
const qAways = db.prepare("SELECT id, from_date AS 'from', to_date AS 'to', note FROM alarm_away ORDER BY from_date, id");

export const periods = () => qPeriods.all() as unknown as Period[];
export const aways = () => qAways.all() as unknown as Away[];

function scheduledNow(now = new Date()): Scheduled {
  const today = localDate(now);
  if (aways().some((a) => a.from <= today && today <= a.to)) return "away";
  const m = now.getHours() * 60 + now.getMinutes();
  for (const p of periods()) {
    const s = minutes(p.start);
    const e = minutes(p.end);
    if (s < e ? s <= m && m < e : m >= s || m < e) return "schedule";
  }
  return "off";
}

/** Replace all armed periods at once. */
export function setPeriods(list: { start: string; end: string }[]) {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM alarm_periods");
    const ins = db.prepare("INSERT INTO alarm_periods (start, end) VALUES (?, ?)");
    for (const p of list) ins.run(p.start, p.end);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  evaluate();
  return periods();
}

export function addAway(from: string, to: string, note: string | null): Away {
  const { lastInsertRowid } = db.prepare("INSERT INTO alarm_away (from_date, to_date, note) VALUES (?, ?, ?)").run(from, to, note);
  evaluate();
  return { id: Number(lastInsertRowid), from, to, note };
}

export function removeAway(id: number): boolean {
  const { changes } = db.prepare("DELETE FROM alarm_away WHERE id = ?").run(id);
  evaluate();
  return Number(changes) > 0;
}

// ---- state ----

const qOverride = db.prepare("SELECT armed, scheduled, at FROM alarm_override WHERE id = 1");
const qSetOverride = db.prepare("INSERT OR REPLACE INTO alarm_override (id, armed, scheduled, at) VALUES (1, ?, ?, ?)");
const qClearOverride = db.prepare("DELETE FROM alarm_override");
const qOpen = db.prepare("SELECT * FROM alarm_sessions WHERE disarmed_at IS NULL ORDER BY id DESC LIMIT 1");
const qArm = db.prepare("INSERT INTO alarm_sessions (armed_at, reason) VALUES (?, ?)");
const qDisarm = db.prepare("UPDATE alarm_sessions SET disarmed_at = ? WHERE disarmed_at IS NULL");
const qSessions = db.prepare("SELECT * FROM alarm_sessions ORDER BY id DESC LIMIT ?");
const qEvents = db.prepare("SELECT * FROM alarm_events WHERE session_id = ? ORDER BY at, id");
const qInsert = db.prepare(
  "INSERT INTO alarm_events (session_id, at, kind, device, entity, name, room, opening, value, unit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
);

let current: AlarmSession | null = (() => {
  const r = qOpen.get() as Row | undefined;
  return r ? toSession(r) : null;
})();
let last: AlarmStatus | null = null;
const listeners = new Set<(s: AlarmStatus) => void>();

function override() {
  const r = qOverride.get() as Row | undefined;
  return r ? { armed: Number(r.armed) === 1, scheduled: r.scheduled as Scheduled, at: Number(r.at) } : null;
}

/** Work out what the alarm should be now, open or close the session to match, and tell listeners if anything changed. */
function evaluate(): AlarmStatus {
  const scheduled = scheduledNow();
  let o = override();
  if (o && o.scheduled !== scheduled) {
    qClearOverride.run(); // the schedule moved on since the manual change: follow it again
    o = null;
  }
  const armed = o ? o.armed : scheduled !== "off";
  const reason: Reason | null = !armed ? null : o ? "manual" : (scheduled as Reason);

  if (armed && !current) {
    const at = Date.now();
    const { lastInsertRowid } = qArm.run(at, reason);
    current = { id: Number(lastInsertRowid), armedAt: at, disarmedAt: null, reason: reason! };
  } else if (!armed && current) {
    qDisarm.run(Date.now());
    current = null;
  }

  const s: AlarmStatus = { armed, reason, scheduled, override: o && { armed: o.armed, at: o.at }, session: current };
  const key = JSON.stringify(s);
  if (key !== JSON.stringify(last)) {
    last = s;
    for (const fn of listeners) fn(s);
  }
  return s;
}

export const status = () => evaluate();

export function onAlarm(fn: (s: AlarmStatus) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Arm or disarm by hand; holds until the schedule next changes. */
export function setArmed(armed: boolean): AlarmStatus {
  const scheduled = scheduledNow();
  if (armed === (scheduled !== "off")) qClearOverride.run(); // matches the schedule: nothing to override
  else qSetOverride.run(armed ? 1 : 0, scheduled, Date.now());
  return evaluate();
}

/** Drop a manual override and follow the schedule now. */
export function clearOverride(): AlarmStatus {
  qClearOverride.run();
  return evaluate();
}

export const sessions = (limit = 50) => (qSessions.all(limit) as Row[]).map(toSession);
export const events = (sessionId: number) => (qEvents.all(sessionId) as Row[]).map(toEvent);

// ---- logging ----

/** availableAt of the last online/offline flip logged per device */
const availLogged = new Map<string, number>();

function record(u: Update) {
  if (!current) return;
  if (u.type === "entity") {
    const e = u.entity;
    if (e.at === null) return; // retained replay, not a live change
    const place = layout.devices[e.device];
    qInsert.run(current.id, e.at, "entity", e.device, e.id, e.name, place?.room ?? null, place?.opening ?? null, JSON.stringify(e.value), e.unit);
  } else if (u.type === "device") {
    const d = u.device;
    // device updates also fire for discovery and IP changes; only log live online/offline flips,
    // which are the ones that set a new availableAt
    if (d.available === null || d.availableAt === null || availLogged.get(d.id) === d.availableAt) return;
    availLogged.set(d.id, d.availableAt);
    qInsert.run(current.id, d.availableAt, "availability", d.id, null, null, d.room, d.opening, JSON.stringify(d.available), null);
  }
}

subscribe(record);
evaluate();
// periods start and end on the minute; check a few times a minute
setInterval(evaluate, 15_000).unref();
