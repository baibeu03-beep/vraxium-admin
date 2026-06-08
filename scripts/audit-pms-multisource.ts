/**
 * 3개 source system (oranke/hrdb/olympus) 동일 감사 (read-only — write 0, snapshot 0).
 *
 *   npx tsx --env-file=.env.local scripts/audit-pms-multisource.ts
 *
 * 주차 차원 = 각 시스템 "자체" weekssettings (start/end/Season/week/confirmStar) —
 *   라이브 weeks 는 ORANKE 달력만 백필(B7)돼 hrdb/olympus 에 적용 불가.
 *   3자 비교 가능성을 위해 oranke 도 동일 방법으로 재산출 (라이브 기준 수치는 기존 보고 참조).
 * 판정 로직 = dryrun-1092 미러: §5-1 집계(net_all·14일 보호·Shield alive)·시즌정규화+week+날짜窓 귀속·
 *   v18(rating>3 AND points>=confirmStar[NULL→30])·adjustment(잔액−주차합).
 */
import { writeFileSync, readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";

const OUT = "claudedocs/audit-pms-multisource-20260607.json";
const DEFAULT_THRESHOLD = 30;
const RATING_FAIL_MAX = 3;
const SYSTEMS = ["oranke", "hrdb", "olympus"] as const;

const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);

const SEASON_DICT = new Map([["봄", "spring"], ["여름", "summer"], ["가을", "autumn"], ["겨울", "winter"], ["거울", "winter"]]);
const normSeason = (s: unknown) => {
  let x = String(s ?? "").replace(/[\s\r\n ]+/g, "");
  if (x.endsWith("시즌")) x = x.slice(0, -2);
  return SEASON_DICT.get(x) ?? null;
};
const addDays = (iso: string, d: number) => {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
};

async function auditSystem(conn: mysql.Connection, db: string, vraxLegacyIds: number[]) {
  const q = async (sql: string) => (await conn.query(sql))[0] as any[];

  // ── 주차 차원: 자체 weekssettings ──
  const ws = await q(`
    SELECT Season, week, CAST(StartDate AS CHAR) AS s, CAST(EndDate AS CHAR) AS e, confirmStar, IsPublic
    FROM ${db}.weekssettings WHERE StartDate IS NOT NULL ORDER BY StartDate`);
  const dim = ws
    .map((r) => ({
      seasonNorm: normSeason(r.Season),
      weekNum: String(r.week ?? "").match(/^\d+$/) ? Number(r.week) : null,
      start: String(r.s).slice(0, 10),
      end: String(r.e ?? r.s).slice(0, 10),
      thr: r.confirmStar != null && r.confirmStar >= 0 ? Number(r.confirmStar) : DEFAULT_THRESHOLD,
    }))
    .filter((w) => w.start >= "2020-01-01");
  const weekByDate = (d: string) => dim.find((w) => d >= w.start && d <= w.end) ?? null;
  const attributeAct = (r: any) => {
    const type = normSeason(r.Season);
    if (!type) return null;
    const cands = dim.filter((w) => w.seasonNorm === type && w.weekNum === r.SeasonWeek);
    const dates = [r.StartDate, r.EndDate].filter(Boolean).map((d: string) => String(d).slice(0, 10));
    for (const w of cands) {
      const lo = addDays(w.start, -60), hi = addDays(w.end, 180);
      if (dates.some((d: string) => d >= lo && d <= hi)) return w;
    }
    return null;
  };

  // ── 사용자/상태/잔액 ──
  const users = await q(`
    SELECT u.UserId, u.Name, i.State, i.Week, CAST(i.StartDate AS CHAR) AS StartDate,
           p.Star AS balStar, p.Shield AS balShield
    FROM ${db}.users u JOIN ${db}.usersinfo i ON i.UserID=u.UserId
    LEFT JOIN ${db}.userspoint p ON p.UserID=u.UserId`);
  const stateDist = new Map<string, number>();
  for (const u of users) stateDist.set(u.State ?? "NULL", (stateDist.get(u.State ?? "NULL") ?? 0) + 1);
  const activeSet = new Set(users.filter((u) => u.State !== "졸업" && u.State !== "활동정지").map((u) => Number(u.UserId)));
  const protectUntil = new Map<number, string>();
  for (const u of users) {
    const sd = String(u.StartDate ?? "");
    if (sd >= "2020-01-01") {
      const t = new Date(`${sd.slice(0, 10)}T00:00:00Z`);
      t.setUTCDate(t.getUTCDate() + 14);
      protectUntil.set(Number(u.UserId), t.toISOString().slice(0, 10));
    }
  }

  // ── pointlogs 집계 (chunk) ──
  const CORR = `CASE WHEN YEAR(ActivityTime) BETWEEN 20 AND 99 THEN DATE(ActivityTime + INTERVAL 2000 YEAR)
                     WHEN YEAR(ActivityTime) = 1 THEN DATE(createtime) ELSE DATE(ActivityTime) END`;
  const [[{ maxLog }]] = (await conn.query(`SELECT MAX(LogNum) AS maxLog FROM ${db}.pointlogs`)) as any;
  type UA = { points: number; adv: number; pen: number };
  const agg = new Map<string, UA>(); // `${uid}|${weekStart}`
  let logTotal = 0, logUnattr = 0;
  for (let lo = 0; lo <= Number(maxLog); lo += 60000) {
    const rows = await q(`
      SELECT UserID, Star, Shield, IsDeleted, CAST(${CORR} AS CHAR) AS corrected
      FROM ${db}.pointlogs WHERE LogNum >= ${lo} AND LogNum < ${lo + 60000}`);
    for (const r of rows) {
      logTotal++;
      const uid = Number(r.UserID);
      const d = String(r.corrected);
      const w = weekByDate(d);
      if (!w) {
        if ((r.Star ?? 0) !== 0 || (r.Shield ?? 0) !== 0) logUnattr++;
        continue;
      }
      const k = `${uid}|${w.start}`;
      let a = agg.get(k);
      if (!a) { a = { points: 0, adv: 0, pen: 0 }; agg.set(k, a); }
      let star = Number(r.Star ?? 0);
      const pu = protectUntil.get(uid);
      if (star < 0 && pu && d < pu) star = 0;
      a.points += star;
      const sh = Number(r.Shield ?? 0);
      if (r.IsDeleted === 0) { if (sh > 0) a.adv += sh; else if (sh < 0) a.pen += -sh; }
    }
  }

  // ── 활동 귀속 ──
  type WP = { rec: boolean; rating: number | null; hasSubtitle: boolean };
  const plan = new Map<string, WP & { thr: number }>();
  let actTotal = 0, actUnattr = 0, actUnattrActive = 0;
  const actUnattrUsers = new Set<number>();
  const firstActiveWeekByUser = new Map<number, string>();
  for (const table of ["useractivities", "manageractivities"]) {
    const rows = await q(`
      SELECT UserId, Season, SeasonWeek, Star, IsActive,
             CHAR_LENGTH(TRIM(COALESCE(Activity,''))) AS actLen,
             CAST(StartDate AS CHAR) AS StartDate, CAST(EndDate AS CHAR) AS EndDate
      FROM ${db}.${table}`);
    for (const r of rows) {
      actTotal++;
      const uid = Number(r.UserId);
      const w = attributeAct(r);
      if (!w) {
        actUnattr++;
        if (r.IsActive === 1) actUnattrActive++;
        actUnattrUsers.add(uid);
        continue;
      }
      if (!firstActiveWeekByUser.has(uid) || w.start < firstActiveWeekByUser.get(uid)!) firstActiveWeekByUser.set(uid, w.start);
      const k = `${uid}|${w.start}`;
      let p = plan.get(k);
      if (!p) { p = { rec: false, rating: null, hasSubtitle: false, thr: w.thr }; plan.set(k, p); }
      if (r.IsActive === 1) p.rec = true;
      if (r.Star != null && (p.rating == null || Number(r.Star) > p.rating)) p.rating = Number(r.Star);
      if (Number(r.actLen) > 0) p.hasSubtitle = true;
    }
  }

  // ── 사용자별 지표 ──
  const userKeys = new Map<number, Set<string>>();
  for (const k of new Set([...agg.keys(), ...plan.keys()])) {
    const [uidS, start] = k.split("|");
    const uid = Number(uidS);
    let s = userKeys.get(uid);
    if (!s) { s = new Set(); userKeys.set(uid, s); }
    s.add(start);
  }
  let weekExact = 0, withDecl = 0;
  let pmsSuccess = 0, v18Success = 0, flips = 0;
  let expWeeks = 0, expSub = 0, expRat = 0;
  const adjBuckets = { "0": 0, "1~5": 0, "6~20": 0, "21~50": 0, "51~100": 0, "100+": 0 };
  for (const u of users) {
    const uid = Number(u.UserId);
    let success = 0, sumP = 0, sumA = 0, sumPen = 0;
    for (const start of userKeys.get(uid) ?? []) {
      const a = agg.get(`${uid}|${start}`) ?? { points: 0, adv: 0, pen: 0 };
      sumP += a.points; sumA += a.adv; sumPen += a.pen;
      const p = plan.get(`${uid}|${start}`);
      if (!p) continue;
      const ratingOk = p.rating == null || p.rating > RATING_FAIL_MAX;
      const v18 = ratingOk && a.points >= p.thr;
      if (p.rec) { success++; pmsSuccess++; }
      if (v18) v18Success++;
      if (p.rec && !v18) flips++;
      expWeeks++;
      if (p.hasSubtitle) expSub++;
      if (p.rating != null) expRat++;
    }
    if (u.Week != null && String(u.Week).match(/^\d+$/)) {
      withDecl++;
      if (Number(u.Week) === success) weekExact++;
    }
    if (u.balStar != null) {
      const m = Math.max(Math.abs(Number(u.balStar) - sumP), Math.abs(Number(u.balShield) - (sumA - sumPen)));
      if (m === 0) adjBuckets["0"]++;
      else if (m <= 5) adjBuckets["1~5"]++;
      else if (m <= 20) adjBuckets["6~20"]++;
      else if (m <= 50) adjBuckets["21~50"]++;
      else if (m <= 100) adjBuckets["51~100"]++;
      else adjBuckets["100+"]++;
    }
  }

  // 활동자 최소 주차
  const activeFirsts = [...firstActiveWeekByUser.entries()].filter(([uid]) => activeSet.has(uid)).map(([, s]) => s).sort();
  const oldestActive = activeFirsts[0] ?? null;
  const oldestDim = oldestActive ? dim.find((w) => w.start === oldestActive) : null;

  // legacy 충돌: Vraxium 비테스터 legacy id ∩ 이 시스템 UserId 점유 범위
  const ids = users.map((u) => Number(u.UserId));
  const lo = Math.min(...ids), hi = Math.max(...ids);
  const idSet = new Set(ids);
  const collisions = vraxLegacyIds.filter((x) => idSet.has(x));

  return {
    users: users.length,
    stateDist: Object.fromEntries([...stateDist.entries()].sort((a, b) => b[1] - a[1])),
    active: activeSet.size,
    weekssettingsRows: dim.length,
    weekssettingsRange: dim.length ? `${dim[0].start}~${dim.at(-1)!.end}` : "-",
    oldestActiveWeek: oldestDim ? `${oldestDim.seasonNorm} W${oldestDim.weekNum} (${oldestDim.start})` : oldestActive,
    pointlogs: { total: logTotal, unattributed: logUnattr },
    weekRepro: { exact: weekExact, withDecl, rate: `${((weekExact / Math.max(withDecl, 1)) * 100).toFixed(1)}%` },
    successRepro: { pms: pmsSuccess, v18: v18Success, flips, rate: `${((1 - flips / Math.max(pmsSuccess, 1)) * 100).toFixed(2)}%` },
    actAttribution: { total: actTotal, unattributed: actUnattr, unattrActive: actUnattrActive, users: actUnattrUsers.size },
    adjustment: adjBuckets,
    legacyCollision: { userIdRange: `${lo}~${hi}`, vraxOverlap: collisions.length },
    expRestore: {
      weeks: expWeeks,
      subtitle: `${((expSub / Math.max(expWeeks, 1)) * 100).toFixed(1)}%`,
      rating: `${((expRat / Math.max(expWeeks, 1)) * 100).toFixed(1)}%`,
    },
  };
}

async function main() {
  const conn = await mysql.createConnection({
    host: envGet("MYSQL_HOST"), port: Number(envGet("MYSQL_PORT") ?? 3306),
    user: envGet("MYSQL_USER"), password: envGet("MYSQL_PASSWORD"),
    dateStrings: true, ssl: { rejectUnauthorized: false },
  });
  // Vraxium 비테스터 legacy id (충돌 후보)
  const { data: bridges } = await sb.from("users").select("id,legacy_user_id").not("legacy_user_id", "is", null).lt("legacy_user_id", 100000000).limit(5000);
  const { data: markers } = await sb.from("test_user_markers").select("user_id").limit(2000);
  const testerSet = new Set((markers ?? []).map((m: any) => m.user_id));
  const vraxLegacyIds = (bridges ?? []).filter((b: any) => !testerSet.has(b.id)).map((b: any) => Number(b.legacy_user_id));
  console.log(`Vraxium 비테스터 legacy id: ${vraxLegacyIds.length}개 (${Math.min(...vraxLegacyIds)}~${Math.max(...vraxLegacyIds)})`);

  const out: Record<string, unknown> = { generatedAt: "2026-06-07 멀티소스 감사 (자체 weekssettings 기준·read-only)" };
  for (const db of SYSTEMS) {
    console.log(`\n════════ [${db}] 감사 시작 ════════`);
    const r = await auditSystem(conn, db, vraxLegacyIds);
    out[db] = r;
    console.log(`  ① 전체 ${r.users}명 ② State ${JSON.stringify(r.stateDist)} ③ 활동자 ${r.active}명`);
    console.log(`  ④ 활동자 최소 주차: ${r.oldestActiveWeek} · 자체 달력 ${r.weekssettingsRows}주 (${r.weekssettingsRange})`);
    console.log(`  ⑤ Week 재현 ${r.weekRepro.exact}/${r.weekRepro.withDecl} = ${r.weekRepro.rate}`);
    console.log(`  ⑥ success ${r.successRepro.pms}→v18 ${r.successRepro.v18} (${r.successRepro.rate}) ⑦ FLIP ${r.successRepro.flips}`);
    console.log(`  ⑧ 귀속실패: 활동 ${r.actAttribution.unattributed}/${r.actAttribution.total}행(인정 ${r.actAttribution.unattrActive})·${r.actAttribution.users}명 / pointlogs ${r.pointlogs.unattributed}/${r.pointlogs.total}`);
    console.log(`  ⑨ adjustment ${JSON.stringify(r.adjustment)}`);
    console.log(`  ⑩ legacy 충돌: UserId ${r.legacyCollision.userIdRange} ∩ Vraxium = ${r.legacyCollision.vraxOverlap}명`);
    console.log(`  ⑪ 실무경험: subtitle ${r.expRestore.subtitle} · rating ${r.expRestore.rating} (대상 ${r.expRestore.weeks}주)`);
  }
  writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`\n→ ${OUT}`);
  await conn.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
