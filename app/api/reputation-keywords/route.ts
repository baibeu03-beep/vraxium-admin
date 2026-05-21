// GET /api/reputation-keywords
//
// Canonical public-facing host route — admin prefix 없이 운영.
// 본 admin repo 에서는 requireAdmin(ADMIN_READ_ROLES) 로 게이트한다. Front repo
// 에 동일 경로가 복제될 때는 인증 모델을 다음과 같이 swap 한다:
//
//   - master taxonomy (PII 없음) 이므로 최소한 세션 인증만 요구.
//   - 정책에 따라 unauth 노출을 허용할 수도 있음. 단 본 admin repo 에서는 항상 가드.
//
// 본 단계는 read 전용. PATCH/POST 는 없음.

import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { listReputationKeywords } from "@/lib/reputationKeywordsData";

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const sp = request.nextUrl.searchParams;
  const clusterParam = sp.get("cluster_number");
  let clusterNumber: number | null = null;
  if (clusterParam !== null && clusterParam.trim() !== "") {
    const n = Number(clusterParam);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 5) {
      return Response.json(
        { success: false, error: "cluster_number must be 1..5" },
        { status: 400 },
      );
    }
    clusterNumber = n;
  }

  try {
    const result = await listReputationKeywords({ clusterNumber });
    return Response.json({
      success: true,
      data: { keywords: result.rows },
      meta: { available: result.available, count: result.rows.length },
    });
  } catch (error) {
    console.error("[reputation-keywords GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load reputation_keywords.",
      },
      { status: 500 },
    );
  }
}
