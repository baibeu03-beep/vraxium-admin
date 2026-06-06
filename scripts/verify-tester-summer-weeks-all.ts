/**
 * 2025-summer 추가 활동 주차 전체 적용(6명) 검증 (2026-06-06, read-only).
 *
 *   npx tsx --env-file=.env.local scripts/verify-tester-summer-weeks-all.ts
 *
 * 항목(사용자 지정 10건):
 *   1~3) direct vs HTTP 일치 — admin stats-cards · admin resume · front weekly-growth
 *   4) growth_status graduated 복원 (+ activity_ended_at 원값)
 *   5) 표시 a >= 30
 *   6) 이력서 "정상 졸업" 1건 + 25 여름 "8/8 정상 완료"
 *   7) front "시즌 중 졸업"
 *   8) snapshot is_stale=false + 여름 카드 8장 success
 *   9) 실사용자 지문 diff=0 (apply 로그 fpBefore 와 비교)
 *   10) front weekly-growth demoUserId 부착/미부착 응답 동일
 *   + 최종 표: approved/cumulative(표시·캐시)/growth_status
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import { readFileSync } from "fs";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const ADMIN_BASE = process.env.DIAG_ADMIN_BASE ?? "https://vraxium-admin.vercel.app";
const FRONT_BASE = process.env.DIAG_FRONT_BASE ?? "https://vraxium.vercel.app";
const INTERNAL_KEY = process.env.INTERNAL_API_KEY!;
const LOG_PATH = "claudedocs/tester-summer-weeks-20260606.json";

const SIX = [
  ["T윤도현", "bf3b4305-751a-49e3-88ad-95a20e5c4dad", "encre", null],
  ["T임다인", "42864260-e4ea-4150-a87f-cff545b02af1", "encre", "2026-05-19"],
  ["T장유준", "4a81b6d1-e488-4f14-8530-0cad60fe4f0d", "encre", "2026-05-12"],
  ["T윤태현", "05ff6b96-b3e7-4050-97f1-080633f183d3", "phalanx", null],
  ["T임건우", "e4dcb97e-a515-4ec5-a91e-32ca4e629dae", "phalanx", "2026-05-19"],
  ["T장시현", "cc1b58e6-b14d-45a0-b389-2df3c27a0b25", "phalanx", "2026-05-12"],
] as const;
const KEPT = [
  ["T류민서", "63813dc4-9dec-4511-83be-1f54196d09cf"],
  ["T송태현", "1a0b0f9e-4e10-4d06-aa56-6d26ee4b203a"],
  ["T홍지환", "e6574586-6279-41cc-ae36-1c9dc3078bc3"],
] as const;

let pass = 0,
  fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

async function pageAll<T>(
  table: string,
  select: string,
  filter?: (q: any) => any,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(select).order("user_id", { ascending: true }).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function realUserFingerprint(excludeIds: Set<string>): Promise<string> {
  const [uws, profiles, points, snaps] = await Promise.all([
    pageAll<any>("user_week_statuses", "user_id,week_start_date,status"),
    pageAll<any>("user_profiles", "user_id,growth_status,activity_started_at,activity_ended_at"),
    pageAll<any>("user_weekly_points", "user_id,year,week_number,points"),
    pageAll<any>("cluster4_weekly_card_snapshots", "user_id,is_stale"),
  ]);
  const pick = (rows: any[]) => rows.filter((r) => !excludeIds.has(r.user_id));
  const u = pick(uws).map((r) => `${r.user_id}|${r.week_start_date}|${r.status}`).sort();
  const p = pick(profiles).map((r) => `${r.user_id}|${r.growth_status}|${r.activity_started_at}|${r.activity_ended_at}`).sort();
  const w = pick(points).map((r) => `${r.user_id}|${r.year}|${r.week_number}|${r.points}`).sort();
  const s = pick(snaps).map((r) => `${r.user_id}|${r.is_stale}`).sort();
  return createHash("sha256").update([u.join("\n"), p.join("\n"), w.join("\n"), s.join("\n")].join("\n#\n")).digest("hex");
}

async function main() {
  const { GRADUATION_THRESHOLDS } = await import("@/lib/pointLabels");
  const { getGrowthIndicatorsInternal } = await import("@/lib/cluster3GrowthData");
  const { getCluster1Resume } = await import("@/lib/cluster1ResumeData");

  type Final = {
    name: string;
    org: string;
    displayA: number;
    displayH: number;
    cacheApproved: number | null;
    cacheCumulative: number | null;
    growth_status: string | null;
    ended: string | null;
  };
  const finals: Final[] = [];

  for (const [name, uid, org, endedExpect] of SIX) {
    console.log(`\n===== ${name} (${org}) =====`);
    const thr = (GRADUATION_THRESHOLDS as Record<string, number>)[org];

    // direct
    const ind = await getGrowthIndicatorsInternal(uid);
    const direct = await getCluster1Resume(uid);
    const dGrad = direct.seasonRecords.filter((x: any) => x.progressStatus === "정상 졸업");
    const dSummer = direct.seasonRecords.find((x: any) => x.year === "25" && String(x.seasonName).includes("여름"));

    // 5) a == 30 (임계 정확 일치 — 과보정 해소 목표값)
    check(`5) a(${ind.period.a}) == 30 (>= ${thr})`, ind.period.a === 30 && ind.period.a >= thr, `h=${ind.period.h}`);

    // 4) graduated + ended 원값
    const { data: p } = await sb
      .from("user_profiles")
      .select("growth_status,activity_started_at,activity_ended_at")
      .eq("user_id", uid)
      .single();
    const endedOk = endedExpect === null ? p?.activity_ended_at === null : Boolean(p?.activity_ended_at?.startsWith(endedExpect));
    check(
      `4) graduated 복원 + ended=${endedExpect ?? "null"}`,
      p?.growth_status === "graduated" && endedOk && ind.process.growthDisplayKey === "graduated",
      `status=${p?.growth_status} key=${ind.process.growthDisplayKey} ended=${p?.activity_ended_at ?? "null"}`,
    );

    // 6) 이력서 direct
    check(`6) direct 정상 졸업 1건`, dGrad.length === 1, dGrad.map((x: any) => `${x.year} ${x.seasonName}`).join(","));
    check(
      `6) direct 25 여름 4/8 정상 완료`,
      Boolean(dSummer) && dSummer.approvedWeeks === 4 && dSummer.totalWeeks === 8 && dSummer.progressStatus === "정상 완료",
      dSummer ? `${dSummer.approvedWeeks}/${dSummer.totalWeeks} ${dSummer.progressStatus}` : "(행 없음)",
    );

    // 1~3) HTTP — admin stats-cards / admin resume / front weekly-growth
    const r1 = await fetch(`${ADMIN_BASE}/api/cluster3/stats-cards?userId=${uid}`, {
      headers: { "x-internal-api-key": INTERNAL_KEY },
    });
    const j1: any = await r1.json().catch(() => null);
    check(
      `1~3) admin stats-cards HTTP==direct (graduated)`,
      j1?.data?.process?.growthStatusKey === ind.process.growthDisplayKey,
      `HTTP=${j1?.data?.process?.growthStatusKey}`,
    );

    const r2 = await fetch(`${ADMIN_BASE}/api/cluster1/resume?userId=${uid}`, {
      headers: { "x-internal-api-key": INTERNAL_KEY },
    });
    const j2: any = await r2.json().catch(() => null);
    const hRecs: any[] = j2?.data?.seasonRecords ?? [];
    const hGrad = hRecs.filter((x) => x.progressStatus === "정상 졸업");
    const hSummer = hRecs.find((x) => x.year === "25" && String(x.seasonName).includes("여름"));
    check(`1~3) admin resume HTTP==direct (정상 졸업 ${dGrad.length}건)`, hGrad.length === dGrad.length, `HTTP=${hGrad.length}`);
    check(
      `1~3) admin resume HTTP 25 여름 4/8 정상 완료`,
      Boolean(hSummer) && hSummer.approvedWeeks === 4 && hSummer.totalWeeks === 8 && hSummer.progressStatus === "정상 완료",
      hSummer ? `${hSummer.approvedWeeks}/${hSummer.totalWeeks} ${hSummer.progressStatus}` : "(행 없음)",
    );

    const r3 = await fetch(`${FRONT_BASE}/api/cluster4/weekly-growth?userId=${uid}`);
    const j3: any = await r3.json().catch(() => null);
    const sums: any[] = j3?.data?.seasonSummaries ?? [];
    // 7) 시즌 중 졸업 + 여름 시즌 성공
    check(
      `7) front "시즌 중 졸업" + 2025-summer 시즌 성공`,
      sums.some((s) => s.statusLabel === "시즌 중 졸업") &&
        sums.find((s) => s.seasonKey === "2025-summer")?.statusLabel === "시즌 성공",
      sums.map((s) => `${s.seasonKey}:${s.statusLabel}`).join(" / "),
    );

    // 10) demoUserId 부착/미부착 동일
    const r4 = await fetch(`${FRONT_BASE}/api/cluster4/weekly-growth?userId=${uid}&demoUserId=${uid}`);
    const j4: any = await r4.json().catch(() => null);
    const sums2: any[] = j4?.data?.seasonSummaries ?? [];
    check(
      `10) demoUserId 부착==미부착 (weekly-growth)`,
      JSON.stringify(sums) === JSON.stringify(sums2),
      `labels2=${sums2.map((s) => `${s.seasonKey}:${s.statusLabel}`).join("/")}`,
    );

    // 8) snapshot
    const { data: snap } = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("is_stale,computed_at,cards")
      .eq("user_id", uid)
      .single();
    const cards: any[] = Array.isArray((snap as any)?.cards) ? (snap as any).cards : [];
    const summerCards = cards.filter((c) => c?.seasonKey === "2025-summer");
    const summerSuccess = summerCards.filter((c) => c?.userWeekStatus === "success");
    check(
      `8) snapshot stale=false + 여름 4장 success (W5~8 카드 소멸)`,
      snap?.is_stale === false && summerCards.length === 4 && summerSuccess.length === 4,
      `stale=${snap?.is_stale} cards=${summerCards.length}/${summerSuccess.length} computed=${snap?.computed_at}`,
    );

    const { data: gs } = await sb
      .from("user_growth_stats")
      .select("approved_weeks,cumulative_weeks")
      .eq("user_id", uid)
      .single();
    finals.push({
      name,
      org,
      displayA: ind.period.a,
      displayH: ind.period.h,
      cacheApproved: gs?.approved_weeks ?? null,
      cacheCumulative: gs?.cumulative_weeks ?? null,
      growth_status: p?.growth_status ?? null,
      ended: p?.activity_ended_at ?? null,
    });
  }

  // 9) 실사용자 지문
  console.log(`\n===== 9) 실사용자 지문 (대상 6명 제외) =====`);
  const fp = await realUserFingerprint(new Set(SIX.map((s) => s[1])));
  const fileLog = JSON.parse(readFileSync(LOG_PATH, "utf8"));
  const lastRun = fileLog.runs[fileLog.runs.length - 1];
  check(`9) hash == apply 직전`, fp === lastRun?.fpBefore?.hash, `now=${fp.slice(0, 16)}…`);

  // 유지조 3명 회귀
  console.log(`\n===== 비대상(oranke 유지 3명) 회귀 =====`);
  const { getGrowthIndicatorsInternal: g2 } = await import("@/lib/cluster3GrowthData");
  for (const [name, uid] of KEPT) {
    const k = await g2(uid);
    check(`${name} graduated·a=26 유지`, k.process.growthDisplayKey === "graduated" && k.period.a === 26, `a=${k.period.a}`);
  }

  // 최종 표
  console.log(`\n===== 최종 표 (표시 a/h · 캐시 approved/cumulative · 상태) =====`);
  for (const f of finals) {
    console.log(
      `  ${f.name} [${f.org}] a=${f.displayA} h=${f.displayH} | cache=${f.cacheApproved}/${f.cacheCumulative} | ${f.growth_status} | ended=${f.ended ?? "null"}`,
    );
  }

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
