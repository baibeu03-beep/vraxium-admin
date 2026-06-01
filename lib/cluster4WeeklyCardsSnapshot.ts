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

// ─────────────────────────────────────────────────────────────────────
// Cron/배치 재계산: is_stale=true 또는 computed_at 이 오래된(due) 기존 snapshot 을
// 오래된 순으로 maxUsers 만큼 재계산한다. 조회 API 는 절대 이 경로를 타지 않는다.
//
// 안전: 사용자별 재계산 실패는 격리(로그+계속)하며, 실패 시 upsert 가 일어나지 않아
//   기존 snapshot 이 그대로 유지된다(정책: Cron 실패 시 기존 값 보존).
// 신규 사용자(행 없음)는 여기서 다루지 않는다 — 백필/lazy 가 담당.
// ─────────────────────────────────────────────────────────────────────
export type SnapshotRecomputeResult = {
  scanned: number;
  recomputed: number;
  failed: number;
  failedUserIds: string[];
  durationMs: number;
};

export async function recomputeStaleOrDueSnapshots(opts: {
  maxUsers?: number;
  dueOlderThanMs?: number;
  concurrency?: number;
  now?: number;
} = {}): Promise<SnapshotRecomputeResult> {
  const now = opts.now ?? Date.now();
  const maxUsers = opts.maxUsers ?? 200;
  const dueOlderThanMs = opts.dueOlderThanMs ?? 60 * 60 * 1000; // 기본 1시간
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const t0 = Date.now();
  const dueThresholdIso = new Date(now - dueOlderThanMs).toISOString();

  // 재계산 후보: stale 이거나 computed_at 이 오래된 행. 오래된 순(asc)으로 우선.
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select("user_id,computed_at,is_stale")
    .or(`is_stale.eq.true,computed_at.lt.${dueThresholdIso}`)
    .order("computed_at", { ascending: true })
    .limit(maxUsers);

  if (error) {
    console.warn("[weekly-cards][snapshot] recompute candidate scan failed", error.message);
    return { scanned: 0, recomputed: 0, failed: 0, failedUserIds: [], durationMs: Date.now() - t0 };
  }

  const userIds = ((data ?? []) as { user_id: string }[]).map((r) => r.user_id);
  const failedUserIds: string[] = [];
  let recomputed = 0;

  let cursor = 0;
  async function worker() {
    while (cursor < userIds.length) {
      const uid = userIds[cursor++];
      try {
        await recomputeAndStoreWeeklyCardsSnapshot(uid);
        recomputed++;
      } catch (e) {
        // 실패 격리: 기존 snapshot 은 보존(upsert 미수행). 다음 run 에서 재시도.
        failedUserIds.push(uid);
        console.warn("[weekly-cards][snapshot] recompute failed (keeping old)", {
          userId: uid,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, userIds.length) }, () => worker()),
  );

  return {
    scanned: userIds.length,
    recomputed,
    failed: failedUserIds.length,
    failedUserIds,
    durationMs: Date.now() - t0,
  };
}

// 조회 시 snapshot miss + lazy 비활성(WEEKLY_CARDS_DISABLE_LAZY=1)일 때 사용.
// 무거운 계산 대신, cron 이 곧바로 집어가도록 "비어있는 stale placeholder 행"을 큐잉한다.
// computed_at 을 epoch(아주 과거)로 두어 due+stale 양쪽으로 잡힌다 → 다음 cron 1순위 재계산.
// 이 함수는 "miss(행 없음)" 경로에서만 호출되므로 ignoreDuplicates 로 기존 정상 snapshot 은 건드리지 않는다.
export async function enqueueStaleSnapshot(profileUserId: string): Promise<void> {
  const { error } = await supabaseAdmin.from(TABLE).upsert(
    {
      user_id: profileUserId,
      cards: [],
      card_count: 0,
      dto_version: WEEKLY_CARDS_DTO_VERSION,
      is_stale: true,
      computed_at: new Date(0).toISOString(),
    },
    { onConflict: "user_id", ignoreDuplicates: true },
  );
  if (error) {
    console.warn("[weekly-cards][snapshot] enqueue stale failed", {
      profileUserId,
      message: error.message,
    });
  }
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
