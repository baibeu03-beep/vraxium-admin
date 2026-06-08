/**
 * SoT 전수 점검 — direct(lib 함수) vs HTTP(운영 admin/front) 비교.
 *
 *   npx tsx --env-file=.env.local scripts/audit-sot-direct-vs-http.ts
 *
 * T1: front weekly-cards(프록시) vs admin weekly-cards(internal key) — 전 주차 핵심 필드
 * T2: front weekly-growth(독립 구현) vs direct getWeeklyGrowth(admin 정본) — 상태/카운트
 * T3: admin weekly-cards demoUserId 경로 vs internal-key 경로
 * T4: direct readWeeklyCardsSnapshot vs admin HTTP weekly-cards — 배포본/로컬 정합
 * T5: weeks.is_official_rest(legacy 컬럼) vs resolveWeekOfficialRest(정본 resolver) 전수 스캔
 */
import { createClient } from "@supabase/supabase-js";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { getWeeklyGrowth } from "@/lib/cluster4WeeklyGrowthData";
import {
  fetchActiveRestPeriods,
  resolveWeekOfficialRest,
} from "@/lib/officialRestPeriodsData";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const internalKey = process.env.INTERNAL_API_KEY!;
const sb = createClient(url, key);

const FRONT = "https://vraxium.vercel.app";
const ADMIN = "https://vraxium-admin.vercel.app";

const out: Record<string, unknown> = {};

async function pickUsers(): Promise<{ tester: string | null; real: string | null }> {
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testerSet = new Set((markers ?? []).map((m) => m.user_id));
  const { data: uws } = await sb
    .from("user_week_statuses")
    .select("user_id")
    .order("week_start_date", { ascending: false })
    .limit(1000);
  const ids = [...new Set((uws ?? []).map((r) => r.user_id))];
  const tester = ids.find((id) => testerSet.has(id)) ?? null;
  const real = ids.find((id) => !testerSet.has(id)) ?? null;
  return { tester, real };
}

function cardCore(c: any) {
  return {
    weekLabel: c.weekLabel,
    userWeekStatus: c.userWeekStatus,
    isRestWeek: c.isRestWeek,
    isTransition: c.isTransition,
    statusLabel: c.statusLabel,
    resultStatus: c.resultStatus,
    seasonKey: c.seasonKey,
    shield: c.points?.shield ?? null,
    checkGate: c.checkGate ?? null,
  };
}

function diffCards(label: string, aCards: any[], bCards: any[]) {
  const aMap = new Map((aCards ?? []).map((c) => [c.weekId, cardCore(c)]));
  const bMap = new Map((bCards ?? []).map((c) => [c.weekId, cardCore(c)]));
  const allIds = new Set([...aMap.keys(), ...bMap.keys()]);
  const diffs: any[] = [];
  for (const id of allIds) {
    const a = aMap.get(id);
    const b = bMap.get(id);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      diffs.push({ weekId: id, a: a ?? "(missing)", b: b ?? "(missing)" });
    }
  }
  console.log(`[${label}] weeks a=${aMap.size} b=${bMap.size} diffs=${diffs.length}`);
  for (const d of diffs.slice(0, 10)) console.log("  ", JSON.stringify(d));
  return diffs;
}

async function fetchJson(u: string, headers?: Record<string, string>) {
  const res = await fetch(u, { headers });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-json */
  }
  return { status: res.status, json };
}

async function main() {
  const { tester, real } = await pickUsers();
  console.log("users:", { tester, real });
  out.users = { tester, real };

  for (const [kind, uid] of [
    ["tester", tester],
    ["real", real],
  ] as const) {
    if (!uid) continue;
    console.log(`\n===== ${kind} ${uid} =====`);

    // ---- HTTP fetches
    const [frontCards, adminCards, demoCards, frontGrowth] = await Promise.all([
      fetchJson(`${FRONT}/api/cluster4/weekly-cards?userId=${uid}`),
      fetchJson(`${ADMIN}/api/cluster4/weekly-cards?userId=${uid}`, {
        "x-internal-api-key": internalKey,
      }),
      fetchJson(`${ADMIN}/api/cluster4/weekly-cards?demoUserId=${uid}`),
      fetchJson(`${FRONT}/api/cluster4/weekly-growth?userId=${uid}`),
    ]);

    console.log(
      `HTTP status: frontCards=${frontCards.status} adminCards=${adminCards.status} demoCards=${demoCards.status} frontGrowth=${frontGrowth.status}`,
    );

    // ---- T1: front proxy vs admin (internal key)
    const t1 = diffCards(
      `T1 ${kind} front-vs-admin weekly-cards`,
      frontCards.json?.data ?? [],
      adminCards.json?.data ?? [],
    );

    // ---- T3: demo path vs internal key path
    let t3: any = { demoStatus: demoCards.status };
    if (demoCards.status === 200) {
      t3.diffs = diffCards(
        `T3 ${kind} demo-vs-internal weekly-cards`,
        demoCards.json?.data ?? [],
        adminCards.json?.data ?? [],
      );
    } else {
      console.log(`[T3 ${kind}] demo path HTTP ${demoCards.status} (게이트 동작 — 비교 불가)`);
    }

    // ---- T4: direct snapshot read vs admin HTTP
    const snap = await readWeeklyCardsSnapshot(uid);
    const snapCards =
      snap.status === "hit" || snap.status === "stale" ? snap.cards : [];
    const t4 = diffCards(
      `T4 ${kind} directSnapshot-vs-adminHTTP weekly-cards`,
      snapCards as any[],
      adminCards.json?.data ?? [],
    );
    console.log(
      `  snapshot outcome: status=${snap.status}${"reason" in snap ? ` reason=${snap.reason}` : ""}${"computedAt" in snap ? ` computed_at=${snap.computedAt}` : ""}`,
    );

    // ---- T2: direct getWeeklyGrowth(정본) vs front weekly-growth(독립 구현)
    const direct = await getWeeklyGrowth(uid);
    const fg = frontGrowth.json;
    const directSummary = direct
      ? {
          currentWeekStatus: direct.currentWeekInfo?.status ?? null,
          approvedWeeks: (direct as any).growthSummary?.approvedWeeks,
          availableWeeks: (direct as any).growthSummary?.availableWeeks,
          cards: (direct.weeklyCards ?? []).length,
        }
      : null;
    const frontSummary = fg
      ? {
          currentWeekStatus: fg.currentWeekInfo?.status ?? null,
          successWeeks: fg.growthStats?.successWeeks,
          availableWeeks: fg.growthStats?.availableWeeks,
          failWeeks: fg.growthStats?.failWeeks,
          restWeeks: fg.growthStats?.restWeeks,
          cards: (fg.weeklyCards ?? []).length,
        }
      : null;
    console.log(`[T2 ${kind}] direct(admin 정본):`, JSON.stringify(directSummary));
    console.log(`[T2 ${kind}] front(독립 구현):`, JSON.stringify(frontSummary));

    // 주차별 상태 비교 (weekNumber+seasonKey 기준)
    const dCards = new Map(
      (direct?.weeklyCards ?? []).map((c: any) => [
        `${c.seasonKey ?? c.season ?? ""}#${c.weekNumber}`,
        { status: c.status ?? c.userWeekStatus ?? null, isTransition: c.isTransition ?? null },
      ]),
    );
    const fCards = new Map(
      (fg?.weeklyCards ?? []).map((c: any) => [
        `${c.seasonKey ?? c.season ?? ""}#${c.weekNumber}`,
        { status: c.status ?? c.userWeekStatus ?? null, isTransition: c.isTransition ?? null },
      ]),
    );
    const t2diffs: any[] = [];
    for (const k of new Set([...dCards.keys(), ...fCards.keys()])) {
      const a = dCards.get(k);
      const b = fCards.get(k);
      if (JSON.stringify(a) !== JSON.stringify(b)) t2diffs.push({ week: k, direct: a, front: b });
    }
    console.log(`[T2 ${kind}] per-week diffs=${t2diffs.length}`);
    for (const d of t2diffs.slice(0, 12)) console.log("  ", JSON.stringify(d));

    (out as any)[kind] = {
      httpStatus: {
        frontCards: frontCards.status,
        adminCards: adminCards.status,
        demoCards: demoCards.status,
        frontGrowth: frontGrowth.status,
      },
      t1Diffs: t1,
      t2: { directSummary, frontSummary, perWeekDiffs: t2diffs },
      t3,
      t4Diffs: t4,
      snapshotMeta: {
        status: snap.status,
        reason: "reason" in snap ? snap.reason : null,
        computedAt: "computedAt" in snap ? snap.computedAt : null,
      },
    };
  }

  // ---- T5: weeks.is_official_rest legacy vs resolver 전수 스캔
  console.log(`\n===== T5 weeks.is_official_rest vs resolver =====`);
  const { data: weeks } = await sb
    .from("weeks")
    .select("id,week_number,start_date,end_date,season_key,is_official_rest,holiday_name")
    .order("start_date", { ascending: true });
  const activePeriods = await fetchActiveRestPeriods();
  const mismatches: any[] = [];
  for (const w of weeks ?? []) {
    const r = await resolveWeekOfficialRest(
      { startDate: w.start_date, endDate: w.end_date },
      activePeriods,
    );
    const resolved = r.isOfficialRest;
    if (resolved !== Boolean(w.is_official_rest)) {
      mismatches.push({
        weekId: w.id,
        seasonKey: w.season_key,
        weekNumber: w.week_number,
        startDate: w.start_date,
        legacyColumn: Boolean(w.is_official_rest),
        resolver: resolved,
        sources: r.sources,
      });
    }
  }
  console.log(`weeks=${weeks?.length} legacy-vs-resolver mismatches=${mismatches.length}`);
  for (const m of mismatches) console.log("  ", JSON.stringify(m));
  out.t5Mismatches = mismatches;

  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    "claudedocs/sot-audit-direct-vs-http-20260605.json",
    JSON.stringify(out, null, 2),
    "utf8",
  );
  console.log("\nsaved → claudedocs/sot-audit-direct-vs-http-20260605.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
