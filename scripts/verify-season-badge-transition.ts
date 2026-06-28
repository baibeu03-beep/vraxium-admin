/**
 * /cluster-4-1 시즌 상세 카드 status badge — 06-28 vs 06-29 전환 검증 (READ-ONLY).
 *
 * SoT 체인(브라우저 → 프론트 라우트):
 *   GET (front:3001) /api/cluster4/weekly-growth?userId=X
 *     → buildSeasonSummaries() → deriveSeasonStatus(): 과거시즌(today>endDate)은
 *       admin /api/cluster1/resume seasonRecords[].progressStatus 로 판정.
 *   배지 = SEASON_STATUS_TEXT[seasonSummaryToSeasonKey(seasonSummaries[page])].
 *
 *   FRONT=http://localhost:3001 ADMIN=http://localhost:3000 npx tsx --env-file=.env.local \
 *     scripts/verify-season-badge-transition.ts <userId>
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const FRONT = process.env.FRONT || "http://localhost:3001";
const ADMIN = process.env.ADMIN || "http://localhost:3000";
const KEY = process.env.INTERNAL_API_KEY || "";

// ── front route deriveSeasonStatus() 의 "과거/현재 시즌" 분기 1:1 복제(순수함수, 추측 아님) ──
function deriveSeasonStatus(isCurrent: boolean, endDate: string | null, today: string, resumeProgressStatus: string | null, currentSeasonRest: boolean, currentSeasonStopped: boolean) {
  if (resumeProgressStatus === "정상 졸업") return { statusLabel: "시즌 중 졸업", seasonResult: "graduated" };
  let status: string, seasonResult: string;
  if (isCurrent) {
    if (currentSeasonStopped) { status = "ended"; seasonResult = "failed"; }
    else if (currentSeasonRest) { status = "rest"; seasonResult = "none"; }
    else { status = "active"; seasonResult = "none"; }
  } else if (endDate && today > endDate) {
    if (resumeProgressStatus === "활동 중단") { status = "ended"; seasonResult = "failed"; }
    else if (resumeProgressStatus === "통합 휴식") { status = "rest"; seasonResult = "none"; }
    else { status = "ended"; seasonResult = "success"; }
  } else { status = "active"; seasonResult = "none"; }
  const statusLabel = status === "active" ? "시즌 진행 중" : status === "rest" ? "시즌 휴식" : seasonResult === "success" ? "시즌 성공" : seasonResult === "failed" ? "시즌 중단" : "시즌 휴식";
  return { statusLabel, seasonResult, status };
}

async function main() {
  const userId = (process.argv[2] || "b09b2559-249c-4358-a1f4-f89132db854c").trim();
  const { data: prof } = await supabaseAdmin.from("user_profiles").select("display_name").eq("user_id", userId).maybeSingle();
  console.log(`대상: ${prof?.display_name ?? userId} (${userId})\n`);

  // (A) 실제 HTTP — front route (실서버 시계 = 오늘 06-28)
  const r = await fetch(`${FRONT}/api/cluster4/weekly-growth?userId=${userId}`);
  const j: any = await r.json();
  const summaries: any[] = Array.isArray(j?.data?.seasonSummaries) ? j.data.seasonSummaries : [];
  console.log("=== (A) 실제 HTTP front /api/cluster4/weekly-growth (오늘 시계) ===");
  console.log("  status", r.status, "| seasonSummaries 개수:", summaries.length);
  for (const s of summaries) {
    console.log(`   [${s.seasonKey}] status=${s.status} seasonResult=${s.seasonResult} statusLabel="${s.statusLabel}" end=${s.endDate} isCurrentByGate=${(s.startDate<=httpToday()&&httpToday()<=s.endDate)}`);
  }
  const springHttp = summaries.find((s) => s.seasonKey === "2026-spring") ?? null;
  console.log("  → 2026-spring 배지(HTTP, 오늘):", springHttp ? `"${springHttp.statusLabel}"` : "MISSING");

  // (B) resume SoT — admin /api/cluster1/resume seasonRecords progressStatus
  const rr = await fetch(`${ADMIN}/api/cluster1/resume?userId=${userId}`, { headers: { "x-internal-api-key": KEY } });
  const jr: any = await rr.json();
  const records: any[] = jr?.success ? (jr?.data?.seasonRecords ?? []) : [];
  const nameToType: Record<string,string> = { 봄:"spring", 여름:"summer", 가을:"autumn", 겨울:"winter" };
  const resumeMap = new Map<string,string>();
  for (const rec of records) {
    const token = String(rec?.seasonName ?? "").replace(/\s*시즌\s*$/, "").trim();
    const type = nameToType[token]; const yy = String(rec?.year ?? "");
    if (type && /^\d{2}$/.test(yy) && rec?.progressStatus) resumeMap.set(`20${yy}-${type}`, String(rec.progressStatus));
  }
  console.log("\n=== (B) admin resume seasonRecords progressStatus ===");
  console.log("  status", rr.status, "| spring progressStatus =", resumeMap.get("2026-spring") ?? "(없음→default 성공)");

  // (C) direct 재현: deriveSeasonStatus(2026-spring, endDate=2026-06-28) — today 06-28 vs 06-29
  const springEnd = springHttp?.endDate ?? "2026-06-28";
  const springStart = springHttp?.startDate ?? "2026-03-02";
  const resumeSpring = resumeMap.get("2026-spring") ?? null;
  const cur28 = springStart <= "2026-06-28" && "2026-06-28" <= springEnd;
  const cur29 = springStart <= "2026-06-29" && "2026-06-29" <= springEnd;
  const d28 = deriveSeasonStatus(cur28, springEnd, "2026-06-28", resumeSpring, false, false);
  const d29 = deriveSeasonStatus(cur29, springEnd, "2026-06-29", resumeSpring, false, false);
  console.log("\n=== (C) direct 재현(deriveSeasonStatus 복제) — 2026-spring ===");
  console.log(`  endDate=${springEnd} resumeProgressStatus=${resumeSpring ?? "(none)"}`);
  console.log(`  today=2026-06-28: isCurrent=${cur28} → 배지 "${d28.statusLabel}"`);
  console.log(`  today=2026-06-29: isCurrent=${cur29} → 배지 "${d29.statusLabel}"`);

  // (D) direct==HTTP (오늘)
  console.log("\n=== (D) direct == HTTP (오늘 06-28) ===");
  console.log(`  HTTP="${springHttp?.statusLabel}"  direct="${d28.statusLabel}"  일치:`, springHttp?.statusLabel === d28.statusLabel);
  console.log("\n=== 결론 ===");
  console.log(`  06-28 → "${d28.statusLabel}"  /  06-29 → "${d29.statusLabel}"  (자동 변경:`, d28.statusLabel !== d29.statusLabel ? "예)" : "아니오)");
  process.exit(0);
}
function httpToday() { return new Date().toISOString().slice(0,10); }
main().catch((e) => { console.error(e); process.exit(1); });
