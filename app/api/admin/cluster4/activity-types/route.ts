import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isOrganizationSlug } from "@/lib/organizations";
import { loadInfoLineCatalog } from "@/lib/adminLineHistoryType";

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
    const { data: types, error } = await supabaseAdmin
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

    // ── 실무 정보: 라인 등록(line_registrations) 메타 병합 ────────────────────────
    //   정보 허브의 "개설 단위"는 activity_types(고정 9종)이고, /admin/lines/register 의
    //   info 등록은 그 활동유형에 **정식 라인명/라인코드를 부여하는 메타**다
    //   (line_registrations.point_activity_type_id → activity_types.id 로 1:1 연결).
    //   따라서 등록 결과를 개설 화면에 반영하는 올바른 방법은 "새 개설 후보 생성"이 아니라
    //   활동유형 DTO 에 등록된 라인명/코드를 실어 보내는 것이다.
    //   · SoT = loadInfoLineCatalog(org) — 라인 내역 화면이 쓰는 것과 동일 함수(중복 조회 금지).
    //   · 프론트에서 배열을 합치지 않는다 — 서버가 완성된 DTO 를 돌려준다.
    //   · registeredLine* 는 additive optional — 미등록 활동유형은 null(기존 표시 유지).
    const registeredByActivity = new Map<string, { lineName: string; lineCode: string | null }>();
    if (cluster === "practical_info") {
      const organization = request.nextUrl.searchParams.get("organization")?.trim() || null;
      for (const entry of await loadInfoLineCatalog(
        isOrganizationSlug(organization) ? organization : null,
      )) {
        registeredByActivity.set(entry.activityTypeId, {
          lineName: entry.lineName,
          lineCode: entry.displayLineCode,
        });
      }
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
