import type { PositionCode } from "@/lib/positionHistory";

// ── 주차별 파트/클래스 저장 검증 — 클라이언트(draft) · 서버(effective 재계산) **공용 규칙** ──
//   같은 로직을 양쪽에서 써서 우회 저장이 잘못된 상태를 만들지 못하게 한다. 순수 함수(서버 import 없음).
//   검증 기준 = 변경을 적용한 **전체 팀 next 상태**(DB 저장 상태가 아니라 nextRows).

export type PositionDraftRow = {
  userId: string;
  rawPart: string | null;
  positionCode: PositionCode;
};
export type ValidationResult = { ok: true } | { ok: false; message: string };

const PART_LEADER_MSG = "해당 파트에는 이미 ‘심화(파트장)’ 크루가 존재합니다.";
const ADVANCED_RATIO_MSG = "현재 팀의 ‘심화’ 크루가 너무 많아서, 더 배정할 수 없습니다.";

// 주차별 팀 <운용> 파트(=배정 크루 ≥1 파트) 상한. '일반'(DEFAULT_PART_NAME)도 실 파트 bucket 이라
//   운용 파트로 카운트한다 — [A] operatedParts SoT(adminTeamSelectedWeekSummary)·매트릭스와 동일 정의.
//   ⚠ 파트 "생성" 개수 제한 아님(파트는 무제한 생성 가능). next 상태의 distinct rawPart 로만 판정.
export const OPERATED_PART_LIMIT = 6;
const OPERATED_PART_LIMIT_MSG = `각 주의 <운용> 파트는 최대 ${OPERATED_PART_LIMIT}개를 넘을 수 없습니다. 지금 배정한 파트는 ${OPERATED_PART_LIMIT + 1}번째 입니다.`;

// 같은 파트의 '심화(파트장)'은 최대 1명.
export function validatePartLeaderUniqueness(rows: PositionDraftRow[]): ValidationResult {
  const byPart = new Map<string, number>();
  for (const r of rows) {
    if (r.positionCode !== "advanced_part_leader") continue;
    const part = (r.rawPart ?? "").trim();
    if (!part) continue;
    const n = (byPart.get(part) ?? 0) + 1;
    if (n > 1) return { ok: false, message: PART_LEADER_MSG };
    byPart.set(part, n);
  }
  return { ok: true };
}

// 팀 전체에서 심화(에이전트+파트장) <= 정규.
export function validateAdvancedRatio(rows: PositionDraftRow[]): ValidationResult {
  let regular = 0;
  let advanced = 0;
  for (const r of rows) {
    if (r.positionCode === "regular") regular++;
    else if (r.positionCode === "advanced_agent" || r.positionCode === "advanced_part_leader")
      advanced++;
  }
  if (advanced > regular) return { ok: false, message: ADVANCED_RATIO_MSG };
  return { ok: true };
}

// next 상태에서 실제 크루가 배정된(rawPart 비어있지 않은) distinct 파트 수 ≤ 6.
//   변경을 가상 적용한 **최종 draft 전체**로 재계산하므로: 운용 파트 간 이동(6→6)·마지막 크루 이동에
//   따른 파트 교체(A 0명 되고 G 1명 → 여전히 6)는 통과하고, 미운용 파트가 새로 운용되어 7이 되면 차단.
export function validateOperatedPartLimit(rows: PositionDraftRow[]): ValidationResult {
  const parts = new Set<string>();
  for (const r of rows) {
    const p = (r.rawPart ?? "").trim();
    if (p) parts.add(p);
  }
  if (parts.size > OPERATED_PART_LIMIT) return { ok: false, message: OPERATED_PART_LIMIT_MSG };
  return { ok: true };
}

export function validateWeekPositionRows(rows: PositionDraftRow[]): ValidationResult {
  const a = validatePartLeaderUniqueness(rows);
  if (!a.ok) return a;
  const b = validateAdvancedRatio(rows);
  if (!b.ok) return b;
  return validateOperatedPartLimit(rows);
}

export const POSITION_CODE_VALUES: PositionCode[] = [
  "regular",
  "advanced_agent",
  "advanced_part_leader",
];
