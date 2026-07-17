import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { assertUserInRequestScope } from "@/lib/userScope";
import { getCrewWeekLineDetail } from "@/lib/adminCrewWeekLineDetail";
import { saveCrewWeekLineDetail, type SaveLineDetailInput } from "@/lib/adminCrewWeekLineSave";
import type { Cluster4EnhancementStatus } from "@/shared/cluster4.contracts";

type Ctx = { params: Promise<{ user_id: string; week_id: string; line_id: string }> };

// 조회 전용 고정 필드 — 요청 본문에 포함되면 거부(§24/§28). 클럽 공통/평가 원천/회원 데이터.
const FORBIDDEN_KEYS = [
  "mainTitle", "main_title", "lineName", "line_name", "hub", "partType", "part_type",
  "lineCode", "line_code", "practitioner", "companyName", "company_name",
  "supervisorName", "supervisor_name", "member", "memberData",
];
function hasForbidden(obj: unknown): boolean {
  return !!obj && typeof obj === "object" && FORBIDDEN_KEYS.some((k) => k in (obj as Record<string, unknown>));
}
const RESULTS: Cluster4EnhancementStatus[] = ["success", "fail", "not_applicable"];

// GET /api/admin/members/[user_id]/weeks/[week_id]/lines/[line_id]
//   라인 상세 팝업 조회 DTO. 크루 카드 라인 SoT 를 그대로 표현(조회 전용, 재계산 없음).
export async function GET(request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { user_id, week_id, line_id } = await params;

  try {
    await assertUserInRequestScope(request, user_id);
  } catch (error) {
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Scope violation" },
      { status: (error as { status?: number }).status ?? 422 },
    );
  }

  try {
    const result = await getCrewWeekLineDetail(user_id, week_id, line_id);
    if (!result.ok) {
      const message =
        result.reason === "member_not_found"
          ? "Crew not found"
          : result.reason === "week_not_found"
            ? "Week not found for this crew"
            : "Line not found in this week";
      return Response.json({ success: false, error: message }, { status: 404 });
    }
    return Response.json({ success: true, data: result.data });
  } catch (error) {
    console.error("[admin/.../lines/:line_id GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to load line detail" },
      { status: 500 },
    );
  }
}

// PUT /api/admin/members/[user_id]/weeks/[week_id]/lines/[line_id]
//   라인 상세 저장(제출 + 허브별 강화 결과 레버). 고정 필드는 allowlist 로 거부.
export async function PUT(request: NextRequest, { params }: Ctx) {
  let admin;
  try {
    admin = await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { user_id, week_id, line_id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ success: false, error: "Request body must be a JSON object" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  // 고정 필드(메인타이틀·허브·라인명·라인코드·실무자·회원) 변경 요청 거부.
  if (hasForbidden(b) || hasForbidden(b.statusData)) {
    return Response.json(
      { success: false, error: "Main Title·허브·라인명·라인 코드·실무자 정보는 수정할 수 없습니다." },
      { status: 400 },
    );
  }

  const enhancementStatus = b.enhancementStatus;
  if (typeof enhancementStatus !== "string" || !RESULTS.includes(enhancementStatus as Cluster4EnhancementStatus)) {
    return Response.json({ success: false, error: "enhancementStatus is invalid" }, { status: 400 });
  }
  const sd = b.statusData;
  if (!sd || typeof sd !== "object" || Array.isArray(sd)) {
    return Response.json({ success: false, error: "statusData is required" }, { status: 400 });
  }
  const s = sd as Record<string, unknown>;
  const rawLinks = Array.isArray(s.outputLinks) ? s.outputLinks : [];
  const outputLinks = rawLinks
    .filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
    .map((l) => ({
      url: typeof l.url === "string" ? l.url : "",
      label: typeof l.label === "string" ? l.label : null,
    }));
  const images = Array.isArray(s.images)
    ? s.images
        .filter((im): im is Record<string, unknown> => !!im && typeof im === "object")
        .map((im) => ({
          url: typeof im.url === "string" ? im.url : "",
          caption: typeof im.caption === "string" ? im.caption : null,
        }))
    : undefined;

  const input: SaveLineDetailInput = {
    enhancementStatus: enhancementStatus as Cluster4EnhancementStatus,
    // 실무 역량 라인명 변경(마스터 repoint) — identity 만 갱신, 나머지 필드는 보존(서버가 허브/상태 게이트).
    //   line_name/line_code 등 고정 필드가 아니라 마스터 id 이므로 FORBIDDEN_KEYS 대상이 아니다.
    competencyMasterId: typeof b.competencyMasterId === "string" ? b.competencyMasterId : null,
    statusData: {
      subTitle: typeof s.subTitle === "string" ? s.subTitle : null,
      growthPoint: typeof s.growthPoint === "string" ? s.growthPoint : null,
      outputLinks,
      images,
      rating: typeof s.rating === "number" ? s.rating : null,
      grade: typeof s.grade === "string" ? (s.grade as SaveLineDetailInput["statusData"]["grade"]) : null,
    },
  };

  try {
    await assertUserInRequestScope(request, user_id, { bodyMode: b.mode });
  } catch (error) {
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Scope violation" },
      { status: (error as { status?: number }).status ?? 422 },
    );
  }

  try {
    const confirmGrowthFlip = b.confirmGrowthFlip === true;
    const result = await saveCrewWeekLineDetail(user_id, week_id, line_id, input, admin.userId, confirmGrowthFlip);
    if (!result.ok) {
      return Response.json(
        { success: false, error: result.error, growth: result.growth },
        { status: result.code },
      );
    }
    return Response.json({ success: true, data: result.data });
  } catch (error) {
    console.error("[admin/.../lines/:line_id PUT]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to save line detail" },
      { status: 500 },
    );
  }
}
