import { randomUUID } from "node:crypto";
import mqtt, { type MqttClient } from "mqtt";
import { config, layout } from "./config.ts";

/**
 * Nothing is stored: only the latest value of each entity is kept in memory and streamed to the page.
 *
 * Builds the house from Home Assistant MQTT discovery, so a new board or Zigbee device shows up without code changes:
 *   <prefix>/<component>/<node>/<object>/config   what an entity is and where its state and availability are published
 * ESPHome sends these for every sensor; Zigbee2MQTT does too when its `homeassistant` option is on.
 * Each config names a state topic (subscribed here) and usually an availability topic (online/offline).
 */

export interface Device {
  id: string; // device name, e.g. "presence-gf"
  label: string;
  /** room id in the 3D house, from layout.json; null when not placed */
  room: string | null;
  /** door or window opening id, from layout.json; null unless it is a contact/vibration sensor placed on one */
  opening: string | null;
  model: string | null;
  firmware: string | null;
  ip: string | null;
  /** null until the availability topic says; devices without one stay null */
  available: boolean | null;
  /** when it went online/offline, if that happened while we were connected */
  availableAt: number | null;
}

export interface Entity {
  id: string; // "<node>/<object>", e.g. "presence-gf/distance"
  device: string;
  component: string; // binary_sensor, sensor, ...
  name: string;
  deviceClass: string | null;
  unit: string | null;
  value: number | string | boolean | null;
  /** when the value last changed; null when the only value is a retained one from before we connected */
  at: number | null;
}

export type Update =
  | { type: "device"; device: Device }
  | { type: "entity"; entity: Entity }
  | { type: "broker"; connected: boolean };

interface Binding {
  entity: Entity;
  stateTopic: string;
  jsonKey: string | null; // from a value_template like "{{ value_json.temperature }}"
  payloadOn: string;
  payloadOff: string;
}

// Discovery messages may use abbreviated keys (ESPHome does).
const ABBR: Record<string, string> = {
  stat_t: "state_topic",
  avty_t: "availability_topic",
  avty: "availability",
  unit_of_meas: "unit_of_measurement",
  dev_cla: "device_class",
  val_tpl: "value_template",
  pl_on: "payload_on",
  pl_off: "payload_off",
  pl_avail: "payload_available",
  pl_not_avail: "payload_not_available",
  dev: "device",
  ids: "identifiers",
  mdl: "model",
  mf: "manufacturer",
  sw: "sw_version",
  t: "topic",
};

type Json = Record<string, unknown>;

function expand(o: Json): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(o)) {
    const key = ABBR[k] ?? k;
    out[key] = Array.isArray(v) ? v.map((x) => (x && typeof x === "object" ? expand(x as Json) : x)) : v && typeof v === "object" ? expand(v as Json) : v;
  }
  // "~" is a base topic that other topics may start or end with
  const base = typeof out["~"] === "string" ? (out["~"] as string) : null;
  if (base) {
    for (const [k, v] of Object.entries(out)) {
      if (k.endsWith("topic") && typeof v === "string") out[k] = v.startsWith("~") ? base + v.slice(1) : v.endsWith("~") ? v.slice(0, -1) + base : v;
    }
  }
  return out;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

const devices = new Map<string, Device>();
const entities = new Map<string, Entity>();
const byStateTopic = new Map<string, Binding[]>();
const byAvailTopic = new Map<string, { devices: Set<string>; on: string; off: string }>();
const ipByName = new Map<string, string>();
const listeners = new Set<(u: Update) => void>();
let client: MqttClient | null = null;
let connected = false;

function emit(u: Update) {
  for (const fn of listeners) fn(u);
}

export function subscribe(fn: (u: Update) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function snapshot() {
  return { connected, devices: [...devices.values()], entities: [...entities.values()] };
}

function ensureDevice(id: string, info: Json | null): Device {
  let d = devices.get(id);
  if (!d) {
    const place = layout.devices[id];
    d = { id, label: place?.label ?? id, room: place?.room ?? null, opening: place?.opening ?? null, model: null, firmware: null, ip: ipByName.get(id) ?? null, available: null, availableAt: null };
    devices.set(id, d);
  }
  if (info) {
    d.model = str(info.model) ?? d.model;
    d.firmware = str(info.sw_version)?.replace(/\s*\(config hash.*\)$/, "") ?? d.firmware;
  }
  return d;
}

function onDiscovery(topic: string, payload: string) {
  // <prefix>/<component>/<node>/<object>/config  (node is optional in the spec)
  const parts = topic.slice(config.discoveryPrefix.length + 1).split("/");
  if (parts.at(-1) !== "config" || parts.length < 3) return;
  const component = parts[0];
  if (!["sensor", "binary_sensor"].includes(component)) return; // read-only dashboard for now
  const node = parts.length >= 4 ? parts[1] : null;
  const object = parts.at(-2)!;
  if (!payload) return; // an empty config removes the entity; keep it simple and leave it until restart

  let c: Json;
  try {
    c = expand(JSON.parse(payload));
  } catch {
    return;
  }
  const stateTopic = str(c.state_topic);
  if (!stateTopic) return;
  const dev = (c.device as Json | undefined) ?? null;
  const deviceId = str(dev?.name) ?? node ?? object;
  const device = ensureDevice(deviceId, dev);
  const id = `${node ?? deviceId}/${object}`;

  const entity: Entity = entities.get(id) ?? {
    id,
    device: device.id,
    component,
    name: str(c.name) ?? object,
    deviceClass: str(c.device_class),
    unit: str(c.unit_of_measurement),
    value: null,
    at: null,
  };
  entities.set(id, entity);

  const tpl = str(c.value_template);
  const binding: Binding = {
    entity,
    stateTopic,
    jsonKey: tpl?.match(/value_json\.([\w]+)/)?.[1] ?? tpl?.match(/value_json\[['"]([^'"]+)['"]\]/)?.[1] ?? null,
    // Zigbee2MQTT sends booleans here (a contact sensor: payload_on false, since contact true means closed)
    payloadOn: c.payload_on !== undefined && c.payload_on !== null ? String(c.payload_on) : "ON",
    payloadOff: c.payload_off !== undefined && c.payload_off !== null ? String(c.payload_off) : "OFF",
  };
  const list = (byStateTopic.get(stateTopic) ?? []).filter((b) => b.entity.id !== id);
  list.push(binding);
  if (!byStateTopic.has(stateTopic)) client?.subscribe(stateTopic);
  byStateTopic.set(stateTopic, list);

  const avail = str(c.availability_topic)
    ? [{ topic: c.availability_topic, payload_available: c.payload_available, payload_not_available: c.payload_not_available }]
    : Array.isArray(c.availability)
      ? (c.availability as Json[])
      : [];
  for (const a of avail) {
    const t = str(a.topic);
    if (!t) continue;
    const entry = byAvailTopic.get(t) ?? { devices: new Set<string>(), on: str(a.payload_available) ?? "online", off: str(a.payload_not_available) ?? "offline" };
    entry.devices.add(device.id);
    if (!byAvailTopic.has(t)) client?.subscribe(t);
    byAvailTopic.set(t, entry);
  }
  emit({ type: "device", device });
  emit({ type: "entity", entity });
}

function parse(b: Binding, text: string): number | string | boolean | null {
  let raw: unknown = text;
  if (b.jsonKey) {
    try {
      raw = (JSON.parse(text) as Json)[b.jsonKey];
    } catch {
      return null;
    }
    if (raw === undefined) return null; // this message is about other fields
  }
  if (b.entity.component === "binary_sensor") {
    const s = String(raw);
    if (s === b.payloadOn) return true;
    if (s === b.payloadOff) return false;
    return typeof raw === "boolean" ? raw : null;
  }
  if (typeof raw === "number") return raw;
  const s = String(raw);
  return s !== "" && Number.isFinite(Number(s)) ? Number(s) : s;
}

function onState(topic: string, text: string, retained: boolean) {
  for (const b of byStateTopic.get(topic) ?? []) {
    const value = parse(b, text);
    if (value === null) continue;
    const e = b.entity;
    if (e.value === value) continue;
    // a retained message is an old value replayed on connect: we don't know when it changed
    e.at = retained ? null : Date.now();
    e.value = value;
    emit({ type: "entity", entity: e });
  }
  const a = byAvailTopic.get(topic);
  if (a) {
    const available = text === a.on ? true : text === a.off ? false : null;
    if (available === null) return;
    for (const id of a.devices) {
      const d = ensureDevice(id, null);
      if (d.available === available) continue;
      d.availableAt = retained ? null : Date.now();
      d.available = available;
      emit({ type: "device", device: d });
    }
  }
}

function onDiscover(topic: string, text: string) {
  // ESPHome's own announcement: esphome/discover/<name> {"ip": ...}
  try {
    const j = JSON.parse(text) as Json;
    const name = str(j.name) ?? topic.split("/").at(-1)!;
    const ip = str(j.ip);
    if (!ip) return;
    ipByName.set(name, ip);
    const d = devices.get(name);
    if (d && d.ip !== ip) {
      d.ip = ip;
      emit({ type: "device", device: d });
    }
  } catch {
    /* not JSON */
  }
}

export function start(log: { info: (m: string) => void; warn: (m: string) => void }) {
  client = mqtt.connect(config.mqttUrl, {
    username: config.mqttUsername || undefined,
    password: config.mqttPassword || undefined,
    clientId: `home-${randomUUID().slice(0, 8)}`,
    reconnectPeriod: 5000,
  });
  client.on("connect", () => {
    connected = true;
    emit({ type: "broker", connected });
    log.info(`mqtt connected to ${config.mqttUrl}`);
    client!.subscribe([`${config.discoveryPrefix}/#`, "esphome/discover/#", ...byStateTopic.keys(), ...byAvailTopic.keys()]);
  });
  client.on("close", () => {
    if (!connected) return;
    connected = false;
    emit({ type: "broker", connected });
  });
  client.on("error", (err) => log.warn(`mqtt: ${err.message}`));
  client.on("message", (topic, payload, packet) => {
    const text = payload.toString();
    if (topic.startsWith(`${config.discoveryPrefix}/`)) onDiscovery(topic, text);
    else if (topic.startsWith("esphome/discover/")) onDiscover(topic, text);
    else onState(topic, text, packet.retain);
  });
}
