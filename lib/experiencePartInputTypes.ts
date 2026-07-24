// 실무 경험 파트장 입력 그리드 — 공용 상수/타입(browser-safe, DB 무관).
// 컴포넌트/데이터레이어/검증 스크립트가 공유한다.

export type ExperiencePartLineType = "derivation" | "analysis" | "evaluation";

// 라인 3종(고정). evaluation 의 표시 라벨 = "견문"(구 '평가' 워딩 변경).
// 확장 시 이 배열만 늘리면 그리드/저장이 따라온다(line_type CHECK 도 함께 갱신 필요).
export const EXPERIENCE_PART_LINE_TYPES: ReadonlyArray<{
  key: ExperiencePartLineType;
  label: string;
}> = [
  { key: "derivation", label: "도출" },
  { key: "analysis", label: "분석" },
  { key: "evaluation", label: "견문" },
];

export const EXPERIENCE_PART_LINE_KEYS: ReadonlyArray<ExperiencePartLineType> =
  EXPERIENCE_PART_LINE_TYPES.map((l) => l.key);

export function isExperiencePartLineType(
  v: unknown,
): v is ExperiencePartLineType {
  return typeof v === "string" && (EXPERIENCE_PART_LINE_KEYS as string[]).includes(v);
}

// 기본값: 최초 진입/초기화 시 모든 체크=true, 점수=7, 라인 미선택('-').
export const PART_CELL_DEFAULT = { checked: true, score: 7, selectedLineId: null } as const;

// 팀 총괄(집계) 선택값 — 실제 파트가 아님.
export const TEAM_OVERALL = "__overall__";

// 크루 상태(=클래스) 표시 라벨만 치환 — "일반"→"정규".
//   ⚠ UI 텍스트 전용. 내부 statusLabel 값("일반")·Enum·DTO·DB·권한/로직(canEditOverallManagement 등)은 불변.
//   개설 검수/완료 테이블 공통 사용(프론트 표시 SoT).
export function displayCrewStatusLabel(statusLabel: string): string {
  return statusLabel === "일반" ? "정규" : statusLabel;
}

// 셀 상태 — 체크/점수 + 선택 라인(안정적 라인 ID). 미선택 = null('-').
export type PartInputCell = {
  checked: boolean;
  score: number;
  selectedLineId: string | null;
};

// 점수 파생 상태(라인 선택과 무관) — checked/score + 제출·강화 판정.
export type ExperienceScoreState = {
  checked: boolean;
  score: number;
  isSubmitted: boolean;
  isReinforcementSuccess: boolean;
};

// Experience line-opening score policy SoT.  UI, API validation/assembly, and
// downstream customer DTOs must all preserve this invariant.
export function experienceScoreState(scoreInput: unknown): ExperienceScoreState {
  const numeric = Number(scoreInput);
  const score = Number.isFinite(numeric)
    ? Math.max(0, Math.min(10, Math.round(numeric)))
    : 0;
  const isSubmitted = score >= 1;
  return {
    score,
    checked: isSubmitted,
    isSubmitted,
    isReinforcementSuccess: score >= 4,
  };
}

export function normalizePartInputCell<T extends PartInputCell>(cell: T): T {
  const state = experienceScoreState(cell.score);
  // 라인명 선택은 평점과 분리한다(2026-07-24) — 평점 0점(미체크)에서도 선택 라인을 그대로 보존한다.
  //   · 라인명은 어떤 평점에서도 선택·저장·조회된다(평점 0 이라고 null 로 지우지 않는다).
  //   · 고객 반영(개설 완료)은 별도 게이트(openTeamOverall: checked && score>0 && selectedLineId)가
  //     독립적으로 판정하므로, 0점 라인을 보존해도 대상자/평가/snapshot 생성 로직은 달라지지 않는다.
  const selectedLineId = cell.selectedLineId ?? null;
  return { ...cell, ...state, selectedLineId };
}

// 강화 실패 판정 = 체크 해제 OR 점수<=3. (표시/저장만 — snapshot 계산과 무관)
export function isPartCellFail(cell: PartInputCell): boolean {
  return !cell.checked || cell.score <= 3;
}

// ── DTO (API ↔ 컴포넌트 공유) ──

export type PartInputCrew = {
  userId: string;
  displayName: string;
  partName: string | null;
  statusLabel: string; // "일반" | "에이전트"
};

export type PartInputCellDto = {
  crewUserId: string;
  lineType: ExperiencePartLineType;
  checked: boolean;
  score: number;
  // 선택 라인의 안정적 ID(line_registrations.bridged_master_id). 미선택/강화실패 = null('-').
  selectedLineId: string | null;
};

// 라인명 드롭다운 옵션(카테고리별). value=id(안정적 라인 ID), label=lineName.
//   개설 신청/검수/서버 검증이 동일 옵션 원천(listExperienceLineOptions)을 공유한다.
export type PartInputLineOption = {
  id: string; // line_registrations.bridged_master_id
  lineName: string; // 표시명(드롭다운 라벨)
  lineCode: string | null;
};

// 라인 유형(도출/분석/견문) → 옵션 목록. 등록 원장에서 유형이 일치하는 활성 라인만.
export type PartInputLineOptions = Record<
  ExperiencePartLineType,
  PartInputLineOption[]
>;

export const EMPTY_PART_INPUT_LINE_OPTIONS: PartInputLineOptions = {
  derivation: [],
  analysis: [],
  evaluation: [],
};

export type PartInputActor = {
  role: string | null;
  teamName: string | null;
  partName: string | null;
  defaultPart: string; // partName(파트장) 또는 TEAM_OVERALL
  // 임퍼소네이션/게이팅용(Phase A 추가 — additive·선택적, 기존 소비처 무영향).
  //   memberRole = 게이팅 정규화 역할. impersonating = actAsTestUserId 유효 여부.
  memberRole?: "team_leader" | "part_leader" | "agent" | "member" | null;
  impersonating?: boolean;
  impersonatedUserId?: string | null;
};

export type PartOverallAggregate = {
  parts: Array<{
    partName: string;
    crews: Array<{
      userId: string;
      displayName: string;
      statusLabel: string;
      cells: PartInputCellDto[];
    }>;
  }>;
};

export type PartInputGetData = {
  actor: PartInputActor;
  lines: ReadonlyArray<{ key: ExperiencePartLineType; label: string }>;
  parts: string[];
  crews: PartInputCrew[]; // 파트 모드 — 평가 대상 크루(파트장 제외)
  cells: PartInputCellDto[]; // 저장된 셀(없으면 빈 배열 → client 기본값)
  // 라인명 드롭다운 옵션(유형별) — 등록 원장에서 유형이 일치하는 활성 라인. org+공통.
  lineOptions: PartInputLineOptions;
  submitted: boolean;
  aggregate: PartOverallAggregate | null; // 팀 총괄 모드일 때만
};
