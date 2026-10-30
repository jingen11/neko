/**
 * STT bake-off: does the model keep a learner's grammar mistakes, or "fix" them?
 *
 * VOICEVOX speaks sentences that contain deliberate N4-level mistakes; each STT server
 * transcribes the same audio. A mistake is "kept" if the wrong form appears in the transcript.
 *
 *   node scripts/stt-bakeoff.ts reazonspeech=ws://127.0.0.1:6006 sensevoice=ws://127.0.0.1:6007
 *
 * Synthetic speech is cleaner than a real learner's voice, so treat this as a first filter;
 * the real test is your own voice through the web page.
 */
import { readWav, transcribe } from "../src/stt.ts";
import { speak } from "../src/tts.ts";

interface Case {
  said: string; // what is spoken (contains the mistake)
  keep: string[]; // the mistake survived if the normalized transcript contains any of these
  fixed?: string[]; // the model "corrected" it if any of these appear instead
}

const cases: Case[] = [
  { said: "私は学校を行きます。", keep: ["学校を行", "がっこうを行", "がっこうをい"], fixed: ["学校に行", "学校へ行"] },
  { said: "昨日、友達と映画を見ます。", keep: ["映画を見ます", "えいがをみます"], fixed: ["見ました"] },
  { said: "この本はとても面白いでした。", keep: ["面白いでした", "おもしろいでした"], fixed: ["面白かった", "おもしろかった"] },
  { said: "日本語が勉強しています。", keep: ["日本語が勉強", "にほんごが勉強", "日本語がべんきょう"], fixed: ["日本語を勉強"] },
  { said: "私は先生にプレゼントをくれました。", keep: ["先生にプレゼントをくれ"], fixed: ["先生にプレゼントをあげ"] },
  { said: "食べるのあとで、散歩します。", keep: ["食べるのあと", "食べるの後", "たべるのあと"], fixed: ["食べたあと", "食べた後"] },
  { said: "日本に行ったのことがあります。", keep: ["行ったのこと", "いったのこと"], fixed: ["行ったことが"] },
  { said: "きれいなの花ですね。", keep: ["きれいなの花", "綺麗なの花", "きれいなのはな"], fixed: ["きれいな花", "綺麗な花"] },
  { said: "寒いだから、コートを着ます。", keep: ["寒いだから", "さむいだから"], fixed: ["寒いから"] },
  { said: "静かな部屋に寝たいです。", keep: ["部屋に寝", "へやに寝", "へやにね"], fixed: ["部屋で寝"] },
  // controls: correct sentences, should come back unchanged
  { said: "毎朝コーヒーを飲みます。", keep: ["コーヒーを飲みます", "コーヒーをのみます"] },
  { said: "週末は家でゆっくり休みました。", keep: ["家でゆっくり休みました", "いえでゆっくり休みました", "家でゆっくりやすみました"] },
];

const norm = (s: string) => s.replace(/[\s、。，．,.！？!?「」]/g, "");

const servers = process.argv.slice(2).map((arg) => {
  const [name, url] = arg.split("=");
  return { name, url };
});
if (!servers.length) {
  console.error("usage: node scripts/stt-bakeoff.ts name=ws://host:port [name=ws://host:port ...]");
  process.exit(1);
}

const score: Record<string, { kept: number; fixed: number; other: number; ms: number }> = {};
for (const s of servers) score[s.name] = { kept: 0, fixed: 0, other: 0, ms: 0 };

for (const c of cases) {
  const { wav } = await speak(c.said);
  const { samples, sampleRate } = readWav(wav);
  console.log(`\n🗣  ${c.said}`);
  for (const s of servers) {
    const r = await transcribe(samples, sampleRate, s.url);
    const t = norm(r.text);
    const verdict = c.keep.some((k) => t.includes(norm(k))) ? "kept" : c.fixed?.some((f) => t.includes(norm(f))) ? "fixed" : "other";
    score[s.name][verdict]++;
    score[s.name].ms += r.ms;
    const icon = { kept: "✅ kept", fixed: "❌ FIXED", other: "⚠️  other" }[verdict];
    console.log(`   ${s.name.padEnd(13)} ${icon.padEnd(9)} ${String(r.ms).padStart(5)}ms  ${r.text}`);
  }
}

console.log("\n── summary (" + cases.length + " sentences, 10 with mistakes + 2 correct controls) ──");
for (const [name, s] of Object.entries(score)) {
  console.log(`${name.padEnd(13)} kept ${s.kept}/${cases.length} · auto-fixed ${s.fixed} · other ${s.other} · avg ${Math.round(s.ms / cases.length)}ms`);
}
