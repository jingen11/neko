import { config } from "./config.ts";
import { isCamera, snapshotFor } from "./frigate.ts";

/**
 * Push notifications through ntfy (NTFY_URL, e.g. http://127.0.0.1:2586/home; off while empty).
 * Only alarms are sent: the alarm module calls this for something turning on, or a board going
 * offline, while armed. The wording matches the dashboard's Alarm tab.
 * A camera's alarm (frigate.ts) carries its snapshot of the person as an image attachment.
 */

const OCC = ["occupancy", "presence", "motion"];
/** one notification per device and kind of alarm in this window, so a flickering presence sensor doesn't spam */
const COOLDOWN = 60_000;
const lastSent = new Map<string, number>();

export interface AlarmNotice {
  kind: "entity" | "availability";
  device: string;
  /** the device's label from layout.json, else its name */
  label: string;
  deviceClass: string | null;
  /** the entity's name, for alarms that aren't a door, window, vibration or someone */
  name: string | null;
  /** an opening id like "door-front" / "win-living-1", for contact and vibration sensors */
  opening: string | null;
  at: number;
}

function describe(n: AlarmNotice): { title: string; tags: string; priority: number } {
  const dc = n.deviceClass ?? "";
  if (n.kind === "availability") return { title: "Sensor went offline", tags: "electric_plug", priority: 4 };
  if (OCC.includes(dc)) return { title: "Someone detected", tags: "walking", priority: 5 };
  if (dc === "vibration") return { title: "Vibration", tags: "warning", priority: 5 };
  if (dc === "door" || dc === "garage_door" || n.opening?.startsWith("door-")) return { title: "Door opened", tags: "door", priority: 5 };
  if (dc === "window" || dc === "opening" || n.opening) return { title: "Window opened", tags: "window", priority: 5 };
  return { title: `${n.name ?? "Sensor"} on`, tags: "rotating_light", priority: 4 };
}

export function notifyAlarm(n: AlarmNotice) {
  if (!config.ntfyUrl) return;
  const { title, tags, priority } = describe(n);
  const key = `${n.device}|${title}`;
  if (n.at - (lastSent.get(key) ?? 0) < COOLDOWN) return;
  lastSent.set(key, n.at);

  const time = new Date(n.at).toTimeString().slice(0, 5);
  const message = `${n.label} at ${time}`;
  const headers: Record<string, string> = { Title: `Alarm: ${title}`, Tags: tags, Priority: String(priority), Click: config.dashboardUrl };
  const image = n.kind === "entity" && isCamera(n.device) ? snapshotFor(n.device, n.at) : Promise.resolve(null);
  image
    .then((jpeg) =>
      fetch(config.ntfyUrl, {
        method: "POST",
        // with an image, the body is the image and the message goes in a header, RFC 2047-encoded so a label can be any text
        headers: jpeg ? { ...headers, Filename: `${n.device}.jpg`, Message: `=?UTF-8?B?${Buffer.from(message).toString("base64")}?=` } : headers,
        body: jpeg ? new Uint8Array(jpeg) : message,
        signal: AbortSignal.timeout(10_000),
      }),
    )
    .then((res) => {
      if (!res.ok) console.error(`ntfy: ${res.status} ${res.statusText}`);
    })
    .catch((err) => console.error(`ntfy: ${err.message}`));
}
