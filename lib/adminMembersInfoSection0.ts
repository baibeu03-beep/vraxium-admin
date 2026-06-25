// 멤버 관리 > 크루 정보 탭 [섹션.0] 상단 현재 정보 — 순수 함수(browser-safe, DB 무관).
//
// 입력 = /api/admin/season-weeks GET 의 rows(시즌·주차 SoT). 프론트는 날짜/시즌/주차/공식
// 휴식 여부를 임의 계산하지 않고 이 DTO 값만 표기한다. snapshot·demoUserId 와 완전 무관
// (현재 접속 시점의 시즌/주차 정보일 뿐 사용자별 데이터가 아니다 → 일반/테스트 모드 동일).
//
// 주차 상태 표기 규칙(2026-06-24 확정 — 화면에는 2종만 노출):
//   공식 활동 주차 → [공식 활동]
//   공식 휴식 주차 → [공식 휴식]
//   전환 주차     → [공식 휴식] (사용자 화면 기준 공식 휴식과 동일 취급)

import {
  DAY_NAMES,
  weekName,
  type SeasonWeekRow,
} from "@/lib/practicalInfoSeasonWeeks";

// season-weeks DTO 중 [섹션.0] 표기에 필요한 필드만(공식 휴식/전환 판정 포함).
export type SeasonWeekInfoRow = SeasonWeekRow & {
  is_official_rest?: boolean | null;
  is_transition?: boolean | null;
};

export type MembersInfoWeekStatus = "공식 활동" | "공식 휴식";

export type MembersInfoSection0 = {
  // 현재 주차를 season-weeks rows 에서 찾았는지. false 면 표기값은 모두 "-".
  found: boolean;
  // "26년 6/24(수)" — 오늘(접속 시점) 표기.
  todayLabel: string;
  // "26년 봄시즌 17주차" — 오늘이 속한 시즌/주차명(weekName SoT).
  seasonWeekName: string;
  // "26년 6/22(월) ~ 26년 6/28(일)" — 해당 주차 기간(월~일).
  periodRange: string;
  // [공식 활동] | [공식 휴식] — 전환 주차도 공식 휴식으로 표기.
  weekStatus: MembersInfoWeekStatus;
};

const pad2 = (n: number) => String(n).padStart(2, "0");
const yy2 = (year: number) => pad2(((year % 100) + 100) % 100);

// date-only ISO 의 요일(UTC 기준 — season-weeks 와 동일 컨벤션 · TZ 시프트 회피).
function dowOfIso(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

// "26년 6/24(수)" — YYYY-MM-DD ISO 를 짧은 한글 표기로(월/일 0패딩 없음).
function fmtDateShort(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${yy2(+m[1])}년 ${+m[2]}/${+m[3]}(${DAY_NAMES[dowOfIso(iso)]})`;
}

// "26년 6/22(월) ~ 26년 6/28(일)" — 주차 시작/종료(월~일) 범위.
function fmtRangeShort(startIso: string, endIso: string): string {
  return `${fmtDateShort(startIso)} ~ ${fmtDateShort(endIso)}`;
}

// 오늘(로컬/KST) 날짜를 "26년 6/24(수)" 로. now 는 접속 로컬 시각.
function formatTodayShort(now: Date): string {
  const iso = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  return fmtDateShort(iso);
}

// 현재 주차 행 = season-weeks DTO 의 is_current_week(=DB today 기준). 없으면 오늘 ISO 가
// week range 안에 드는 행으로 폴백(동일 SoT, 표기 누락 방지).
export function findCurrentSeasonWeek(
  rows: readonly SeasonWeekInfoRow[],
  now: Date,
): SeasonWeekInfoRow | null {
  const flagged = rows.find((r) => r.is_current_week === true);
  if (flagged) return flagged;
  const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  return (
    rows.find(
      (r) =>
        r.week_start_date != null &&
        r.week_end_date != null &&
        r.week_start_date <= today &&
        today <= r.week_end_date,
    ) ?? null
  );
}

// 주차 상태 — 공식 휴식(is_official_rest) 또는 전환 주차(is_transition) → [공식 휴식].
//   그 외(공식 활동 주차) → [공식 활동]. 화면 노출은 항상 이 2종 중 하나.
export function resolveWeekStatus(
  row: Pick<SeasonWeekInfoRow, "is_official_rest" | "is_transition">,
): MembersInfoWeekStatus {
  return row.is_official_rest === true || row.is_transition === true
    ? "공식 휴식"
    : "공식 활동";
}

export function resolveMembersInfoSection0(
  rows: readonly SeasonWeekInfoRow[],
  now: Date,
): MembersInfoSection0 {
  const todayLabel = formatTodayShort(now);
  const current = findCurrentSeasonWeek(rows, now);
  if (!current) {
    return {
      found: false,
      todayLabel,
      seasonWeekName: "-",
      periodRange: "-",
      weekStatus: "공식 활동",
    };
  }
  const periodRange =
    current.week_start_date && current.week_end_date
      ? fmtRangeShort(current.week_start_date, current.week_end_date)
      : "-";
  return {
    found: true,
    todayLabel,
    seasonWeekName: weekName(current),
    periodRange,
    weekStatus: resolveWeekStatus(current),
  };
}
