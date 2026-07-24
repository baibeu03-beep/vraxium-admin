// 실무 정보 라인 개설 [섹션 0] 상태창 표기 포맷 — 순수 함수(browser-safe, DB 무관).
// 컴포넌트와 검증 스크립트가 동일 코드를 공유한다.

import { formatClubDate, formatClubDateTime } from "@/lib/clubDate";
import type { AdminLogTone } from "@/lib/adminLogPresentation";

export const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"] as const;

// "26 - 07 - 06 (월)" — 오늘(접속 시점) 날짜. 클럽 일정 공통 표기(formatClubDate SoT).
export function formatToday(d: Date): string {
  return formatClubDate(d);
}

// "26년, 여름 시즌, 2주차" — seasonName 은 DTO 값("여름 시즌")을 그대로 사용한다.
export function formatBannerPeriod(input: {
  year: number;
  seasonName: string;
  weekNumber: number;
}): string {
  const yy = String(((input.year % 100) + 100) % 100).padStart(2, "0");
  return `${yy}년, ${input.seasonName}, ${input.weekNumber}주차`;
}

// "26년, 여름 시즌, 2주차 · 개설 대상" — 시즌·주차 라벨 + 상태 suffix 공통 포맷(단일 SoT).
//   base = formatBannerPeriod. 드롭다운/옵션에서 페이지마다 문자열을 직접 조합하지 않도록,
//   라인 개설(line-opening) 하위 전 화면이 이 함수로 라벨을 만든다.
//   suffix 순서(고정) = 개설 대상 → 현재 → 휴식. 상태 의미(개설 대상/현재)는 그대로 유지한다.
export function formatSeasonWeekLabel(input: {
  year: number;
  seasonName: string;
  weekNumber: number;
  isOpenTarget?: boolean;
  isCurrent?: boolean;
  isRest?: boolean;
}): string {
  let label = formatBannerPeriod(input);
  if (input.isOpenTarget) label += " · 개설 대상";
  if (input.isCurrent) label += " · 현재";
  if (input.isRest) label += " · 휴식";
  return label;
}

// "26 - 06 - 29 (월)" — 주차 시작/종료일 풀 표기. 클럽 일정 공통 표기(formatClubDate SoT).
export function formatFullDateKo(iso: string): string {
  return formatClubDate(iso, iso);
}

// "2026년 6월 29일(월) ~ 2026년 7월 5일(일)" — week start/end 범위(요일 포함).
export function formatFullDateRangeKo(startIso: string, endIso: string): string {
  return `${formatFullDateKo(startIso)} ~ ${formatFullDateKo(endIso)}`;
}

// ── 로그창 표기 포맷 ───────────────────────────────────────────────────────

// season_key suffix → 한글 시즌명. (lib/cluster4PeriodLabel 의 매핑과 동일 — 작은 안정 상수.)
const SEASON_KEY_TO_KO: Record<string, string> = {
  spring: "봄",
  summer: "여름",
  autumn: "가을",
  fall: "가을",
  winter: "겨울",
};

function seasonNameKo(seasonKey: string | null | undefined): string | null {
  if (!seasonKey) return null;
  for (const part of seasonKey.toLowerCase().split("-")) {
    const ko = SEASON_KEY_TO_KO[part];
    if (ko) return ko;
  }
  return null;
}

// "26년 여름 시즌 1주차" — weeks.iso_year / season_key / week_number 로부터(SoT).
export function formatLogPeriodLabel(input: {
  isoYear: number | null;
  seasonKey: string | null;
  weekNumber: number | null;
}): string {
  const season = seasonNameKo(input.seasonKey);
  if (input.isoYear == null || !season || input.weekNumber == null) {
    return "기간 미상";
  }
  const yy = String(((input.isoYear % 100) + 100) % 100).padStart(2, "0");
  return `${yy}년 ${season} 시즌 ${input.weekNumber}주차`;
}

// "26 - 06 - 01 (월) 17:23" — timestamptz 를 KST 기준 날짜+시각으로(클럽 일정 공통 표기).
export function formatLogDateTime(iso: string): string {
  return formatClubDateTime(iso, iso);
}

export type OpeningLogAction = "open" | "cancel" | "close";
export const OPENING_LOG_ACTION_LABEL: Record<OpeningLogAction, string> = {
  open: "개설 완료",
  cancel: "개설 취소",
  // 수동 "2차 기입 마감"(force-close) — submission_closes_at 을 현재 시각으로 단축한 조기 마감 이벤트.
  close: "2차 기입 마감",
};

export function practicalInfoOpeningLogTone(
  action: OpeningLogAction,
): AdminLogTone {
  if (action === "open") return "completed";
  if (action === "cancel") return "cancelled";
  return "closed";
}
