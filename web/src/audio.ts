/**
 * Browser audio: microphone capture (streamed as 16-bit PCM) and playback of the pet's voice,
 * with a level meter for lip-sync.
 */
const workletSource = `class Rec extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
} registerProcessor("rec", Rec);`;

export class AudioIO {
  private ctx!: AudioContext;
  private analyser!: AnalyserNode;
  private levelBuf = new Float32Array(1024);

  // voice playback
  private voiceChunks: Int16Array[] = [];
  private voiceRate = 24000;
  private source?: AudioBufferSourceNode;

  // microphone
  private micReady?: Promise<void>;
  private micNode?: AudioWorkletNode;
  private onMic?: (pcm: Int16Array<ArrayBuffer>) => void;
  private micPending: Float32Array[] = [];
  private micPendingLen = 0;

  /** Must be called from a user gesture (browsers block audio until then). */
  async init() {
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.connect(this.ctx.destination);
    await this.ctx.resume();
  }

  get sampleRate() {
    return this.ctx.sampleRate;
  }

  // ── voice ──────────────────────────────────────────────────
  voiceStart(rate: number) {
    this.voiceChunks = [];
    this.voiceRate = rate;
  }

  voicePush(frame: ArrayBuffer) {
    this.voiceChunks.push(new Int16Array(frame));
  }

  /** Play everything received since voiceStart. Resolves when playback ends. */
  voiceEnd(): Promise<void> {
    const total = this.voiceChunks.reduce((n, c) => n + c.length, 0);
    if (!total) return Promise.resolve();
    const buf = this.ctx.createBuffer(1, total, this.voiceRate);
    const ch = buf.getChannelData(0);
    let o = 0;
    for (const c of this.voiceChunks) for (let i = 0; i < c.length; i++) ch[o++] = c[i] / 32768;
    this.voiceChunks = [];
    this.stopVoice();
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.analyser);
    this.source = src;
    return new Promise((resolve) => {
      src.onended = () => {
        if (this.source === src) this.source = undefined;
        resolve();
      };
      src.start();
    });
  }

  stopVoice() {
    try {
      this.source?.stop();
    } catch {
      // already stopped
    }
    this.source = undefined;
  }

  /** Loudness of the pet's voice right now, 0..1. */
  level(): number {
    if (!this.source) return 0;
    this.analyser.getFloatTimeDomainData(this.levelBuf);
    let sum = 0;
    for (const v of this.levelBuf) sum += v * v;
    return Math.min(1, Math.sqrt(sum / this.levelBuf.length) * 5);
  }

  // ── microphone ─────────────────────────────────────────────
  private async initMic() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    await this.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([workletSource], { type: "text/javascript" })));
    const node = new AudioWorkletNode(this.ctx, "rec");
    node.port.onmessage = (e: MessageEvent<Float32Array>) => this.onMicFrame(e.data);
    this.ctx.createMediaStreamSource(stream).connect(node);
    this.micNode = node;
  }

  /** Start streaming the mic as 16-bit PCM at `sampleRate`, in ~100 ms chunks. */
  async startMic(onChunk: (pcm: Int16Array<ArrayBuffer>) => void) {
    this.micReady ??= this.initMic();
    await this.micReady;
    this.micPending = [];
    this.micPendingLen = 0;
    this.onMic = onChunk;
  }

  stopMic() {
    this.flushMic();
    this.onMic = undefined;
  }

  private onMicFrame(f: Float32Array) {
    if (!this.onMic) return;
    this.micPending.push(f);
    this.micPendingLen += f.length;
    if (this.micPendingLen >= this.ctx.sampleRate / 10) this.flushMic();
  }

  private flushMic() {
    if (!this.onMic || !this.micPendingLen) return;
    const out = new Int16Array(this.micPendingLen);
    let o = 0;
    for (const f of this.micPending) for (let i = 0; i < f.length; i++) out[o++] = Math.max(-1, Math.min(1, f[i])) * 32767;
    this.micPending = [];
    this.micPendingLen = 0;
    this.onMic(out);
  }
}
