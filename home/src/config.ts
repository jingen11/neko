import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

/** Where each device is in the house. Keyed by the device name in its discovery message (ESPHome `name`, Z2M friendly name). */
export interface Placement {
  label: string;
  /** presence boards: a room id of the 3D house (ROOMS in public/app.js), e.g. "living" */
  room?: string;
  /** door and window sensors: an opening id (OPENINGS in public/app.js), e.g. "door-front", "win-kitchen-2" */
  opening?: string;
}
interface Layout {
  devices: Record<string, Placement>;
}

export const layout: Layout = JSON.parse(readFileSync(path.join(root, "layout.json"), "utf8"));

export const config = {
  host: process.env.HOME_HOST ?? "127.0.0.1",
  port: Number(process.env.HOME_PORT ?? 8090),
  mqttUrl: process.env.MQTT_URL ?? "mqtt://127.0.0.1:1883",
  mqttUsername: process.env.MQTT_USERNAME ?? "",
  mqttPassword: process.env.MQTT_PASSWORD ?? "",
  /** Home Assistant discovery prefix. ESPHome publishes here; Zigbee2MQTT does too with `homeassistant: true`. */
  discoveryPrefix: process.env.DISCOVERY_PREFIX ?? "homeassistant",
  publicDir: path.join(root, "public"),
};
