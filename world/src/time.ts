import tzlookup from "@photostructure/tz-lookup";

/**
 * Local time anywhere, already written out in Japanese (午前7時23分) so the model doesn't have to turn
 * 24-hour time into 午前/午後 itself (the local model got that wrong: 07:23 became 午後7時).
 */

/** The IANA zone at some coordinates, offline (tz-lookup's coarse map). "" for invalid coordinates. */
export function zoneAt(latitude: number, longitude: number): string {
  try {
    return tzlookup(latitude, longitude);
  } catch {
    return "";
  }
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** "午前7時23分" (midnight is 午前0時, noon 午後0時; on the hour, no 分). */
export function japaneseClock(hour: number, minute: number): string {
  const half = hour < 12 ? "午前" : "午後";
  return `${half}${hour % 12}時${minute ? `${minute}分` : ""}`;
}

/** The time now in a zone, as text for the model. `where` says whose time it is. */
export function timeReport(zone: string, where: string, now = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone, year: "numeric", month: "numeric", day: "numeric",
      weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23",
    }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  const hour = Number(parts.hour), minute = Number(parts.minute);
  const weekday = WEEKDAYS[new Date(`${parts.year}-${parts.month.padStart(2, "0")}-${parts.day.padStart(2, "0")}T12:00:00Z`).getUTCDay()];
  const hhmm = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const part = hour < 5 ? "night" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  return (
    `It is ${japaneseClock(hour, minute)} (${hhmm}, ${part}) on ${parts.year}年${parts.month}月${parts.day}日 (${weekday}曜日) ` +
    `${where} (${zone}). Say the time as written: ${japaneseClock(hour, minute)}.`
  );
}
