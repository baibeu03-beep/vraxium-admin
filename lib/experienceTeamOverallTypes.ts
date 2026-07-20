// 실무 경험 [팀 총괄] 화면 — 공용 상수/타입(browser-safe, DB 무관).
// 컴포넌트/데이터레이어/API/검증 스크립트가 공유한다.

import type {
  ExperiencePartLineType,
  PartInputLineOption,
} from "@/lib/experiencePartInputTypes";
//
// 그리드 모델: 크루 행 × 5열(도출/분석/견문/관리/확장).
//   - 도출/분석/견문(part-derived): 파트장 신청(cluster4_experience_part_submissions)에서 라이브로 채운다.
//                                   파트장 본인 행과 미신청 파트는 기본값(checked=true, score=7).
//   - 관리/확장(leader-input): 팀장이 팀 총괄 화면에서 직접 입력 — cluster4_experience_team_overall_cells 에 저장.
//                              확장은 확장 주간에만 활성(아니면 disabled).
// 아웃풋 링크/설명은 카테고리(라인)별 1세트. 이미지는 입력 UI 없음(라인 등록값 자동 반영).

export type ExperienceOverallCategory =
  | "derivation"
  | "analysis"
  | "evaluation"
  | "extension"
  | "management";

// 표시 순서 = 도출 · 분석 · 견문 · 관리 · 확장. evaluation 라벨 = "견문"(구 '평가' 워딩).
export const EXPERIENCE_OVERALL_CATEGORIES: ReadonlyArray<{
  key: ExperienceOverallCategory;
  label: string;
  slot: number;
  // registrations/masters 의 한글 line_type 라벨(개설 완료 시 라인 매칭).
  koLineType: string;
}> = [
  { key: "derivation", label: "도출", slot: 1, koLineType: "도출" },
  { key: "analysis", label: "분석", slot: 2, koLineType: "분석" },
  { key: "evaluation", label: "견문", slot: 3, koLineType: "평가" },
  { key: "management", label: "관리", slot: 5, koLineType: "관리" },
  { key: "extension", label: "확장", slot: 4, koLineType: "확장" },
];

// 파트장 신청에서 채우는 카테고리(part-derived). part_submissions line_type 와 동일 키.
export const OVERALL_PART_CATEGORIES: ReadonlyArray<ExperienceOverallCategory> = [
  "derivation",
  "analysis",
  "evaluation",
];

// 팀장이 직접 입력하는 카테고리(leader-input). cells 저장 대상.
export const OVERALL_LEADER_CATEGORIES: ReadonlyArray<ExperienceOverallCategory> = [
  "management",
  "extension",
];

export const EXPERIENCE_OVERALL_CATEGORY_KEYS: ReadonlyArray<ExperienceOverallCategory> =
  EXPERIENCE_OVERALL_CATEGORIES.map((c) => c.key);

// 팀 총괄 5카테고리(도출/분석/견문/확장/관리) 라인명 옵션 — 개설 신청과 동일 원천.
export type OverallLineOptions = Record<
  ExperienceOverallCategory,
  PartInputLineOption[]
>;

export const EMPTY_OVERALL_LINE_OPTIONS: OverallLineOptions = {
  derivation: [],
  analysis: [],
  evaluation: [],
  extension: [],
  management: [],
};

export function isExperienceOverallCategory(
  v: unknown,
): v is ExperienceOverallCategory {
  return (
    typeof v === "string" &&
    (EXPERIENCE_OVERALL_CATEGORY_KEYS as string[]).includes(v)
  );
}

export function isLeaderCategory(v: ExperienceOverallCategory): boolean {
  return (OVERALL_LEADER_CATEGORIES as string[]).includes(v);
}

// '관리'(management) 류 편집/저장 자격 — 파트장/에이전트 전용. 일반 크루는 불가.
//   (개설 완료 시 resolveCategoryLineGroups 가 일반을 라우팅 제외하는 정책과 동일 기준.
//    프론트 disable + 저장 payload 제외 + 백엔드 검수 가드 공용 SoT.)
//   확장(extension)은 자격 무관(주간 활성 여부로만 게이팅).
export function canEditOverallManagement(crew: {
  statusLabel: string;
  isPartLeader: boolean;
}): boolean {
  return crew.isPartLeader || crew.statusLabel === "에이전트";
}

// 기본값: 최초 진입/초기화 시 모든 체크=true, 점수=7, 라인 미선택.
export const OVERALL_CELL_DEFAULT = { checked: true, score: 7 } as const;

// selectedLineId 는 도출/분석/견문(part-derived) 셀에서만 의미(파트 신청 셀 SoT 미러/편집).
//   관리/확장(leader) 셀은 이번 기능 대상 아님 → 항상 미지정(undefined→null).
export type OverallCell = {
  checked: boolean;
  score: number;
  selectedLineId?: string | null;
};

// 강화 실패 판정 = 체크 해제 OR 점수<=3. (표시/반영용 — snapshot 계산과 무관)
export function isOverallCellFail(cell: OverallCell): boolean {
  return !cell.checked || cell.score <= 3;
}

// ── DTO (API ↔ 컴포넌트 공유) ──

export type OverallBoardCrew = {
  userId: string;
  displayName: string;
  partName: string | null;
  statusLabel: string; // "일반" | "에이전트" | "파트장"
  isPartLeader: boolean;
  // 5개 카테고리 전부의 현재 셀(part-derived 는 라이브 병합, leader 는 저장값/기본값).
  cells: Record<ExperienceOverallCategory, OverallCell>;
};

export type OverallBoardPart = {
  partName: string;
  submitted: boolean; // 해당 파트가 [개설 신청] 했는지(미신청이면 도출/분석/견문 기본값).
  crews: OverallBoardCrew[];
};

// ── [개설 검수] 사전조건: 대상 파트 신청 완료 판정(프론트/백엔드 공용 SoT) ──
//   화면 카드 수/프론트 상태가 아니라 board.parts(대상 파트 목록 + 파트별 신청 상태)로 판정한다.
//   제외/비활성/휴식 파트는 이미 board.parts 조립 단계에서 빠져 있으므로 여기서 다시 거르지 않는다.
export type OverallApplicationReadiness = {
  totalPartCount: number; // 대상 파트 전체 수.
  appliedPartCount: number; // [개설 신청] 완료 파트 수.
  unappliedParts: string[]; // 미신청 파트명(board.parts 정렬 유지).
  allPartsApplied: boolean; // 모든 대상 파트 신청 완료 여부(대상 0개면 false).
};

// 프론트 disable/안내 + 서버 검수 가드가 공유하는 순수 판정 함수(기준 불일치 방지).
export function resolveOverallApplicationReadiness(
  parts: ReadonlyArray<Pick<OverallBoardPart, "partName" | "submitted">>,
): OverallApplicationReadiness {
  const unappliedParts = parts.filter((p) => !p.submitted).map((p) => p.partName);
  return {
    totalPartCount: parts.length,
    appliedPartCount: parts.length - unappliedParts.length,
    unappliedParts,
    // 대상 파트가 하나도 없으면 검수 불가(개설할 신청 자체가 없음).
    allPartsApplied: parts.length > 0 && unappliedParts.length === 0,
  };
}

// 검수 차단 안내/오류 문구 — 프론트 안내와 서버 409 오류가 동일 문구를 쓴다.
export const OVERALL_APPLICATION_INCOMPLETE_MESSAGE =
  "아직 모든 파트의 [개설 신청]이 완료되지 않았습니다.";

// 대상 파트가 0개일 때(신청 대상 자체가 없음) — allPartsApplied=false 를 "완료"로 오인하지 않도록
//   별도 문구로 구분한다(프론트 toast·서버 거부 공용). resolveOverallApplicationReadiness 참고.
export const OVERALL_NO_TARGET_PARTS_MESSAGE = "개설 신청 대상 파트가 없습니다.";

export type OverallOutput = {
  category: ExperienceOverallCategory;
  link: string;
  description: string;
  imageUrl: string;
  imageDescription: string;
};

export type OverallOutputRequirementIssue = {
  missingLink: boolean;
  missingImage: boolean;
  firstMissingCategory: ExperienceOverallCategory;
  firstMissingField: "link" | "image";
  message: string;
};

export const OVERALL_OUTPUT_REQUIRED_MESSAGES = {
  both: "아웃풋 링크와 아웃풋 이미지를 모두 입력해야 합니다.",
  link: "아웃풋 링크를 1개 이상 입력해주세요.",
  image: "아웃풋 이미지를 1개 이상 등록해주세요.",
} as const;

/** 프론트와 서버가 함께 쓰는 카테고리별 아웃풋 필수값 판정. 설명 필드는 기존 선택 정책을 유지한다. */
export function validateOverallOutputRequirements(
  outputs: ReadonlyArray<OverallOutput>,
  extensionActive: boolean,
): OverallOutputRequirementIssue | null {
  const byCategory = new Map(outputs.map((output) => [output.category, output]));
  let firstMissingLinkCategory: ExperienceOverallCategory | null = null;
  let firstMissingImageCategory: ExperienceOverallCategory | null = null;
  for (const category of EXPERIENCE_OVERALL_CATEGORIES) {
    if (category.key === "extension" && !extensionActive) continue;
    const output = byCategory.get(category.key);
    if (!output?.link.trim() && !firstMissingLinkCategory) firstMissingLinkCategory = category.key;
    if (!output?.imageUrl.trim() && !firstMissingImageCategory) firstMissingImageCategory = category.key;
  }
  if (!firstMissingLinkCategory && !firstMissingImageCategory) return null;
  // 입력 흐름 우선순위: 모든 활성 류의 링크를 먼저 채운 뒤 이미지를 안내한다.
  const firstMissingField = firstMissingLinkCategory ? "link" : "image";
  return {
    missingLink: Boolean(firstMissingLinkCategory),
    missingImage: Boolean(firstMissingImageCategory),
    firstMissingCategory: firstMissingLinkCategory ?? firstMissingImageCategory!,
    firstMissingField,
    message: firstMissingField === "link"
      ? OVERALL_OUTPUT_REQUIRED_MESSAGES.link
      : OVERALL_OUTPUT_REQUIRED_MESSAGES.image,
  };
}

export type OverallBoardStatus = "none" | "reviewed" | "opened";

export type ExperienceTeamOverallBoard = {
  status: OverallBoardStatus;
  // 이 주차·팀이 실무 경험 라인 "개설 기간"인가(단일 SoT = cluster4_week_opening_configs →
  //   isExperienceLineOpenForWeek). false 면 개설 검수/완료 UI·API 모두 차단(개설되지 않은 상태와 구분).
  //   실무 정보(isInfoLineOpenForWeek)·역량(canOpen)과 동일 의미의 필드. status(opened/reviewed)와 독립.
  canOpen: boolean;
  // canOpen=false 일 때 사유(개설 차단 패널 문구). true 면 null.
  openBlockedReason: string | null;
  // 확장 주간 여부 + 종류(상태창 SoT 와 동일 — cluster4_experience_extension_periods).
  extensionActive: boolean;
  extensionKind: "online" | "offline" | null;
  parts: OverallBoardPart[];
  // 대상 파트 신청 완료 판정(parts 파생) — 프론트 [개설 검수] 버튼 게이팅/서버 가드 공용.
  application: OverallApplicationReadiness;
  outputs: OverallOutput[]; // 카테고리별 0~5건(저장된 것만).
  // 라인명 드롭다운 옵션(5카테고리) — 개설 신청과 동일 원천. 도출/분석/견문/확장/관리.
  lineOptions: OverallLineOptions;
  reviewedAt: string | null;
  openedAt: string | null;
};

// ── 라인 선택 저장 payload(도출/분석/견문) — 검수 화면 편집 → 파트 신청 셀 write-back ──
export type OverallLineSelectionDto = {
  crewUserId: string;
  // part-derived 카테고리만(도출/분석/견문). 관리/확장은 대상 아님.
  lineType: ExperiencePartLineType;
  selectedLineId: string | null;
  // 파트장 전용 점수/체크 — 파트장은 [개설 신청] 그리드에서 구조적으로 제외되어(심화(파트장))
  //   part_submission_cells 가 없다. 그래서 도출/분석/견문 점수를 입력할 정상 경로가 없어
  //   [개설 검수] 화면에서 직접 선택한다. 일반/에이전트는 이 필드를 보내지 않으며(undefined),
  //   서버도 파트장 여부로만 반영한다(일반 크루 점수 SoT=개설 신청 셀 불변).
  //   미지정 시 기존 기본값(checked=true/score=7 = OVERALL_CELL_DEFAULT)으로 처리 — 파트장 전용
  //   임의 기본값을 새로 만들지 않는다. 허용 점수·보이드 규칙은 일반 크루와 동일(experienceScoreState).
  checked?: boolean;
  score?: number;
};

export const PART_LEADER_LINE_REQUIRED_MESSAGE =
  "파트장 라인명을 선택해야 개설 검수를 진행할 수 있습니다.";

export type PartLeaderLineRequirementIssue = {
  crewUserId: string;
  category: ExperiencePartLineType;
  message: string;
};

/** 체크되고 1점 이상인 파트장 도출/분석/견문 셀은 라인명이 반드시 있어야 한다. */
export function validatePartLeaderLineRequirements(
  selections: ReadonlyArray<OverallLineSelectionDto>,
  partLeaderUserIds: ReadonlyArray<string>,
): PartLeaderLineRequirementIssue | null {
  const byCell = new Map(
    selections.map((selection) => [
      `${selection.crewUserId}::${selection.lineType}`,
      selection,
    ]),
  );
  for (const crewUserId of partLeaderUserIds) {
    for (const category of OVERALL_PART_CATEGORIES) {
      const selection = byCell.get(`${crewUserId}::${category}`);
      const checked = selection?.checked ?? true;
      const score = selection?.score ?? OVERALL_CELL_DEFAULT.score;
      if (checked && score >= 1 && !selection?.selectedLineId) {
        return {
          crewUserId,
          category: category as ExperiencePartLineType,
          message: PART_LEADER_LINE_REQUIRED_MESSAGE,
        };
      }
    }
  }
  return null;
}

// ── 저장 payload (POST) ──

export type OverallLeaderCellDto = {
  crewUserId: string;
  category: "management" | "extension";
  checked: boolean;
  score: number;
  // 선택 라인 ID(관리/확장 라인명). 미선택/강화실패 = null. 저장=team_overall_cells.selected_line_id.
  selectedLineId: string | null;
};

export type OverallSaveAction = "review" | "open" | "cancel";
