// GET /api/admin/cluster4/recompute-snapshots
//
// 주차 카드 snapshot 주기 재계산 엔드포인트. Vercel Cron + 관리자 수동/ops 트리거.
//   - is_stale=true 또는 computed_at 이 오래된(due) 기존 snapshot 을 오래된 순으로 재계산.
//   - 조회 API(/api/cluster4/weekly-cards)는 절대 재계산하지 않는다 — 재계산은 여기서만.
//   - 사용자별 실패는 격리(기존 snapshot 유지). Cron 실패가 화면을 깨뜨리지 않는다.
//
// 인증(우선순위):
//   1) Vercel Cron: Authorization: Bearer <CRON_SECRET>  (CRON_SECRET 환경변수 설정 시 자동 부착)
//   2) ops: x-internal-api-key == INTERNAL_API_KEY
//   3) 관리자 세션(requireAdmin)
//
// 쿼리 파라미터:
//   maxUsers   기본 200 — 한 번에 재계산할 최대 사용자 수(cron 타임아웃 보호).
//   dueMinutes 기본 60  — computed_at 이 이 분(min)보다 오래되면 due 로 간주.

import type { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  AdminAuthError,
  requireAdmin,
} from "@/lib/adminAuth";
import {
  currentQueryCount,
  runWithQueryMeter,
} from "@/lib/supabaseQueryMeter";
import { recomputeStaleOrDueSnapshots } from "@/lib/cluster4WeeklyCardsSnapshot";

export const maxDuration = 300; // 배치성 작업 — 넉넉한 상한.
export const dynamic = "force-dynamic";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function authorize(request: NextRequest): Promise<Response | null> {
  // 1) Vercel Cron
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (cronSecret && authHeader && timingSafeEqual(authHeader, `Bearer ${cronSecret}`)) {
    return null;
  }
  // 2) ops 내부 키
  const internalKey = request.headers.get("x-internal-api-key");
  const expected = process.env.INTERNAL_API_KEY;
  if (internalKey && expected && timingSafeEqual(internalKey, expected)) {
    return null;
  }
  // 3) 관리자 세션
  try {
    await requireAdmin(ADMIN_READ_ROLES);
    return null;
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return Response.json(
        { success: false, error: { message: error.message, code: "forbidden" } },
        { status: error.status },
      );
    }
    return Response.json(
      { success: false, error: { message: "Unauthorized", code: "unauthorized" } },
      { status: 401 },
    );
  }
}

export async function GET(request: NextRequest) {
  return runWithQueryMeter("[recompute-snapshots]", async () => {
    const denied = await authorize(request);
    if (denied) return denied;

    const sp = request.nextUrl.searchParams;
    const maxUsers = Math.max(1, Math.min(1000, Number(sp.get("maxUsers")) || 200));
    const dueMinutes = Math.max(0, Number(sp.get("dueMinutes")) || 60);

    const tStart = Date.now();
    try {
      const result = await recomputeStaleOrDueSnapshots({
        maxUsers,
        dueOlderThanMs: dueMinutes * 60 * 1000,
      });
      console.log(
        "[recompute-snapshots] done",
        `scanned=${result.scanned} recomputed=${result.recomputed} failed=${result.failed}`,
        `| ${Date.now() - tStart}ms | supabaseQueries=${currentQueryCount()}`,
      );
      return Response.json({ success: true, data: result, error: null });
    } catch (error) {
      // 전체 실패해도 기존 snapshot 은 그대로 — 조회 API 는 계속 동작.
      console.error("[recompute-snapshots] fatal", error);
      return Response.json(
        {
          success: false,
          data: null,
          error: {
            message: error instanceof Error ? error.message : "recompute failed",
            code: "internal",
          },
        },
        { status: 500 },
      );
    }
  });
}
