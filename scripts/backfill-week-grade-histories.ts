/**
 * 주차별 확정 품계 이력(user_week_grade_histories) backfill + gap-detector.
 *   기존 공표 완료 주차들에 대해 as-of 품계를 재현해 채운다(정정된 포인트 원장 기준).
 *   ⚠ 사전조건: user_week_grade_histories 테이블 수동 적용 완료(2026-07-21_user_week_grade_histories.sql).
 *
 *   npx tsx --env-file=.env.local scripts/backfill-week-grade-histories.ts                  # dry-run(write 0)
 *   npx tsx --env-file=.env.local scripts/backfill-week-grade-histories.ts --apply          # 실제 upsert
 *   옵션: --scope=operating|qa|all(기본 operating) · --limit=N(최근 N주차만) · --from=YYYY-MM-DD
 *
 *   정책: 품계는 전역 상대지표 → readAllWeeklyPoints 재사용(주차마다 1회 전체 스캔). 156주 전체는 무거우니
 *   먼저 --limit 로 dry-run 확인 후 --apply 권장. finalize 와 동일 산식(computeAsOfClubRankGradeBatch).
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { computeAsOfClubRankGradeBatch } from "@/lib/cluster3ClubRankData";
import { computeAndUpsertWeekGrades } from "@/lib/userWeekGradeHistory";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";

const APPLY = process.argv.includes("--apply");
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const SCOPE = (arg("scope") ?? "operating") as "operating" | "qa" | "all";
const LIMIT = Number(arg("limit") ?? 0);
const FROM = arg("from") ?? null;

const line = (s = "") => console.log(s);

type WeekRow = { id: string; start_date: string; season_key: string | null; week_number: number };

async function publishedWeeks(): Promise<WeekRow[]> {
  let q = supabaseAdmin
    .from("weeks")
    .select("id,start_date,season_key,week_number,result_published_at")
    .not("result_published_at", "is", null)
    .not("start_date", "is", null)
    .order("start_date", { ascending: true });
  if (FROM) q = q.gte("start_date", FROM);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  let rows = (data ?? []) as Array<WeekRow & { result_published_at: string }>;
  if (LIMIT > 0) rows = rows.slice(-LIMIT); // 최근 N주차
  return rows.map((r) => ({ id: r.id, start_date: r.start_date, season_key: r.season_key, week_number: r.week_number }));
}

async function cohortForWeek(weekStartDate: string): Promise<string[]> {
  const ids = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("user_week_statuses")
      .select("user_id")
      .eq("week_start_date", weekStartDate)
      .order("user_id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<{ user_id: string }>;
    for (const r of rows) ids.add(r.user_id);
    if (rows.length < 1000) break;
  }
  return [...ids];
}

async function main() {
  line(`=== backfill week grade histories (${APPLY ? "APPLY" : "DRY-RUN"}) scope=${SCOPE}${LIMIT ? ` limit=${LIMIT}` : ""}${FROM ? ` from=${FROM}` : ""} ===`);
  const testRaw = await fetchTestUserMarkerIds();
  const testIds = new Set<string>(Array.isArray(testRaw) ? testRaw : [...(testRaw as Iterable<string>)]);
  const weeks = await publishedWeeks();
  line(`대상 공표 주차: ${weeks.length}개`);

  let totalGraded = 0, totalNull = 0, totalRows = 0, totalWritten = 0, failWeeks = 0;
  for (const w of weeks) {
    const cohort = await cohortForWeek(w.start_date);
    const opIds = cohort.filter((id) => !testIds.has(id));
    const qaIds = cohort.filter((id) => testIds.has(id));
    const targets: Array<{ scope: "operating" | "qa"; ids: string[] }> = [];
    if (SCOPE === "operating" || SCOPE === "all") targets.push({ scope: "operating", ids: opIds });
    if (SCOPE === "qa" || SCOPE === "all") targets.push({ scope: "qa", ids: qaIds });

    for (const t of targets) {
      if (t.ids.length === 0) continue;
      if (APPLY) {
        const res = await computeAndUpsertWeekGrades({
          cohortUserIds: t.ids,
          week: { startDate: w.start_date, seasonKey: w.season_key, weekNumber: w.week_number },
          scope: t.scope,
          source: "backfill",
          finalizedAt: null,
        });
        totalRows += res.attempted;
        totalWritten += res.written;
        if (!res.ok) { failWeeks++; line(`  ✗ ${w.season_key} W${w.week_number} (${w.start_date}) ${t.scope} 실패: ${res.error}`); }
        else if (res.skipped) { line(`  · 테이블 미적용 — 스킵(마이그레이션 먼저)`); return; }
      } else {
        const grades = await computeAsOfClubRankGradeBatch({
          userIds: t.ids,
          asOfWeekStartDate: w.start_date,
          asOfSeasonKey: w.season_key,
        });
        let graded = 0, nulls = 0;
        for (const id of t.ids) {
          if (grades.get(id)) graded++;
          else nulls++;
        }
        totalGraded += graded; totalNull += nulls; totalRows += t.ids.length;
        const sample = t.ids.map((id) => grades.get(id)).find((g) => g);
        line(`  ${w.season_key} W${w.week_number} (${w.start_date}) ${t.scope}: 대상 ${t.ids.length} · grade ${graded} · null ${nulls}${sample ? ` · 예: ${sample.label}(${sample.avgPercentile})` : ""}`);
      }
    }
  }

  line("─".repeat(70));
  if (APPLY) line(`APPLY 완료 — 대상 ${totalRows}행 · upsert ${totalWritten}행 · 실패주차 ${failWeeks}`);
  else line(`DRY-RUN — 대상 ${totalRows}행 · grade ${totalGraded} · null ${totalNull} (write 0). 확인 후 --apply.`);
  process.exit(failWeeks > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
