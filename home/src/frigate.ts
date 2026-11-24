import { randomUUID } from "node:crypto";
import mqtt from "mqtt";
import { config } from "./config.ts";

/**
 * Frigate's cameras as presence sensors. Frigate (~/frigate, Docker) detects people and publishes over MQTT,
 * but not as Home Assistant discovery, which is how this app finds devices. So this bridge does it:
 *
 *   frigate/<camera>/enabled/state   retained, one per camera: tells cameras apart from zones (frigate/<zone>/person)
 *   frigate/<camera>/person          how many people it sees now (not retained)
 *   frigate/<camera>/person/snapshot a JPEG of the best shot of the latest person (retained)
 *   frigate/available                online/offline: Frigate itself
 *
 * For each camera it publishes (retained) a binary_sensor discovery config, "Person" with device class occupancy,
 * and its state on home/frigate/<camera>/person, ON while anyone is in view. From there the camera is a device
 * like any other: on the Devices tab, in the alarm log, and while armed someone seen is an alarm
 * (notification plus siren). The notification carries the snapshot (see notify.ts).
 *
 * The device is named after the camera (e.g. living_room_main); its label and room are set on the Devices tab.
 */

const STATE = (cam: string) => `home/frigate/${cam}/person`;
const cameras = new Set<string>();
const people = new Map<string, boolean>();
/** the latest person snapshot per camera, and when it arrived (0: retained, from before we connected) */
const snapshots = new Map<string, { jpeg: Buffer; at: number }>();

export function startFrigate(log: { info: (m: string) => void; warn: (m: string) => void }) {
  const client = mqtt.connect(config.mqttUrl, {
    username: config.mqttUsername || undefined,
    password: config.mqttPassword || undefined,
    clientId: `home-frigate-${randomUUID().slice(0, 8)}`,
    reconnectPeriod: 5000,
  });
  client.on("connect", () => client.subscribe(["frigate/+/enabled/state", "frigate/+/person", "frigate/+/person/snapshot"]));
  client.on("error", (err) => log.warn(`frigate mqtt: ${err.message}`));
  client.on("message", (topic, payload, packet) => {
    const [, cam, kind, sub] = topic.split("/");
    if (kind === "enabled" && sub === "state") {
      if (cameras.has(cam)) return;
      cameras.add(cam);
      log.info(`frigate camera ${cam}`);
      client.publish(
        `${config.discoveryPrefix}/binary_sensor/${cam}/person/config`,
        JSON.stringify({
          name: "Person",
          device_class: "occupancy",
          state_topic: STATE(cam),
          availability_topic: "frigate/available",
          device: { name: cam, identifiers: [`frigate_${cam}`], manufacturer: "Frigate", model: "Camera" },
        }),
        { retain: true },
      );
    } else if (kind === "person" && sub === undefined) {
      if (!cameras.has(cam)) return; // a zone, not a camera
      const on = Number(payload.toString()) > 0;
      if (people.get(cam) === on) return;
      people.set(cam, on);
      client.publish(STATE(cam), on ? "ON" : "OFF", { retain: true });
    } else if (kind === "person" && sub === "snapshot") {
      snapshots.set(cam, { jpeg: Buffer.from(payload), at: packet.retain ? 0 : Date.now() });
    }
  });
}

export const isCamera = (device: string) => cameras.has(device);

/**
 * The person snapshot for an alarm at `at`: Frigate publishes it around the same moment as the count,
 * sometimes just after, so wait up to a few seconds for one from then. Null if none comes.
 */
export async function snapshotFor(cam: string, at: number, waitMs = 4000): Promise<Buffer | null> {
  const fresh = () => {
    const s = snapshots.get(cam);
    return s && s.at >= at - 3000 ? s.jpeg : null;
  };
  for (let waited = 0; waited < waitMs; waited += 250) {
    const s = fresh();
    if (s) return s;
    await new Promise((r) => setTimeout(r, 250));
  }
  return fresh();
}
