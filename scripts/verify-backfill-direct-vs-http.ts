/**
 * direct(getCluster1Resume·snapshot) vs HTTP(/api/cluster1/resume·/api/profile) 일치 검증.
 *   npx tsx --env-file=.env.local scripts/verify-backfill-direct-vs-http.ts <userId>
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { getCluster1Resume } from "@/lib/cluster1ResumeData";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const U = process.argv[2] || "fff3941f-071c-4cca-b99a-da8bd6d2fae2"; // T정하은
const ADMIN = "http://localhost:3000";
const FRONT = "http://localhost:3001";
const KEY = process.env.INTERNAL_API_KEY!;

async function main() {
  // 1) direct
  const direct = await getCluster1Resume(U);
  const snap: any = await readWeeklyCardsSnapshot(U);
  const snapInfo = (snap?.cards ?? []).map((c: any) => ({
    week: c.startDate,
    status: c.userWeekStatus,
    infoLines: (c.lines ?? []).filter((l: any) => l.partType === "information" && l.status !== "void").length,
    den: c.growthDenominator,
    num: c.growthNumerator,
  }));
  console.log("── direct getCluster1Resume:");
  console.log("  practicalStats:", JSON.stringify(direct?.practicalStats));
  console.log("  activityCompletion:", JSON.stringify(direct?.activityCompletion));
  console.log("  seasonRecords:", JSON.stringify(direct?.seasonRecords));
  console.log("── direct snapshot (status hit?):", snap?.status);

  // 2) HTTP admin /api/cluster1/resume
  const r1 = await fetch(`${ADMIN}/api/cluster1/resume?userId=${U}`, {
    headers: { "x-internal-api-key": KEY },
  });
  const j1: any = await r1.json();
  console.log("\n── HTTP admin /api/cluster1/resume:", r1.status);
  console.log("  practicalStats:", JSON.stringify(j1?.data?.practicalStats));
  console.log("  activityCompletion:", JSON.stringify(j1?.data?.activityCompletion));
  console.log("  seasonRecords:", JSON.stringify(j1?.data?.seasonRecords));
  const directVsAdminHttp =
    JSON.stringify(direct?.practicalStats) === JSON.stringify(j1?.data?.practicalStats) &&
    JSON.stringify(direct?.activityCompletion) === JSON.stringify(j1?.data?.activityCompletion) &&
    JSON.stringify(direct?.seasonRecords) === JSON.stringify(j1?.data?.seasonRecords);
  console.log("  direct == admin HTTP ?", directVsAdminHttp ? "✓ 일치" : "✗ 불일치");

  // 3) HTTP admin /api/cluster4/weekly-cards (snapshot-only 경로)
  const r2 = await fetch(`${ADMIN}/api/cluster4/weekly-cards?demoUserId=${U}`, {
    headers: { "x-internal-api-key": KEY },
  });
  const j2: any = await r2.json();
  const rawCards = Array.isArray(j2?.data) ? j2.data : (j2?.data?.cards ?? j2?.cards ?? []);
  const httpCards = rawCards.map((c: any) => ({
    week: c.startDate,
    status: c.userWeekStatus,
    infoLines: (c.lines ?? []).filter((l: any) => l.partType === "information" && l.status !== "void").length,
    den: c.growthDenominator,
    num: c.growthNumerator,
  }));
  console.log("\n── HTTP admin /api/cluster4/weekly-cards:", r2.status, "cards:", httpCards.length);
  const cardsMatch = JSON.stringify(snapInfo) === JSON.stringify(httpCards);
  console.log("  direct snapshot == HTTP cards ?", cardsMatch ? "✓ 일치" : "✗ 불일치");
  if (!cardsMatch) {
    console.log("  direct:", JSON.stringify(snapInfo));
    console.log("  http  :", JSON.stringify(httpCards));
  } else {
    console.log("  cards:", JSON.stringify(httpCards));
  }

  // 4) HTTP front /api/profile (이력서 카드 소비 경로) — dev 컴파일 중 HTML 응답 대비 재시도
  let j3: any = null;
  let r3: Response | null = null;
  for (let i = 0; i < 3; i++) {
    r3 = await fetch(`${FRONT}/api/profile/?userId=${U}`);
    const text = await r3.text();
    try { j3 = JSON.parse(text); break; } catch {
      console.log(`  (front 응답 JSON 아님 — 재시도 ${i + 1}/3)`);
      await new Promise((res) => setTimeout(res, 4000));
    }
  }
  console.log("\n── HTTP front /api/profile:", r3?.status ?? "(no response)");
  console.log("  growthPeriodStats:", JSON.stringify(j3?.growthPeriodStats));
  console.log("  practicalCounts:", JSON.stringify(j3?.practicalCounts));
  console.log("  seasonHistories(요약):", JSON.stringify((j3?.seasonHistories ?? []).map((h: any) => ({
    season: h.seasons?.season_label ?? h.seasonName, approved: h.approved_weeks, total: h.total_weeks,
  }))));
  console.log("  completionRate:", j3?.completionRate);
  // front seasonHistories ← admin seasonRecords 매핑 검증
  const fromAdmin = (direct?.seasonRecords ?? []).map((r) => ({ approved: r.approvedWeeks, total: r.totalWeeks }));
  const fromFront = (j3?.seasonHistories ?? []).map((h: any) => ({ approved: h.approved_weeks, total: h.total_weeks }));
  console.log("  admin seasonRecords == front seasonHistories(approved/total) ?",
    JSON.stringify(fromAdmin) === JSON.stringify(fromFront) ? "✓ 일치" : "✗ 불일치");
}
main().catch((e) => { console.error(e); process.exit(1); });
