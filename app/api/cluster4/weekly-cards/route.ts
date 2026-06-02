import type { NextRequest } from "next/server";
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
  enqueueStaleSnapshot,
  readWeeklyCardsSnapshot,
  recomputeAndStoreWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";
import { DemoModeError, resolveDemoProfileUserId } from "@/lib/demoMode";
import {
  currentQueryCount,
  runWithQueryMeter,
} from "@/lib/supabaseQueryMeter";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

// 무거운 list API — Vercel function 최대 실행시간 상한을 명시(안전망).
// dynamic: 인증/유저별 데이터이므로 캐시 금지(항상 동적 실행).
export const maxDuration = 60;
export const dynamic = "force-dynamic";

// 디버그 비교 로그(getWeeklyGrowth 2차 호출)는 비용이 크므로 기본 OFF.
// 필요 시 Vercel 환경변수 CLUSTER4_WEEKLY_CARDS_DEBUG=1 로만 켠다.
const DEBUG_COMPARE = process.env.CLUSTER4_WEEKLY_CARDS_DEBUG === "1";

// ⚠ 504 방지 핵심: 조회 API 는 기본적으로 절대 실시간 계산을 하지 않는다(snapshot-only).
// MISS/STALE/버전불일치/조회오류 어느 경우에도 무거운 getWeeklyGrowth/computeWeeklyCards 를
// 타지 않는다 — 재계산은 Cron/관리자 훅에서만. (과거: lazy 가 기본 ON 이라 버전 bump 시 전원
// 재계산 → 504. 이제 기본 OFF 로 반전.)
//   WEEKLY_CARDS_ALLOW_LAZY=1 로만 lazy(조회 중 계산)를 한시적으로 켤 수 있다(전환/디버그용).
//   (구 WEEKLY_CARDS_DISABLE_LAZY 는 이제 무의미 — 기본이 곧 snapshot-only.)
const ALLOW_LAZY = process.env.WEEKLY_CARDS_ALLOW_LAZY === "1";

// 응답 형식 고정:
//   성공: { success: true,  data: [...], error: null }
//   실패: { success: false, data: [],     error: { message, code } }
// data 는 어떤 경우에도 배열이며 undefined 가 되지 않는다(프론트 .length/.map 방어).
function ok(data: Cluster4WeeklyCardDto[]) {
  return Response.json({ success: true, data, error: null });
}
function fail(status: number, message: string, code: string) {
  return Response.json(
    { success: false, data: [] as Cluster4WeeklyCardDto[], error: { message, code } },
    { status },
  );
}

type LoadOutcome = "hit" | "stale" | "miss" | "error";
type LoadResult = {
  cards: Cluster4WeeklyCardDto[];
  outcome: LoadOutcome;
  detail: string; // stale 사유 / error 메시지 등
  lazyRan: boolean; // 조회 경로에서 무거운 계산이 실제 실행됐는지
};

// 카드 로딩의 단일 진입점. 기본은 snapshot-only(무거운 계산 0):
//   - hit            → 저장 카드 그대로 (쿼리 1).
//   - stale(版 불일치 포함) → 저장된 구 카드 graceful 노출 (쿼리 1). cron 이 재생성.
//   - miss(행 없음)   → 빈 배열 + cron 큐잉(enqueue). 빈 화면은 cron/백필이 곧 채움.
//   - error(조회 실패) → 빈 배열(+호출부가 error 응답). 절대 계산으로 빠지지 않음.
//   ALLOW_LAZY=1 일 때만 stale/miss 에서 즉시 재계산(전환/디버그용).
async function loadWeeklyCards(profileUserId: string): Promise<LoadResult> {
  const snap = await readWeeklyCardsSnapshot(profileUserId);

  if (snap.status === "hit") {
    return { cards: snap.cards, outcome: "hit", detail: "", lazyRan: false };
  }

  if (snap.status === "stale") {
    if (ALLOW_LAZY) {
      const cards = await recomputeAndStoreWeeklyCardsSnapshot(profileUserId);
      return { cards, outcome: "stale", detail: `${snap.reason}+lazy`, lazyRan: true };
    }
    // 조회 경로 계산 금지 → 구 카드 노출, cron 이 재생성(版 불일치는 cron 후보 쿼리가 직접 잡음).
    return { cards: snap.cards, outcome: "stale", detail: snap.reason, lazyRan: false };
  }

  if (snap.status === "miss") {
    if (ALLOW_LAZY) {
      const cards = await recomputeAndStoreWeeklyCardsSnapshot(profileUserId);
      return { cards, outcome: "miss", detail: "lazy", lazyRan: true };
    }
    await enqueueStaleSnapshot(profileUserId); // cron 이 생성하도록 placeholder 큐잉
    return { cards: [], outcome: "miss", detail: "enqueued", lazyRan: false };
  }

  // error: 조회 실패. 무거운 계산으로 빠지지 않는다(ALLOW_LAZY 라도 — 일시 오류에 계산 폭증 방지).
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
      const result = await loadWeeklyCards(cardTargetUserId);
      if (DEBUG_COMPARE) await logWeekComparison(cardTargetUserId, result.cards);
      return done(ok(result.cards), "demo", { userId: cardTargetUserId, ...result });
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

    const result = await loadWeeklyCards(profileUserId);

    // 디버그 비교 로그는 getWeeklyGrowth 를 2차로 다시 호출(요청 비용 약 2배) → 기본 OFF.
    if (DEBUG_COMPARE) {
      await logWeekComparison(profileUserId, result.cards);
    }

    // error outcome 은 200(빈 카드)으로 내리되 error 필드를 채워 프론트가 덮어쓰지 않게 한다.
    if (result.outcome === "error") {
      return done(
        Response.json({
          success: false,
          data: result.cards,
          error: { message: result.detail || "snapshot read failed", code: "snapshot_read_error" },
        }),
        "ok",
        { userId: profileUserId, ...result },
      );
    }

    return done(ok(result.cards), "ok", { userId: profileUserId, ...result });
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
