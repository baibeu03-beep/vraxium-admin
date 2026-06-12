// Browser-safe constants and types for the /admin/processes/register process master APIs.
// Must not import server-only modules here.
//
// 정책 (2026-06-12 마스터 카탈로그 Phase):
//   - 액트/라인급 마스터 CRUD 만 정의한다(additive). 사용자 수행기록 · user_weekly_points
//     자동 합산 · 주차 성장 계산 · snapshot · checkGate 판정은 본 Phase 범위 밖.
//   - 조직(organization) 구분 없음 — 허브×라인급×액트 전역 1세트.
//
// 3단 구조: 허브급(hub enum) → 라인급(process_line_groups) → 액트(process_acts).

// ── 허브급 (탭 자체가 값) ───────────────────────────────────────────────────
export type ProcessHub = "club" | "info" | "experience" | "competency" | "career";

export const PROCESS_HUBS = [
  "club",
  "info",
  "experience",
  "competency",
  "career",
] as const;

// 탭 라벨 — 시안: "클럽 총괄 급" / "실무 정보 급" … (표시 시 "급" 접미).
export const PROCESS_HUB_LABEL: Record<ProcessHub, string> = {
  club: "클럽 총괄",
  info: "실무 정보",
  experience: "실무 경험",
  competency: "실무 역량",
  career: "실무 경력",
};

export function isProcessHub(value: unknown): value is ProcessHub {
  return typeof value === "string" && (PROCESS_HUBS as readonly string[]).includes(value);
}

// ── 발생/체크 주차 (N | N+1) ───────────────────────────────────────────────
export type ProcessWeekRef = "N" | "N1";
export const PROCESS_WEEK_REFS = ["N", "N1"] as const;
export const PROCESS_WEEK_REF_LABEL: Record<ProcessWeekRef, string> = {
  N: "N",
  N1: "N+1",
};
export function isProcessWeekRef(value: unknown): value is ProcessWeekRef {
  return value === "N" || value === "N1";
}

// ── 요일 (0=일 ~ 6=토, 시안 순서) ──────────────────────────────────────────
export const PROCESS_DOW_LABELS = ["일", "월", "화", "수", "목", "금", "토"] as const;
export function isProcessDow(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6;
}

// ── 시간 옵션 (06:00 ~ 24:00, 30분 단위) ───────────────────────────────────
export const PROCESS_TIME_OPTIONS: readonly string[] = (() => {
  const out: string[] = [];
  // 06:00(360분) ~ 24:00(1440분), 30분 step.
  for (let m = 6 * 60; m <= 24 * 60; m += 30) {
    const h = Math.floor(m / 60);
    const min = m % 60;
    out.push(`${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`);
  }
  return out;
})();
export function isProcessTime(value: unknown): value is string {
  return typeof value === "string" && PROCESS_TIME_OPTIONS.includes(value);
}

// ── 소요 시간 (분, 5~90 / 5분 단위) ────────────────────────────────────────
export const PROCESS_DURATION_OPTIONS: readonly number[] = (() => {
  const out: number[] = [];
  for (let m = 5; m <= 90; m += 5) out.push(m);
  return out;
})();
export function isProcessDuration(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 5 &&
    value <= 90 &&
    value % 5 === 0
  );
}

// ── 포인트 (A=check / B=advantage / C=penalty, 각 0~20) ────────────────────
export const PROCESS_POINT_OPTIONS: readonly number[] = Array.from({ length: 21 }, (_, i) => i);
export function isProcessPoint(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 20;
}

// ── 카페 / 체크 대상 / 액트 종류 ───────────────────────────────────────────
export type ProcessCafe = "occur" | "none";
export const PROCESS_CAFE_OPTIONS = ["occur", "none"] as const;
export const PROCESS_CAFE_LABEL: Record<ProcessCafe, string> = {
  occur: "발생",
  none: "미발생",
};

export type ProcessCheckTarget = "check" | "none";
export const PROCESS_CHECK_TARGET_OPTIONS = ["check", "none"] as const;
export const PROCESS_CHECK_TARGET_LABEL: Record<ProcessCheckTarget, string> = {
  check: "체크",
  none: "미체크",
};

// 시안 4종 사용 (문서 3종 표기는 무시 — 4개 사용 확정).
export type ProcessActType = "required" | "optional" | "selection" | "basic";
export const PROCESS_ACT_TYPE_OPTIONS = [
  "required",
  "optional",
  "selection",
  "basic",
] as const;
export const PROCESS_ACT_TYPE_LABEL: Record<ProcessActType, string> = {
  required: "필수",
  optional: "자율",
  selection: "선발",
  basic: "기본",
};

// 허브당 라인급 최대 개수.
export const PROCESS_LINE_GROUP_MAX = 12;
// 라인급명 / 액트명 최대 글자수.
export const PROCESS_NAME_MAX = 30;

// ── DTO ────────────────────────────────────────────────────────────────────
export type ProcessLineGroupDto = {
  id: string;
  hub: ProcessHub;
  hubLabel: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  // 산하 액트 수 — 삭제 가능 여부(0 이어야 삭제) 판정용. 목록 조회 시 채워짐.
  actCount: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProcessActDto = {
  id: string;
  lineGroupId: string;
  lineGroupName: string | null;
  hub: ProcessHub;
  hubLabel: string;
  actName: string;
  durationMinutes: number;
  occurWeek: ProcessWeekRef;
  occurDow: number;
  occurTime: string;
  checkWeek: ProcessWeekRef;
  checkDow: number;
  checkTime: string;
  pointCheck: number;
  pointAdvantage: number;
  pointPenalty: number;
  cafe: ProcessCafe;
  checkTarget: ProcessCheckTarget;
  actType: ProcessActType;
  overview: string | null;
  remarks: string | null;
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

// ── Create inputs ───────────────────────────────────────────────────────────
export type ProcessLineGroupCreateInput = {
  hub: ProcessHub;
  name: string;
};

export type ProcessActCreateInput = {
  lineGroupId: string;
  hub: ProcessHub;
  actName: string;
  durationMinutes: number;
  occurWeek: ProcessWeekRef;
  occurDow: number;
  occurTime: string;
  checkWeek: ProcessWeekRef;
  checkDow: number;
  checkTime: string;
  pointCheck: number;
  pointAdvantage: number;
  pointPenalty: number;
  cafe: ProcessCafe;
  checkTarget: ProcessCheckTarget;
  actType: ProcessActType;
  overview: string | null;
  remarks: string | null;
};

export type ParseBodyResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredText(
  raw: unknown,
  field: string,
  max: number,
): ParseBodyResult<string> {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, status: 400, error: `${field} is required` };
  }
  const trimmed = raw.trim();
  if (trimmed.length > max) {
    return { ok: false, status: 400, error: `${field} 는 최대 ${max}자입니다` };
  }
  return { ok: true, value: trimmed };
}

function optionalText(raw: unknown, field: string): ParseBodyResult<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") {
    return { ok: false, status: 400, error: `${field} must be a string or null` };
  }
  const trimmed = raw.trim();
  return { ok: true, value: trimmed.length ? trimmed : null };
}

// POST /api/admin/processes/line-groups body 파서.
export function parseProcessLineGroupCreateBody(
  body: unknown,
): ParseBodyResult<ProcessLineGroupCreateInput> {
  if (!isRecord(body)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object" };
  }
  if (!isProcessHub(body.hub)) {
    return {
      ok: false,
      status: 400,
      error: "hub must be one of club|info|experience|competency|career",
    };
  }
  const name = requiredText(body.name, "name", PROCESS_NAME_MAX);
  if (!name.ok) return name;
  return { ok: true, value: { hub: body.hub, name: name.value } };
}

// POST /api/admin/processes/acts body 파서.
export function parseProcessActCreateBody(
  body: unknown,
): ParseBodyResult<ProcessActCreateInput> {
  if (!isRecord(body)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object" };
  }

  if (typeof body.line_group_id !== "string" || body.line_group_id.trim().length === 0) {
    return { ok: false, status: 400, error: "line_group_id is required (소속 라인급을 선택해주세요)" };
  }
  const lineGroupId = body.line_group_id.trim();

  if (!isProcessHub(body.hub)) {
    return {
      ok: false,
      status: 400,
      error: "hub must be one of club|info|experience|competency|career",
    };
  }
  const hub = body.hub;

  const actName = requiredText(body.act_name, "act_name", PROCESS_NAME_MAX);
  if (!actName.ok) return actName;

  const durationMinutes = Number(body.duration_minutes);
  if (!isProcessDuration(durationMinutes)) {
    return { ok: false, status: 400, error: "duration_minutes must be 5~90 (5분 단위)" };
  }

  if (!isProcessWeekRef(body.occur_week)) {
    return { ok: false, status: 400, error: "occur_week must be 'N' or 'N1'" };
  }
  const occurDow = Number(body.occur_dow);
  if (!isProcessDow(occurDow)) {
    return { ok: false, status: 400, error: "occur_dow must be 0~6 (일~토)" };
  }
  if (!isProcessTime(body.occur_time)) {
    return { ok: false, status: 400, error: "occur_time must be a 30분 단위 시각 (06:00~24:00)" };
  }

  if (!isProcessWeekRef(body.check_week)) {
    return { ok: false, status: 400, error: "check_week must be 'N' or 'N1'" };
  }
  const checkDow = Number(body.check_dow);
  if (!isProcessDow(checkDow)) {
    return { ok: false, status: 400, error: "check_dow must be 0~6 (일~토)" };
  }
  if (!isProcessTime(body.check_time)) {
    return { ok: false, status: 400, error: "check_time must be a 30분 단위 시각 (06:00~24:00)" };
  }

  const pointCheck = Number(body.point_check);
  const pointAdvantage = Number(body.point_advantage);
  const pointPenalty = Number(body.point_penalty);
  if (!isProcessPoint(pointCheck) || !isProcessPoint(pointAdvantage) || !isProcessPoint(pointPenalty)) {
    return { ok: false, status: 400, error: "point_check/advantage/penalty must be 0~20" };
  }

  if (body.cafe !== "occur" && body.cafe !== "none") {
    return { ok: false, status: 400, error: "cafe must be 'occur' or 'none'" };
  }
  if (body.check_target !== "check" && body.check_target !== "none") {
    return { ok: false, status: 400, error: "check_target must be 'check' or 'none'" };
  }
  if (!(PROCESS_ACT_TYPE_OPTIONS as readonly string[]).includes(body.act_type as string)) {
    return {
      ok: false,
      status: 400,
      error: "act_type must be one of required|optional|selection|basic",
    };
  }

  const overview = optionalText(body.overview, "overview");
  if (!overview.ok) return overview;
  const remarks = optionalText(body.remarks, "remarks");
  if (!remarks.ok) return remarks;

  return {
    ok: true,
    value: {
      lineGroupId,
      hub,
      actName: actName.value,
      durationMinutes,
      occurWeek: body.occur_week,
      occurDow,
      occurTime: body.occur_time,
      checkWeek: body.check_week,
      checkDow,
      checkTime: body.check_time,
      pointCheck,
      pointAdvantage,
      pointPenalty,
      cafe: body.cafe,
      checkTarget: body.check_target,
      actType: body.act_type as ProcessActType,
      overview: overview.value,
      remarks: remarks.value,
    },
  };
}
