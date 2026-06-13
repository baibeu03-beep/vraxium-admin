import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  getAdminCrewDtoByLegacyUserId,
  listAdminCrewDtos,
} from "@/lib/adminCrewData";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { OrganizationSlug } from "@/lib/organizations";
import { isOrganizationSlug } from "@/lib/organizations";
import { parseScopeMode } from "@/lib/userScopeShared";

const LEGACY_TABLE = "legacy_crew_import";

// Add Crew 모달 — legacy 정적 import 데이터를 보강하기 위한 경로다.
// 신규 소셜 로그인 승인 사용자는 /admin/applicants → approve-new 경로로 추가되고,
// /admin/users 에서 organization_slug 가 부여되므로 본 POST 를 거치지 않는다.
const WRITABLE_FIELDS = [
  "legacy_user_id",
  "display_name",
  "team_name",
  "part_name",
  "cumulative_weeks",
  "is_visible",
  "admin_note",
] as const;

type CrewInput = Partial<Record<(typeof WRITABLE_FIELDS)[number], unknown>>;

function pickWritable(body: unknown): CrewInput {
  if (!body || typeof body !== "object") return {};
  const out: CrewInput = {};
  for (const key of WRITABLE_FIELDS) {
    if (key in (body as Record<string, unknown>)) {
      out[key] = (body as Record<string, unknown>)[key];
    }
  }
  return out;
}

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const org = request.nextUrl.searchParams.get("organization");
  let organization: OrganizationSlug | undefined;

  if (org && !isOrganizationSlug(org)) {
    return Response.json(
      { success: false, error: `Unknown organization: ${org}` },
      { status: 400 },
    );
  }
  if (org) organization = org as OrganizationSlug;

  const mode = parseScopeMode(request.nextUrl.searchParams.get("mode"));

  try {
    const data = await listAdminCrewDtos(organization, mode);
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/crews GET]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to load crews",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const payload = pickWritable(body);
  const organizationSlug =
    (body as { organization_slug?: unknown })?.organization_slug ??
    (body as { organization?: unknown })?.organization;

  if (!payload.legacy_user_id) {
    return Response.json(
      { success: false, error: "legacy_user_id is required" },
      { status: 400 },
    );
  }
  if (!payload.display_name || typeof payload.display_name !== "string") {
    return Response.json(
      { success: false, error: "display_name is required" },
      { status: 400 },
    );
  }
  if (!isOrganizationSlug(organizationSlug)) {
    return Response.json(
      { success: false, error: "organization_slug is required" },
      { status: 400 },
    );
  }

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from(LEGACY_TABLE)
    .insert(payload)
    .select("*")
    .single();

  if (insertError) {
    console.error("[admin/crews POST insert]", insertError);
    const status = insertError.code === "23505" ? 409 : 500;
    return Response.json(
      { success: false, error: insertError.message },
      { status },
    );
  }

  // organization_slug 는 user_profiles 에 직접 반영한다.
  // users.legacy_user_id = payload.legacy_user_id 로 매칭되는 user_profiles 가
  // 있어야 한다. 매칭되지 않으면 경고만 띄우고 legacy row 는 유지한다.
  let warning: string | undefined;

  // B안 복합키 (2026-06-07): legacy_user_id 는 단독 식별자가 아니다 —
  // (source_system, legacy_user_id) 복합 체계에서 같은 숫자가 소스별로 공존 가능.
  // limit(2) 조회로 모호성을 감지해 fail-closed (잘못된 사용자에게 org 동기화 금지).
  const legacyUserId = String(payload.legacy_user_id);
  const { data: userRows, error: userErr } = await supabaseAdmin
    .from("users")
    .select("id,source_system")
    .eq("legacy_user_id", legacyUserId)
    .limit(2);

  const userRow = userRows && userRows.length === 1 ? userRows[0] : null;
  if (userErr) {
    console.error("[admin/crews POST users lookup]", userErr);
    warning = `users 조회 실패: ${userErr.message}`;
  } else if (!userRows || userRows.length === 0) {
    warning =
      "users 테이블에 legacy_user_id 매칭 row 가 없어 organization_slug 를 동기화하지 못했습니다. 사용자가 가입한 뒤 다시 시도하세요.";
  } else if (userRows.length > 1) {
    warning =
      `legacy_user_id=${legacyUserId} 가 복합키 체계에서 모호합니다 (source_system 다른 사용자 ${userRows.length}명 공존) — organization_slug 동기화를 건너뜁니다. 회원 관리 화면(UUID 기준)에서 수동 처리하세요.`;
  } else if (userRow?.id) {
    const { error: orgErr } = await supabaseAdmin
      .from("user_profiles")
      .update({ organization_slug: organizationSlug })
      .eq("user_id", userRow.id);
    if (orgErr) {
      console.error("[admin/crews POST organization_slug]", orgErr);
      warning = `legacy_crew_import 은 저장됐지만 organization_slug 동기화 실패: ${orgErr.message}`;
    }
  }

  const normalized = userRow?.id
    ? await getAdminCrewDtoByLegacyUserId(userRow.id)
    : null;

  return Response.json(
    {
      success: true,
      data: normalized ?? inserted,
      warning,
    },
    { status: 201 },
  );
}
