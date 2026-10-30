import { Application, Container, Graphics, Text } from "pixi.js";
import { GifSource, GifSprite } from "pixi.js/gif";
import type { Anim, Mood } from "../../shared/protocol.ts";

/**
 * The pet, drawn from pixel-art GIFs in web/public/pet/<name>.gif (one per animation).
 * Each GIF is anchored at its feet (found from the first frame), so they line up whatever their canvas size.
 * Local coordinates: the cat stands on y = 125, roughly 300×300 units; scaling keeps art pixels whole.
 */
const ANIMS: Anim[] = ["idle", "listen", "think", "talk", "happy", "sad", "eat", "sleep", "petted", "sleepy", "sick", "angry"];
const EXTRAS = ["yawn"] as const; // played now and then on top of a state
const FEET_Y = 125;
const ART_PX = 4.2; // units per art pixel (64 px art → ~270 units)

interface Floater {
  t: Text;
  vx: number;
  vy: number;
  life: number;
  age: number;
}

export class Pet {
  private root = new Container();
  private cat = new Container();
  private fx = new Container(); // floating hearts / Zzz
  private floaters: Floater[] = [];
  private sprites = new Map<string, GifSprite>();
  private shown: GifSprite | null = null;

  private anim: Anim = "idle";
  private serverAnim: Anim = "idle";
  private forced: Anim | null = null;
  private t = 0;
  private nextFloater = 0;
  private nextYawn = 0;
  private yawning = false;
  private lastVoiceAt = -1;
  private stroke = { down: false, x: 0, y: 0, dist: 0 };

  constructor(
    private app: Application,
    private voiceLevel: () => number,
    private onPet: () => void,
  ) {
    const shadow = new Graphics().ellipse(0, FEET_Y + 3, 95, 12).fill({ color: 0x000000, alpha: 0.12 });
    this.root.addChild(shadow, this.cat, this.fx);
    app.stage.addChild(this.root);
    this.setupStroking();
    app.ticker.add((tk) => this.update(tk.deltaMS / 1000));
    this.layout();
    app.renderer.on("resize", () => this.layout());
    void this.load();
  }

  setState(anim: Anim, _mood: Mood) {
    this.serverAnim = anim;
    if (!this.forced) this.apply(anim);
  }

  /** Debug: show an animation regardless of the server (null = back to normal). */
  force(anim: Anim | null) {
    this.forced = anim;
    this.apply(anim ?? this.serverAnim);
  }

  /** Debug: yawn right now. */
  yawnNow() {
    if (!this.yawning) this.yawn();
  }

  private apply(anim: Anim) {
    if (anim === this.anim) return; // periodic refresh: keep what's playing (e.g. a yawn)
    this.yawning = false;
    this.anim = anim;
    if (anim === "sleepy") this.nextYawn = this.t + 4 + Math.random() * 6;
    this.show(anim);
  }

  private async load() {
    await Promise.all(
      [...ANIMS, ...EXTRAS].map(async (name) => {
        try {
          const res = await fetch(`${import.meta.env.BASE_URL}pet/${name}.gif`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const source = GifSource.from(await res.arrayBuffer());
          const s = new GifSprite({ source, scaleMode: "nearest", autoUpdate: false, autoPlay: false });
          const { x, y } = feetOf(source);
          s.anchor.set(x / source.width, y / source.height);
          s.position.y = FEET_Y;
          s.visible = false;
          this.cat.addChild(s);
          this.sprites.set(name, s);
        } catch (e) {
          console.warn(`pet sprite "${name}" not loaded (falls back to idle):`, e);
        }
      }),
    );
    this.layout();
    this.show(this.anim);
  }

  /** Switch the visible sprite (missing ones fall back to idle). */
  private show(name: string) {
    const s = this.sprites.get(name) ?? this.sprites.get("idle");
    if (!s || s === this.shown) return;
    if (this.shown) {
      this.shown.visible = false;
      this.shown.stop();
    }
    this.shown = s;
    s.visible = true;
    s.loop = true;
    s.currentFrame = 0;
    s.play();
  }

  private yawn() {
    const y = this.sprites.get("yawn");
    if (!y) return;
    this.show("yawn");
    this.yawning = true;
    y.loop = false;
    y.onComplete = () => {
      y.onComplete = undefined;
      if (!this.yawning) return;
      this.yawning = false;
      this.show(this.anim);
      this.nextYawn = this.t + 10 + Math.random() * 15;
    };
  }

  private setupStroking() {
    // stroking or tapping the cat pets it
    this.cat.eventMode = "static";
    this.cat.cursor = "grab";
    this.cat.on("pointerdown", (e) => {
      this.stroke = { down: true, x: e.global.x, y: e.global.y, dist: 0 };
    });
    this.cat.on("pointermove", (e) => {
      if (!this.stroke.down) return;
      this.stroke.dist += Math.hypot(e.global.x - this.stroke.x, e.global.y - this.stroke.y);
      this.stroke.x = e.global.x;
      this.stroke.y = e.global.y;
      if (this.stroke.dist > 120) {
        this.stroke.dist = 0;
        this.onPet();
      }
    });
    const end = () => {
      if (this.stroke.down && this.stroke.dist < 10) this.onPet(); // a tap counts too
      this.stroke.down = false;
    };
    this.cat.on("pointerup", end);
    this.cat.on("pointerupoutside", end);
  }

  private layout() {
    const { width, height } = this.app.screen;
    const s = Math.min(width / 340, height / 330); // screen px per unit
    // whole device pixels per art pixel, so the pixel art stays crisp
    const dpr = this.app.renderer.resolution;
    const px = Math.max(1, Math.round(s * ART_PX * dpr)) / dpr;
    this.root.scale.set(s);
    this.root.position.set(Math.round(width / 2), Math.round(height / 2 - 5 * s));
    for (const sp of this.sprites.values()) sp.scale.set(px / s);
  }

  private update(dt: number) {
    this.t += dt;
    const s = this.shown;
    if (s) {
      if (this.anim === "talk" && !this.yawning && !this.forced) {
        // lip-sync: animate while the voice is sounding, rest on the first (closed-mouth) frame in silence
        if (this.voiceLevel() > 0.04) this.lastVoiceAt = this.t;
        const speaking = this.t - this.lastVoiceAt < 0.15;
        if (speaking && !s.playing) s.play();
        if (!speaking && s.playing) {
          s.stop();
          s.currentFrame = 0;
        }
      }
      if (s.playing) s.update(this.app.ticker);
    }
    if (this.anim === "sleepy" && !this.yawning && this.t > this.nextYawn) this.yawn();
    this.updateFloaters(dt);
  }

  private updateFloaters(dt: number) {
    const a = this.anim;
    // sleep.gif has no Zzz of its own (sleepy.gif does)
    const emoji = a === "petted" ? "💗" : a === "sleep" ? "💤" : a === "angry" ? "💢" : null;
    if (emoji && this.t > this.nextFloater) {
      this.nextFloater = this.t + (a === "sleep" ? 1.4 : a === "petted" ? 0.25 : 0.6);
      const t = new Text({ text: emoji, style: { fontSize: a === "sleep" ? 30 : 24, fill: 0x8a8079 } });
      t.anchor.set(0.5);
      t.position.set(a === "sleep" ? 60 : (Math.random() - 0.5) * 140, -90);
      this.fx.addChild(t);
      this.floaters.push({ t, vx: a === "sleep" ? 12 : (Math.random() - 0.5) * 30, vy: -45, life: a === "sleep" ? 2.6 : 1.4, age: 0 });
    }
    for (const f of this.floaters) {
      f.age += dt;
      f.t.position.x += f.vx * dt;
      f.t.position.y += f.vy * dt;
      f.t.alpha = Math.max(0, 1 - f.age / f.life);
      f.t.scale.set(0.8 + f.age * 0.3);
    }
    for (const f of this.floaters.filter((f) => f.age >= f.life)) f.t.destroy();
    this.floaters = this.floaters.filter((f) => f.age < f.life);
  }
}

/** Where the cat's feet are in a GIF: the lowest opaque row, centred on the opaque pixels near it. */
function feetOf(source: GifSource): { x: number; y: number } {
  const { width: w, height: h } = source;
  const canvas = source.textures[0].source.resource as HTMLCanvasElement | OffscreenCanvas;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return { x: w / 2, y: h };
  const a = ctx.getImageData(0, 0, w, h).data;
  const opaque = (x: number, y: number) => a[(y * w + x) * 4 + 3] > 0;
  let bottom = -1;
  for (let y = h - 1; y >= 0 && bottom < 0; y--) for (let x = 0; x < w; x++) if (opaque(x, y)) { bottom = y; break; }
  if (bottom < 0) return { x: w / 2, y: h };
  let min = w, max = -1;
  for (let y = Math.max(0, bottom - 3); y <= bottom; y++)
    for (let x = 0; x < w; x++) if (opaque(x, y)) { min = Math.min(min, x); max = Math.max(max, x); }
  return { x: (min + max + 1) / 2, y: bottom + 1 };
}
