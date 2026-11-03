import { randomUUID } from "node:crypto";
import mqtt, { type MqttClient } from "mqtt";
import { config } from "./config.ts";

/**
 * Talks to Zigbee2MQTT through the MQTT broker.
 *
 * Zigbee2MQTT topics (base = MQTT_BASE_TOPIC, "zigbee2mqtt" by default):
 *   <base>/<device>               device state, published by Z2M (JSON)
 *   <base>/<device>/set           we publish to change a device, e.g. {"state":"ON"}
 *   <base>/<device>/get           we publish to ask a device to report, e.g. {"state":""}
 *   <base>/<device>/availability  {"state":"online"|"offline"}
 *   <base>/bridge/state           {"state":"online"|"offline"}
 *   <base>/bridge/devices         retained list of paired devices
 *   <base>/bridge/request/<x>     we publish; Z2M answers on <base>/bridge/response/<x>
 */

export type DeviceState = Record<string, unknown>;

export interface Device {
  ieee_address: string;
  friendly_name: string;
  type: "Coordinator" | "Router" | "EndDevice" | string;
  supported?: boolean;
  disabled?: boolean;
  definition?: { model: string; vendor: string; description: string; exposes: unknown[] } | null;
  [key: string]: unknown;
}

type StateListener = (device: string, state: DeviceState) => void;

const base = config.mqttBaseTopic;
const devices = new Map<string, Device>(); // by friendly name
const states = new Map<string, DeviceState>(); // last state seen per device
const availability = new Map<string, boolean>();
const listeners = new Set<{ device: string | null; fn: StateListener }>();
const pending = new Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
let bridgeOnline = false;
let client: MqttClient | null = null;

const BRIDGE = `${base}/bridge/`;

function onMessage(topic: string, payload: Buffer) {
  if (!topic.startsWith(`${base}/`)) return;
  const rest = topic.slice(base.length + 1);
  const text = payload.toString();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text; // Z2M can be set to send plain strings; keep them as-is
  }

  if (topic.startsWith(BRIDGE)) {
    const sub = topic.slice(BRIDGE.length);
    if (sub === "state") bridgeOnline = (typeof data === "string" ? data : (data as { state?: string })?.state) === "online";
    else if (sub === "devices" && Array.isArray(data)) {
      devices.clear();
      for (const d of data as Device[]) devices.set(d.friendly_name, d);
    } else if (sub.startsWith("response/")) {
      const res = data as { status?: string; error?: string; data?: unknown; transaction?: string };
      const p = res?.transaction ? pending.get(res.transaction) : undefined;
      if (!p) return;
      pending.delete(res.transaction!);
      clearTimeout(p.timer);
      if (res.status === "ok") p.resolve(res.data);
      else p.reject(new Error(res.error ?? `zigbee2mqtt request failed`));
    }
    return;
  }

  if (rest.endsWith("/availability")) {
    const name = rest.slice(0, -"/availability".length);
    const state = typeof data === "string" ? data : (data as { state?: string })?.state;
    availability.set(name, state === "online");
    return;
  }
  // Ignore our own /set and /get echoes; a device name can contain "/", so only skip those suffixes.
  if (rest.endsWith("/set") || rest.endsWith("/get") || !data || typeof data !== "object" || Array.isArray(data)) return;

  const state = { ...states.get(rest), ...(data as DeviceState) };
  states.set(rest, state);
  for (const l of listeners) {
    if (l.device === null || l.device === rest) {
      try {
        l.fn(rest, data as DeviceState);
      } catch (err) {
        console.warn(`mqtt listener for ${rest} threw: ${(err as Error).message}`);
      }
    }
  }
}

/** Connect to the broker (once). Called automatically by the other functions. */
export function connect(): MqttClient {
  if (client) return client;
  if (!config.mqttUrl) throw new Error("MQTT_URL is not set");
  client = mqtt.connect(config.mqttUrl, {
    username: config.mqttUsername || undefined,
    password: config.mqttPassword || undefined,
    clientId: `neko-${randomUUID().slice(0, 8)}`,
    reconnectPeriod: 5000,
    connectTimeout: 10_000,
  });
  client.on("connect", () => client!.subscribe(`${base}/#`));
  client.on("message", onMessage);
  client.on("error", (err) => console.warn(`mqtt: ${err.message}`));
  return client;
}

/** Resolves once connected to the broker, or rejects after `timeoutMs`. */
export function ready(timeoutMs = 5000): Promise<void> {
  const c = connect();
  if (c.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = (err?: Error) => {
      clearTimeout(timer);
      c.off("connect", onConnect);
      c.off("error", onError);
      err ? reject(err) : resolve();
    };
    const onConnect = () => done();
    const onError = (err: Error) => done(err);
    const timer = setTimeout(() => done(new Error(`no connection to ${config.mqttUrl} after ${timeoutMs}ms`)), timeoutMs);
    c.on("connect", onConnect);
    c.on("error", onError);
  });
}

async function publish(topic: string, payload: unknown) {
  await ready();
  await connect().publishAsync(topic, typeof payload === "string" ? payload : JSON.stringify(payload));
}

/** Change a device, e.g. setDevice("desk lamp", { state: "ON", brightness: 120 }). */
export const setDevice = (device: string, payload: DeviceState) => publish(`${base}/${device}/set`, payload);

/** Ask a device to report properties now, e.g. getDevice("desk lamp", ["state"]). The answer arrives as a state update. */
export const getDevice = (device: string, props: string[] = ["state"]) =>
  publish(`${base}/${device}/get`, Object.fromEntries(props.map((p) => [p, ""])));

/** Send a bridge request (e.g. "permit_join", "device/rename") and wait for its response's `data`. */
export async function bridgeRequest<T = unknown>(action: string, payload: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
  await ready();
  const transaction = randomUUID();
  const answer = new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(transaction);
      reject(new Error(`zigbee2mqtt did not answer "${action}" within ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(transaction, { resolve: resolve as (d: unknown) => void, reject, timer });
  });
  await publish(`${BRIDGE}request/${action}`, { ...payload, transaction });
  return answer;
}

/**
 * Call `fn` on every state update from `device` (or from every device when `device` is null).
 * `fn` gets only the fields in that message; use lastState() for the merged picture. Returns an unsubscribe function.
 */
export function onState(device: string | null, fn: StateListener): () => void {
  connect();
  const entry = { device, fn };
  listeners.add(entry);
  return () => void listeners.delete(entry);
}

/** Resolves with the next state update from `device` that passes `match`, or rejects after `timeoutMs`. */
export function waitForState(device: string, match: (s: DeviceState) => boolean = () => true, timeoutMs = 10_000): Promise<DeviceState> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`no matching state from "${device}" within ${timeoutMs}ms`));
    }, timeoutMs);
    const off = onState(device, (_d, s) => {
      if (!match(s)) return;
      clearTimeout(timer);
      off();
      resolve(s);
    });
  });
}

/** Paired devices (from the retained bridge/devices message), without the coordinator. */
export const listDevices = (): Device[] => [...devices.values()].filter((d) => d.type !== "Coordinator");
export const lastState = (device: string): DeviceState | undefined => states.get(device);
/** true/false when Z2M's availability feature reports on this device, undefined otherwise. */
export const isAvailable = (device: string): boolean | undefined => availability.get(device);
export const isBridgeOnline = () => bridgeOnline;

/** For /api/health: throws unless the broker is reachable and Zigbee2MQTT is online. */
export async function mqttHealth() {
  await ready(3000);
  if (!bridgeOnline) throw new Error(`connected, but ${base}/bridge/state is not "online"`);
}

export async function disconnect() {
  if (!client) return;
  const c = client;
  client = null;
  await c.endAsync();
}
