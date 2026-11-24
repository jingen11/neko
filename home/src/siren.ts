import { command, snapshot } from "./broker.ts";

/**
 * The siren(s). Once anything counts as an alarm while armed (someone detected, a door or window opened,
 * a vibration, a board going offline), the siren sounds until the alarm is disarmed.
 *
 * A siren only sounds for its own alarm_duration (the SONOFF SNZB-09P tops out at 900 s), so while the
 * alarm module says it's ringing it calls keepSounding() every few seconds, and the siren is sent "on" again
 * well before that runs out, or straight away if it reports it has stopped. Keep alarm_duration at 900 in
 * Zigbee2MQTT: then if this app dies mid-alarm the siren still stops by itself within 15 minutes.
 *
 * A siren is any Zigbee2MQTT device with a `siren_on` switch. Volume and tone are its own settings.
 */

/** re-send "on" this often while ringing: well inside the siren's 900 s alarm_duration */
const RESEND_EVERY = 240_000;
/** never faster than this, whatever the siren reports: a burst of alarms or a lagging state report */
const MIN_GAP = 5_000;
/**
 * The SNZB-09P reports on, off, on within a second or two of being switched on, not always in that order.
 * An "off" this soon after sending "on" is part of that, not the siren stopping.
 */
const SETTLE = 5_000;

/** when "on" was last sent; 0 when silenced */
let lastSent = 0;
/** the last failure logged per siren, so an offline one doesn't log every few seconds */
const lastError = new Map<string, string>();

const sirens = () => snapshot().entities.filter((e) => e.command && e.id.endsWith("/switch_siren_on"));

function send(on: boolean) {
  for (const s of sirens()) {
    command(s.id, on)
      .then((r) => {
        const msg = r === "ok" ? "" : `${on ? "on" : "off"} not sent (${r})`;
        if (msg && lastError.get(s.id) !== msg) console.error(`siren ${s.id}: ${msg}`);
        lastError.set(s.id, msg);
      })
      .catch((err) => console.error(`siren ${s.id}: ${err.message}`));
  }
}

/** Sound the siren, or keep it sounding: called on each alarm and every few seconds while the alarm is ringing. */
export function keepSounding() {
  const since = Date.now() - lastSent;
  if (since < MIN_GAP) return;
  const list = sirens();
  // none yet: just after a restart, before discovery has found it. Try again on the next call.
  if (!list.length) return;
  // stopped: it ran out its alarm_duration, or someone switched it off in Zigbee2MQTT
  const stopped = list.some((s) => s.value === false && (s.at ?? 0) > lastSent + SETTLE);
  if (lastSent && since < RESEND_EVERY && !stopped) return;
  lastSent = Date.now();
  send(true);
}

/** On disarming: stop the siren. */
export function silence() {
  const sounding = lastSent > 0 || sirens().some((s) => s.value === true);
  lastSent = 0;
  if (sounding) send(false);
}
