/**
 * READ-ONLY 진단: 이력서 "실무 경험 축적"(practicalStats.experienceCount) SoT 추적.
 *   1) direct getCluster1Resume().practicalStats
 *   2) raw: uws 주차별 status + weeks.result_published_at(공표) — "공표 완료 성공 주차 수"
 *   3) experience 라인 타깃 전수(레거시 통합 라인 포함) + 평점(rating) — 마감/평점별 분해
 *   4) weekly-cards 측 experienceSuccessMap(rating<=3 제외) 합 — 허브 기준값
 * 사용: npx tsx --env-file=.env.local scripts/diag-resume-exp-count.ts <userId...>
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  const ids = process.argv.slice(2);
  if (ids.length === 0) {
    console.error("usage: diag-resume-exp-count.ts <userId...>");
    process.exit(1);
  }
  const { getCluster1Resume } = await import("../lib/cluster1ResumeData");
  const { fetchWeeklyCardLineAggregates } = await import("../lib/lineAvailability");

  for (const uid of ids) {
    console.log(`\n══════ user ${uid} ══════`);

    // 1) direct DTO
    const dto = await getCluster1Resume(uid);
    console.log("[1. direct getCluster1Resume.practicalStats]", JSON.stringify(dto?.practicalStats));

    // 2) raw uws + 공표
    const { data: uws } = await sb
      .from("user_week_statuses")
      .select("week_start_date,season_key,week_number,status")
      .eq("user_id", uid)
      .order("week_start_date");
    const starts = (uws ?? []).map((w: any) => w.week_start_date);
    const { data: weeks } = await sb
      .from("weeks")
      .select("id,start_date,result_published_at,is_official_rest")
      .in("start_date", starts.length ? starts : ["1970-01-01"]);
    const weekByStart = new Map((weeks ?? []).map((w: any) => [w.start_date, w]));
    let pubSuccess = 0;
    console.log("[2. uws 주차별 status/공표]");
    for (const w of uws ?? []) {
      const wk: any = weekByStart.get(w.week_start_date);
      const pub = wk ? Boolean(wk.result_published_at) : "(weeks행 없음→공표 간주)";
      if (w.status === "success" && (wk ? Boolean(wk.result_published_at) : true)) pubSuccess++;
      console.log(
        `  ${w.week_start_date} ${w.season_key ?? "-"} W${w.week_number} status=${w.status} published=${pub}${wk?.is_official_rest ? " [공식휴식]" : ""}`,
      );
    }
    console.log(`  → 공표 완료 성공 주차 수 = ${pubSuccess}`);

    // 3) experience 라인 타깃 전수 + 평점
    const weekIds = (weeks ?? []).map((w: any) => w.id);
    const { data: targets } = await sb
      .from("cluster4_line_targets")
      .select("id,week_id,line_id")
      .eq("target_mode", "user")
      .eq("target_user_id", uid)
      .in("week_id", weekIds.length ? weekIds : ["00000000-0000-0000-0000-000000000000"]);
    const lineIds = [...new Set((targets ?? []).map((t: any) => t.line_id))];
    const { data: lines } = await sb
      .from("cluster4_lines")
      .select("id,part_type,line_code,main_title,submission_closes_at,is_active,source_file_name")
      .in("id", lineIds.length ? lineIds : ["00000000-0000-0000-0000-000000000000"]);
    const lineById = new Map((lines ?? []).map((l: any) => [l.id, l]));
    const expTargets = (targets ?? []).filter(
      (t: any) => lineById.get(t.line_id)?.part_type === "experience" && lineById.get(t.line_id)?.is_active,
    );
    const { data: evals } = await sb
      .from("cluster4_experience_line_evaluations")
      .select("line_target_id,rating")
      .eq("user_id", uid)
      .in("line_target_id", expTargets.length ? expTargets.map((t: any) => t.id) : ["00000000-0000-0000-0000-000000000000"]);
    const ratingByTarget = new Map((evals ?? []).map((e: any) => [e.line_target_id, e.rating]));
    const weekById = new Map((weeks ?? []).map((w: any) => [w.id, w]));
    const now = Date.now();
    let closedAll = 0, closedRatingOk = 0;
    console.log(`[3. experience 라인 타깃 ${expTargets.length}건]`);
    for (const t of expTargets) {
      const l: any = lineById.get(t.line_id);
      const wk: any = weekById.get(t.week_id);
      const closed = l.submission_closes_at && new Date(l.submission_closes_at).getTime() < now;
      const rating = ratingByTarget.get(t.id);
      if (closed) {
        closedAll++;
        if (!(rating != null && rating <= 3)) closedRatingOk++;
      }
      console.log(
        `  ${wk?.start_date} ${l.line_code} "${(l.main_title ?? "").slice(0, 24)}" closed=${Boolean(closed)} rating=${rating ?? "(미평가)"} legacy=${l.source_file_name?.includes("legacy") ?? false}`,
      );
    }
    console.log(`  → 마감 기준(평점 무관, =resume 계산식) = ${closedAll}`);
    console.log(`  → 마감+rating<=3 제외(=허브 계산식)     = ${closedRatingOk}`);

    // 4) weekly-cards 측 합
    const agg = await fetchWeeklyCardLineAggregates(uid, weekIds);
    let hubExp = 0;
    for (const v of agg.experienceSuccessMap.values()) hubExp += v;
    console.log(`[4. weekly-cards experienceSuccessMap 합] = ${hubExp}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
