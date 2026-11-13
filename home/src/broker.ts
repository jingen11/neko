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
  /** IEEE address when the device comes from Zigbee2MQTT (discovery identifier "zigbee2mqtt_0x..."), else null */
  zigbee: string | null;
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
  /** Zigbee2MQTT marks battery, voltage, link quality and the like as `entity_category: diagnostic` */
  diagnostic: boolean;
}

export type Update =
  | { type: "device"; device: Device }
  | { type: "entity"; entity: Entity }
  | { type: "broker"; connected: boolean }
  /** a device left with no entities, e.g. the old name after a Zigbee2MQTT rename */
  | { type: "device-removed"; id: string };

interface Binding {
  entity: Entity;
  stateTopic: string;
  jsonPath: string[] | null; // from a value_template like "{{ value_json.temperature }}" or "{{ value_json.coordinator.meta.revision }}"
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
  ent_cat: "entity_category",
  avty_mode: "availability_mode",
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
interface AvailTopic {
  devices: Set<string>;
  on: string;
  off: string;
  /** Zigbee2MQTT sends {"state":"online"} with value_template "{{ value_json.state }}"; ESPHome a plain "online" */
  path: string[] | null;
  /** last reading of this topic */
  value: boolean | null;
}
const byAvailTopic = new Map<string, AvailTopic>();
/**
 * Which availability topics a device has and how they combine (discovery's availability_mode).
 * Zigbee2MQTT gives each device two with mode "all": the bridge (Z2M itself is up) and the device's own.
 */
const availOf = new Map<string, { topics: string[]; mode: string }>();
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
    d = { id, label: place?.label ?? id, room: place?.room ?? null, opening: place?.opening ?? null, model: null, firmware: null, zigbee: null, ip: ipByName.get(id) ?? null, available: null, availableAt: null };
    devices.set(id, d);
  }
  if (info) {
    d.model = str(info.model) ?? d.model;
    d.firmware = str(info.sw_version)?.replace(/\s*\(config hash.*\)$/, "") ?? d.firmware;
    const ids = Array.isArray(info.identifiers) ? info.identifiers : [info.identifiers];
    const z = ids.map(str).find((x) => x?.startsWith("zigbee2mqtt_0x"));
    if (z) d.zigbee = z.slice("zigbee2mqtt_".length);
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

  const meta = {
    component,
    name: str(c.name) ?? object,
    deviceClass: str(c.device_class),
    unit: str(c.unit_of_measurement),
    diagnostic: c.entity_category === "diagnostic",
  };
  const existing = entities.get(id);
  const entity: Entity = existing ? Object.assign(existing, meta) : { id, device: device.id, ...meta, value: null, at: null };
  entities.set(id, entity);
  // A Zigbee2MQTT rename republishes the same entities (same node: the IEEE address) under a new device name:
  // move them to the new device and forget the old one once nothing is left on it.
  if (existing && existing.device !== device.id) {
    const old = existing.device;
    entity.device = device.id;
    dropIfEmpty(old);
  }

  const tpl = str(c.value_template);
  const binding: Binding = {
    entity,
    stateTopic,
    jsonPath: jsonPath(tpl),
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
  const topics: string[] = [];
  for (const a of avail) {
    const t = str(a.topic);
    if (!t) continue;
    topics.push(t);
    const entry = byAvailTopic.get(t) ?? {
      devices: new Set<string>(),
      on: str(a.payload_available) ?? "online",
      off: str(a.payload_not_available) ?? "offline",
      path: jsonPath(str(a.value_template)),
      value: null,
    };
    entry.devices.add(device.id);
    if (!byAvailTopic.has(t)) client?.subscribe(t);
    byAvailTopic.set(t, entry);
  }
  if (topics.length) availOf.set(device.id, { topics, mode: str(c.availability_mode) ?? "latest" });
  emit({ type: "device", device });
  emit({ type: "entity", entity });
}

/** "{{ value_json.a.b }}", "{{ value_json['a'] }}" (Zigbee2MQTT wraps it in {% if "a" in value_json %}) -> ["a", "b"] */
function jsonPath(tpl: string | null): string[] | null {
  const m = tpl?.match(/value_json((?:\.\w+|\[['"][^'"]+['"]\])+)/);
  if (!m) return null;
  return [...m[1].matchAll(/\.(\w+)|\[['"]([^'"]+)['"]\]/g)].map((p) => p[1] ?? p[2]);
}

/** the value at `path` in a JSON message; undefined when it isn't JSON or the path isn't there */
function dig(text: string, path: string[]): unknown {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  for (const k of path) raw = raw !== null && typeof raw === "object" ? (raw as Json)[k] : undefined;
  return raw;
}

/** Re-read a device's label and place from layout.json (after the devices API changed it) and tell the page. */
export function place(id: string) {
  const d = devices.get(id);
  if (!d) return;
  const p = layout.devices[id];
  d.label = p?.label ?? id;
  d.room = p?.room ?? null;
  d.opening = p?.opening ?? null;
  emit({ type: "device", device: d });
}

export const device = (id: string) => devices.get(id) ?? null;

/** Zigbee2MQTT bridge requests: answered on <base>/bridge/response/<same path>, matched by transaction id. */
const pendingZ2m = new Map<string, { resolve: (r: Json) => void; timer: NodeJS.Timeout }>();
export function zigbeeRequest(what: string, payload: Json, timeoutMs = 10_000): Promise<Json> {
  if (!client?.connected) return Promise.reject(new Error("MQTT broker not connected"));
  const transaction = randomUUID().slice(0, 8);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingZ2m.delete(transaction);
      reject(new Error("Zigbee2MQTT did not answer (is it running?)"));
    }, timeoutMs);
    pendingZ2m.set(transaction, { resolve, timer });
    client!.publish(`${config.z2mBaseTopic}/bridge/request/${what}`, JSON.stringify({ ...payload, transaction }));
  });
}
function onZ2mResponse(text: string) {
  let r: Json;
  try {
    r = JSON.parse(text);
  } catch {
    return;
  }
  const p = typeof r.transaction === "string" ? pendingZ2m.get(r.transaction) : undefined;
  if (!p) return;
  clearTimeout(p.timer);
  pendingZ2m.delete(r.transaction as string);
  p.resolve(r);
}

function dropIfEmpty(id: string) {
  for (const e of entities.values()) if (e.device === id) return;
  if (!devices.delete(id)) return;
  for (const a of byAvailTopic.values()) a.devices.delete(id);
  availOf.delete(id);
  emit({ type: "device-removed", id });
}

function parse(b: Binding, text: string): number | string | boolean | null {
  let raw: unknown = text;
  if (b.jsonPath) {
    raw = dig(text, b.jsonPath);
    if (raw === undefined) return null; // this message is about other fields
    if (raw !== null && typeof raw === "object") return null; // the template points at a whole object, not a value
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
    const s = String(a.path ? dig(text, a.path) : text);
    const v = s === a.on ? true : s === a.off ? false : null;
    if (v === null) return;
    a.value = v;
    for (const id of a.devices) {
      const av = availOf.get(id);
      const vals = (av?.topics ?? [topic]).map((t) => byAvailTopic.get(t)?.value ?? null);
      // "all": online only when every topic says so; "any": when one does; "latest" (the default): this message decides
      const available =
        av?.mode === "all"
          ? vals.includes(false) ? false : vals.every((x) => x === true) ? true : null
          : av?.mode === "any"
            ? vals.includes(true) ? true : vals.every((x) => x === false) ? false : null
            : v;
      if (available === null) continue;
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
    client!.subscribe([`${config.discoveryPrefix}/#`, "esphome/discover/#", `${config.z2mBaseTopic}/bridge/response/#`, ...byStateTopic.keys(), ...byAvailTopic.keys()]);
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
    else if (topic.startsWith(`${config.z2mBaseTopic}/bridge/response/`)) onZ2mResponse(text);
    else onState(topic, text, packet.retain);
  });
}
