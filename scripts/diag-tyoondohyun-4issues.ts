// T윤도현 4개 문제 진단 — 1) 이력서 시즌 목록 누락 2) cluster3 온보딩 오표시
// 3) cluster4 누적주차 8/30 vs 7 4) 14주차 휴식주차 라인개설(demo)
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { isTransitionWeekStart } = await import("../lib/seasonCalendar");

  // ── 1. T윤도현 user_id ──
  const needle = "윤도현";
  const { data: profsAll } = await sb
    .from("user_profiles")
    .select("user_id, display_name, organization_slug, growth_status, status, activity_started_at");
  const profs = (profsAll ?? []).filter((p: any) =>
    ((p.display_name ?? "") as string).normalize("NFC").includes(needle),
  );
  console.log("=== user_profiles 매칭 ===");
  for (const p of profs)
    console.log(p.user_id, p.display_name, p.organization_slug, p.growth_status, p.status, p.activity_started_at);
  const target = profs.find((p: any) => (p.display_name as string).normalize("NFC").startsWith("T")) ?? profs[0];
  if (!target) throw new Error("T윤도현 미발견");
  const uid = target.user_id as string;
  console.log("→ 대상 uid:", uid, target.display_name);

  const { data: marker } = await sb.from("test_user_markers").select("user_id").eq("user_id", uid);
  console.log("테스터 마커:", (marker ?? []).length > 0 ? "있음" : "없음");

  const { data: userRow } = await sb.from("users").select("id, legacy_user_id").eq("id", uid).maybeSingle();
  console.log("users.legacy_user_id:", userRow?.legacy_user_id ?? "(users 행 없음)");

  // ── 2. user_week_statuses 전수 ──
  const { data: uws } = await sb
    .from("user_week_statuses")
    .select("year, week_number, status, season_key, week_start_date, is_official_rest_override")
    .eq("user_id", uid)
    .order("week_start_date", { ascending: true });
  const rows = (uws ?? []) as any[];
  console.log(`\n=== user_week_statuses (${rows.length}행) ===`);
  for (const r of rows) {
    const isTr = r.week_start_date && isTransitionWeekStart(r.week_start_date);
    console.log(
      `${r.week_start_date} | W${String(r.week_number).padStart(2, "0")} | ${r.season_key ?? "(null)"} | ${r.status}${isTr ? " [전환]" : ""}${r.is_official_rest_override ? " [override]" : ""}`,
    );
  }

  // ── 3. season_definitions ──
  const { data: sd } = await sb
    .from("season_definitions")
    .select("season_key, season_label, season_type, start_date, end_date")
    .order("start_date", { ascending: true });
  console.log(`\n=== season_definitions (${(sd ?? []).length}행) ===`);
  for (const s of sd ?? []) console.log(s.season_key, s.season_label, s.season_type, s.start_date, "~", s.end_date);

  // uws season_key 들이 season_definitions 에 있는지
  const sdKeys = new Set((sd ?? []).map((s: any) => s.season_key));
  const uwsKeys = new Set(rows.map((r) => r.season_key).filter(Boolean));
  console.log("\nuws season_key 들:", [...uwsKeys].join(", "));
  for (const k of uwsKeys) if (!sdKeys.has(k)) console.log(`⚠ season_definitions 에 없는 uws season_key: ${k}`);

  // ── 4. user_season_statuses / user_season_histories ──
  const { data: uss } = await sb.from("user_season_statuses").select("*").eq("user_id", uid);
  console.log(`\n=== user_season_statuses (${(uss ?? []).length}행) ===`);
  for (const s of uss ?? []) console.log(JSON.stringify(s));

  // ── 5. computeSeasonRecords direct (getCluster1Resume 경유, 식별자=profile UUID) ──
  {
    const { getCluster1Resume } = await import("../lib/cluster1ResumeData");
    const resume = await getCluster1Resume(uid);
    console.log("\n=== getCluster1Resume direct ===");
    console.log("seasonRecords:", JSON.stringify(resume?.seasonRecords, null, 2));
    console.log("resumeStatus:", JSON.stringify(resume?.resumeStatus));
    console.log("scheduleReliability:", JSON.stringify(resume?.scheduleReliability));
  }

  // ── 6. cluster3 getGrowthIndicatorsInternal direct ──
  const { getGrowthIndicatorsInternal } = await import("../lib/cluster3GrowthData");
  const gi = await getGrowthIndicatorsInternal(uid);
  console.log("\n=== cluster3 growthIndicators direct ===");
  console.log("displayKey:", gi.process.growthDisplayKey, "| display:", gi.process.growthStatusDisplay);
  console.log("period:", JSON.stringify(gi.period));
  console.log("_debug:", JSON.stringify(gi._debug));

  // ── 7. snapshot 상태 + 카드 요약 ──
  const { readWeeklyCardsSnapshot } = await import("../lib/cluster4WeeklyCardsSnapshot");
  const snap = await readWeeklyCardsSnapshot(uid);
  console.log("\n=== weekly-cards snapshot ===");
  console.log("status:", snap.status, "reason" in snap ? `reason=${(snap as any).reason}` : "", "computedAt" in snap ? (snap as any).computedAt : "");
  const snapCards = "cards" in snap ? (snap as any).cards : [];
  console.log(`cards: ${snapCards.length}`);
  for (const c of snapCards) {
    console.log(
      `  ${c.startDate} W${c.weekNumber} ${c.seasonKey ?? "-"} | status=${c.userWeekStatus} | isRest=${c.isRestWeek} | isTr=${c.isTransition} | acc=${c.accumulatedApprovedWeeks} | label="${c.displayWeekProgressLabel}" | lines=${c.lines?.length ?? 0} | growth=${c.growthNumerator}/${c.growthDenominator}`,
    );
  }

  // ── 8. getWeeklyGrowth direct (실시간) ──
  const { getWeeklyGrowth } = await import("../lib/cluster4WeeklyGrowthData");
  const g = await getWeeklyGrowth(uid);
  console.log("\n=== getWeeklyGrowth direct ===");
  console.log("summary:", JSON.stringify(g?.summary ?? null));
  for (const c of g?.weeklyCards ?? []) {
    console.log(
      `  ${c.startDate} W${c.weekNumber} ${c.seasonKey ?? "-"} | result=${c.resultStatus} | isTr=${c.isTransition} | acc=${c.accumulatedApprovedWeeks}/${c.targetWeeks} | growth=${c.weeklyGrowth.completedLines}/${c.weeklyGrowth.availableLines}`,
    );
  }

  // ── 9. 14주차(휴식 의심) 식별 — weeks 테이블 + official_rest_periods ──
  const { data: weeks14 } = await sb
    .from("weeks")
    .select("id, season_key, week_number, start_date, end_date, result_published_at, is_official_rest")
    .eq("week_number", 14)
    .order("start_date", { ascending: true });
  console.log("\n=== weeks (week_number=14) ===");
  for (const w of weeks14 ?? []) console.log(JSON.stringify(w));
  const { data: orp } = await sb.from("official_rest_periods").select("*");
  console.log(`\n=== official_rest_periods (${(orp ?? []).length}행) ===`);
  for (const r of orp ?? []) console.log(JSON.stringify(r));
}

main().catch((e) => { console.error(e); process.exit(1); });
