# Home dashboard

The house at a glance on https://dash.home.je-dev.com: a 3D twin of the house (Three.js, `public/app.js`) with each room lit where someone is, how far from the sensor, and which boards are online. A Fastify server on `:8090` reads the MQTT broker; Caddy serves it over HTTPS on the tailnet.

## What it reads

Nothing is hard-coded per sensor. The server subscribes to Home Assistant MQTT discovery (`homeassistant/#`), which ESPHome publishes for every sensor, and builds the device list from that. Zigbee2MQTT devices show up the same way once its `homeassistant` option is on. Shown for now: `sensor` and `binary_sensor` entities.

- Online / offline comes from each entity's availability topic (`<board>/status`). An offline board's last reading is never counted as someone being there.
- `esphome/discover/<board>` gives each board's IP.
- Sensor values aren't stored, except in the alarm log (below). The server keeps the latest value of each entity in memory and streams changes to the page. After a restart it starts from the broker's retained messages (the last state each board published), shown without a "changed … ago" time since that isn't known.

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

## Alarm

`data/home.db` (SQLite, `HOME_DATA_DIR` to move it) holds the alarm. It arms itself from a schedule, in the box's local time:

- **Armed periods**: daily windows such as `23:00`–`07:00`. An end before the start runs past midnight.
- **Away days**: date ranges, inclusive. The alarm stays armed all day.

Arming or disarming by hand overrides the schedule until the schedule itself next changes. For example, disarming at 23:30 inside a 23:00–07:00 period holds until 07:00. `DELETE /api/alarm/override` goes back to the schedule straight away.

Each armed stretch is a session (`alarm_sessions`). While one is open, every live sensor change and every board going online or offline is written to `alarm_events`, with the device's room or opening. Retained values replayed on reconnect aren't logged.

```bash
curl -X PUT  localhost:8090/api/alarm/periods -H 'content-type: application/json' -d '[{"start":"23:00","end":"07:00"}]'
curl -X POST localhost:8090/api/alarm/away    -H 'content-type: application/json' -d '{"from":"2026-12-20","to":"2026-12-27","note":"trip"}'
curl -X POST localhost:8090/api/alarm         -H 'content-type: application/json' -d '{"armed":true}'
```

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
| `GET /api/events` | server-sent events: a `snapshot` (with `alarm`), then each `device` / `entity` / `broker` / `alarm` change |
| `GET /api/alarm` | armed or not, why (`schedule` / `away` / `manual`), any override, the open session, periods and away days |
| `POST /api/alarm` | `{"armed": bool}`: manual arm or disarm |
| `DELETE /api/alarm/override` | follow the schedule again |
| `GET`/`PUT /api/alarm/periods` | daily armed periods, replaced as a whole |
| `GET`/`POST /api/alarm/away`, `DELETE /api/alarm/away/:id` | away days |
| `GET /api/alarm/sessions?limit=` | past armed sessions, newest first |
| `GET /api/alarm/sessions/:id/events` | what the sensors did during one session |
| `GET /health` | `{"status":"ok","mqtt":true}` |
