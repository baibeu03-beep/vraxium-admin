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

export async function GET(request: NextRequest) {
  // 데모 모드: demoUserId 가 유효한 테스트 유저면 세션 인증 대신 그 유저 데이터를 반환.
  try {
    const demoProfileUserId = await resolveDemoProfileUserId(request);
    if (demoProfileUserId) {
      const dto = await getWeeklyGrowth(demoProfileUserId);
      if (!dto) {
        return Response.json(
          { success: false, error: "User profile not found." },
          { status: 404 },
        );
      }
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

    return Response.json({ success: true, data: dto });
  } catch (error) {
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
