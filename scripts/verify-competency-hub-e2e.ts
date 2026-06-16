// 실 함수 E2E: openCompetencyHub / cancelCompetencyHub (실무 역량 [개설 완료]/[개설 취소]) 가
//   대상 크루의 고객 snapshot 을 개설 직후 자동 재계산(invalidate)하는지 검증한다.
//   phalanx test W13 의 현재 상태 = 4 크루 opened. 다음 사이클을 돌려 원상복구한다:
//     ① cancel  → opened 4건 pending 환원 + opened 라인 삭제 + 크루 snapshot recompute(라인 사라짐)
//     ② open    → approved 4건 재개설 + 라인 재생성 + 크루 snapshot recompute(라인 다시 반영)
//   검증: 각 단계 후 크루 snapshot 이 is_stale=false(자동 recompute) + 역량 라인 노출 여부가
//   토글된다(고객 반영). 시작==종료 상태(4 opened). 운영 데이터 무접촉(test 스코프 · org=phalanx).
// 사용법: npx tsx --env-file=.env.local scripts/verify-competency-hub-e2e.ts
import { createClient } from "@supabase/supabase-js";
import {
  openCompetencyHub,
  cancelCompetencyHub,
  getCompetencyOpeningStatus,
} from "../lib/adminCompetencyLineOpening";
import { readWeeklyCardsSnapshot } from "../lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const WEEK_ID = "a2112b50-64d2-42d6-a243-faf9fcdc6ffc";
const ORG = "phalanx";

let pass = 0, fail = 0;
const check = (l: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};

// 크루의 W13 카드에 (배정된) competency 라인 컨텐츠가 보이는지 + snapshot 메타.
async function crewW13(u: string) {
  const r = await readWeeklyCardsSnapshot(u);
  const cards = (r as any).cards ?? [];
  const c = cards.find((x: any) => x.weekId === WEEK_ID);
  const compLines = (c?.lines ?? []).filter((ln: any) => ln.partType === "competency");
  // 배정된(본인 타깃) 역량 라인 = status !== 'void' (보이드는 미배정/미개설 placeholder).
  const assignedComp = compLines.filter((ln: any) => ln.status !== "void");
  const { data: meta } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("is_stale,computed_at")
    .eq("user_id", u)
    .maybeSingle();
  return {
    status: (r as any).status as string,
    compLineCount: compLines.length,
    assignedCompCount: assignedComp.length,
    isStale: (meta as any)?.is_stale,
    computedAt: (meta as any)?.computed_at as string | undefined,
  };
}

async function openedTargets(): Promise<string[]> {
  const { data } = await sb
    .from("cluster4_competency_applications")
    .select("target_user_id,resolution")
    .eq("organization_slug", ORG)
    .eq("week_id", WEEK_ID);
  return ((data ?? []) as any[]).filter((r) => r.resolution === "opened").map((r) => r.target_user_id);
}
async function approvedCount(): Promise<{ opened: number; pending: number; rejected: number }> {
  const { data } = await sb
    .from("cluster4_competency_applications")
    .select("resolution")
    .eq("organization_slug", ORG)
    .eq("week_id", WEEK_ID);
  const rows = (data ?? []) as any[];
  const c = (v: string) => rows.filter((r) => r.resolution === v).length;
  return { opened: c("opened"), pending: c("pending"), rejected: c("rejected") };
}

async function main() {
  // 시작 상태 캡처.
  const crews = await openedTargets();
  const startCounts = await approvedCount();
  console.log(`\n시작 상태: ${JSON.stringify(startCounts)} | opened 크루 ${crews.length}명`);
  console.log(`크루: ${crews.join(", ")}`);
  if (crews.length === 0) { console.log("opened 크루 없음 — 중단"); process.exit(1); }

  const before = new Map<string, Awaited<ReturnType<typeof crewW13>>>();
  for (const u of crews) before.set(u, await crewW13(u));
  for (const u of crews) {
    const b = before.get(u)!;
    console.log(`  [before] ${u}: assignedComp=${b.assignedCompCount} isStale=${b.isStale} status=${b.status}`);
  }

  try {
    // ── ① 개설 취소 ──
    console.log("\n## ① cancelCompetencyHub(phalanx,test) ##");
    const cancelRes = await cancelCompetencyHub({ organization: ORG, adminId: null, mode: "test" });
    console.log("  result:", JSON.stringify(cancelRes));
    const afterCancelCounts = await approvedCount();
    check("취소 후 opened=0 · 신청은 pending 환원(명단 보존)",
      afterCancelCounts.opened === 0 && afterCancelCounts.pending >= crews.length,
      JSON.stringify(afterCancelCounts));
    for (const u of crews) {
      const a = await crewW13(u);
      check(`취소 후 ${u.slice(0, 8)} snapshot 자동 recompute(is_stale=false)`, a.isStale === false,
        `computed ${before.get(u)!.computedAt} → ${a.computedAt}`);
      check(`취소 후 ${u.slice(0, 8)} 배정 역량 라인 사라짐(고객 반영)`,
        a.assignedCompCount < before.get(u)!.assignedCompCount || a.assignedCompCount === 0,
        `assignedComp ${before.get(u)!.assignedCompCount}→${a.assignedCompCount}`);
    }

    // ── ② 개설 완료(원복) ──
    console.log("\n## ② openCompetencyHub(phalanx,test) ##");
    const openRes = await openCompetencyHub({ organization: ORG, adminId: null, mode: "test" });
    console.log("  result:", JSON.stringify(openRes));
    const afterOpenCounts = await approvedCount();
    check("재개설 후 opened 복원(시작과 동일 크루 수)",
      afterOpenCounts.opened === startCounts.opened, JSON.stringify(afterOpenCounts));
    const reopened = await openedTargets();
    for (const u of reopened) {
      const a = await crewW13(u);
      check(`재개설 후 ${u.slice(0, 8)} snapshot 자동 recompute(is_stale=false)`, a.isStale === false);
      check(`재개설 후 ${u.slice(0, 8)} 배정 역량 라인 다시 반영(고객 노출)`, a.assignedCompCount >= 1,
        `assignedComp=${a.assignedCompCount}`);
    }
  } finally {
    const end = await approvedCount();
    const st = await getCompetencyOpeningStatus(ORG, "test");
    console.log(`\n[종료 상태] ${JSON.stringify(end)} | opened=${st.opened}`);
    check("종료==시작(원상복구: opened 크루 수 동일)", end.opened === startCounts.opened,
      `start opened=${startCounts.opened}, end opened=${end.opened}`);
  }

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exit(1); });
