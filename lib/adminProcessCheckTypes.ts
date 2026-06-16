// Browser-safe constants/types/parsers for the 프로세스 체크 화면(/admin/processes/check/{hub}).
// Must not import server-only modules here.
//
// 정책 (2026-06-12 — 체크 동작 Phase):
//   - org × hub × week × act 단위 "체크 상태"(needed|pending|completed) + append-only "행동 이력".
//   - 마스터(process_line_groups/process_acts)는 SoT 그대로 — 여기서는 수행 상태/로그만.
//   - ⚠ user_weekly_points.points · 주차 성장 계산 · snapshot · checkGate 무접촉.
//     포인트 부여/크롤링 연동(완료 트리거)은 후속 Phase — completed 저장 컬럼만 정의.

import { PROCESS_HUB_LABEL, type ProcessHub } from "@/lib/adminProcessesTypes";
import { DAY_NAMES, formatBannerPeriod } from "@/lib/practicalInfoSection0Format";
import type { ScopeMode } from "@/lib/userScopeShared";

// ── 체크 상태 ────────────────────────────────────────────────────────────────
//   needed = 체크 필요(기본) · pending = 체크 대기(신청 후) · completed = 체크 완료.
export type ProcessCheckStatus = "needed" | "pending" | "completed";
export function isProcessCheckStatus(v: unknown): v is ProcessCheckStatus {
  return v === "needed" || v === "pending" || v === "completed";
}

// 상태 버튼 라벨/색 — needed=노랑 · pending=보라 · completed=초록.
export function processCheckButtonLabel(s: ProcessCheckStatus): string {
  if (s === "pending") return "체크 대기";
  if (s === "completed") return "체크 완료";
  return "체크 필요";
}
export function processCheckButtonClass(s: ProcessCheckStatus): string {
  if (s === "completed") return "border-green-300 bg-green-100 text-green-800 hover:bg-green-200";
  if (s === "pending") return "border-purple-300 bg-purple-100 text-purple-800 hover:bg-purple-200";
  return "border-amber-300 bg-amber-100 text-amber-800 hover:bg-amber-200"; // needed = 노랑
}

// ── 체크 행동(로그) ───────────────────────────────────────────────────────────
export type ProcessCheckLogAction = "check_requested" | "check_cancelled" | "check_completed";
export const PROCESS_CHECK_LOG_ACTION_LABEL: Record<ProcessCheckLogAction, string> = {
  check_requested: "체크 신청",
  check_cancelled: "체크 취소",
  check_completed: "체크 완료",
};
export function processCheckLogActionClass(a: ProcessCheckLogAction): string {
  if (a === "check_completed") return "text-green-700";
  if (a === "check_cancelled") return "text-rose-700";
  return "text-purple-700"; // check_requested
}

// 화면 액션(POST) — 신청/취소(완료는 시스템 트리거, 본 Phase 미구현).
export type ProcessCheckAction = "request" | "cancel";
export function isProcessCheckAction(v: unknown): v is ProcessCheckAction {
  return v === "request" || v === "cancel";
}

// ── 팀·파트 스코프 (experience 섹션.1) ─────────────────────────────────────────
//   team_all     = 팀 전체(팀 총괄 + 모든 파트 액트) — 읽기 전용(체크 신청/취소 불가).
//   team_overall = 팀 총괄(특정 파트에 속하지 않은 액트) — 체크 가능.
//   part         = 특정 파트(소속 라인급명에 "파트" 포함) — 체크 가능(대상=그 파트 크루).
// 정책(2026-06-15): "파트 액트" = 소속 라인급(process_line_groups.name)에 "파트" 문자 포함.
//   팀 총괄 액트 = 파트가 아닌 액트. 스코프는 act 의 line_group 으로 서버가 독립 재검증한다
//   (part 식별자 = line_group_id — 상태행에 이미 저장되어 별도 컬럼 불필요).
export type ProcessCheckScopeKind = "team_all" | "team_overall" | "part";
export function isProcessCheckScopeKind(v: unknown): v is ProcessCheckScopeKind {
  return v === "team_all" || v === "team_overall" || v === "part";
}
// team_all 은 읽기 전용 — 체크 신청/취소가 가능한 스코프인지.
export function isCheckableScope(kind: ProcessCheckScopeKind): boolean {
  return kind === "team_overall" || kind === "part";
}

// 소속 라인급명에 "파트" 문자가 포함되면 파트 액트(서버/클라 공용 단일 판정).
export function isPartLineGroupName(name: string | null | undefined): boolean {
  return (name ?? "").includes("파트");
}

// ── 검수 시점 검증 (now < scheduled ≤ now+7d) — 서버/클라 공용 SoT ──────────────
export const CHECK_SCHEDULE_MAX_DAYS = 7;
const DAY_MS = 86_400_000;
export type ScheduleValidation = { ok: true } | { ok: false; error: string };
// nowMs = 신청 시점(서버 기준). scheduledIso = 사용자가 고른 검수 예정 시각(ISO).
export function validateScheduledCheckAt(scheduledIso: string, nowMs: number): ScheduleValidation {
  const t = Date.parse(scheduledIso);
  if (Number.isNaN(t)) return { ok: false, error: "검수 시점 형식이 올바르지 않습니다" };
  if (t <= nowMs) return { ok: false, error: "검수 시점은 현재 시간 이후여야 합니다" };
  if (t > nowMs + CHECK_SCHEDULE_MAX_DAYS * DAY_MS) {
    return { ok: false, error: `검수 시점은 신청 시점 기준 ${CHECK_SCHEDULE_MAX_DAYS}일 이내여야 합니다` };
  }
  return { ok: true };
}

// 검수 링크 검증 — 네이버 카페 게시물 링크(필수). http(s) URL 만 강제(호스트는 강제하지 않음).
export function validateReviewLink(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, error: "검수 링크(네이버 카페 게시물 링크)는 필수입니다" };
  }
  const v = raw.trim();
  if (!/^https?:\/\/\S+$/i.test(v)) {
    return { ok: false, error: "검수 링크는 http(s) URL 이어야 합니다" };
  }
  return { ok: true, value: v };
}

// ── DTO ──────────────────────────────────────────────────────────────────────
// [섹션.1] 액트 목록 테이블 한 행 — 마스터(process_acts) + 체크 상태(현재값).
// "팀 & 파트" 컬럼 값 — 팀 총괄 액트 = "팀 총괄" / 파트 액트 = 파트명. ("팀 전체"는 값이 아님)
export const TEAM_OVERALL_LABEL = "팀 총괄";

export type ProcessCheckActRowDto = {
  actId: string;
  lineGroupId: string;
  lineGroupName: string;
  // 이 행의 실제 소속 인덱스(컬럼 "팀 & 파트") — "팀 총괄" 또는 파트명. 팀 전체 보기는 행마다 실제 값.
  partLabel: string;
  actName: string;
  durationMinutes: number;
  occurWhen: string; // 신청 시점(필요) — "N주 화 06:30"
  checkWhen: string; // 검수 시점(필요)
  pointCheck: number; // Po.A
  pointAdvantage: number; // Po.B
  pointPenalty: number; // Po.C
  crewReactionLabel: string; // 크루 반응(= act_type 라벨)
  cafeLabel: string; // 카페(발생/미발생)
  isCheckTarget: boolean;
  // 체크 상태(현재값).
  status: ProcessCheckStatus;
  reviewLink: string | null;
  scheduledCheckAt: string | null; // 검수 시점(실제)
  requestedAt: string | null; // 신청 시점(실제)
  completedAt: string | null;
  checkedCrewCount: number | null;
};

export type ProcessCheckLineGroupDto = {
  lineGroupId: string;
  name: string;
  targetActCount: number; // 산하 체크 대상 액트 수
  appliedActCount: number; // 그 중 신청완료(pending|completed) 수
  hasApplied: boolean;
};

export type ProcessCheckSummary = {
  lineGroupTotal: number;
  lineGroupApplied: number;
  actTotal: number; // 체크 대상 액트 수
  actApplied: number; // pending|completed
  actCompleted: number; // completed
  isAllCompleted: boolean; // actTotal>0 && 전부 completed
};

export type ProcessCheckWeekDto = {
  weekId: string | null;
  weekName: string;
  editable: boolean;
  year: number;
  seasonName: string; // "여름 시즌"
  weekNumber: number;
  startDate: string;
  endDate: string;
  periodLabel: string; // "26년, 여름 시즌, 2주차" (상태창/드롭다운)
  logPeriodLabel: string; // "26년 여름 시즌 2주차" (로그 denorm)
};

export type ProcessCheckLogDto = {
  id: string;
  action: ProcessCheckLogAction;
  periodLabel: string;
  teamName: string | null; // 팀 구분 허브(experience)만 채움 — 그 외 null(팀 세그먼트 생략)
  partName: string | null; // 파트 스코프 체크(experience)만 채움 — 그 외 null(파트 세그먼트 생략)
  lineGroupName: string;
  actName: string;
  actorName: string;
  createdAt: string;
};

// 팀 구분 허브(experience)의 상태창1 — 팀마다 1문장. isAllCompleted=팀 산하 체크대상 전부 completed.
export type ProcessCheckTeamDto = {
  teamId: string;
  teamName: string;
  isAllCompleted: boolean;
};

// 팀 구분이 있는 허브(상태창1을 팀별 문장으로 · org 팀 동적 조회). 서버/클라 단일 출처.
export const PROCESS_CHECK_TEAM_BASED_HUBS: readonly ProcessHub[] = ["experience"];
export function isTeamBasedProcessHub(hub: ProcessHub): boolean {
  return PROCESS_CHECK_TEAM_BASED_HUBS.includes(hub);
}

export type ProcessCheckBoardDto = {
  hub: ProcessHub;
  hubLabel: string;
  organization: string;
  mode: ScopeMode;
  week: ProcessCheckWeekDto | null;
  selectedWeek: ProcessCheckWeekDto | null;
  // 팀 구분 허브(experience)면 org 팀 목록(상태창1 팀별 문장용). 그 외(info 등)는 빈 배열(허브 전체 1문장).
  teams: ProcessCheckTeamDto[];
  // 선택 팀의 실제 파트 목록(user_memberships.part_name · org+mode 스코프 · "일반" 제외). 드롭다운 파트 옵션.
  //   팀 미선택/비팀 허브는 빈 배열. process_line_groups 가 아니라 실제 팀 구조가 출처.
  teamParts: string[];
  // 현재 스코프가 특정 파트일 때 그 파트의 체크 대상 크루 정보(표시·가드 참고). 그 외 null.
  selectedPart: { name: string; crewCount: number } | null;
  lineGroups: ProcessCheckLineGroupDto[]; // 체크 대상 ≥1 라인급(칩), ≤12
  acts: ProcessCheckActRowDto[]; // [섹션.1] 신청 시점(필요) 순 — 서버가 스코프로 필터한 결과
  summary: ProcessCheckSummary;
  logs: ProcessCheckLogDto[];
};

export function emptyProcessCheckBoard(hub: ProcessHub, organization: string): ProcessCheckBoardDto {
  return {
    hub,
    hubLabel: PROCESS_HUB_LABEL[hub],
    organization,
    mode: "operating",
    week: null,
    selectedWeek: null,
    teams: [],
    teamParts: [],
    selectedPart: null,
    lineGroups: [],
    acts: [],
    summary: {
      lineGroupTotal: 0,
      lineGroupApplied: 0,
      actTotal: 0,
      actApplied: 0,
      actCompleted: 0,
      isAllCompleted: false,
    },
    logs: [],
  };
}

// ── 표시 포맷 ─────────────────────────────────────────────────────────────────

// "26.07.08(수)" — 공백 없는 컴팩트 표기(상태창 1 문장1).
export function formatCheckTodayCompact(d: Date): string {
  const yy = String(((d.getFullYear() % 100) + 100) % 100).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}.${mm}.${dd}(${DAY_NAMES[d.getDay()]})`;
}

// "2026-07-08(수) 17:00" — 검수/신청 시점 표기(로컬 KST · 24h). 빈 값은 호출부에서 처리.
export function formatCheckDateTimeKo(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${mm}-${dd}(${DAY_NAMES[d.getDay()]}) ${hh}:${mi}`;
}

// 주차 라벨(상태창/드롭다운) "26년, 여름 시즌, 2주차".
export function processCheckPeriodLabel(week: {
  year: number;
  seasonName: string;
  weekNumber: number;
}): string {
  return formatBannerPeriod(week);
}

// 로그 주차 라벨 "26년 여름 시즌 2주차" (콤마 없음 — 로그 예시 포맷).
export function processCheckLogPeriodLabel(week: {
  year: number;
  seasonName: string;
  weekNumber: number;
}): string {
  const yy = String(((week.year % 100) + 100) % 100).padStart(2, "0");
  return `${yy}년 ${week.seasonName} ${week.weekNumber}주차`;
}
