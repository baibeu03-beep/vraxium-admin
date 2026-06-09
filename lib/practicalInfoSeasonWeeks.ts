// 실무 정보 라인 개설 — 상단 현재 상황 / 주차별 개설 결과 공용 주차 계산·포맷 (browser-safe).
//
// "금요일 경계" 규칙(표시용, 2026-06-09):
//   - 월·화·수·목 접속: 개설 필요 = 지난 주차(N-1), 개설 이행 = 이번 주차(N)
//   - 금·토·일   접속: 개설 필요 = 이번 주차(N),   개설 이행 = 이번 주차(N) (동일)
//   → 개설 이행 = 항상 현재 주차 N. 개설 필요만 요일로 갈린다.
//
// ⚠ 표시 전용 — 실제 저장 강제 주차 정책(describeOpenableWeek=목요일 경계)·snapshot·demoUserId 무관.
// 주차/기간 SoT = /admin/season-weeks (GET /api/admin/season-weeks). 하드코딩 없음(오늘 날짜가
// 어떤 week range 에 속하는지로 현재 주차를 찾는다).

export type SeasonWeekRow = {
  week_id?: string;
  season_name: string | null;
  week_number: number | null;
  week_start_date: string | null;
  week_end_date: string | null;
  is_current_week?: boolean;
};

export const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"] as const;

const pad2 = (n: number) => String(n).padStart(2, "0");
export const yy2 = (year: number) => pad2(((year % 100) + 100) % 100);

// date-only ISO 의 요일(UTC 기준 — date 문자열은 season-weeks 와 동일 컨벤션).
export function dowOfIso(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}
export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
// "26-06-29(월)"
export function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${m[1].slice(2)}-${m[2]}-${m[3]}(${DAY_NAMES[dowOfIso(iso)]})`;
}
// season-weeks season_name 은 "2026년도 봄시즌" 처럼 연도 포함 → 표시("26년 …")용으로 앞쪽 "YYYY년도" 제거.
export function seasonLabelOnly(seasonName: string | null): string {
  if (!seasonName) return "-";
  return seasonName.replace(/^\s*\d{4}\s*년도\s*/, "").trim() || seasonName;
}
// "26년 봄시즌 14주차"
export function weekName(w: SeasonWeekRow): string {
  const year = w.week_start_date ? Number(w.week_start_date.slice(0, 4)) : NaN;
  const yLabel = Number.isFinite(year) ? `${yy2(year)}년 ` : "";
  return `${yLabel}${seasonLabelOnly(w.season_name)} ${w.week_number ?? "-"}주차`;
}
// "26-06-29(월) ~ 26-07-05(일)"
export function weekRange(w: SeasonWeekRow): string {
  if (!w.week_start_date || !w.week_end_date) return "-";
  return `${fmtDate(w.week_start_date)} ~ ${fmtDate(w.week_end_date)}`;
}
// "26년 봄시즌 14주차 (26-06-29(월) ~ 26-07-05(일))"
export function weekFull(w: SeasonWeekRow | null): string {
  return w ? `${weekName(w)} (${weekRange(w)})` : "—";
}

export type OpenNeedComputed = {
  todayLabel: string;
  current: SeasonWeekRow | null; // 오늘이 속한 주차 N
  need: SeasonWeekRow | null; // 개설 필요 기간
  fulfil: SeasonWeekRow | null; // 개설 이행 기간 (= N)
};

// 금요일 경계로 개설 필요/이행 주차를 계산. now 는 접속 로컬 시각.
export function computeOpenNeed(
  rows: SeasonWeekRow[],
  now: Date,
): OpenNeedComputed {
  const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const dow = now.getDay(); // 0=일 … 6=토 (로컬)
  const todayLabel = `${yy2(now.getFullYear())}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}(${DAY_NAMES[dow]})`;

  const current =
    rows.find(
      (r) =>
        r.week_start_date != null &&
        r.week_end_date != null &&
        r.week_start_date <= today &&
        today <= r.week_end_date,
    ) ?? null;

  if (!current) return { todayLabel, current: null, need: null, fulfil: null };

  const prevStart = current.week_start_date
    ? addDaysIso(current.week_start_date, -7)
    : null;
  const prevWeek = prevStart
    ? rows.find((r) => r.week_start_date === prevStart) ?? null
    : null;

  const isMonThu = dow >= 1 && dow <= 4;
  const need = isMonThu ? prevWeek : current;
  const fulfil = current; // 개설 이행 = 항상 현재 주차 N

  return { todayLabel, current, need, fulfil };
}
