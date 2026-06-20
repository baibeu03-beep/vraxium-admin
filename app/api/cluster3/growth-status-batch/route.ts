// GET /api/cluster3/growth-status-batch?org=<slug?>
//
// 고객앱 /crews 목록의 displayGrowthStatus graft 전용 — server-to-server 배치 조회.
// 인증: x-internal-api-key == INTERNAL_API_KEY 단일 경로 (stats-cards 의 internal 분기와
// 동일 모델, 세션 경로 없음 — 목록 단위 타인 데이터라 본인-세션 인증이 성립하지 않는다).
//
// 동작:
//   - ?org= 가 있으면 해당 조직(user_profiles.organization_slug) 로스터만,
//     없으면 organization_slug 비-NULL 전원.
//   - 각 사용자에 대해 getGrowthStatusResolutionBatch() 가
//     {raw, auto, override, display(=override ?? auto), mismatch} 를 반환.
//     상태 판정 SoT = lib/growthCore.resolveGrowthStatusDetail (cluster3 와 동일 경로).
//
// 반환: { success: true, data: GrowthStatusResolutionRow[] }

import type { NextRequest } from "next/server";
import {
  getGrowthStatusResolutionBatch,
  GrowthError,
} from "@/lib/cluster3GrowthData";
import { isOrganizationSlug } from "@/lib/organizations";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { observeApiRoute } from "@/lib/apiObservability";

export async function GET(request: NextRequest) {
  const TAG = "[cluster3/growth-status-batch GET]";

  const internalKey = request.headers.get("x-internal-api-key");
  const expectedInternalKey = process.env.INTERNAL_API_KEY;
  const internalAuthAccepted =
    !!internalKey && !!expectedInternalKey && internalKey === expectedInternalKey;

  // 키 값은 절대 로그하지 않는다.
  if (!internalAuthAccepted) {
    console.warn(TAG, "unauthorized", {
      hasKey: !!internalKey,
      hasExpectedKey: !!expectedInternalKey,
    });
    return Response.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const org = request.nextUrl.searchParams.get("org")?.trim() || null;
  if (org && !isOrganizationSlug(org)) {
    return Response.json(
      { success: false, error: `Unknown organization: ${org}` },
      { status: 400 },
    );
  }

  // 고객앱 /crews graft 대량 배치 핫패스 — 실행 시간/처리 건수/쿼리/timeout 계측.
  return observeApiRoute(TAG, async (obs) => {
    try {
      let rosterQuery = supabaseAdmin
        .from("user_profiles")
        .select("user_id")
        .not("organization_slug", "is", null);
      if (org) rosterQuery = rosterQuery.eq("organization_slug", org);

      const rosterRes = await rosterQuery;
      if (rosterRes.error) {
        throw new GrowthError(500, rosterRes.error.message);
      }
      const userIds = ((rosterRes.data ?? []) as Array<{ user_id: string }>).map(
        (row) => row.user_id,
      );

      const data = await getGrowthStatusResolutionBatch(userIds);
      obs.processed = data.length;

      return Response.json({ success: true, data });
    } catch (error) {
      if (error instanceof GrowthError) {
        console.error(TAG, "growth error", { status: error.status, message: error.message });
        return Response.json(
          { success: false, error: error.message },
          { status: error.status },
        );
      }
      console.error(TAG, "unexpected error", error);
      return Response.json(
        { success: false, error: "Internal server error" },
        { status: 500 },
      );
    }
  });
}
