import type { FastifyBaseLogger } from "fastify";
import type { SensorEvent } from "../../shared/protocol.ts";
import { config } from "./config.ts";
import { onState, type DeviceState } from "./mqtt.ts";

/**
 * Home sensors neko listens to, through Zigbee2MQTT (mqtt.ts). neko only listens: it never changes a device.
 * When a sensor fires, ねこ looks up, says a short line about it and the page shows a banner (hub.sensorAlert).
 *
 * Each sensor is a Zigbee2MQTT device, named after where it is; the event is what neko calls the thing that happened.
 */
interface Sensor {
  event: SensorEvent;
  device: string; // Zigbee2MQTT friendly name: messages arrive on <base>/<device>
  label: string; // for the banner
  /** Read one message: true = it's happening, false = it's over, undefined = this message is about something else. */
  read: (s: DeviceState) => boolean | undefined;
  /**
   * "state" sensors (a door: open or closed) fire when they change to true.
   * "momentary" sensors (a knock on a window) fire on every true message, at most once per cooldown.
   */
  kind: "state" | "momentary";
  cooldownMs: number;
  ja: string;
  en: string;
}

/** What a vibration sensor reports as "something hit it" (Aqara-style sensors also send "tilt" and "drop"). */
const SHAKES = new Set(["vibration", "tilt", "drop"]);

const SENSORS: Sensor[] = [
  {
    event: "front_door_open",
    device: config.doorSensor,
    label: "Front door opened",
    // contact sensors report contact: true when closed, false when open
    read: (s) => (typeof s.contact === "boolean" ? !s.contact : undefined),
    kind: "state",
    cooldownMs: 10_000,
    ja: "あっ、げんかんのドアが開いたよ！",
    en: "Oh, the front door just opened!",
  },
  {
    event: "front_window_1_vibrate",
    device: config.windowSensor,
    label: "Front window 1 vibrated",
    read: (s) => {
      if (s.vibration === true || (typeof s.action === "string" && SHAKES.has(s.action))) return true;
      if (s.vibration === false) return false;
      return undefined;
    },
    kind: "momentary",
    cooldownMs: 60_000, // one knock sends several messages
    ja: "まどがゆれているよ！だいじょうぶかな？",
    en: "The window is shaking! Is everything okay?",
  },
];

export interface SensorAlert {
  event: SensorEvent;
  device: string;
  label: string;
  at: number;
  ja: string;
  en: string;
}

/** Start listening. `alert` is called once per event (after the cooldown and change rules above). */
export function startSensors(alert: (a: SensorAlert) => Promise<void>, log: FastifyBaseLogger) {
  for (const s of SENSORS) {
    let on: boolean | undefined; // last reading; unknown until the first message
    let lastFired = 0;
    onState(s.device, (_device, state, { retained }) => {
      const now = s.read(state);
      if (now === undefined) return;
      const was = on;
      on = now;
      // a retained message is an old state replayed on connect, not something that just happened
      if (!now || retained) return;
      if (s.kind === "state" && was === true) return; // still open: a repeat report (battery, link quality)
      const at = Date.now();
      if (at - lastFired < s.cooldownMs) return;
      lastFired = at;
      log.info(`sensor: ${s.event} (${s.device})`);
      alert({ event: s.event, device: s.device, label: s.label, at, ja: s.ja, en: s.en }).catch((err) =>
        log.warn(`sensor alert ${s.event} failed: ${(err as Error).message}`),
      );
    });
  }
  log.info(`listening to sensors: ${SENSORS.map((s) => `${s.device} (${s.event})`).join(", ")}`);
}
