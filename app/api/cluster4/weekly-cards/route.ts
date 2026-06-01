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

// 백필+Cron 안정화 후 1 로 설정하면 조회 API 가 절대 실시간 계산을 하지 않는다(snapshot-only).
// miss 시에는 cron 재계산을 큐잉하고 빈 배열을 반환한다. 전환 초기에는 0(=lazy 허용)로 둔다.
const DISABLE_LAZY = process.env.WEEKLY_CARDS_DISABLE_LAZY === "1";

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

// 카드 로딩의 단일 진입점: 저장된 snapshot 우선(정상 경로 = SELECT 1개, 무거운 계산 0).
//   - snapshot hit  → 그대로 반환. is_stale 이면 로그만 남기고 노출(정책: cron/훅이 재계산).
//   - snapshot miss → (행 없음/스키마 버전 불일치) 이때만 기존 실시간 계산 1회 후 저장하고 반환.
async function loadWeeklyCards(
  profileUserId: string,
): Promise<Cluster4WeeklyCardDto[]> {
  const snap = await readWeeklyCardsSnapshot(profileUserId);
  if (snap) {
    if (snap.isStale) {
      console.warn(
        "[weekly-cards] serving STALE snapshot (cron/hook will recompute)",
        `user=${profileUserId}`,
        `computedAt=${snap.computedAt}`,
      );
    }
    return snap.cards;
  }
  // snapshot-only 모드: 조회 경로에서 절대 계산하지 않는다. cron 재계산 큐잉 후 빈 배열 반환.
  if (DISABLE_LAZY) {
    console.warn(
      "[weekly-cards] snapshot MISS + lazy disabled → enqueue for cron, return empty",
      `user=${profileUserId}`,
    );
    await enqueueStaleSnapshot(profileUserId);
    return [];
  }
  // 전환 초기 임시 안전장치: miss 일 때만 무거운 계산 허용. (신규 유저/최초 배포/스키마 버전 변경)
  console.warn("[weekly-cards] snapshot MISS → lazy compute+store", `user=${profileUserId}`);
  return recomputeAndStoreWeeklyCardsSnapshot(profileUserId);
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
  const done = (res: Response, label: string) => {
    console.log(
      "[weekly-cards] done",
      label,
      `| ${Date.now() - tStart}ms`,
      `| supabaseQueries=${currentQueryCount()}`,
    );
    return res;
  };

  // 데모 모드: demoUserId 가 유효한 테스트 유저면 세션 인증 대신 그 유저 데이터를 반환.
  // (DTO shape 은 일반 경로와 동일 — 프론트 컴포넌트 재사용 가능)
  try {
    const demoProfileUserId = await resolveDemoProfileUserId(request);
    if (demoProfileUserId) {
      const data = await loadWeeklyCards(demoProfileUserId);
      if (DEBUG_COMPARE) await logWeekComparison(demoProfileUserId, data);
      return done(ok(data), "demo");
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

    const data = await loadWeeklyCards(profileUserId);
    const profileUserIdForLog = DEBUG_COMPARE ? profileUserId : null;

    // 디버그 비교 로그는 getWeeklyGrowth 를 2차로 다시 호출(요청 비용 약 2배) → 기본 OFF.
    if (DEBUG_COMPARE && profileUserIdForLog) {
      await logWeekComparison(profileUserIdForLog, data);
    }

    return done(ok(data), "ok");
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
