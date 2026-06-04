// 이력서 카드 seasonRecords totalWeeks 정책 검증 (전환 제외 · 봄/가을 16 · 여름/겨울 8).
// 실유저 + 테스터 일부의 getCluster1Resume() 실 DTO 에서 approvedWeeks/totalWeeks 를 출력한다.
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { getCluster1Resume } = await import("../lib/cluster1ResumeData");

  const { data: mk } = await sb.from("test_user_markers").select("user_id");
  const testSet = new Set((mk ?? []).map((m: any) => m.user_id));
  const { data: profs } = await sb
    .from("user_profiles")
    .select("user_id, display_name");
  const all = (profs ?? []) as any[];
  const real = all.filter((p) => !testSet.has(p.user_id));
  const testers = all.filter((p) => testSet.has(p.user_id)).slice(0, 3);

  let bad = 0;
  for (const p of [...real, ...testers]) {
    const dto = await getCluster1Resume(p.user_id);
    const recs = dto?.seasonRecords ?? [];
    if (recs.length === 0) continue;
    const kind = testSet.has(p.user_id) ? "[tester]" : "[real]  ";
    for (const r of recs) {
      const expected =
        r.seasonName.includes("봄") || r.seasonName.includes("가을") ? 16 : 8;
      const ok = r.totalWeeks === expected && r.approvedWeeks <= r.totalWeeks;
      if (!ok) bad++;
      console.log(
        `${ok ? "OK  " : "BAD "} ${kind} ${p.display_name} | ${r.year} ${r.seasonName} | ${r.approvedWeeks}주 / ${r.totalWeeks}주 | ${r.progressStatus} / ${r.reviewStatus}`,
      );
    }
  }
  console.log(bad === 0 ? "\n✅ 전 레코드 정책 일치" : `\n❌ 불일치 ${bad}건`);
}
main();
