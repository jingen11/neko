# neko board firmware

For the Waveshare ESP32-S3-Touch-LCD-1.83. Built with ESP-IDF v5.5.x and Waveshare's BSP (`waveshare/esp32_s3_touch_lcd_1_83` ^2.0.0, pulled in by the component manager).

Speaker, mics and screen all work; see [What it does](#what-it-does).

## Toolchain (once)

```bash
brew install cmake ninja dfu-util ccache
mkdir -p ~/esp && cd ~/esp
git clone -b v5.5.6 --depth 1 --recursive --shallow-submodules https://github.com/espressif/esp-idf.git esp-idf-v5.5.6
cd esp-idf-v5.5.6 && ./install.sh esp32s3
```

In each new shell: `. ~/esp/esp-idf-v5.5.6/export.sh`

## Build and flash

```bash
cd firmware
idf.py set-target esp32s3      # first time only
idf.py menuconfig              # neko → home Wi-Fi, away Wi-Fi (phone hotspot), box URL (ws://<box LAN IP>:8081/ws)
idf.py build
idf.py -p /dev/cu.usbmodem* flash monitor
```

Wi-Fi settings are saved in `sdkconfig`, which git ignores. If the board doesn't show up as `/dev/cu.usbmodem*`, use a data USB-C cable, or hold **BOOT** while plugging it in.

## Tailscale

The board joins your tailnet with [microlink](https://github.com/Csontikka/microlink) (vendored in `components/`, local changes in `components/microlink/UPSTREAM`) and reaches the box at its tailnet address, at home and away.

1. In the Tailscale admin, **Settings → Keys → Generate auth key**: reusable, pre-approved, not ephemeral (90 days at most; it only matters for joining).
2. `idf.py menuconfig` → neko: **Tailscale auth key**, **the box's tailnet IP** (`tailscale ip -4` on the box), and set **Box WebSocket URL** to `ws://<that IP>:8081/ws`. Empty key = Tailscale off and the board uses the URL as is.
3. Flash. It shows as `neko-board`; in **Machines**, **Disable key expiry** for it (and for the box).

Joining takes ~7.5 s after Wi-Fi; the WebSocket starts once it's up. The home relay region (**Tailscale home relay region**, default 3 = Singapore) is only used when a direct path can't be made. The board reports its public IP to the box (`net` message) for the IP location.

Memory: microlink needs ~1 MB of PSRAM and a good share of internal RAM. `sdkconfig.defaults` sends TLS and anything over 4 KB to PSRAM, and microlink's task stacks are in PSRAM; with them in internal RAM, a long voice reply over WireGuard used up the internal RAM and the screen hung.

## Pins (from the BSP)

| | |
|---|---|
| LCD ST7789P (SPI2) | SCLK 6, MOSI 7, CS 5, DC 4, RST 38, backlight 40 |
| I2C (touch CST816D, codecs, IMU, RTC, PMU) | SDA 15, SCL 14 |
| Touch | INT 13, RST 39 |
| I2S (ES8311 / ES7210) | MCLK 16, BCLK 9, WS 45, DOUT 8, DIN 10; speaker amp enable 46 |
| TF card (SDMMC 1-bit) | CLK 2, CMD 1, D0 3 |

## What it does

- **The cat:** the web app's GIFs (`web/public/pet/`) are embedded at build time and played with LVGL's GIF player at 2x (so it fits between the status rows and the text; `petted.gif` draws the cat 1.5x bigger, so it plays at 1.33x), anchored at the feet like `web/src/pet.ts`. Yawns now and then while `sleepy`.
- **Text:** ねこ's line in Japanese (DotGothic16, `assets/`, OFL, drawn by LVGL's TinyTTF) and its English below; stats at the top.
- **Voice:** the box sends each line at 16 kHz faster than it plays; the board buffers up to 30 s in PSRAM and plays it on the ES8311. A new line cuts off the old one. The mouth moves only while the voice sounds.
- **Push-to-talk:** hold the screen (a red dot shows), speak, let go. Both mics (ES7210) are mixed to mono and streamed between `listen_start` and `listen_end` (30 s max). The transcript (`heard`) is shown and sent back as `confirm` at once.
- **Check:** each `correction` shows as a card at the top: red with `wrong → right` and the grammar point for 12 s, or a green ◎ for 3 s.
- **Touch:** a tap pets the cat.
- **Status rows:** Wi-Fi signal (four bars) and battery (from the AXP2101, which is only read; its power rails are left alone) on the first row, the pet's health on the second. Everything keeps 16 px from the edges for the rounded corners.
- **Wi-Fi, home and away:** two networks in menuconfig. The board scans and joins home if it's in range, else the away network (your phone's hotspot); when it sees neither (a hotspot can hide its name), it tries each in turn. On the hotspot it checks for home every minute and moves back once home's signal is above −75 dBm. The hotspot's name shows next to the Wi-Fi bars. The box URL is the same on both, so away from home the board can't reach the box yet.
- **Power:** the CPU drops to 80 MHz when idle. On battery, the screen dims after 30 s without use and the board deep-sleeps after 60 s (Wi-Fi, screen, speaker amp and codecs off); a touch wakes it, and it reconnects. On USB it never sleeps. While it sleeps the Mac can't see it: touch it before flashing.

In `idf.py menuconfig` → neko: home and away Wi-Fi, box URL, speaker volume (default 70), dim after (30 s) and sleep after (60 s). menuconfig needs a full terminal window; it doesn't open inside Claude Code.
