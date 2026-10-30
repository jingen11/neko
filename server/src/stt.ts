import { config } from "./config.ts";

export interface SttResult {
  text: string;
  ms: number;
}

/**
 * Transcribe mono audio with the sherpa-onnx offline WebSocket server.
 * Protocol: one binary message = int32 sample rate + int32 byte length + float32 samples (little endian);
 * the server replies with one text message (JSON with a `text` field), then we send "Done".
 */
export function transcribe(samples: Float32Array, sampleRate: number, url = config.sttUrl): Promise<SttResult> {
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("speech-to-text timed out"));
    }, 30_000);

    ws.onopen = () => {
      const header = new DataView(new ArrayBuffer(8));
      header.setInt32(0, sampleRate, true);
      header.setInt32(4, samples.byteLength, true);
      const msg = new Uint8Array(8 + samples.byteLength);
      msg.set(new Uint8Array(header.buffer), 0);
      msg.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), 8);
      ws.send(msg);
    };
    ws.onmessage = (ev) => {
      clearTimeout(timer);
      const raw = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
      let text = raw;
      try {
        text = JSON.parse(raw).text ?? raw;
      } catch {
        // plain-text reply
      }
      ws.send("Done");
      ws.close();
      resolve({ text: text.trim(), ms: Math.round(performance.now() - t0) });
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`speech-to-text server unreachable at ${url}`));
    };
  });
}

/** 16-bit PCM bytes → float samples in [-1, 1]. */
export function int16ToFloat32(buf: Buffer): Float32Array {
  const n = Math.floor(buf.byteLength / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

/** Minimal WAV reader for 16-bit PCM mono (what VOICEVOX produces). */
export function readWav(buf: Buffer): { samples: Float32Array; sampleRate: number } {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let sampleRate = 0;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      sampleRate = buf.readUInt32LE(pos + 12);
      const channels = buf.readUInt16LE(pos + 10);
      const bits = buf.readUInt16LE(pos + 22);
      if (channels !== 1 || bits !== 16) throw new Error(`unsupported WAV: ${channels}ch ${bits}-bit`);
    } else if (id === "data") {
      return { samples: int16ToFloat32(buf.subarray(pos + 8, pos + 8 + size)), sampleRate };
    }
    pos += 8 + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}
