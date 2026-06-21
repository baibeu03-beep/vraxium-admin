import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { CLUSTER4_LINE_WRITE_ROLES } from "@/lib/adminCluster4LinesTypes";
import {
  Cluster4LineError,
  editInfoLineCrew,
} from "@/lib/adminCluster4LinesData";
import { loadCrewRecordsByUserIds } from "@/lib/cluster4CafeLineMatch";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { isOrganizationSlug } from "@/lib/organizations";
import {
  resolveUserScope,
  readScopeMode,
  assertUserIdsInScope,
} from "@/lib/userScope";

// GET /api/admin/cluster4/info-lines/crew?line_id=&week_id=&organization=&mode=
//   "개설 대상 크루 수정" 모달 상단 "현재 개설 대상 크루" 섹션용 — 이 라인+주차의 현재 user 대상자를
//   카페 검수 결과와 동일한 CrewRecord shape(이름/팀/파트/학교/전공/crew_no)로 enrich 해 돌려준다.
//   - 0명 개설 sentinel(rule-mode)은 대상자가 아니므로 제외 → 빈 배열(빈 상태 UI).
//   - org/mode 무관하게 정확히 그 대상 userId 만 by-id 조회 → 운영/테스트(demoUserId) 경로 동일 DTO.
//   - 표시 전용(read-only). snapshot/points/고객 DTO 무접촉.
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const params = request.nextUrl.searchParams;
  const lineId = params.get("line_id")?.trim() || null;
  const weekId = params.get("week_id")?.trim() || null;
  if (!lineId || !isUuid(lineId)) {
    return Response.json(
      { success: false, error: "line_id is required and must be a UUID" },
      { status: 400 },
    );
  }
  if (!weekId || !isUuid(weekId)) {
    return Response.json(
      { success: false, error: "week_id is required and must be a UUID" },
      { status: 400 },
    );
  }

  try {
    // 현재 user 대상자(생성 순) — rule-mode sentinel 제외.
    const { data: targetRows, error: targetErr } = await supabaseAdmin
      .from("cluster4_line_targets")
      .select("target_user_id,target_mode,created_at")
      .eq("line_id", lineId)
      .eq("week_id", weekId)
      .eq("target_mode", "user")
      .order("created_at", { ascending: true });
    if (targetErr) {
      return Response.json(
        { success: false, error: targetErr.message },
        { status: 500 },
      );
    }
    const userIds = ((targetRows ?? []) as Array<{ target_user_id: string | null }>)
      .map((r) => r.target_user_id)
      .filter((id): id is string => Boolean(id));

    const crews = await loadCrewRecordsByUserIds(userIds);
    const crewById = new Map(crews.map((c) => [c.userId, c]));
    // 대상 추가 순서 보존 — 미해소(프로필 없음) userId 는 최소 레코드로 폴백(이름 알 수 없음).
    const targets = userIds.map(
      (id) =>
        crewById.get(id) ?? {
          userId: id,
          crewNo: null,
          name: "(알 수 없음)",
          teamName: null,
          partName: null,
          schoolName: null,
          majorName: null,
          organization: null,
        },
    );

    return Response.json({
      success: true,
      data: { targets, count: targets.length },
    });
  } catch (error) {
    console.error("[admin/cluster4/info-lines/crew GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to load info line crew",
      },
      { status: 500 },
    );
  }
}

// PATCH /api/admin/cluster4/info-lines/crew?organization=&mode=
//   이미 개설된 (과거) 실무 정보 라인의 개설 대상 크루를 카페 검수 결과로 사후 수정한다.
//   body: { line_id, week_id, mode: 'add' | 'replace', target_user_ids: string[] }
//
//   - mode='add'(기본)     : 기존 대상자 유지 + 신규 추가(중복 제외).
//   - mode='replace'       : 기존 user 대상자를 신규 집합으로 교체.
//   - 허용 주차 = 25겨울 W1 ~ 26봄 W11(그 외 fail-closed, editInfoLineCrew 내부 게이트).
//   - target 스코프 가드(org/mode) 는 POST(info-lines)와 동일하게 여기서 선검사 — 혼입 시 422.
//   - snapshot 재계산은 editInfoLineCrew 가 invalidateWeeklyCardsForLineChange 로 수행.
type CrewEditBody = {
  line_id: string;
  week_id: string;
  mode: "add" | "replace";
  target_user_ids: string[];
};

function parseBody(
  body: unknown,
): { ok: true; value: CrewEditBody } | { ok: false; status: number; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.line_id !== "string" || !isUuid(b.line_id)) {
    return { ok: false, status: 400, error: "line_id is required and must be a UUID" };
  }
  if (typeof b.week_id !== "string" || !isUuid(b.week_id)) {
    return { ok: false, status: 400, error: "week_id is required and must be a UUID" };
  }
  const mode = b.mode === "replace" ? "replace" : b.mode === "add" ? "add" : null;
  if (mode === null) {
    return { ok: false, status: 400, error: "mode must be 'add' or 'replace'" };
  }
  // target_user_ids — 0명 허용(replace 로 전체 비우기 가능). 항목은 유효 UUID.
  const raw = Array.isArray(b.target_user_ids) ? b.target_user_ids : null;
  if (raw === null) {
    return { ok: false, status: 400, error: "target_user_ids must be an array (0명 허용)" };
  }
  const ids: string[] = [];
  for (const uid of raw) {
    if (typeof uid !== "string" || !isUuid(uid)) {
      return { ok: false, status: 400, error: "target_user_ids must contain valid UUIDs" };
    }
    ids.push(uid);
  }

  return {
    ok: true,
    value: { line_id: b.line_id, week_id: b.week_id, mode, target_user_ids: Array.from(new Set(ids)) },
  };
}

export async function PATCH(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdmin(CLUSTER4_LINE_WRITE_ROLES);
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

  const parsed = parseBody(body);
  if (!parsed.ok) {
    return Response.json({ success: false, error: parsed.error }, { status: parsed.status });
  }
  const input = parsed.value;

  // ── 조직 + 운영/테스트 스코프 강제 (cluster4_line_targets 혼입 방지) — POST 와 동일 ──
  const scopeMode = readScopeMode(request.nextUrl.searchParams);
  const scopeOrgRaw = request.nextUrl.searchParams.get("organization")?.trim() || null;
  const scopeOrg = isOrganizationSlug(scopeOrgRaw) ? scopeOrgRaw : null;

  // 1) mode 가드 — test_user_markers 등재 여부 축.
  try {
    const scope = await resolveUserScope(scopeMode, scopeOrg);
    assertUserIdsInScope(scope, input.target_user_ids);
  } catch (error) {
    if ((error as { status?: number })?.status === 422) {
      return Response.json({ success: false, error: (error as Error).message }, { status: 422 });
    }
    throw error;
  }

  // 2) org 가드 — org-scoped 수정은 target 전원이 그 org 소속이어야(동명이인 타org 저장 차단).
  if (scopeOrg && input.target_user_ids.length > 0) {
    const { data: orgRows, error: orgErr } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,organization_slug")
      .in("user_id", input.target_user_ids);
    if (orgErr) {
      return Response.json({ success: false, error: orgErr.message }, { status: 500 });
    }
    const orgById = new Map(
      ((orgRows ?? []) as Array<{ user_id: string; organization_slug: string | null }>).map(
        (r) => [r.user_id, r.organization_slug],
      ),
    );
    const offenders = input.target_user_ids.filter((id) => orgById.get(id) !== scopeOrg);
    if (offenders.length > 0) {
      return Response.json(
        {
          success: false,
          error: `현재 조직(${scopeOrg}) 소속이 아닌 사용자 ${offenders.length}명이 포함되어 처리를 중단했습니다.`,
        },
        { status: 422 },
      );
    }
  }

  try {
    const result = await editInfoLineCrew({
      lineId: input.line_id,
      weekId: input.week_id,
      mode: input.mode,
      targetUserIds: input.target_user_ids,
      actorAdminId: admin.userId,
      organization: scopeOrg,
      scopeMode,
    });
    return Response.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof Cluster4LineError) {
      return Response.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error("[admin/cluster4/info-lines/crew PATCH]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to edit info line crew",
      },
      { status: 500 },
    );
  }
}
