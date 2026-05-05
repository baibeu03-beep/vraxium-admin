import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isOrganizationSlug } from "@/lib/organizations";

const TABLE = "legacy_crew_import";
const VIEW = "admin_crew_list_view";

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
  for (const k of WRITABLE_FIELDS) {
    if (k in (body as Record<string, unknown>)) {
      out[k] = (body as Record<string, unknown>)[k];
    }
  }
  return out;
}

export async function GET(request: NextRequest) {
  const org = request.nextUrl.searchParams.get("organization");

  let q = supabaseAdmin
    .from(VIEW)
    .select("*")
    .order("is_visible", { ascending: false })
    .order("team_name", { ascending: true, nullsFirst: false })
    .order("display_name", { ascending: true });

  if (org) {
    if (!isOrganizationSlug(org)) {
      return Response.json(
        { success: false, error: `Unknown organization: ${org}` },
        { status: 400 },
      );
    }
    q = q.eq("organization_slug", org);
  }

  const { data, error } = await q;
  if (error) {
    console.error("[admin/crews GET]", error);
    return Response.json(
      { success: false, error: error.message },
      { status: 500 },
    );
  }
  return Response.json({ success: true, data });
}

export async function POST(request: NextRequest) {
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

  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    console.error("[admin/crews POST insert]", error);
    const status = error.code === "23505" ? 409 : 500;
    return Response.json(
      { success: false, error: error.message },
      { status },
    );
  }

  // user_profiles.organization_slug도 함께 갱신 (행이 없으면 0 반환 → 경고만)
  const { data: matched, error: rpcError } = await supabaseAdmin.rpc(
    "set_crew_organization",
    {
      p_legacy_user_id: String(payload.legacy_user_id),
      p_organization_slug: organizationSlug,
    },
  );

  if (rpcError) {
    console.error("[admin/crews POST rpc]", rpcError);
    return Response.json(
      {
        success: true,
        data,
        warning: `legacy_crew_import은 저장됐지만 organization 동기화 실패: ${rpcError.message}`,
      },
      { status: 201 },
    );
  }

  return Response.json(
    {
      success: true,
      data,
      warning:
        matched === 0
          ? "user_profiles에 매칭되는 행이 없어 organization_slug를 설정하지 못했습니다. 인증 가입 후 다시 시도하세요."
          : undefined,
    },
    { status: 201 },
  );
}
