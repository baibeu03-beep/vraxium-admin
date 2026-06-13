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

// 기본값: 최초 진입/초기화 시 모든 체크=true, 점수=7.
export const PART_CELL_DEFAULT = { checked: true, score: 7 } as const;

// 팀 총괄(집계) 선택값 — 실제 파트가 아님.
export const TEAM_OVERALL = "__overall__";

export type PartInputCell = { checked: boolean; score: number };

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
  submitted: boolean;
  aggregate: PartOverallAggregate | null; // 팀 총괄 모드일 때만
};
