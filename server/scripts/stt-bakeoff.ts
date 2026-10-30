/**
 * STT bake-off: does the model keep a learner's grammar mistakes, or "fix" them?
 *
 * VOICEVOX speaks sentences that contain deliberate N4-level mistakes; each STT server
 * transcribes the same audio. A mistake is "kept" if the wrong form appears in the transcript.
 *
 *   node scripts/stt-bakeoff.ts reazonspeech=ws://127.0.0.1:6006 sensevoice=ws://127.0.0.1:6007 [--ja]
 *
 * Output is romaji by default; pass --ja to also print the Japanese transcripts.
 * Synthetic speech is cleaner than a real learner's voice, so treat this as a first filter;
 * the real test is your own voice in the web page's Voice test tab.
 */
import { readWav, transcribe } from "../src/stt.ts";
import { speak } from "../src/tts.ts";
import { score, testCases, type Verdict } from "../src/voicetest.ts";

const args = process.argv.slice(2);
const showJa = args.includes("--ja");
const servers = args
  .filter((a) => a.includes("="))
  .map((arg) => {
    const [name, url] = arg.split("=");
    return { name, url };
  });
if (!servers.length) {
  console.error("usage: node scripts/stt-bakeoff.ts name=ws://host:port [name=ws://host:port ...] [--ja]");
  process.exit(1);
}

const icons: Record<Verdict, string> = { kept: "✅ kept", fixed: "❌ FIXED", other: "⚠️  other" };
const totals: Record<string, Record<Verdict, number> & { ms: number }> = {};
for (const s of servers) totals[s.name] = { kept: 0, fixed: 0, other: 0, ms: 0 };

for (const c of testCases) {
  const { wav } = await speak(c.said);
  const { samples: speech, sampleRate } = readWav(wav);
  // Real recordings start and end with a little silence; TTS audio doesn't.
  const pad = Math.round(sampleRate * 0.3);
  const samples = new Float32Array(speech.length + 2 * pad);
  samples.set(speech, pad);

  console.log(`\n🗣  ${c.romaji}${c.mistake ? `   (${c.mistake})` : "   (correct)"}`);
  for (const s of servers) {
    const r = await transcribe(samples, sampleRate, s.url);
    const verdict = score(c, r.text);
    totals[s.name][verdict]++;
    totals[s.name].ms += r.ms;
    console.log(`   ${s.name.padEnd(13)} ${icons[verdict].padEnd(9)} ${String(r.ms).padStart(5)}ms${showJa ? `  ${r.text}` : ""}`);
  }
}

const n = testCases.length;
console.log(`\n── summary (${n} sentences: ${testCases.filter((c) => c.mistake).length} with mistakes + ${testCases.filter((c) => !c.mistake).length} correct controls) ──`);
for (const [name, t] of Object.entries(totals)) {
  console.log(`${name.padEnd(13)} kept ${t.kept}/${n} · auto-fixed ${t.fixed} · other ${t.other} · avg ${Math.round(t.ms / n)}ms`);
}
