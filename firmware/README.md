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
idf.py menuconfig              # neko → Wi-Fi SSID, password, box URL (ws://<box LAN IP>:8081/ws)
idf.py build
idf.py -p /dev/cu.usbmodem* flash monitor
```

Wi-Fi settings are saved in `sdkconfig`, which git ignores. If the board doesn't show up as `/dev/cu.usbmodem*`, use a data USB-C cable, or hold **BOOT** while plugging it in.

## Pins (from the BSP)

| | |
|---|---|
| LCD ST7789P (SPI2) | SCLK 6, MOSI 7, CS 5, DC 4, RST 38, backlight 40 |
| I2C (touch CST816D, codecs, IMU, RTC, PMU) | SDA 15, SCL 14 |
| Touch | INT 13, RST 39 |
| I2S (ES8311 / ES7210) | MCLK 16, BCLK 9, WS 45, DOUT 8, DIN 10; speaker amp enable 46 |
| TF card (SDMMC 1-bit) | CLK 2, CMD 1, D0 3 |

## What it does

- **The cat:** the web app's GIFs (`web/public/pet/`) are embedded at build time and played with LVGL's GIF player at 3x (the stretched-out `petted` at 2x), anchored at the feet like `web/src/pet.ts`. Yawns now and then while `sleepy`.
- **Text:** ねこ's line in Japanese (DotGothic16, `assets/`, OFL, drawn by LVGL's TinyTTF) and its English below; stats at the top.
- **Voice:** the box sends each line at 16 kHz faster than it plays; the board buffers up to 30 s in PSRAM and plays it on the ES8311. A new line cuts off the old one. The mouth moves only while the voice sounds.
- **Push-to-talk:** hold the screen (a red dot shows), speak, let go. Both mics (ES7210) are mixed to mono and streamed between `listen_start` and `listen_end` (30 s max). The transcript (`heard`) is shown and sent back as `confirm` at once.
- **Check:** each `correction` shows as a card at the top: red with `wrong → right` and the grammar point for 12 s, or a green ◎ for 3 s.
- **Touch:** a tap pets the cat.

Speaker volume: `idf.py menuconfig` → neko → Speaker volume (default 70).
