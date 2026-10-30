import { config } from "./config.ts";

export interface SpeakOptions {
  speaker?: number;
  /** 1.0 = normal; listening practice uses ~0.75 for "slow". */
  speed?: number;
}

/** Japanese text → WAV (16-bit mono, 24 kHz) via the VOICEVOX engine. */
export async function speak(text: string, opts: SpeakOptions = {}): Promise<{ wav: Buffer; ms: number }> {
  const t0 = performance.now();
  const speaker = opts.speaker ?? config.voicevoxSpeaker;
  const q = await fetch(`${config.voicevoxUrl}/audio_query?speaker=${speaker}&text=${encodeURIComponent(text)}`, { method: "POST" });
  if (!q.ok) throw new Error(`VOICEVOX audio_query failed: ${q.status} ${await q.text()}`);
  const query = await q.json();
  if (opts.speed) query.speedScale = opts.speed;

  const s = await fetch(`${config.voicevoxUrl}/synthesis?speaker=${speaker}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(query),
  });
  if (!s.ok) throw new Error(`VOICEVOX synthesis failed: ${s.status} ${await s.text()}`);
  return { wav: Buffer.from(await s.arrayBuffer()), ms: Math.round(performance.now() - t0) };
}

/** Available voices as a flat list of {id, name}. */
export async function listVoices(): Promise<{ id: number; name: string }[]> {
  const res = await fetch(`${config.voicevoxUrl}/speakers`);
  if (!res.ok) throw new Error(`VOICEVOX /speakers failed: ${res.status}`);
  const speakers = (await res.json()) as { name: string; styles: { id: number; name: string }[] }[];
  return speakers.flatMap((sp) => sp.styles.map((st) => ({ id: st.id, name: `${sp.name}（${st.name}）` })));
}
