// /api/admin/lines/point-configs — 라인 강화 Point.A/B 설정.  [Phase 3]
//   SoT = cluster4_line_point_configs. config_key(info=activity_types.id·experience=카테고리·
//   competency=master line_code)에 키잉. 기존 개설/ledger/snapshot 무접촉(설정값만).
//   테이블 미적용(마이그 전)이면 GET 은 available:false, PUT 은 503(무회귀).

import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
  type AdminContext,
} from "@/lib/adminAuth";
import { resolveAdminOrgAccess } from "@/lib/adminOrgAccess";
import { isOrganizationSlug } from "@/lib/organizations";
import {
  LinePointConfigError,
  isLinePointHub,
  listLinePointConfigs,
  upsertLinePointConfig,
} from "@/lib/adminLinePointConfigsData";

export async function GET(request: NextRequest) {
  let admin: AdminContext;
  try {
    admin = await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }
  const params = request.nextUrl.searchParams;
  const organizationRaw = params.get("organization")?.trim() || null;
  const requested = isOrganizationSlug(organizationRaw) ? organizationRaw : null;

  const access = await resolveAdminOrgAccess(admin);
  if (access.allowedOrgs.length === 0) {
    return Response.json({ success: true, data: { organization: "common", available: false, rows: [] } });
  }
  if (requested && !access.allowedOrgs.includes(requested)) {
    return Response.json({ success: false, error: "이 클럽에 접근할 권한이 없습니다." }, { status: 403 });
  }
  // 단일 허용 org → 그 org. 전체 허용 + 미지정 → common(전 조직 공유 기본).
  const organization = requested ?? (access.isAllOrgs ? "common" : access.allowedOrgs[0]);

  try {
    const data = await listLinePointConfigs(organization);
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[lines/point-configs GET]", error);
    return Response.json({ success: false, error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  let admin: AdminContext;
  try {
    admin = await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const orgRaw = typeof b.organization === "string" ? b.organization.trim() : null;
  const organization = orgRaw === "common" ? "common" : isOrganizationSlug(orgRaw) ? orgRaw : null;
  if (!organization) return Response.json({ success: false, error: "organization required (org slug or 'common')" }, { status: 400 });
  if (!isLinePointHub(b.hub)) return Response.json({ success: false, error: "hub must be info|experience|competency|career" }, { status: 400 });

  // 허용 조직 검증 — 전체 허용이 아니면 common/타org 쓰기 차단.
  const access = await resolveAdminOrgAccess(admin);
  const orgAllowed = organization !== "common" && access.allowedOrgs.includes(organization);
  if (!access.isAllOrgs && !orgAllowed) {
    return Response.json({ success: false, error: "이 클럽에 포인트를 설정할 권한이 없습니다." }, { status: 403 });
  }

  const toPoint = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));
  try {
    const row = await upsertLinePointConfig({
      organization,
      hub: b.hub,
      configKey: typeof b.config_key === "string" ? b.config_key : "",
      pointA: toPoint(b.point_a),
      pointB: toPoint(b.point_b),
      actorId: admin.userId,
    });
    // 지급 정책(2026-07-15): 포인트 지급은 "대상자 등록 시점"에만 발생한다. 설정값 변경은 이후
    //   새로 등록되는 대상자에게만 반영되며, 이미 지급된 원장은 pay-once 로 변경/재정합하지 않는다.
    return Response.json({ success: true, data: row });
  } catch (error) {
    const status = error instanceof LinePointConfigError ? error.status : 500;
    console.error("[lines/point-configs PUT]", error);
    return Response.json({ success: false, error: error instanceof Error ? error.message : "Failed" }, { status });
  }
}
