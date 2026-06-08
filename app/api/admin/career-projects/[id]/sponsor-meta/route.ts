import { NextRequest } from "next/server";
import { requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import {
  CareerProjectError,
  collectCareerProjectTargetUserIds,
  updateCareerProjectSponsorMeta,
  type CareerProjectSponsorMetaInput,
} from "@/lib/adminCareerProjectsData";
import { CAREER_PROJECTS_WRITE_ROLES } from "@/lib/adminCareerProjectsTypes";
import {
  markWeeklyCardsSnapshotStaleMany,
  recomputeWeeklyCardsSnapshotsForUsers,
} from "@/lib/cluster4WeeklyCardsSnapshot";
import { syncRegistrationFromCareerProject } from "@/lib/lineMasterDriftGuard";

// PATCH /api/admin/career-projects/[id]/sponsor-meta
//   career_projects 의 sponsor-card 6필드만 부분 수정 (full upsert 아님 — 다른 컬럼/career_records 불변).
//   라인 편집 모달 / 라인 개설 화면에서 기업·감독자 정보를 바로 고칠 때 사용.
//   성공 시 이 프로젝트를 보는 모든 대상자의 weekly-cards snapshot 을 stale 처리한다.
//   companyName SoT = company_name (supervisor_company fallback 미사용).

type Ctx = { params: Promise<{ id: string }> };

const META_KEYS = [
  "company_name",
  "company_logo_url",
  "supervisor_name",
  "supervisor_department",
  "supervisor_position",
  "supervisor_profile_img",
] as const;

function parseBody(
  body: unknown,
): { ok: true; value: CareerProjectSponsorMetaInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  const texts: Record<string, string | null> = {};
  for (const key of META_KEYS) {
    const raw = b[key];
    if (raw === undefined || raw === null) {
      texts[key] = null;
      continue;
    }
    if (typeof raw !== "string") {
      return { ok: false, error: `${key} must be a string or null` };
    }
    const trimmed = raw.trim();
    texts[key] = trimmed.length ? trimmed : null;
  }
  return {
    ok: true,
    value: {
      companyName: texts.company_name,
      companyLogoUrl: texts.company_logo_url,
      supervisorName: texts.supervisor_name,
      supervisorDepartment: texts.supervisor_department,
      supervisorPosition: texts.supervisor_position,
      supervisorProfileImg: texts.supervisor_profile_img,
    },
  };
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(CAREER_PROJECTS_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parseBody(body);
  if (!parsed.ok) {
    return Response.json({ success: false, error: parsed.error }, { status: 400 });
  }

  try {
    const meta = await updateCareerProjectSponsorMeta(id, parsed.value);
    // 이 프로젝트를 보는 모든 대상자(선발 로스터 ∪ 라인 target).
    const targetUserIds = await collectCareerProjectTargetUserIds(id);
    // 1) 먼저 stale 표시(안전망) — 이후 eager 재계산이 실패한 사용자는 stale 로 남아 cron 이 보정.
    await markWeeklyCardsSnapshotStaleMany(targetUserIds);
    // 2) 그 자리에서 즉시 재계산·저장 — mark-stale 만 하면 lazy-on-read/cron 에 의존해
    //    snapshot-only(DISABLE_LAZY) 런타임/지연 조회 시 옛값이 계속 노출되는 race 가 있었다.
    //    저장 시점에 바로 재계산해 다음 weekly-cards 조회에서 변경이 즉시 반영되게 한다. best-effort.
    const recompute = await recomputeWeeklyCardsSnapshotsForUsers(targetUserIds);
    // (2E-5) bridged registration 이 있는 행만 통합 등록에 역방향 동기화 — mirror 정합 유지.
    const sync = await syncRegistrationFromCareerProject(id);
    return Response.json({
      success: true,
      data: {
        meta,
        staleUserCount: targetUserIds.length,
        recomputed: recompute.recomputed,
        recomputeFailed: recompute.failed,
      },
      driftSync: { synced: sync.synced, warning: sync.warning },
    });
  } catch (error) {
    if (error instanceof CareerProjectError) {
      return Response.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error("[admin/career-projects/:id/sponsor-meta PATCH]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to update sponsor meta",
      },
      { status: 500 },
    );
  }
}
