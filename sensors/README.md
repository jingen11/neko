# Presence sensors

ESPHome configs for the presence units (ESP32-C6 + HMMD mmWave + AM312 PIR). Each unit joins the home Wi-Fi and publishes to the box's Mosquitto.

| Board | Config | MQTT user / topic prefix |
|---|---|---|
| Ground floor | `presence-gf.yaml` | `presence-gf` |
| First floor | `presence-1f.yaml` | `presence-1f` |

Everything shared lives in `presence-base.yaml`; each board file only sets its `name` and its IP secret. Change the base and reflash every board.

## Wiring

| HMMD mmWave | C6 board |
|---|---|
| 3.3V | 3.3V |
| GND | GND |
| RX | TX (GPIO16) |
| TX | RX (GPIO17) |

The sensor streams `ON`/`OFF` and `Range <cm>` lines at 115200 baud, about 10 a second. If a board reads nothing, check the wires first: both faults so far were broken jumper wires.

## Range cap

The sensor itself can see 5 m or more, including through thin walls. `presence-base.yaml` drops anything beyond `max_range_cm` (default `300`) in firmware. To change it for one board, add it to that board file's `substitutions:`:

```yaml
substitutions:
  name: presence-gf
  max_range_cm: "400"
```

The sensor's own max-gate setting isn't used: the vendor wiki documents reading it but not the write command.

## MQTT topics

| Topic | Payload | Retained |
|---|---|---|
| `<board>/status` | `online` / `offline` (offline about a minute after the board loses power) | yes |
| `<board>/binary_sensor/occupied/state` | `ON` / `OFF`, on change. Only counts people within `max_range_cm` (default 300); goes `OFF` after 5 s with nobody that close | yes |
| `<board>/sensor/distance/state` | cm to the detected person; median-filtered, at most once a second, only on a change of 15 cm or more; only updates while someone is within range | yes |
| `<board>/debug` | ESPHome log lines | no |

## Setup

```bash
pip install esphome
cp secrets.example.yaml secrets.yaml   # fill in Wi-Fi, OTA, broker IP, MQTT password, board IPs
esphome run presence-gf.yaml           # first flash over USB; later ones go over Wi-Fi to the board's IP
```

## Adding a board

1. Copy a board file, change `name` and the IP secret name.
2. Add a Mosquitto user with the same name (same password as `mqtt_pw`).
3. Flash over USB, then reserve its IP in DHCP and put it in `secrets.yaml`.

## Check

```bash
mosquitto_sub -h <box LAN IP> -u presence-gf -P <pw> -t 'presence-gf/#' -t 'presence-1f/#' -v
esphome logs presence-gf.yaml --device MQTT   # live log, no mosquitto_sub needed
```
