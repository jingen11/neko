import tzlookup from "@photostructure/tz-lookup";

/**
 * Local time anywhere, as plain data: an ISO 8601 date and 24-hour time with its UTC offset, the weekday
 * and the IANA zone. No language or regional formatting: the model words it however the conversation needs.
 */

/** The IANA zone at some coordinates, offline (tz-lookup's coarse map). "" for invalid coordinates. */
export function zoneAt(latitude: number, longitude: number): string {
  try {
    return tzlookup(latitude, longitude);
  } catch {
    return "";
  }
}

/** The time now in a zone, as text for the model. `where` says whose time it is. */
export function timeReport(zone: string, where: string, now = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "long",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "longOffset",
    }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  const offset = parts.timeZoneName === "GMT" ? "+00:00" : parts.timeZoneName.replace("GMT", ""); // "GMT+08:00" → "+08:00"
  const iso = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}${offset}`;
  return `${iso} (${parts.weekday}, 24-hour clock) ${where}. Time zone: ${zone} (UTC${offset}).`;
}
