// 실무 정보 라인 개설 — 상단 현재 상황 / 주차별 개설 결과 공용 주차 계산·포맷 (browser-safe).
//
// "금요일 경계" 규칙(2026-06-09 확정 — 표시·강제 단일 SoT):
//   - 월·화·수·목 접속: 개설 필요 = 지난 주차(N-1), 개설 이행 = 이번 주차(N)
//   - 금·토·일   접속: 개설 필요 = 이번 주차(N),   개설 이행 = 이번 주차(N) (동일)
//   → 개설 이행 = 항상 현재 주차 N. 개설 필요만 요일로 갈린다.
//
// ⚠ 실제 저장 강제 주차 정책(describeOpenableWeek=getOpenableWeekStartMs, 금요일 경계)과
//   동일 경계를 쓴다(2026-06-09 통일). 표시 전용이며 snapshot·demoUserId 와는 무관.
// 주차/기간 SoT = /admin/season-weeks (GET /api/admin/season-weeks). 하드코딩 없음(오늘 날짜가
// 어떤 week range 에 속하는지로 현재 주차를 찾는다).

import { formatClubDate } from "@/lib/clubDate";

export type SeasonWeekRow = {
  week_id?: string;
  // season-weeks DTO 의 season_key("2025-winter") — 시즌 타입 판정(주차 유효성)에 사용.
  season_key?: string | null;
  season_name: string | null;
  week_number: number | null;
  week_start_date: string | null;
  week_end_date: string | null;
  is_current_week?: boolean;
};

// 시즌별 정규 최대 주차(전환 주차 +1 은 제외). 라인 개설 주차 선택 필터의 SoT.
//   봄/가을 1~16, 여름/겨울 1~8. 0주차·최대 초과(전환 주차 17/9 등)는 개설 대상이 아님.
export const SEASON_MAX_WEEK: Record<string, number> = {
  spring: 16,
  summer: 8,
  autumn: 16,
  winter: 8,
};

// season_key("2025-winter") 우선, 없으면 season_name("…겨울시즌") 한글로 시즌 타입 추출.
export function seasonTypeToken(
  w: Pick<SeasonWeekRow, "season_key" | "season_name">,
): "spring" | "summer" | "autumn" | "winter" | null {
  const m = /(spring|summer|autumn|winter)/i.exec(w.season_key ?? "");
  if (m) return m[1].toLowerCase() as "spring" | "summer" | "autumn" | "winter";
  const name = w.season_name ?? "";
  if (name.includes("봄")) return "spring";
  if (name.includes("여름")) return "summer";
  if (name.includes("가을")) return "autumn";
  if (name.includes("겨울")) return "winter";
  return null;
}

// 라인 개설 주차 선택 필터 — 0주차 및 시즌 최대 초과(전환 주차 포함) 제외.
//   봄/가을 1~16, 여름/겨울 1~8 만 유효. 시즌 타입 미상이면 16(보수적 상한)으로 본다.
//   ⚠ 표시/선택 필터 전용. season-weeks DTO 원본(전환 주차 포함)·snapshot 에는 영향 없음.
export function isValidLineOpeningWeek(w: SeasonWeekRow): boolean {
  const n = w.week_number;
  if (n == null || n < 1) return false; // 0주차·미지정 제외
  const type = seasonTypeToken(w);
  const max = type ? SEASON_MAX_WEEK[type] : 16;
  return n <= max;
}

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
// "26 - 06 - 29 (월)" — 클럽 일정 공통 표기(formatClubDate SoT).
export function fmtDate(iso: string): string {
  return formatClubDate(iso, iso);
}
// season-weeks season_name 은 "2026년도 봄시즌" 처럼 연도 포함 → 표시("26년 …")용으로 앞쪽 "YYYY년도" 제거.
export function seasonLabelOnly(seasonName: string | null): string {
  if (!seasonName) return "-";
  return seasonName.replace(/^\s*\d{4}\s*년도\s*/, "").trim() || seasonName;
}
// "26년 봄시즌 14주차"
// 시즌 연도 = 주차 종료일(일요일) 기준. 겨울 경계 주차(예: 24-12-30~25-01-05)는
//   종료일이 속한 연도(2025)로 표시해 season_definitions 의 시즌 귀속 연도와 일치시킨다.
//   종료일이 없으면 시작일 연도로 폴백(이전 동작 유지).
export function weekName(w: SeasonWeekRow): string {
  const yearSource = w.week_end_date ?? w.week_start_date;
  const year = yearSource ? Number(yearSource.slice(0, 4)) : NaN;
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
  const todayLabel = formatClubDate(today, today);

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
