// =============================================================
// Cluster4 Weekly Cards — 카드 로딩 서비스(공용).
//
// 기존 GET /api/cluster4/weekly-cards 핸들러 내부에 있던 snapshot-only 로더 + overlay +
// 성장 중단 truncation 파이프라인을 그대로 이 모듈로 "이동"한 것이다(로직 무변경).
//   · 목적: 단건 GET 라우트와 슬림 랭킹 projection 배치 라우트가 "동일 함수/동일 계산 경로"를
//           공유하도록(계산 엔진 복제·snapshot 경로 복제 금지) — 결과 byte-identical 보장.
//   · GET 라우트는 이 모듈의 startSubjectPreload/loadWeeklyCards 를 import 해 기존과 동일하게 동작한다.
//   · 배치 라우트는 loadFinalizedWeeklyCards(단건) 를 유저별로 호출한 뒤 랭킹 필드만 projection 한다.
//
// ⚠️ snapshot 생성/조회/stale/version/override/growth-stop 정책은 원본 route 코드 그대로다.
//    특히 조회(GET)가 miss/stale/boundary 에서 recompute·저장(WRITE)하는 동작도 원본과 동일하다.
// =============================================================
import { after } from "next/server";
import {
  readWeeklyCardsSnapshot,
  recomputeAndStoreWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";
import {
  applyEnhancementOverridesToCards,
  loadEnhancementOverridesForUser,
  type Cluster4LineEnhancementOverrideRow,
} from "@/lib/cluster4EnhancementOverride";
import {
  applySecondEntryOverridesToCards,
  loadSecondEntryOverridesForUser,
  type Cluster4LineSecondEntryOverrideRow,
} from "@/lib/cluster4SecondEntryOverride";
import { getCurrentWeekStartMs } from "@/lib/cluster4WeekPolicy";
import {
  loadGrowthStopInfo,
  truncateCardsForGrowthStop,
  type GrowthStopInfo,
} from "@/lib/cluster4GrowthStopPolicy";
import { traceSpan } from "@/lib/perfTrace";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";
import {
  getCurrentActivityDateIso,
  weekStartToBoundaryMs,
} from "@/lib/seasonCalendar";

// ─────────────────────────────────────────────────────────────────────
// 주체(profileUserId) 확정 후 시작할 수 있는 "독립 조회" preload.
//
// 의존관계 실측·정독 결과(2026-07-17):
//   ① scope 결과가 먼저 필요한 것 : resolveRequestScope(데모 판정·주체 결정) → 주체 확정 전제
//   ② userId 만 알면 되는 것      : snapshot / 강화 override / 2차기입 override / growth stop
//                                   → 서로 의존 없음. 넷 다 .eq(user_id) 단건 조회.
//   ③ HIT 여부 확정 후에만 필요   : (없음 — override·growthStop 은 cards 내용과 무관하게 user_id 키)
//   ④ 재계산 경로 영향            : (없음 — 재계산은 snapshot 계열만 건드리고 override 표는 안 읽음)
//   ⑤ 에러 우선순위/HTTP status   : 아래 3종은 전부 loader 내부에서 fail-open(로그+기본값)이라
//                                   status 에 영향을 주지 않는다. snapshot 오류만 outcome=error 로
//                                   기존과 동일하게 처리된다.
//
// 그래서 ②의 3종만 여기서 "시작"하고, await 는 기존 위치·기존 순서 그대로 둔다(I/O 시작 시점만 이동).
//   · 각 promise 는 loader 와 동일한 fail-open 기본값으로 .catch 를 달아 절대 reject 하지 않는다
//     → 조기 return(예: outcome=error) 으로 소비되지 않아도 unhandledRejection 이 생기지 않는다.
//   · snapshot 조회는 loadWeeklyCardsRaw 가 호출 즉시 시작하므로 별도 preload 불필요(같이 in-flight).
//
// ⚠ 관측 가능한 유일한 차이: cards 가 빈 배열이라 apply*() 가 조기 return 하는 희귀 경로에서도
//   override 조회 2건이 실제로 발행된다(기존엔 미발행). 응답 본문·status 는 동일하며 결과는 버려진다.
export type SubjectPreload = {
  enhancementRows: Promise<Cluster4LineEnhancementOverrideRow[]>;
  secondEntryRows: Promise<Cluster4LineSecondEntryOverrideRow[]>;
  growthStop: Promise<GrowthStopInfo>;
};

export function startSubjectPreload(userId: string): SubjectPreload {
  return {
    enhancementRows: traceSpan("preload:enhancementOverrides", () =>
      loadEnhancementOverridesForUser(userId),
    ).catch(() => [] as Cluster4LineEnhancementOverrideRow[]),
    secondEntryRows: traceSpan("preload:secondEntryOverrides", () =>
      loadSecondEntryOverridesForUser(userId),
    ).catch(() => [] as Cluster4LineSecondEntryOverrideRow[]),
    growthStop: traceSpan("preload:growthStopInfo", () =>
      loadGrowthStopInfo(userId),
    ).catch(() => ({ status: null, growthStatus: null, isStopped: false })),
  };
}

export type LoadOutcome = "hit" | "stale" | "miss" | "error";
export type LoadResult = {
  cards: Cluster4WeeklyCardDto[];
  outcome: LoadOutcome;
  detail: string; // stale 사유 / error 메시지 등
  lazyRan: boolean; // 조회 경로에서 무거운 계산이 실제 실행됐는지
};

// version_mismatch 백그라운드 재계산 중복 방지(동일 인스턴스 내). after() 콜백이 끝나면 해제.
//   - 같은 인스턴스에서 동일 사용자가 여러 탭/연속 요청으로 들어와도 재계산은 1회만 예약된다.
//   - 인스턴스 간(Fluid Compute 다중 인스턴스) 전역 dedupe 는 아니지만, 재계산 대상은 "그 사용자
//     1명"이고 upsert 는 멱등이므로 인스턴스 수만큼만 중복될 뿐(사용자 수 herd 아님) 안전.
const versionMismatchRecomputeInFlight = new Set<string>();

// 응답을 블로킹하지 않고(after) 해당 사용자 1명의 snapshot 을 백그라운드 재계산·저장한다.
//   version_mismatch(DTO 버전 bump) 자동 수렴 전용 — deploy 직후 전원 동시 블로킹 재계산(과거 504)
//   을 피하면서도 "사용자 단위"로 신버전에 수렴시킨다. 실패는 격리(로그+계속)하며 upsert 가 일어나지
//   않아 기존 snapshot 이 그대로 보존된다(폴백). after() 불가 컨텍스트면 조용히 생략(구값 유지·
//   수동 ops/다음 인스턴스가 보정).
function scheduleVersionMismatchRecompute(profileUserId: string): void {
  if (versionMismatchRecomputeInFlight.has(profileUserId)) return;
  versionMismatchRecomputeInFlight.add(profileUserId);
  try {
    after(async () => {
      try {
        await recomputeAndStoreWeeklyCardsSnapshot(profileUserId);
        console.log(
          "[weekly-cards] version-mismatch bg recompute ok",
          `user=${profileUserId}`,
        );
      } catch (e) {
        // 실패 격리: upsert 미수행 → 기존(구버전) snapshot 보존. 다음 조회/ops 가 재시도.
        console.warn(
          "[weekly-cards] version-mismatch bg recompute failed (구 snapshot 보존)",
          { profileUserId, message: e instanceof Error ? e.message : String(e) },
        );
      } finally {
        versionMismatchRecomputeInFlight.delete(profileUserId);
      }
    });
  } catch (e) {
    // after() 불가(요청 컨텍스트 밖 등) → 백그라운드 생략. in-flight 정리하고 구값 유지.
    versionMismatchRecomputeInFlight.delete(profileUserId);
    console.warn("[weekly-cards] after() unavailable → version-mismatch bg skip", {
      profileUserId,
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

// 카드 로딩 단일 진입점(demo/session/internal 공용). snapshot-only 로더(loadWeeklyCardsRaw)의
// 결과에 라인 강화 상태 수동 override 를 read-time overlay 로 덧씌운 뒤 반환한다.
//   - override 는 조회 시점에만 적용(snapshot 무접촉·계산 무수정).
//   - override 행이 없거나 매칭 라인이 없으면 raw 결과를 그대로 반환 → 기존 응답과 100% 동일.
//   - demo(mode=test/demoUserId) 와 session 경로가 모두 이 함수를 통과하므로 동일 DTO·동일 overlay
//     를 탄다(override 키 = user_id, mode 무관).
export async function loadWeeklyCards(
  profileUserId: string,
  preload: SubjectPreload,
): Promise<LoadResult> {
  const result = await traceSpan("loadWeeklyCardsRaw", () =>
    loadWeeklyCardsRaw(profileUserId),
  );
  try {
    // ① 강화 상태 overlay → ② 2차 기입 편집권 overlay. 둘 다 read-time(굽지 않음), 키=user_id(mode 무관).
    //   각 overlay 는 매칭 없음 시 동일 배열 참조 반환 → 참조 비교로 no-op 판정.
    //   조회는 preload 로 이미 시작돼 있고(같은 user_id·같은 쿼리), 적용 순서는 기존과 동일하다.
    const afterEnh = await traceSpan("applyEnhancementOverridesToCards", () =>
      applyEnhancementOverridesToCards(
        profileUserId,
        result.cards,
        preload.enhancementRows,
      ),
    );
    const cards = await traceSpan("applySecondEntryOverridesToCards", () =>
      applySecondEntryOverridesToCards(
        profileUserId,
        afterEnh,
        preload.secondEntryRows,
      ),
    );
    return cards === result.cards ? result : { ...result, cards };
  } catch (e) {
    // overlay 실패는 격리한다 — override 때문에 조회가 깨지면 안 되므로 raw 결과로 폴백.
    console.warn("[weekly-cards] override overlay failed → raw fallback", {
      profileUserId,
      message: e instanceof Error ? e.message : String(e),
    });
    return result;
  }
}

// snapshot-only 로더 (계산 없이 저장본 조회 — override overlay 이전의 raw 결과).
//   - hit + 신선(computed_at ≥ 현재 주차 시작) → 저장 카드 그대로 (쿼리 1, 계산 0). 대다수 요청.
//   - hit + boundary-stale(주차 경계 통과)     → 단건 재계산·저장 → 최신 반환. 실패 시 구 카드 폴백.
//   - stale(is_stale=true)                    → 단건 재계산·저장 → 최신 반환. 실패 시 구 카드 폴백.
//   - stale(version_mismatch)                 → 구 카드 즉시 노출(블로킹 0) + after() 백그라운드로
//                                                그 1명만 재계산 → 다음 조회부터 신버전 수렴. 실패 시 구값 보존.
//   - miss(행 없음, 신규 유저)                 → 단건 재계산·저장 → 최신 반환. 실패 시 빈 배열.
//   - error(조회 실패)                         → 빈 배열. 일시 오류에 계산 폭증 방지 — 절대 계산 안 함.
async function loadWeeklyCardsRaw(profileUserId: string): Promise<LoadResult> {
  const snap = await traceSpan("readWeeklyCardsSnapshot", () =>
    readWeeklyCardsSnapshot(profileUserId),
  );

  // 현재 주차 경계 시각(월요일 00:01 KST) — computed_at 이 이보다 과거면 주차 경계를 지난
  // snapshot(boundary-stale). 현재 주차 선택은 00:01 KST 에 넘어가는 활동 날짜로 하고,
  // 추상 주차 시작(월요일 00:00 UTC)을 실제 경계 시각으로 변환해 비교한다(00:01~09:00 KST
  // 구간 herd 방지 — 그 시각에 재계산된 snapshot 은 경계 이후라 신선 판정).
  // 추가 쿼리 0 (순수 달력 연산). 달력 갭(시즌 판별 불가)이면 경계 판정 생략(신선 취급).
  const weekStartMs = getCurrentWeekStartMs(getCurrentActivityDateIso());
  const boundaryMs = weekStartMs == null ? null : weekStartToBoundaryMs(weekStartMs);

  // 단건 lazy 재계산 — 실패해도 throw 하지 않고 null 반환(호출부가 구 값으로 폴백).
  const lazyRecompute = async (): Promise<Cluster4WeeklyCardDto[] | null> => {
    try {
      return await traceSpan("lazyRecompute(recomputeAndStoreWeeklyCardsSnapshot)", () =>
        recomputeAndStoreWeeklyCardsSnapshot(profileUserId),
      );
    } catch (e) {
      console.warn("[weekly-cards] lazy recompute failed → 기존 저장본 폴백", {
        profileUserId,
        message: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  };

  if (snap.status === "hit") {
    const boundaryStale =
      boundaryMs != null && Date.parse(snap.computedAt) < boundaryMs;
    if (!boundaryStale) {
      return { cards: snap.cards, outcome: "hit", detail: "", lazyRan: false };
    }
    const cards = await lazyRecompute();
    return cards
      ? { cards, outcome: "stale", detail: "boundary+lazy", lazyRan: true }
      : { cards: snap.cards, outcome: "stale", detail: "boundary+lazy-failed", lazyRan: false };
  }

  if (snap.status === "stale") {
    if (snap.reason === "version_mismatch") {
      // 구 카드를 즉시 노출(블로킹 0)하되, 응답 후 백그라운드로 이 사용자 1명만 재계산해
      // 다음 조회부터 신버전으로 수렴시킨다. 블로킹 lazy 가 아니므로 deploy 직후 전원 mismatch
      // 여도 조회 경로 504 위험이 없다(과거 가드의 의도 보존). 실패 시 기존 snapshot 폴백.
      scheduleVersionMismatchRecompute(profileUserId);
      return { cards: snap.cards, outcome: "stale", detail: "version_mismatch+bg", lazyRan: false };
    }
    const cards = await lazyRecompute();
    return cards
      ? { cards, outcome: "stale", detail: `${snap.reason}+lazy`, lazyRan: true }
      : { cards: snap.cards, outcome: "stale", detail: `${snap.reason}+lazy-failed`, lazyRan: false };
  }

  if (snap.status === "miss") {
    const cards = await lazyRecompute();
    return cards
      ? { cards, outcome: "miss", detail: "lazy", lazyRan: true }
      : { cards: [], outcome: "miss", detail: "lazy-failed", lazyRan: false };
  }

  // error: 조회 실패. 무거운 계산으로 빠지지 않는다 — 일시 오류에 계산 폭증 방지.
  return { cards: [], outcome: "error", detail: snap.message, lazyRan: false };
}

// ── 최종(finalized) 카드 단건 로더 — GET 라우트의 finalizeOk / error 경로와 동일한 "data" 배열 생성.
//   GET 라우트가 data 로 내보내는 배열과 byte-identical 한 결과를 반환한다:
//     · ok/hit/stale/miss 경로 → 성장중단 truncation 적용본(finalizeOk 와 동일)
//     · error 경로            → result.cards 그대로(비-truncate) + growthInfo=null (GET error 분기와 동일)
//   슬림 projection 배치는 이 함수를 유저별로 호출한 뒤 랭킹 필드만 뽑는다(계산 재실행 없음).
export type FinalizedWeeklyCards = {
  outcome: LoadOutcome;
  detail: string;
  lazyRan: boolean;
  // GET data 배열과 동일(ok=truncated / error=raw).
  cards: Cluster4WeeklyCardDto[];
  // 성장 배지 정보(GET envelope 용). error 경로는 null(GET 과 동일).
  growthInfo: GrowthStopInfo | null;
};

export async function loadFinalizedWeeklyCards(
  profileUserId: string,
): Promise<FinalizedWeeklyCards> {
  const preload = startSubjectPreload(profileUserId);
  const result = await loadWeeklyCards(profileUserId, preload);
  if (result.outcome === "error") {
    // GET error 분기(route): data=result.cards(비-truncate), growthInfo=null.
    return {
      outcome: result.outcome,
      detail: result.detail,
      lazyRan: result.lazyRan,
      cards: result.cards,
      growthInfo: null,
    };
  }
  // GET finalizeOk 와 동일: growthStop preload await → 중단 시 running/tallying truncation.
  const growthInfo = await preload.growthStop;
  const cards = truncateCardsForGrowthStop(result.cards, growthInfo.isStopped);
  return {
    outcome: result.outcome,
    detail: result.detail,
    lazyRan: result.lazyRan,
    cards,
    growthInfo,
  };
}
