import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

// ─────────────────────────────────────────────────────────────────────
// 주차 카드 사전 계산 결과(snapshot) 데이터 레이어.
//
// 읽기(readWeeklyCardsSnapshot): 화면 조회 API 전용 — 단일 SELECT, 무거운 계산 0.
// 쓰기(recomputeAndStoreWeeklyCardsSnapshot): 관리자 저장/sync/cron/lazy-fallback 시점에만.
//   계산 자체는 기존 getCluster4WeeklyCardsForProfileUser(실시간 계산 함수)를 그대로 재사용한다
//   (함수 삭제 금지 — snapshot 생성용으로 보존).
//
// dto_version: DTO 스키마가 바뀌면 이 상수를 올린다. 저장된 snapshot.dto_version 이 현재 값과
//   다르면 읽기에서 miss 로 취급 → 재계산. (구버전 직렬화 데이터를 그대로 내려주지 않기 위함.)
// ─────────────────────────────────────────────────────────────────────

export const WEEKLY_CARDS_DTO_VERSION = 1;

const TABLE = "cluster4_weekly_card_snapshots";

export type WeeklyCardsSnapshotRead = {
  cards: Cluster4WeeklyCardDto[];
  computedAt: string;
  isStale: boolean;
};

// 저장된 snapshot 1행을 읽는다(단일 SELECT). 정상 hit 시 쿼리 1개.
// 반환:
//   - 객체: 현재 dto_version 과 일치하는 snapshot 존재(= 사용 가능). is_stale 여도 그대로 반환
//           (정책: stale 여도 기존 값 노출, cron/훅이 재계산). 호출부가 staleness 를 로깅한다.
//   - null: 행 없음 / dto_version 불일치(스키마 변경) / 조회 오류 → 호출부가 miss(lazy 계산) 처리.
export async function readWeeklyCardsSnapshot(
  profileUserId: string,
): Promise<WeeklyCardsSnapshotRead | null> {
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select("cards,dto_version,is_stale,computed_at")
    .eq("user_id", profileUserId)
    .maybeSingle();

  if (error) {
    // 테이블 미생성/권한 등 → miss 로 폴백(읽기 경로가 깨지지 않게). 호출부가 lazy 계산.
    console.warn("[weekly-cards][snapshot] read failed → treat as miss", {
      profileUserId,
      message: error.message,
    });
    return null;
  }
  if (!data) return null;

  const row = data as {
    cards: unknown;
    dto_version: number;
    is_stale: boolean;
    computed_at: string;
  };

  // 스키마 버전 불일치 → 구버전 직렬화 데이터를 내려주지 않고 재계산 유도.
  if (row.dto_version !== WEEKLY_CARDS_DTO_VERSION) return null;
  if (!Array.isArray(row.cards)) return null;

  return {
    cards: row.cards as Cluster4WeeklyCardDto[],
    computedAt: row.computed_at,
    isStale: row.is_stale,
  };
}

// 실시간 계산(기존 함수) → snapshot upsert. 계산 결과 배열을 그대로 반환한다.
// 관리자 저장/sync 훅, cron, 그리고 읽기 경로의 lazy-fallback(미존재 시 1회)에서 호출한다.
// 계산이 실패하면 throw — 호출부(라우트)가 기존 에러 형식으로 변환한다.
export async function recomputeAndStoreWeeklyCardsSnapshot(
  profileUserId: string,
): Promise<Cluster4WeeklyCardDto[]> {
  const cards = await getCluster4WeeklyCardsForProfileUser(profileUserId);

  const { error } = await supabaseAdmin.from(TABLE).upsert(
    {
      user_id: profileUserId,
      cards,
      card_count: cards.length,
      dto_version: WEEKLY_CARDS_DTO_VERSION,
      is_stale: false,
      computed_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  if (error) {
    // 저장 실패해도 계산된 카드는 반환(이번 요청은 응답 가능). 다음 cron 이 재시도.
    console.warn("[weekly-cards][snapshot] upsert failed (returning computed cards)", {
      profileUserId,
      message: error.message,
    });
  }

  return cards;
}

// 입력 변경 시 "재계산 필요" 표시만 남긴다(즉시 계산하지 않음). 관리자 저장/sync 훅에서 사용 예정.
// cron 이 is_stale=true 행을 모아 재계산한다. 행이 없으면 no-op(다음 lazy/cron 에서 생성).
export async function markWeeklyCardsSnapshotStale(
  profileUserId: string,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from(TABLE)
    .update({ is_stale: true })
    .eq("user_id", profileUserId);
  if (error) {
    console.warn("[weekly-cards][snapshot] mark stale failed", {
      profileUserId,
      message: error.message,
    });
  }
}
