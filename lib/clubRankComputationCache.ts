// 클럽 품계(club-rank) 전체 모집단 계산 결과의 **짧은 수명 프로세스 메모리 캐시** — server-only.
//
// 왜 필요한가:
//   품계는 상대 백분위라 한 사람의 값을 구하려면 전 사용자의 user_weekly_points(약 1.5만 행)를
//   읽어 주차별 RANK 를 다시 매겨야 한다. /admin/members·주차 쇼케이스는 요청마다 이 전수 계산을
//   유발해 응답이 1초 이상 늘어났다. 값을 캐시하지 않고 **계산 결과 전체를 한 덩어리로** 짧게
//   재사용해 그 반복을 없앤다.
//
// 계약(중요):
//   · 캐시 단위 = "동일 시점의 전체 모집단 계산 결과 1개". 사용자별로 부분 교체하지 않는다
//     (일부만 새 값이면 서로 다른 계산 시점이 한 화면에 섞인다).
//   · 캐시 키 없음(전역 1개). 계산기는 mode/actAs/demo/org 로 분기하지 않으므로
//     (대상 선택만 다르다) scope 를 키에 넣으면 같은 계산을 쓸데없이 여러 벌 갖게 된다.
//   · TTL 이 지난 결과는 **정상 응답의 권위 원천으로 쓰지 않는다**. stale-while-error 없음 —
//     재계산이 실패하면 그 실패를 그대로 올린다(조용한 옛값 반환 금지).
//   · single-flight: 캐시가 빈 순간 동시 요청이 몰려도 전수 계산은 1회만. 실패한 promise 는
//     보관하지 않는다(다음 요청이 재시도).
//   · 산식·모집단·rest 제외·frozen·온보딩 제외는 일절 관여하지 않는다 — 이 모듈은 순수 저장소다.
//
// 배포 환경 전제:
//   Vercel 서버리스(vercel.json regions=["icn1"], Fluid Compute 기본) = **다중 인스턴스**.
//   따라서 이 캐시는 인스턴스별 best-effort 이며, 전역 일관성을 보장하지 않는다. 그래서
//   (a) TTL 을 짧게 잡고 (b) 순위에 영향을 주는 쓰기 성공 뒤 invalidate 를 호출하며
//   (c) 공표처럼 확정이 걸린 경로는 forceRefresh 로 캐시를 건너뛴다.
//   인스턴스가 재활용되면 모듈 메모리가 유지되고, 콜드 스타트에서는 빈 캐시로 시작한다.

export type ClubRankComputation<V> = {
  /** 전체 모집단 계산 결과 1덩어리. 이 Map 은 절대 부분 수정하지 않는다(freeze 계약). */
  map: Map<string, V>;
  /** 계산이 끝난 시각(ms). 신선도 판정·디버깅용. */
  computedAt: number;
};

// TTL 30초 근거:
//   · 품계 입력(user_weekly_points)은 운영자 적립/검수 같은 이산 이벤트로만 바뀐다(초당 변경 아님).
//   · 그 이벤트 경로에는 invalidate 훅이 걸려 있어 TTL 은 "훅이 빠진 경로"에 대한 안전망일 뿐이다.
//   · 다중 인스턴스라 전역 정합은 어차피 보장되지 않으므로, 관리자가 화면을 한 번 새로고침하는
//     체감 시간(수십 초) 안에서 수렴하면 충분하다.
//   · 60초를 넘기면 "포인트 고쳤는데 목록이 그대로"라는 오인이 실제로 생길 수 있어 상한을 둔다.
export const CLUB_RANK_CACHE_TTL_MS = 30_000;

let cached: ClubRankComputation<unknown> | null = null;
let inflight: Promise<ClubRankComputation<unknown>> | null = null;
// 무효화 세대 — 계산 도중 들어온 invalidate 가 그 계산 결과에 의해 덮이지 않게 한다.
//   (invalidate 시점 이전에 시작된 계산은 이미 옛 데이터를 읽었을 수 있다.)
let generation = 0;

/**
 * 순위 결과에 영향을 주는 쓰기가 **성공한 뒤** 호출한다. 다음 조회는 새로 계산한다.
 * 진행 중인 계산이 있으면 그 결과도 캐시에 채택하지 않는다(옛 스냅샷 고착 방지).
 */
export function invalidateClubRankComputationCache(reason?: string): void {
  cached = null;
  generation += 1;
  if (process.env.CLUB_RANK_PROFILE === "1") {
    console.log("[clubRankCache] invalidate", { reason: reason ?? "(unspecified)", generation });
  }
}

/** 테스트/검증 전용 — 현재 캐시 상태 관찰(값은 반환하지 않는다). */
export function peekClubRankComputationCache(): {
  hasFresh: boolean;
  ageMs: number | null;
  inflight: boolean;
  generation: number;
} {
  const age = cached ? Date.now() - cached.computedAt : null;
  return {
    hasFresh: cached != null && age != null && age < CLUB_RANK_CACHE_TTL_MS,
    ageMs: age,
    inflight: inflight != null,
    generation,
  };
}

/**
 * 신선한 캐시가 있으면 그대로, 없으면 single-flight 로 1회만 계산한다.
 *
 * @param compute 전체 모집단 계산 함수. 캐시 모듈은 내용을 해석하지 않는다.
 * @param forceRefresh true 면 캐시를 무시하고 새로 계산한다(공표 등 확정 경로).
 *                     이때도 single-flight 는 공유하지 않는다 — 진행 중인 계산은 이 요청보다
 *                     먼저 시작됐을 수 있어 "지금 시점" 보장이 되지 않기 때문이다.
 */
export async function getClubRankComputation<V>(
  compute: () => Promise<Map<string, V>>,
  options?: { forceRefresh?: boolean },
): Promise<ClubRankComputation<V> & { source: "cache" | "computed" }> {
  const profile = process.env.CLUB_RANK_PROFILE === "1";

  if (!options?.forceRefresh) {
    const fresh = cached;
    if (fresh && Date.now() - fresh.computedAt < CLUB_RANK_CACHE_TTL_MS) {
      if (profile) console.log("[clubRankCache] hit", { ageMs: Date.now() - fresh.computedAt });
      return { ...(fresh as ClubRankComputation<V>), source: "cache" };
    }
    if (inflight) {
      if (profile) console.log("[clubRankCache] join inflight");
      const joined = (await inflight) as ClubRankComputation<V>;
      return { ...joined, source: "computed" };
    }
  }

  const startedGeneration = generation;
  const run = (async () => {
    const t0 = Date.now();
    const map = await compute();
    const entry: ClubRankComputation<unknown> = { map, computedAt: Date.now() };
    // 계산 도중 invalidate 가 있었으면 결과를 캐시에 남기지 않는다(값 자체는 정상이라 반환은 한다).
    if (generation === startedGeneration) cached = entry;
    if (profile) {
      console.log("[clubRankCache] computed", {
        ms: Date.now() - t0,
        users: map.size,
        stored: generation === startedGeneration,
      });
    }
    return entry;
  })();

  // forceRefresh 계산은 다른 요청이 올라타지 못하게 한다(그 요청의 "지금" 보장이 깨진다).
  if (!options?.forceRefresh) inflight = run;
  try {
    const entry = (await run) as ClubRankComputation<V>;
    return { ...entry, source: "computed" };
  } finally {
    // 실패한 promise 를 남겨두면 이후 요청이 전부 같은 오류를 받는다 → 항상 해제.
    if (inflight === run) inflight = null;
  }
}
