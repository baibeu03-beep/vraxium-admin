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

// v2 (2026-06-01): career line DTO 에 sponsor-card 메타 6필드(companyName/companyLogoUrl/
//   supervisorName/supervisorDepartment/supervisorPosition/supervisorPhotoUrl) 추가.
//   기존 v1 snapshot 은 해당 필드가 없으므로 읽기에서 miss 처리 → 재계산되어 신필드가 채워진다.
export const WEEKLY_CARDS_DTO_VERSION = 2;

const TABLE = "cluster4_weekly_card_snapshots";

// 읽기 결과를 구분형으로 반환한다 — 호출부가 "절대 무거운 계산 없이" 분기할 수 있게.
//   hit   : 정상(현재 버전 + fresh). 그대로 노출.
//   stale : 행은 있으나 (is_stale=true) 또는 (dto_version 불일치). cards 배열은 사용 가능하므로
//           graceful 하게 노출하고, cron 이 재생성하게 둔다(버전 불일치도 구 카드를 빈 화면보다 우선).
//   miss  : 행 없음(신규 유저) 또는 cards 손상. 노출할 게 없음.
//   error : SELECT 실패(일시 오류/권한/테이블). 노출할 게 없음 — 무거운 계산으로 빠지지 않는다.
export type WeeklyCardsSnapshotOutcome =
  | { status: "hit"; cards: Cluster4WeeklyCardDto[]; computedAt: string }
  | {
      status: "stale";
      cards: Cluster4WeeklyCardDto[];
      computedAt: string;
      reason: "is_stale" | "version_mismatch";
    }
  | { status: "miss" }
  | { status: "error"; message: string };

// 저장된 snapshot 1행을 읽는다(단일 SELECT). 정상 시 쿼리 1개. 무거운 계산은 절대 하지 않는다.
export async function readWeeklyCardsSnapshot(
  profileUserId: string,
): Promise<WeeklyCardsSnapshotOutcome> {
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select("cards,dto_version,is_stale,computed_at")
    .eq("user_id", profileUserId)
    .maybeSingle();

  if (error) {
    // ⚠ 조회 실패를 miss 로 강등하지 않는다 — miss 로 보면 (lazy 허용 시) 무거운 계산으로 빠진다.
    console.warn("[weekly-cards][snapshot] read error", {
      profileUserId,
      message: error.message,
    });
    return { status: "error", message: error.message };
  }
  if (!data) return { status: "miss" };

  const row = data as {
    cards: unknown;
    dto_version: number;
    is_stale: boolean;
    computed_at: string;
  };

  // cards 가 배열이 아니면(손상) 노출 불가 → miss.
  if (!Array.isArray(row.cards)) return { status: "miss" };
  const cards = row.cards as Cluster4WeeklyCardDto[];

  // 버전 불일치: 구 카드(배열)는 사용 가능하므로 stale 로 노출(빈 화면 방지) + cron 이 재생성.
  if (row.dto_version !== WEEKLY_CARDS_DTO_VERSION) {
    return { status: "stale", cards, computedAt: row.computed_at, reason: "version_mismatch" };
  }
  if (row.is_stale) {
    return { status: "stale", cards, computedAt: row.computed_at, reason: "is_stale" };
  }
  return { status: "hit", cards, computedAt: row.computed_at };
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

  // 재계산 후보: stale 이거나 / computed_at 이 오래된(due) 행 / dto_version 불일치(스키마 변경 후
  // 아직 신버전으로 재생성 안 된 행 — computed_at 이 최신이어도 반드시 잡아야 화면이 신버전으로 수렴).
  // 오래된 순(asc)으로 우선.
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select("user_id,computed_at,is_stale")
    .or(
      `is_stale.eq.true,computed_at.lt.${dueThresholdIso},dto_version.neq.${WEEKLY_CARDS_DTO_VERSION}`,
    )
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

// 특정 사용자들의 snapshot 을 즉시 재계산·저장한다(관리자 저장 직후 변경 즉시 반영용).
//   mark-stale 만 하면 lazy-on-read 또는 cron 에 의존하는데, snapshot-only(DISABLE_LAZY) 런타임이나
//   다음 조회가 늦어지는 경우 옛값이 계속 노출된다. 저장 시점에 바로 재계산해 그 race 를 제거한다.
// 실패는 사용자별로 격리(로그+계속) — 실패한 사용자는 markStale 상태로 남아 cron 이 보정한다.
// best-effort: 전체가 throw 하지 않는다(본 저장 요청 응답을 깨뜨리지 않음).
export async function recomputeWeeklyCardsSnapshotsForUsers(
  profileUserIds: string[],
  opts: { concurrency?: number } = {},
): Promise<{ requested: number; recomputed: number; failed: number; failedUserIds: string[] }> {
  const uniqueIds = Array.from(
    new Set(profileUserIds.filter((id): id is string => Boolean(id))),
  );
  if (uniqueIds.length === 0) {
    return { requested: 0, recomputed: 0, failed: 0, failedUserIds: [] };
  }
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const failedUserIds: string[] = [];
  let recomputed = 0;

  let cursor = 0;
  async function worker() {
    while (cursor < uniqueIds.length) {
      const uid = uniqueIds[cursor++];
      try {
        await recomputeAndStoreWeeklyCardsSnapshot(uid);
        recomputed++;
      } catch (e) {
        // 실패 격리: 해당 사용자는 markStale 상태로 남아 cron/lazy 가 보정.
        failedUserIds.push(uid);
        console.warn("[weekly-cards][snapshot] eager recompute failed (left stale)", {
          userId: uid,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, uniqueIds.length) }, () => worker()),
  );

  return {
    requested: uniqueIds.length,
    recomputed,
    failed: failedUserIds.length,
    failedUserIds,
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

// 관리자 훅 전용: 변경된 사용자의 snapshot 을 그 자리에서 즉시 재계산(변경 즉시 반영용).
// 조회 경로는 snapshot-only(계산 안 함)이므로, 즉시 반영이 필요한 단건 변경은 쓰기 시점에 여기서 갱신한다.
// best-effort: 재계산이 실패해도 본 쓰기 요청을 깨뜨리지 않는다 — 실패 시 stale 로 표시해 cron 이 재시도.
//   (실패 시에도 upsert 가 일어나지 않아 기존 snapshot 은 보존된다.)
export async function refreshWeeklyCardsSnapshotSafe(
  profileUserId: string,
): Promise<void> {
  try {
    await recomputeAndStoreWeeklyCardsSnapshot(profileUserId);
  } catch (e) {
    console.warn(
      "[weekly-cards][snapshot] hook recompute failed → mark stale for cron retry",
      { profileUserId, message: e instanceof Error ? e.message : String(e) },
    );
    await markWeeklyCardsSnapshotStale(profileUserId);
  }
}

// 입력 변경 시 "재계산 필요" 표시만 남긴다(즉시 계산하지 않음). 관리자 저장/sync 훅에서 사용.
// 조회 경로는 stale 여도 구 카드를 그대로 노출하고 계산하지 않는다(snapshot-only). 재생성은 cron 이
// is_stale=true / dto_version 불일치 / due 행을 모아 수행한다(주기 갱신).
// 행이 없으면 no-op(UPDATE 라 신규 유저에는 영향 없음 — 다음 cron/백필 에서 생성).
// best-effort: 실패해도 throw 하지 않는다(본 쓰기 요청을 깨뜨리지 않음, 다음 cron 이 보정).
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

// 여러 사용자 snapshot 을 한 번의 UPDATE 로 stale 처리한다(career 라인 개설 = 대상자 N명).
// 빈/중복 id 는 정리하고, 행이 없는 사용자는 자연스럽게 no-op. best-effort(throw 안 함).
export async function markWeeklyCardsSnapshotStaleMany(
  profileUserIds: string[],
): Promise<void> {
  const uniqueIds = Array.from(
    new Set(profileUserIds.filter((id): id is string => Boolean(id))),
  );
  if (uniqueIds.length === 0) return;
  const { error } = await supabaseAdmin
    .from(TABLE)
    .update({ is_stale: true })
    .in("user_id", uniqueIds);
  if (error) {
    console.warn("[weekly-cards][snapshot] mark stale (many) failed", {
      count: uniqueIds.length,
      message: error.message,
    });
  }
}
