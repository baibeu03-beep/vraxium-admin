/**
 * audit-cross-app-parity.ts — 어드민 ↔ 고객 앱 표시값 전수 파리티 감사 (HTTP 기준).
 *
 *   npx tsx --env-file=.env.local scripts/audit-cross-app-parity.ts
 *   npx tsx --env-file=.env.local scripts/audit-cross-app-parity.ts <userId1> <userId2> ...
 *
 * 목적: 같은 userId / 같은 시즌 / 같은 주차에서 어드민 API 응답과 고객 API 응답이
 *       불일치하는 필드를 실제 HTTP 응답 기준으로 자동 비교한다. (grep 아님)
 *
 * 비교 축:
 *   · 고객 HTTP  vs  어드민 HTTP        (동일 userId cross-app 파리티)
 *   · direct lib fn  vs  어드민 HTTP     (snapshot SoT ↔ 배포본 정합)
 *   · direct lib fn  vs  고객 HTTP       (snapshot SoT ↔ 고객 화면값)
 *   · 고객 ?userId=  vs  고객 ?demoUserId= (일반 경로 vs demo 경로 DTO 분기)
 *
 * 환경 제약(사전 조사 결과):
 *   · 고객 prod = QA 모드 → 실유저 403(qaModeBlocked). 모집단=test_user_markers. → 테스터로 비교.
 *   · 어드민 prod demoUserId = 401(ENABLE_DEMO_MODE off). → 어드민 demo 경로는 로컬 전용(별도).
 *   · 어드민 cluster4/weekly-growth = internal-key 미수용(401). → direct getWeeklyGrowth 로 비교.
 *   · 어드민 랭킹/리그 = internal-key 엔드포인트 없음(session gated). → 구조적 독립(문서화만).
 */
import { createClient } from "@supabase/supabase-js";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { getWeeklyGrowth } from "@/lib/cluster4WeeklyGrowthData";
import { writeFileSync } from "node:fs";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const IK = process.env.INTERNAL_API_KEY!;
const sb = createClient(url, key, { auth: { persistSession: false } });

const ADMIN = process.env.ADMIN_BASE ?? "https://vraxium-admin.vercel.app";
const FRONT = process.env.FRONT_BASE ?? "https://vraxium.vercel.app";

type Cause =
  | "stale-grade-cache"
  | "stale-snapshot"
  | "graft-fallback-null"
  | "dto-divergence"
  | "legacy-local-calc"
  | "demo-path-branch"
  | "proxy-ok"
  | "frontend-render";

interface Finding {
  screen: string;
  field: string;
  userId: string;
  adminSource: string;
  customerSource: string;
  directValue: unknown;
  adminHttp: unknown;
  customerHttp: unknown;
  snapshotImpact: boolean;
  needsRecompute: boolean;
  cause: Cause;
  priority: 1 | 2 | 3;
  note?: string;
}

const findings: Finding[] = [];
function record(f: Finding) {
  findings.push(f);
}

async function fetchJson(u: string, headers?: Record<string, string>) {
  const t0 = Date.now();
  try {
    const res = await fetch(u, { headers, signal: AbortSignal.timeout(30000) });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* non-json */
    }
    return { status: res.status, json, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, json: null, ms: Date.now() - t0, err: (e as Error).name };
  }
}

const num = (v: unknown): number | null =>
  v === null || v === undefined || v === "" ? null : Number(v);
const eqNum = (a: unknown, b: unknown, tol = 0.01) => {
  const x = num(a);
  const y = num(b);
  if (x === null && y === null) return true;
  if (x === null || y === null) return false;
  return Math.abs(x - y) <= tol;
};

// weekly-card 핵심 표시 필드만 추린 지문
function cardCore(c: any) {
  return {
    userWeekStatus: c.userWeekStatus ?? null,
    isRestWeek: c.isRestWeek ?? null,
    isTransition: c.isTransition ?? null,
    statusLabel: c.statusLabel ?? null,
    resultStatus: c.resultStatus ?? null,
    seasonKey: c.seasonKey ?? null,
    roleLabel: c.roleLabel ?? null,
    weeklyGrowthRate: c.weeklyGrowthRate ?? null,
    shield: c.points?.shield ?? null,
    star: c.points?.star ?? null,
    lightning: c.points?.lightning ?? null,
  };
}
function diffCardsCore(aCards: any[], bCards: any[]) {
  const aMap = new Map((aCards ?? []).map((c) => [c.weekId, cardCore(c)]));
  const bMap = new Map((bCards ?? []).map((c) => [c.weekId, cardCore(c)]));
  const ids = new Set([...aMap.keys(), ...bMap.keys()]);
  const diffs: any[] = [];
  for (const id of ids) {
    const a = aMap.get(id);
    const b = bMap.get(id);
    if (JSON.stringify(a) !== JSON.stringify(b))
      diffs.push({ weekId: id, a: a ?? "(missing)", b: b ?? "(missing)" });
  }
  return { aWeeks: aMap.size, bWeeks: bMap.size, diffs };
}

async function pickTesters(limit: number): Promise<string[]> {
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testerSet = new Set((markers ?? []).map((m) => m.user_id));
  // 최근 활동(uws) 있는 테스터 우선 — 표시값이 존재하는 유저만.
  const { data: uws } = await sb
    .from("user_week_statuses")
    .select("user_id")
    .order("week_start_date", { ascending: false })
    .limit(4000);
  const seen: string[] = [];
  for (const r of uws ?? []) {
    if (testerSet.has(r.user_id) && !seen.includes(r.user_id)) seen.push(r.user_id);
    if (seen.length >= limit) break;
  }
  return seen;
}

async function auditUser(uid: string) {
  console.log(`\n================= USER ${uid} =================`);

  // ---------- HTTP fetches (병렬) ----------
  const ikh = { "x-internal-api-key": IK };
  const [
    custProfile,
    custProfileDemo,
    custStats,
    custCards,
    custCardsDemo,
    custGrowth,
    admResume,
    admStats,
    admRank,
    admCards,
  ] = await Promise.all([
    fetchJson(`${FRONT}/api/profile?userId=${uid}`),
    fetchJson(`${FRONT}/api/profile?demoUserId=${uid}`),
    fetchJson(`${FRONT}/api/cluster3/stats-cards?userId=${uid}`),
    fetchJson(`${FRONT}/api/cluster4/weekly-cards?userId=${uid}`),
    fetchJson(`${FRONT}/api/cluster4/weekly-cards?demoUserId=${uid}`),
    fetchJson(`${FRONT}/api/cluster4/weekly-growth?userId=${uid}`),
    fetchJson(`${ADMIN}/api/cluster1/resume?userId=${uid}`, ikh),
    fetchJson(`${ADMIN}/api/cluster3/stats-cards?userId=${uid}`, ikh),
    fetchJson(`${ADMIN}/api/cluster3/club-rank?userId=${uid}`, ikh),
    fetchJson(`${ADMIN}/api/cluster4/weekly-cards?userId=${uid}`, ikh),
  ]);

  console.log(
    `HTTP: custProfile=${custProfile.status} custStats=${custStats.status} custCards=${custCards.status} custGrowth=${custGrowth.status} | admResume=${admResume.status} admStats=${admStats.status} admRank=${admRank.status} admCards=${admCards.status}`,
  );
  if (custProfile.status === 403 && custProfile.json?.qaModeBlocked) {
    console.log("  ⚠ 고객 403 qaModeBlocked — 실유저(QA 모집단 제외). 테스터로 재시도 필요.");
    return;
  }

  const cp = custProfile.json;
  const ar = admResume.json?.data;
  const as = admStats.json?.data;
  const arank = admRank.json?.data;

  // ================= 카테고리 1: 이력서/프로필 그래프트 필드 =================
  if (cp?.success && ar) {
    // P1 reliabilityRate (일정 신뢰도) — 고객 graft vs 어드민 정본
    if (!eqNum(cp.reliabilityRate, ar.scheduleReliability?.rate)) {
      record({
        screen: "이력서카드/프로필 일정신뢰도",
        field: "reliabilityRate",
        userId: uid,
        adminSource: "cluster1/resume scheduleReliability.rate",
        customerSource: "profile reliabilityRate (admin graft or null)",
        directValue: "(n/a)",
        adminHttp: ar.scheduleReliability?.rate,
        customerHttp: cp.reliabilityRate,
        snapshotImpact: false,
        needsRecompute: false,
        cause: cp.reliabilityRate === null ? "graft-fallback-null" : "dto-divergence",
        priority: cp.reliabilityRate === null ? 3 : 1,
        note: cp.reliabilityRate === null ? "graft 실패 시 null('-') — 안전 폴백" : undefined,
      });
    }
    // P2 completionRate (활동 완료율)
    if (!eqNum(cp.completionRate, ar.activityCompletion?.rate)) {
      record({
        screen: "이력서카드/프로필 활동완료율",
        field: "completionRate",
        userId: uid,
        adminSource: "cluster1/resume activityCompletion.rate",
        customerSource: "profile completionRate (admin graft or null)",
        directValue: "(n/a)",
        adminHttp: ar.activityCompletion?.rate,
        customerHttp: cp.completionRate,
        snapshotImpact: false,
        needsRecompute: false,
        cause: cp.completionRate === null ? "graft-fallback-null" : "dto-divergence",
        priority: cp.completionRate === null ? 3 : 1,
      });
    }
    // P3 practicalStats 4종
    for (const k of ["infoCount", "experienceCount", "abilityUnitCount", "careerProjectCount"] as const) {
      if (!eqNum(cp.practicalStats?.[k], ar.practicalStats?.[k])) {
        record({
          screen: "이력서카드 실무 4종",
          field: `practicalStats.${k}`,
          userId: uid,
          adminSource: `cluster1/resume practicalStats.${k}`,
          customerSource: `profile practicalStats.${k}`,
          directValue: "(n/a)",
          adminHttp: ar.practicalStats?.[k],
          customerHttp: cp.practicalStats?.[k],
          snapshotImpact: false,
          needsRecompute: false,
          cause: "dto-divergence",
          priority: 2,
        });
      }
    }
  }

  // P4 avgPercentile (품계 백분위) — 고객 cache-first vs 어드민 live
  if (cp?.success && arank) {
    const custPct = cp.gradeStats?.avgPercentile;
    if (!eqNum(custPct, arank.avgPercentile, 0.5)) {
      record({
        screen: "이력서카드 품계/백분위",
        field: "avgPercentile",
        userId: uid,
        adminSource: "cluster3/club-rank avgPercentile (live)",
        customerSource: "profile gradeStats.avgPercentile (user_grade_stats cache-first)",
        directValue: "(n/a)",
        adminHttp: arank.avgPercentile,
        customerHttp: custPct ?? null,
        snapshotImpact: false,
        needsRecompute: true,
        cause: custPct === null || custPct === undefined ? "graft-fallback-null" : "stale-grade-cache",
        priority: 1,
        note: "고객은 user_grade_stats 캐시 우선(캐시 null 일 때만 graft). 포인트 변경 후 sync:grade-stats 필요.",
      });
    }
  }

  // ================= 카테고리 4(proxy): stats-cards 고객 vs 어드민 (동일해야 정상) =================
  if (custStats.json?.success && as) {
    const cSucc = custStats.json?.data?.period?.successWeeks;
    const aSucc = as.period?.successWeeks;
    if (!eqNum(cSucc, aSucc)) {
      record({
        screen: "Details 카드 successWeeks (stats-cards proxy)",
        field: "period.successWeeks",
        userId: uid,
        adminSource: "cluster3/stats-cards period.successWeeks",
        customerSource: "cluster3/stats-cards (admin proxy)",
        directValue: "(n/a)",
        adminHttp: aSucc,
        customerHttp: cSucc,
        snapshotImpact: false,
        needsRecompute: false,
        cause: "proxy-ok",
        priority: 2,
        note: "고객이 어드민을 프록시 — 불일치면 프록시 깨짐(캐시/배포 지연).",
      });
    }
  }

  // ================= 카테고리 3: weekly-cards 고객(proxy) vs 어드민 =================
  if (custCards.status === 200 && admCards.status === 200) {
    const { aWeeks, bWeeks, diffs } = diffCardsCore(admCards.json?.data ?? [], custCards.json?.data ?? []);
    console.log(`  weekly-cards core: admin=${aWeeks} cust=${bWeeks} coreDiffs=${diffs.length}`);
    if (diffs.length > 0) {
      record({
        screen: "주차 카드(핵심 필드)",
        field: `${diffs.length} weeks differ`,
        userId: uid,
        adminSource: "cluster4/weekly-cards (snapshot SoT)",
        customerSource: "cluster4/weekly-cards (admin proxy + lineRating enrich)",
        directValue: "(see W2 snapshot)",
        adminHttp: `${aWeeks} weeks`,
        customerHttp: `${bWeeks} weeks`,
        snapshotImpact: true,
        needsRecompute: true,
        cause: "dto-divergence",
        priority: 1,
        note: JSON.stringify(diffs.slice(0, 3)),
      });
    }
  }

  // ================= direct SoT: readWeeklyCardsSnapshot vs 어드민 HTTP (W2) =================
  const snap = await readWeeklyCardsSnapshot(uid);
  const snapCards = snap.status === "hit" || snap.status === "stale" ? (snap as any).cards : [];
  if (admCards.status === 200) {
    const { diffs } = diffCardsCore(snapCards as any[], admCards.json?.data ?? []);
    console.log(
      `  snapshot(direct) status=${snap.status}${"reason" in snap ? ` reason=${(snap as any).reason}` : ""} vs adminHTTP coreDiffs=${diffs.length}`,
    );
    if (diffs.length > 0) {
      record({
        screen: "주차 카드 snapshot 정합",
        field: `direct snapshot vs admin HTTP (${diffs.length} weeks)`,
        userId: uid,
        adminSource: "cluster4/weekly-cards HTTP",
        customerSource: "(n/a)",
        directValue: `readWeeklyCardsSnapshot status=${snap.status}`,
        adminHttp: "see snapshot",
        customerHttp: "(n/a)",
        snapshotImpact: true,
        needsRecompute: snap.status === "stale",
        cause: "stale-snapshot",
        priority: 2,
        note: JSON.stringify(diffs.slice(0, 3)),
      });
    }
  }

  // ================= 카테고리 4(C4): weekly-growth 고객(local) vs direct getWeeklyGrowth(SoT) =================
  const direct = await getWeeklyGrowth(uid);
  const cg = custGrowth.json?.data ?? custGrowth.json;
  if (direct && cg) {
    const dSum = {
      currentWeekStatus: direct.currentWeekInfo?.status ?? null,
      approvedWeeks: (direct as any).growthSummary?.approvedWeeks ?? null,
      availableWeeks: (direct as any).growthSummary?.availableWeeks ?? null,
      failedWeeks: (direct as any).growthSummary?.failedWeeks ?? null,
      restWeeks: (direct as any).growthSummary?.restWeeks ?? null,
    };
    // 고객 weekly-growth 는 독립 구현 — seasonSummary/status 를 로컬 산식으로 생성.
    const cSum = {
      currentWeekStatus: cg.currentWeekInfo?.status ?? cg.currentWeekStatus ?? null,
      seasonResult: cg.seasonResult ?? cg.seasonSummary?.seasonResult ?? null,
      statusLabel: cg.statusLabel ?? cg.seasonSummary?.statusLabel ?? null,
      cards: Array.isArray(cg.data) ? cg.data.length : Array.isArray(cg.weeklyCards) ? cg.weeklyCards.length : null,
    };
    console.log(`  weekly-growth direct(SoT):`, JSON.stringify(dSum));
    console.log(`  weekly-growth cust(local):`, JSON.stringify(cSum));
    // 상태 라벨/결과 divergence 만 기록(카운트 필드는 DTO 형태가 달라 별도 표기).
    // 여기서는 currentWeekStatus 만 직접 비교(양쪽 공통 필드).
    if (dSum.currentWeekStatus !== cSum.currentWeekStatus && cSum.currentWeekStatus !== null) {
      record({
        screen: "주차 성장(현재주차 상태)",
        field: "currentWeekInfo.status",
        userId: uid,
        adminSource: "getWeeklyGrowth (direct SoT)",
        customerSource: "cluster4/weekly-growth (독립 로컬 구현)",
        directValue: dSum.currentWeekStatus,
        adminHttp: "(direct fn)",
        customerHttp: cSum.currentWeekStatus,
        snapshotImpact: false,
        needsRecompute: false,
        cause: "legacy-local-calc",
        priority: 2,
        note: "고객 weekly-growth 는 seasonSummary/status 를 자체 산식으로 계산(admin graft 실패 시 로컬 폴백).",
      });
    }
  }

  // ================= 카테고리 6: demo 경로 파리티 (고객 ?userId vs ?demoUserId) =================
  if (custProfile.status === 200 && custProfileDemo.status === 200) {
    const strip = (o: any) => {
      if (!o?.data) return o;
      // updated_at 등 시각 필드 제외 후 비교
      const { updated_at, ...rest } = o.data;
      return { ...o, data: rest };
    };
    const a = JSON.stringify(strip(custProfile.json));
    const b = JSON.stringify(strip(custProfileDemo.json));
    console.log(`  demo profile parity: ${a === b ? "IDENTICAL ✓" : "DIVERGES ✗"}`);
    if (a !== b) {
      record({
        screen: "profile 일반 vs demo 경로",
        field: "profile DTO (userId vs demoUserId)",
        userId: uid,
        adminSource: "(n/a)",
        customerSource: "profile ?userId= vs ?demoUserId=",
        directValue: "(n/a)",
        adminHttp: "(n/a)",
        customerHttp: "DTO differs",
        snapshotImpact: false,
        needsRecompute: false,
        cause: "demo-path-branch",
        priority: 2,
      });
    }
  }
  if (custCards.status === 200 && custCardsDemo.status === 200) {
    const { diffs } = diffCardsCore(custCards.json?.data ?? [], custCardsDemo.json?.data ?? []);
    console.log(`  demo weekly-cards parity: coreDiffs=${diffs.length}`);
    if (diffs.length > 0) {
      record({
        screen: "주차 카드 일반 vs demo 경로",
        field: `weekly-cards (${diffs.length} weeks)`,
        userId: uid,
        adminSource: "(n/a)",
        customerSource: "weekly-cards ?userId= vs ?demoUserId=",
        directValue: "(n/a)",
        adminHttp: "(n/a)",
        customerHttp: "cards differ",
        snapshotImpact: false,
        needsRecompute: false,
        cause: "demo-path-branch",
        priority: 2,
        note: JSON.stringify(diffs.slice(0, 3)),
      });
    }
  }
}

async function main() {
  const argv = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const testers = argv.length ? argv : await pickTesters(6);
  console.log(`감사 대상 테스터 ${testers.length}명:`, testers);

  for (const uid of testers) {
    await auditUser(uid);
  }

  // ---------- 리포트 ----------
  console.log(`\n\n#################### 파리티 감사 결과 ####################`);
  console.log(`총 findings: ${findings.length}`);
  const byCause: Record<string, number> = {};
  for (const f of findings) byCause[f.cause] = (byCause[f.cause] ?? 0) + 1;
  console.log("원인별:", JSON.stringify(byCause, null, 0));

  const sorted = [...findings].sort((a, b) => a.priority - b.priority);
  console.log(`\n--- 우선순위순 findings ---`);
  for (const f of sorted) {
    console.log(
      `\n[P${f.priority}] ${f.cause} — ${f.screen} / ${f.field}`,
    );
    console.log(`   user=${f.userId.slice(0, 8)}  admin=${JSON.stringify(f.adminHttp)}  cust=${JSON.stringify(f.customerHttp)}  direct=${JSON.stringify(f.directValue)}`);
    console.log(`   adminSrc: ${f.adminSource}`);
    console.log(`   custSrc : ${f.customerSource}`);
    console.log(`   snapshotImpact=${f.snapshotImpact} needsRecompute=${f.needsRecompute}`);
    if (f.note) console.log(`   note: ${f.note}`);
  }

  const outPath = "claudedocs/cross-app-parity-audit.json";
  writeFileSync(outPath, JSON.stringify({ testers, findings, byCause }, null, 2));
  console.log(`\n결과 저장: ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
