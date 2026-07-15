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

// 허브 enum(process_acts.hub 등) → 한글 표시명. **표시 전용** 포맷터 — DB 저장값/DTO/API 무변경.
//   PROCESS_HUB_LABEL(허브명 SoT)을 재사용한다(신규 매핑 금지). null/미지정 → "-",
//   알 수 없는 값은 원문 보존(방어적). 어드민/크루 페이지의 영문 허브 노출 제거에 공통 사용.
export function formatProcessHubLabel(hub: string | null | undefined): string {
  if (!hub) return "-";
  return isProcessHub(hub) ? PROCESS_HUB_LABEL[hub] : hub;
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

// enum(저장값)은 기존 4종(required|optional|selection|basic)을 그대로 유지 — 과거 데이터 표시 호환.
// 단, 신규 등록 드롭다운/POST 검증은 2종(필수·선별)만 허용한다(PROCESS_ACT_TYPE_OPTIONS).
export type ProcessActType = "required" | "optional" | "selection" | "basic";
// 신규 등록에서 선택 가능한 액트 종류 — '필수'·'선별' 2종만 (POST 검증·드롭다운 공용 SoT).
export const PROCESS_ACT_TYPE_OPTIONS = [
  "required",
  "selection",
] as const;
export const PROCESS_ACT_TYPE_LABEL: Record<ProcessActType, string> = {
  required: "필수",
  optional: "자율",
  // 'selection' 표시 라벨을 '선발' → '선별'로 변경 (저장값 enum 은 "selection" 유지).
  selection: "선별",
  // UI 표시 라벨만 '기타'로 변경 — 저장값(enum)은 기존과 동일하게 "basic" 유지.
  basic: "기타",
};

// ── 액트 종류(act_type / crew_reaction) ↔ 포인트 C 규칙 (서버/클라 공용 SoT) ─────
//   '필수(required)' 일 때만 포인트 C(미이행 페널티) 입력 가능.
//   그 외(자율·선택·선발·기본·없음)는 포인트 C = 0 고정. 정규 액트(act_type)·변동(crew_reaction) 공용.
export function reactionAllowsPointC(reactionKey: string): boolean {
  return reactionKey === "required";
}
// 저장/표시 강제 보정 — required 가 아니면 무조건 0.
export function enforcePointC(reactionKey: string, pointC: number): number {
  return reactionAllowsPointC(reactionKey) ? pointC : 0;
}

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

// ── 발생/검수 시점 표시 포맷 ("N주 월 06:30") ──────────────────────────────
export function formatProcessWhen(
  week: ProcessWeekRef,
  dow: number,
  time: string,
): string {
  const d = dow >= 0 && dow <= 6 ? PROCESS_DOW_LABELS[dow] : "?";
  return `${PROCESS_WEEK_REF_LABEL[week]}주 ${d} ${time}`;
}

// ── 신청/검수 시점 선후 비교 (서버/클라 공용 SoT) ──────────────────────────
//   시점 = (주차 N<N+1) → (요일 일0~토6) → (시각 분) 의 사전식 순서.
//   검수 시점(check)은 신청 시점(occur)보다 이전일 수 없다.
//   "HH:MM" 이외/범위 밖 값은 방어적으로 0 처리 — 기존에 저장된 이상 데이터도 깨지지 않게 한다.
export function processWhenOrdinal(
  week: ProcessWeekRef,
  dow: number,
  time: string,
): number {
  const weekRank = week === "N1" ? 1 : 0;
  const safeDow = Number.isInteger(dow) && dow >= 0 && dow <= 6 ? dow : 0;
  const [hRaw, mRaw] = typeof time === "string" ? time.split(":") : [];
  const h = Number(hRaw);
  const m = Number(mRaw);
  const minutes =
    (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  return weekRank * 100000 + safeDow * 10000 + minutes;
}

// 검수 시점이 신청 시점보다 이전이면 true (같은 시점은 허용).
export function isCheckBeforeOccur(
  occurWeek: ProcessWeekRef,
  occurDow: number,
  occurTime: string,
  checkWeek: ProcessWeekRef,
  checkDow: number,
  checkTime: string,
): boolean {
  return (
    processWhenOrdinal(checkWeek, checkDow, checkTime) <
    processWhenOrdinal(occurWeek, occurDow, occurTime)
  );
}

// ── 신청 시점 → 검수 시점 최소 간격(12시간) 규칙 (서버/클라 공용 SoT) ─────────
//   시점은 절대 시각이 아니라 상대 스케줄(주차 N/N+1 · 요일 · 30분 시각)이다.
//   실제 경과(분)를 계산하려면 주차(N→N+1)를 7일 간격으로 환산한다:
//     절대분 = 주차(0|1)*7*24*60 + 요일(0~6)*24*60 + (시*60+분)
//   ⚠️ processWhenOrdinal 은 선후 비교 전용(자리수 분리값)이라 실제 간격 계산엔 쓰지 않는다.
export const PROCESS_MIN_REVIEW_GAP_MINUTES = 12 * 60; // 720분 = 12시간

function processWhenAbsoluteMinutes(
  week: ProcessWeekRef,
  dow: number,
  time: string,
): number {
  const weekIndex = week === "N1" ? 1 : 0;
  const safeDow = Number.isInteger(dow) && dow >= 0 && dow <= 6 ? dow : 0;
  const [hRaw, mRaw] = typeof time === "string" ? time.split(":") : [];
  const h = Number(hRaw);
  const m = Number(mRaw);
  const minutes =
    (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  return weekIndex * 7 * 24 * 60 + safeDow * 24 * 60 + minutes;
}

// 검수 시점 - 신청 시점 실제 경과(분). 음수면 검수가 더 이르다.
export function processReviewGapMinutes(
  occurWeek: ProcessWeekRef,
  occurDow: number,
  occurTime: string,
  checkWeek: ProcessWeekRef,
  checkDow: number,
  checkTime: string,
): number {
  return (
    processWhenAbsoluteMinutes(checkWeek, checkDow, checkTime) -
    processWhenAbsoluteMinutes(occurWeek, occurDow, occurTime)
  );
}

// 검수 시점이 신청 시점 + 12시간 미만이면 true (등록 불가).
//   정확히 12시간(720분)은 허용, 그 미만(같은 시점·이른 시점 포함)은 불가.
export function isReviewGapTooShort(
  occurWeek: ProcessWeekRef,
  occurDow: number,
  occurTime: string,
  checkWeek: ProcessWeekRef,
  checkDow: number,
  checkTime: string,
): boolean {
  return (
    processReviewGapMinutes(
      occurWeek,
      occurDow,
      occurTime,
      checkWeek,
      checkDow,
      checkTime,
    ) < PROCESS_MIN_REVIEW_GAP_MINUTES
  );
}

// 12시간 규칙 위반 시 서버/클라 공용 안내 메시지.
export const PROCESS_REVIEW_GAP_MESSAGE =
  "검수 시점은 신청 시점보다 최소 12시간 이후여야 합니다.\n신청 시점과 검수 시점을 다시 확인해주세요.";

// ── 즉시 팝업/필드 오류 공용 문구 (신청→검수 순서·12시간 규칙, 클라 SoT) ────────
// 신청 시점을 먼저 선택하지 않고 검수 시점을 건드릴 때.
export const PROCESS_OCCUR_FIRST_MESSAGE = "신청 시점을 먼저 선택해주세요.";
// 12시간 미만 검수 시점을 선택하는 즉시(등록 전) 띄우는 짧은 안내.
export const PROCESS_REVIEW_GAP_IMMEDIATE_MESSAGE =
  "검수 시점은 신청 시점보다 최소 12시간 이후로 설정해주세요.";

// ── 프로세스 정보(/admin/processes/info) 요약 ──────────────────────────────
export type ProcessPointTriplet = { check: number; advantage: number; penalty: number };

export type ProcessActSummary = {
  actCount: number;            // 산하 액트 수 (basic 포함 전체)
  lineGroupCount: number;      // 산하 라인급 수
  totalDurationMinutes: number; // 총합 소요 시간 (전체 액트)
  // 누적 계층: 필수 ⊂ 우수(=필수+자율) ⊂ 최대(=필수+자율+선발). 기본(basic)은 어느 합계에도 미포함.
  required: ProcessPointTriplet;
  excellent: ProcessPointTriplet;
  max: ProcessPointTriplet;
};

export type ProcessInfoResult = {
  hub: ProcessHub;
  hubLabel: string;
  acts: ProcessActDto[];
  summary: ProcessActSummary;
};

function emptyTriplet(): ProcessPointTriplet {
  return { check: 0, advantage: 0, penalty: 0 };
}

// 액트 목록 → 요약 (순수 계산 — 서버/클라 공용, direct==HTTP SoT).
export function computeProcessActSummary(
  acts: readonly Pick<
    ProcessActDto,
    "actType" | "durationMinutes" | "pointCheck" | "pointAdvantage" | "pointPenalty"
  >[],
  lineGroupCount: number,
): ProcessActSummary {
  const required = emptyTriplet();
  const excellent = emptyTriplet();
  const max = emptyTriplet();
  let totalDuration = 0;
  const add = (t: ProcessPointTriplet, a: { pointCheck: number; pointAdvantage: number; pointPenalty: number }) => {
    t.check += a.pointCheck;
    t.advantage += a.pointAdvantage;
    t.penalty += a.pointPenalty;
  };
  for (const a of acts) {
    totalDuration += a.durationMinutes;
    if (a.actType === "required") {
      add(required, a); add(excellent, a); add(max, a);
    } else if (a.actType === "optional") {
      add(excellent, a); add(max, a);
    } else if (a.actType === "selection") {
      add(max, a);
    }
    // basic → 포인트 합계 제외 (소요시간·액트수에는 포함)
  }
  return {
    actCount: acts.length,
    lineGroupCount,
    totalDurationMinutes: totalDuration,
    required,
    excellent,
    max,
  };
}

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
  // 개요 = 필수 입력 (2026-07 정책). 신규 등록 시 공백만 있는 값도 불가.
  overview: string;
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

  // 검수 시점은 신청 시점보다 최소 12시간 이후여야 한다 (프론트 우회·잘못된 요청 차단).
  //   12시간 규칙이 "이전 불가"를 포함한다(이전·동일·<12시간 모두 차단, 정확히 12시간은 허용).
  if (
    isReviewGapTooShort(
      body.occur_week,
      occurDow,
      body.occur_time,
      body.check_week,
      checkDow,
      body.check_time,
    )
  ) {
    return {
      ok: false,
      status: 400,
      error: "검수 시점은 신청 시점보다 최소 12시간 이후여야 합니다.",
    };
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
      error: "act_type must be one of required|selection",
    };
  }

  // 개요 = 필수. 공백만 있는 값(trim 후 빈 문자열)도 불가.
  if (typeof body.overview !== "string" || body.overview.trim().length === 0) {
    return { ok: false, status: 400, error: "개요를 입력해주세요." };
  }
  const overview = body.overview.trim();
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
      overview,
      remarks: remarks.value,
    },
  };
}
