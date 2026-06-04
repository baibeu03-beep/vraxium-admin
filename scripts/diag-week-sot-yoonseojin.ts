// 주차 SoT 불일치 전수 추적 — T윤서진 기준 (29주 vs 8주 vs 2주 분해)
// 1) raw user_week_statuses 전수 덤프 2) user_growth_stats 캐시 3) 3개 direct function 결과
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { isTransitionWeekStart } = await import("../lib/seasonCalendar");

  // 1. T윤서진 user_id
  // 한글 NFC/NFD 양쪽 모두 검색 (OneDrive 환경 정규화 차이 대비)
  const needleNFC = "윤서진".normalize("NFC");
  const needleNFD = "윤서진".normalize("NFD");
  const { data: profsAll, error: pErr } = await sb
    .from("user_profiles")
    .select(
      "user_id, display_name, organization_slug, growth_status, status, activity_started_at",
    );
  if (pErr) console.log("검색 error:", pErr.message);
  const profs = (profsAll ?? []).filter((p: any) => {
    const n = (p.display_name ?? "") as string;
    return n.includes(needleNFC) || n.includes(needleNFD) || n.normalize("NFC").includes(needleNFC);
  });
  console.log("=== user_profiles 매칭 ===");
  for (const p of profs)
    console.log(p.user_id, p.display_name, p.organization_slug, p.growth_status, p.status, p.activity_started_at);
  const target = profs[0];
  if (!target) throw new Error("T윤서진 미발견");
  const uid = target.user_id;

  const { data: marker } = await sb
    .from("test_user_markers")
    .select("user_id")
    .eq("user_id", uid);
  console.log(`테스터 마커: ${(marker ?? []).length > 0 ? "있음" : "없음"}`);

  // 2. raw user_week_statuses 전수
  const { data: uws } = await sb
    .from("user_week_statuses")
    .select("year, week_number, status, season_key, week_start_date")
    .eq("user_id", uid)
    .order("week_start_date", { ascending: true });
  const rows = (uws ?? []) as any[];
  console.log(`\n=== user_week_statuses 전수 (${rows.length}행) ===`);
  const bySeasonStatus = new Map<string, Map<string, number>>();
  let transitionCount = 0;
  for (const r of rows) {
    const isTr = r.week_start_date && isTransitionWeekStart(r.week_start_date);
    if (isTr) transitionCount++;
    const sk = r.season_key ?? "(null)";
    const m = bySeasonStatus.get(sk) ?? new Map();
    const k = `${r.status}${isTr ? "[전환]" : ""}`;
    m.set(k, (m.get(k) ?? 0) + 1);
    bySeasonStatus.set(sk, m);
    console.log(
      `${r.week_start_date} | ${r.year}-W${String(r.week_number).padStart(2, "0")} | ${sk} | ${r.status}${isTr ? " [전환주]" : ""}`,
    );
  }
  console.log(`\n--- season_key × status 집계 ---`);
  for (const [sk, m] of bySeasonStatus) {
    console.log(`${sk}: ${[...m.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  console.log(`전환주 총계: ${transitionCount}`);

  // 3. user_growth_stats 캐시 (crews 페이지 SoT)
  const { data: gs } = await sb
    .from("user_growth_stats")
    .select("*")
    .eq("user_id", uid)
    .maybeSingle();
  console.log(`\n=== user_growth_stats (crews 캐시) ===`);
  console.log(JSON.stringify(gs));
  console.log(
    `→ crews 공식 재현: cumulative=rows.length=${rows.length}, approved=success=${rows.filter((r) => r.status === "success").length}`,
  );

  // 4. direct: getCluster1Resume (이력서)
  const { getCluster1Resume } = await import("../lib/cluster1ResumeData");
  const resume = await getCluster1Resume(uid);
  console.log(`\n=== direct getCluster1Resume.seasonRecords ===`);
  for (const r of resume?.seasonRecords ?? []) {
    console.log(
      `${r.year} ${r.seasonName} | approved=${r.approvedWeeks} / total=${r.totalWeeks} | ${r.progressStatus} / ${r.reviewStatus}`,
    );
  }

  // 5. direct: getWeeklyGrowth (cluster4 허브 실시간)
  const { getWeeklyGrowth } = await import("../lib/cluster4WeeklyGrowthData");
  const wg = await getWeeklyGrowth(uid);
  console.log(`\n=== direct getWeeklyGrowth.growthSummary ===`);
  console.log(JSON.stringify(wg?.growthSummary));
  console.log(`seasonSummary: ${JSON.stringify(wg?.seasonSummary)}`);
  const cards = wg?.weeklyCards ?? [];
  console.log(`weeklyCards: ${cards.length}장`);
  const last = cards[cards.length - 1];
  if (last)
    console.log(
      `마지막 카드: week=${(last as any).weekNumber}, accumulatedApprovedWeeks=${(last as any).accumulatedApprovedWeeks}, targetWeeks=${(last as any).targetWeeks}`,
    );

  // 6. cluster4 weekly-cards snapshot (허브 카드 화면 SoT)
  const { data: snap } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("dto_version, is_stale, computed_at")
    .eq("user_id", uid)
    .maybeSingle();
  console.log(`\n=== weekly_cards snapshot 메타 ===`);
  console.log(JSON.stringify(snap));

  // 7. user_season_statuses (시즌 참여)
  const { data: uss } = await sb
    .from("user_season_statuses")
    .select("season_key, status, note")
    .eq("user_id", uid);
  console.log(`\n=== user_season_statuses ===`);
  for (const s of uss ?? []) console.log(JSON.stringify(s));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
