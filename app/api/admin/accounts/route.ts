import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  AccountsError,
  createAccount,
  isAdminUsersRole,
  listAccounts,
  type AdminUsersRole,
  type CreateAccountPayload,
} from "@/lib/adminAccountsData";
import { publicErrorMessage } from "@/lib/apiError";

// admin_users.role='owner' = logical super_admin (단일 매핑 지점).
const SUPER_ADMIN_ROLES = ["owner"] as const;

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

// GET /api/admin/accounts
// → admin_users 기반 운영 계정 목록. user_profiles 는 enrichment 로 join.
//   조회는 owner/admin/viewer 모두 가능. 응답의 isSuperAdmin 으로 클라이언트가
//   토글/생성/PATCH 버튼 활성 여부를 결정한다.
//
// 쿼리:
//   q                 검색어 (admin_users.email ilike + id UUID 일치)
//   admin_role        owner | admin | viewer
//   active            true | false  (admin_users.is_active)
//   limit / offset    페이지네이션 (limit 최대 200, 기본 50)
export async function GET(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const params = request.nextUrl.searchParams;
  const q = params.get("q")?.trim() || null;

  const adminRoleRaw = params.get("admin_role")?.trim() || null;
  if (adminRoleRaw !== null && !isAdminUsersRole(adminRoleRaw)) {
    return Response.json(
      { success: false, error: "선택할 수 없는 권한 등급입니다." },
      { status: 400 },
    );
  }
  const adminRole: AdminUsersRole | null = adminRoleRaw;

  const activeRaw = params.get("active");
  let isActive: boolean | null = null;
  if (activeRaw === "true") isActive = true;
  else if (activeRaw === "false") isActive = false;
  else if (activeRaw !== null && activeRaw !== "") {
    return Response.json(
      { success: false, error: "선택할 수 없는 활성 상태 필터입니다." },
      { status: 400 },
    );
  }

  const limit = parseIntParam(params.get("limit"), 50, { min: 1, max: 200 });
  const offset = parseIntParam(params.get("offset"), 0, { min: 0, max: 100000 });

  const isSuperAdmin = admin.role === "owner";

  try {
    const data = await listAccounts({
      query: q,
      adminRole,
      isActive,
      limit,
      offset,
      isSuperAdmin,
    });
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/accounts GET]", error);
    const status = error instanceof AccountsError ? error.status : 500;
    return Response.json(
      {
        success: false,
        error: publicErrorMessage(error, status, "계정 목록을 불러오지 못했습니다."),
      },
      { status },
    );
  }
}

// POST /api/admin/accounts
// body: CreateAccountPayload (admin_role 필수, is_active 기본 true)
// → Supabase Auth + users + user_profiles + admin_users + audit 한 번에 생성.
//   user_profiles.role 은 admin_role 의 매핑값으로 자동 동기화 (super_admin/admin/null).
//   super_admin 단독.
export async function POST(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdmin(SUPER_ADMIN_ROLES);
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
      { success: false, error: "요청 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  if (!body || typeof body !== "object") {
    return Response.json(
      { success: false, error: "요청 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  try {
    const result = await createAccount({
      payload: body as CreateAccountPayload,
      actorId: admin.userId,
    });
    return Response.json({ success: true, data: result }, { status: 201 });
  } catch (error) {
    console.error("[admin/accounts POST]", error);
    const status = error instanceof AccountsError ? error.status : 500;
    return Response.json(
      {
        success: false,
        error: publicErrorMessage(error, status, "계정을 생성하지 못했습니다."),
      },
      { status },
    );
  }
}
