/**
 * [READ-ONLY] Step 5-A 최종 영향도 리포트 — cluster3 전환 전.
 *
 * A. 현재 cluster3GrowthData 기준 값 (getGrowthIndicatorsInternal: raw a/b/c/d/e/h + displayKey)
 * B. Growth Core 기준 값:
 *      - 주차 결과 6종 = resolveWeekResultStatus  (cluster4 getWeeklyGrowth.weeklyCards 경유)
 *      - 성장 지표     = foldGrowthMetrics         (resolved 카드 status 를 fold)
 *      - 성장 상태     = resolveGrowthStatus       (Core a/h 주입)
 *
 * 주의: cluster3GrowthData/cluster4 코드는 수정하지 않는다. 실데이터 읽기 전용.
 *   - B 의 주차 집합 = cluster4 resolved weeklyCards(전환 제외). cluster4 가 주차결과 SoT.
 *   - resolveGrowthStatus 의 currentWeekStatus 입력은 A._debug.currentWeekStatus 를 사용
 *     (status 변화는 a/h 임계 교차로만 발생 — 현재주 official_rest 재판정 영향은 caveat 로 보고).
 *
 *   npx tsx --env-file=.env.local scripts/impact-step5a-cluster3-core.ts [--limit N]
 */
import { createClient } from "@supabase/supabase-js";
import { getGrowthIndicatorsInternal } from "@/lib/cluster3GrowthData";
import { getWeeklyGrowth } from "@/lib/cluster4WeeklyGrowthData";
import { foldGrowthMetrics, resolveGrowthStatus } from "@/lib/growthCore";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(url, key);
const CONCURRENCY = 3;
// 신 h 정의(확정): end_date < today 인 전환 제외 주차. running/미래/현재 진행중 제외.
const TODAY_ISO = new Date().toISOString().slice(0, 10);

function argLimit(): number | null {
  const i = process.argv.indexOf("--limit");
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : null;
}

type Metrics = { a: number; b: number; c: number; d: number; e: number; h: number; key: string };
type Row = {
  user_id: string;
  org: string;
  dbStatus: string | null;
  threshold: number | null;
  skip: string | null;
  old: Metrics;
  neu: Metrics;
  tallying: number;
  // cause flags
  verdictFail: boolean;
  officialRestRejudge: boolean;
  tallyingIncluded: boolean;
  structural: boolean;
  statusChanged: boolean;
  // graduation
  eligOld: boolean;
  eligNew: boolean;
};

const ORGS = ["encre", "oranke", "phalanx"] as const;
function bucketOrg(o: string | null): string {
  if (o && (ORGS as readonly string[]).includes(o)) return o;
  return o ? `기타(${o})` : "(없음)";
}

async function listUsers(): Promise<string[]> {
  const ids: string[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("user_profiles")
      .select("user_id")
      .order("user_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { user_id: string }[];
    ids.push(...rows.map((r) => r.user_id));
    if (rows.length < PAGE) break;
  }
  return ids;
}

async function compute(userId: string): Promise<Row> {
  const base: Row = {
    user_id: userId, org: "(없음)", dbStatus: null, threshold: null, skip: null,
    old: { a: 0, b: 0, c: 0, d: 0, e: 0, h: 0, key: "-" },
    neu: { a: 0, b: 0, c: 0, d: 0, e: 0, h: 0, key: "-" },
    tallying: 0, verdictFail: false, officialRestRejudge: false,
    tallyingIncluded: false, structural: false, statusChanged: false,
    eligOld: false, eligNew: false,
  };

  // A — 현재 cluster3
  let currentWeekStatus: string | null = null;
  try {
    const a = await getGrowthIndicatorsInternal(userId);
    base.org = bucketOrg(a.organizationSlug);
    base.dbStatus = a.process.growthStatus;
    base.threshold = a._debug.graduationThreshold;
    currentWeekStatus = a._debug.currentWeekStatus;
    base.old = {
      a: a.period.a, b: a.period.b, c: a.period.c, d: a.period.d,
      e: a.period.e, h: a.period.h, key: a.process.growthDisplayKey,
    };
  } catch (e) {
    base.skip = `cluster3 err: ${e instanceof Error ? e.message : e}`;
    return base;
  }

  // B — Growth Core (cluster4 resolved cards)
  let g;
  try {
    g = await getWeeklyGrowth(userId);
  } catch (e) {
    base.skip = `core/cluster4 err: ${e instanceof Error ? e.message : e}`;
    return base;
  }
  if (!g) { base.skip = "crew 없음(getWeeklyGrowth null)"; return base; }

  const cards = g.weeklyCards.filter((c) => !c.isTransition);
  const m = foldGrowthMetrics({
    weeks: cards.map((c) => ({ status: c.resultStatus, isTransition: false })),
    restSeasonCount: 0,
  });
  const dNew = cards.filter((c) => c.resultStatus === "official_rest").length;
  const tallying = cards.filter((c) => c.resultStatus === "tallying").length;
  const aNew = m.approvedWeeks, bNew = m.failedWeeks, cNew = m.restWeeks;
  const eNew = m.availableWeeks;            // a+b+c
  // 신 h 정의(확정): end_date < today 인 전환 제외 주차 (현재 진행중 공식휴식/running 제외).
  const hNew = cards.filter((c) => c.endDate < TODAY_ISO).length;
  const keyNew = resolveGrowthStatus({
    growthStatus: base.dbStatus,
    currentWeekStatus,
    approvedWeeks: aNew,
    elapsedWeeks: hNew,
    graduationThreshold: base.threshold,
  });

  base.neu = { a: aNew, b: bNew, c: cNew, d: dNew, e: eNew, h: hNew, key: keyNew };
  base.tallying = tallying;

  // 원인 분류
  const dA = aNew - base.old.a, dB = bNew - base.old.b, dD = dNew - base.old.d;
  base.verdictFail = dA < 0 && dB > 0 && Math.abs(dA) === dB;
  base.officialRestRejudge = dD !== 0;
  base.tallyingIncluded = tallying > 0;
  // 구조 차이: terminal 합(a+b+c+d)이 verdict 보정으로 설명되지 않는 차이
  const oldTerminal = base.old.a + base.old.b + base.old.c + base.old.d;
  const newTerminal = aNew + bNew + cNew + dNew;
  base.structural = newTerminal !== oldTerminal && !(base.verdictFail && newTerminal === oldTerminal);
  base.statusChanged = base.old.key !== keyNew;

  // 졸업 조건 (a >= threshold)
  base.eligOld = base.threshold !== null && base.old.a >= base.threshold;
  base.eligNew = base.threshold !== null && aNew >= base.threshold;

  return base;
}

function changed(r: Row): boolean {
  if (r.skip) return false;
  const o = r.old, n = r.neu;
  return o.a !== n.a || o.b !== n.b || o.c !== n.c || o.d !== n.d || o.e !== n.e || o.h !== n.h || o.key !== n.key;
}

function score(r: Row): number {
  return (r.verdictFail ? 100 : 0) + (r.statusChanged ? 60 : 0) +
    Math.abs(r.neu.a - r.old.a) * 5 + Math.abs(r.neu.h - r.old.h) + Math.abs(r.neu.d - r.old.d) * 2 +
    (r.eligOld !== r.eligNew ? 80 : 0);
}

async function run() {
  const limit = argLimit();
  let users = await listUsers();
  if (limit) users = users.slice(0, limit);
  console.log(`[5A] 대상 사용자 = ${users.length}${limit ? ` (--limit ${limit})` : ""}`);

  const results: Row[] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, users.length) }, async () => {
    while (cursor < users.length) {
      const i = cursor++;
      results.push(await compute(users[i]));
      if (results.length % 25 === 0) console.log(`[5A] ${results.length}/${users.length}`);
    }
  }));

  const comparable = results.filter((r) => !r.skip);
  const skipped = results.filter((r) => r.skip);
  const changedRows = comparable.filter(changed);

  // 원인 집계
  const cnt = {
    verdictFail: changedRows.filter((r) => r.verdictFail).length,
    officialRestRejudge: changedRows.filter((r) => r.officialRestRejudge).length,
    tallyingIncluded: changedRows.filter((r) => r.tallyingIncluded).length,
    structural: changedRows.filter((r) => r.structural).length,
    statusChanged: changedRows.filter((r) => r.statusChanged).length,
  };

  // 상태 전이
  const transitions = new Map<string, number>();
  for (const r of changedRows) if (r.statusChanged) {
    const k = `${r.old.key} → ${r.neu.key}`;
    transitions.set(k, (transitions.get(k) ?? 0) + 1);
  }

  // 졸업 조건 영향
  const gradLost = comparable.filter((r) => r.eligOld && !r.eligNew);
  const gradGained = comparable.filter((r) => !r.eligOld && r.eligNew);

  // 조직별 요약
  const orgKeys = [...new Set(comparable.map((r) => r.org))].sort();
  const orgSummary = orgKeys.map((org) => {
    const inOrg = comparable.filter((r) => r.org === org);
    return {
      org,
      total: inOrg.length,
      changed: inOrg.filter(changed).length,
      verdictFail: inOrg.filter((r) => r.verdictFail).length,
      officialRest: inOrg.filter((r) => r.officialRestRejudge).length,
      gradLost: inOrg.filter((r) => r.eligOld && !r.eligNew).length,
      gradGained: inOrg.filter((r) => !r.eligOld && r.eligNew).length,
    };
  });

  const fmt = (x: Metrics) => `a${x.a} b${x.b} c${x.c} d${x.d} e${x.e} h${x.h} [${x.key}]`;

  console.log("\n================= Step 5-A 영향도 리포트 =================");
  console.log(`전체 대상       : ${results.length}`);
  console.log(`비교 가능       : ${comparable.length}`);
  console.log(`비교 불가(skip) : ${skipped.length}`);
  console.log(`변화 없음       : ${comparable.length - changedRows.length}`);
  console.log(`변화 있음       : ${changedRows.length}`);

  console.log("\n--- 변화 원인별 건수(중복 가능) ---");
  console.log(`  실무경험 verdict fail 보정 : ${cnt.verdictFail}`);
  console.log(`  공식 휴식 재판정(d 변동)   : ${cnt.officialRestRejudge}`);
  console.log(`  집계전(tallying) h 포함    : ${cnt.tallyingIncluded}`);
  console.log(`  구조 차이(uws vs 카드)     : ${cnt.structural}`);
  console.log(`  성장 상태(key) 변화        : ${cnt.statusChanged}`);

  console.log("\n--- 성장 상태 전이 ---");
  if (transitions.size === 0) console.log("  (상태키 변화 없음)");
  else for (const [k, n] of [...transitions.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k} : ${n}명`);

  console.log("\n--- 졸업 조건(a >= threshold) 영향 ---");
  console.log(`  충족→미충족(regression) : ${gradLost.length}`);
  if (gradLost.length) gradLost.slice(0, 10).forEach((r) => console.log(`     user=${r.user_id} org=${r.org} thr=${r.threshold} aOld=${r.old.a}→aNew=${r.neu.a}`));
  console.log(`  미충족→충족(newly)      : ${gradGained.length}`);
  if (gradGained.length) gradGained.slice(0, 10).forEach((r) => console.log(`     user=${r.user_id} org=${r.org} thr=${r.threshold} aOld=${r.old.a}→aNew=${r.neu.a}`));

  console.log("\n--- 조직별 요약 ---");
  for (const s of orgSummary) {
    console.log(`  ${s.org.padEnd(12)} total=${s.total} changed=${s.changed} verdictFail=${s.verdictFail} officialRest=${s.officialRest} gradLost=${s.gradLost} gradGained=${s.gradGained}`);
  }

  console.log("\n--- 대표 사용자 10명(변화 크기순) ---");
  [...changedRows].sort((a, b) => score(b) - score(a)).slice(0, 10).forEach((r) => {
    const tags = [
      r.verdictFail ? "verdictFail" : "", r.officialRestRejudge ? "officialRest" : "",
      r.tallyingIncluded ? "tallying" : "", r.structural ? "structural" : "",
      r.statusChanged ? "statusΔ" : "", r.eligOld !== r.eligNew ? "gradΔ" : "",
    ].filter(Boolean).join(",");
    console.log(`\n  user=${r.user_id} org=${r.org} dbStatus=${r.dbStatus} thr=${r.threshold}`);
    console.log(`    A(cluster3): ${fmt(r.old)}`);
    console.log(`    B(core)    : ${fmt(r.neu)}`);
    console.log(`    원인: ${tags || "(수치 차이)"}`);
  });

  if (skipped.length) {
    console.log("\n--- 비교 불가 ---");
    skipped.forEach((r) => console.log(`  user=${r.user_id} → ${r.skip}`));
  }

  console.log("\n[JSON]");
  console.log(JSON.stringify({
    total: results.length, comparable: comparable.length, skipped: skipped.length,
    unchanged: comparable.length - changedRows.length, changed: changedRows.length,
    causes: cnt, transitions: Object.fromEntries(transitions),
    gradLost: gradLost.length, gradGained: gradGained.length,
    org: orgSummary,
  }));
  console.log("=========================================================");
}

run().catch((e) => { console.error("[5A] fatal", e); process.exit(1); });
