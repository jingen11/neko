import { Application, Container, Graphics, Text } from "pixi.js";
import type { Anim, Mood } from "../../shared/protocol.ts";

/**
 * The pet, drawn and animated in code (no sprite art yet).
 * Local coordinates: the cat is centred on (0, 0), feet at y ≈ 125, roughly 300×300 units.
 */
const C = {
  fur: 0xf4a259,
  furDark: 0xd9803a,
  belly: 0xfde8cf,
  earInner: 0xf7b6b0,
  eye: 0x2b2622,
  nose: 0xe0706a,
  mouth: 0x6b2d2a,
  tongue: 0xee8a86,
  blush: 0xf59a9a,
  whisker: 0x8a6a55,
};

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
  private head = new Container();
  private tail = new Graphics();
  private body = new Graphics();
  private leftEar = new Graphics();
  private rightEar = new Graphics();
  private eyes = new Graphics();
  private mouth = new Graphics();
  private extras = new Graphics(); // tear, thought dots, fish
  private fx = new Container(); // floating hearts / Zzz
  private floaters: Floater[] = [];

  private anim: Anim = "idle";
  private mood: Mood = "happy";
  private t = 0;
  private nextBlink = 2;
  private blinkUntil = 0;
  private nextFloater = 0;
  private mouthOpen = 0;
  private stroke = { down: false, x: 0, y: 0, dist: 0 };

  constructor(
    private app: Application,
    private voiceLevel: () => number,
    private onPet: () => void,
  ) {
    this.build();
    app.stage.addChild(this.root);
    app.ticker.add((tk) => this.update(tk.deltaMS / 1000));
    this.layout();
    app.renderer.on("resize", () => this.layout());
  }

  setState(anim: Anim, mood: Mood) {
    this.anim = anim;
    this.mood = mood;
  }

  private build() {
    const shadow = new Graphics().ellipse(0, 128, 95, 12).fill({ color: 0x000000, alpha: 0.12 });
    this.body
      .ellipse(0, 70, 82, 62).fill(C.fur)
      .ellipse(0, 86, 46, 36).fill(C.belly)
      .ellipse(-36, 124, 20, 11).fill(C.fur)
      .ellipse(36, 124, 20, 11).fill(C.fur);

    // ears pivot at their base so they can perk up / droop
    this.drawEar(this.leftEar, -1);
    this.drawEar(this.rightEar, 1);
    this.leftEar.position.set(-42, -48);
    this.rightEar.position.set(42, -48);

    const face = new Graphics()
      .ellipse(0, -5, 78, 66).fill(C.fur)
      // tabby stripes
      .moveTo(-14, -66).lineTo(-10, -46).stroke({ width: 5, color: C.furDark, cap: "round" })
      .moveTo(0, -70).lineTo(0, -48).stroke({ width: 5, color: C.furDark, cap: "round" })
      .moveTo(14, -66).lineTo(10, -46).stroke({ width: 5, color: C.furDark, cap: "round" })
      .ellipse(-46, 16, 13, 8).fill({ color: C.blush, alpha: 0.55 })
      .ellipse(46, 16, 13, 8).fill({ color: C.blush, alpha: 0.55 })
      .poly([-7, 8, 7, 8, 0, 15]).fill(C.nose);
    // whiskers
    for (const side of [-1, 1]) {
      for (const dy of [-4, 6]) {
        face.moveTo(side * 34, 14 + dy * 0.3).lineTo(side * 78, 8 + dy).stroke({ width: 2, color: C.whisker, alpha: 0.7 });
      }
    }

    this.head.position.set(0, -10);
    this.head.addChild(this.leftEar, this.rightEar, face, this.eyes, this.mouth);
    this.cat.addChild(this.tail, this.body, this.head, this.extras);
    this.root.addChild(shadow, this.cat, this.fx);

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

  private drawEar(g: Graphics, side: -1 | 1) {
    g.poly([side * -22, 12, side * 6, -46, side * 30, 4]).fill(C.fur);
    g.poly([side * -10, 6, side * 6, -30, side * 20, 2]).fill(C.earInner);
  }

  private layout() {
    const { width, height } = this.app.screen;
    const s = Math.min(width / 340, height / 330);
    this.root.scale.set(s);
    this.root.position.set(width / 2, height / 2 - 5 * s);
  }

  private update(dt: number) {
    this.t += dt;
    const t = this.t;
    const a = this.anim;

    // ── whole-body motion ──
    let y = 0;
    let squash = 1 + Math.sin(t * 2) * 0.015; // breathing
    if (a === "happy" || a === "petted") y = -Math.abs(Math.sin(t * 7)) * 10;
    if (a === "eat") y = -Math.abs(Math.sin(t * 10)) * 3;
    if (a === "sleep") {
      y = 14;
      squash = 0.92 + Math.sin(t * 1.2) * 0.025;
    }
    this.cat.position.y = y;
    this.body.scale.y = squash;
    this.body.position.y = (1 - squash) * 120;

    // ── head ──
    let tilt = Math.sin(t * 0.7) * 0.03;
    if (a === "listen") tilt = 0.14;
    if (a === "think") tilt = -0.08 + Math.sin(t * 1.5) * 0.03;
    if (a === "sad") tilt = -0.05;
    if (a === "petted") tilt = Math.sin(t * 10) * 0.06;
    if (a === "sleep") tilt = 0.1;
    this.head.rotation = lerp(this.head.rotation, tilt, dt * 6);

    // ── ears ──
    let ear = Math.sin(t * 0.9) * 0.03;
    if (a === "listen") ear = -0.25;
    if (a === "sad" || a === "sleep") ear = 0.55;
    if (a === "happy" || a === "petted") ear = -0.1 + Math.sin(t * 12) * 0.05;
    this.leftEar.rotation = lerp(this.leftEar.rotation, -ear, dt * 8);
    this.rightEar.rotation = lerp(this.rightEar.rotation, ear, dt * 8);

    // ── tail ──
    const speed = a === "happy" || a === "petted" ? 7 : a === "sleep" ? 0.6 : a === "sad" ? 1 : 2;
    const sway = Math.sin(t * speed) * (a === "sleep" ? 5 : 22);
    const tailUp = a === "sad" ? 50 : a === "sleep" ? 95 : 0;
    this.tail.clear()
      .moveTo(62, 100)
      .bezierCurveTo(130, 90, 110 + sway * 0.4, 20 + tailUp, 120 + sway, -10 + tailUp)
      .stroke({ width: 17, color: C.fur, cap: "round" })
      .moveTo(118 + sway * 0.95, -2 + tailUp)
      .lineTo(120 + sway, -10 + tailUp)
      .stroke({ width: 17, color: C.furDark, cap: "round" });

    this.drawEyes(dt);
    this.drawMouth(dt);
    this.drawExtras();
    this.updateFloaters(dt);
  }

  private drawEyes(_dt: number) {
    const t = this.t;
    const a = this.anim;
    if (t > this.nextBlink) {
      this.blinkUntil = t + 0.13;
      this.nextBlink = t + 2 + Math.random() * 4;
    }
    const g = this.eyes.clear();
    const xs = [-27, 27];
    if (a === "sleep" || t < this.blinkUntil) {
      for (const x of xs) g.moveTo(x - 10, -4).quadraticCurveTo(x, 2, x + 10, -4).stroke({ width: 4, color: C.eye, cap: "round" });
    } else if (a === "happy" || a === "petted" || a === "eat") {
      for (const x of xs) g.moveTo(x - 10, -2).quadraticCurveTo(x, -14, x + 10, -2).stroke({ width: 4.5, color: C.eye, cap: "round" });
    } else {
      const look = a === "think" ? { x: 4, y: -5 } : a === "listen" ? { x: -2, y: -1 } : { x: Math.sin(t * 0.4) * 1.5, y: 0 };
      const h = a === "sad" ? 10 : 14;
      for (const x of xs) {
        g.ellipse(x + look.x, -5 + look.y, 10, h).fill(C.eye);
        g.circle(x + look.x + 3, -10 + look.y, 3.5).fill(0xffffff);
      }
      if (a === "sad") for (const x of xs) g.moveTo(x - 12, -22).lineTo(x + 10, -18 * (x < 0 ? 0.85 : 1.15)).stroke({ width: 3, color: C.eye, cap: "round" });
    }
  }

  private drawMouth(dt: number) {
    const a = this.anim;
    let target = 0;
    if (a === "talk") target = Math.max(this.voiceLevel(), 0.05);
    if (a === "eat") target = (Math.sin(this.t * 14) + 1) * 0.35;
    if (a === "happy" || a === "petted") target = 0.25;
    this.mouthOpen = lerp(this.mouthOpen, target, Math.min(1, dt * 18));
    const g = this.mouth.clear();
    const open = this.mouthOpen;
    if (open > 0.08) {
      g.ellipse(0, 24 + open * 6, 9 + open * 4, 3 + open * 13).fill(C.mouth);
      g.ellipse(0, 26 + open * 12, 6 + open * 2, 2 + open * 5).fill(C.tongue);
    } else if (a === "sad") {
      g.moveTo(-9, 28).quadraticCurveTo(0, 20, 9, 28).stroke({ width: 3, color: C.mouth, cap: "round" });
    } else {
      // the classic cat "ω" mouth
      g.moveTo(-12, 19).quadraticCurveTo(-6, 27, 0, 19).quadraticCurveTo(6, 27, 12, 19).stroke({ width: 3, color: C.mouth, cap: "round" });
    }
  }

  private drawExtras() {
    const t = this.t;
    const g = this.extras.clear();
    if (this.anim === "think") {
      for (let i = 0; i < 3; i++) {
        const pulse = (Math.sin(t * 4 - i * 0.8) + 1) / 2;
        g.circle(70 + i * 22, -110 - i * 14, 6 + i * 2).fill({ color: 0xffffff, alpha: 0.5 + pulse * 0.5 }).stroke({ width: 2, color: 0xcfc4b8 });
      }
    }
    if (this.anim === "sad" || this.mood === "sad") {
      const drip = (t * 25) % 40;
      g.ellipse(-36, 6 + drip, 4, 6).fill({ color: 0x7cc0f0, alpha: 1 - drip / 40 });
    }
    if (this.anim === "eat") {
      // a little fish being eaten
      const bite = (Math.sin(t * 14) + 1) * 2;
      g.ellipse(0, 52, 24 - bite, 10).fill(0x7aa7d6);
      g.poly([22 - bite, 52, 36, 42, 36, 62]).fill(0x5b8ec4);
      g.circle(-12, 49, 2.5).fill(0x1c2a3a);
    }
  }

  private updateFloaters(dt: number) {
    const a = this.anim;
    const emoji = a === "petted" ? "💗" : a === "sleep" ? "💤" : a === "listen" ? "♪" : a === "happy" ? "✨" : null;
    if (emoji && this.t > this.nextFloater) {
      this.nextFloater = this.t + (a === "sleep" ? 1.4 : a === "petted" ? 0.25 : 0.7);
      const t = new Text({ text: emoji, style: { fontSize: a === "sleep" ? 30 : 24, fill: 0x8a8079 } });
      t.anchor.set(0.5);
      t.position.set((a === "sleep" ? 60 : (Math.random() - 0.5) * 140), -90);
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

const lerp = (a: number, b: number, k: number) => a + (b - a) * Math.min(1, k);
