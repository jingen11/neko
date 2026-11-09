/*
 * neko board firmware.
 *
 * The pet, drawn from the web app's GIFs (web/public/pet/, embedded at build time),
 * its lines in Japanese (DotGothic16 through LVGL's TinyTTF) and English, and the
 * WebSocket link to the box (protocol in shared/protocol.ts). A tap on the
 * screen pets the cat; holding it is push-to-talk (ES7210 mics). ねこ's voice
 * plays on the speaker (ES8311), and its mouth moves while the voice sounds.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_heap_caps.h"
#include "esp_codec_dev.h"
#include "driver/i2c_master.h"
#include "driver/gpio.h"
#include "driver/ledc.h"
#include "driver/rtc_io.h"
#include "esp_pm.h"
#include "esp_sleep.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "nvs_flash.h"
#include "cJSON.h"
#include "esp_websocket_client.h"
#include "bsp/esp-bsp.h"
#include "lvgl.h"

#define FW_VERSION "0.3.0"
#define BOARD_AUDIO_RATE 16000

static const char *TAG = "neko";

// ── audio: speaker and microphones ───────────────────────────────────────────
//
// The ES8311 (speaker) and ES7210 (two mics) share one I2S bus, so both are opened
// once, in the same format: 16 kHz, 16-bit, 2 channels (as Waveshare's demos do).
//
// Speaker: the box sends a whole line of voice at once, faster than it plays, so it
// goes into a ring buffer in PSRAM and a task feeds it to the codec at playback
// speed. When the buffer runs dry, the I2S driver sends silence (auto_clear).
//
// Microphones: push-to-talk. While the screen is held, a task reads both mics,
// mixes them to mono and streams 16 kHz PCM to the box between listen_start and
// listen_end.

#define AUDIO_CHANNELS 2
#define VOICE_BUF_BYTES (BOARD_AUDIO_RATE * 2 * 30) // 30 s of 16-bit mono
#define VOICE_CHUNK_SAMPLES 512                     // 32 ms
#define MIC_CHUNK_SAMPLES 320                       // 20 ms
#define MIC_MAX_SECONDS 30
#define MIC_GAIN_DB 24.0

static esp_codec_dev_handle_t speaker, mic;
static TaskHandle_t player_task, mic_task;
static uint8_t *voice_buf;
static size_t voice_head, voice_tail, voice_used; // bytes
static SemaphoreHandle_t voice_lock;
static volatile int64_t voice_loud_until_us; // lip-sync: the voice sounded until then
static volatile bool mic_wanted;             // the screen is held down

static esp_websocket_client_handle_t ws;
static bool ws_ready(void) { return ws && esp_websocket_client_is_connected(ws); }

static void voice_clear(void)
{
    xSemaphoreTake(voice_lock, portMAX_DELAY);
    voice_head = voice_tail = voice_used = 0;
    xSemaphoreGive(voice_lock);
}

static void voice_write(const uint8_t *data, size_t len)
{
    xSemaphoreTake(voice_lock, portMAX_DELAY);
    size_t space = VOICE_BUF_BYTES - voice_used;
    size_t n = len < space ? len : space;
    for (size_t done = 0; done < n;) {
        size_t run = VOICE_BUF_BYTES - voice_head;
        if (run > n - done) run = n - done;
        memcpy(voice_buf + voice_head, data + done, run);
        voice_head = (voice_head + run) % VOICE_BUF_BYTES;
        done += run;
    }
    voice_used += n;
    xSemaphoreGive(voice_lock);
    if (n < len) ESP_LOGW(TAG, "voice buffer full, %u bytes dropped", (unsigned)(len - n));
    if (player_task) xTaskNotifyGive(player_task);
}

static size_t voice_read(uint8_t *dst, size_t max)
{
    xSemaphoreTake(voice_lock, portMAX_DELAY);
    size_t n = voice_used < max ? voice_used : max;
    n &= ~(size_t)1; // whole samples
    for (size_t done = 0; done < n;) {
        size_t run = VOICE_BUF_BYTES - voice_tail;
        if (run > n - done) run = n - done;
        memcpy(dst + done, voice_buf + voice_tail, run);
        voice_tail = (voice_tail + run) % VOICE_BUF_BYTES;
        done += run;
    }
    voice_used -= n;
    xSemaphoreGive(voice_lock);
    return n;
}

static void player(void *arg)
{
    static int16_t mono[VOICE_CHUNK_SAMPLES], stereo[VOICE_CHUNK_SAMPLES * AUDIO_CHANNELS];
    for (;;) {
        size_t n = voice_read((uint8_t *)mono, sizeof mono) / 2;
        if (n == 0) {
            ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(100));
            continue;
        }
        int64_t sum = 0;
        for (size_t i = 0; i < n; i++) {
            stereo[2 * i] = stereo[2 * i + 1] = mono[i];
            sum += abs(mono[i]);
        }
        // lip-sync: loud enough to count as speaking? (mean level ~1.3% of full scale)
        if (sum / (int64_t)n > 440) voice_loud_until_us = esp_timer_get_time() + 150000;
        esp_codec_dev_write(speaker, stereo, n * AUDIO_CHANNELS * 2);
    }
}

static void mic_reader(void *arg)
{
    static int16_t stereo[MIC_CHUNK_SAMPLES * AUDIO_CHANNELS], mono[MIC_CHUNK_SAMPLES];
    for (;;) {
        if (!mic_wanted || !ws_ready()) {
            ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
            continue;
        }
        voice_clear(); // talking over ねこ stops it
        char start[64];
        int len = snprintf(start, sizeof start, "{\"type\":\"listen_start\",\"rate\":%d}", BOARD_AUDIO_RATE);
        esp_websocket_client_send_text(ws, start, len, pdMS_TO_TICKS(1000));
        ESP_LOGI(TAG, "listening");

        int chunks = 0, max_chunks = MIC_MAX_SECONDS * BOARD_AUDIO_RATE / MIC_CHUNK_SAMPLES;
        while (mic_wanted && ws_ready() && chunks++ < max_chunks) {
            if (esp_codec_dev_read(mic, stereo, sizeof stereo) != ESP_CODEC_DEV_OK) continue;
            for (int i = 0; i < MIC_CHUNK_SAMPLES; i++)
                mono[i] = (int16_t)(((int32_t)stereo[2 * i] + stereo[2 * i + 1]) / 2);
            esp_websocket_client_send_bin(ws, (const char *)mono, sizeof mono, pdMS_TO_TICKS(1000));
        }

        const char *end = "{\"type\":\"listen_end\"}";
        if (ws_ready()) esp_websocket_client_send_text(ws, end, strlen(end), pdMS_TO_TICKS(1000));
        ESP_LOGI(TAG, "sent %d ms of speech", chunks * MIC_CHUNK_SAMPLES * 1000 / BOARD_AUDIO_RATE);
        mic_wanted = false;
    }
}

static void audio_start(void)
{
    voice_lock = xSemaphoreCreateMutex();
    voice_buf = heap_caps_malloc(VOICE_BUF_BYTES, MALLOC_CAP_SPIRAM);
    speaker = bsp_audio_codec_speaker_init();
    mic = bsp_audio_codec_microphone_init();
    if (!voice_buf || !speaker || !mic) {
        ESP_LOGE(TAG, "audio not available");
        return;
    }
    esp_codec_dev_sample_info_t fs = {.bits_per_sample = 16, .channel = AUDIO_CHANNELS, .sample_rate = BOARD_AUDIO_RATE};
    esp_codec_dev_open(speaker, &fs);
    esp_codec_dev_set_out_vol(speaker, CONFIG_NEKO_VOLUME);
    esp_codec_dev_open(mic, &fs);
    esp_codec_dev_set_in_gain(mic, MIC_GAIN_DB);
    xTaskCreatePinnedToCore(player, "player", 4096, NULL, 6, &player_task, 1);
    xTaskCreatePinnedToCore(mic_reader, "mic", 4096, NULL, 6, &mic_task, 1);
}

/** Push-to-talk: start or stop sending the microphones to the box. */
static void mic_hold(bool down)
{
    mic_wanted = down;
    if (down && mic_task) xTaskNotifyGive(mic_task);
}

static bool voice_sounding(void)
{
    return esp_timer_get_time() < voice_loud_until_us;
}

// ── embedded assets ──────────────────────────────────────────────────────────

extern const uint8_t font_start[] asm("_binary_DotGothic16_Regular_ttf_start");
extern const uint8_t font_end[] asm("_binary_DotGothic16_Regular_ttf_end");

#define GIF_EXTERN(n)                                                      \
    extern const uint8_t n##_gif_start[] asm("_binary_" #n "_gif_start"); \
    extern const uint8_t n##_gif_end[] asm("_binary_" #n "_gif_end");
GIF_EXTERN(idle) GIF_EXTERN(listen) GIF_EXTERN(think) GIF_EXTERN(talk) GIF_EXTERN(happy)
GIF_EXTERN(sad) GIF_EXTERN(eat) GIF_EXTERN(sleep) GIF_EXTERN(petted) GIF_EXTERN(sleepy)
GIF_EXTERN(sick) GIF_EXTERN(angry) GIF_EXTERN(yawn)

// ── the pet ──────────────────────────────────────────────────────────────────

#define CAT_X (BSP_LCD_H_RES / 2) // where the cat's feet go on screen
#define CAT_FEET_Y 170
#define PAD 16 // keeps text out of the panel's rounded corners

typedef struct {
    const char *name;
    const uint8_t *start, *end;
    int scale;          // LVGL scale: 256 = one screen pixel per art pixel
    lv_image_dsc_t dsc; // filled in at start
    int16_t fx, fy;     // the feet in the GIF, found from its first frame
    bool feet_known;
} sprite_t;

#define SPRITE(n, s) {.name = #n, .start = n##_gif_start, .end = n##_gif_end, .scale = s}
static sprite_t sprites[] = {
    // 2x: fits between the status rows and ねこ's text. petted.gif draws the cat 1.5x bigger
    // than the others, so it gets 2/3 of that (1.33x) to keep the cat the same size.
    SPRITE(idle, 512), SPRITE(listen, 512), SPRITE(think, 512), SPRITE(talk, 512), SPRITE(happy, 512),
    SPRITE(sad, 512), SPRITE(eat, 512), SPRITE(sleep, 512), SPRITE(petted, 341),
    SPRITE(sleepy, 512), SPRITE(sick, 512), SPRITE(angry, 512), SPRITE(yawn, 512),
};
#define N_SPRITES (sizeof sprites / sizeof sprites[0])

static lv_obj_t *cat;
static int shown = -1;      // sprite on screen
static int state_anim = 0;  // what the box says the pet is doing
static bool yawning;
static int64_t next_yawn_us;

static int sprite_index(const char *name)
{
    for (int i = 0; i < N_SPRITES; i++)
        if (strcmp(sprites[i].name, name) == 0) return i;
    return 0; // unknown: idle
}

/** The cat's feet: the lowest opaque row, centred on the opaque pixels near it (as in web/src/pet.ts). */
static void find_feet(sprite_t *s)
{
    const lv_draw_buf_t *buf = (const lv_draw_buf_t *)lv_image_get_src(cat);
    int w = buf->header.w, h = buf->header.h, stride = buf->header.stride;
    s->fx = w / 2;
    s->fy = h;
    s->feet_known = true;
    if (buf->header.cf != LV_COLOR_FORMAT_ARGB8888) return;
#define OPAQUE(x, y) (buf->data[(y) * stride + (x) * 4 + 3] > 0)
    int bottom = -1;
    for (int y = h - 1; y >= 0 && bottom < 0; y--)
        for (int x = 0; x < w; x++)
            if (OPAQUE(x, y)) { bottom = y; break; }
    if (bottom < 0) return;
    int min = w, max = -1;
    for (int y = bottom > 3 ? bottom - 3 : 0; y <= bottom; y++)
        for (int x = 0; x < w; x++)
            if (OPAQUE(x, y)) { if (x < min) min = x; if (x > max) max = x; }
#undef OPAQUE
    s->fx = (min + max + 1) / 2;
    s->fy = bottom + 1;
}

/** Switch the cat to a sprite. Call with the display locked. */
static void show(int i)
{
    if (i == shown) return;
    shown = i;
    sprite_t *s = &sprites[i];
    lv_gif_set_src(cat, &s->dsc);
    if (!s->feet_known) find_feet(s);
    lv_gif_set_loop_count(cat, i == sprite_index("yawn") ? 1 : 0); // 0 = forever
    lv_image_set_pivot(cat, s->fx, s->fy);
    lv_image_set_scale(cat, s->scale);
    lv_obj_set_pos(cat, CAT_X - s->fx, CAT_FEET_Y - s->fy);
}

static void set_anim(const char *name)
{
    int i = sprite_index(name);
    if (i == state_anim) return;
    state_anim = i;
    yawning = false;
    next_yawn_us = esp_timer_get_time() + (4 + esp_random() % 6) * 1000000LL;
    show(i);
}

static void yawn_done(void *arg)
{
    if (!yawning) return;
    yawning = false;
    show(state_anim);
    next_yawn_us = esp_timer_get_time() + (10 + esp_random() % 15) * 1000000LL;
}

static void on_cat_event(lv_event_t *e)
{
    // played once to the end: back to what the pet was doing (after this event returns)
    if (yawning) lv_async_call(yawn_done, NULL);
}

/** Lip-sync while talking, and now and then a yawn while drowsy. Runs in the LVGL task. */
static bool mouth_paused;
static bool screen_dark(void);

static void tick(lv_timer_t *t)
{
    if (screen_dark()) return; // the cat is paused while the screen is off
    // talking: the mouth moves while the voice sounds and rests in silence (as in the web app)
    bool pause = shown == sprite_index("talk") && !voice_sounding();
    if (pause != mouth_paused) {
        mouth_paused = pause;
        if (pause) lv_gif_pause(cat);
        else lv_gif_resume(cat);
    }
    if (state_anim == sprite_index("sleepy") && !yawning && esp_timer_get_time() > next_yawn_us) {
        yawning = true;
        show(sprite_index("yawn"));
    }
}

// ── screen ───────────────────────────────────────────────────────────────────

static char device_id[18];
static lv_font_t *font_ja;
static lv_obj_t *lbl_top, *lbl_ja, *lbl_en, *rec_dot, *fix_card;
static lv_timer_t *fix_timer;

static void fix_hide(lv_timer_t *t)
{
    lv_obj_set_hidden(fix_card, true);
    fix_timer = NULL;
}

/** The check of what the learner said, as a card at the top. Call with the display locked. */
static void fix_show(const char *text, bool ok, uint32_t ms)
{
    lv_label_set_text(fix_card, text);
    lv_obj_set_style_bg_color(fix_card, lv_color_hex(ok ? 0xe6f4ea : 0xfdecec), 0);
    lv_obj_set_style_text_color(fix_card, lv_color_hex(ok ? 0x1e7a3c : 0xb3261e), 0);
    lv_obj_set_hidden(fix_card, false);
    if (fix_timer) lv_timer_delete(fix_timer);
    fix_timer = lv_timer_create(fix_hide, ms, NULL);
    lv_timer_set_repeat_count(fix_timer, 1);
}

static void ui_set(lv_obj_t *label, const char *text)
{
    if (bsp_display_lock(100)) {
        lv_label_set_text(label, text);
        bsp_display_unlock();
    }
}

// ── power: battery (AXP2101) and screen sleep ────────────────────────────────
//
// The AXP2101 is only read (power source, charging, charge %); its power rails stay
// as the board set them. While awake, the CPU slows to 80 MHz when idle. On battery,
// the screen dims after a while without use, and later the whole board goes into
// deep sleep (Wi-Fi, screen, speaker amp and codecs off). A touch wakes it: it
// restarts, reconnects and ねこ greets you. On USB it never sleeps.

#define AXP2101_ADDR 0x34
#define BRIGHT_ON 80
#define BRIGHT_DIM 15

#define BAR_ON 0x636361
#define BAR_OFF 0xd9d9d6

static i2c_master_dev_handle_t pmu;
static lv_obj_t *wifi_bars[4];
static volatile bool wifi_up; // has an IP
static lv_obj_t *lbl_batt;
static bool on_battery;
static int64_t last_activity_us;
static enum { SCREEN_ON, SCREEN_DIM, SCREEN_OFF } screen = SCREEN_ON;
static bool swallow_touch; // a touch on a dark screen only wakes it
static bool going_to_sleep;

static bool screen_dark(void) { return screen == SCREEN_OFF; }

/** Everything off, then deep sleep until the screen is touched. Runs in its own task. */
static void sleep_task(void *arg)
{
    ESP_LOGI(TAG, "going to sleep");
    if (ws) esp_websocket_client_close(ws, pdMS_TO_TICKS(1000));
    esp_wifi_stop();
    if (speaker) esp_codec_dev_close(speaker);
    if (mic) esp_codec_dev_close(mic);

    // keep the backlight and the speaker amp off while asleep (their pins would float)
    ledc_stop(LEDC_LOW_SPEED_MODE, CONFIG_BSP_DISPLAY_BRIGHTNESS_LEDC_CH, 0);
    const gpio_num_t held[] = {BSP_LCD_BACKLIGHT, BSP_POWER_AMP_IO};
    for (int i = 0; i < 2; i++) {
        gpio_set_direction(held[i], GPIO_MODE_OUTPUT);
        gpio_set_level(held[i], 0);
        gpio_hold_en(held[i]);
    }
    gpio_deep_sleep_hold_en();

    // the touch controller pulls its interrupt line low on a touch
    rtc_gpio_pullup_en(BSP_LCD_TOUCH_INT);
    rtc_gpio_pulldown_dis(BSP_LCD_TOUCH_INT);
    esp_sleep_enable_ext0_wakeup(BSP_LCD_TOUCH_INT, 0);
    esp_deep_sleep_start();
}

static int pmu_read(uint8_t reg)
{
    uint8_t v;
    if (!pmu || i2c_master_transmit_receive(pmu, &reg, 1, &v, 1, 50) != ESP_OK) return -1;
    return v;
}

static void pmu_set_bits(uint8_t reg, uint8_t bits)
{
    int v = pmu_read(reg);
    if (v < 0 || (v & bits) == bits) return;
    uint8_t w[2] = {reg, (uint8_t)(v | bits)};
    i2c_master_transmit(pmu, w, 2, 50);
}

static void pmu_start(void)
{
    i2c_device_config_t cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = AXP2101_ADDR,
        .scl_speed_hz = 400000,
    };
    if (i2c_master_bus_add_device(bsp_i2c_get_handle(), &cfg, &pmu) != ESP_OK || pmu_read(0x00) < 0) {
        ESP_LOGW(TAG, "battery chip not found");
        pmu = NULL;
        return;
    }
    pmu_set_bits(0x18, 1 << 3); // fuel gauge on
    pmu_set_bits(0x30, 1 << 0); // battery voltage measurement on (as Waveshare's demo)
}

/** Call with the display locked. */
static void screen_set(int state)
{
    if (state == screen) return;
    if (screen == SCREEN_OFF) { // waking: let the cat move again (tick re-pauses a silent mouth)
        mouth_paused = false;
        lv_gif_resume(cat);
    }
    if (state == SCREEN_OFF) lv_gif_pause(cat);
    screen = state;
    bsp_display_brightness_set(state == SCREEN_ON ? BRIGHT_ON : state == SCREEN_DIM ? BRIGHT_DIM : 0);
}

/** Something happened worth looking at: keep the screen on. Call with the display locked. */
static void activity(void)
{
    last_activity_us = esp_timer_get_time();
    screen_set(SCREEN_ON);
}

/** Battery readout and screen sleep, every second. Runs in the LVGL task. */
static void power_tick(lv_timer_t *t)
{
    if (voice_sounding() || mic_wanted) last_activity_us = esp_timer_get_time();

    int s1 = pmu_read(0x00), s2 = pmu_read(0x01), pct = pmu_read(0xA4);
    if (s1 < 0) {
        on_battery = false;
        lv_obj_set_hidden(lbl_batt, true);
    } else {
        bool usb = s1 & (1 << 5), batt = s1 & (1 << 3);
        bool charging = s2 >= 0 && ((s2 >> 5) & 3) == 1;
        on_battery = batt && !usb;
        if (pct < 0 || pct > 100) pct = 0;
        char buf[40];
        if (!batt) {
            snprintf(buf, sizeof buf, LV_SYMBOL_USB);
        } else {
            const char *icon = pct > 80   ? LV_SYMBOL_BATTERY_FULL
                               : pct > 55 ? LV_SYMBOL_BATTERY_3
                               : pct > 30 ? LV_SYMBOL_BATTERY_2
                               : pct > 10 ? LV_SYMBOL_BATTERY_1
                                          : LV_SYMBOL_BATTERY_EMPTY;
            if (charging) snprintf(buf, sizeof buf, LV_SYMBOL_CHARGE "%d%%", pct);
            else snprintf(buf, sizeof buf, "%d%% %s", pct, icon);
        }
        lv_label_set_text(lbl_batt, buf);
        lv_obj_set_style_text_color(lbl_batt, lv_color_hex(on_battery && pct <= 15 ? 0xb3261e : 0x636361), 0);
        lv_obj_set_hidden(lbl_batt, false);
    }

    // Wi-Fi signal: 0–4 bars
    int rssi = -127;
    int bars = 0;
    if (wifi_up && esp_wifi_sta_get_rssi(&rssi) == ESP_OK)
        bars = rssi > -55 ? 4 : rssi > -65 ? 3 : rssi > -75 ? 2 : rssi > -85 ? 1 : 0;
    for (int i = 0; i < 4; i++)
        lv_obj_set_style_bg_color(wifi_bars[i], lv_color_hex(i < bars ? BAR_ON : BAR_OFF), 0);

    int64_t idle = esp_timer_get_time() - last_activity_us;
    if (!on_battery) {
        screen_set(SCREEN_ON);
    } else if (idle > CONFIG_NEKO_SLEEP_S * 1000000LL) {
        if (!going_to_sleep) {
            going_to_sleep = true;
            screen_set(SCREEN_OFF);
            xTaskCreate(sleep_task, "sleep", 4096, NULL, 5, NULL);
        }
    } else if (idle > CONFIG_NEKO_SCREEN_DIM_S * 1000000LL) {
        screen_set(SCREEN_DIM);
    }
}

static void send_touch(const char *gesture)
{
    if (!ws_ready()) return;
    char buf[64];
    int n = snprintf(buf, sizeof buf, "{\"type\":\"touch\",\"gesture\":\"%s\"}", gesture);
    esp_websocket_client_send_text(ws, buf, n, pdMS_TO_TICKS(1000));
}

static void on_screen_event(lv_event_t *e)
{
    // tap: pet the cat. hold: talk (push-to-talk), let go to send.
    lv_event_code_t code = lv_event_get_code(e);
    if (code == LV_EVENT_PRESSED) {
        swallow_touch = screen == SCREEN_OFF; // a dark screen: this touch only wakes it
        activity();
    }
    if (swallow_touch) {
        if (code == LV_EVENT_RELEASED || code == LV_EVENT_PRESS_LOST) swallow_touch = false;
        return;
    }
    if (code == LV_EVENT_SHORT_CLICKED) {
        send_touch("pet");
    } else if (code == LV_EVENT_LONG_PRESSED && ws_ready() && mic) {
        mic_hold(true);
        if (fix_timer) lv_timer_delete(fix_timer); // a new try: clear the last check
        fix_hide(NULL);
        lv_obj_set_hidden(rec_dot, false);
    } else if ((code == LV_EVENT_RELEASED || code == LV_EVENT_PRESS_LOST) && mic_wanted) {
        mic_hold(false);
        lv_obj_set_hidden(rec_dot, true);
    }
}

static lv_obj_t *add_label(lv_obj_t *parent, const lv_font_t *font, lv_color_t color, int y)
{
    lv_obj_t *l = lv_label_create(parent);
    lv_obj_set_style_text_font(l, font, 0);
    lv_obj_set_style_text_color(l, color, 0);
    lv_obj_set_style_text_line_space(l, 2, 0);
    lv_obj_set_width(l, BSP_LCD_H_RES - 2 * PAD);
    lv_label_set_long_mode(l, LV_LABEL_LONG_MODE_WRAP);
    lv_obj_set_style_text_align(l, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(l, LV_ALIGN_TOP_MID, 0, y);
    lv_obj_set_clickable(l, false);
    lv_label_set_text(l, "");
    return l;
}

static void ui_init(void)
{
    for (int i = 0; i < N_SPRITES; i++) {
        sprites[i].dsc = (lv_image_dsc_t){
            .header = {.magic = LV_IMAGE_HEADER_MAGIC, .cf = LV_COLOR_FORMAT_RAW},
            .data = sprites[i].start,
            .data_size = sprites[i].end - sprites[i].start,
        };
    }
    font_ja = lv_tiny_ttf_create_data(font_start, font_end - font_start, 16);

    bsp_display_lock(0);
    lv_obj_t *scr = lv_screen_active();
    lv_obj_set_style_bg_color(scr, lv_color_hex(0xffffff), 0);
    lv_obj_set_scrollable(scr, false);
    lv_obj_add_event_cb(scr, on_screen_event, LV_EVENT_ALL, NULL);

    cat = lv_gif_create(scr);
    lv_gif_set_color_format(cat, LV_COLOR_FORMAT_ARGB8888);
    lv_image_set_antialias(cat, false); // crisp pixel art
    lv_obj_set_clickable(cat, false);
    lv_obj_add_event_cb(cat, on_cat_event, LV_EVENT_READY, NULL);
    show(0);

    // row 1: recording dot, Wi-Fi signal, battery (centred: the panel's corners are rounded)
    lv_obj_t *status = lv_obj_create(scr);
    lv_obj_remove_style_all(status);
    lv_obj_set_size(status, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(status, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(status, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_column(status, 10, 0);
    lv_obj_align(status, LV_ALIGN_TOP_MID, 0, 10);
    lv_obj_set_clickable(status, false);

    rec_dot = lv_obj_create(status); // shows while the mics are on
    lv_obj_remove_style_all(rec_dot);
    lv_obj_set_size(rec_dot, 10, 10);
    lv_obj_set_style_radius(rec_dot, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_opa(rec_dot, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(rec_dot, lv_color_hex(0xe5484d), 0);
    lv_obj_set_clickable(rec_dot, false);
    lv_obj_set_hidden(rec_dot, true);

    lv_obj_t *wifi = lv_obj_create(status); // four bars, like a phone
    lv_obj_remove_style_all(wifi);
    lv_obj_set_size(wifi, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(wifi, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(wifi, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_END, LV_FLEX_ALIGN_END);
    lv_obj_set_style_pad_column(wifi, 2, 0);
    lv_obj_set_clickable(wifi, false);
    for (int i = 0; i < 4; i++) {
        wifi_bars[i] = lv_obj_create(wifi);
        lv_obj_remove_style_all(wifi_bars[i]);
        lv_obj_set_size(wifi_bars[i], 4, 4 + 3 * i);
        lv_obj_set_style_radius(wifi_bars[i], 1, 0);
        lv_obj_set_style_bg_opa(wifi_bars[i], LV_OPA_COVER, 0);
        lv_obj_set_style_bg_color(wifi_bars[i], lv_color_hex(BAR_OFF), 0);
        lv_obj_set_clickable(wifi_bars[i], false);
    }

    lbl_batt = lv_label_create(status);
    lv_obj_set_style_text_font(lbl_batt, &lv_font_montserrat_14, 0);
    lv_obj_set_clickable(lbl_batt, false);
    lv_label_set_text(lbl_batt, "");

    // row 2: the pet's health (or how the connection is going)
    lbl_top = add_label(scr, font_ja, lv_color_hex(0x636361), 30);
    lbl_ja = add_label(scr, font_ja, lv_color_hex(0x1f201d), CAT_FEET_Y + 8);
    lbl_en = add_label(scr, &lv_font_montserrat_14, lv_color_hex(0x636361), CAT_FEET_Y + 60);
    lv_label_set_text(lbl_top, "起動中…");

    fix_card = lv_label_create(scr); // the check of what the learner said
    lv_obj_set_style_text_font(fix_card, font_ja, 0);
    lv_obj_set_style_text_line_space(fix_card, 2, 0);
    lv_obj_set_style_radius(fix_card, 8, 0);
    lv_obj_set_style_bg_opa(fix_card, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(fix_card, 6, 0);
    lv_obj_set_width(fix_card, BSP_LCD_H_RES - 2 * PAD + 8);
    lv_label_set_long_mode(fix_card, LV_LABEL_LONG_MODE_WRAP);
    lv_obj_align(fix_card, LV_ALIGN_TOP_MID, 0, 8);
    lv_obj_set_clickable(fix_card, false);
    lv_obj_set_hidden(fix_card, true);

    lv_timer_create(tick, 50, NULL);
    pmu_start();
    last_activity_us = esp_timer_get_time();
    bsp_display_brightness_set(BRIGHT_ON);
    lv_timer_create(power_tick, 1000, NULL);
    bsp_display_unlock();
}

// ── messages from the box ────────────────────────────────────────────────────

static int num(cJSON *obj, const char *key)
{
    return (int)cJSON_GetNumberValue(cJSON_GetObjectItem(obj, key));
}

static void handle_message(const char *json, size_t len)
{
    cJSON *msg = cJSON_ParseWithLength(json, len);
    if (!msg) return;
    const char *type = cJSON_GetStringValue(cJSON_GetObjectItem(msg, "type"));
    char buf[512];

    if (type && strcmp(type, "state") == 0) {
        const char *anim = cJSON_GetStringValue(cJSON_GetObjectItem(msg, "anim"));
        cJSON *s = cJSON_GetObjectItem(msg, "stats");
        if (s) {
            snprintf(buf, sizeof buf, "♥%d  おなか%d  %d日",
                     num(s, "happiness"), 100 - num(s, "hunger"), num(s, "streak"));
        }
        if (bsp_display_lock(100)) {
            if (anim) set_anim(anim);
            if (s) lv_label_set_text(lbl_top, buf);
            bsp_display_unlock();
        }
    } else if (type && strcmp(type, "say") == 0) {
        const char *ja = cJSON_GetStringValue(cJSON_GetObjectItem(msg, "ja"));
        const char *en = cJSON_GetStringValue(cJSON_GetObjectItem(msg, "en"));
        if (bsp_display_lock(100)) {
            activity();
            lv_label_set_text(lbl_ja, ja ? ja : "");
            lv_label_set_text(lbl_en, en ? en : "");
            bsp_display_unlock();
        }
    } else if (type && strcmp(type, "audio_start") == 0) {
        // a new line cuts off whatever is still playing (the voice comes at the 16 kHz asked for in hello)
        voice_clear();
        if (num(msg, "rate") != BOARD_AUDIO_RATE) ESP_LOGW(TAG, "voice at %d Hz, expected %d", num(msg, "rate"), BOARD_AUDIO_RATE);
    } else if (type && strcmp(type, "correction") == 0) {
        // each mistake as "wrong → right", then the first one's grammar point
        bool ok = cJSON_IsTrue(cJSON_GetObjectItem(msg, "is_correct"));
        cJSON *mistakes = cJSON_GetObjectItem(msg, "mistakes");
        int n = 0, shown_n = 0;
        const char *point = NULL;
        buf[0] = 0;
        cJSON *m;
        cJSON_ArrayForEach(m, mistakes) {
            if (shown_n == 2) break;
            const char *orig = cJSON_GetStringValue(cJSON_GetObjectItem(m, "original"));
            const char *fix = cJSON_GetStringValue(cJSON_GetObjectItem(m, "fix"));
            if (!orig || !fix) continue;
            if (!point) point = cJSON_GetStringValue(cJSON_GetObjectItem(m, "grammar_point"));
            n += snprintf(buf + n, sizeof buf - n, "%s%s → %s", shown_n ? "\n" : "", orig, fix);
            if (n >= (int)sizeof buf) n = sizeof buf - 1;
            shown_n++;
        }
        if (point && n < (int)sizeof buf) snprintf(buf + n, sizeof buf - n, "\n%s", point);
        if (bsp_display_lock(100)) {
            activity();
            if (ok || shown_n == 0) fix_show("◎ ばっちり！", true, 3000);
            else fix_show(buf, false, 12000);
            bsp_display_unlock();
        }
    } else if (type && strcmp(type, "heard") == 0) {
        // what the box heard: show it and send it on straight away (the browser lets you edit it first)
        const char *text = cJSON_GetStringValue(cJSON_GetObjectItem(msg, "text"));
        if (text && *text) {
            cJSON *c = cJSON_CreateObject();
            cJSON_AddStringToObject(c, "type", "confirm");
            cJSON_AddStringToObject(c, "text", text);
            char *out = cJSON_PrintUnformatted(c);
            if (out && ws_ready()) esp_websocket_client_send_text(ws, out, strlen(out), pdMS_TO_TICKS(1000));
            cJSON_free(out);
            cJSON_Delete(c);
            snprintf(buf, sizeof buf, "「%s」", text);
            ui_set(lbl_ja, buf);
            ui_set(lbl_en, "");
        } else {
            ui_set(lbl_ja, "きこえなかった…");
            ui_set(lbl_en, "Didn't catch that. Hold the screen and speak.");
        }
    } else if (type && strcmp(type, "error") == 0) {
        const char *m = cJSON_GetStringValue(cJSON_GetObjectItem(msg, "message"));
        ui_set(lbl_en, m ? m : "error");
    }
    cJSON_Delete(msg);
}

// ── WebSocket ────────────────────────────────────────────────────────────────

static char rx_buf[8192];

static void send_hello(void)
{
    char buf[512];
    int n = snprintf(buf, sizeof buf,
                     "{\"type\":\"hello\",\"client\":\"board\",\"deviceId\":\"%s\",\"audioRate\":%d,\"fw\":\"%s\"}",
                     device_id, BOARD_AUDIO_RATE, FW_VERSION);
    esp_websocket_client_send_text(ws, buf, n, pdMS_TO_TICKS(1000));
}

static void ws_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    esp_websocket_event_data_t *d = data;
    switch (id) {
    case WEBSOCKET_EVENT_CONNECTED:
        ESP_LOGI(TAG, "connected to box");
        send_hello();
        break;
    case WEBSOCKET_EVENT_DISCONNECTED:
        ESP_LOGW(TAG, "disconnected from box");
        ui_set(lbl_top, "ボックスに再接続中…");
        break;
    case WEBSOCKET_EVENT_DATA:
        // Text frames may arrive in pieces; put them back together.
        if (d->op_code == 0x1 || (d->op_code == 0x0 && d->payload_offset > 0)) {
            if (d->payload_len >= (int)sizeof rx_buf) {
                ESP_LOGW(TAG, "message too long (%d), dropped", d->payload_len);
                break;
            }
            memcpy(rx_buf + d->payload_offset, d->data_ptr, d->data_len);
            if (d->payload_offset + d->data_len >= d->payload_len) {
                handle_message(rx_buf, d->payload_len);
            }
        }
        if (d->op_code == 0x2 && voice_buf) voice_write((const uint8_t *)d->data_ptr, d->data_len); // the pet's voice
        break;
    case WEBSOCKET_EVENT_ERROR:
        ESP_LOGE(TAG, "websocket error");
        break;
    default:
        break;
    }
}

static void ws_start(void)
{
    if (ws) return; // the client reconnects on its own
    esp_websocket_client_config_t cfg = {
        .uri = CONFIG_NEKO_WS_URL,
        .buffer_size = 4096,
        .reconnect_timeout_ms = 3000,
        .network_timeout_ms = 10000,
        .ping_interval_sec = 15,
    };
    ws = esp_websocket_client_init(&cfg);
    esp_websocket_register_events(ws, WEBSOCKET_EVENT_ANY, ws_event, NULL);
    esp_websocket_client_start(ws);
}

// ── Wi-Fi ────────────────────────────────────────────────────────────────────

static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_up = false;
        ui_set(lbl_top, "Wi-Fi 再接続中…");
        vTaskDelay(pdMS_TO_TICKS(2000));
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = data;
        wifi_up = true;
        ESP_LOGI(TAG, "IP " IPSTR, IP2STR(&e->ip_info.ip));
        ui_set(lbl_top, "ボックスに接続中…");
        ws_start();
    }
}

static void wifi_start(void)
{
    ESP_ERROR_CHECK(esp_netif_init());
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, NULL));

    wifi_config_t cfg = {0};
    strlcpy((char *)cfg.sta.ssid, CONFIG_NEKO_WIFI_SSID, sizeof cfg.sta.ssid);
    strlcpy((char *)cfg.sta.password, CONFIG_NEKO_WIFI_PASSWORD, sizeof cfg.sta.password);
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &cfg));
    ESP_ERROR_CHECK(esp_wifi_start());
    ui_set(lbl_top, "Wi-Fi 接続中…");
}

void app_main(void)
{
    if (esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_EXT0) ESP_LOGI(TAG, "woken by a touch");
    gpio_hold_dis(BSP_LCD_BACKLIGHT);
    gpio_hold_dis(BSP_POWER_AMP_IO);
    gpio_deep_sleep_hold_dis();
    rtc_gpio_deinit(BSP_LCD_TOUCH_INT); // back to a normal pin for the touch driver
    esp_pm_config_t pm = {.max_freq_mhz = 240, .min_freq_mhz = 80, .light_sleep_enable = false};
    esp_pm_configure(&pm);

    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(device_id, sizeof device_id, "%02x%02x%02x%02x%02x%02x",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

    bsp_display_start();
    bsp_display_backlight_on();
    ui_init();
    audio_start();

    if (strlen(CONFIG_NEKO_WIFI_SSID) == 0) {
        ui_set(lbl_top, "Wi-Fi 未設定 (menuconfig)");
        return;
    }
    wifi_start();
}
