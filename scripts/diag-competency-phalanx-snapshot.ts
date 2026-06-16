// 진단(읽기 전용): phalanx test 모드 역량 라인 개설 대상 주차 / 활성 역량 라인 / 영향 사용자 /
//   snapshot is_stale 상태를 조회한다. 운영 데이터 무변경.
// 사용법: npx tsx --env-file=.env.local scripts/diag-competency-phalanx-snapshot.ts
import { createClient } from "@supabase/supabase-js";
import { getCompetencyOpeningStatus } from "../lib/adminCompetencyLineOpening";
import { resolveUserScope } from "../lib/userScope";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  const ORG = "phalanx";
  // 1) 개설 대상 주차(test 모드) — 상태창 SoT.
  const status = await getCompetencyOpeningStatus(ORG, "test");
  console.log("\n[개설 대상 주차 상태(test/phalanx)]");
  console.log("  targetWeek:", status.targetWeek?.year, status.targetWeek?.seasonName, "W" + status.targetWeek?.weekNumber);
  console.log("  opened:", status.opened);

  // targetWeekId 직접 산출(weeks 매칭).
  const tw = status.targetWeek;
  if (!tw) {
    console.log("  targetWeek 없음 — 중단");
    return;
  }
  const { data: weekRow } = await sb
    .from("weeks")
    .select("id,season_key,week_number,start_date")
    .eq("start_date", tw.startDate)
    .maybeSingle();
  const weekId = (weekRow as { id: string } | null)?.id;
  console.log("  targetWeekId:", weekId, "| start:", tw.startDate);
  if (!weekId) return;

  // 2) 그 주차에 타깃이 걸린 competency 라인.
  const { data: tgtRows } = await sb
    .from("cluster4_line_targets")
    .select("line_id,target_user_id")
    .eq("week_id", weekId);
  const lineIds = Array.from(new Set((tgtRows ?? []).map((r: any) => r.line_id).filter(Boolean)));
  const { data: lineRows } = await sb
    .from("cluster4_lines")
    .select("id,part_type,line_code,is_active,competency_line_master_id")
    .eq("part_type", "competency")
    .in("id", lineIds.length ? lineIds : ["00000000-0000-0000-0000-000000000000"]);
  console.log("\n[그 주차 competency 라인]", (lineRows ?? []).length, "개");
  for (const l of (lineRows ?? []) as any[]) {
    console.log(`  ${l.id} | code=${l.line_code} | active=${l.is_active}`);
  }

  // 3) phalanx test 모집단.
  const scope = await resolveUserScope("test", ORG);
  const testTargets = (tgtRows ?? [])
    .map((r: any) => r.target_user_id)
    .filter((u: string | null) => u && scope.filter([u]).length > 0);
  console.log("\n[phalanx test 모집단] size=", scope.size ?? "(n/a)");
  console.log("  그 주차 competency 타깃 중 test 유저:", Array.from(new Set(testTargets)));

  // 4) test 모집단의 snapshot is_stale 상태.
  const ids = Array.from(new Set(testTargets)) as string[];
  if (ids.length) {
    const { data: snaps } = await sb
      .from("cluster4_weekly_cards_snapshots")
      .select("user_id,is_stale,dto_version,computed_at")
      .in("user_id", ids);
    console.log("\n[snapshot 상태(test 타깃)]");
    for (const s of (snaps ?? []) as any[]) {
      console.log(`  ${s.user_id} | is_stale=${s.is_stale} | v=${s.dto_version} | computed=${s.computed_at}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
