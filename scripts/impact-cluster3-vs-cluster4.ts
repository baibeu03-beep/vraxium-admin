/**
 * [READ-ONLY] Phase 0 영향도 리포트.
 *
 * 목적: "주차 결과 SoT = cluster4" 전제를 적용해 cluster3 성장지표를
 *       cluster4 기준으로 교체했을 때 사용자별로 무엇이 바뀌는지 비교한다.
 *       DB 는 읽기만 한다(upsert/update 없음). 어떤 테이블도 수정하지 않는다.
 *
 * 비교 대상(지표 6종):
 *   1) success 주차(a)  2) fail 주차(b)  3) personal_rest 주차(c)
 *   4) official_rest 주차(d)  5) 성장 가능 주차(e=a+b+c)  6) 지나간 주차(h)
 *     - h 신정의: end_date<today 인 전환 제외 주차 = a+b+c+d+tallying (running/미래/전환 제외)
 *
 * 상태 변화(성장 상태 10종 displayKey) 도 함께 비교한다.
 *
 * 데이터 소스:
 *   - cluster3(기존): getGrowthIndicatorsInternal(profileUserId)
 *       → period{a,b,c,d,e,h}, process.growthDisplayKey, _debug.{currentWeekStatus,graduationThreshold}
 *   - cluster4(신규): getWeeklyGrowth(legacyUserId)
 *       → growthSummary{approvedWeeks=a, failedWeeks=b, restWeeks=c, availableWeeks=e}
 *       → weeklyCards[] 로 official_rest(d) / tallying 카운트
 *   - 새 displayKey: resolveDisplayKey() 를 cluster3GrowthData.ts:116-137 와 동일하게 재현,
 *       cluster4 기반 a/h 를 주입(나머지 입력은 cluster3 와 동일하게 사용).
 *
 * 사용:
 *   npx tsx --env-file=.env.local scripts/impact-cluster3-vs-cluster4.ts          # 전체
 *   npx tsx --env-file=.env.local scripts/impact-cluster3-vs-cluster4.ts --limit 10
 */
import { createClient } from "@supabase/supabase-js";
import { getGrowthIndicatorsInternal } from "@/lib/cluster3GrowthData";
import { getWeeklyGrowth } from "@/lib/cluster4WeeklyGrowthData";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(url, key);

const CONCURRENCY = 3; // cluster4 계산이 무거우므로 낮게.

// argv: --limit N
function argLimit(): number | null {
  const i = process.argv.indexOf("--limit");
  if (i >= 0 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  return null;
}

type GrowthDisplayKey =
  | "graduated" | "suspended" | "paused" | "graduating"
  | "seasonal_rest" | "weekly_rest" | "official_rest"
  | "onboarding" | "extra_growth" | "active";

// cluster3GrowthData.ts:116-137 과 1:1 재현 (입력 a/h 만 cluster4 기반으로 교체).
function resolveDisplayKey(
  dbStatus: string | null,
  currentWeekStatus: string | null,
  a: number,
  h: number,
  graduationThreshold: number | null,
): GrowthDisplayKey {
  switch (dbStatus) {
    case "graduated": return "graduated";
    case "suspended": return "suspended";
    case "paused": return "paused";
    case "graduating": return "graduating";
    case "seasonal_rest": return "seasonal_rest";
    case "weekly_rest": return "weekly_rest";
  }
  if (currentWeekStatus === "official_rest") return "official_rest";
  if (h <= 1) return "onboarding";
  if (graduationThreshold !== null && a >= graduationThreshold) return "extra_growth";
  return "active";
}

async function listUsers(): Promise<
  { user_id: string; growth_status: string | null }[]
> {
  const rows: { user_id: string; growth_status: string | null }[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("user_profiles")
      .select("user_id,growth_status")
      .order("user_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as typeof rows;
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

type Row = {
  user_id: string;
  dbStatus: string | null;
  skip: string | null; // 비교 불가 사유
  old: { a: number; b: number; c: number; d: number; e: number; h: number; key: string };
  neu: { a: number; b: number; c: number; d: number; e: number; h: number; key: string };
  tallying: number;
  causes: string[];
};

function classifyCauses(r: Row): string[] {
  const causes: string[] = [];
  const dA = r.neu.a - r.old.a;
  const dB = r.neu.b - r.old.b;
  const dD = r.neu.d - r.old.d;
  const dH = r.neu.h - r.old.h;
  // success↓ 와 fail↑ 가 짝이면 verdict fail 전환.
  if (dA < 0 && dB > 0 && Math.abs(dA) === dB) {
    causes.push(`verdict fail 전환 (success→fail ${dB}건)`);
  } else {
    if (dA < 0) causes.push(`success ↓${-dA} (미공표 tallying 미집계 또는 카드 구조 차이)`);
    if (dB > 0 && !(dA < 0)) causes.push(`fail ↑${dB} (official_rest 재판정→fail 등)`);
  }
  if (dD !== 0) {
    causes.push(
      `official_rest ${dD > 0 ? "↑" : "↓"}${Math.abs(dD)} ` +
      `(현재주 official_rest 카드화 / no_data skip / seasonCalendar∪periods 재판정)`,
    );
  }
  if (r.tallying > 0) causes.push(`tallying ${r.tallying}건 (신 h 정의에 포함)`);
  if (dH !== 0 && causes.length === 0) causes.push(`지나간 주차 변화 (Δ${dH}) — 구조 차이`);
  if (r.old.key !== r.neu.key) causes.push(`상태키 변화: ${r.old.key} → ${r.neu.key}`);
  return causes.length ? causes : ["(수치 동일 — 변화 없음)"];
}

async function compute(u: {
  user_id: string;
  growth_status: string | null;
}): Promise<Row> {
  const base: Row = {
    user_id: u.user_id,
    dbStatus: u.growth_status,
    skip: null,
    old: { a: 0, b: 0, c: 0, d: 0, e: 0, h: 0, key: "-" },
    neu: { a: 0, b: 0, c: 0, d: 0, e: 0, h: 0, key: "-" },
    tallying: 0,
    causes: [],
  };

  // cluster3 (기존)
  let currentWeekStatus: string | null = null;
  let threshold: number | null = null;
  try {
    const c3 = await getGrowthIndicatorsInternal(u.user_id);
    base.old = {
      a: c3.period.a, b: c3.period.b, c: c3.period.c, d: c3.period.d,
      e: c3.period.e, h: c3.period.h, key: c3.process.growthDisplayKey,
    };
    currentWeekStatus = c3._debug.currentWeekStatus;
    threshold = c3._debug.graduationThreshold;
  } catch (e) {
    base.skip = `cluster3 err: ${e instanceof Error ? e.message : e}`;
    return base;
  }

  // cluster4 (신규) — getWeeklyGrowth 의 param 은 historical 명칭일 뿐 실제로는 profile user_id.
  let g;
  try {
    g = await getWeeklyGrowth(u.user_id);
  } catch (e) {
    base.skip = `cluster4 err: ${e instanceof Error ? e.message : e}`;
    return base;
  }
  if (!g) {
    base.skip = "cluster4: crew 없음(getAdminCrewDtoByLegacyUserId null)";
    return base;
  }

  const cards = g.weeklyCards.filter((c) => !c.isTransition);
  const newD = cards.filter((c) => c.resultStatus === "official_rest").length;
  const tallying = cards.filter((c) => c.resultStatus === "tallying").length;
  const newA = g.growthSummary.approvedWeeks;
  const newB = g.growthSummary.failedWeeks;
  const newC = g.growthSummary.restWeeks;
  const newE = newA + newB + newC;
  const newH = newA + newB + newC + newD + tallying; // 신 정의

  const newKey = resolveDisplayKey(base.dbStatus, currentWeekStatus, newA, newH, threshold);

  base.neu = { a: newA, b: newB, c: newC, d: newD, e: newE, h: newH, key: newKey };
  base.tallying = tallying;
  return base;
}

function changed(r: Row): boolean {
  if (r.skip) return false;
  return (
    r.old.a !== r.neu.a || r.old.b !== r.neu.b || r.old.c !== r.neu.c ||
    r.old.d !== r.neu.d || r.old.e !== r.neu.e || r.old.h !== r.neu.h ||
    r.old.key !== r.neu.key
  );
}

async function run() {
  const limit = argLimit();
  let users = await listUsers();
  if (limit) users = users.slice(0, limit);
  console.log(`[impact] 대상 사용자 = ${users.length}${limit ? ` (--limit ${limit})` : ""}`);

  const results: Row[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < users.length) {
      const i = cursor++;
      const r = await compute(users[i]);
      r.causes = changed(r) ? classifyCauses(r) : [];
      results.push(r);
      if (results.length % 25 === 0) console.log(`[impact] ${results.length}/${users.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, users.length) }, worker));

  const skipped = results.filter((r) => r.skip);
  const comparable = results.filter((r) => !r.skip);
  const changedRows = comparable.filter(changed);
  const unchanged = comparable.length - changedRows.length;

  // 상태 전이 집계
  const transitions = new Map<string, number>();
  for (const r of changedRows) {
    if (r.old.key !== r.neu.key) {
      const k = `${r.old.key} → ${r.neu.key}`;
      transitions.set(k, (transitions.get(k) ?? 0) + 1);
    }
  }

  console.log("\n================= 영향도 리포트 =================");
  console.log(`전체 대상       : ${results.length}`);
  console.log(`비교 가능       : ${comparable.length}`);
  console.log(`비교 불가(skip) : ${skipped.length}`);
  console.log(`변화 없음       : ${unchanged}`);
  console.log(`변화 있음       : ${changedRows.length}`);

  console.log("\n--- 상태키 전이 집계 ---");
  if (transitions.size === 0) console.log("(상태키 변화 없음)");
  else for (const [k, n] of [...transitions.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k} : ${n}명`);
  }

  console.log("\n--- 변화 사용자 상세 ---");
  for (const r of changedRows) {
    const o = r.old, n = r.neu;
    const fmt = (x: typeof o) => `a${x.a} b${x.b} c${x.c} d${x.d} e${x.e} h${x.h} [${x.key}]`;
    console.log(`\nuser=${r.user_id} dbStatus=${r.dbStatus}`);
    console.log(`  before: ${fmt(o)}`);
    console.log(`  after : ${fmt(n)}`);
    console.log(`  원인  : ${r.causes.join(" | ")}`);
  }

  if (skipped.length) {
    console.log("\n--- 비교 불가 상세 ---");
    for (const r of skipped) console.log(`  user=${r.user_id} → ${r.skip}`);
  }
  console.log("\n=================================================");

  // 머신리더블 요약(선택 활용)
  console.log("\n[JSON]");
  console.log(JSON.stringify({
    total: results.length,
    comparable: comparable.length,
    skipped: skipped.length,
    unchanged,
    changed: changedRows.length,
    transitions: Object.fromEntries(transitions),
  }));
}

run().catch((e) => {
  console.error("[impact] fatal", e);
  process.exit(1);
});
