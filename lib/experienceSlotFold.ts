import type { Cluster4LineDetailDto } from "@/shared/cluster4.contracts";

// ─────────────────────────────────────────────────────────────────────
// 실무 경험 "유형 슬롯" 폴딩 — 성장률 집계·관리자 표·크루 카드가 공유하는 **단일 resolver**.
//   화면별로 따로 계산하지 않는다(요구). 한 유형(도출/분석/견문/관리/확장) 슬롯당 정확히 1개로 접는다.
//
//   정책(사용자 확정 2026-07-17):
//     · 유형 오픈 + 본인 대상자      = 강화 성공(성공/실패는 본인 결과)  → 분모 포함, 성공 시 분자.
//     · 유형 오픈 + 본인 비대상      = 강화 실패                        → 분모 포함(분자 아님).
//     · 유형 미오픈                  = 해당 없음                        → 분모/분자 모두 제외.
//   즉 강화율 분모 = "그 주차에 오픈된 경험 유형 수", 분자 = "그중 본인 배정·성공한 유형 수".
//
//   ⚠ 같은 유형에 사용자별로 다른 라인이 개설돼도 유형 단위로 1칸이므로 희석(도출 n/4)이 없고,
//     본인 미배정(타인 라인)도 유형이 오픈됐으면 실패로 분모에 포함된다. 대표(rep) 라인의
//     enhancementStatus 를 그대로 사용하므로(재판정 없음) 미확정 주차의 pending 도 그대로 반영된다.
// ─────────────────────────────────────────────────────────────────────

export type FoldedExperienceSlot = {
  // 이 슬롯을 대표하는 카드 라인(표시·상세의 원천). 본인 배정 우선.
  rep: Cluster4LineDetailDto;
  slotKey: string;
  // 본인에게 실제 배정(선택)된 라인 슬롯인가.
  isOwn: boolean;
  // 클럽에서 그 유형이 오픈됐는가(= enhancementStatus !== "not_applicable"). 강화율 분모.
  open: boolean;
  // 본인 배정·강화 성공 유형인가. 강화율 분자.
  success: boolean;
};

// 카드의 모든 라인에서 experience 만 골라 유형 슬롯당 1개로 접는다.
//   그룹 키 = experienceSlotOrder(있으면) > experienceCategory > "none"(레거시/미분류 통합 라인·na).
//   대표 선택 = 본인 배정(성공 우선) > 오픈 비대상(na 아님) > 첫 행(na placeholder).
export function foldExperienceSlots(
  lines: readonly Cluster4LineDetailDto[],
): FoldedExperienceSlot[] {
  const groups = new Map<string, Cluster4LineDetailDto[]>();
  for (const l of lines) {
    if (l.partType !== "experience") continue;
    const key =
      l.experienceSlotOrder != null
        ? `slot:${l.experienceSlotOrder}`
        : l.experienceCategory ?? "none";
    const arr = groups.get(key);
    if (arr) arr.push(l);
    else groups.set(key, [l]);
  }
  const out: FoldedExperienceSlot[] = [];
  for (const [slotKey, arr] of groups) {
    const assigned = arr.filter((l) => l.lineTargetId != null);
    const rep = assigned.length
      ? assigned.find((l) => l.enhancementStatus === "success") ?? assigned[0]
      : arr.find((l) => l.enhancementStatus !== "not_applicable") ?? arr[0];
    out.push({
      rep,
      slotKey,
      isOwn: rep.lineTargetId != null,
      open: rep.enhancementStatus !== "not_applicable",
      success: rep.enhancementStatus === "success",
    });
  }
  return out;
}

// 강화율 집계값(분모/분자) — breakdownFromLines.experience 가 이 값을 그대로 쓴다.
export function experienceBreakdownFromFold(
  lines: readonly Cluster4LineDetailDto[],
): { available: number; completed: number } {
  const slots = foldExperienceSlots(lines);
  return {
    available: slots.filter((s) => s.open).length,
    completed: slots.filter((s) => s.success).length,
  };
}
