// [read-only 진단] 저장된 recognition_count_n(권위 latch) vs 현재 코드 재계산 N(미리보기) 격차 전수 스캔.
//   run: node_modules/.bin/tsx --env-file=.env.local scripts/_diag-recognition-divergence.ts
/* eslint-disable @typescript-eslint/no-explicit-any -- 진단 스크립트: DB 행을 그대로 훑는다. */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ORGANIZATIONS } from "@/lib/organizations";
import { prepareWeekRecognition } from "@/lib/weekRecognitionResolve";

async function main() {
  const { data, error } = await supabaseAdmin
    .from("cluster4_week_opening_configs")
    .select(
      "week_id, organization_slug, open_confirmed, open_confirmed_at, min_points_a, exec_points_b, recognition_count_n, recognition_calc_version, config, updated_at",
    );
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<Record<string, any>>;
  console.log(`opening_configs rows = ${rows.length}`);

  const weekIds = [...new Set(rows.map((r) => r.week_id))];
  const { data: wk } = await supabaseAdmin
    .from("weeks")
    .select("id, season_key, week_number, start_date, end_date")
    .in("id", weekIds);
  const weekById = new Map(
    ((wk ?? []) as Array<Record<string, any>>).map((w) => [w.id, w]),
  );

  for (const r of rows.sort((a, b) => String(a.organization_slug).localeCompare(String(b.organization_slug)))) {
    const w = weekById.get(r.week_id);
    const org = r.organization_slug;
    if (!ORGANIZATIONS.includes(org)) continue;
    let recomputed: string;
    let missing = 0;
    try {
      const p = await prepareWeekRecognition({
        weekId: r.week_id,
        organization: org,
        config: r.config ?? {},
      });
      recomputed = `A=${p.result.minimalA} B=${p.result.diligentB} N=${p.result.recognitionCountN} feat=${p.featureAvailable}`;
      missing = p.missing.length;
    } catch (e) {
      recomputed = `ERR ${e instanceof Error ? e.message : e}`;
    }
    const stored = `A=${r.min_points_a} B=${r.exec_points_b} N=${r.recognition_count_n} v=${r.recognition_calc_version}`;
    console.log(
      `\n[${org}] ${w?.season_key ?? "?"} W${w?.week_number ?? "?"} (${w?.start_date ?? "?"}) week=${r.week_id}`,
    );
    console.log(`  open_confirmed=${r.open_confirmed} at=${r.open_confirmed_at} updated=${r.updated_at}`);
    console.log(`  저장(latch): ${stored}`);
    console.log(`  재계산(저장 config): ${recomputed} missing=${missing}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
