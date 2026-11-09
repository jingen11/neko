/**
 * Weather from Open-Meteo (no key): place names through its geocoding search, forecasts by coordinates.
 */

const GEOCODE = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST = "https://api.open-meteo.com/v1/forecast";

export interface Place {
  name: string; // "Shibuya, Tokyo, Japan"
  latitude: number;
  longitude: number;
}

async function getJson(url: URL): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.error) throw new Error(`Open-Meteo: ${body?.reason ?? res.statusText}`);
  return body;
}

/**
 * A place by name in Latin script ("London", "Tokyo", "Shibuya, Tokyo, JP"); Open-Meteo finds no names
 * written in Japanese script. It searches the first part; the rest (region, country) picks between places
 * with the same name.
 */
export async function findPlace(query: string): Promise<Place | null> {
  const [name, ...hints] = query.split(/[,、，]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!name) return null;
  const url = new URL(GEOCODE);
  url.searchParams.set("name", name);
  url.searchParams.set("count", "10");
  url.searchParams.set("language", "en");
  const results: any[] = (await getJson(url)).results ?? [];
  if (!results.length) return null;
  // "Shibuya, Tokyo, JP": the Shibuya whose region or country fits the rest; else the best-known one (listed first)
  const fits = (r: any) =>
    hints.filter((h) => [r.admin1, r.admin2, r.country, r.country_code].some((f) => f && String(f).toLowerCase().includes(h))).length;
  const best = results.reduce((a, b) => (fits(b) > fits(a) ? b : a));
  return {
    name: [best.name, best.admin1, best.country].filter((s, i, all) => s && all.indexOf(s) === i).join(", "),
    latitude: best.latitude,
    longitude: best.longitude,
  };
}

/** WMO weather codes (Open-Meteo's weather_code) in plain English. */
const CONDITIONS: Record<number, string> = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "heavy freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "heavy freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "light showers", 81: "showers", 82: "violent showers", 85: "snow showers", 86: "heavy snow showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with heavy hail",
};
const condition = (code: number) => CONDITIONS[code] ?? `weather code ${code}`;

/** Current conditions and a daily forecast, as text for the model. Days are labelled in the place's own time. */
export async function weatherReport(place: Place, days: number): Promise<string> {
  const url = new URL(FORECAST);
  url.searchParams.set("latitude", String(place.latitude));
  url.searchParams.set("longitude", String(place.longitude));
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", String(days));
  url.searchParams.set("current", "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m");
  url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum");
  const w = await getJson(url);

  const c = w.current;
  const localNow = String(c.time).replace("T", " "); // the place's local time
  const lines = [
    `${place.name} (${place.latitude.toFixed(2)}, ${place.longitude.toFixed(2)}), time zone ${w.timezone}.`,
    `Now (${localNow} local): ${condition(c.weather_code)}, ${Math.round(c.temperature_2m)}°C ` +
      `(feels like ${Math.round(c.apparent_temperature)}°C), humidity ${c.relative_humidity_2m}%, ` +
      `wind ${Math.round(c.wind_speed_10m)} km/h${c.precipitation > 0 ? `, ${c.precipitation} mm precipitation` : ""}.`,
  ];

  const d = w.daily;
  const label = ["today", "tomorrow"];
  for (let i = 0; i < d.time.length; i++) {
    const date = new Date(`${d.time[i]}T12:00:00Z`);
    const weekday = date.toLocaleDateString("en", { weekday: "long", timeZone: "UTC" });
    const rain = d.precipitation_probability_max[i];
    lines.push(
      `${d.time[i]} (${weekday}${label[i] ? `, ${label[i]}` : ""}): ${condition(d.weather_code[i])}, ` +
        `${Math.round(d.temperature_2m_min[i])}–${Math.round(d.temperature_2m_max[i])}°C` +
        (rain != null ? `, ${rain}% chance of rain` : "") +
        (d.precipitation_sum[i] > 0 ? ` (${d.precipitation_sum[i]} mm)` : "") + ".",
    );
  }
  return lines.join("\n");
}
