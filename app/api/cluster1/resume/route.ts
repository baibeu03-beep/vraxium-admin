// GET /api/cluster1/resume?userId=<profile user_id>
//
// Canonical public-facing host route — admin prefix 없이 운영.
// 고객 프론트(/api/profile)가 사이드바 이력서 카드의 활동완료율·실무성적·일정신뢰도를
// 자체 계산하지 않고 이 단일 SoT(getCluster1Resume)에서 가져가도록 노출하는 프록시 경로다.
// (club-rank GET /api/cluster3/club-rank 와 동일한 x-internal-api-key 서버-서버 인증 모델.)
//
// 인증: x-internal-api-key == INTERNAL_API_KEY 만 허용(서버-서버 전용). 세션 경로 없음 —
//   어드민 화면은 /api/admin/crews/[legacy_user_id]/resume-card/resume(세션 인증)를 그대로 쓴다.
//
// 반환 DTO 는 어드민 resume-card/resume 와 동일한 getCluster1Resume() 결과이므로
//   direct(getCluster1Resume) == admin HTTP == 이 internal HTTP == 고객 표시값 이 보장된다.

import type { NextRequest } from "next/server";
import { getCluster1Resume } from "@/lib/cluster1ResumeData";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: NextRequest) {
  const TAG = "[cluster1/resume GET]";

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

  if (!internalAuthAccepted) {
    return Response.json(
      { success: false, error: "internal key required." },
      { status: 401 },
    );
  }

  const userId = request.nextUrl.searchParams.get("userId")?.trim() || null;
  if (!userId) {
    return Response.json(
      { success: false, error: "userId is required." },
      { status: 400 },
    );
  }

  try {
    // getCluster1Resume 의 식별자(legacyUserId)는 user_profiles.user_id(UUID)다 (lib/adminCrewData 참고).
    const dto = await getCluster1Resume(userId);
    if (!dto) {
      return Response.json(
        { success: false, error: "User not found." },
        { status: 404 },
      );
    }
    console.log(TAG, "result", {
      profileUserId: userId,
      completionRate: dto.activityCompletion.rate,
      available: dto.activityCompletion.availableActivities,
      completed: dto.activityCompletion.completedActivities,
    });
    return Response.json({ success: true, data: dto });
  } catch (error) {
    console.error(TAG, error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to load resume DTO.",
      },
      { status: 500 },
    );
  }
}
