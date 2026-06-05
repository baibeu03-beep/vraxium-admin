/**
 * 실사용자(비테스터) 표시 데이터 출처(provenance) 진단. read-only.
 *   npx tsx --env-file=.env.local scripts/diag-real-user-data-provenance.ts
 *
 * 항목: 프로필 / point.check·advantage·penalty / 주차 활동 내역(uws) / 평점 /
 *       4허브 라인(타깃·제출) / 졸업 진행도(growth_stats) / 성장 상태(growth_status)
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { LEGACY_UNIFIED_LINE_NAME } from "@/lib/lineAvailability";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function pageAll<T>(
  table: string,
  select: string,
  filter?: (q: any) => any,
  orderCol = "id",
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = sb
      .from(table)
      .select(select)
      .order(orderCol, { ascending: true })
      .range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  // 0. 실사용자 식별
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testers = new Set((markers ?? []).map((m: any) => m.user_id));
  const profiles = await pageAll<any>(
    "user_profiles",
    "user_id,display_name,organization_slug,growth_status,activity_started_at,created_at",
    undefined,
    "user_id",
  );
  const realProfiles = profiles.filter((p) => !testers.has(p.user_id));
  const realIds = realProfiles.map((p) => p.user_id);
  console.log(`전체 프로필 ${profiles.length} | 테스터 ${testers.size} | 실사용자 ${realIds.length}`);
  console.log(
    `실사용자 조직 분포:`,
    JSON.stringify(
      realProfiles.reduce((acc: any, p) => {
        acc[p.organization_slug ?? "none"] = (acc[p.organization_slug ?? "none"] ?? 0) + 1;
        return acc;
      }, {}),
    ),
  );
  console.log(
    `실사용자 growth_status 분포:`,
    JSON.stringify(
      realProfiles.reduce((acc: any, p) => {
        acc[p.growth_status ?? "null"] = (acc[p.growth_status ?? "null"] ?? 0) + 1;
        return acc;
      }, {}),
    ),
  );

  // 1. user_weekly_points (check/advantage/penalty)
  const pts: any[] = [];
  for (const c of chunk(realIds, 100)) {
    pts.push(
      ...(await pageAll<any>(
        "user_weekly_points",
        "user_id,year,week_number,points,advantages,penalty,checks_migrated,created_at,updated_at",
        (q) => q.in("user_id", c),
      )),
    );
  }
  const createdDates = [...new Set(pts.map((p) => String(p.created_at).slice(0, 10)))].sort();
  const updatedDates = [...new Set(pts.map((p) => String(p.updated_at).slice(0, 10)))].sort();
  const migratedCount = pts.filter((p) => p.checks_migrated === true).length;
  const maxPoints = Math.max(0, ...pts.map((p) => p.points));
  const maxAdv = Math.max(0, ...pts.map((p) => p.advantages));
  const maxPen = Math.max(0, ...pts.map((p) => p.penalty));
  console.log(
    `\nuser_weekly_points(실사용자): rows=${pts.length} | created_at 일자=${JSON.stringify(createdDates)} | updated_at 일자=${JSON.stringify(updatedDates)}`,
  );
  console.log(
    `  points max=${maxPoints} adv max=${maxAdv} penalty max=${maxPen} | checks_migrated=true: ${migratedCount}건`,
  );

  // 2. user_week_statuses (주차 활동 내역)
  const uws: any[] = [];
  for (const c of chunk(realIds, 100)) {
    uws.push(
      ...(await pageAll<any>(
        "user_week_statuses",
        "user_id,week_start_date,status,note,created_at,updated_at",
        (q) => q.in("user_id", c),
      )),
    );
  }
  const uwsCreated = [...new Set(uws.map((r) => String(r.created_at).slice(0, 10)))].sort();
  const uwsWeeks = [...new Set(uws.map((r) => r.week_start_date))].sort();
  console.log(
    `\nuser_week_statuses(실사용자): rows=${uws.length} | 주차범위=${uwsWeeks[0]}~${uwsWeeks[uwsWeeks.length - 1]} | created_at 일자=${JSON.stringify(uwsCreated)}`,
  );
  console.log(
    `  status 분포:`,
    JSON.stringify(
      uws.reduce((acc: any, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + 1;
        return acc;
      }, {}),
    ),
  );

  // 3. 평점 (cluster4_experience_line_evaluations)
  const evals: any[] = [];
  for (const c of chunk(realIds, 100)) {
    evals.push(
      ...(await pageAll<any>(
        "cluster4_experience_line_evaluations",
        "user_id,line_target_id,rating,evaluated_by,evaluated_at,created_at",
        (q) => q.in("user_id", c),
      )),
    );
  }
  console.log(`\n평점(실사용자): rows=${evals.length}`);
  if (evals.length) {
    console.log(
      `  rating 분포:`,
      JSON.stringify(
        evals.reduce((acc: any, e) => {
          acc[e.rating] = (acc[e.rating] ?? 0) + 1;
          return acc;
        }, {}),
      ),
      `| created 일자=${JSON.stringify([...new Set(evals.map((e) => String(e.created_at).slice(0, 10)))].sort())}`,
    );
  }

  // 4. 라인 타깃/제출 (실사용자)
  const { data: master } = await sb
    .from("cluster4_experience_line_masters")
    .select("id")
    .eq("line_name", LEGACY_UNIFIED_LINE_NAME)
    .maybeSingle();
  const unifiedLines = await pageAll<any>("cluster4_lines", "id,part_type", (q) =>
    q.eq("experience_line_master_id", (master as any).id),
  );
  const unifiedLineIds = new Set(unifiedLines.map((l) => l.id));

  const targets: any[] = [];
  for (const c of chunk(realIds, 100)) {
    targets.push(
      ...(await pageAll<any>(
        "cluster4_line_targets",
        "id,line_id,week_id,target_user_id,created_at",
        (q) => q.in("target_user_id", c),
      )),
    );
  }
  const unifiedTargets = targets.filter((t) => unifiedLineIds.has(t.line_id));
  const otherTargets = targets.filter((t) => !unifiedLineIds.has(t.line_id));
  console.log(
    `\n라인 타깃(실사용자): 통합=${unifiedTargets.length} (created=${JSON.stringify([...new Set(unifiedTargets.map((t) => String(t.created_at).slice(0, 10)))].sort())}) | 비통합=${otherTargets.length} (created=${JSON.stringify([...new Set(otherTargets.map((t) => String(t.created_at).slice(0, 10)))].sort())})`,
  );

  // 비통합 타깃의 라인 part_type 분포
  if (otherTargets.length) {
    const lineIds = [...new Set(otherTargets.map((t) => t.line_id))];
    const lines: any[] = [];
    for (const c of chunk(lineIds, 100)) {
      lines.push(...(await pageAll<any>("cluster4_lines", "id,part_type", (q) => q.in("id", c))));
    }
    const ptById = new Map(lines.map((l) => [l.id, l.part_type]));
    console.log(
      `  비통합 타깃 part_type 분포:`,
      JSON.stringify(
        otherTargets.reduce((acc: any, t) => {
          const pt = ptById.get(t.line_id) ?? "?";
          acc[pt] = (acc[pt] ?? 0) + 1;
          return acc;
        }, {}),
      ),
    );
  }

  // 제출 (실사용자)
  const subs: any[] = [];
  for (const c of chunk(realIds, 100)) {
    subs.push(
      ...(await pageAll<any>(
        "cluster4_line_submissions",
        "id,line_target_id,user_id,growth_point,submitted_at,created_at",
        (q) => q.in("user_id", c),
      )),
    );
  }
  const unifiedTargetIds = new Set(unifiedTargets.map((t) => t.id));
  const subsOnUnified = subs.filter((s) => unifiedTargetIds.has(s.line_target_id));
  console.log(
    `제출(실사용자): 전체=${subs.length} | 통합 타깃 위=${subsOnUnified.length} | created 일자=${JSON.stringify([...new Set(subs.map((s) => String(s.created_at).slice(0, 10)))].sort())}`,
  );

  // 5. 졸업 진행도 (user_growth_stats)
  const gs: any[] = [];
  for (const c of chunk(realIds, 100)) {
    gs.push(
      ...(await pageAll<any>(
        "user_growth_stats",
        "user_id,approved_weeks,cumulative_weeks,updated_at",
        (q) => q.in("user_id", c),
        "user_id",
      )),
    );
  }
  console.log(
    `\nuser_growth_stats(실사용자): rows=${gs.length} | approved 분포=${JSON.stringify(
      gs.reduce((acc: any, g) => {
        acc[g.approved_weeks] = (acc[g.approved_weeks] ?? 0) + 1;
        return acc;
      }, {}),
    )}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
