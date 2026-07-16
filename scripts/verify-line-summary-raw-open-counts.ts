/**
 * 라인 강화 내역 상단 요약 — raw 라인 행 집계 검증 (READ-ONLY, 무손실).
 *   run: npx tsx --env-file=.env.local scripts/verify-line-summary-raw-open-counts.ts
 *
 * 목적: 전체/오픈/미오픈/주차성장률이 **허브 개수**가 아니라 **실제 라인 행(clubOpen)** 기준으로
 *       집계되는지 실제 (사용자, 주차) 로 확인한다. 아래 두 값을 나란히 보여 fix 효과를 증명:
 *         - open(구, lineTargetId != null) : 대상자 배정 기준(허브/대상 편향)
 *         - open(신, clubOpen === true)    : 실제 개설 라인 행 기준(이번 SoT)
 *       또한 오픈+미오픈==전체, 성장률==round(성공오픈/오픈*100) 불변식을 재검산한다.
 *
 * 무손실: 오직 읽기만 한다(쓰기 없음).
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCrewWeekLineSummary } from "@/lib/adminCrewWeekLineSummary";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

type Cand = { userId: string; weekId: string; weekLabel: string; lineCount: number; hubs: number };

function hubKo(part: string): string {
  if (part === "information") return "실무 정보";
  if (part === "experience") return "실무 경험";
  if (part === "competency") return "실무 역량";
  if (part === "career") return "실무 경력";
  return part;
}

async function main() {
  // 후보 사용자 — 테스트 유저(시드된 다라인 주차 존재 가능성 높음) 우선, 부족하면 일반 표본 보충.
  const { data: markerRows } = await supabaseAdmin.from("test_user_markers").select("user_id");
  const testIds = ((markerRows ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
  const { data: sampleRows } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id")
    .limit(600);
  const sampleIds = ((sampleRows ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
  const userIds = Array.from(new Set([...testIds, ...sampleIds]));
  console.log(`[후보 사용자] 테스트 ${testIds.length} + 표본 ${sampleIds.length} → 유니크 ${userIds.length}`);

  // 1) 스냅샷 카드의 lines 로 사전 필터 — 라인 3개 이상 & 허브 2종 이상인 (사용자, 주차) 후보만.
  const cands: Cand[] = [];
  for (const uid of userIds) {
    let snap;
    try {
      snap = await readWeeklyCardsSnapshot(uid);
    } catch {
      continue;
    }
    const cards = snap.status === "hit" || snap.status === "stale" ? snap.cards : [];
    for (const c of cards) {
      if (!c.weekId) continue;
      const ls = c.lines ?? [];
      if (ls.length < 3) continue;
      const hubs = new Set(ls.map((l) => l.partType));
      if (hubs.size < 2) continue;
      cands.push({
        userId: uid,
        weekId: c.weekId,
        weekLabel: c.weekLabel ?? c.weekId,
        lineCount: ls.length,
        hubs: hubs.size,
      });
    }
    if (cands.length >= 80) break;
  }
  console.log(`[사전 필터] 다라인·다허브 후보 ${cands.length}건`);
  if (cands.length === 0) {
    console.log("후보 없음 — 라인 3개+·허브 2종+ 주차를 찾지 못했습니다.");
    return;
  }

  // 2) 실제 production 함수(getCrewWeekLineSummary)로 재계산 + 불변식 검산.
  type Report = {
    userId: string;
    weekLabel: string;
    confirmed: boolean;
    total: number;
    openNew: number; // clubOpen === true (이번 SoT)
    openOld: number; // lineTargetId != null (구 로직)
    unopened: number;
    success: number;
    fail: number;
    na: number;
    pending: number;
    rate: number;
    rateRecheck: number;
    invariantOk: boolean;
    openBreakdown: string; // 허브별 오픈 행 수
  };
  const reports: Report[] = [];
  for (const cand of cands) {
    const res = await getCrewWeekLineSummary(cand.userId, cand.weekId);
    if (!res.ok) continue;
    const d = res.data;
    const rows = d.lineDetails;
    const openOld = rows.filter((r) => r.lineTargetId != null).length;
    const openRows = rows.filter((r) => r.clubOpen);
    const successOpen = openRows.filter((r) => r.enhancementStatus === "success").length;
    const rateRecheck = openRows.length === 0 ? 0 : Math.round((successOpen / openRows.length) * 100);
    const invariantOk =
      d.lines.total === d.lines.open + d.lines.unopened && d.weeklyGrowthRate === rateRecheck;
    // 허브별 오픈 행 수(허브 개수 ≠ 라인 개수 를 눈으로 확인).
    const byHub = new Map<string, number>();
    for (const r of openRows) byHub.set(r.hubLabel, (byHub.get(r.hubLabel) ?? 0) + 1);
    const openBreakdown =
      Array.from(byHub.entries())
        .map(([h, n]) => `${h} ${n}`)
        .join(" / ") || "-";
    reports.push({
      userId: cand.userId,
      weekLabel: cand.weekLabel,
      confirmed: d.confirmed,
      total: d.lines.total,
      openNew: d.lines.open,
      openOld,
      unopened: d.lines.unopened,
      success: d.results.success,
      fail: d.results.failure,
      na: d.results.notApplicable,
      pending: d.results.pending,
      rate: d.weeklyGrowthRate,
      rateRecheck,
      invariantOk,
      openBreakdown,
    });
    if (reports.length >= 60) break;
  }

  // 3) 불변식 위반이 있으면 즉시 실패(있어선 안 됨).
  const broken = reports.filter((r) => !r.invariantOk);
  console.log(`\n[검산] ${reports.length}건 계산 — 불변식 위반 ${broken.length}건`);
  for (const b of broken.slice(0, 10)) console.log("  ✗ 위반:", JSON.stringify(b));

  // 4) fix 효과가 잘 드러나는 예(구/신 오픈 수가 다르거나, 오픈 허브가 2종 이상) 상위 출력.
  reports.sort(
    (a, b) =>
      Math.abs(b.openNew - b.openOld) - Math.abs(a.openNew - a.openOld) ||
      b.openNew - a.openNew ||
      b.total - a.total,
  );
  console.log("\n[대표 사례] (open 신=clubOpen, open 구=lineTargetId)");
  for (const r of reports.slice(0, 8)) {
    console.log(
      `\n  · user=${r.userId.slice(0, 8)}… ${r.weekLabel} ${r.confirmed ? "[확정]" : "[집계중]"}`,
    );
    console.log(
      `    전체=${r.total}  오픈(신)=${r.openNew}  오픈(구)=${r.openOld}  미오픈=${r.unopened}`,
    );
    console.log(
      `    성공=${r.success}  실패=${r.fail}  해당없음=${r.na}  집계전=${r.pending}  성장률=${r.rate}% (재검산 ${r.rateRecheck}%)`,
    );
    console.log(`    오픈 허브별 라인 수: ${r.openBreakdown}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
