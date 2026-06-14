import type { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  AdminAuthError,
  requireAdmin,
} from "@/lib/adminAuth";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveProfileUserId } from "@/lib/resolveProfileUserId";
import {
  Cluster4WeeklyCardsError,
  getCluster4WeeklyCardsForProfileUser,
} from "@/lib/cluster4WeeklyCardsData";
import { isTestUser } from "@/lib/testUsers";
import { TEST_SUMMER_SIM_EFFECTIVE_FROM } from "@/lib/lineAvailability";
import { getWeeklyGrowth } from "@/lib/cluster4WeeklyGrowthData";
import {
  readWeeklyCardsSnapshot,
  recomputeAndStoreWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";
import { getCurrentWeekStartMs } from "@/lib/cluster4WeekPolicy";
import { DemoModeError, resolveDemoProfileUserId } from "@/lib/demoMode";
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
// "전원 일괄" 재계산은 조회 경로에서 절대 일어나지 않는다. 단건 lazy 재계산만 허용:
//   - boundary-stale (computed_at < 현재 주차 시작 — 주차 경계 통과)
//   - is_stale=true  (관리자 훅 무효화 표시)
//   - miss           (snapshot 행 없음 — 신규 유저)
//   → 그 자리에서 해당 1명만 재계산·저장 후 최신 저장본을 반환 (~1.5–3s, 실측 2026-06-04).
// version_mismatch(DTO 버전 bump)는 재계산하지 않는다 — 과거 504 의 원인이던 전원 동시
// 재계산 시나리오이므로, 구 카드 graceful 노출 + 수동 ops(GET /api/admin/cluster4/
// recompute-snapshots, x-internal-api-key)로만 일괄 수렴한다. Vercel cron 의존성 제거됨.

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

function ok(
  data: Cluster4WeeklyCardDto[],
  areaSixCircles: Cluster4AreaSixCirclesDto,
  seasonAreaProgress: Cluster4SeasonAreaProgressDto,
) {
  const { areaSixCirclesBySeason, seasonAreaProgressBySeason } = seasonCircleMaps(data);
  return Response.json({
    success: true,
    data,
    areaSixCircles,
    seasonAreaProgress,
    areaSixCirclesBySeason,
    seasonAreaProgressBySeason,
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
      error: { message, code },
    },
    { status },
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

// 카드 로딩의 단일 진입점 (demo/일반/internal 모든 경로 공용 — DTO·로직 단일).
//   - hit + 신선(computed_at ≥ 현재 주차 시작) → 저장 카드 그대로 (쿼리 1, 계산 0). 대다수 요청.
//   - hit + boundary-stale(주차 경계 통과)     → 단건 재계산·저장 → 최신 반환. 실패 시 구 카드 폴백.
//   - stale(is_stale=true)                    → 단건 재계산·저장 → 최신 반환. 실패 시 구 카드 폴백.
//   - stale(version_mismatch)                 → 구 카드 graceful 노출 (재계산 금지 — 수동 ops 전용).
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
      // DTO 버전 bump 일괄 수렴은 수동 ops 전용(전원 동시 lazy = 과거 504 시나리오 금지).
      return { cards: snap.cards, outcome: "stale", detail: snap.reason, lazyRan: false };
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
    const demoProfileUserId = await resolveDemoProfileUserId(request);
    if (demoProfileUserId) {
      // 데모(테스트유저) 인증은 demoUserId 로 통과하되, 카드 조회 대상은 userId(페이지 주인)가
      // 있으면 그것을 우선한다. foreign viewer(테스트유저 demoUserId 가 다른 유저 userId 페이지를
      // 조회) 시 4허브 카드는 반드시 페이지 주인(userId) 기준이어야 하며 viewer(demoUserId)
      // 데이터가 섞이면 안 된다. userId 가 없으면(본인 페이지) 기존대로 demoUserId 기준.
      const requestedUserId =
        request.nextUrl.searchParams.get("userId")?.trim() || null;
      const cardTargetUserId = requestedUserId || demoProfileUserId;

      // ── 테스트 시즌 시뮬레이션(mode=test) ──
      //   레거시 주차(W13 등)를 여름 정책으로 시뮬레이션해 신규 라인/강화율/verdict 를 개별 표시.
      //   조건(엄격): 데모 모드 + demoUserId 가 검증된 test_user_markers 유저(resolveDemoProfileUserId 통과)
      //               + 조회 대상(cardTargetUserId)도 테스트 유저 + mode=test.
      //   ⚠ snapshot read/write 없이 live compute 만 반환 → 운영 snapshot 무접촉(절대 미저장).
      //   실유저/운영 모드는 이 분기에 진입 불가(demoUserId 없음 → 위 데모 게이트 자체 미통과).
      const mode = request.nextUrl.searchParams.get("mode")?.trim();
      if (mode === "test") {
        const targetIsTest =
          cardTargetUserId === demoProfileUserId
            ? true
            : await isTestUser(cardTargetUserId);
        if (targetIsTest) {
          const cards = await getCluster4WeeklyCardsForProfileUser(
            cardTargetUserId,
            { effectiveFromOverride: TEST_SUMMER_SIM_EFFECTIVE_FROM },
          );
          const seasonKeyT = currentSeasonKey();
          const circlesT = computeAreaSixCircles(cards, seasonKeyT);
          const areaProgressT = computeSeasonAreaProgress(cards, seasonKeyT);
          return done(ok(cards, circlesT, areaProgressT), "demo-test-sim", {
            userId: cardTargetUserId,
            cards,
            outcome: "stale",
            detail: "test-summer-sim(live, no-snapshot)",
            lazyRan: true,
          });
        }
      }

      const result = await loadWeeklyCards(cardTargetUserId);
      if (DEBUG_COMPARE) await logWeekComparison(cardTargetUserId, result.cards);
      // area-6-circles / area-7-progress: 로드된 스냅샷 cards 에서 현재 시즌 집계(snapshot-only 파생).
      const seasonKey = currentSeasonKey();
      const circles = computeAreaSixCircles(result.cards, seasonKey);
      const areaProgress = computeSeasonAreaProgress(result.cards, seasonKey);
      return done(ok(result.cards, circles, areaProgress), "demo", { userId: cardTargetUserId, ...result });
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

    // ── 테스트 시즌 시뮬레이션(mode=test) — internal/세션 경로 ──
    //   고객 앱은 weekly-cards?userId=<testUser>&mode=test 를 x-internal-api-key 로 보내므로
    //   위 demoUserId(데모) 분기에 진입하지 못한다. 동일 시뮬레이션을 여기서도 제공하되,
    //   조건(엄격): mode=test + profileUserId 가 검증된 test_user_markers 유저인 경우에만.
    //   ⚠ snapshot read/write 없이 live compute 만 반환 → 운영 snapshot 무접촉(절대 미저장).
    //   실유저/운영 모드/mode 없음은 이 분기에 진입 불가(isTestUser=false 또는 mode!=test)
    //   → 아래 loadWeeklyCards(snapshot) 경로 그대로(회귀 없음).
    const mode = request.nextUrl.searchParams.get("mode")?.trim();
    if (mode === "test" && (await isTestUser(profileUserId))) {
      const cards = await getCluster4WeeklyCardsForProfileUser(profileUserId, {
        effectiveFromOverride: TEST_SUMMER_SIM_EFFECTIVE_FROM,
      });
      const seasonKeyT = currentSeasonKey();
      const circlesT = computeAreaSixCircles(cards, seasonKeyT);
      const areaProgressT = computeSeasonAreaProgress(cards, seasonKeyT);
      return done(ok(cards, circlesT, areaProgressT), "internal-test-sim", {
        userId: profileUserId,
        cards,
        outcome: "stale",
        detail: "test-summer-sim(live, no-snapshot)",
        lazyRan: true,
      });
    }

    const result = await loadWeeklyCards(profileUserId);

    // 디버그 비교 로그는 getWeeklyGrowth 를 2차로 다시 호출(요청 비용 약 2배) → 기본 OFF.
    if (DEBUG_COMPARE) {
      await logWeekComparison(profileUserId, result.cards);
    }

    // area-6-circles / area-7-progress: 로드된 스냅샷 cards 에서 현재 시즌 집계(snapshot-only 파생).
    const seasonKey = currentSeasonKey();
    const circles = computeAreaSixCircles(result.cards, seasonKey);
    const areaProgress = computeSeasonAreaProgress(result.cards, seasonKey);

    // error outcome 은 200(빈 카드)으로 내리되 error 필드를 채워 프론트가 덮어쓰지 않게 한다.
    if (result.outcome === "error") {
      const errMaps = seasonCircleMaps(result.cards);
      return done(
        Response.json({
          success: false,
          data: result.cards,
          areaSixCircles: circles,
          seasonAreaProgress: areaProgress,
          areaSixCirclesBySeason: errMaps.areaSixCirclesBySeason,
          seasonAreaProgressBySeason: errMaps.seasonAreaProgressBySeason,
          error: { message: result.detail || "snapshot read failed", code: "snapshot_read_error" },
        }),
        "ok",
        { userId: profileUserId, ...result },
      );
    }

    return done(ok(result.cards, circles, areaProgress), "ok", { userId: profileUserId, ...result });
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
