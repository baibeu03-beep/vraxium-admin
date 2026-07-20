import { NextRequest } from "next/server";
import { ADMIN_WRITE_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { assertUserInRequestScope } from "@/lib/userScope";
import { resolveCrewWeekCard } from "@/lib/adminCrewWeekDetail";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { earlyCloseClosesAt } from "@/lib/cluster4LineSubmissionWindow";
import { finalizeLineResultAwards } from "@/lib/lineResultAwardReconcile";
import { insertOpeningLogForLine } from "@/lib/adminCluster4OpeningLogs";
import { formatLogDateTime } from "@/lib/practicalInfoSection0Format";

type Ctx = { params: Promise<{ user_id: string; week_id: string; line_id: string }> };

// POST /api/admin/members/[user_id]/weeks/[week_id]/lines/[line_id]/close
//   "2차 기입 마감"(force-close) — 지정 라인의 submission_closes_at 을 현재 시각으로 **단축**한다.
//   이 한 값이 크루 수정창 + 강화 deadlinePassed + snapshot + payout 을 동시에 게이트하므로,
//   마감 즉시 그 라인의 대상자는 강화 최종 판정(info/competency=성공, experience/career=평점 게이트)으로
//   전환되고, 성공 대상자만 포인트가 지급된다.
//
//   정책(2026-07-20):
//     · 조기 마감만 허용 — 현재 시각이 기존 마감보다 이를 때만 now 로 단축. 이미 마감된 라인은 멱등 성공
//       (값 불변). 마감을 뒤로 연장하는 동작은 없음.
//     · 라인 단위 — 대상 line_id 만 갱신(그 라인의 모든 대상자 즉시 마감). 다른 라인/허브 무접촉.
//     · 확정 주차 게이트 없음 — 2차 기입 마감은 진행 중(48h 창 내)에 실행하는 동작이다(second-entry
//       override 와 반대: override 는 확정 후에만, 마감은 확정 전 진행 중에).
//     · allowed=false(force-open 회수)와 **별도 action** — 혼동 금지.
//     · 감사 — 라인 개설 로그(append-only)에 action='close' + note(기존→변경 마감) 기록.
export async function POST(request: NextRequest, { params }: Ctx) {
  let admin;
  try {
    admin = await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { user_id, week_id, line_id } = await params;

  // body 는 선택(스코프 모드 전달용). 없어도 동작.
  let bodyMode: unknown = undefined;
  try {
    const raw = await request.json();
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      bodyMode = (raw as Record<string, unknown>).mode;
    }
  } catch {
    // body 없음 — 무시.
  }

  try {
    await assertUserInRequestScope(request, user_id, { bodyMode });
  } catch (error) {
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Scope violation" },
      { status: (error as { status?: number }).status ?? 422 },
    );
  }

  try {
    // 1) 소유 검증 — 이 크루·주차 카드에 그 line_id 가 오픈되어 있어야 한다(URL 조작 차단).
    const resolved = await resolveCrewWeekCard(user_id, week_id);
    if (!resolved.ok) {
      const message =
        resolved.reason === "member_not_found" ? "Crew not found" : "Week not found for this crew";
      return Response.json({ success: false, error: message }, { status: 404 });
    }
    const { card } = resolved;
    const cardLine = card.lines.find((l) => l.lineId != null && l.lineId === line_id);
    if (!cardLine) {
      return Response.json(
        { success: false, error: "오픈된 라인이 아니므로 2차 기입을 마감할 수 없습니다." },
        { status: 422 },
      );
    }

    // 2) 라인 로드 — 현재 마감 시각/활성/활동유형.
    const { data: lineData, error: lineErr } = await supabaseAdmin
      .from("cluster4_lines")
      .select("id,is_active,submission_closes_at,activity_type_id")
      .eq("id", line_id)
      .maybeSingle();
    if (lineErr) {
      return Response.json({ success: false, error: lineErr.message }, { status: 500 });
    }
    const line = lineData as {
      id: string;
      is_active: boolean;
      submission_closes_at: string | null;
      activity_type_id: string | null;
    } | null;
    if (!line || line.is_active === false) {
      return Response.json(
        { success: false, error: "마감할 활성 라인이 없습니다." },
        { status: 404 },
      );
    }

    const prevClosesAt = line.submission_closes_at;
    const nowMs = Date.now();
    const { closesAt: newClosesAt, changed } = earlyCloseClosesAt(prevClosesAt, nowMs);

    // 3) 조기 마감만 갱신. 이미 마감(changed=false)이면 값 불변 — 멱등 성공으로 계속 진행(원장 정합만 재수행).
    if (changed) {
      const { error: updErr } = await supabaseAdmin
        .from("cluster4_lines")
        .update({ submission_closes_at: newClosesAt, updated_by: admin.userId })
        .eq("id", line_id)
        .eq("is_active", true);
      if (updErr) {
        return Response.json({ success: false, error: updErr.message }, { status: 500 });
      }

      // 감사 — force-close 이벤트(기존 마감 → 변경 마감). best-effort.
      await insertOpeningLogForLine({
        action: "close",
        lineId: line_id,
        weekId: week_id,
        activityTypeId: line.activity_type_id,
        changedBy: admin.userId,
        note: `기존 마감 ${prevClosesAt ? formatLogDateTime(prevClosesAt) : "미상"} → 변경 마감 ${formatLogDateTime(newClosesAt)}`,
      });
    }

    // 4) 마감 직후 강화 결과 확정 + 성공 대상자 지급 정합(대상자 snapshot 재계산 → 원장 reconcile).
    //    자동 48h 스윕과 겹쳐도 upsert 멱등으로 중복 지급 없음. experience/career 는 평점 게이트 유지.
    const reconcile = await finalizeLineResultAwards({ lineId: line_id, actor: admin.userId });

    return Response.json({
      success: true,
      data: {
        lineId: line_id,
        closed: true,
        changed,
        prevClosesAt,
        newClosesAt,
        reconcile,
      },
    });
  } catch (error) {
    console.error("[admin/.../lines/:line_id/close POST]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to close line submission",
      },
      { status: 500 },
    );
  }
}
