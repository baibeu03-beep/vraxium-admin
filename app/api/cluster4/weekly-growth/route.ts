// GET /api/cluster4/weekly-growth
//
// Canonical public-facing host route — admin prefix 없이 운영.
// 본 admin repo 에서는 세션 인증 사용자 본인 데이터만 반환.
// Front repo 에 동일 경로가 복제될 때는 동일 인증 모델 유지.
//
// 반환: WeeklyGrowthDto (currentWeekInfo + growthSummary + weeklyCards)
//   어드민 /api/admin/crews/[legacy_user_id]/cluster4/weekly-growth 와 동일 DTO.

import type { NextRequest } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import {
  getWeeklyGrowth,
  getWeeklyGrowthByUserId,
} from "@/lib/cluster4WeeklyGrowthData";
import { DemoModeError, resolveDemoProfileUserId } from "@/lib/demoMode";
import {
  currentQueryCount,
  runWithQueryMeter,
} from "@/lib/supabaseQueryMeter";

// 무거운 데이터 라우트 — 실행시간 상한 명시 + 항상 동적 실행(인증/유저별).
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return runWithQueryMeter("[weekly-growth]", () => handleGet(request));
}

async function handleGet(request: NextRequest) {
  const tStart = Date.now();
  const logDone = (label: string) =>
    console.log(
      "[weekly-growth] done",
      label,
      `| ${Date.now() - tStart}ms`,
      `| supabaseQueries=${currentQueryCount()}`,
    );
  // 데모 모드: demoUserId 가 유효한 테스트 유저면 세션 인증 대신 그 유저 데이터를 반환.
  try {
    const demoProfileUserId = await resolveDemoProfileUserId(request);
    if (demoProfileUserId) {
      // 데모 인증은 demoUserId(viewer)로 통과하되, 조회 대상은 userId(pageOwner)가 있으면 우선한다.
      // foreign viewer(테스트유저가 타 유저 페이지 조회) 시 성장 데이터는 페이지 주인 기준이어야 함.
      const requestedUserId =
        request.nextUrl.searchParams.get("userId")?.trim() || null;
      const dto = await getWeeklyGrowth(requestedUserId || demoProfileUserId);
      if (!dto) {
        logDone("demo-404");
        return Response.json(
          { success: false, error: "User profile not found." },
          { status: 404 },
        );
      }
      logDone("demo");
      return Response.json({ success: true, data: dto });
    }
  } catch (error) {
    if (error instanceof DemoModeError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    throw error;
  }

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

  const TAG = "[cluster4/weekly-growth GET]";
  console.log(TAG, "auth.users.id =", user.id, "| email =", user.email);

  try {
    const dto = await getWeeklyGrowthByUserId(user.id, user.email);
    if (!dto) {
      console.warn(TAG, "getWeeklyGrowthByUserId returned null for auth.id =", user.id);
      return Response.json(
        { success: false, error: "User profile not found." },
        { status: 404 },
      );
    }

    console.log(TAG, "result summary:", {
      growthSummary_approvedWeeks: dto.growthSummary.approvedWeeks,
      growthSummary_availableWeeks: dto.growthSummary.availableWeeks,
      weeklyCards_count: dto.weeklyCards.length,
    });

    logDone("ok");
    return Response.json({ success: true, data: dto });
  } catch (error) {
    logDone("error");
    console.error(TAG, error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load weekly growth data.",
      },
      { status: 500 },
    );
  }
}
