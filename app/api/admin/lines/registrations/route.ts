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
  getLineRegistration,
  listLineRegistrations,
} from "@/lib/adminLineRegistrationsData";
import { LineBridgeError, bridgeLineRegistration } from "@/lib/adminLineBridgeData";
import { assertInfoRegistrationPolicy } from "@/lib/adminInfoLineRegistrationPolicy";
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

  // ── [정보 허브] 고정 9종 정책 게이트 — **행 생성 전에** 검증한다 ────────────────
  //   실무 정보 활동유형은 고정 9종이고 info 등록은 그 9종에 정식 라인명/코드/포인트를 연결하는
  //   원장이다(신규 활동유형을 만들지 않는다). 따라서:
  //     · 활동유형 미선택/9종 외 값 → 422 INFO_ACTIVITY_TYPE_REQUIRED
  //     · 같은 조직 범위에 그 활동유형의 활성 등록이 이미 있음 → 409 (수정 경로로 유도)
  //   ⚠ 종전처럼 registration 을 먼저 만들고 포인트만 실패시키는 부분 성공 구조를 쓰지 않는다 —
  //     "등록은 됐는데 연결은 안 된" 반쪽 행이 목록에 남는다. 요청 전체를 거절해 일관성을 지킨다.
  if (parsed.value.hub === "info") {
    const violation = await assertInfoRegistrationPolicy({
      pointActivityTypeId: parsed.value.pointActivityTypeId,
      organizationSlug: parsed.value.organizationSlug,
    });
    if (violation) {
      return Response.json(
        { success: false, code: violation.code, error: violation.message },
        { status: violation.status },
      );
    }
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
  // info 포인트 config_key = 선택된 활동유형 id(고정 9종 중 하나).
  //   info 는 위 정책 게이트를 통과했으므로 이 값이 항상 유효하다 → 도출 실패 경로가 없다.
  //   (registration.pointActivityTypeId 를 쓴다 — 저장된 값과 config_key 가 갈릴 여지를 없앤다.)
  const infoActivityTypeId =
    registration.hub === "info"
      ? registration.pointActivityTypeId
      : typeof b.point_activity_type_id === "string"
        ? b.point_activity_type_id
        : null;

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
      // info 는 위 정책 게이트 통과 후이므로 여기 오지 않는다(방어적 분기).
      pointConfig = {
        saved: false,
        configKey: null,
        reason: "포인트 config_key 를 도출할 수 없습니다.",
      };
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

  // ── 개설 연결(bridge) 자동 실행 — 경험/역량 전용 ──────────────────────────────
  //   목적: "정상 등록 = 관련 개설 목록에서 바로 쓸 수 있음" 계약을 서버에서 완결한다.
  //     경험/역량 개설 목록은 bridged_master_id IS NOT NULL 인 행만 반환하고 DTO 의 id 도
  //     bridged_master_id 라, 연결 전에는 등록 라인이 개설 후보/저장 FK 어디에도 등장할 수 없다.
  //
  //   ⚠ 새 로직을 만들지 않는다 — 기존 bridgeLineRegistration() 을 그대로 호출한다.
  //     (마스터 find-or-create·무덮어쓰기·멱등(already_bridged)·info 400 거부·org 미지정 400 ·
  //      마스터 UUID 체계가 전부 그 함수의 기존 계약이다.)
  //   · info: 적용하지 않는다 — 개설 단위가 고정 9종 activity_types 이며 마스터가 없다(함수도 400 거부).
  //     info 의 연결은 등록 시 point_activity_type_id(9종 중 하나) 지정으로 끝난다.
  //   · career: 이번 단계 대상 아님(등록 화면의 라인 정보 탭에서도 제외되는 허브).
  //   · 조직 권한은 위 createAccess 게이트에서 이미 통과했다(추가 검사 불필요·중복 금지).
  //
  //   부분 성공 정책: 등록(위)은 이미 성공했다. 연결만 실패하면 롤백하지 않고 registration 을
  //     유지한 채 bridge.linked=false + reason 을 실어 보낸다 → 클라이언트가 "등록 완료 · 개설
  //     미연결" 로 안내하고, /admin/lines/info 의 [개설 연결] 버튼이 재시도 경로가 된다.
  const AUTO_BRIDGE_HUBS: ReadonlyArray<LineRegistrationHub> = ["experience", "competency"];
  let bridge: {
    linked: boolean;
    action?: "created" | "found" | "already_bridged";
    reason?: string;
  } = { linked: false };
  let finalRegistration = registration;

  if (AUTO_BRIDGE_HUBS.includes(registration.hub)) {
    try {
      const result = await bridgeLineRegistration(registration.id);
      bridge = { linked: true, action: result.action };
      // 연결 결과(bridgedMasterId/bridgedAt)를 응답 DTO 에 반영 — 클라이언트가 재조회 없이
      //   최종 상태를 그대로 쓰도록. DTO 모양/키는 불변(값만 채워진다).
      try {
        finalRegistration = await getLineRegistration(registration.id);
      } catch {
        /* 재조회 실패는 치명적이지 않다 — 연결 자체는 성공했고 목록 조회로 확인된다. */
      }
    } catch (error) {
      console.warn("[lines/registrations POST] auto bridge failed:", error);
      const status = error instanceof LineBridgeError ? error.status : 500;
      bridge = {
        linked: false,
        reason: publicErrorMessage(error, status, "개설 목록 연결에 실패했습니다."),
      };
    }
  } else {
    // info/career — 연결 대상 아님. linked=false 지만 reason 없음(실패가 아니라 "해당 없음").
    //   info 의 "연결"은 마스터 브리지가 아니라 point_activity_type_id(고정 9종) 지정이며,
    //   그것은 위 정책 게이트에서 이미 필수로 강제됐다.
    bridge = { linked: false };
  }

  return Response.json(
    { success: true, data: finalRegistration, pointConfig, bridge },
    { status: 201 },
  );
}
