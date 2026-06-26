import { NextRequest } from "next/server";
import { ADMIN_READ_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { listMembersRoster } from "@/lib/adminMembersData";
import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";
import { parseScopeMode } from "@/lib/userScopeShared";
import { observeApiRoute } from "@/lib/apiObservability";
import { isFilterValue, type SortEntry, type ColKey } from "@/lib/membersRosterView";

// GET /api/admin/members/roster?organization=&mode=&page=&pageSize=&search=&filter=&sort=
//
// /admin/members "크루 목록" 탭 — 서버 페이지네이션(기본 50). 검색/상태필터/정렬을 서버에서
// 적용하고 해당 페이지 행만 반환한다. 품계=user_grade_stats 캐시, 모집단=operationalSeasonKey 참여자.
// 응답: { members(page rows), total(모집단), filteredTotal, statusCounts{active,rest,stopped}, page, pageSize }.
//   sort = "key:dir,key:dir" (예: "poA:desc,name:asc"). organization 미지정 = 전체.
function parseSort(raw: string | null): SortEntry[] {
  if (!raw) return [];
  const out: SortEntry[] = [];
  for (const tok of raw.split(",")) {
    const [key, dir] = tok.split(":");
    if (key && key.trim()) out.push({ key: key.trim() as ColKey, dir: dir?.trim() === "desc" ? "desc" : "asc" });
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

  const params = request.nextUrl.searchParams;

  const orgParam = params.get("organization")?.trim() || null;
  let organization: OrganizationSlug | null = null;
  if (orgParam) {
    if (isOrganizationSlug(orgParam)) {
      organization = orgParam;
    } else {
      return Response.json(
        { success: false, error: `Unknown organization: ${orgParam}` },
        { status: 400 },
      );
    }
  }

  const pageRaw = Number(params.get("page"));
  const pageSizeRaw = Number(params.get("pageSize"));
  const filterRaw = params.get("filter")?.trim() || null;
  const filter = isFilterValue(filterRaw) ? filterRaw : null;
  const search = params.get("search");
  const sort = parseSort(params.get("sort"));

  // 서버 페이지네이션 핫패스 — 실행 시간/처리 건수/쿼리/timeout 계측.
  return observeApiRoute("[admin/members/roster GET]", async (obs) => {
    try {
      const data = await listMembersRoster({
        organization,
        mode: parseScopeMode(params.get("mode")),
        page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
        pageSize: Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? pageSizeRaw : 50,
        search,
        filter,
        sort,
      });
      obs.processed = data.members.length;
      return Response.json({ success: true, data });
    } catch (error) {
      console.error("[admin/members/roster GET]", error);
      return Response.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Failed to load roster",
        },
        { status: 500 },
      );
    }
  });
}
