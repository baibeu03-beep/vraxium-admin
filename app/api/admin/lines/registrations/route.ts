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
  type AdminContext,
} from "@/lib/adminAuth";
import { publicErrorMessage } from "@/lib/apiError";
import { resolveAdminOrgAccess } from "@/lib/adminOrgAccess";
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
import {
  deriveLineConfigKey,
  upsertLinePointConfig,
} from "@/lib/adminLinePointConfigsData";
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
  let admin: AdminContext;
  try {
    admin = await requireAdmin(ADMIN_READ_ROLES);
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
        { success: false, error: "소속 허브를 다시 선택해주세요." },
        { status: 400 },
      );
    }
    hub = hubRaw;
  }
  const limit = parseIntParam(params.get("limit"), 50, { min: 1, max: 200 });
  const offset = parseIntParam(params.get("offset"), 0, { min: 0, max: 100000 });
  // 조직 스코프(통합 ↔ 조직 진입). 내부 API 컨벤션은 organization. 미지정/무효 = 통합(전체).
  const organizationRaw = params.get("organization")?.trim() || null;
  const requested = isOrganizationSlug(organizationRaw) ? organizationRaw : null;

  // 허용 조직으로 결과를 스코프한다(탭이 아닌 필터형 페이지 — 허용 안 된 org 행 미반환).
  //   · 허용 조직 0개        → 빈 결과(권한 없음, 클라 no-access UI 담당)
  //   · 명시적 disallowed org → 403
  //   · 전체 허용            → 요청값(없으면 통합 전체)
  //   · 단일 허용            → 그 org 로 강제(listLineRegistrations 가 org+common 반환)
  const access = await resolveAdminOrgAccess(admin);
  if (access.allowedOrgs.length === 0) {
    return Response.json({
      success: true,
      data: { rows: [], total: 0, limit, offset },
    });
  }
  if (requested && !access.allowedOrgs.includes(requested)) {
    return Response.json(
      { success: false, error: "이 클럽에 접근할 권한이 없습니다." },
      { status: 403 },
    );
  }
  const organization = requested ?? (access.isAllOrgs ? null : access.allowedOrgs[0]);

  try {
    const result = await listLineRegistrations({ hub, organization, limit, offset });
    return Response.json({ success: true, data: result });
  } catch (error) {
    const status = error instanceof LineRegistrationError ? error.status : 500;
    console.error("[lines/registrations GET]", error);
    return Response.json(
      { success: false, error: publicErrorMessage(error, status, "라인 목록을 불러오지 못했습니다") },
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
    return Response.json({ success: false, error: "요청 형식이 올바르지 않습니다." }, { status: 400 });
  }

  const parsed = parseLineRegistrationCreateBody(body);
  if (!parsed.ok) {
    return Response.json({ success: false, error: parsed.error }, { status: parsed.status });
  }

  // 허용 조직 검증 — 등록할 org 이 허용 목록에 있어야 한다.
  //   전체 허용이 아니면 공통(common)/미지정(null) 라인 생성도 차단(교차 조직 쓰기 방지).
  const createAccess = await resolveAdminOrgAccess(admin);
  const createOrg = parsed.value.organizationSlug;
  const createOrgAllowed =
    createOrg != null &&
    createOrg !== "common" &&
    createAccess.allowedOrgs.includes(createOrg);
  if (!createAccess.isAllOrgs && !createOrgAllowed) {
    return Response.json(
      { success: false, error: "이 클럽에 라인을 등록할 권한이 없습니다." },
      { status: 403 },
    );
  }

  let registration;
  try {
    registration = await createLineRegistration(parsed.value, admin.userId);
  } catch (error) {
    const status = error instanceof LineRegistrationError ? error.status : 500;
    console.error("[lines/registrations POST]", error);
    return Response.json(
      { success: false, error: publicErrorMessage(error, status, "라인 등록에 실패했습니다") },
      { status },
    );
  }

  // ── [Phase 3] 강화 시 Point.A/B 를 같은 등록 동작에서 config 로 저장(설정값만·ledger 무접촉) ──
  //   config_key: info=활동유형 id · experience=line_type→카테고리 enum · competency=line_code · career=제외.
  //   반쪽 상태 정책: 라인 등록은 이미 성공(위). config 저장 실패(테이블 미적용 등)여도 요청은 성공으로
  //   반환하되 pointConfig.saved=false + reason 을 실어 클라이언트가 명확히 안내하게 한다(무회귀).
  const b = (body ?? {}) as Record<string, unknown>;
  const toPoint = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 20 ? n : null;
  };
  const pointA = toPoint(b.point_a);
  const pointB = toPoint(b.point_b);
  const infoActivityTypeId = typeof b.point_activity_type_id === "string" ? b.point_activity_type_id : null;

  let pointConfig: { saved: boolean; configKey: string | null; reason?: string } = { saved: false, configKey: null };
  const hasPoint = pointA !== null || pointB !== null;
  if (hasPoint) {
    const derived = deriveLineConfigKey({
      hub: registration.hub,
      lineType: registration.lineType,
      lineCode: registration.lineCode,
      infoActivityTypeId,
    });
    if (!derived) {
      pointConfig = { saved: false, configKey: null, reason: registration.hub === "info" ? "info 는 포인트 대상 활동유형을 선택해야 저장됩니다." : "포인트 config_key 를 도출할 수 없습니다." };
    } else {
      try {
        await upsertLinePointConfig({
          organization: registration.organizationSlug ?? "common",
          hub: derived.hub,
          configKey: derived.configKey,
          pointA,
          pointB,
          actorId: admin.userId,
        });
        pointConfig = { saved: true, configKey: derived.configKey };
      } catch (error) {
        console.warn("[lines/registrations POST] point config save failed:", error);
        pointConfig = { saved: false, configKey: derived.configKey, reason: error instanceof Error ? error.message : "포인트 저장 실패" };
      }
    }
  }

  return Response.json({ success: true, data: registration, pointConfig }, { status: 201 });
}
