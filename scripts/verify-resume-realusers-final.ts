// 실사용자(test_user_markers 제외) 한정 이력서 seasonRecords 최종 점검.
//   1) 시즌 누락: raw 비전환 행 보유 시즌이 record 에 빠짐 없음
//   2) approvedWeeks: raw 비전환 success 와 정확 일치 (0주 오표시 없음)
//   3) 활동 중단 오판정: record 판정을 raw 로 재계산해 대조
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { isTransitionWeekStart } = await import("../lib/seasonCalendar");
  const { getCluster1Resume } = await import("../lib/cluster1ResumeData");

  const { data: mk } = await sb.from("test_user_markers").select("user_id");
  const testSet = new Set(((mk ?? []) as any[]).map((m) => m.user_id));
  const { data: profs } = await sb.from("user_profiles").select("user_id, display_name");
  const real = ((profs ?? []) as any[]).filter((p) => !testSet.has(p.user_id));

  const { data: defs } = await sb
    .from("season_definitions")
    .select("season_key,season_label,season_type,end_date");
  const defOf = new Map(((defs ?? []) as any[]).map((d) => [d.season_key, d]));
  const NAME: Record<string, string> = { spring: "봄 시즌", summer: "여름 시즌", autumn: "가을 시즌", winter: "겨울 시즌" };
  const TOTAL: Record<string, number> = { spring: 16, summer: 8, autumn: 16, winter: 8 };

  let problems = 0;
  let users = 0;
  let records = 0;
  for (const p of real) {
    const { data: uws } = await sb
      .from("user_week_statuses")
      .select("season_key,week_start_date,status")
      .eq("user_id", p.user_id);
    const rows = ((uws ?? []) as any[]).filter(
      (r) => r.season_key && !(r.week_start_date && isTransitionWeekStart(r.week_start_date)),
    );
    if (rows.length === 0 && (uws ?? []).length === 0) continue;
    users++;

    const bySeason = new Map<string, any[]>();
    for (const r of rows) {
      const arr = bySeason.get(r.season_key) ?? [];
      arr.push(r);
      bySeason.set(r.season_key, arr);
    }

    const dto = await getCluster1Resume(p.user_id);
    const recs = (dto?.seasonRecords ?? []) as any[];

    // 1) 시즌 누락
    for (const [sk, srows] of bySeason) {
      const def = defOf.get(sk);
      const label = def ? `${sk.slice(2, 4)} ${NAME[def.season_type] ?? def.season_label}` : sk;
      const rec = recs.find((r) => `${r.year} ${r.seasonName}` === label);
      if (!rec) {
        problems++;
        console.log(`❌ [시즌누락] ${p.display_name} | ${sk} raw 비전환 ${srows.length}행 → record 없음`);
        continue;
      }
      records++;
      // 2) approvedWeeks 일치
      const rawSuccess = srows.filter((r) => r.status === "success").length;
      if (rec.approvedWeeks !== rawSuccess) {
        problems++;
        console.log(`❌ [approved불일치] ${p.display_name} | ${sk} raw=${rawSuccess} vs record=${rec.approvedWeeks}`);
      }
      // 3) 판정 재계산 대조 (computeSeasonRecords 와 동일 규칙을 raw 로 독립 재현)
      const total = TOTAL[def?.season_type] ?? srows.length;
      const hasRest = srows.some((r) => r.status === "personal_rest");
      const hasFail = srows.some((r) => r.status === "fail");
      const ongoing = new Date() <= new Date(def?.end_date ?? "9999-12-31");
      let expect: string;
      if (ongoing) expect = "진행 중";
      else if (hasRest && !hasFail) expect = "통합 휴식";
      else if (hasFail && rawSuccess < total / 2) expect = "활동 중단";
      else expect = rawSuccess >= total - 1 ? "정상 졸업" : "정상 완료";
      if (rec.progressStatus !== expect) {
        problems++;
        console.log(
          `❌ [판정불일치] ${p.display_name} | ${sk} 기대=${expect} vs record=${rec.progressStatus} (success ${rawSuccess}/${total}, fail=${hasFail}, rest=${hasRest})`,
        );
      }
      console.log(
        `   ${p.display_name} | ${label} | ${rec.approvedWeeks}/${rec.totalWeeks} ${rec.progressStatus} (raw success=${rawSuccess}, fail=${srows.filter((r) => r.status === "fail").length}, rest=${srows.filter((r) => r.status === "personal_rest").length}, official=${srows.filter((r) => r.status === "official_rest").length})`,
      );
    }
  }
  console.log(`\n실사용자 ${users}명 · record ${records}건 점검 → ${problems === 0 ? "✅ 문제 없음" : `❌ ${problems}건`}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
