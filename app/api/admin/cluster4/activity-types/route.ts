import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";
import { listInfoLineCatalog } from "@/lib/adminInfoLineCatalog";

const VALID_CLUSTERS = [
  "practical_info",
  "practical_competency",
  "practical_experience",
  "practical_career",
] as const;

type ActivityTypeRow = {
  id: string;
  name: string;
  line_code: string | null;
  description: string | null;
  is_active: boolean;
};

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const cluster = request.nextUrl.searchParams.get("cluster")?.trim();

  if (!cluster || !(VALID_CLUSTERS as readonly string[]).includes(cluster)) {
    return Response.json(
      {
        success: false,
        error: `cluster must be one of ${VALID_CLUSTERS.join("|")}`,
      },
      { status: 400 },
    );
  }

  try {
    // ── 실무 정보: 라인 유니버스 = listInfoLineCatalog(org) 단일 SoT ──────────────
    //   **항상 고정 9종**이다(등록으로 늘지 않는다 — 2026-07-22 제품 계약). 이 함수를 쓰는 이유는
    //   개수가 아니라 정합이다: 표시 순서·등록 원장(라인명/코드) 조인·org 우선순위를
    //   team-parts/info/weeks 와 **동일 함수**에서 얻어 두 화면이 갈라지지 않게 한다.
    //   (프론트에서 배열을 합치지 않는다 — 서버가 완성된 DTO 를 돌려준다.)
    const organizationRaw = request.nextUrl.searchParams.get("organization")?.trim() || null;
    const organization: OrganizationSlug | null = isOrganizationSlug(organizationRaw)
      ? organizationRaw
      : null;
    let types: ActivityTypeRow[];
    const infoCatalog =
      cluster === "practical_info" ? await listInfoLineCatalog(organization) : null;

    if (infoCatalog) {
      types = infoCatalog.map((l) => ({
        id: l.lineId,
        name: l.lineName,
        line_code: l.lineCode,
        description: null,
        is_active: true,
      }));
    } else {
      const { data, error } = await supabaseAdmin
        .from("activity_types")
        .select("id,name,line_code,description,is_active")
        .eq("cluster_id", cluster)
        .eq("is_active", true)
        .order("id", { ascending: true });

      if (error) {
        return Response.json(
          { success: false, error: error.message },
          { status: 500 },
        );
      }
      types = (data ?? []) as ActivityTypeRow[];
    }

    // Check which activity_type_ids already have an active line
    const typeIds = ((types ?? []) as ActivityTypeRow[]).map((t) => t.id);
    let activeLineTypeIds = new Set<string>();

    if (typeIds.length > 0) {
      const { data: activeLines } = await supabaseAdmin
        .from("cluster4_lines")
        .select("activity_type_id")
        .eq("is_active", true)
        .in("activity_type_id", typeIds);

      if (activeLines) {
        activeLineTypeIds = new Set(
          (activeLines as Array<{ activity_type_id: string | null }>)
            .map((l) => l.activity_type_id)
            .filter((id): id is string => id != null),
        );
      }
    }

    // registeredLine* — 등록 원장(line_registrations, hub='info')이 이 활동유형에 부여한 정식
    //   라인명/코드. 표시명(name)은 activity_types 정본 그대로 두고 이 값은 툴팁으로만 쓴다
    //   (정본 라벨을 원장 값으로 덮지 않는다 — 고객 앱 하드코딩 라벨/과거 FK 보호).
    //   등록 원장이 없는 활동유형은 null → 기존 표시 그대로.
    const registeredByActivity = new Map<string, { lineName: string; lineCode: string | null }>();
    for (const entry of infoCatalog ?? []) {
      if (!entry.registrationId || !entry.registeredLineName) continue;
      registeredByActivity.set(entry.activityTypeId, {
        lineName: entry.registeredLineName,
        lineCode: entry.registeredLineCode,
      });
    }

    const result = ((types ?? []) as ActivityTypeRow[]).map((t) => {
      const reg = registeredByActivity.get(t.id) ?? null;
      return {
        id: t.id,
        name: t.name,
        lineCode: t.line_code,
        description: t.description,
        isActive: Boolean(t.is_active),
        hasActiveLine: activeLineTypeIds.has(t.id),
        // 등록 원장(line_registrations)이 부여한 정식 라인명/코드. 미등록이면 null.
        registeredLineName: reg?.lineName ?? null,
        registeredLineCode: reg?.lineCode ?? null,
      };
    });

    return Response.json({ success: true, data: result });
  } catch (error) {
    console.error("[admin/cluster4/activity-types GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to list activity types",
      },
      { status: 500 },
    );
  }
}
