/**
 * READ-ONLY 진단: 이력서 카드 누적 주차(medal-week-num)=0 / "26 봄시즌 0주/5주" 원인 추적.
 *
 *   npx tsx --env-file=.env.local scripts/diag-resume-card-weeks-zero.ts [userId]
 *
 * 1) 테스트 유저(test_user_markers) 목록 + 실유저 샘플
 * 2) 대상 유저 user_week_statuses 분포 (season_key × status)
 * 3) direct getCluster1Resume DTO (seasonRecords / scheduleReliability)
 * 4) front /api/profile 의 growthPeriodStats.approvedWeeks 산식 재현 (status='success' 카운트)
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { getCluster1Resume } from "@/lib/cluster1ResumeData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  const argUserId = process.argv[2] || null;

  // 1) 테스트 유저 목록
  const { data: markers, error: mErr } = await sb
    .from("test_user_markers")
    .select("user_id")
    .limit(20);
  if (mErr) console.log("test_user_markers error:", mErr.message);
  const testIds = (markers ?? []).map((m: any) => m.user_id);
  const { data: testProfiles } = await sb
    .from("user_profiles")
    .select("user_id, display_name")
    .in("user_id", testIds.length ? testIds : ["00000000-0000-0000-0000-000000000000"]);
  console.log("── 테스트 유저:", JSON.stringify(testProfiles ?? [], null, 0));

  const targets: { id: string; name: string }[] = [];
  if (argUserId) {
    targets.push({ id: argUserId, name: "(arg)" });
  } else {
    for (const p of (testProfiles ?? []).slice(0, 3) as any[]) {
      targets.push({ id: p.user_id, name: p.display_name });
    }
    // 실유저 샘플: user_week_statuses 가 있는 비테스트 유저 1명
    const { data: anyWs } = await sb
      .from("user_week_statuses")
      .select("user_id")
      .limit(500);
    const testSet = new Set(testIds);
    const realId = (anyWs ?? []).map((w: any) => w.user_id).find((id: string) => !testSet.has(id));
    if (realId) {
      const { data: rp } = await sb.from("user_profiles").select("display_name").eq("user_id", realId).maybeSingle();
      targets.push({ id: realId, name: `(실유저) ${rp?.display_name ?? "?"}` });
    }
  }

  for (const t of targets) {
    console.log(`\n════════ ${t.name} (${t.id}) ════════`);

    // 2) user_week_statuses 분포
    const { data: ws, error: wsErr } = await sb
      .from("user_week_statuses")
      .select("week_start_date, status, season_key, week_number, year")
      .eq("user_id", t.id)
      .order("week_start_date", { ascending: true });
    if (wsErr) console.log("user_week_statuses error:", wsErr.message);
    const rows = ws ?? [];
    const dist = new Map<string, Map<string, number>>();
    for (const r of rows as any[]) {
      const sk = r.season_key ?? "(null)";
      if (!dist.has(sk)) dist.set(sk, new Map());
      const m = dist.get(sk)!;
      m.set(r.status, (m.get(r.status) ?? 0) + 1);
    }
    console.log(`user_week_statuses rows: ${rows.length}`);
    for (const [sk, m] of dist) {
      console.log(`  ${sk}: ${JSON.stringify(Object.fromEntries(m))}`);
    }

    // 4) front /api/profile growthPeriodStats.approvedWeeks 재현
    const approved = (rows as any[]).filter((r) => r.status === "success").length;
    console.log(`front growthPeriodStats.approvedWeeks 재현 = ${approved}`);

    // 3) direct getCluster1Resume
    try {
      const dto = await getCluster1Resume(t.id);
      if (!dto) {
        console.log("getCluster1Resume → null (crew not found)");
      } else {
        console.log("getCluster1Resume.seasonRecords:", JSON.stringify(dto.seasonRecords));
        console.log("getCluster1Resume.scheduleReliability:", JSON.stringify(dto.scheduleReliability));
        console.log("getCluster1Resume.activityCompletion:", JSON.stringify(dto.activityCompletion));
        console.log("getCluster1Resume.practicalStats:", JSON.stringify(dto.practicalStats));
      }
    } catch (e) {
      console.log("getCluster1Resume threw:", (e as Error).message);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
