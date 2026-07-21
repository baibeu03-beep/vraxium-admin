/**
 * 파트 스키마 전수 조사 — 독립 "파트 마스터" 테이블 존재 여부 + partId 정체 + 32의 성격.
 *   READ-ONLY. npx tsx --env-file=.env.local scripts/investigate-part-schema.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ORGANIZATIONS } from "@/lib/organizations";
import { resolveCurrentHalfKey } from "@/lib/adminTeamHalvesData";
import { resolveEffectiveScopeMode } from "@/lib/cluster4ExperienceTestScope";

async function exists(table: string): Promise<string> {
  // ⚠ head:true 는 없는 테이블에도 error 를 채우지 않고 count=null 만 준다(오탐). limit(1) 로 확정 판정.
  const { error, count } = await supabaseAdmin
    .from(table)
    .select("*", { count: "exact" })
    .limit(1);
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "42P01" || code === "PGRST205" || /does not exist|find the table/i.test(error.message))
      return "❌ 없음(PGRST205)";
    return `⚠ ${code ?? ""} ${error.message}`;
  }
  return `✅ 존재 (rows=${count})`;
}

async function main() {
  console.log("════ 1) 독립 '파트 마스터' 후보 테이블 존재 여부 ════");
  const candidates = [
    "parts", "part_masters", "cluster4_parts", "cluster4_part_masters",
    "cluster4_team_part_masters", "team_parts", "user_team_parts",
    "cluster4_team_parts", // 실제 사용 카탈로그(팀_반기 종속)
  ];
  for (const t of candidates) console.log(`  ${t.padEnd(28)} ${await exists(t)}`);

  console.log("\n════ 2) cluster4_team_parts 구조/키 ════");
  const { data: sample } = await supabaseAdmin
    .from("cluster4_team_parts")
    .select("*")
    .limit(1);
  console.log("  컬럼:", sample?.[0] ? Object.keys(sample[0]).join(", ") : "(행 없음)");
  console.log("  → PK=id(uuid), 파트명 저장 컬럼=part_name(text), 소속=team_half_id(FK→cluster4_team_halves), UNIQUE(team_half_id, part_name)");

  // 전역: 같은 part_name 이 여러 team_half 에 반복되는가?
  const all: Array<{ part_name: string; team_half_id: string }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("cluster4_team_parts")
      .select("part_name,team_half_id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    all.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const nameCount = new Map<string, number>();
  for (const r of all) nameCount.set(r.part_name, (nameCount.get(r.part_name) ?? 0) + 1);
  const topRepeat = [...nameCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`\n  전역 레코드 수=${all.length}, 고유 part_name 수=${nameCount.size}`);
  console.log("  같은 파트명이 여러 팀_반기에 반복 저장(상위):");
  for (const [n, c] of topRepeat) console.log(`    "${n}" → ${c}개 레코드(팀_반기)`);

  console.log("\n════ 3) '전체 파트 수 32'의 성격 분해 ════");
  const currentHalf = await resolveCurrentHalfKey();
  const wantQaTest = resolveEffectiveScopeMode("operating") === "test";
  const teamHalfIds: string[] = [];
  for (const org of ORGANIZATIONS) {
    const { data } = await supabaseAdmin
      .from("cluster4_team_halves")
      .select("id,is_qa_test")
      .eq("organization_slug", org)
      .eq("half_key", currentHalf ?? "")
      .eq("is_active", true);
    for (const h of (data ?? []).filter((x: { is_qa_test: boolean | null }) => Boolean(x.is_qa_test) === wantQaTest))
      teamHalfIds.push((h as { id: string }).id);
  }
  const { data: parts } = await supabaseAdmin
    .from("cluster4_team_parts")
    .select("id,team_half_id,part_name")
    .in("team_half_id", teamHalfIds);
  const rows = (parts ?? []) as Array<{ id: string; team_half_id: string; part_name: string }>;
  const distinctPartId = new Set(rows.map((r) => r.id)).size;
  const distinctName = new Set(rows.map((r) => r.part_name)).size;
  const distinctTeamPart = new Set(rows.map((r) => `${r.team_half_id}|${r.part_name}`)).size;
  console.log(`  현재 반기=${currentHalf}, 활성 팀_반기 수=${teamHalfIds.length}`);
  console.log(`  ┌ 팀별 파트 레코드 수 (cluster4_team_parts 행, =고유 partId)     = ${rows.length} / ${distinctPartId}`);
  console.log(`  ├ 고유 파트명 개념 수 (distinct part_name)                        = ${distinctName}`);
  console.log(`  └ 고유 (팀_반기 × 파트명) 조합 수                                  = ${distinctTeamPart}`);
  console.log(`\n  ⇒ 화면의 "전체 파트 수"(=summary.totalParts) 는 위 중 [팀별 파트 레코드 수 = ${rows.length}] 이다.`);
  console.log(`     (고유 파트명 개념 수는 ${distinctName} — 팀마다 '일반' 등 동명 파트가 별도 레코드로 반복되기 때문)`);

  console.log("\n════ 4) '파트×주차 레코드'는 어디에? (다른 테이블) ════");
  console.log("  cluster4_team_parts 에는 주차 축이 없다(파트×주차 저장 아님). 파트×주차 존재표는");
  console.log("  user_position_histories(raw_part, week_start_date)를 read 하여 매트릭스를 '계산'한다(저장 아님).");
  const { count: uphParts } = await supabaseAdmin
    .from("user_position_histories")
    .select("id", { count: "exact", head: true })
    .not("raw_part", "is", null);
  console.log(`  참고: user_position_histories(raw_part not null) 총 레코드 = ${uphParts} (사용자×주차×파트, 텍스트 raw_part)`);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
