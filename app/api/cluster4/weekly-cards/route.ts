import type { NextRequest } from "next/server";
import { after } from "next/server";
import {
  ADMIN_READ_ROLES,
  AdminAuthError,
  requireAdmin,
} from "@/lib/adminAuth";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveProfileUserId } from "@/lib/resolveProfileUserId";
import { Cluster4WeeklyCardsError } from "@/lib/cluster4WeeklyCardsData";
import { getWeeklyGrowth } from "@/lib/cluster4WeeklyGrowthData";
import {
  readWeeklyCardsSnapshot,
  recomputeAndStoreWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";
import { getCurrentWeekStartMs } from "@/lib/cluster4WeekPolicy";
import {
  loadGrowthStopInfo,
  truncateCardsForGrowthStop,
  type GrowthStopInfo,
} from "@/lib/cluster4GrowthStopPolicy";
import { DemoModeError } from "@/lib/demoMode";
import { resolveRequestScope } from "@/lib/requestScope";
import {
  currentQueryCount,
  runWithQueryMeter,
} from "@/lib/supabaseQueryMeter";
import type {
  Cluster4AreaSixCirclesDto,
  Cluster4SeasonAreaProgressDto,
  Cluster4WeeklyCardDto,
} from "@/shared/cluster4.contracts";
import {
  computeAreaSixCircles,
  computeSeasonAreaProgress,
} from "@/lib/cluster4SeasonCircles";
import { getSeasonForDate, seasonDbKey } from "@/lib/seasonCalendar";

// 무거운 list API — Vercel function 최대 실행시간 상한을 명시(안전망).
// dynamic: 인증/유저별 데이터이므로 캐시 금지(항상 동적 실행).
export const maxDuration = 60;
export const dynamic = "force-dynamic";

// 디버그 비교 로그(getWeeklyGrowth 2차 호출)는 비용이 크므로 기본 OFF.
// 필요 시 Vercel 환경변수 CLUSTER4_WEEKLY_CARDS_DEBUG=1 로만 켠다.
const DEBUG_COMPARE = process.env.CLUSTER4_WEEKLY_CARDS_DEBUG === "1";

// ⚠ 504 방지 핵심(2026-06-04 lazy 전환 후에도 유지): 조회의 SoT 는 snapshot 저장본이며,
// "전원 일괄" 재계산은 조회 경로에서 절대 일어나지 않는다. 단건(사용자 1명) 재계산만 허용:
//   - boundary-stale (computed_at < 현재 주차 시작 — 주차 경계 통과)  → 블로킹 lazy
//   - is_stale=true  (관리자 훅 무효화 표시)                          → 블로킹 lazy
//   - miss           (snapshot 행 없음 — 신규 유저)                   → 블로킹 lazy
//   → 그 자리에서 해당 1명만 재계산·저장 후 최신 저장본을 반환 (~1.5–3s, 실측 2026-06-04).
// version_mismatch(DTO 버전 bump)는 위 3건과 달리 deploy 직후 전원(=100%)이 동시에 해당되므로,
//   블로킹 lazy 로 처리하면 과거 504(전원 동시 재계산)의 herd 가 재현될 수 있다. 그래서:
//   ① 구 카드를 즉시 graceful 노출(블로킹 0 — 이번 응답은 절대 무거운 계산을 기다리지 않음).
//   ② 응답 후 after() 백그라운드로 "그 사용자 1명만" 재계산·저장(scheduleVersionMismatchRecompute).
//   → 다음 조회부터 신버전으로 수렴한다(사용자 단위 자동 수렴). 실패 시 기존 snapshot 보존(폴백).
//   수동 ops(GET /api/admin/cluster4/recompute-snapshots, x-internal-api-key)는 즉시 전원 수렴이
//   필요할 때 보조로 유지(백그라운드 미도달 인스턴스 보정). Vercel cron 의존성은 여전히 제거됨.

// 응답 형식 고정:
//   성공: { success: true,  data: [...], areaSixCircles: {...}, seasonAreaProgress: [...], error: null }
//   실패: { success: false, data: [],     areaSixCircles: {...}, seasonAreaProgress: [...], error: {…} }
// data 는 어떤 경우에도 배열이며 undefined 가 되지 않는다(프론트 .length/.map 방어).
// areaSixCircles 는 현재 시즌 단위 집계(주차 활용도/일정 신뢰도/시즌 성장률) — snapshot cards
//   파생값(append-only). 실패/빈 카드면 0 세트.
// seasonAreaProgress 는 area-7-progress 용 실무 4허브(정보/경험/역량/경력) 시즌 누적 강화율 —
//   동일 snapshot cards 파생값(append-only). 항상 4개 항목, 실패/빈 카드면 0 세트.
// area-6-circles / area-7-progress 를 카드에 등장하는 모든 시즌 키별로 미리 계산한 맵.
//   snapshot cards 가 이미 전 시즌을 포함하므로(재계산 불필요) computeAreaSixCircles/
//   computeSeasonAreaProgress(순수 함수)를 시즌 키마다 1회 호출한다. 프론트는 화면에서
//   선택된 시즌 key 로 이 맵을 조회해 렌더링한다(현재 시즌 고정값 재사용 금지).
//   현재 시즌 단건(areaSixCircles/seasonAreaProgress)은 하위호환을 위해 그대로 유지한다.
function seasonCircleMaps(cards: Cluster4WeeklyCardDto[]): {
  areaSixCirclesBySeason: Record<string, Cluster4AreaSixCirclesDto>;
  seasonAreaProgressBySeason: Record<string, Cluster4SeasonAreaProgressDto>;
} {
  const seasonKeys = Array.from(
    new Set(cards.map((c) => c.seasonKey).filter((k): k is string => !!k)),
  );
  const areaSixCirclesBySeason: Record<string, Cluster4AreaSixCirclesDto> = {};
  const seasonAreaProgressBySeason: Record<string, Cluster4SeasonAreaProgressDto> = {};
  for (const sk of seasonKeys) {
    areaSixCirclesBySeason[sk] = computeAreaSixCircles(cards, sk);
    seasonAreaProgressBySeason[sk] = computeSeasonAreaProgress(cards, sk);
  }
  return { areaSixCirclesBySeason, seasonAreaProgressBySeason };
}

// growthInfo: 성장 배지(성장 중단/완료/휴식/진행) 단일 출처 — 데모·일반 동일 응답 필드.
//   프론트는 이 값으로 허브/이력서 배지를 렌더(/api/profile 의존·재계산 제거). 실패/빈 응답 시 null.
function ok(
  data: Cluster4WeeklyCardDto[],
  areaSixCircles: Cluster4AreaSixCirclesDto,
  seasonAreaProgress: Cluster4SeasonAreaProgressDto,
  growthInfo: GrowthStopInfo | null = null,
) {
  const { areaSixCirclesBySeason, seasonAreaProgressBySeason } = seasonCircleMaps(data);
  return Response.json({
    success: true,
    data,
    areaSixCircles,
    seasonAreaProgress,
    areaSixCirclesBySeason,
    seasonAreaProgressBySeason,
    growthInfo,
    error: null,
  });
}
function fail(status: number, message: string, code: string) {
  return Response.json(
    {
      success: false,
      data: [] as Cluster4WeeklyCardDto[],
      areaSixCircles: emptyAreaSixCircles(),
      seasonAreaProgress: computeSeasonAreaProgress([], currentSeasonKey()),
      areaSixCirclesBySeason: {} as Record<string, Cluster4AreaSixCirclesDto>,
      seasonAreaProgressBySeason: {} as Record<string, Cluster4SeasonAreaProgressDto>,
      growthInfo: null as GrowthStopInfo | null,
      error: { message, code },
    },
    { status },
  );
}

// 성공 응답 단일 진입점: 성장 중단 정책(배지 + 미확정 카드 truncation)을 모든 경로에 일관 적용.
//   ① 사용자 성장 배지/중단 신호를 1 SELECT 로 읽고(snapshot 무접촉),
//   ② 중단 사용자면 running/tallying(미확정) 카드를 제거한 뒤,
//   ③ truncate 된 카드로 area-6/area-7 을 다시 집계해 envelope 와 정합을 맞춘다.
//   중단이 아니면 입력 카드를 그대로 사용(기존 동작 불변).
type DoneFn = (
  res: Response,
  label: string,
  meta?: { userId: string } & LoadResult,
) => Response;

async function finalizeOk(
  done: DoneFn,
  userId: string,
  rawCards: Cluster4WeeklyCardDto[],
  label: string,
  meta: ({ userId: string } & LoadResult) | null,
): Promise<Response> {
  const growthInfo = await loadGrowthStopInfo(userId);
  const cards = truncateCardsForGrowthStop(rawCards, growthInfo.isStopped);
  const seasonKey = currentSeasonKey();
  const circles = computeAreaSixCircles(cards, seasonKey);
  const areaProgress = computeSeasonAreaProgress(cards, seasonKey);
  return done(
    ok(cards, circles, areaProgress, growthInfo),
    label,
    meta ? { ...meta, cards } : undefined,
  );
}

// 오늘 날짜 기준 현재 시즌 key (area-6-circles 집계 대상 시즌). 달력 갭이면 null.
//   area-1/area-4(seasonSummary)와 동일한 seasonCalendar 현재 시즌 기준으로 통일.
function currentSeasonKey(): string | null {
  const season = getSeasonForDate(new Date().toISOString().slice(0, 10));
  return season ? seasonDbKey(season) : null;
}

function emptyAreaSixCircles(): Cluster4AreaSixCirclesDto {
  return computeAreaSixCircles([], currentSeasonKey());
}

type LoadOutcome = "hit" | "stale" | "miss" | "error";
type LoadResult = {
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

// 카드 로딩의 단일 진입점 (demo/일반/internal 모든 경로 공용 — DTO·로직 단일).
//   - hit + 신선(computed_at ≥ 현재 주차 시작) → 저장 카드 그대로 (쿼리 1, 계산 0). 대다수 요청.
//   - hit + boundary-stale(주차 경계 통과)     → 단건 재계산·저장 → 최신 반환. 실패 시 구 카드 폴백.
//   - stale(is_stale=true)                    → 단건 재계산·저장 → 최신 반환. 실패 시 구 카드 폴백.
//   - stale(version_mismatch)                 → 구 카드 즉시 노출(블로킹 0) + after() 백그라운드로
//                                                그 1명만 재계산 → 다음 조회부터 신버전 수렴. 실패 시 구값 보존.
//   - miss(행 없음, 신규 유저)                 → 단건 재계산·저장 → 최신 반환. 실패 시 빈 배열.
//   - error(조회 실패)                         → 빈 배열. 일시 오류에 계산 폭증 방지 — 절대 계산 안 함.
async function loadWeeklyCards(profileUserId: string): Promise<LoadResult> {
  const snap = await readWeeklyCardsSnapshot(profileUserId);

  // 현재 주차 시작(월요일 00:00 UTC) — computed_at 이 이보다 과거면 주차 경계를 지난 snapshot.
  // 추가 쿼리 0 (순수 달력 연산). 달력 갭(시즌 판별 불가)이면 경계 판정 생략(신선 취급).
  const weekStartMs = getCurrentWeekStartMs(
    new Date().toISOString().slice(0, 10),
  );

  // 단건 lazy 재계산 — 실패해도 throw 하지 않고 null 반환(호출부가 구 값으로 폴백).
  const lazyRecompute = async (): Promise<Cluster4WeeklyCardDto[] | null> => {
    try {
      return await recomputeAndStoreWeeklyCardsSnapshot(profileUserId);
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
      weekStartMs != null && Date.parse(snap.computedAt) < weekStartMs;
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

// 디버깅: W12/W11 에 대해 백엔드(getWeeklyGrowth) ↔ DTO 응답값 매핑을 콘솔에 비교 출력.
// 프론트 검증용 ad-hoc 로그 — 운영에서도 비용 무시 가능 (2개 row 만).
async function logWeekComparison(
  profileUserId: string,
  cards: Cluster4WeeklyCardDto[],
): Promise<void> {
  try {
    const growth = await getWeeklyGrowth(profileUserId);
    if (!growth) return;

    for (const weekNum of [12, 11]) {
      const backend = growth.weeklyCards.find((c) => c.weekNumber === weekNum);
      const dto = cards.find((c) => c.weekNumber === weekNum);
      if (!backend || !dto) continue;
      console.log(
        `[cluster4/weekly-cards W${weekNum} compare]`,
        JSON.stringify(
          {
            backend: {
              teamLabel: backend.teamLabel,
              partLabel: backend.partLabel,
              activityStatus: backend.activityStatus,
              points: backend.pointsRaw,
              advantages: backend.advantagesRaw,
              penalty: backend.penaltyRaw,
              cumulativeAdvantages: backend.cumulativeAdvantages,
              totalFmScore: backend.totalFmScoreRaw,
              weeklyReputationCount: backend.weeklyReputationCountRaw,
              linkedCrewCount: backend.linkedCrewCountRaw,
              weeklyGrowthRate: backend.weeklyGrowth.rate,
              growth: `${backend.weeklyGrowth.completedLines}/${backend.weeklyGrowth.availableLines}`,
              lineBreakdown: backend.lineBreakdown,
            },
            dto: {
              teamName: dto.teamName,
              partName: dto.partName,
              roleLabel: dto.roleLabel,
              membershipStatusLabel: dto.membershipStatusLabel,
              points: dto.points,
              cumulativeInjeolmi: dto.cumulativeInjeolmi,
              fameScore: dto.fameScore,
              reputationCount: dto.reputationCount,
              reputationTotal: dto.reputationTotal,
              colleagueCount: dto.colleagueCount,
              colleagueTotal: dto.colleagueTotal,
              weeklyGrowthRate: dto.weeklyGrowthRate,
              growth: `${dto.growthNumerator}/${dto.growthDenominator}`,
              lines: dto.lines.map((l) => ({
                partType: l.partType,
                numerator: l.numerator,
                denominator: l.denominator,
                rate: l.rate,
              })),
            },
          },
          null,
          2,
        ),
      );
    }
  } catch (error) {
    console.warn("[cluster4/weekly-cards W12/W11 compare] failed", error);
  }
}

export async function GET(request: NextRequest) {
  return runWithQueryMeter("[weekly-cards]", () => handleGet(request));
}

async function handleGet(request: NextRequest): Promise<Response> {
  const tStart = Date.now();
  const done = (
    res: Response,
    label: string,
    meta?: { userId: string } & LoadResult,
  ) => {
    // 요청 단위 구조화 로그(요구사항): userId / HIT·MISS·STALE / lazy 실행 / 쿼리수 / 총 ms.
    const metaStr = meta
      ? ` | user=${meta.userId} | outcome=${meta.outcome.toUpperCase()}` +
        `${meta.detail ? `(${meta.detail})` : ""} | lazyRan=${meta.lazyRan} | cards=${meta.cards.length}`
      : "";
    console.log(
      "[weekly-cards] done",
      label,
      `| ${Date.now() - tStart}ms`,
      `| supabaseQueries=${currentQueryCount()}` + metaStr,
    );
    return res;
  };

  // 데모 모드: demoUserId 가 유효한 테스트 유저면 세션 인증 대신 그 유저 데이터를 반환.
  // (DTO shape 은 일반 경로와 동일 — 프론트 컴포넌트 재사용 가능)
  try {
    const requestScope = await resolveRequestScope(request);
    if (requestScope.demoUserId) {
      // 데모(테스트유저) 인증은 demoUserId 로 통과하되, 카드 조회 대상은 userId(페이지 주인)가
      // 있으면 그것을 우선한다. foreign viewer(테스트유저 demoUserId 가 다른 유저 userId 페이지를
      // 조회) 시 4허브 카드는 반드시 페이지 주인(userId) 기준이어야 하며 viewer(demoUserId)
      // 데이터가 섞이면 안 된다. userId 가 없으면(본인 페이지) 기존대로 demoUserId 기준.
      const cardTargetUserId = requestScope.targetUserId || requestScope.demoUserId;

      // 진입경로 일관성(2026-06-16): demoUserId(테스트 유저) 경로도 일반 로그인 경로와 100% 동일하게
      //   snapshot-only 로더(loadWeeklyCards)만 사용한다. demoUserId 는 "조회 대상 userId"만 바꾸며
      //   DTO 생성/계산 로직은 분기하지 않는다. mode 파라미터는 weekly-cards DTO 에 영향을 주지 않는다
      //   (테스트 유저 선택/스코프 용도일 뿐 — snapshot key/season/week/org/userId 선택 불변).
      //   → /admin/test-users(데모, mode=test) 경유와 실제 직접 로그인(세션, mode 없음) 경로가
      //     동일 snapshot row 를 읽어 같은 카드 값을 반환한다. ENABLE_DEMO_MODE 게이트는 데모 경로의
      //     "진입 가능 여부"만 가르며, 진입한 뒤 반환하는 DTO 는 일반 경로와 동일하다.
      const result = await loadWeeklyCards(cardTargetUserId);
      if (DEBUG_COMPARE) await logWeekComparison(cardTargetUserId, result.cards);
      // area-6/area-7 + 성장 중단 정책(배지·미확정 카드 truncation)을 finalizeOk 에서 일관 적용.
      return finalizeOk(done, cardTargetUserId, result.cards, "demo", {
        userId: cardTargetUserId,
        ...result,
      });
    }
  } catch (error) {
    if (error instanceof DemoModeError) {
      return done(fail(error.status, error.message, "demo_mode"), "demo-error");
    }
    if (error instanceof Cluster4WeeklyCardsError) {
      return done(
        fail(error.status, error.message, "weekly_cards_error"),
        "demo-cards-error",
      );
    }
    console.error("[weekly-cards] demo path unexpected", error);
    return done(
      fail(500, error instanceof Error ? error.message : "Unexpected error.", "internal"),
      "demo-unexpected",
    );
  }

  const internalKey = request.headers.get("x-internal-api-key");
  const expectedInternalKey = process.env.INTERNAL_API_KEY;
  const internalAuthAccepted =
    !!internalKey &&
    !!expectedInternalKey &&
    internalKey === expectedInternalKey;

  if (internalKey) {
    console.log(
      internalAuthAccepted
        ? "[weekly-cards] internal auth accepted"
        : "[weekly-cards] internal auth rejected",
    );
  }

  let sessionUser: { id: string; email: string | null | undefined } | null =
    null;

  if (!internalAuthAccepted) {
    const supabase = await getSupabaseServerClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return done(fail(401, "Authentication required.", "unauthenticated"), "auth");
    }
    sessionUser = { id: user.id, email: user.email };
  }

  try {
    const requestedUserId =
      request.nextUrl.searchParams.get("userId")?.trim() || null;

    // 모든 분기에서 먼저 profileUserId 를 확정한 뒤, snapshot 우선 로더로 카드를 가져온다.
    let profileUserId: string;
    if (internalAuthAccepted) {
      if (!requestedUserId) {
        return done(
          fail(400, "userId is required for internal calls.", "missing_user_id"),
          "internal-missing-user",
        );
      }
      profileUserId = requestedUserId;
    } else if (requestedUserId) {
      const ownProfileUserId = await resolveProfileUserId(
        sessionUser!.id,
        sessionUser!.email,
      );
      if (requestedUserId !== ownProfileUserId) {
        await requireAdmin(ADMIN_READ_ROLES);
      }
      profileUserId = requestedUserId;
    } else {
      const ownProfileUserId = await resolveProfileUserId(
        sessionUser!.id,
        sessionUser!.email,
      );
      if (!ownProfileUserId) {
        return done(fail(404, "User profile not found.", "profile_not_found"), "no-profile");
      }
      profileUserId = ownProfileUserId;
    }

    // 진입경로 일관성(2026-06-16): mode 파라미터는 weekly-cards DTO 계산에 영향을 주지 않는다.
    //   세션/internal 경로도 snapshot-only 로더만 사용 — 테스트 유저든 실유저든 동일 userId 면
    //   동일 snapshot row 를 반환한다(데모 경로와 정합).
    const result = await loadWeeklyCards(profileUserId);

    // 디버그 비교 로그는 getWeeklyGrowth 를 2차로 다시 호출(요청 비용 약 2배) → 기본 OFF.
    if (DEBUG_COMPARE) {
      await logWeekComparison(profileUserId, result.cards);
    }

    // error outcome 은 200(빈 카드)으로 내리되 error 필드를 채워 프론트가 덮어쓰지 않게 한다.
    //   (조회 실패 경로 — 성장 중단 정책 미적용, growthInfo=null. 빈/구 카드 그대로 노출.)
    if (result.outcome === "error") {
      const seasonKey = currentSeasonKey();
      const circles = computeAreaSixCircles(result.cards, seasonKey);
      const areaProgress = computeSeasonAreaProgress(result.cards, seasonKey);
      const errMaps = seasonCircleMaps(result.cards);
      return done(
        Response.json({
          success: false,
          data: result.cards,
          areaSixCircles: circles,
          seasonAreaProgress: areaProgress,
          areaSixCirclesBySeason: errMaps.areaSixCirclesBySeason,
          seasonAreaProgressBySeason: errMaps.seasonAreaProgressBySeason,
          growthInfo: null,
          error: { message: result.detail || "snapshot read failed", code: "snapshot_read_error" },
        }),
        "ok",
        { userId: profileUserId, ...result },
      );
    }

    // area-6/area-7 + 성장 중단 정책(배지·미확정 카드 truncation)을 finalizeOk 에서 일관 적용.
    return finalizeOk(done, profileUserId, result.cards, "ok", {
      userId: profileUserId,
      ...result,
    });
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return done(fail(error.status, error.message, "forbidden"), "admin-error");
    }

    if (error instanceof Cluster4WeeklyCardsError) {
      return done(
        fail(error.status, error.message, "weekly_cards_error"),
        "cards-error",
      );
    }

    console.error("[cluster4/weekly-cards GET]", error);
    return done(
      fail(
        500,
        error instanceof Error ? error.message : "Failed to load cluster4 weekly cards.",
        "internal",
      ),
      "unexpected",
    );
  }
}
