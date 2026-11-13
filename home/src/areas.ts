import { readFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.ts";

/**
 * The rooms, doors and windows a device can be put in, read from the 3D model in public/app.js
 * (ROOMS, door(...), panes(...)) so the page stays the one place they are defined.
 */
export interface Area {
  id: string;
  name: string;
  floor: "g" | "u" | "out";
}

const src = readFileSync(path.join(config.publicDir, "app.js"), "utf8");
const FLOOR = /^(g|u|out)$/;

export const rooms: Area[] = [...src.matchAll(/\{id:'([\w-]+)',name:'([^']+)',lv:'(\w+)',p:/g)]
  .filter((m) => FLOOR.test(m[3]))
  .map((m) => ({ id: m[1], name: m[2], floor: m[3] as Area["floor"] }));

// a window of n panes is n openings: win-living-1, win-living-2, ... (one pane keeps the plain id)
const panesPer = Object.fromEntries(
  [...(src.match(/const PANES=\{([^}]*)\}/)?.[1] ?? "").matchAll(/(\w+):(\d+)/g)].map((m) => [m[1], Number(m[2])]),
);
export const openings: Area[] = [
  ...[...src.matchAll(/^door\('([\w-]+)','([^']+)','[\w-]+','(\w+)'/gm)].map((m) => ({ id: m[1], name: m[2], floor: m[3] as Area["floor"] })),
  ...[...src.matchAll(/^panes\('([\w-]+)','([^']+)','[\w-]+','(\w+)',[^\n]*'(\w+)'(?:,\d+)?\);/gm)].flatMap((m) => {
    const n = panesPer[m[4]] ?? 1;
    return Array.from({ length: n }, (_, i) => ({
      id: n > 1 ? `${m[1]}-${i + 1}` : m[1],
      name: n > 1 ? `${m[2]}, panel ${i + 1}` : m[2],
      floor: m[3] as Area["floor"],
    }));
  }),
];

const roomIds = new Set(rooms.map((r) => r.id));
const openingIds = new Set(openings.map((o) => o.id));
export const isRoom = (id: string) => roomIds.has(id);
export const isOpening = (id: string) => openingIds.has(id);
