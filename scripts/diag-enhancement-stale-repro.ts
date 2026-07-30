// 진단 전용(read-only) — 마감(수 22:00 KST) 후에도 enhancementStatus 가 pending 인 채로
// 남아있는 실사용자 케이스를 찾아 원인을 추적한다. DB/계산/스냅샷 상태만 조회, 쓰기 없음.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { readWeeklyCardsSnapshot, WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";
import { computeCluster4Enhancement } from "@/lib/cluster4Enhancement";
import { canEditCluster4Line } from "@/lib/cluster4LinePermission";

async function main() {
  const nowIso = new Date().toISOString();
  console.log("[now]", nowIso, "dto_version(code)=", WEEKLY_CARDS_DTO_VERSION);

  // 1) "최근" 마감이 지난 experience 라인 타깃을 찾는다(대상자 존재 + 라인 활성 + 마감 과거 + 최근 30일 이내).
  //   최근 것을 봐야 snapshot 이 "마감 전에 구워지고 이후 아무 write 도 없어 stale 로 남는" 케이스를 잡는다.
  const sinceIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: targets, error } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select(
      "id,line_id,week_id,target_mode,target_user_id,cluster4_lines!inner(id,part_type,is_active,submission_closes_at,submission_opens_at)",
    )
    .eq("target_mode", "user")
    .eq("cluster4_lines.is_active", true)
    .eq("cluster4_lines.part_type", "experience")
    .lte("cluster4_lines.submission_closes_at", nowIso)
    .gte("cluster4_lines.submission_closes_at", sinceIso)
    .order("cluster4_lines(submission_closes_at)", { ascending: false })
    .limit(500);

  if (error) {
    console.error("query error", error.message);
    return;
  }
  console.log("[candidates found]", targets?.length ?? 0);

  type Row = {
    id: string;
    line_id: string;
    week_id: string;
    target_user_id: string;
    cluster4_lines: { id: string; part_type: string; is_active: boolean; submission_closes_at: string; submission_opens_at: string };
  };
  const rows = (targets ?? []) as unknown as Row[];

  let checked = 0;
  for (const row of rows) {
    if (checked >= 8) break;
    const userId = row.target_user_id;
    if (!userId) continue;
    checked++;

    const snap = await readWeeklyCardsSnapshot(userId);
    console.log("\n=================================================");
    console.log("[target]", { userId, lineId: row.line_id, weekId: row.week_id, closesAt: row.cluster4_lines.submission_closes_at });
    console.log("[snapshot outcome]", snap.status, (snap as { reason?: string }).reason ?? "", "computedAt=", (snap as { computedAt?: string }).computedAt ?? "");

    if (snap.status !== "hit" && snap.status !== "stale") continue;
    const card = snap.cards.find((c) => c.weekId === row.week_id);
    if (!card) {
      console.log("[card] not found for weekId in snapshot");
      continue;
    }
    const line = card.lines.find((l: { lineTargetId?: string | null }) => l.lineTargetId === row.id);
    if (!line) {
      console.log("[line] not found in card.lines for lineTargetId", row.id);
      continue;
    }
    console.log("[stored line]", {
      enhancementStatus: line.enhancementStatus,
      enhancementReason: line.enhancementReason,
      submissionStatus: line.submissionStatus,
      submissionClosesAt: line.submissionClosesAt,
      experienceRating: line.experienceRating,
      canEdit: (line as { canEdit?: boolean }).canEdit,
    });

    // 실제 저장 API 가 쓰는 것과 동일한 live 게이트(canEditCluster4Line) — now=현재 시각.
    const liveGate = canEditCluster4Line(
      {
        target_mode: row.target_mode,
        target_user_id: row.target_user_id,
        line: {
          is_active: row.cluster4_lines.is_active,
          submission_opens_at: row.cluster4_lines.submission_opens_at,
          submission_closes_at: row.cluster4_lines.submission_closes_at,
        },
      },
      userId,
    );
    console.log("[live write-gate canEditCluster4Line]", liveGate);

    // deadlinePassed 실제 계산(라인 컬럼 기준, live)
    const deadlinePassed = new Date(row.cluster4_lines.submission_closes_at).getTime() < Date.now();

    // rating 조회(live) — experience_line_evaluations
    const { data: evalRow } = await supabaseAdmin
      .from("cluster4_experience_line_evaluations")
      .select("rating,evaluated_by")
      .eq("line_target_id", row.id)
      .eq("user_id", userId)
      .maybeSingle();
    const rating = (evalRow as { rating?: number } | null)?.rating ?? null;
    const evaluatedBy = (evalRow as { evaluated_by?: string | null } | null)?.evaluated_by ?? null;
    let verdict: "fail" | "pass" | "unevaluated" | null = null;
    if (rating != null) {
      if (rating <= 3 && evaluatedBy) verdict = "fail";
      else if (rating >= 4) verdict = "pass";
      else verdict = "unevaluated";
    }

    const { data: submissionRow } = await supabaseAdmin
      .from("cluster4_line_submissions")
      .select("id")
      .eq("line_target_id", row.id)
      .eq("user_id", userId)
      .maybeSingle();

    const live = computeCluster4Enhancement({
      hasTarget: true,
      deadlinePassed,
      hasSubmission: !!submissionRow,
      isCareer: false,
      experienceRatingVerdict: verdict,
    });
    console.log("[live recompute]", { deadlinePassed, rating, evaluatedBy, verdict, hasSubmission: !!submissionRow, ...live });

    // override 확인
    const { data: overrideRow } = await supabaseAdmin
      .from("cluster4_line_enhancement_overrides")
      .select("override_status,source,note")
      .eq("user_id", userId)
      .eq("week_id", row.week_id)
      .eq("line_id", row.line_id)
      .maybeSingle()
      .then((r) => r, () => ({ data: null }));
    console.log("[override row]", overrideRow ?? "(none/table missing)");

    if (line.enhancementStatus !== live.enhancementStatus) {
      console.log("*** MISMATCH: stored != live recompute ***");
    }
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
