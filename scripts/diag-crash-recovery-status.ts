/**
 * 진단(read-only): 2026-06-05 graduated 테스터 작업 — 컴퓨터 중단 후 현재 상태 전수 확인.
 *
 *   npx tsx --env-file=.env.local scripts/diag-crash-recovery-status.ts
 *
 * 확인:
 *   1) 강등 6명 profile/growth_stats 현재값
 *   2) uws is_official_rest_override=true 건수·대상·주차 (파일럿 진행 여부)
 *   3) weekly-cards snapshot stale/computed_at
 *   4) 현재 graduated 테스터 전수
 *   5~7) direct 표시값 vs 운영 HTTP 응답 비교
 * DB 변경 없음.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const ADMIN_BASE = process.env.DIAG_ADMIN_BASE ?? "https://vraxium-admin.vercel.app";
const FRONT_BASE = process.env.DIAG_FRONT_BASE ?? "https://vraxium.vercel.app";
const INTERNAL_KEY = process.env.INTERNAL_API_KEY!;

const SIX = [
  ["T윤도현", "bf3b4305-751a-49e3-88ad-95a20e5c4dad", "encre"],
  ["T임다인", "42864260-e4ea-4150-a87f-cff545b02af1", "encre"],
  ["T장유준", "4a81b6d1-e488-4f14-8530-0cad60fe4f0d", "encre"],
  ["T윤태현", "05ff6b96-b3e7-4050-97f1-080633f183d3", "phalanx"],
  ["T임건우", "e4dcb97e-a515-4ec5-a91e-32ca4e629dae", "phalanx"],
  ["T장시현", "cc1b58e6-b14d-45a0-b389-2df3c27a0b25", "phalanx"],
] as const;
const SIX_IDS = SIX.map((s) => s[1]);

const OUT = "claudedocs/diag-crash-recovery-status-20260606.json";

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

async function main() {
  const { getGrowthIndicatorsInternal } = await import("@/lib/cluster3GrowthData");
  const report: Record<string, unknown> = { runAt: new Date().toISOString() };

  // ── 1) 6명 profile + growth_stats ────────────────────────────────────
  console.log("=== 1) 강등 6명 — profile / growth_stats / 표시 a·h ===");
  const [{ data: profiles }, { data: gs }] = await Promise.all([
    sb
      .from("user_profiles")
      .select("user_id,display_name,organization_slug,growth_status,activity_started_at,activity_ended_at")
      .in("user_id", SIX_IDS),
    sb
      .from("user_growth_stats")
      .select("user_id,approved_weeks,cumulative_weeks,updated_at")
      .in("user_id", SIX_IDS),
  ]);
  const item1: any[] = [];
  for (const [name, uid, org] of SIX) {
    const p: any = (profiles ?? []).find((x: any) => x.user_id === uid);
    const g: any = (gs ?? []).find((x: any) => x.user_id === uid);
    let a: number | null = null,
      h: number | null = null,
      key: string | null = null;
    try {
      const ind = await getGrowthIndicatorsInternal(uid);
      a = ind.period.a;
      h = ind.period.h;
      key = ind.process.growthDisplayKey;
    } catch (e) {
      console.warn(`  표시계산 실패(${name}): ${(e as Error).message}`);
    }
    const row = {
      name,
      uid,
      org,
      growth_status: p?.growth_status ?? null,
      activity_ended_at: p?.activity_ended_at ?? null,
      displayA: a,
      displayH: h,
      displayKey: key,
      cacheApproved: g?.approved_weeks ?? null,
      cacheCumulative: g?.cumulative_weeks ?? null,
      gsUpdatedAt: g?.updated_at ?? null,
    };
    item1.push(row);
    console.log(
      `  ${name} [${org}] status=${row.growth_status} ended=${row.activity_ended_at ?? "null"} a=${a} h=${h} key=${key} cache=${row.cacheApproved}/${row.cacheCumulative}`,
    );
  }
  report.item1_profiles = item1;

  // ── 2) override 파일럿 진행 여부 ─────────────────────────────────────
  console.log("\n=== 2) uws is_official_rest_override=true 전수 ===");
  const ovrRows = await pageAll<{
    user_id: string;
    week_start_date: string;
    status: string;
    is_official_rest_override: boolean;
  }>(
    "user_week_statuses",
    "user_id,week_start_date,status,is_official_rest_override",
    (q) => q.eq("is_official_rest_override", true),
  );
  console.log(`  override=true 전체: ${ovrRows.length}건`);
  const ovrUsers = [...new Set(ovrRows.map((r) => r.user_id))];
  const ovrWeeks = [...new Set(ovrRows.map((r) => r.week_start_date))].sort();
  const { data: ovrProfiles } = ovrUsers.length
    ? await sb.from("user_profiles").select("user_id,display_name").in("user_id", ovrUsers)
    : { data: [] as any[] };
  const nameById = new Map((ovrProfiles ?? []).map((p: any) => [p.user_id, p.display_name]));
  for (const r of ovrRows) {
    console.log(`    ${nameById.get(r.user_id) ?? r.user_id} ${r.week_start_date} status=${r.status}`);
  }
  console.log(`  대상 사용자: ${ovrUsers.map((u) => nameById.get(u) ?? u).join(", ") || "(없음)"}`);
  console.log(`  적용 주차: ${ovrWeeks.join(", ") || "(없음)"}`);
  report.item2_override = {
    total: ovrRows.length,
    users: ovrUsers.map((u) => ({ uid: u, name: nameById.get(u) ?? null })),
    weeks: ovrWeeks,
    rows: ovrRows,
  };

  // 파일럿 계획 4주차의 6명 uws 현재값 (override 미적용이어도 상태 확인)
  console.log("\n  (참고) 계획 4주차 × 6명 uws 현재값:");
  const PLAN_WEEKS = ["2026-02-16", "2026-04-06", "2026-04-13", "2026-04-20"];
  const { data: planRows } = await sb
    .from("user_week_statuses")
    .select("user_id,week_start_date,status,is_official_rest_override")
    .in("user_id", SIX_IDS)
    .in("week_start_date", PLAN_WEEKS);
  const sixName = new Map(SIX.map((s) => [s[1], s[0]]));
  for (const r of (planRows ?? []) as any[]) {
    console.log(
      `    ${sixName.get(r.user_id)} ${r.week_start_date} status=${r.status} ovr=${r.is_official_rest_override}`,
    );
  }
  report.item2_planWeeksCurrent = planRows ?? [];

  // ── 3) snapshot 상태 ─────────────────────────────────────────────────
  console.log("\n=== 3) weekly-cards snapshot (6명) ===");
  const { data: snaps, error: sErr } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,is_stale,computed_at")
    .in("user_id", SIX_IDS);
  if (sErr) console.warn(`  snapshot 조회 실패: ${sErr.message}`);
  const item3: any[] = [];
  for (const [name, uid] of SIX) {
    const rows = ((snaps ?? []) as any[]).filter((x) => x.user_id === uid);
    const staleCnt = rows.filter((x) => x.is_stale).length;
    const latest = rows.map((x) => x.computed_at).sort().pop() ?? null;
    item3.push({ name, uid, snapshotRows: rows.length, staleRows: staleCnt, latestComputedAt: latest });
    console.log(`  ${name} rows=${rows.length} stale=${staleCnt} latest computed_at=${latest}`);
  }
  report.item3_snapshots = item3;

  // ── 4) 현재 graduated 테스터 전수 ────────────────────────────────────
  console.log("\n=== 4) 현재 graduated 사용자 전수 (테스터/실사용자 구분) ===");
  const [markers, gradNow] = await Promise.all([
    pageAll<{ user_id: string }>("test_user_markers", "user_id"),
    pageAll<{ user_id: string; display_name: string | null; organization_slug: string | null }>(
      "user_profiles",
      "user_id,display_name,organization_slug",
      (q) => q.eq("growth_status", "graduated"),
    ),
  ]);
  const testerIds = new Set(markers.map((m) => m.user_id));
  const gradTesters = gradNow.filter((p) => testerIds.has(p.user_id));
  const gradReal = gradNow.filter((p) => !testerIds.has(p.user_id));
  console.log(`  graduated 테스터: ${gradTesters.length}명 — ${gradTesters.map((p) => `${p.display_name}(${p.organization_slug})`).join(", ") || "(없음)"}`);
  console.log(`  graduated 실사용자: ${gradReal.length}명 — ${gradReal.map((p) => `${p.display_name}(${p.organization_slug})`).join(", ") || "(없음)"}`);
  report.item4_graduatedNow = {
    testers: gradTesters.map((p) => ({ uid: p.user_id, name: p.display_name, org: p.organization_slug })),
    real: gradReal.map((p) => ({ uid: p.user_id, name: p.display_name, org: p.organization_slug })),
  };

  // ── 5~7) direct vs HTTP ──────────────────────────────────────────────
  console.log("\n=== 5~7) direct vs HTTP (admin stats-cards / front weekly-growth) ===");
  const item57: any[] = [];
  for (const [name, uid] of SIX) {
    const directKey = item1.find((r) => r.uid === uid)?.displayKey ?? null;
    let httpAdminKey: string | null = null;
    let httpFrontLabels: string | null = null;
    let frontHasMidGrad: boolean | null = null;
    try {
      const r = await fetch(`${ADMIN_BASE}/api/cluster3/stats-cards?userId=${uid}`, {
        headers: { "x-internal-api-key": INTERNAL_KEY },
      });
      const j: any = await r.json().catch(() => null);
      httpAdminKey = j?.data?.process?.growthStatusKey ?? `HTTP ${r.status}`;
    } catch (e) {
      httpAdminKey = `fetch 실패: ${(e as Error).message}`;
    }
    try {
      const r = await fetch(`${FRONT_BASE}/api/cluster4/weekly-growth?userId=${uid}`);
      const j: any = await r.json().catch(() => null);
      const sums: any[] = j?.data?.seasonSummaries ?? [];
      httpFrontLabels = sums.map((s) => `${s.seasonKey}:${s.statusLabel}`).join(" / ") || `HTTP ${r.status}`;
      frontHasMidGrad = sums.some((s) => s.statusLabel === "시즌 중 졸업");
    } catch (e) {
      httpFrontLabels = `fetch 실패: ${(e as Error).message}`;
    }
    const match = directKey !== null && httpAdminKey === directKey;
    item57.push({ name, uid, directKey, httpAdminKey, adminMatch: match, frontLabels: httpFrontLabels, frontHasMidGrad });
    console.log(`  ${name} direct=${directKey} adminHTTP=${httpAdminKey} ${match ? "✓일치" : "✗불일치"}`);
    console.log(`    front: ${httpFrontLabels} | 시즌중졸업=${frontHasMidGrad}`);
  }
  report.item57_directVsHttp = item57;

  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\n리포트 저장: ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
