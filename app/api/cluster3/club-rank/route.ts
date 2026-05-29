// GET /api/cluster3/club-rank
//
// Canonical public-facing host route — admin prefix 없이 운영.
// 인증 2-경로 (weekly-cards 와 동일 모델):
//   1) x-internal-api-key == INTERNAL_API_KEY → 세션 건너뛰고 ?userId= 대상 계산
//      (프론트 /api/profile → fetchClubRankAvgPercentile 가 이 경로로 호출)
//   2) 그 외 → Supabase 세션 인증 사용자 본인 데이터만 반환 (기존 흐름 유지)
//
// 주차 평균 백분위(avgPercentile)의 SoT 는 getClubRank() 실시간 계산식 단 하나다.
// 어드민 GET /api/admin/crews/[legacy_user_id]/cluster3/growth/rank 와
// 정확히 동일한 getClubRank() 를 재사용하므로 admin 화면과 항상 같은 값을 반환한다.
// user_grade_stats.avg_percentile 캐시는 이 경로에서 참조하지 않는다.
//
// 온보딩 1주차 제외 기준: getClubRank() 가 user_week_statuses 의 최소 year/week 를
// 사용한다 (단일 기준).
//
// 반환: ClubRankDto (avgPercentile, avgPercentileDisplay, rankGrade, isFrozen, weeklyDetails)

import type { NextRequest } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveProfileUserId } from "@/lib/resolveProfileUserId";
import { getClubRank } from "@/lib/cluster3ClubRankData";
import { GrowthError } from "@/lib/cluster3GrowthData";

export async function GET(request: NextRequest) {
  const TAG = "[cluster3/club-rank GET]";

  // === 인증 분기 1: internal key (서버-서버 호출, 세션 없음) ===
  const internalKey = request.headers.get("x-internal-api-key");
  const expectedInternalKey = process.env.INTERNAL_API_KEY;
  const internalAuthAccepted =
    !!internalKey && !!expectedInternalKey && internalKey === expectedInternalKey;

  if (internalKey) {
    // 키 값은 절대 로그하지 않는다 — 존재/length/수락 여부만.
    console.log(TAG, "internal auth", {
      hasKey: !!internalKey,
      keyLength: internalKey.length,
      accepted: internalAuthAccepted,
    });
  }

  // 대상 profile userId 결정.
  let targetUserId: string | null = null;

  if (internalAuthAccepted) {
    // internal 호출은 ?userId= (profile userId) 필수.
    const requestedUserId = request.nextUrl.searchParams.get("userId")?.trim() || null;
    if (!requestedUserId) {
      return Response.json(
        { success: false, error: "userId is required for internal calls." },
        { status: 400 },
      );
    }
    targetUserId = requestedUserId;
  } else {
    // === 인증 분기 2: 기존 Supabase 세션 인증 (본인 데이터만) ===
    const supabase = await getSupabaseServerClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return Response.json(
        { success: false, error: "Authentication required." },
        { status: 401 },
      );
    }

    console.log(TAG, "auth.users.id =", user.id, "| email =", user.email);

    const resolved = await resolveProfileUserId(user.id, user.email);
    if (!resolved) {
      console.warn(TAG, "resolveProfileUserId returned null for auth.id =", user.id);
      return Response.json(
        { success: false, error: "User profile not found." },
        { status: 404 },
      );
    }
    targetUserId = resolved;
  }

  try {
    const dto = await getClubRank(targetUserId);

    console.log(TAG, "result:", {
      mode: internalAuthAccepted ? "internal" : "session",
      profileUserId: targetUserId,
      avgPercentile: dto.avgPercentile,
      rankGrade: dto.rankGrade,
      isFrozen: dto.isFrozen,
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
          error instanceof Error ? error.message : "Failed to load club rank.",
      },
      { status: 500 },
    );
  }
}
