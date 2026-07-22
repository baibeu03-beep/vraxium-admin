import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
  type AdminContext,
} from "@/lib/adminAuth";
import { guardAdminOrgAccess } from "@/lib/adminOrgAccess";
import { isOrganizationSlug } from "@/lib/organizations";
import { readScopeMode } from "@/lib/userScopeShared";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getTeamSelectedWeekSummary } from "@/lib/adminTeamSelectedWeekSummary";
import {
  validateWeekPositionChange,
  POSITION_CODE_VALUES,
  type PositionDraftRow,
} from "@/lib/teamWeekPositionValidation";
import type { PositionCode } from "@/lib/positionHistory";
import {
  invalidateWeeklyCardsForUsers,
  markWeeklyCardsSnapshotStaleMany,
  type WeeklyCardsInvalidationResult,
} from "@/lib/cluster4WeeklyCardsSnapshot";
import { resolveWeekPositionInvalidationOutcome } from "@/lib/weekPositionInvalidationOutcome";

// 팀 상세 [B] — 주차별 파트/클래스 저장(관리자 override, batch).
//   PATCH ?mode=test  body { organization, weekId, rawTeam, changes:[{userId, rawPart, positionCode}] }
//     · cluster4_team_week_position_overrides upsert(conflict = user_id,week_start_date,organization,raw_team).
//     · UPH 원본 무변경 — override 만 생성/갱신. effective = override ?? UPH.
//   서버 검증(우회 방지): 검수 완료 주차 차단(403) · positionCode 화이트리스트 · 팀 전체 next 상태로
//     파트장≤1/파트 · 심화≤정규 · <운용>파트(배정 크루≥1 distinct rawPart, '일반' 포함)≤6
//     (validateWeekPositionRows — 클라이언트 onCellChange 와 동일 순수 함수).
//   2단계(2026-07-22): override 는 이제 **공통 SoT** 다. 저장 직후 변경 크루의 weekly-cards snapshot 을
//     invalidate 해 카드 역할배지/클래스·area-8·이력서 시즌 직책이 같은 값으로 수렴한다
//     (invalidateWeeklyCardsForUsers: stale 마킹 → ≤10명 즉시 재계산 / 초과 시 after 백그라운드).
//     ⚠ 무효화는 best-effort 가 아니라 **보장**이다 — 실패하면 이 라우트가 500 으로 응답한다(아래 참조).
//     파트×주차 존재표·팀 상세 [A]/[B] 는 조회 시 override 를 coalesce 하므로 캐시가 없다(즉시 반영).
export async function PATCH(request: NextRequest) {
  let admin: AdminContext;
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
    return Response.json({ success: false, error: "요청 본문이 올바르지 않습니다." }, { status: 400 });
  }
  const { organization, weekId, rawTeam, changes } = (body ?? {}) as {
    organization?: unknown;
    weekId?: unknown;
    rawTeam?: unknown;
    changes?: unknown;
  };

  if (typeof organization !== "string" || !isOrganizationSlug(organization)) {
    return Response.json({ success: false, error: "유효한 organization 이 필요합니다." }, { status: 400 });
  }
  const denied = await guardAdminOrgAccess(admin, organization);
  if (denied) return denied;
  if (typeof weekId !== "string" || !weekId.trim()) {
    return Response.json({ success: false, error: "weekId 가 필요합니다." }, { status: 400 });
  }
  if (typeof rawTeam !== "string" || !rawTeam.trim()) {
    return Response.json({ success: false, error: "rawTeam 이 필요합니다." }, { status: 400 });
  }
  if (!Array.isArray(changes) || changes.length === 0) {
    return Response.json({ success: false, error: "변경 사항이 없습니다." }, { status: 400 });
  }

  // 변경 파싱 + 값 검증.
  const parsed: PositionDraftRow[] = [];
  for (const c of changes as unknown[]) {
    const { userId, rawPart, positionCode } = (c ?? {}) as {
      userId?: unknown;
      rawPart?: unknown;
      positionCode?: unknown;
    };
    if (typeof userId !== "string" || !userId) {
      return Response.json({ success: false, error: "userId 가 올바르지 않습니다." }, { status: 400 });
    }
    if (typeof positionCode !== "string" || !POSITION_CODE_VALUES.includes(positionCode as PositionCode)) {
      return Response.json(
        { success: false, error: "positionCode 는 정규/심화(에이전트/파트장)만 가능합니다." },
        { status: 400 },
      );
    }
    const part = typeof rawPart === "string" ? rawPart.trim() : "";
    if (!part) {
      return Response.json({ success: false, error: "소속 파트를 선택하세요." }, { status: 400 });
    }
    parsed.push({ userId, rawPart: part, positionCode: positionCode as PositionCode });
  }

  const mode = readScopeMode(request.nextUrl.searchParams);

  try {
    // 현재 effective 상태를 다시 읽어 검증(우회 방지). week meta + crewRows 를 그대로 사용.
    const summary = await getTeamSelectedWeekSummary({
      organization,
      teamName: rawTeam,
      weekId,
      mode,
    });
    if (!summary.week) {
      return Response.json({ success: false, error: "주차를 찾을 수 없습니다." }, { status: 404 });
    }
    if (summary.week.reviewCompleted) {
      return Response.json(
        { success: false, error: "검수가 완료된 주차는 수정할 수 없습니다." },
        { status: 403 },
      );
    }
    // ⚠ getTeamSelectedWeekSummary 는 weekId 가 선택 가능 목록에 없으면 **조용히 현재 주차로 폴백**한다
    //   (읽기 화면에서는 무해한 기본값). 쓰기 경로에서 그대로 두면 "과거 주차를 편집한다고 믿고 보낸
    //   요청이 현재 주차 행을 덮는" 사고가 난다 — 실제로 밟았다(2026-07-22: mode 를 쿼리가 아닌 body 로
    //   보내 scope 가 달라지자 다른 주차에 저장돼 사용자가 저장해 둔 행이 손실). 요청한 주차와 실제
    //   대상 주차가 다르면 저장하지 않고 409 로 알린다.
    if (summary.week.weekId !== weekId) {
      return Response.json(
        {
          success: false,
          error:
            "요청한 주차를 이 조직·모집단에서 편집할 수 없습니다. 주차를 다시 선택해 주세요.",
        },
        { status: 409 },
      );
    }
    const weekStart = summary.week.weekStartDate;

    // prev = 저장 전 effective 상태, next = 변경 적용 상태. 변경 대상은 반드시 현재 팀 crew.
    const prevRows: PositionDraftRow[] = summary.crewRows.map((r) => ({
      userId: r.userId,
      rawPart: r.rawPart,
      positionCode: r.positionCode,
    }));
    const draft = new Map<string, PositionDraftRow>(prevRows.map((r) => [r.userId, r]));
    for (const c of parsed) {
      if (!draft.has(c.userId)) {
        return Response.json(
          { success: false, error: "현재 팀·주차의 크루가 아닌 대상은 수정할 수 없습니다." },
          { status: 400 },
        );
      }
      draft.set(c.userId, c);
    }
    // ⚠ delta 검증(prev→next). whole-state 로 검사하면 팀이 이미 규칙을 어긴 상태에서
    //   파트만 바꾸는 편집까지 막힌다(2026-07-22 버그). 클라이언트 onCellChange 와 동일 함수.
    const verdict = validateWeekPositionChange(prevRows, [...draft.values()]);
    if (!verdict.ok) {
      return Response.json({ success: false, error: verdict.message }, { status: 422 });
    }

    // 변경 행만 override upsert(원본 UPH 무변경).
    const actor = admin.email ?? admin.userId;
    const rows = parsed.map((c) => ({
      user_id: c.userId,
      organization,
      week_id: weekId,
      week_start_date: weekStart,
      raw_team: rawTeam,
      raw_part: c.rawPart,
      position_code: c.positionCode,
      created_by: actor,
      updated_by: actor,
    }));
    const { error } = await supabaseAdmin
      .from("cluster4_team_week_position_overrides")
      .upsert(rows, { onConflict: "user_id,week_start_date,organization,raw_team" });
    if (error) throw new Error(error.message);

    // 변경 크루의 파생 캐시(weekly-cards snapshot) 무효화 — 고객앱/스냅샷 소비 화면 즉시 수렴.
    //
    // ⚠ **best-effort 였던 것을 보장으로 바꿨다(2026-07-22).** 종전에는 예외를 삼키고 항상
    //   success:true 를 돌려줘, 무효화가 실패해도 관리자는 "저장됨"으로 보고 크루앱은 옛
    //   팀/파트/클래스를 계속 노출했다(실측: override updated_at > snapshot computed_at 인데
    //   is_stale=false → 조회 라우트가 fresh 로 판정해 lazy 재계산조차 안 함 → 영구 고착).
    // 정책:
    //   · invalidateWeeklyCardsForUsers 는 먼저 is_stale=true 를 찍고 즉시 재계산한다.
    //   · 재계산 일부 실패(ok=true, recomputeFailed>0) → stale 이 남아 조회 lazy/cron 이 반드시
    //     복구하므로 저장은 성공. 다만 응답에 수치를 담아 "반영 지연 가능"을 알린다.
    //   · **stale 마킹 자체 실패(ok=false)** → 수렴 보장이 깨진다 → 저장 요청을 실패로 응답한다.
    //     override upsert 는 멱등이라 관리자가 그대로 재시도하면 안전하게 복구된다.
    const changedUserIds = parsed.map((c) => c.userId);
    let invalidated: WeeklyCardsInvalidationResult | null = null;
    let invalidateError: string | null = null;
    try {
      invalidated = await invalidateWeeklyCardsForUsers(changedUserIds);
    } catch (e) {
      invalidateError = e instanceof Error ? e.message : String(e);
      console.error("[admin/team-parts/info/team-detail/week-position] snapshot invalidate threw", {
        userIds: changedUserIds,
        message: invalidateError,
      });
      // 마지막 안전망 — 최소한 stale 만이라도 찍어 조회 lazy 가 복구하게 한다.
      try {
        const fallback = await markWeeklyCardsSnapshotStaleMany(changedUserIds);
        if (fallback.failed === 0) {
          invalidated = {
            mode: "stale_only",
            count: changedUserIds.length,
            staleMarked: fallback.requested,
            staleFailed: 0,
            recomputed: 0,
            recomputeFailed: changedUserIds.length,
            failedUserIds: [],
            ok: true,
          };
        }
      } catch (e2) {
        console.error("[admin/team-parts/info/team-detail/week-position] fallback markStale threw", {
          message: e2 instanceof Error ? e2.message : String(e2),
        });
      }
    }

    // 판정 규칙은 lib/weekPositionInvalidationOutcome 로 분리(서버 없이 단위 검증 가능).
    const outcome = resolveWeekPositionInvalidationOutcome(invalidated);
    if (!outcome.ok) {
      // 저장 자체를 실패로 응답 — 관리자가 재시도하도록. (override 행은 이미 기록됐고 upsert 는 멱등)
      console.error("[admin/team-parts/info/team-detail/week-position] invalidation NOT guaranteed", {
        userIds: changedUserIds,
        invalidated,
        invalidateError,
      });
      return Response.json(
        {
          success: false,
          error: outcome.error,
          data: {
            saved: rows.length,
            invalidated,
            invalidateError,
            userIds: changedUserIds,
          },
        },
        { status: outcome.status },
      );
    }

    return Response.json({
      success: true,
      data: { saved: rows.length, invalidated, warning: outcome.warning },
    });
  } catch (error) {
    console.error("[admin/team-parts/info/team-detail/week-position PATCH]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "저장에 실패했습니다." },
      { status: 500 },
    );
  }
}
