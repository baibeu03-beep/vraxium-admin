/**
 * graduated 테스터 졸업 기준 보정 검증 (2026-06-05, apply-graduated-tester-threshold-fix 후속).
 *
 *   npx tsx --env-file=.env.local scripts/verify-graduated-threshold-fix.ts
 *
 * 검증 항목:
 *   1) 전 graduated 사용자: graduated ⇔ a >= 조직임계 일치 (테스터·실사용자 공통 invariant)
 *   2) 강등 6명: growth_status=active / 표시 키=active(성장 중) / ended_at=null
 *   3) direct(getGrowthIndicatorsInternal·getCluster1Resume) vs 운영 HTTP 응답 일치
 *      — admin /api/cluster3/stats-cards · /api/cluster1/resume · front weekly-growth
 *   4) 강등자 이력서 "정상 졸업" 행 0건 / 유지자(T홍지환) 1건
 *   5) front weekly-growth: 강등자 "시즌 중 졸업" 라벨 소멸, 유지자 유지
 *   6) weekly-cards snapshot: 강등 6명 is_stale=false 유지 (growth_status 는 snapshot
 *      비포함 → 재계산 불필요 검증)
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const ADMIN_BASE = process.env.DIAG_ADMIN_BASE ?? "https://vraxium-admin.vercel.app";
const FRONT_BASE = process.env.DIAG_FRONT_BASE ?? "https://vraxium.vercel.app";
const INTERNAL_KEY = process.env.INTERNAL_API_KEY!;

const DEMOTED = [
  ["T윤도현", "bf3b4305-751a-49e3-88ad-95a20e5c4dad", "encre"],
  ["T임다인", "42864260-e4ea-4150-a87f-cff545b02af1", "encre"],
  ["T장유준", "4a81b6d1-e488-4f14-8530-0cad60fe4f0d", "encre"],
  ["T윤태현", "05ff6b96-b3e7-4050-97f1-080633f183d3", "phalanx"],
  ["T임건우", "e4dcb97e-a515-4ec5-a91e-32ca4e629dae", "phalanx"],
  ["T장시현", "cc1b58e6-b14d-45a0-b389-2df3c27a0b25", "phalanx"],
] as const;
const KEPT = [
  ["T류민서", "63813dc4-9dec-4511-83be-1f54196d09cf", "oranke"],
  ["T송태현", "1a0b0f9e-4e10-4d06-aa56-6d26ee4b203a", "oranke"],
  ["T홍지환", "e6574586-6279-41cc-ae36-1c9dc3078bc3", "oranke"],
] as const;

let pass = 0,
  fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

async function main() {
  const { GRADUATION_THRESHOLDS } = await import("@/lib/pointLabels");
  const { getGrowthIndicatorsInternal } = await import("@/lib/cluster3GrowthData");
  const { getCluster1Resume } = await import("@/lib/cluster1ResumeData");

  // ── 1) 전 graduated 사용자 invariant: graduated ⇔ a >= 임계 ─────────
  console.log("=== 1) graduated ⇔ 기준충족 invariant (전수) ===");
  const { data: gradRows, error: gErr } = await sb
    .from("user_profiles")
    .select("user_id,display_name,organization_slug")
    .eq("growth_status", "graduated");
  if (gErr) throw new Error(gErr.message);
  check(`graduated 총원 3명(oranke 유지조)`, (gradRows ?? []).length === 3, `실제=${gradRows?.length}`);
  for (const r of gradRows ?? []) {
    const thr = (GRADUATION_THRESHOLDS as Record<string, number>)[r.organization_slug ?? ""];
    const ind = await getGrowthIndicatorsInternal(r.user_id);
    check(
      `${r.display_name}(${r.organization_slug}) a=${ind.period.a} >= ${thr}`,
      thr !== undefined && ind.period.a >= thr,
    );
  }

  // ── 2) 강등 6명 direct 상태 ──────────────────────────────────────────
  console.log("\n=== 2) 강등 6명 — profile/표시 상태 ===");
  const directKeyById = new Map<string, string>();
  for (const [name, uid, org] of DEMOTED) {
    const { data: p } = await sb
      .from("user_profiles")
      .select("growth_status,activity_ended_at")
      .eq("user_id", uid)
      .single();
    const ind = await getGrowthIndicatorsInternal(uid);
    directKeyById.set(uid, ind.process.growthDisplayKey);
    // 표시 키: DB=active 인 사용자는 현재 주차 맥락에 따라 active(성장 중) 또는
    // official_rest(휴식(공식) 중 — 현재 주차가 공식 휴식일 때)로 계산된다.
    // 핵심 invariant 는 "졸업 계열이 아님" — graduated/graduating 이면 실패.
    const okKey = ["active", "official_rest"].includes(ind.process.growthDisplayKey);
    check(
      `${name}(${org}) growth_status=active·ended_at=null·표시=진행중 계열`,
      p?.growth_status === "active" && p?.activity_ended_at === null && okKey,
      `db=${p?.growth_status} ended=${p?.activity_ended_at} key=${ind.process.growthDisplayKey} a=${ind.period.a}/h=${ind.period.h}`,
    );
  }
  for (const [name, uid] of KEPT) {
    const ind = await getGrowthIndicatorsInternal(uid);
    directKeyById.set(uid, ind.process.growthDisplayKey);
    check(`${name} 표시=graduated 유지`, ind.process.growthDisplayKey === "graduated");
  }

  // ── 3) direct vs HTTP — admin stats-cards ───────────────────────────
  console.log("\n=== 3) admin /api/cluster3/stats-cards — direct vs HTTP ===");
  for (const [name, uid] of [...DEMOTED, ...KEPT]) {
    const r = await fetch(`${ADMIN_BASE}/api/cluster3/stats-cards?userId=${uid}`, {
      headers: { "x-internal-api-key": INTERNAL_KEY },
    });
    const j: any = await r.json().catch(() => null);
    const httpKey = j?.data?.process?.growthStatusKey;
    check(
      `${name} HTTP growthStatusKey=${directKeyById.get(uid)}`,
      httpKey === directKeyById.get(uid),
      `HTTP=${httpKey}`,
    );
  }

  // ── 4) 이력서 "정상 졸업" 행 — direct vs HTTP ────────────────────────
  console.log("\n=== 4) 이력서 정상 졸업 행 — direct vs HTTP ===");
  for (const [name, uid, expectCount] of [
    ["T윤도현(강등)", DEMOTED[0][1], 0],
    ["T장시현(강등)", DEMOTED[5][1], 0],
    ["T홍지환(유지)", KEPT[2][1], 1],
  ] as const) {
    const direct = await getCluster1Resume(uid);
    const dCount = direct.seasonRecords.filter((x) => x.progressStatus === "정상 졸업").length;
    const r = await fetch(`${ADMIN_BASE}/api/cluster1/resume?userId=${uid}`, {
      headers: { "x-internal-api-key": INTERNAL_KEY },
    });
    const j: any = await r.json().catch(() => null);
    const hCount = (j?.data?.seasonRecords ?? []).filter(
      (x: any) => x.progressStatus === "정상 졸업",
    ).length;
    check(`${name} 정상 졸업 행 direct=${expectCount}`, dCount === expectCount, `실제=${dCount}`);
    check(`${name} 정상 졸업 행 HTTP=direct`, hCount === dCount, `HTTP=${hCount}`);
  }

  // ── 5) front weekly-growth — "시즌 중 졸업" 라벨 ─────────────────────
  console.log("\n=== 5) front weekly-growth — 시즌 중 졸업 라벨 ===");
  for (const [name, uid, expectHas] of [
    ["T윤도현(강등)", DEMOTED[0][1], false],
    ["T임건우(강등)", DEMOTED[4][1], false],
    ["T홍지환(유지)", KEPT[2][1], true],
  ] as const) {
    const r = await fetch(`${FRONT_BASE}/api/cluster4/weekly-growth?userId=${uid}`);
    const j: any = await r.json().catch(() => null);
    const sums: any[] = j?.data?.seasonSummaries ?? [];
    const has = sums.some((s) => s.statusLabel === "시즌 중 졸업");
    check(
      `${name} "시즌 중 졸업" ${expectHas ? "존재" : "소멸"}`,
      has === expectHas,
      sums.map((s) => `${s.seasonKey}:${s.statusLabel}`).join(" / "),
    );
  }

  // ── 6) snapshot 영향 — 강등 6명 is_stale=false 유지 ──────────────────
  console.log("\n=== 6) weekly-cards snapshot 비영향 ===");
  const { data: snaps, error: sErr } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,is_stale,computed_at")
    .in("user_id", DEMOTED.map((d) => d[1]));
  if (sErr) throw new Error(sErr.message);
  for (const [name, uid] of DEMOTED) {
    const s = (snaps ?? []).find((x) => x.user_id === uid);
    check(
      `${name} snapshot fresh(is_stale=false)`,
      s?.is_stale === false,
      `computed_at=${s?.computed_at}`,
    );
  }

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
