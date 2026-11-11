# Presence sensors

ESPHome configs for the presence units (ESP32-C6 + HMMD mmWave + AM312 PIR). Each unit joins the home Wi-Fi and publishes to the box's Mosquitto.

| Board | Config | MQTT user / topic prefix |
|---|---|---|
| Ground floor | `presence-gf.yaml` | `presence-gf` |
| First floor | `presence-1f.yaml` | `presence-1f` |

Everything shared lives in `presence-base.yaml`; each board file only sets its `name` and its IP secret. Change the base and reflash every board.

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
mosquitto_sub -h <box LAN IP> -u presence-gf -P <pw> -t 'presence-+/#' -v
```
