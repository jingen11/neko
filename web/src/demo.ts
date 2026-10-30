import type { ServerMessage } from "../../shared/protocol.ts";

/** Sample messages for /?demo, so the screen can be seen without the neko server. Not real data. */
export function run(onMessage: (m: ServerMessage) => void, wake: () => void, userSays: (text: string) => void, ask: (text: string) => void) {
  const stats = { name: "ねこ", hunger: 58, happiness: 64, streak: 6, practicedToday: 3, level: "N5" };
  wake();
  onMessage({ type: "state", anim: "idle", mood: "happy", stats });
  onMessage({ type: "say", id: "d1", ja: "きょうは なにを たべた？", en: "What did you eat today?", mood: "curious" });
  userSays("ラーメンを食べたでした。");
  onMessage({
    type: "correction",
    text: "ラーメンを食べたでした。",
    is_correct: false,
    corrected: "ラーメンを食べました。",
    natural: "",
    mistakes: [
      { type: "conjugation", original: "食べたでした", fix: "食べました", grammar_point: "Polite past: 〜ました", explanation: "The polite past of 食べる is 食べました. た and でした both mark the past, so use one." },
    ],
  });
  onMessage({ type: "say", id: "d2", ja: "いいね！ どこで たべたの？", en: "Nice! Where did you eat it?", mood: "excited" });
  userSays("駅の近くで食べました。");
  onMessage({ type: "correction", text: "駅の近くで食べました。", is_correct: true, corrected: "駅の近くで食べました。", natural: "", mistakes: [] });
  onMessage({ type: "say", id: "d3", ja: "えきの ちかく、いいね。また いっしょに いこう！", en: "Near the station, nice. Let's go together next time!", mood: "happy" });
  userSays("はい、明日は行きたいです。");
  onMessage({
    type: "correction",
    text: "はい、明日は行きたいです。",
    is_correct: false,
    corrected: "はい、明日行きたいです。",
    natural: "うん、明日行こう！",
    mistakes: [
      { type: "particle", original: "明日は", fix: "明日", grammar_point: "Time words without は", explanation: "は here sets tomorrow against other days. A plain plan needs no particle after 明日." },
    ],
  });
  onMessage({ type: "state", anim: "happy", mood: "happy", stats: { ...stats, hunger: 43, practicedToday: 4, happiness: 69 } });
  ask("When do I drop は after time words like 明日?");
  onMessage({
    type: "answer",
    question: "When do I drop は after time words like 明日?",
    text: "Use **は** after a time word only when you contrast it with another time.\n- 明日行きたいです。 (I want to go tomorrow.)\n- 明日は行きたいです。 (Tomorrow, at least, I want to go.)\nYou added は after 明日 twice this week, both times for a plain plan.",
    source: "hermes",
    model: "Claude Opus 5.5",
    ms: 8400,
  });
}
