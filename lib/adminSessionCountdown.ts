// Pure formatter for the "time until auto-logout" countdown. Kept side-effect
// free (no Date.now, no DOM) so it can be unit-tested and shares no state — the
// remaining-ms value is derived from the single session SoT (AdminSessionProvider).

export type CountdownLevel = "normal" | "warning" | "danger";

export type CountdownView = {
  // mm:ss, zero-padded, clamped to >= 00:00.
  text: string;
  // normal (> 5min), warning (<= 5min, orange), danger (<= 1min, red).
  level: CountdownLevel;
};

const FIVE_MIN_MS = 5 * 60 * 1000;
const ONE_MIN_MS = 1 * 60 * 1000;

export function formatRemaining(remainingMs: number): CountdownView {
  const clamped = Math.max(0, remainingMs);
  // ceil so a full window reads "20:00" and it only shows 00:00 at true zero.
  const totalSeconds = Math.ceil(clamped / 1000);
  const mm = Math.floor(totalSeconds / 60);
  const ss = totalSeconds % 60;
  const text = `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;

  let level: CountdownLevel = "normal";
  if (clamped <= ONE_MIN_MS) {
    level = "danger";
  } else if (clamped <= FIVE_MIN_MS) {
    level = "warning";
  }

  return { text, level };
}
