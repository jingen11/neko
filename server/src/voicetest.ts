import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Sentences with deliberate N4-level mistakes, used to check that speech-to-text keeps
 * learner mistakes instead of "fixing" them. Shared by the bake-off script and the
 * web page's voice test mode.
 */
export interface TestCase {
  said: string; // what is spoken (contains the mistake)
  romaji: string;
  mistake: string; // what is wrong, in English ("" for correct control sentences)
  keep: string[]; // mistake survived if the normalized transcript contains any of these
  fixed?: string[]; // the model "corrected" it if any of these appear instead
}

export const testCases: TestCase[] = [
  { said: "私は学校を行きます。", romaji: "watashi wa gakkou WO ikimasu", mistake: "wo instead of ni with iku", keep: ["学校を行", "がっこうを行", "がっこうをい"], fixed: ["学校に行", "学校へ行"] },
  { said: "昨日、友達と映画を見ます。", romaji: "kinou, tomodachi to eiga wo MIMASU", mistake: "present tense after kinou (yesterday)", keep: ["映画を見ます", "えいがをみます"], fixed: ["見ました"] },
  { said: "この本はとても面白いでした。", romaji: "kono hon wa totemo omoshiroi DESHITA", mistake: "i-adjective + deshita (should be omoshirokatta desu)", keep: ["面白いでした", "おもしろいでした"], fixed: ["面白かった", "おもしろかった"] },
  { said: "日本語が勉強しています。", romaji: "nihongo GA benkyou shite imasu", mistake: "ga instead of wo", keep: ["日本語が勉強", "にほんごが勉強", "日本語がべんきょう"], fixed: ["日本語を勉強"] },
  { said: "私は先生にプレゼントをくれました。", romaji: "watashi wa sensei ni purezento wo KUREMASHITA", mistake: "kureru for giving to someone else (should be agemashita)", keep: ["先生にプレゼントをくれ"], fixed: ["先生にプレゼントをあげ"] },
  { said: "食べるのあとで、散歩します。", romaji: "TABERU NO ato de, sanpo shimasu", mistake: "dictionary form + no before ato de (should be tabeta ato de)", keep: ["食べるのあと", "食べるの後", "たべるのあと"], fixed: ["食べたあと", "食べた後"] },
  { said: "日本に行ったのことがあります。", romaji: "nihon ni itta NO koto ga arimasu", mistake: "extra no before koto", keep: ["行ったのこと", "いったのこと"], fixed: ["行ったことが"] },
  { said: "きれいなの花ですね。", romaji: "kirei na NO hana desu ne", mistake: "extra no after na-adjective", keep: ["きれいなの花", "綺麗なの花", "きれいなのはな"], fixed: ["きれいな花", "綺麗な花"] },
  { said: "寒いだから、コートを着ます。", romaji: "samui DA kara, kooto wo kimasu", mistake: "da after i-adjective", keep: ["寒いだから", "さむいだから"], fixed: ["寒いから"] },
  { said: "静かな部屋に寝たいです。", romaji: "shizuka na heya NI netai desu", mistake: "ni instead of de for where an action happens", keep: ["部屋に寝", "へやに寝", "へやにね"], fixed: ["部屋で寝"] },
  { said: "毎朝コーヒーを飲みます。", romaji: "maiasa koohii wo nomimasu", mistake: "", keep: ["コーヒーを飲みます", "コーヒーをのみます"] },
  { said: "週末は家でゆっくり休みました。", romaji: "shuumatsu wa ie de yukkuri yasumimashita", mistake: "", keep: ["家でゆっくり休みました", "いえでゆっくり休みました", "家でゆっくりやすみました"] },
];

export type Verdict = "kept" | "fixed" | "other";

const norm = (s: string) => s.replace(/[\s、。，．,.！？!?「」]/g, "");

export function score(c: TestCase, transcript: string): Verdict {
  const t = norm(transcript);
  if (c.keep.some((k) => t.includes(norm(k)))) return "kept";
  if (c.fixed?.some((f) => t.includes(norm(f)))) return "fixed";
  return "other";
}

/** Save a voice-test recording (16-bit mono WAV) plus a log line, so it can be re-run against other models later. */
export async function saveRecording(dir: string, index: number, pcm: Buffer, sampleRate: number, transcript: string, verdict: Verdict) {
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = `${stamp}-case${String(index + 1).padStart(2, "0")}.wav`;
  await writeFile(path.join(dir, file), wavFile(pcm, sampleRate));
  await appendFile(path.join(dir, "results.jsonl"), JSON.stringify({ at: new Date().toISOString(), case: index + 1, said: testCases[index].said, transcript, verdict, file }) + "\n");
  return file;
}

function wavFile(pcm: Buffer, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
