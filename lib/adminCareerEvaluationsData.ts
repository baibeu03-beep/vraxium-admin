// 실무 경력(career) 평가 데이터 레이어 (admin, service-role).
//
// 책임:
//   - career 라인 대상자(line_target)별 평점(grade S~D)을 cluster4_career_line_evaluations 에
//     upsert / 조회한다. grade_points 는 lib/careerGrade 의 단일 변환으로 파생한다.
//   - 운영자 평가는 작성기간(submission_closes_at)과 무관하다 — 지난 주차도 입력/수정 가능(D4).
//     (사용자 제출 마감과는 별개. 여기서는 window 를 검사하지 않는다.)
//
// 비범위: user_week_statuses sync, category/slot. career_records(legacy)는 건드리지 않는다.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveUserScope, type ScopeMode } from "@/lib/userScope";
import { isUuid } from "@/lib/isUuid";
import {
  type CareerGrade,
  careerRatingStatusFromGrade,
  gradeToPoints,
  isCareerGrade,
} from "@/lib/careerGrade";
import type {
  CareerEvaluationDto,
  CareerEvaluationTargetDto,
  UpsertCareerEvaluationInput,
} from "@/lib/adminCareerEvaluationsTypes";
import { refreshWeeklyCardsSnapshotSafe } from "@/lib/cluster4WeeklyCardsSnapshot";

export class CareerEvaluationError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "CareerEvaluationError";
    this.status = status;
  }
}

type EvaluationRow = {
  id: string;
  line_target_id: string;
  user_id: string;
  grade: CareerGrade;
  grade_points: number;
  evaluated_by: string | null;
  evaluated_at: string | null;
  updated_at: string;
};

function toEvaluationDto(row: EvaluationRow): CareerEvaluationDto {
  return {
    id: row.id,
    lineTargetId: row.line_target_id,
    userId: row.user_id,
    grade: row.grade,
    gradePoints: row.grade_points,
    evaluatedBy: row.evaluated_by,
    evaluatedAt: row.evaluated_at,
    updatedAt: row.updated_at,
  };
}

// upsert 대상 target 이 (a) career 라인이고 (b) user-mode 이며 (c) 평가 대상 user 와 일치하는지 검증.
async function assertCareerTargetOwnsUser(
  lineTargetId: string,
  userId: string,
): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("id,target_mode,target_user_id,cluster4_lines!inner(part_type)")
    .eq("id", lineTargetId)
    .maybeSingle();
  if (error) throw new CareerEvaluationError(500, error.message);
  if (!data) throw new CareerEvaluationError(404, "Line target not found.");

  const row = data as unknown as {
    target_mode: "user" | "rule";
    target_user_id: string | null;
    cluster4_lines: { part_type: string } | null;
  };
  if (row.cluster4_lines?.part_type !== "career") {
    throw new CareerEvaluationError(400, "평가는 실무 경력(career) 라인에만 입력할 수 있습니다.");
  }
  if (row.target_mode !== "user") {
    throw new CareerEvaluationError(400, "user-mode 대상자만 평가할 수 있습니다.");
  }
  if (row.target_user_id !== userId) {
    throw new CareerEvaluationError(400, "해당 라인 대상자가 아닌 사용자입니다.");
  }
}

// (line_target_id, user_id) 기준 upsert. 기존 row 가 있으면 grade/points/평가자/평가시각을 갱신.
// onConflict 대신 lookup→update-or-insert 로 명시 처리한다(어드민 제출 upsert 와 동일 패턴).
export async function upsertCareerEvaluation(
  input: UpsertCareerEvaluationInput,
  evaluatedBy: string,
  evaluatedAtIso: string,
): Promise<CareerEvaluationDto> {
  if (!isUuid(input.lineTargetId)) {
    throw new CareerEvaluationError(400, "lineTargetId must be a UUID");
  }
  if (!isUuid(input.userId)) {
    throw new CareerEvaluationError(400, "userId must be a UUID");
  }
  if (!isCareerGrade(input.grade)) {
    throw new CareerEvaluationError(400, "grade must be one of S/A/B/C/D");
  }

  await assertCareerTargetOwnsUser(input.lineTargetId, input.userId);

  const gradePoints = gradeToPoints(input.grade);

  const { data: existing, error: lookupError } = await supabaseAdmin
    .from("cluster4_career_line_evaluations")
    .select("id")
    .eq("line_target_id", input.lineTargetId)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (lookupError) throw new CareerEvaluationError(500, lookupError.message);

  if (existing) {
    const { data, error } = await supabaseAdmin
      .from("cluster4_career_line_evaluations")
      .update({
        grade: input.grade,
        grade_points: gradePoints,
        evaluated_by: evaluatedBy,
        evaluated_at: evaluatedAtIso,
      })
      .eq("id", (existing as { id: string }).id)
      .select("id,line_target_id,user_id,grade,grade_points,evaluated_by,evaluated_at,updated_at")
      .single();
    if (error || !data) {
      throw new CareerEvaluationError(500, error?.message ?? "평가 수정 실패");
    }
    // 평점 변경은 그 사용자 career 카드에 즉시 반영되어야 함 → 단건 즉시 재계산(best-effort).
    await refreshWeeklyCardsSnapshotSafe(input.userId);
    return toEvaluationDto(data as EvaluationRow);
  }

  const { data, error } = await supabaseAdmin
    .from("cluster4_career_line_evaluations")
    .insert({
      line_target_id: input.lineTargetId,
      user_id: input.userId,
      grade: input.grade,
      grade_points: gradePoints,
      evaluated_by: evaluatedBy,
      evaluated_at: evaluatedAtIso,
    })
    .select("id,line_target_id,user_id,grade,grade_points,evaluated_by,evaluated_at,updated_at")
    .single();
  if (error || !data) {
    throw new CareerEvaluationError(500, error?.message ?? "평가 생성 실패");
  }
  await refreshWeeklyCardsSnapshotSafe(input.userId);
  return toEvaluationDto(data as EvaluationRow);
}

// 평가 탭 로드용: career 라인의 user-mode 대상자 목록 + 현재 평점.
export async function listCareerEvaluationTargetsForLine(
  lineId: string,
  mode: ScopeMode = "operating",
): Promise<CareerEvaluationTargetDto[]> {
  if (!isUuid(lineId)) {
    throw new CareerEvaluationError(400, "lineId must be a UUID");
  }

  // 라인이 career 인지 확인.
  const { data: lineRow, error: lineErr } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id,part_type")
    .eq("id", lineId)
    .maybeSingle();
  if (lineErr) throw new CareerEvaluationError(500, lineErr.message);
  if (!lineRow) throw new CareerEvaluationError(404, "Line not found.");
  if ((lineRow as { part_type: string }).part_type !== "career") {
    throw new CareerEvaluationError(400, "실무 경력(career) 라인이 아닙니다.");
  }

  const { data: targets, error: targetErr } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("id,week_id,target_user_id")
    .eq("line_id", lineId)
    .eq("target_mode", "user")
    .order("created_at", { ascending: true });
  if (targetErr) throw new CareerEvaluationError(500, targetErr.message);

  const targetRows = (targets ?? []) as {
    id: string;
    week_id: string;
    target_user_id: string | null;
  }[];
  const userTargets = targetRows.filter(
    (t): t is { id: string; week_id: string; target_user_id: string } =>
      Boolean(t.target_user_id),
  );
  if (userTargets.length === 0) return [];

  const targetIds = userTargets.map((t) => t.id);
  const userIds = Array.from(new Set(userTargets.map((t) => t.target_user_id)));

  // 현재 평점 (line_target_id 기준).
  const { data: evals, error: evalErr } = await supabaseAdmin
    .from("cluster4_career_line_evaluations")
    .select("line_target_id,user_id,grade,grade_points")
    .in("line_target_id", targetIds);
  if (evalErr) throw new CareerEvaluationError(500, evalErr.message);
  const evalByKey = new Map<string, { grade: CareerGrade; points: number }>();
  for (const e of (evals ?? []) as {
    line_target_id: string;
    user_id: string;
    grade: CareerGrade;
    grade_points: number;
  }[]) {
    evalByKey.set(`${e.line_target_id}:${e.user_id}`, {
      grade: e.grade,
      points: e.grade_points,
    });
  }

  // 사용자 표시명.
  const { data: profiles, error: profErr } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name")
    .in("user_id", userIds);
  if (profErr) throw new CareerEvaluationError(500, profErr.message);
  const nameByUser = new Map<string, string | null>();
  for (const p of (profiles ?? []) as {
    user_id: string;
    display_name: string | null;
  }[]) {
    nameByUser.set(p.user_id, p.display_name ?? null);
  }

  const scope = await resolveUserScope(mode, null);
  return userTargets.filter((t) => scope.includes(t.target_user_id)).map((t) => {
    const ev = evalByKey.get(`${t.id}:${t.target_user_id}`) ?? null;
    const grade = ev?.grade ?? null;
    return {
      lineTargetId: t.id,
      weekId: t.week_id,
      userId: t.target_user_id,
      displayName: nameByUser.get(t.target_user_id) ?? null,
      grade,
      gradePoints: ev?.points ?? null,
      ratingStatus: careerRatingStatusFromGrade(grade),
    };
  });
}
