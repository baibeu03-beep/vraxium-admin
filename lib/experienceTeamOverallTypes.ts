// 실무 경험 [팀 총괄] 화면 — 공용 상수/타입(browser-safe, DB 무관).
// 컴포넌트/데이터레이어/API/검증 스크립트가 공유한다.
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

// 기본값: 최초 진입/초기화 시 모든 체크=true, 점수=7.
export const OVERALL_CELL_DEFAULT = { checked: true, score: 7 } as const;

export type OverallCell = { checked: boolean; score: number };

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
};

export type OverallBoardStatus = "none" | "reviewed" | "opened";

export type ExperienceTeamOverallBoard = {
  status: OverallBoardStatus;
  // 확장 주간 여부 + 종류(상태창 SoT 와 동일 — cluster4_experience_extension_periods).
  extensionActive: boolean;
  extensionKind: "online" | "offline" | null;
  parts: OverallBoardPart[];
  // 대상 파트 신청 완료 판정(parts 파생) — 프론트 [개설 검수] 버튼 게이팅/서버 가드 공용.
  application: OverallApplicationReadiness;
  outputs: OverallOutput[]; // 카테고리별 0~5건(저장된 것만).
  reviewedAt: string | null;
  openedAt: string | null;
};

// ── 저장 payload (POST) ──

export type OverallLeaderCellDto = {
  crewUserId: string;
  category: "management" | "extension";
  checked: boolean;
  score: number;
};

export type OverallSaveAction = "review" | "open" | "cancel";
