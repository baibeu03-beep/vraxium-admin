// GET /api/cluster3/stats-cards
//
// Canonical public-facing host route — admin prefix 없이 운영.
// 인증 2-경로 (club-rank / weekly-cards 와 동일 모델):
//   1) x-internal-api-key == INTERNAL_API_KEY → 세션 건너뛰고 ?userId= 대상 계산
//      (프론트 레포의 cluster3 stats-cards 프록시가 이 경로로 호출)
//   2) 그 외 → Supabase 세션 인증 사용자 본인 데이터만 반환 (기존 흐름 유지)
//
// stats-cards 3영역(Process / Period / Point)의 SoT 는 getCluster3StatsCards() →
// getGrowthIndicators() 실시간 계산식 단 하나다.
// 어드민 GET /api/admin/crews/[legacy_user_id]/cluster3/growth 와 정확히 동일한
// getGrowthIndicators() 를 재사용하므로 어드민 화면과 항상 같은 값을 반환한다.
// 캐시 테이블(user_growth_stats / user_grade_stats)은 이 경로에서 참조하지 않는다.
//
// 반환: Cluster3StatsCards (process / period / points)

import type { NextRequest } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveProfileUserId } from "@/lib/resolveProfileUserId";
import { getCluster3StatsCards } from "@/lib/cluster3StatsCardsData";
import { GrowthError } from "@/lib/cluster3GrowthData";

export async function GET(request: NextRequest) {
  const TAG = "[cluster3/stats-cards GET]";
  const requestStartedAt = Date.now();

  // weekly-cards 와 동일한 internal API key 인증 분기.
  // 프론트(NextAuth)는 Supabase sb-* 쿠키가 없으므로, SSR 서버 간 호출은
  // x-internal-api-key + ?userId= 조합으로 세션 없이 통과시킨다.
  const internalKey = request.headers.get("x-internal-api-key");
  const expectedInternalKey = process.env.INTERNAL_API_KEY;
  const internalAuthAccepted =
    !!internalKey &&
    !!expectedInternalKey &&
    internalKey === expectedInternalKey;
  const requestedUserId =
    request.nextUrl.searchParams.get("userId")?.trim() || null;

  console.log(TAG, "request received", {
    host: request.headers.get("host"),
    pathname: request.nextUrl.pathname,
    hasUserId: !!requestedUserId,
    hasInternalKey: !!internalKey,
    internalKeyLength: internalKey?.length ?? 0,
    hasExpectedInternalKey: !!expectedInternalKey,
    expectedInternalKeyLength: expectedInternalKey?.length ?? 0,
    internalAuthAccepted,
  });

  // 키 값은 절대 로그하지 않는다 — hasKey/keyLength/accepted 만 출력.
  if (internalKey) {
    console.log(TAG, "internal auth", {
      hasKey: !!internalKey,
      keyLength: internalKey.length,
      accepted: internalAuthAccepted,
    });
  }

  let userId: string | null = null;

  if (internalAuthAccepted) {
    if (!requestedUserId) {
      console.warn(TAG, "internal request rejected: missing userId");
      return Response.json(
        { success: false, error: "userId is required for internal calls." },
        { status: 400 },
      );
    }
    userId = requestedUserId;
  }

  try {
    if (!internalAuthAccepted) {
      const supabase = await getSupabaseServerClient();
      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser();

      if (authError || !user) {
        console.warn(TAG, "session auth rejected", {
          hasAuthError: !!authError,
          authErrorMessage: authError?.message,
          elapsedMs: Date.now() - requestStartedAt,
        });
        return Response.json(
          { success: false, error: "Authentication required." },
          { status: 401 },
        );
      }

      console.log(TAG, "auth.users.id =", user.id, "| email =", user.email);

      userId = await resolveProfileUserId(user.id, user.email);
      if (!userId) {
        console.warn(TAG, "resolveProfileUserId returned null for auth.id =", user.id);
        return Response.json(
          { success: false, error: "User profile not found." },
          { status: 404 },
        );
      }
    }

    const dto = await getCluster3StatsCards(userId!);

    console.log(TAG, "result:", {
      mode: internalAuthAccepted ? "internal" : "session",
      profileUserId: userId,
      growthStatus: dto.process.growthStatusKey,
      successWeeks: dto.period.successWeeks,
      totalStars: dto.points.totalStars,
      elapsedMs: Date.now() - requestStartedAt,
    });

    return Response.json({ success: true, data: dto });
  } catch (error) {
    console.error(TAG, error);
    if (error instanceof GrowthError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to load stats cards.",
      },
      { status: 500 },
    );
  }
}
