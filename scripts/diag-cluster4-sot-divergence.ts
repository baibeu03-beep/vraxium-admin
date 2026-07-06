/**
 * Phase 0 진단 — Cluster4 허브 강화율 SoT 드리프트 측정.
 *
 *   npx tsx --env-file=.env.local scripts/diag-cluster4-sot-divergence.ts
 *
 * 두 계산 경로가 같은 사용자/주차/허브에서 얼마나 어긋나는지 전수 비교한다.
 *   Path 1 = getCluster4WeeklyCardsForProfileUser  (breakdownFromLines — 카드 렌더 셀)
 *            → card.growthNumerator/growthDenominator (총합) + lines[].numerator/denominator (허브별)
 *   Path 2 = getWeeklyGrowth                        (SQL 집계 + 레거시 override)
 *            → weeklyCards[].weeklyGrowth.{completedLines,availableLines} + lineBreakdown{info,ability,experience,career}
 *
 * 산출:
 *   - 주차 총합 불일치(completed/available) 목록·카운트
 *   - 허브별 불일치(info/competency/experience/career) 목록·카운트
 *   - 시즌율(seasonGrowthRates vs Path1 시즌 합) 불일치
 *   - 레거시 주차 운영 역량/경험 라인 보유 진단(Phase 3 blast-radius)
 * Phase 1 통일 후 이 스크립트가 diffs=0 이면 성공.
 */
import { createClient } from "@supabase/supabase-js";
import {
  getCluster4WeeklyCardsForProfileUser,
  getUnifiedWeeklyGrowth,
} from "@/lib/cluster4WeeklyCardsData";
import { getWeeklyGrowth } from "@/lib/cluster4WeeklyGrowthData";

// DIAG_UNIFIED=1 → 통일 함수(getUnifiedWeeklyGrowth) 비교(통일 후 0 기대).
// 기본(미설정) → 원본 getWeeklyGrowth 비교(통일 전 baseline).
const P2_SOURCE =
  process.env.DIAG_UNIFIED === "1" ? getUnifiedWeeklyGrowth : getWeeklyGrowth;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(url, key);

const USER_CAP = Number(process.env.DIAG_USER_CAP ?? 120);
const CONCURRENCY = 4;
const LEGACY_BEFORE = "2026-06-29"; // 2026 여름 W1 경계 (레거시 판정).

// 주차 start_date 맵(레거시 분류용) — main 에서 1회 로드 후 주입.
let legacyWeekIds = new Set<string>();

// P1 partType ↔ P2 lineBreakdown 키.
const HUB_KEYS = [
  { part: "information", p2: "info", label: "info" },
  { part: "competency", p2: "ability", label: "competency" },
  { part: "experience", p2: "experience", label: "experience" },
  { part: "career", p2: "career", label: "career" },
] as const;

type Pair = { completed: number; available: number };

function p1Total(card: any): Pair {
  return {
    completed: Number(card.growthNumerator ?? 0),
    available: Number(card.growthDenominator ?? 0),
  };
}
function p2Total(card: any): Pair {
  return {
    completed: Number(card?.weeklyGrowth?.completedLines ?? 0),
    available: Number(card?.weeklyGrowth?.availableLines ?? 0),
  };
}
// P1 허브별: 라인에 부착된 numerator/denominator(허브 총계)를 직접 읽는다.
function p1Hub(lines: any[], part: string): Pair {
  const l = (lines ?? []).find(
    (x) => x.partType === part && x.denominator != null,
  );
  if (l) return { completed: Number(l.numerator ?? 0), available: Number(l.denominator ?? 0) };
  return { completed: 0, available: 0 };
}
function p2Hub(card: any, p2key: string): Pair {
  const d = card?.lineBreakdown?.[p2key];
  return { completed: Number(d?.completed ?? 0), available: Number(d?.available ?? 0) };
}
function eq(a: Pair, b: Pair): boolean {
  return a.completed === b.completed && a.available === b.available;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    for (;;) {
      const i = idx++;
      if (i >= items.length) break;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function pickUsers(): Promise<string[]> {
  const set = new Set<string>();
  // (a) cluster4 라인 타깃 보유자 — 허브 데이터가 확실히 있는 사용자.
  {
    let from = 0;
    for (;;) {
      const { data, error } = await sb
        .from("cluster4_line_targets")
        .select("target_user_id")
        .eq("target_mode", "user")
        .not("target_user_id", "is", null)
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      const rows = data ?? [];
      for (const r of rows) if (r.target_user_id) set.add(r.target_user_id as string);
      if (rows.length < 1000) break;
      from += 1000;
    }
  }
  // (b) 최근 주차 상태 보유자 일부 — 라인 없는 일반 사용자도 표본에 포함.
  {
    const { data } = await sb
      .from("user_week_statuses")
      .select("user_id")
      .order("week_start_date", { ascending: false })
      .limit(1000);
    for (const r of data ?? []) if (r.user_id) set.add(r.user_id as string);
  }
  return [...set].slice(0, USER_CAP);
}

type UserResult = {
  userId: string;
  weeks: number;
  totalDiffs: any[];
  hubDiffs: any[];
  seasonDiffs: any[];
  error?: string;
};

async function diagUser(userId: string): Promise<UserResult> {
  const res: UserResult = { userId, weeks: 0, totalDiffs: [], hubDiffs: [], seasonDiffs: [] };
  try {
    const [p1cards, p2] = await Promise.all([
      getCluster4WeeklyCardsForProfileUser(userId),
      P2_SOURCE(userId),
    ]);
    const p2ByWeek = new Map<string, any>(
      (p2?.weeklyCards ?? [])
        .filter((c: any) => c.weekId)
        .map((c: any) => [c.weekId as string, c]),
    );

    // 시즌별 Path1 합계 누적(시즌율 비교용).
    const p1SeasonAgg = new Map<string, Pair>();

    for (const c of p1cards) {
      if (!c.weekId) continue;
      const p2c = p2ByWeek.get(c.weekId);
      if (!p2c) continue; // 주차 매칭 안 되면 스킵(정체성 이슈는 별도)
      res.weeks++;

      // 시즌 합계 누적.
      const sk = c.seasonKey ?? "(none)";
      const acc = p1SeasonAgg.get(sk) ?? { completed: 0, available: 0 };
      acc.completed += Number(c.growthNumerator ?? 0);
      acc.available += Number(c.growthDenominator ?? 0);
      p1SeasonAgg.set(sk, acc);

      // 총합 비교.
      const legacy = legacyWeekIds.has(c.weekId);
      const a = p1Total(c);
      const b = p2Total(p2c);
      if (!eq(a, b)) {
        res.totalDiffs.push({ weekId: c.weekId, seasonKey: sk, weekNumber: c.weekNumber, legacy, p1: a, p2: b });
      }
      // 허브별 비교.
      for (const h of HUB_KEYS) {
        const ha = p1Hub(c.lines, h.part);
        const hb = p2Hub(p2c, h.p2);
        if (!eq(ha, hb)) {
          res.hubDiffs.push({
            weekId: c.weekId, seasonKey: sk, weekNumber: c.weekNumber, legacy,
            hub: h.label, p1: ha, p2: hb,
          });
        }
      }
    }

    // 시즌율 비교: P2.seasonGrowthRates vs P1 시즌 합.
    for (const s of p2?.seasonGrowthRates ?? []) {
      const p1s = p1SeasonAgg.get(s.seasonKey);
      if (!p1s) continue;
      if (p1s.completed !== s.totalCompleted || p1s.available !== s.totalAvailable) {
        res.seasonDiffs.push({
          seasonKey: s.seasonKey,
          p1: p1s,
          p2: { completed: s.totalCompleted, available: s.totalAvailable },
        });
      }
    }
  } catch (e) {
    res.error = e instanceof Error ? e.message : String(e);
  }
  return res;
}

async function legacyLineDiagnostic() {
  // 레거시 주차(허브 도입 전, start_date < 2026-06-29) 운영 역량/경험 라인 보유 여부.
  const { data: weeks } = await sb
    .from("weeks")
    .select("id")
    .lt("start_date", "2026-06-29");
  const legacyWeekIds = new Set((weeks ?? []).map((w) => w.id as string));
  if (legacyWeekIds.size === 0) return { note: "레거시 주차 없음", counts: {} };

  // 타깃 → 라인 조인으로 competency/experience 라인 수 집계(is_qa_test 컬럼은 아직 없을 수 있으므로 미참조).
  const counts: Record<string, { lines: Set<string>; targets: number }> = {
    competency: { lines: new Set(), targets: 0 },
    experience: { lines: new Set(), targets: 0 },
  };
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from("cluster4_line_targets")
      .select("week_id, line_id, cluster4_lines!inner(id,part_type,is_active,experience_line_master_id)")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as any[];
    for (const r of rows) {
      const line = r.cluster4_lines;
      if (!line || !line.is_active) continue;
      if (!legacyWeekIds.has(r.week_id)) continue;
      if (line.part_type === "competency") {
        counts.competency.lines.add(line.id);
        counts.competency.targets++;
      } else if (line.part_type === "experience") {
        // 통합 라인 제외는 experience_line_master_id 로 판별해야 하나 마스터 id 미상 —
        // 일단 전체 experience 를 세고, 통합 여부는 후속 세부 진단으로 남긴다.
        counts.experience.lines.add(line.id);
        counts.experience.targets++;
      }
    }
    if (rows.length < 1000) break;
    from += 1000;
  }
  return {
    competency: { lines: counts.competency.lines.size, targets: counts.competency.targets },
    experience: { lines: counts.experience.lines.size, targets: counts.experience.targets },
    note: "experience 는 [통합] 포함 총계 — 통합 제외 세부는 후속.",
  };
}

async function loadLegacyWeekIds() {
  const ids = new Set<string>();
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from("weeks")
      .select("id")
      .lt("start_date", LEGACY_BEFORE)
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    for (const r of rows) ids.add(r.id as string);
    if (rows.length < 1000) break;
    from += 1000;
  }
  return ids;
}

async function main() {
  legacyWeekIds = await loadLegacyWeekIds();
  const users = await pickUsers();
  console.log(`sampled users: ${users.length} (cap ${USER_CAP}) | legacy weeks: ${legacyWeekIds.size}`);

  const results = await mapWithConcurrency(users, CONCURRENCY, (u) => diagUser(u));

  let totalWeeks = 0;
  let totalDiffWeeks = 0;
  let totalDiffLegacy = 0;
  let totalDiffCurrent = 0;
  let hubDiffCount = 0;
  const hubDiffByHub: Record<string, { legacy: number; current: number }> = {
    info: { legacy: 0, current: 0 },
    competency: { legacy: 0, current: 0 },
    experience: { legacy: 0, current: 0 },
    career: { legacy: 0, current: 0 },
  };
  let seasonDiffCount = 0;
  const errored: string[] = [];
  const usersWithTotalDiff: string[] = [];
  const usersWithHubDiff: string[] = [];
  const sampleTotal: any[] = [];
  const sampleHub: any[] = [];
  const sampleSeason: any[] = [];

  for (const r of results) {
    if (r.error) { errored.push(`${r.userId}: ${r.error}`); continue; }
    totalWeeks += r.weeks;
    if (r.totalDiffs.length) {
      totalDiffWeeks += r.totalDiffs.length;
      usersWithTotalDiff.push(r.userId);
      for (const d of r.totalDiffs) {
        if (d.legacy) totalDiffLegacy++; else totalDiffCurrent++;
        if (sampleTotal.length < 25) sampleTotal.push({ userId: r.userId, ...d });
      }
    }
    if (r.hubDiffs.length) {
      hubDiffCount += r.hubDiffs.length;
      usersWithHubDiff.push(r.userId);
      for (const d of r.hubDiffs) {
        const bucket = hubDiffByHub[d.hub];
        if (bucket) { if (d.legacy) bucket.legacy++; else bucket.current++; }
        if (sampleHub.length < 40) sampleHub.push({ userId: r.userId, ...d });
      }
    }
    if (r.seasonDiffs.length) {
      seasonDiffCount += r.seasonDiffs.length;
      for (const d of r.seasonDiffs) if (sampleSeason.length < 25) sampleSeason.push({ userId: r.userId, ...d });
    }
  }

  console.log("\n==== SUMMARY ====");
  console.log(`users compared: ${results.length - errored.length} / ${results.length} (errored ${errored.length})`);
  console.log(`weeks compared: ${totalWeeks}`);
  console.log(`TOTAL(header) diff weeks: ${totalDiffWeeks} (legacy ${totalDiffLegacy} / current ${totalDiffCurrent}) across ${usersWithTotalDiff.length} users`);
  console.log(`HUB diff cells: ${hubDiffCount} across ${usersWithHubDiff.length} users`);
  console.log("  by hub (legacy/current):", JSON.stringify(hubDiffByHub));
  console.log(`SEASON rate diffs: ${seasonDiffCount}`);
  if (errored.length) {
    console.log("\nerrors (first 10):");
    for (const e of errored.slice(0, 10)) console.log("  ", e);
  }
  console.log("\nTOTAL diff samples:");
  for (const s of sampleTotal.slice(0, 15)) console.log("  ", JSON.stringify(s));
  console.log("\nHUB diff samples:");
  for (const s of sampleHub.slice(0, 20)) console.log("  ", JSON.stringify(s));
  console.log("\nSEASON diff samples:");
  for (const s of sampleSeason.slice(0, 15)) console.log("  ", JSON.stringify(s));

  console.log("\n==== LEGACY LINE DIAGNOSTIC (Phase 3 blast-radius) ====");
  const legacy = await legacyLineDiagnostic();
  console.log(JSON.stringify(legacy, null, 2));

  const out = {
    sampledUsers: users.length,
    weeksCompared: totalWeeks,
    totalDiffWeeks,
    totalDiffLegacy,
    totalDiffCurrent,
    usersWithTotalDiff,
    hubDiffCount,
    hubDiffByHub,
    usersWithHubDiff,
    seasonDiffCount,
    errored,
    sampleTotal,
    sampleHub,
    sampleSeason,
    legacy,
  };
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    "claudedocs/cluster4-sot-divergence-phase0.json",
    JSON.stringify(out, null, 2),
    "utf8",
  );
  console.log("\nsaved → claudedocs/cluster4-sot-divergence-phase0.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
