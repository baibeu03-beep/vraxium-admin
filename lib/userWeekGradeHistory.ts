import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { computeAsOfClubRankGradeBatch } from "@/lib/cluster3ClubRankData";

// ─────────────────────────────────────────────────────────────────────
// 주차별 **확정 품계 이력**(user_week_grade_histories) 공용 SoT — 계산/쓰기/읽기 집약.
//   · 현재 품계(user_grade_stats + getClubRank*)와 **역할 분리** — 이 모듈은 "N주차 당시 확정 품계".
//   · 쓰기 = runWeeklyCardFinalization(주차 검수/공표 확정) + backfill 스크립트 공용.
//   · 읽기 = 관리자 팀 상세 [B] · (향후) 크루 /weekly-ranking 공용(같은 loadWeekGradeHistory 재사용).
//   · 값 산식은 cluster3ClubRankData(computeAsOfClubRankGradeBatch) 재사용 — math fork 금지.
// ─────────────────────────────────────────────────────────────────────

const TABLE = "user_week_grade_histories";

export type WeekGradeHistoryEntry = {
  grade: number | null;
  gradeLabel: string | null;
  avgPercentile: number | null;
};

export type UpsertWeekGradesResult = {
  ok: boolean;
  skipped?: "missing_table";
  attempted: number;
  written: number;
  error?: string;
};

// 테이블 미적용(수동 마이그레이션 전) 감지 — 조회/쓰기 모두 이 케이스는 양성 스킵.
function isMissingTableError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  const code = err.code ?? "";
  const message = err.message ?? "";
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    /schema cache|could not find the table|does not exist/i.test(message)
  );
}

// 조회 — (userIds × weekStartDate) 확정 품계. 테이블 부재/에러 → 빈 맵(그레이스풀, 화면은 '-').
//   ⚠ 검수 완료 게이트는 **호출부**가 담당한다(reviewCompleted=false 면 애초에 호출하지 않음).
export async function loadWeekGradeHistory(params: {
  userIds: string[];
  weekStartDate: string;
}): Promise<Map<string, WeekGradeHistoryEntry>> {
  const out = new Map<string, WeekGradeHistoryEntry>();
  const ids = Array.from(new Set(params.userIds.filter(Boolean)));
  if (ids.length === 0 || !params.weekStartDate) return out;

  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .select("user_id,grade,grade_label,avg_percentile")
      .eq("week_start_date", params.weekStartDate)
      .in("user_id", chunk);
    if (error) {
      if (isMissingTableError(error)) return out;
      throw new Error(error.message);
    }
    for (const r of (data ?? []) as Array<{
      user_id: string;
      grade: number | null;
      grade_label: string | null;
      avg_percentile: number | string | null;
    }>) {
      out.set(r.user_id, {
        grade: r.grade ?? null,
        gradeLabel: r.grade_label ?? null,
        avgPercentile: r.avg_percentile == null ? null : Number(r.avg_percentile),
      });
    }
  }
  return out;
}

async function loadOrgByIds(userIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (let i = 0; i < userIds.length; i += 200) {
    const chunk = userIds.slice(i, i + 200);
    const { data } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,organization_slug")
      .in("user_id", chunk);
    for (const r of (data ?? []) as Array<{ user_id: string; organization_slug: string | null }>) {
      out.set(r.user_id, r.organization_slug ?? null);
    }
  }
  return out;
}

async function upsertRows(rows: Record<string, unknown>[]): Promise<{ code?: string; message: string } | null> {
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabaseAdmin
      .from(TABLE)
      .upsert(rows.slice(i, i + 200), { onConflict: "user_id,week_start_date" });
    if (error) return error;
  }
  return null;
}

// 계산 + upsert — finalize·backfill 공용. 코호트 전원에 대해 as-of 품계를 산출해 (user, week) UPSERT.
//   · grade 산출 불가(모집단 제외/이력 부재)여도 **null 행을 기록**한다 — "이 주차는 확정됐다"는 사실을
//     남겨 gap(확정됐으나 이력 없음)과 구분한다.
//   · 실패 시 소규모 재시도. 테이블 부재는 양성 스킵(수동 마이그레이션 전). 그 외 실패는 ok:false 로
//     **호출부에 노출**(무음 스왑 금지) — finalize 는 이를 결과에 실어 보내고, recompute/ backfill 이 보정.
export async function computeAndUpsertWeekGrades(params: {
  cohortUserIds: string[];
  week: { startDate: string; seasonKey: string | null; weekNumber: number };
  scope: "operating" | "qa";
  source: "finalize" | "backfill";
  finalizedAt?: string | null;
  actor?: string | null;
  retries?: number;
}): Promise<UpsertWeekGradesResult> {
  const { cohortUserIds, week, scope, source, finalizedAt = null, actor = null } = params;
  const ids = Array.from(new Set(cohortUserIds.filter(Boolean)));
  if (ids.length === 0) return { ok: true, attempted: 0, written: 0 };

  const [grades, orgById] = await Promise.all([
    computeAsOfClubRankGradeBatch({
      userIds: ids,
      asOfWeekStartDate: week.startDate,
      asOfSeasonKey: week.seasonKey,
    }),
    loadOrgByIds(ids),
  ]);

  const rows = ids.map((uid) => {
    const g = grades.get(uid) ?? null;
    return {
      user_id: uid,
      week_start_date: week.startDate,
      season_key: week.seasonKey ?? "",
      week_number: week.weekNumber,
      avg_percentile: g?.avgPercentile ?? null,
      grade: g?.grade ?? null,
      grade_label: g?.label ?? null,
      scope,
      organization_slug: orgById.get(uid) ?? null,
      source,
      finalized_at: finalizedAt,
      created_by: actor,
      updated_by: actor,
    };
  });

  const retries = params.retries ?? 2;
  let lastErr = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const err = await upsertRows(rows);
    if (!err) return { ok: true, attempted: ids.length, written: rows.length };
    if (isMissingTableError(err)) return { ok: true, skipped: "missing_table", attempted: ids.length, written: 0 };
    lastErr = err.message;
  }
  return { ok: false, attempted: ids.length, written: 0, error: lastErr };
}
