import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { deriveEndStatus } from "@/lib/growthCore";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

// ─────────────────────────────────────────────────────────────────────
// 성장 중단(suspended/paused) 표시 정책 — read-time 단일 SoT (snapshot 무접촉).
//
// 목적(2026-06-16): 고객 4허브 주차 카드 목록과 이력서/허브 배지에서 "성장 중단"을
//   단일 DTO 출처로 일관 적용한다. 데모(demoUserId·mode=test)와 일반 모드가 같은
//   응답 필드를 보도록 growthInfo 를 응답 envelope 에 함께 내려, 프론트가 /api/profile
//   유무·재계산에 의존하지 않게 한다.
//
// 정책(사용자 확정):
//   ① 허브 상단/이력서 배지 = 성장 중단 (deriveEndStatus==="stopped").
//   ② 주차 카드 목록 = "성장 중단 이전에 확정된 주차"까지만 노출. 이후(미확정·진행/집계)
//      주차 카드는 생성·노출하지 않는다 → running/tallying 카드 제거.
//   ③ 과거 success/fail/personal_rest/official_rest 결과는 그대로 보존(소급 변경 없음).
//   ④ 누적 인정주차·강화율·시즌 성장률·이력서 활동완료율은 "확정 주차" 기준으로 유지된다
//      (미확정 주차를 빼면 분모/분자에서 자연 제외 — 확정값 불변).
//   ⑤ snapshot 은 전체 카드를 그대로 저장한다(불변). 본 정책은 조회 시점에만 적용 →
//      성장상태 변경이 즉시 반영되고 snapshot 재계산이 불필요하다.
//
// ⚠ 성장 중단이 아닌 사용자(active/graduated/휴식 등)는 truncation 미적용 — 기존 동작 불변.
// ─────────────────────────────────────────────────────────────────────

export type GrowthStopInfo = {
  // user_profiles.status (raw enum) — 프론트 getGrowthBadgeText/resolveCrewStatus 입력 호환.
  status: string | null;
  // user_profiles.growth_status (raw enum) — 수동 오버라이드(graduated/suspended/paused) 포함.
  growthStatus: string | null;
  // 성장 중단(suspended/paused) 여부 — deriveEndStatus==="stopped".
  isStopped: boolean;
};

// 사용자 1명의 성장 배지/중단 신호를 단일 SELECT 로 읽는다(무거운 계산 0).
//   조회 실패/행 없음 → 중단 아님(보수적: 카드 truncation 없음, 배지는 raw null).
export async function loadGrowthStopInfo(
  userId: string,
): Promise<GrowthStopInfo> {
  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select("status,growth_status")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) {
    if (error) {
      console.warn("[growth-stop] profile read failed → 중단 아님 처리", {
        userId,
        message: error.message,
      });
    }
    return { status: null, growthStatus: null, isStopped: false };
  }
  const status = (data.status as string | null) ?? null;
  const growthStatus = (data.growth_status as string | null) ?? null;
  return {
    status,
    growthStatus,
    isStopped: deriveEndStatus(growthStatus) === "stopped",
  };
}

// 성장 중단 사용자의 카드 목록을 "확정 주차"까지만 남긴다.
//   미확정 상태(running=진행 중, tallying=집계 중) 카드를 제거한다(= 중단 이후 노출 금지).
//   확정 상태(success/fail/personal_rest/official_rest)는 보존.
//   중단이 아니면 입력 배열을 그대로 반환(기존 동작 불변).
export function truncateCardsForGrowthStop(
  cards: Cluster4WeeklyCardDto[],
  isStopped: boolean,
): Cluster4WeeklyCardDto[] {
  if (!isStopped) return cards;
  return cards.filter(
    (c) => c.userWeekStatus !== "running" && c.userWeekStatus !== "tallying",
  );
}
