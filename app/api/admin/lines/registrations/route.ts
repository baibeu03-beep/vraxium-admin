// /api/admin/lines/registrations — 라인 등록 레지스트리 (additive Phase).
//
// line_registrations 테이블만 읽고 쓴다. 기존 4허브 SoT(cluster4_lines · 마스터 ·
// career_projects), snapshot 생성/조회, demoUserId/일반 사용자 경로는 일절 건드리지 않는다.

import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  isLineRegistrationHub,
  parseLineRegistrationCreateBody,
  type LineRegistrationHub,
} from "@/lib/adminLineRegistrationsTypes";
import {
  LineRegistrationError,
  createLineRegistration,
  listLineRegistrations,
} from "@/lib/adminLineRegistrationsData";
import { isOrganizationSlug } from "@/lib/organizations";

function parseIntParam(
  raw: string | null,
  fallback: number,
  { min, max }: { min: number; max: number },
) {
  if (raw == null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const params = request.nextUrl.searchParams;
  const hubRaw = params.get("hub")?.trim() || null;
  let hub: LineRegistrationHub | null = null;
  if (hubRaw !== null) {
    if (!isLineRegistrationHub(hubRaw)) {
      return Response.json(
        { success: false, error: "hub must be one of info|experience|competency|career" },
        { status: 400 },
      );
    }
    hub = hubRaw;
  }
  const limit = parseIntParam(params.get("limit"), 50, { min: 1, max: 200 });
  const offset = parseIntParam(params.get("offset"), 0, { min: 0, max: 100000 });
  // 조직 스코프(통합 ↔ 조직 진입). 내부 API 컨벤션은 organization. 미지정/무효 = 통합(전체).
  const organizationRaw = params.get("organization")?.trim() || null;
  const organization = isOrganizationSlug(organizationRaw) ? organizationRaw : null;

  try {
    const result = await listLineRegistrations({ hub, organization, limit, offset });
    return Response.json({ success: true, data: result });
  } catch (error) {
    const status = error instanceof LineRegistrationError ? error.status : 500;
    console.error("[lines/registrations GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status },
    );
  }
}

export async function POST(request: NextRequest) {
  let admin;
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

  const parsed = parseLineRegistrationCreateBody(body);
  if (!parsed.ok) {
    return Response.json({ success: false, error: parsed.error }, { status: parsed.status });
  }

  try {
    const registration = await createLineRegistration(parsed.value, admin.userId);
    return Response.json({ success: true, data: registration }, { status: 201 });
  } catch (error) {
    const status = error instanceof LineRegistrationError ? error.status : 500;
    console.error("[lines/registrations POST]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status },
    );
  }
}
