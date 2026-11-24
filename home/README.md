# Home dashboard

The house at a glance on https://dash.home.je-dev.com: a 3D twin of the house (Three.js, `public/app.js`) with each room lit where someone is, how far from the sensor, and which boards are online. A Fastify server on `:8090` reads the MQTT broker; Caddy serves it over HTTPS on the tailnet.

## What it reads

Nothing is hard-coded per sensor. The server subscribes to Home Assistant MQTT discovery (`homeassistant/#`), which ESPHome publishes for every sensor, and builds the device list from that. Zigbee2MQTT devices show up the same way once its `homeassistant` option is on. Shown: `sensor` and `binary_sensor` entities, `switch` entities (a wall switch's rockers, a plug's relay) that can be turned on and off, and `fan` entities (the fan remote board, `sensors/rf-remote.yaml`), which also have a speed. A switch's settings (`entity_category: config`, such as an Aqara rocker's *lock relay*) and Zigbee2MQTT's *permit join* are left out.

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
| Ground | `door-front`, `door-living-1..2` (sliding, one per panel), `door-kitchen` (side) | `win-living-1..3`, `win-dining-1..3`, `win-work-1..2`, `win-kitchen-1..3` |
| Upper | `door-upper-living-1..2` (sliding, one per panel), `door-bed1`, `door-bed2` (to the corridor) | `win-master-front-1..3`, `win-master-side-1..2`, `win-bed1-1..2`, `win-bed2-1..2` |

Panels count from the lower x (west) or lower z (front) end of the window. Each opening has a small sensor mark on its head: grey with no sensor, green closed, orange open (the whole opening is tinted then too, and gets a bubble).

## Lights and fans

Each switch can be given the appliance it drives, a `light` or a `fan`, with an optional name and its own `room` when it isn't in the switch's (a lobby light wired to the living room's switch). Set it on the **Devices** tab (**Edit label, place or appliances**), or in `layout.json` under `loads`, keyed by the switch's object id (the end of its entity id: `switch_top`, `switch_center`, `switch_bottom` on an Aqara Z1 triple rocker, `switch` on a plug):

```json
"g_floor_living_gang_1": { "label": "Living room switch", "room": "living",
  "loads": { "switch_top": { "kind": "light", "label": "Lobby light", "room": "lobby" }, "switch_center": { "kind": "fan" } } }
```

Assigned appliances are listed under **Lights and fans** on the overview and in their room's card, each with an on/off button. A button shows the new state only once the switch reports it. Switches and fans never count toward the alarm.

A `fan` entity is assigned the same way (its object id, e.g. `living_room_fan` on `rf-remote`, with its own room) and gets a button per speed under its row; a speed turns it on. Its state is what the board last sent or heard from the real remote, so the row says "as last sent". In the 3D house its ceiling fan spins faster at a higher speed.

```json
"rf-remote": { "label": "Fan remote", "room": "living",
  "loads": { "living_room_fan": { "kind": "fan", "label": "Living room fan" }, "dining_room_fan": { "kind": "fan", "label": "Dining room fan", "room": "dining" },
             "master_bedroom_fan": { "kind": "fan", "label": "Master bedroom fan", "room": "master" }, "upper_living_fan": { "kind": "fan", "label": "Upper living fan", "room": "uliving" } } }
```

In the 3D house, a room with a light gets a ceiling lamp that's lit while the light is on; a room with a fan gets a ceiling fan that spins while it runs (still, with an orange ring under the hub, under reduced motion). A room with a presence sensor and no light assigned keeps its lamp for presence; with a light assigned, presence shows only as the warm floor.

A room glows warm while any online presence sensor in it reads occupied; an offline board's last reading is never counted. A device that isn't placed (or names a room that doesn't exist) is listed under **Not placed** in the side panel. Restart after editing.

## Alarm

`data/home.db` (SQLite, `HOME_DATA_DIR` to move it) holds the alarm. It arms itself from a schedule, in the box's local time:

- **Armed periods**: windows such as `23:00`–`07:00` on chosen days of the week, for example weekdays 23:00–07:00 and weekends 01:00–09:00. A period with no days runs every day. An end before the start runs past midnight, and the period belongs to the day it starts on: a Friday 23:00–07:00 runs until 07:00 on Saturday.
- **Away days**: date ranges, inclusive. The alarm stays armed all day.

Arming or disarming by hand overrides the schedule until the schedule itself next changes. For example, disarming at 23:30 inside a 23:00–07:00 period holds until 07:00. `DELETE /api/alarm/override` goes back to the schedule straight away.

On the dashboard, the **Alarm** tab shows the state, arm/disarm, and the alarms: someone detected, a door or window opening, or a board going offline while armed, newest first by day. The **Settings** tab holds the periods, drawn as a week, and the away days.

Each armed stretch is a session (`alarm_sessions`). While one is open, every live sensor change and every board going online or offline is written to `alarm_events`, with the device's room or opening. Retained values replayed on reconnect aren't logged.

On a presence board with an `Intruder` sensor (PIR and mmWave agreeing, see `sensors/`), only `Intruder` turning on is an alarm; its `Occupied` and `PIR` are still logged, since either alone is easily fooled by a fan, a curtain or heat. Each event is flagged as an alarm or not when it is written (`alarm_events.alarm`); events from before the flag keep the old rule.

Each alarm is also sent as a push notification when `NTFY_URL` is set (e.g. `http://127.0.0.1:2586/home`, the ntfy server on the box at https://ntfy.home.je-dev.com; Caddy block in `deploy/caddy/ntfy.caddy`). Only while armed, and only alarms: someone detected, a door or window opening, a vibration, a diagnostic warning turning on, or a board going offline. One notification per device and kind a minute, so a presence sensor flickering doesn't spam; tapping it opens the dashboard.

The first alarm of an armed stretch also starts the siren, and it sounds until the alarm is disarmed. A low battery, a tamper switch or another diagnostic warning only sends a notification. A siren is any Zigbee2MQTT device with a `siren_on` switch (the SONOFF SNZB-09P, `Alarm`), and it sounds whether or not `NTFY_URL` is set. The siren stops by itself after its `alarm_duration`, so while the alarm is ringing the app sends "on" again every 4 minutes, or within 15 s if the siren reports it has stopped. This carries on across an app restart. Keep `alarm_duration` at its maximum, 900 s, in Zigbee2MQTT: that keeps the 4-minute resend well inside it, and if the app dies mid-alarm the siren still stops within 15 minutes. Volume and tone are the siren's own settings (`alarm_volume_level`, `alarm_sound_type`).

Frigate's cameras (`~/frigate`, Docker) are presence sensors too. `src/frigate.ts` reads Frigate's MQTT topics: a camera's retained `frigate/<camera>/enabled/state` tells it apart from a zone, and `frigate/<camera>/person` gives how many people it sees. For each camera it publishes a `binary_sensor` discovery config ("Person", occupancy) and an ON/OFF state on `home/frigate/<camera>/person`, so the camera is an ordinary device: on the Devices tab, in the alarm log, and while armed a person seen is an alarm, with a notification and the siren. Its availability is Frigate's own (`frigate/available`). The notification has the camera's person snapshot (`frigate/<camera>/person/snapshot`) attached, which needs ntfy's `attachment-cache-dir` set. Video is viewed in Frigate's own web app (https://frigate.home.je-dev.com, through Caddy, Tailscale only).

```bash
curl -X PUT  localhost:8090/api/alarm/periods -H 'content-type: application/json' -d '[{"start":"23:00","end":"07:00","days":["mon","tue","wed","thu","fri"]},{"start":"01:00","end":"09:00","days":["sat","sun"]}]'
curl -X POST localhost:8090/api/alarm/away    -H 'content-type: application/json' -d '{"from":"2026-12-20","to":"2026-12-27","note":"trip"}'
curl -X POST localhost:8090/api/alarm         -H 'content-type: application/json' -d '{"armed":true}'
curl -X PATCH localhost:8090/api/devices/ground_floor_smart_plug -H 'content-type: application/json' -d '{"label":"Lobby plug","room":"lobby"}'
curl -X POST  localhost:8090/api/switches/0x54ef44100196dcde/switch_top -H 'content-type: application/json' -d '{"on":true}'
curl -X POST  localhost:8090/api/switches/rf-remote/living_room_fan -H 'content-type: application/json' -d '{"speed":3}'
```

## ねこ's house tools (MCP)

`POST /mcp` is an MCP server (Streamable HTTP, stateless) so ねこ can work the lights and fans by voice, through the Hermes `neko` profile. It lives here, not in `server/`, because neko-home already holds the MQTT connection and knows what each switch drives.

| Tool | What it does |
|---|---|
| `list_appliances()` | every light and fan: name, kind, room and floor, on/off (and a fan's speed), online or offline |
| `set_appliance(on?, speed?, id?, room?, kind?, name?)` | switches every appliance matching all the filters given (at least one): `room: "living", kind: "light"` is every light in the living area; `name` matches part of the name. `speed` sets a fan's speed (and turns it on); only fans with speeds are picked then. Says what was switched and what wasn't (an offline switch, a speed it doesn't have) |

Only switches given an appliance on the **Devices** tab are listed; a plug with nothing assigned isn't. There's no key: the dashboard, and so `/mcp`, is only reachable on the tailnet.

In `~/.hermes/profiles/neko/config.yaml` on the Hermes box, next to `neko_world`:

```yaml
  neko_home:
    url: https://dash.home.je-dev.com/mcp
    enabled: true
```

then restart the Hermes gateway, and check it with `hermes mcp test neko_home`. Keep the name unique: the gateway shares MCP servers by name across profiles.

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
| `GET /api/events` | server-sent events: a `snapshot` (with `alarm`), then each `device` / `device-removed` / `entity` / `broker` / `alarm` change |
| `GET /api/devices` | devices with their label, room or opening, and Zigbee IEEE address (`zigbee`, null for ESPHome) |
| `GET /api/areas` | the room and opening ids a device can be put in, read from the 3D model in `public/app.js` |
| `PATCH /api/devices/:id` | any of `label`, `room`, `opening` (`null` takes it out; a room clears the opening and back), `loads` (`{"switch_top": {"kind": "light", "label": "…"}, "switch_center": null}`: `null` forgets one, switches left out keep theirs). Saved to `layout.json`, live straight away. Rename a device in Zigbee2MQTT or ESPHome, not here |
| `POST /api/switches/:node/:object` | `{"on": bool}`: turn a switch (an entity with `command: true`) on or off. `202` once sent; the new state follows on `/api/events`. `409` while the switch or broker is offline |
| `GET /api/alarm` | armed or not, why (`schedule` / `away` / `manual`), any override, the open session, periods and away days |
| `POST /api/alarm` | `{"armed": bool}`: manual arm or disarm |
| `DELETE /api/alarm/override` | follow the schedule again |
| `GET`/`PUT /api/alarm/periods` | armed periods, replaced as a whole: `start`, `end` and `days` (`"mon"` … `"sun"`; left out = every day) |
| `GET`/`POST /api/alarm/away`, `DELETE /api/alarm/away/:id` | away days |
| `GET /api/alarm/alarms?limit=&beforeAt=&beforeId=&since=` | alarms across every armed stretch, newest first (`since` also counts those after that time) |
| `GET /api/alarm/sessions?limit=` | past armed sessions, newest first |
| `GET /api/alarm/sessions/:id/events` | what the sensors did during one session |
| `POST /mcp` | MCP server for ねこ's house tools (see above) |
| `GET /health` | `{"status":"ok","mqtt":true}` |
