# Home dashboard

The house at a glance on https://dash.home.je-dev.com: a 3D twin of the house (Three.js, `public/app.js`) with each room lit where someone is, how far from the sensor, and which boards are online. A Fastify server on `:8090` reads the MQTT broker; Caddy serves it over HTTPS on the tailnet.

## What it reads

Nothing is hard-coded per sensor. The server subscribes to Home Assistant MQTT discovery (`homeassistant/#`), which ESPHome publishes for every sensor, and builds the device list from that. Zigbee2MQTT devices show up the same way once its `homeassistant` option is on. Shown for now: `sensor` and `binary_sensor` entities.

- Online / offline comes from each entity's availability topic (`<board>/status`). An offline board's last reading is never counted as someone being there.
- `esphome/discover/<board>` gives each board's IP.
- Nothing is stored. The server keeps only the latest value of each entity in memory and streams changes to the page. After a restart it starts from the broker's retained messages (the last state each board published), shown without a "changed … ago" time since that isn't known.

## Placing devices

`layout.json` puts each device in a room of the 3D house, by its discovery name:

```json
{
  "devices": { "presence-gf": { "label": "Ground floor sensor", "room": "living" } }
}
```

Room ids (`ROOMS` in `public/app.js`):

| Floor | Rooms |
|---|---|
| Ground | `lobby`, `living`, `stairs`, `work`, `dining`, `kitchen`, `wc-g` |
| Upper | `master`, `wc-m`, `uliving`, `wc-u`, `bed2`, `bed1`, `corridor` |
| Outside | `porch`, `garden`, `yard` |

Door and window sensors (Zigbee contact or vibration sensors, once Zigbee2MQTT runs with `homeassistant: true`) go on an **opening** instead of a room, by the Zigbee2MQTT friendly name:

```json
"front-door": { "label": "Front door", "opening": "door-front" }
```

| Floor | Doors | Window panels |
|---|---|---|
| Ground | `door-front`, `door-living` (sliding), `door-kitchen` (side) | `win-living-1..3`, `win-dining-1..3`, `win-work-1..2`, `win-wc-g`, `win-kitchen-1..3` |
| Upper | `door-upper-living` (sliding), `door-bed1`, `door-bed2` (to the corridor) | `win-wc-m`, `win-master-front-1..3`, `win-master-side-1..2`, `win-bed1-1..2`, `win-bed2-1..2` |

Panels count from the lower x (west) or lower z (front) end of the window. Each opening has a small sensor mark on its head: grey with no sensor, green closed, orange open (the whole opening is tinted then too, and gets a bubble).

A room glows warm while any online presence sensor in it reads occupied; an offline board's last reading is never counted. A device that isn't placed (or names a room that doesn't exist) is listed under **Not placed** in the side panel. Restart after editing.

## Run

```bash
cp .env.example .env         # MQTT user and password
npm install
npm run dev                  # http://127.0.0.1:8090
```

As a service: `neko-home` (`deploy/systemd/neko-home.service`, installed by `sudo ./deploy/install-services.sh`).

## Caddy

`deploy/caddy/home.caddy` goes inside the existing `*.home.je-dev.com` block in `/etc/caddy/Caddyfile`, above the final `handle { abort }`; then `sudo systemctl reload caddy`. The wildcard DNS record and certificate already cover `dash.home.je-dev.com`.

Live updates are server-sent events on `/api/events`; `flush_interval -1` sends each one through as it happens.

## API

| Path | What |
|---|---|
| `GET /api/state` | floors, devices, entities with their current values |
| `GET /api/events` | server-sent events: a `snapshot`, then each `device` / `entity` / `broker` change |
| `GET /health` | `{"status":"ok","mqtt":true}` |
