// Pure formatter for the "time until auto-logout" countdown. Kept side-effect
// free (no Date.now, no DOM) so it can be unit-tested and shares no state — the
// remaining-ms value is derived from the single session SoT (AdminSessionProvider).

export type CountdownLevel = "normal" | "warning" | "danger";

export type CountdownView = {
  // 한글 단위 표기("19분 58초"), clamped to >= "0초". mm:ss 표기는 시각(19시 58분)으로
  // 오해되는 사례가 있어 단위를 명시한다 — 1분 미만은 분을 생략("43초"), 1시간 이상은
  // "1시간 19분 58초".
  text: string;
  // normal (> 5min), warning (<= 5min, orange), danger (<= 1min, red).
  level: CountdownLevel;
};

const FIVE_MIN_MS = 5 * 60 * 1000;
const ONE_MIN_MS = 1 * 60 * 1000;

export function formatRemaining(remainingMs: number): CountdownView {
  const clamped = Math.max(0, remainingMs);
  // ceil so a full window reads "20분 0초" and it only shows "0초" at true zero.
  const totalSeconds = Math.ceil(clamped / 1000);
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor((totalSeconds % 3600) / 60);
  const ss = totalSeconds % 60;
  const text =
    hh > 0 ? `${hh}시간 ${mm}분 ${ss}초` : mm > 0 ? `${mm}분 ${ss}초` : `${ss}초`;

  let level: CountdownLevel = "normal";
  if (clamped <= ONE_MIN_MS) {
    level = "danger";
  } else if (clamped <= FIVE_MIN_MS) {
    level = "warning";
  }

  return { text, level };
}
