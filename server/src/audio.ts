/** Small PCM helpers. All audio in neko is 16-bit little-endian mono. */

/** Extract 16-bit mono PCM and its sample rate from a WAV file (what VOICEVOX returns). */
export function wavToPcm16(buf: Buffer): { pcm: Int16Array; rate: number } {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let rate = 0;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      rate = buf.readUInt32LE(pos + 12);
      if (buf.readUInt16LE(pos + 10) !== 1 || buf.readUInt16LE(pos + 22) !== 16) throw new Error("expected 16-bit mono WAV");
    } else if (id === "data") {
      const data = buf.subarray(pos + 8, pos + 8 + size);
      const pcm = new Int16Array(data.length >> 1);
      for (let i = 0; i < pcm.length; i++) pcm[i] = data.readInt16LE(i * 2);
      return { pcm, rate };
    }
    pos += 8 + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

/** Linear-interpolation resampler; good enough for speech going to small speakers. */
export function resample(input: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return input;
  const out = new Int16Array(Math.floor((input.length * to) / from));
  const step = from / to;
  for (let i = 0; i < out.length; i++) {
    const x = i * step;
    const j = Math.floor(x);
    const a = input[j] ?? 0;
    const b = input[j + 1] ?? a;
    out[i] = Math.round(a + (b - a) * (x - j));
  }
  return out;
}

export function int16ToFloat32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}

/** Push-to-talk audio can start right on the first word, which the STT model then misses; pad with 0.3 s of silence. */
export function padSilence(speech: Float32Array, rate: number): Float32Array {
  const pad = Math.round(rate * 0.3);
  const out = new Float32Array(speech.length + 2 * pad);
  out.set(speech, pad);
  return out;
}
