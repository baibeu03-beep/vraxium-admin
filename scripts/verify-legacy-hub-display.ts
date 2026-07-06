/**
 * Phase 3 검증 — 레거시 주차 실무경험/실무역량 표시(granular 이 [통합] 대체·역량 fold).
 *
 *   npx tsx --env-file=.env.local scripts/verify-legacy-hub-display.ts
 *
 * 한 테스트 유저·한 레거시 주차에 granular 경험 라인 + 역량 라인을 임시로 심고,
 * getCluster4WeeklyCardsForProfileUser 로 그 주차 카드를 계산해:
 *   - before: 경험 = [통합] 1칸.
 *   - after:  경험 = granular(슬롯) 표시 + [통합] 제외 / 역량 = fold 1칸(개설 라인).
 * 을 확인하고 임시 데이터를 정리한다. 실데이터 무변경.
 */
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(url, key);
const TAG = "LGCYVERIFY";
const PAST = "2020-01-01T00:00:00Z";

function expLines(cards: any[], weekId: string) {
  const c = (cards ?? []).find((x) => x.weekId === weekId);
  if (!c) return null;
  return {
    experience: (c.lines ?? [])
      .filter((l: any) => l.partType === "experience")
      .map((l: any) => ({ code: l.lineCode ?? null, slot: l.experienceSlotOrder ?? null, enh: l.enhancementStatus })),
    competency: (c.lines ?? [])
      .filter((l: any) => l.partType === "competency")
      .map((l: any) => ({ code: l.lineCode ?? null, enh: l.enhancementStatus })),
  };
}

async function main() {
  // 1. 테스트 유저 + 그 유저 org (기존 배정 라인의 line_code org 토큰에서 유도).
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testers = (markers ?? []).map((m) => m.user_id as string);
  // org 토큰이 있는 experience 마스터(비관리·비통합) 하나 확보.
  const { data: expMasters } = await sb
    .from("cluster4_experience_line_masters")
    .select("id, line_code, line_name")
    .not("line_code", "like", "%EN0000%");
  const expMaster = (expMasters ?? []).find(
    (m: any) => !/EL000[12]/.test(m.line_code ?? "") && /^EX/.test(m.line_code ?? ""),
  );
  const { data: compMasters } = await sb
    .from("cluster4_competency_line_masters")
    .select("id, line_code, organization_slug")
    .eq("organization_slug", "common")
    .limit(1);
  const compMaster = compMasters?.[0];
  if (!expMaster || !compMaster) { console.error("마스터 확보 실패", { expMaster, compMaster }); process.exit(1); }

  // expMaster org 토큰(EX**-...) → 그 org 테스트 유저 찾기.
  const orgToken = (expMaster.line_code as string).slice(2, 4); // BS/EC/OK/PX
  const { data: memberships } = await sb
    .from("user_memberships")
    .select("user_id, organization_slug")
    .in("user_id", testers.slice(0, 500));
  const orgSlugByToken: Record<string, string> = { BS: "oranke", EC: "encre", OK: "olympus", PX: "phalanx" };
  const wantOrg = orgSlugByToken[orgToken];
  const testUser =
    (memberships ?? []).find((m: any) => m.organization_slug === wantOrg)?.user_id ??
    testers[0];
  console.log("fixture:", { testUser, orgToken, wantOrg, expMaster: expMaster.line_code, compMaster: compMaster.line_code });

  // 2. 레거시 주차 하나.
  const { data: weeks } = await sb.from("weeks").select("id, season_key, week_number").lt("start_date", "2026-06-29").order("start_date", { ascending: false }).limit(1);
  const weekId = weeks?.[0]?.id as string;
  console.log("legacy week:", JSON.stringify(weeks?.[0]));

  // before.
  const before = expLines(await getCluster4WeeklyCardsForProfileUser(testUser), weekId);
  console.log("BEFORE:", JSON.stringify(before));

  const created: string[] = [];
  try {
    // 3. granular 경험 라인 + 역량 라인 심기(테스트 유저 타깃).
    const { data: expLine } = await sb.from("cluster4_lines").insert({
      part_type: "experience", experience_line_master_id: expMaster.id,
      line_code: expMaster.line_code, main_title: `${TAG} exp`,
      submission_opens_at: PAST, submission_closes_at: PAST, is_active: true, is_qa_test: false,
    }).select("id").single();
    created.push(expLine!.id);
    await sb.from("cluster4_line_targets").insert({ line_id: expLine!.id, week_id: weekId, target_mode: "user", target_user_id: testUser });

    const { data: compLine } = await sb.from("cluster4_lines").insert({
      part_type: "competency", competency_line_master_id: compMaster.id,
      line_code: compMaster.line_code, main_title: `${TAG} comp`,
      submission_opens_at: PAST, submission_closes_at: PAST, is_active: true, is_qa_test: false,
    }).select("id").single();
    created.push(compLine!.id);
    await sb.from("cluster4_line_targets").insert({ line_id: compLine!.id, week_id: weekId, target_mode: "user", target_user_id: testUser });

    // after.
    const after = expLines(await getCluster4WeeklyCardsForProfileUser(testUser), weekId);
    console.log("AFTER:", JSON.stringify(after));

    const beforeHadUnifiedOnly =
      before!.experience.length >= 1 &&
      before!.experience.every((e) => e.slot == null || before!.experience.length === 1);
    const afterHasGranularExp = after!.experience.some((e) => e.code === expMaster.line_code || e.slot != null);
    const afterUnifiedExcluded = !after!.experience.some((e) => e.code === "EXBS-EN0000");
    const afterHasCompetency = after!.competency.length === 1 && after!.competency[0].code != null;

    const checks = [
      ["after: 경험 granular/슬롯 표시(레거시 [통합] 대체)", afterHasGranularExp],
      ["after: [통합] 라인 제외", afterUnifiedExcluded],
      ["after: 역량 1칸 fold(개설 라인)", afterHasCompetency],
    ] as const;
    let ok = true;
    for (const [label, pass] of checks) { console.log(`${pass ? "✓" : "✗"} ${label}`); if (!pass) ok = false; }
    console.log(ok ? "\nPHASE3 VERIFY: PASS" : "\nPHASE3 VERIFY: FAIL (위 BEFORE/AFTER 확인)");
    process.exitCode = ok ? 0 : 1;
  } finally {
    if (created.length) {
      await sb.from("cluster4_lines").delete().in("id", created);
      console.log(`cleanup: ${created.length} temp lines 삭제`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
