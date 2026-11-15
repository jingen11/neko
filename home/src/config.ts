import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

/** Where each device is in the house. Keyed by the device name in its discovery message (ESPHome `name`, Z2M friendly name). */
export interface Placement {
  label: string;
  /** presence boards: a room id of the 3D house (ROOMS in public/app.js), e.g. "living" */
  room?: string;
  /** door and window sensors: an opening id (OPENINGS in public/app.js), e.g. "door-front", "win-kitchen-2" */
  opening?: string;
  /** what each relay of a switch or plug drives, keyed by the switch entity's object id (e.g. "switch_top" for an Aqara rocker) */
  loads?: Record<string, Load>;
}
export const LOAD_KINDS = ["light", "fan"] as const;
export interface Load {
  kind: (typeof LOAD_KINDS)[number];
  /** what the dashboard calls it, e.g. "Ceiling fan"; the kind's name when missing */
  label?: string;
}
interface Layout {
  devices: Record<string, Placement>;
}

const layoutPath = process.env.HOME_LAYOUT ?? path.join(root, "layout.json");
/** Read once at startup; the devices API (PATCH /api/devices/:id) changes it in place and saves it. */
export const layout: Layout = JSON.parse(readFileSync(layoutPath, "utf8"));

/** Write layout.json back, one device per line like the hand-written file. Written to a temp file first so a crash can't leave half a file. */
export function saveLayout() {
  const lines = Object.entries(layout.devices).map(([id, p]) => `    ${JSON.stringify(id)}: ${JSON.stringify(p).replace(/^\{/, "{ ").replace(/\}$/, " }").replace(/":/g, '": ').replace(/,"/g, ', "')}`);
  writeFileSync(`${layoutPath}.tmp`, `{\n  "devices": {\n${lines.join(",\n")}\n  }\n}\n`);
  renameSync(`${layoutPath}.tmp`, layoutPath);
}

export const config = {
  host: process.env.HOME_HOST ?? "127.0.0.1",
  port: Number(process.env.HOME_PORT ?? 8090),
  mqttUrl: process.env.MQTT_URL ?? "mqtt://127.0.0.1:1883",
  mqttUsername: process.env.MQTT_USERNAME ?? "",
  mqttPassword: process.env.MQTT_PASSWORD ?? "",
  /** Home Assistant discovery prefix. ESPHome publishes here; Zigbee2MQTT does too with `homeassistant: true`. */
  discoveryPrefix: process.env.DISCOVERY_PREFIX ?? "homeassistant",
  publicDir: path.join(root, "public"),
  /** home.db (alarm sessions and what the sensors did while armed) */
  dataDir: process.env.HOME_DATA_DIR ?? path.join(root, "data"),
};
