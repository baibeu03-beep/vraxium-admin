// 이력서 seasonRecords 4단계 대조: raw(uws) → direct(getCluster1Resume)
//   → admin HTTP(/api/cluster1/resume) → 고객 HTTP(/api/profile seasonHistories).
// 대상: 증상A(시즌누락)·증상B(0주)·정상 테스터·실유저 컨트롤.
import { config } from "dotenv";
config({ path: ".env.local" });

const ADMIN = "http://localhost:3000";
const CUSTOMER = "http://localhost:3001";

const TARGET_NAMES = ["T안준혁", "T서다은", "T임시우", "T홍지환", "김연우"];

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { isTransitionWeekStart } = await import("../lib/seasonCalendar");
  const { getCluster1Resume } = await import("../lib/cluster1ResumeData");

  const { data: profs } = await sb
    .from("user_profiles")
    .select("user_id, display_name")
    .in("display_name", TARGET_NAMES);

  for (const p of (profs ?? []) as any[]) {
    console.log(`\n${"═".repeat(70)}\n■ ${p.display_name} (${p.user_id})`);

    // 1) raw
    const { data: uws } = await sb
      .from("user_week_statuses")
      .select("season_key,week_start_date,status")
      .eq("user_id", p.user_id)
      .order("week_start_date");
    const bySeason = new Map<string, { reg: string[]; trans: string[]; regSuccess: number }>();
    for (const r of (uws ?? []) as any[]) {
      const e = bySeason.get(r.season_key) ?? { reg: [], trans: [], regSuccess: 0 };
      const tag = `${r.week_start_date}:${r.status}`;
      if (r.week_start_date && isTransitionWeekStart(r.week_start_date)) e.trans.push(tag);
      else {
        e.reg.push(tag);
        if (r.status === "success") e.regSuccess++;
      }
      bySeason.set(r.season_key, e);
    }
    console.log("[1.raw user_week_statuses]");
    for (const [sk, e] of bySeason) {
      console.log(
        `  ${sk}: 비전환 ${e.reg.length}행(success ${e.regSuccess}) | 전환 ${e.trans.length}행 ${e.trans.join(", ") || ""}`,
      );
    }

    // 2) direct
    const dto = await getCluster1Resume(p.user_id);
    const direct = (dto?.seasonRecords ?? []).map(
      (r: any) => `${r.year} ${r.seasonName} ${r.approvedWeeks}/${r.totalWeeks} ${r.progressStatus}·${r.reviewStatus}`,
    );
    console.log("[2.direct getCluster1Resume]");
    for (const d of direct) console.log(`  ${d}`);

    // 3) admin HTTP
    const adminRes = await fetch(`${ADMIN}/api/cluster1/resume?userId=${p.user_id}`, {
      headers: { "x-internal-api-key": process.env.INTERNAL_API_KEY! },
    });
    const adminJson: any = await adminRes.json().catch(() => null);
    const http = (adminJson?.data?.seasonRecords ?? []).map(
      (r: any) => `${r.year} ${r.seasonName} ${r.approvedWeeks}/${r.totalWeeks} ${r.progressStatus}·${r.reviewStatus}`,
    );
    console.log(`[3.admin HTTP /api/cluster1/resume] status=${adminRes.status}`);
    for (const d of http) console.log(`  ${d}`);
    console.log(`  direct==HTTP: ${JSON.stringify(direct) === JSON.stringify(http) ? "✅ 동일" : "❌ 불일치"}`);

    // 4) customer /api/profile (seasonHistories — Sidebar 가 그대로 렌더)
    // Sidebar 실제 호출과 동일: context 없음 (context=card 는 시즌 통계 스킵 경량 분기)
    const custRes = await fetch(`${CUSTOMER}/api/profile/?userId=${p.user_id}`, {
      headers: { "Content-Type": "application/json" },
    });
    const custJson: any = await custRes.json().catch(() => null);
    const sh = custJson?.seasonHistories ?? custJson?.data?.seasonHistories ?? [];
    console.log(`[4.customer HTTP /api/profile seasonHistories] status=${custRes.status} (${Array.isArray(sh) ? sh.length : "?"}건)`);
    for (const h of Array.isArray(sh) ? sh : []) {
      console.log(
        `  ${h.seasons?.year ?? h.year ?? "?"} ${h.seasons?.name ?? h.seasonName ?? "?"} ${h.approved_weeks}/${h.total_weeks} ${h.progress_status}·${h.review_status}`,
      );
    }
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
