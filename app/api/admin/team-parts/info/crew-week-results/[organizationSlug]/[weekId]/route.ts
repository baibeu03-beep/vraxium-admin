import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
  type AdminContext,
} from "@/lib/adminAuth";
import { guardAdminOrgAccess } from "@/lib/adminOrgAccess";
import { isOrganizationSlug } from "@/lib/organizations";
import { parseScopeMode } from "@/lib/userScopeShared";
import { resolveOrgResultScope } from "@/lib/weekOrgResultState";
import {
  computeCrewWeekPreview,
  publishCrewWeekResult,
  unpublishCrewWeekResult,
  loadPublishedCrewWeekResult,
  CrewWeekPublishError,
} from "@/lib/crewWeekPublish";

// 주차 결과(크루) — 주차 × 조직 단위 예비/공표/취소.
//
//   GET    ?action=preview   → [3] 예비 검수. **live 계산 · 저장 0.** 다른 화면 무영향.
//   GET    (기본)            → 공표된 결과(활성 run snapshot) 조회. 없으면 published=null.
//   POST   {action:"publish"}   → [4] 공표. 서버가 원천 재조회·재계산 후 snapshot 저장.
//   POST   {action:"unpublish"} → [4] 공표 취소. reverted_at 세팅(물리 삭제 없음).
//
// ⚠ 클라이언트가 보낸 지표 숫자는 **일절 받지 않는다**(body 에 숫자를 넣어도 무시). 공표 시점의
//   최신 원천으로 서버가 다시 계산한다 — 예비 검수 후 다른 화면에서 포인트가 바뀔 수 있기 때문.
// ⚠ scope 는 검수 상태와 동일한 resolveOrgResultScope(mode) 단일 출처. 일반/test/actAs/demo 가
//   같은 command·같은 projection 을 타고, 사용자 컨텍스트 해석만 다르다.

type Params = { params: Promise<{ organizationSlug: string; weekId: string }> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveTarget(request: NextRequest, params: Params["params"], write: boolean) {
  let admin: AdminContext;
  try {
    admin = await requireAdmin(write ? ADMIN_WRITE_ROLES : ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return { error: response } as const;
    throw error;
  }
  const { organizationSlug, weekId } = await params;
  if (!isOrganizationSlug(organizationSlug)) {
    return {
      error: Response.json(
        { success: false, error: "유효한 클럽(encre·oranke·phalanx)이 필요합니다." },
        { status: 400 },
      ),
    } as const;
  }
  if (!UUID_RE.test(weekId)) {
    return {
      error: Response.json({ success: false, error: "유효한 주차가 필요합니다." }, { status: 400 }),
    } as const;
  }
  const denied = await guardAdminOrgAccess(admin, organizationSlug);
  if (denied) return { error: denied } as const;

  const mode = parseScopeMode(request.nextUrl.searchParams.get("mode"));
  return { admin, organization: organizationSlug, weekId, scope: resolveOrgResultScope(mode) } as const;
}

function toErrorResponse(error: unknown, fallback: string) {
  if (error instanceof CrewWeekPublishError) {
    return Response.json({ success: false, error: error.message }, { status: error.status });
  }
  console.error("[crew-week-results/detail]", error);
  return Response.json(
    { success: false, error: error instanceof Error ? error.message : fallback },
    { status: 500 },
  );
}

export async function GET(request: NextRequest, { params }: Params) {
  const t = await resolveTarget(request, params, false);
  if ("error" in t) return t.error;

  const action = request.nextUrl.searchParams.get("action");
  try {
    if (action === "preview") {
      // [3] 예비 검수 — 저장하지 않는다. 응답 자체가 결과다.
      const preview = await computeCrewWeekPreview({
        organization: t.organization,
        weekId: t.weekId,
        scope: t.scope,
      });
      return Response.json({ success: true, data: { preview, scope: t.scope } });
    }
    const published = await loadPublishedCrewWeekResult({
      organization: t.organization,
      weekId: t.weekId,
      scope: t.scope,
    });
    return Response.json({ success: true, data: { published, scope: t.scope } });
  } catch (error) {
    return toErrorResponse(error, "조회에 실패했습니다.");
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  const t = await resolveTarget(request, params, true);
  if ("error" in t) return t.error;

  let body: { action?: string } = {};
  try {
    body = (await request.json()) as { action?: string };
  } catch {
    body = {};
  }

  try {
    if (body.action === "publish") {
      const published = await publishCrewWeekResult({
        organization: t.organization,
        weekId: t.weekId,
        scope: t.scope,
        actorId: t.admin.userId,
      });
      return Response.json({ success: true, data: { published, scope: t.scope } });
    }
    if (body.action === "unpublish") {
      const result = await unpublishCrewWeekResult({
        organization: t.organization,
        weekId: t.weekId,
        scope: t.scope,
        actorId: t.admin.userId,
      });
      return Response.json({ success: true, data: { ...result, scope: t.scope } });
    }
    return Response.json(
      { success: false, error: "action 은 publish 또는 unpublish 여야 합니다." },
      { status: 400 },
    );
  } catch (error) {
    return toErrorResponse(error, "처리에 실패했습니다.");
  }
}
