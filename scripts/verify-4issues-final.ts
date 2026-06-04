// 4개 문제 수정 최종 검증 — direct vs HTTP(내부키) vs snapshot, 3종 사용자 + 전수 invariant
//   npx tsx scripts/verify-4issues-final.ts
import { config } from "dotenv";
config({ path: ".env.local" });

const T_YDH = "bf3b4305-751a-49e3-88ad-95a20e5c4dad"; // T윤도현 (테스터)
const ADMIN = "http://localhost:3000";

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const KEY = process.env.INTERNAL_API_KEY!;
  const { readWeeklyCardsSnapshot } = await import("../lib/cluster4WeeklyCardsSnapshot");
  const { getWeeklyGrowth } = await import("../lib/cluster4WeeklyGrowthData");
  const { getGrowthIndicatorsInternal } = await import("../lib/cluster3GrowthData");
  const { getCluster1Resume } = await import("../lib/cluster1ResumeData");
  const { isTransitionWeekStart } = await import("../lib/seasonCalendar");

  // 대상: T윤도현 + 일반 유저 1 + 다른 테스터 1
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testers = new Set((markers ?? []).map((m: any) => m.user_id));
  const { data: snaps } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id, dto_version, is_stale, computed_at, card_count");
  const rows = (snaps ?? []) as any[];
  const normal = rows.find((r) => !testers.has(r.user_id) && r.card_count > 0)?.user_id;
  const otherTester = rows.find((r) => testers.has(r.user_id) && r.user_id !== T_YDH && r.card_count > 0)?.user_id;

  console.log("=== snapshot dto_version 분포 ===");
  const dist = new Map<string, number>();
  for (const r of rows) dist.set(`v${r.dto_version}${r.is_stale ? "(stale)" : ""}`, (dist.get(`v${r.dto_version}${r.is_stale ? "(stale)" : ""}`) ?? 0) + 1);
  console.log(JSON.stringify([...dist]), "| total:", rows.length);

  // ── 사용자별 비교 ──
  for (const [label, uid] of [
    ["T윤도현(테스터)", T_YDH],
    ["일반 유저", normal],
    ["다른 테스터", otherTester],
  ] as const) {
    if (!uid) { console.log(`\n### ${label}: 대상 없음`); continue; }
    console.log(`\n### ${label} ${uid.slice(0, 8)} ###`);

    // direct 실시간
    const g = await getWeeklyGrowth(uid);
    const cardsDesc = g?.weeklyCards ?? [];
    const newest = cardsDesc[0];
    const directAcc = newest?.accumulatedApprovedWeeks ?? null;

    // direct cluster3 (a, displayKey)
    const gi = await getGrowthIndicatorsInternal(uid);

    // direct 이력서
    const resume = await getCluster1Resume(uid);
    const seasonList = (resume?.seasonRecords ?? []).map(
      (r) => `${r.year} ${r.seasonName} ${r.approvedWeeks}/${r.totalWeeks} ${r.progressStatus}`,
    );

    // snapshot 저장본
    const snap = await readWeeklyCardsSnapshot(uid);
    const sCards = "cards" in snap ? (snap as any).cards : [];
    const sNewest = sCards[0];

    // HTTP (internal key)
    const res = await fetch(`${ADMIN}/api/cluster4/weekly-cards?userId=${uid}`, {
      headers: { "x-internal-api-key": KEY },
    });
    const json: any = await res.json();
    const hCards = json.data ?? [];
    const hNewest = hCards[0];

    // HTTP demo 경로 (테스터만 성립)
    let dNewest: any = null;
    if (testers.has(uid)) {
      const dRes = await fetch(`${ADMIN}/api/cluster4/weekly-cards?demoUserId=${uid}`);
      const dJson: any = await dRes.json();
      dNewest = (dJson.data ?? [])[0] ?? null;
    }

    // cluster3 stats-cards HTTP
    const c3Res = await fetch(`${ADMIN}/api/cluster3/stats-cards?userId=${uid}`, {
      headers: { "x-internal-api-key": KEY },
    });
    const c3: any = (await c3Res.json()).data ?? null;

    // 이력서 HTTP
    const r1Res = await fetch(`${ADMIN}/api/cluster1/resume?userId=${uid}`, {
      headers: { "x-internal-api-key": KEY },
    });
    const r1: any = (await r1Res.json()).data ?? null;

    console.log("cluster4 누적(direct/snapshot/HTTP/demoHTTP):",
      directAcc, "/", sNewest?.accumulatedApprovedWeeks ?? "-", "/", hNewest?.accumulatedApprovedWeeks ?? "-",
      "/", dNewest ? dNewest.accumulatedApprovedWeeks : "(n/a)");
    console.log("cluster4 라벨(snapshot/HTTP):", JSON.stringify(sNewest?.displayWeekProgressLabel), "/", JSON.stringify(hNewest?.displayWeekProgressLabel));
    console.log("cluster3 a(성공주차)/h/displayKey:", gi.period.a, "/", gi.period.h, "/", gi.process.growthDisplayKey);
    console.log("stats-cards HTTP successWeeks/growthStatus/key:", c3?.period?.successWeeks, "/", JSON.stringify(c3?.process?.growthStatus), "/", c3?.process?.growthStatusKey);
    console.log("이력서 direct 시즌:", JSON.stringify(seasonList));
    console.log("이력서 HTTP 시즌:", JSON.stringify((r1?.seasonRecords ?? []).map((r: any) => `${r.year} ${r.seasonName} ${r.approvedWeeks}/${r.totalWeeks} ${r.progressStatus}`)));
    const match =
      directAcc === sNewest?.accumulatedApprovedWeeks &&
      directAcc === hNewest?.accumulatedApprovedWeeks &&
      (!dNewest || directAcc === dNewest.accumulatedApprovedWeeks) &&
      directAcc === gi.period.a &&
      gi.period.a === c3?.period?.successWeeks;
    console.log(match ? "✅ 누적 주차 SoT 일치 (direct=snapshot=HTTP=demo=cluster3)" : "❌ 불일치!");

    // W14(2026-06-01) 휴식/라인 검증
    const w14 = hCards.find((c: any) => c.startDate === "2026-06-01");
    if (w14) {
      const editable = (w14.lines ?? []).filter((l: any) => l.canEdit);
      const opened = (w14.lines ?? []).filter((l: any) => l.status !== "void" && l.statusLabel !== "미개설");
      console.log(`W14: status=${w14.userWeekStatus} isRest=${w14.isRestWeek} growth=${w14.growthNumerator}/${w14.growthDenominator} canEdit라인=${editable.length} 개설라인=${opened.length}`,
        w14.userWeekStatus === "official_rest" && w14.isRestWeek && editable.length === 0 && opened.length === 0 ? "✅" : "❌");
      if (dNewest) {
        const dRes2 = await fetch(`${ADMIN}/api/cluster4/weekly-cards?demoUserId=${uid}`);
        const dJson2: any = await dRes2.json();
        const dW14 = (dJson2.data ?? []).find((c: any) => c.startDate === "2026-06-01");
        const same = JSON.stringify(dW14) === JSON.stringify(w14);
        console.log("W14 demo HTTP == internal HTTP:", same ? "✅ 동일" : "❌ 다름");
      }
    } else console.log("W14 카드 없음");
  }

  // ── 전수 invariant: 모든 snapshot 사용자 — 최신 카드 acc == fold(success, 전환제외) ──
  console.log("\n=== 전수 invariant (acc == snapshot 카드 success 수·전환제외, verdict 반영) ===");
  let ok = 0, bad = 0;
  for (const r of rows) {
    if (r.card_count === 0) { ok++; continue; }
    const s = await readWeeklyCardsSnapshot(r.user_id);
    const cs = "cards" in s ? (s as any).cards : [];
    if (cs.length === 0) { ok++; continue; }
    const newest = cs[0];
    const successCnt = cs.filter(
      (c: any) => c.userWeekStatus === "success" && !isTransitionWeekStart(c.startDate),
    ).length;
    if (newest.accumulatedApprovedWeeks === successCnt) ok++;
    else {
      bad++;
      if (bad <= 8) console.log(`  ❌ ${r.user_id.slice(0, 8)} acc=${newest.accumulatedApprovedWeeks} successCnt=${successCnt}`);
    }
  }
  console.log(`invariant 일치 ${ok} / 불일치 ${bad}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
