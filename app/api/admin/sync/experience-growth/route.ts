import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  syncAllExperienceGrowthWeekStatuses,
  syncTestExperienceGrowthWeekStatuses,
} from "@/lib/cluster4WeeklyGrowthData";

// 실무경험 성장 상태 동기화 (success → fail 단방향, rest/현재주 제외, 멱등).
//
// 개발자 모드 기준 정책:
//   body { devMode: boolean, scope?: "all" | "test", confirm?: boolean }
//   - devMode=true  → 강제로 scope="test" (테스트 사용자만, 실사용자 보호). 즉시 반영.
//   - devMode=false → scope="all" 허용(운영 전체, 실사용자 포함).
//       · confirm=true  → 실제 DB 반영.
//       · confirm 없음  → dry-run 만 (변경 예정만 계산, DB write 금지).
//   - scope="test" 는 항상 테스트 사용자만 대상이라 confirm 없이 즉시 반영(안전).
// fail 판정 정책 자체는 테스트/실사용자 동일. 모드는 "DB 반영 범위/시점"만 가른다.
export async function POST(request: Request) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  let devMode = false;
  let requestedScope: "all" | "test" = "test";
  let confirm = false;
  try {
    const body = (await request.json().catch(() => ({}))) as {
      devMode?: boolean;
      scope?: string;
      confirm?: boolean;
    };
    devMode = body?.devMode === true;
    if (body?.scope === "all") requestedScope = "all";
    confirm = body?.confirm === true;
  } catch {
    // body 없음/파싱 실패 → 안전 기본값 (devMode=false, scope=test, confirm=false)
  }

  // devMode=true 이면 scope 를 강제로 test 로 (실사용자 보호). devMode=false 일 때만 all 허용.
  const scope: "all" | "test" = devMode ? "test" : requestedScope;
  // scope=all 은 confirm=true 일 때만 실제 반영. 그 외(test 포함)는 즉시 반영.
  const dryRun = scope === "all" && !confirm;

  try {
    const data =
      scope === "all"
        ? await syncAllExperienceGrowthWeekStatuses({ dryRun })
        : await syncTestExperienceGrowthWeekStatuses();
    return Response.json({ success: true, devMode, scope, dryRun, confirm, data });
  } catch (error) {
    console.error("[admin/sync/experience-growth POST]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to sync all experience growth week statuses",
      },
      { status: 500 },
    );
  }
}
