/**
 * 2025-summer 추가 활동 주차 파일럿 검증 (2026-06-06, read-only).
 *
 *   npx tsx --env-file=.env.local scripts/verify-tester-summer-weeks.ts <pilotUid>
 *
 * 검증:
 *   1) 표시 a >= 임계(30) — direct getGrowthIndicatorsInternal
 *   2) 이력서 "정상 졸업" 행 1건 + 2025-summer "8/8 정상 완료" — direct + admin HTTP
 *   3) front weekly-growth "시즌 중 졸업" + 2025-summer "시즌 성공"
 *   4) admin stats-cards HTTP growthStatusKey=graduated (direct 일치)
 *   5) snapshot is_stale=false + 2025-summer 카드 8장 전부 success·published
 *   6) 실사용자 지문 diff=0 (apply 로그 before hash 와 비교)
 *   7) 비대상 무변화: oranke 유지 3명 graduated 유지 · 나머지 강등 5명 active/a=26 유지
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
  ["T윤도현", "bf3b4305-751a-49e3-88ad-95a20e5c4dad", "encre"],
  ["T임다인", "42864260-e4ea-4150-a87f-cff545b02af1", "encre"],
  ["T장유준", "4a81b6d1-e488-4f14-8530-0cad60fe4f0d", "encre"],
  ["T윤태현", "05ff6b96-b3e7-4050-97f1-080633f183d3", "phalanx"],
  ["T임건우", "e4dcb97e-a515-4ec5-a91e-32ca4e629dae", "phalanx"],
  ["T장시현", "cc1b58e6-b14d-45a0-b389-2df3c27a0b25", "phalanx"],
] as const;
const KEPT = [
  ["T류민서", "63813dc4-9dec-4511-83be-1f54196d09cf"],
  ["T송태현", "1a0b0f9e-4e10-4d06-aa56-6d26ee4b203a"],
  ["T홍지환", "e6574586-6279-41cc-ae36-1c9dc3078bc3"],
] as const;

const PILOT = process.argv[2];
if (!PILOT) throw new Error("usage: ... <pilotUid>");
const pilotEntry = SIX.find((s) => s[1] === PILOT);
if (!pilotEntry) throw new Error(`pilot 이 강등 6명에 없음: ${PILOT}`);
const PILOT_NAME = pilotEntry[0];
const OTHERS = SIX.filter((s) => s[1] !== PILOT);

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
  orderCol = "user_id",
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(select).order(orderCol, { ascending: true }).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// apply 스크립트와 동일한 지문 (대상 6명 제외 전원)
async function realUserFingerprint(excludeIds: Set<string>): Promise<{ hash: string; counts: Record<string, number> }> {
  const [uws, profiles, points, snaps] = await Promise.all([
    pageAll<{ user_id: string; week_start_date: string; status: string }>(
      "user_week_statuses",
      "user_id,week_start_date,status",
    ),
    pageAll<{ user_id: string; growth_status: string | null; activity_started_at: string | null; activity_ended_at: string | null }>(
      "user_profiles",
      "user_id,growth_status,activity_started_at,activity_ended_at",
    ),
    pageAll<{ user_id: string; year: number; week_number: number; points: number }>(
      "user_weekly_points",
      "user_id,year,week_number,points",
    ),
    pageAll<{ user_id: string; is_stale: boolean }>(
      "cluster4_weekly_card_snapshots",
      "user_id,is_stale",
    ),
  ]);
  const pick = <T extends { user_id: string }>(rows: T[]) => rows.filter((r) => !excludeIds.has(r.user_id));
  const u = pick(uws).map((r) => `${r.user_id}|${r.week_start_date}|${r.status}`).sort();
  const p = pick(profiles).map((r) => `${r.user_id}|${r.growth_status}|${r.activity_started_at}|${r.activity_ended_at}`).sort();
  const w = pick(points).map((r) => `${r.user_id}|${r.year}|${r.week_number}|${r.points}`).sort();
  const s = pick(snaps).map((r) => `${r.user_id}|${r.is_stale}`).sort();
  const hash = createHash("sha256").update([u.join("\n"), p.join("\n"), w.join("\n"), s.join("\n")].join("\n#\n")).digest("hex");
  return { hash, counts: { uws: u.length, profiles: p.length, points: w.length, snapshots: s.length } };
}

async function main() {
  const { GRADUATION_THRESHOLDS } = await import("@/lib/pointLabels");
  const { getGrowthIndicatorsInternal } = await import("@/lib/cluster3GrowthData");
  const { getCluster1Resume } = await import("@/lib/cluster1ResumeData");
  const { getResolvedCardsForUser } = await import("@/lib/cluster3GrowthData").catch(() => ({ getResolvedCardsForUser: null }) as any);

  const thr = (GRADUATION_THRESHOLDS as Record<string, number>)[pilotEntry[2]];

  // ── 1) 표시 a >= 임계 ────────────────────────────────────────────────
  console.log(`=== 1) ${PILOT_NAME} 표시 지표 (임계 ${thr}) ===`);
  const ind = await getGrowthIndicatorsInternal(PILOT);
  check(`a(${ind.period.a}) >= ${thr}`, ind.period.a >= thr, `h=${ind.period.h}`);
  check(`표시 키 = graduated`, ind.process.growthDisplayKey === "graduated", `key=${ind.process.growthDisplayKey}`);

  const { data: prof } = await sb
    .from("user_profiles")
    .select("growth_status,activity_started_at,activity_ended_at")
    .eq("user_id", PILOT)
    .single();
  check(
    `profile graduated · started=2025-06-30`,
    prof?.growth_status === "graduated" && prof?.activity_started_at?.startsWith("2025-06-30"),
    `status=${prof?.growth_status} started=${prof?.activity_started_at} ended=${prof?.activity_ended_at ?? "null"}`,
  );
  const { data: gsRow } = await sb
    .from("user_growth_stats")
    .select("approved_weeks,cumulative_weeks")
    .eq("user_id", PILOT)
    .single();
  console.log(`  (캐시 approved=${gsRow?.approved_weeks} cumulative=${gsRow?.cumulative_weeks})`);

  // ── 2) 이력서 — direct + HTTP ────────────────────────────────────────
  console.log(`\n=== 2) 이력서 seasonRecords — direct & HTTP ===`);
  const direct = await getCluster1Resume(PILOT);
  const dGrad = direct.seasonRecords.filter((x: any) => x.progressStatus === "정상 졸업");
  check(`direct "정상 졸업" 행 1건`, dGrad.length === 1, dGrad.map((x: any) => `${x.year} ${x.seasonName}`).join(","));
  const dSummer = direct.seasonRecords.find((x: any) => x.year === "25" && String(x.seasonName).includes("여름"));
  check(
    `direct 25 여름 = 8/8 정상 완료`,
    Boolean(dSummer) && dSummer.approvedWeeks === 8 && dSummer.totalWeeks === 8 && dSummer.progressStatus === "정상 완료",
    dSummer ? `${dSummer.approvedWeeks}/${dSummer.totalWeeks} ${dSummer.progressStatus}` : "(행 없음)",
  );
  const r1 = await fetch(`${ADMIN_BASE}/api/cluster1/resume?userId=${PILOT}`, {
    headers: { "x-internal-api-key": INTERNAL_KEY },
  });
  const j1: any = await r1.json().catch(() => null);
  const hRecs: any[] = j1?.data?.seasonRecords ?? [];
  const hGrad = hRecs.filter((x) => x.progressStatus === "정상 졸업");
  const hSummer = hRecs.find((x) => x.year === "25" && String(x.seasonName).includes("여름"));
  check(`HTTP "정상 졸업" 행 = direct`, hGrad.length === dGrad.length, `HTTP=${hGrad.length}`);
  check(
    `HTTP 25 여름 = 8/8 정상 완료`,
    Boolean(hSummer) && hSummer.approvedWeeks === 8 && hSummer.totalWeeks === 8 && hSummer.progressStatus === "정상 완료",
    hSummer ? `${hSummer.approvedWeeks}/${hSummer.totalWeeks} ${hSummer.progressStatus}` : "(행 없음)",
  );

  // ── 3) front weekly-growth ───────────────────────────────────────────
  console.log(`\n=== 3) front weekly-growth 시즌 라벨 ===`);
  const r2 = await fetch(`${FRONT_BASE}/api/cluster4/weekly-growth?userId=${PILOT}`);
  const j2: any = await r2.json().catch(() => null);
  const sums: any[] = j2?.data?.seasonSummaries ?? [];
  const labelStr = sums.map((s) => `${s.seasonKey}:${s.statusLabel}`).join(" / ");
  check(`"시즌 중 졸업" 존재`, sums.some((s) => s.statusLabel === "시즌 중 졸업"), labelStr);
  const summerSum = sums.find((s) => s.seasonKey === "2025-summer");
  check(`2025-summer 시즌 성공`, summerSum?.statusLabel === "시즌 성공", `label=${summerSum?.statusLabel ?? "(없음)"}`);

  // ── 4) admin stats-cards HTTP ────────────────────────────────────────
  console.log(`\n=== 4) admin stats-cards — direct vs HTTP ===`);
  const r3 = await fetch(`${ADMIN_BASE}/api/cluster3/stats-cards?userId=${PILOT}`, {
    headers: { "x-internal-api-key": INTERNAL_KEY },
  });
  const j3: any = await r3.json().catch(() => null);
  check(
    `growthStatusKey=graduated (HTTP==direct)`,
    j3?.data?.process?.growthStatusKey === "graduated" && ind.process.growthDisplayKey === "graduated",
    `HTTP=${j3?.data?.process?.growthStatusKey}`,
  );

  // ── 5) snapshot — stale=false + 여름 카드 8장 success ────────────────
  console.log(`\n=== 5) snapshot ===`);
  const { data: snap } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("is_stale,computed_at,cards")
    .eq("user_id", PILOT)
    .single();
  check(`is_stale=false`, snap?.is_stale === false, `computed_at=${snap?.computed_at}`);
  const cards: any[] = Array.isArray((snap as any)?.cards) ? (snap as any).cards : [];
  const summerCards = cards.filter((c) => c?.seasonKey === "2025-summer");
  const summerSuccess = summerCards.filter((c) => c?.userWeekStatus === "success");
  const summerLineOk = summerCards.filter(
    (c) =>
      Array.isArray(c?.lines) &&
      c.lines.some((l: any) => l?.lineName === "[통합] 주차 활동 내역" && l?.status === "success"),
  );
  check(
    `2025-summer 카드 8장 · 전부 success · 통합라인 success`,
    summerCards.length === 8 && summerSuccess.length === 8 && summerLineOk.length === 8,
    `cards=${summerCards.length} success=${summerSuccess.length} lineOk=${summerLineOk.length} label=${summerCards[0]?.weekLabel ?? "-"}`,
  );

  // ── 6) 실사용자 지문 diff ────────────────────────────────────────────
  console.log(`\n=== 6) 실사용자 지문 (대상 6명 제외) ===`);
  const fp = await realUserFingerprint(new Set(SIX.map((s) => s[1])));
  const fileLog = JSON.parse(readFileSync(LOG_PATH, "utf8"));
  const beforeHash = fileLog.runs[fileLog.runs.length - 1]?.fpBefore?.hash;
  check(`hash == apply 직전`, fp.hash === beforeHash, `now=${fp.hash.slice(0, 16)}… before=${String(beforeHash).slice(0, 16)}…`);

  // ── 7) 비대상 무변화 ─────────────────────────────────────────────────
  console.log(`\n=== 7) 비대상 무변화 ===`);
  for (const [name, uid] of KEPT) {
    const k = await getGrowthIndicatorsInternal(uid);
    check(`${name}(유지조) graduated 유지`, k.process.growthDisplayKey === "graduated", `a=${k.period.a}`);
  }
  for (const [name, uid] of OTHERS) {
    const { data: p } = await sb.from("user_profiles").select("growth_status").eq("user_id", uid).single();
    const o = await getGrowthIndicatorsInternal(uid);
    check(
      `${name}(잔여 강등조) active·a=26 유지`,
      p?.growth_status === "active" && o.period.a === 26,
      `status=${p?.growth_status} a=${o.period.a}`,
    );
  }

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
