/**
 * A 방식 검증: weekly-cards 공개 응답의 기존 status 필드가 fail 로 내려오는지 (2026-05-30).
 *
 *   npx tsx --env-file=.env.local scripts/verify-experience-growth-badge.ts
 *
 * 케이스:
 *   2) read-time override: DB status='success' + verdict=fail (원복된 실사용자) → 응답 fail 이어야
 *   3) sync 후 DB status='fail' (테스트 사용자)                                → 응답 fail 이어야
 * 확인 필드: userWeekStatus / statusLabel / statusIconKey / statusTone / statusIconUrl
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const isTest = (n: string | null) => !!n && n.toLowerCase().includes("t");

async function pickUser(status: "success" | "fail", wantTest: boolean) {
  const { data } = await sb
    .from("user_week_statuses")
    .select("user_id,week_start_date")
    .eq("year", 2026)
    .eq("week_number", 21)
    .eq("status", status);
  const rows = (data ?? []) as { user_id: string; week_start_date: string }[];
  for (const r of rows) {
    const { data: p } = await sb
      .from("user_profiles")
      .select("display_name")
      .eq("user_id", r.user_id)
      .maybeSingle();
    const name = (p as { display_name: string | null } | null)?.display_name ?? null;
    if (isTest(name) === wantTest) return { ...r, name };
  }
  return null;
}

async function inspect(label: string, picked: { user_id: string; week_start_date: string; name: string | null } | null) {
  console.log(`\n──── ${label} ────`);
  if (!picked) {
    console.log("  (해당 케이스 표본 없음)");
    return;
  }
  // DB 현재 status
  const { data: dbRow } = await sb
    .from("user_week_statuses")
    .select("status,updated_at")
    .eq("user_id", picked.user_id)
    .eq("year", 2026)
    .eq("week_number", 21)
    .maybeSingle();
  const dbStatus = (dbRow as { status: string } | null)?.status ?? "?";

  const cards = await getCluster4WeeklyCardsForProfileUser(picked.user_id);
  const card = cards.find((c) => c.startDate === picked.week_start_date);
  if (!card) {
    console.log(`  ${picked.name} (${picked.user_id.slice(0, 8)}) — 2026/21 카드 없음 (cards=${cards.length})`);
    return;
  }
  console.log(`  사용자: ${picked.name} (${picked.user_id.slice(0, 8)})`);
  console.log(`  DB user_week_statuses.status = ${dbStatus}`);
  console.log(`  ── 공개 응답 필드 (프론트가 읽는 것) ──`);
  console.log(`  userWeekStatus  = ${card.userWeekStatus}`);
  console.log(`  statusLabel     = ${card.statusLabel}`);
  console.log(`  statusIconKey   = ${card.statusIconKey}`);
  console.log(`  statusTone      = ${card.statusTone}`);
  console.log(`  statusIconUrl   = ${card.statusIconUrl}`);
  console.log(`  ── 디버깅용(프론트 비필수) ──`);
  console.log(`  experienceGrowth.status = ${card.experienceGrowth.status}, failedSlots=${JSON.stringify(card.experienceGrowth.failedSlotOrders)}, applied=${card.experienceGrowth.appliedToWeekStatus}`);

  const ok =
    card.userWeekStatus === "fail" &&
    card.statusLabel === "성장(실패)" &&
    card.statusIconKey === "fail" &&
    card.statusTone === "danger" &&
    typeof card.statusIconUrl === "string" &&
    card.statusIconUrl.includes("실패");
  console.log(`  ⇒ 모든 status 필드 fail: ${ok ? "✅" : "❌"}`);
  if (!ok) process.exitCode = 1;
  return { dbStatus };
}

async function main() {
  // 케이스 2: read-time override (DB success + verdict fail) — 원복된 실사용자
  const realSuccess = await pickUser("success", false);
  const r2 = await inspect("케이스2 read-time override (DB=success, verdict=fail)", realSuccess);

  // 케이스 3: sync 후 DB fail — 테스트 사용자
  const testFail = await pickUser("fail", true);
  const r3 = await inspect("케이스3 sync 후 DB fail (DB=fail)", testFail);

  console.log("\n──── 요약 ────");
  console.log(`케이스2 DB status = ${r2?.dbStatus ?? "-"} (override 로 fail 표시, DB 미변경)`);
  console.log(`케이스3 DB status = ${r3?.dbStatus ?? "-"} (DB fail 그대로 fail 표시)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
