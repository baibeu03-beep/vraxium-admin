/**
 * PMS "현재 활동 중" 사용자 한정 이관 감사 (read-only — write 0, snapshot 0).
 *
 *   npx tsx --env-file=.env.local scripts/audit-pms-active-scope.ts
 *
 * 활동 중 = usersinfo.State NOT IN ('졸업','활동정지') — 일반·운영진.
 * 로직 = audit-pms-full-migration.ts 와 동일(dryrun-1092 미러). 추가 산출:
 *   최초 활동 주차(귀속 활동 min + 미귀속 활동 min 날짜 + 최초 pointlog) → 최소 이관 시즌 범위
 *   범위 한정 지표(Week/success 재현·FLIP·귀속실패·adjustment) + 2023/2024-spring 영향 + 차단 이슈 재평가
 */
import { writeFileSync, readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";

const OUT = "claudedocs/audit-pms-active-20260607.json";
const DEFAULT_THRESHOLD = 30;
const RATING_FAIL_MAX = 3;

const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);

async function main() {
  const conn = await mysql.createConnection({
    host: envGet("MYSQL_HOST"), port: Number(envGet("MYSQL_PORT") ?? 3306),
    user: envGet("MYSQL_USER"), password: envGet("MYSQL_PASSWORD"), database: envGet("MYSQL_DATABASE"),
    dateStrings: true, ssl: { rejectUnauthorized: false },
  });

  const weeks: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("weeks")
      .select("id,season_key,week_number,start_date,end_date,check_threshold,is_official_rest,result_published_at")
      .order("start_date")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    weeks.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const weekById = new Map(weeks.map((w) => [w.id, w]));
  const weekByRange = (d: string) => weeks.find((w) => d >= w.start_date && d <= w.end_date) ?? null;

  // ── 활동 중 사용자 ──
  const [active] = (await conn.query(
    `SELECT u.UserId, u.Name, i.State, i.Week, CAST(i.StartDate AS CHAR) AS StartDate, i.Team, i.Part,
            p.Star AS balStar, p.Shield AS balShield
     FROM users u JOIN usersinfo i ON i.UserID = u.UserId
     LEFT JOIN userspoint p ON p.UserID = u.UserId
     WHERE i.State NOT IN ('졸업','활동정지') ORDER BY u.UserId`,
  )) as any;
  const activeIds = new Set(active.map((u: any) => Number(u.UserId)));
  console.log(`활동 중 사용자: ${active.length}명 (State 분포: ${JSON.stringify(Object.fromEntries(active.reduce((m: Map<string, number>, u: any) => m.set(u.State, (m.get(u.State) ?? 0) + 1), new Map())))})`);

  // 14일 보호 경계
  const protectUntil = new Map<number, string>();
  for (const u of active) {
    if (u.StartDate && !String(u.StartDate).startsWith("0001") && !String(u.StartDate).startsWith("1900")) {
      const t = new Date(`${String(u.StartDate).slice(0, 10)}T00:00:00Z`);
      t.setUTCDate(t.getUTCDate() + 14);
      protectUntil.set(Number(u.UserId), t.toISOString().slice(0, 10));
    }
  }

  // ── pointlogs (활동 사용자만 — IN 절) ──
  const CORR = `CASE WHEN YEAR(ActivityTime) BETWEEN 20 AND 99 THEN DATE(ActivityTime + INTERVAL 2000 YEAR)
                     WHEN YEAR(ActivityTime) = 1 THEN DATE(createtime) ELSE DATE(ActivityTime) END`;
  const idList = [...activeIds].join(",");
  type UA = { points: number; adv: number; pen: number; rows: number };
  const agg = new Map<string, UA>();
  const logUnattrByUser = new Map<number, number>();
  const firstLogByUser = new Map<number, string>();
  let logTotal = 0;
  {
    const [rows] = (await conn.query(
      `SELECT UserID, Star, Shield, IsDeleted, CAST(${CORR} AS CHAR) AS corrected
       FROM pointlogs WHERE UserID IN (${idList})`,
    )) as any;
    for (const r of rows) {
      logTotal++;
      const uid = Number(r.UserID);
      const d = String(r.corrected);
      if (!firstLogByUser.has(uid) || d < firstLogByUser.get(uid)!) firstLogByUser.set(uid, d);
      const w = weekByRange(d);
      if (!w) {
        if ((r.Star ?? 0) !== 0 || (r.Shield ?? 0) !== 0) logUnattrByUser.set(uid, (logUnattrByUser.get(uid) ?? 0) + 1);
        continue;
      }
      const k = `${uid}|${w.id}`;
      let a = agg.get(k);
      if (!a) { a = { points: 0, adv: 0, pen: 0, rows: 0 }; agg.set(k, a); }
      a.rows++;
      let star = Number(r.Star ?? 0);
      const pu = protectUntil.get(uid);
      if (star < 0 && pu && d < pu) star = 0;
      a.points += star;
      const sh = Number(r.Shield ?? 0);
      if (r.IsDeleted === 0) { if (sh > 0) a.adv += sh; else if (sh < 0) a.pen += -sh; }
    }
  }
  console.log(`pointlogs(활동자): ${logTotal}행`);

  // ── 활동 (ua+ma, 활동 사용자만) ──
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
  const attributeAct = (r: any) => {
    const type = normSeason(r.Season);
    if (!type) return null;
    const cands = weeks.filter((w) => w.season_key.endsWith(`-${type}`) && w.week_number === r.SeasonWeek);
    const dates = [r.StartDate, r.EndDate].filter(Boolean).map((d: string) => String(d).slice(0, 10));
    for (const w of cands) {
      const lo = addDays(w.start_date, -60), hi = addDays(w.end_date, 180);
      if (dates.some((d: string) => d >= lo && d <= hi)) return w;
    }
    return null;
  };
  type WP = { uaActive: number; maActive: number; rating: number | null; rows: number };
  const plan = new Map<string, WP>();
  const actUnattrByUser = new Map<number, { rows: number; activeRows: number; minDate: string | null; labels: Map<string, number> }>();
  const firstActWeekByUser = new Map<number, string>(); // 귀속 활동 최소 week start
  for (const table of ["useractivities", "manageractivities"]) {
    const [rows] = (await conn.query(
      `SELECT UserId, Season, SeasonWeek, Star, IsActive,
              CAST(StartDate AS CHAR) AS StartDate, CAST(EndDate AS CHAR) AS EndDate
       FROM ${table} WHERE UserId IN (${idList})`,
    )) as any;
    for (const r of rows) {
      const uid = Number(r.UserId);
      const w = attributeAct(r);
      if (!w) {
        let e = actUnattrByUser.get(uid);
        if (!e) { e = { rows: 0, activeRows: 0, minDate: null, labels: new Map() }; actUnattrByUser.set(uid, e); }
        e.rows++;
        if (r.IsActive === 1) e.activeRows++;
        const d = r.StartDate ? String(r.StartDate).slice(0, 10) : null;
        if (d && (!e.minDate || d < e.minDate)) e.minDate = d;
        const label = `${normSeason(r.Season) ?? `미해석(${String(r.Season ?? "").slice(0, 12)})`}·${String(r.StartDate ?? "?").slice(0, 4)}`;
        e.labels.set(label, (e.labels.get(label) ?? 0) + 1);
        continue;
      }
      if (!firstActWeekByUser.has(uid) || w.start_date < firstActWeekByUser.get(uid)!) firstActWeekByUser.set(uid, w.start_date);
      const k = `${uid}|${w.id}`;
      let p = plan.get(k);
      if (!p) { p = { uaActive: 0, maActive: 0, rating: null, rows: 0 }; plan.set(k, p); }
      p.rows++;
      if (r.IsActive === 1) table === "useractivities" ? p.uaActive++ : p.maActive++;
      if (r.Star != null && (p.rating == null || Number(r.Star) > p.rating)) p.rating = Number(r.Star);
    }
  }

  // ── 사용자별 산출 ──
  const userWeekIds = new Map<number, Set<string>>();
  for (const k of new Set([...agg.keys(), ...plan.keys()])) {
    const [uidS, wid] = k.split("|");
    const uid = Number(uidS);
    let s = userWeekIds.get(uid);
    if (!s) { s = new Set(); userWeekIds.set(uid, s); }
    s.add(wid);
  }

  const perUser: any[] = [];
  const seasonStats = new Map<string, { users: Set<number>; success: number; v18: number; flips: number; unattr: number }>();
  for (const u of active) {
    const uid = Number(u.UserId);
    const wids = userWeekIds.get(uid) ?? new Set<string>();
    let success = 0, v18n = 0, flips = 0, reverse = 0;
    let sumP = 0, sumA = 0, sumPen = 0;
    for (const wid of wids) {
      const w = weekById.get(wid)!;
      const a = agg.get(`${uid}|${wid}`) ?? { points: 0, adv: 0, pen: 0, rows: 0 };
      const p = plan.get(`${uid}|${wid}`) ?? null;
      sumP += a.points; sumA += a.adv; sumPen += a.pen;
      if (!p) continue;
      const thr = w.check_threshold != null && w.check_threshold >= 0 ? w.check_threshold : DEFAULT_THRESHOLD;
      const pmsRec = p.uaActive > 0 || p.maActive > 0;
      const ratingOk = p.rating == null || p.rating > RATING_FAIL_MAX;
      const v18 = ratingOk && a.points >= thr;
      const ss = seasonStats.get(w.season_key) ?? { users: new Set(), success: 0, v18: 0, flips: 0, unattr: 0 };
      seasonStats.set(w.season_key, ss);
      ss.users.add(uid);
      if (pmsRec) { success++; ss.success++; }
      if (v18) { v18n++; ss.v18++; }
      if (pmsRec && !v18) { flips++; ss.flips++; }
      else if (!pmsRec && v18) reverse++;
    }
    const unattr = actUnattrByUser.get(uid) ?? { rows: 0, activeRows: 0, minDate: null, labels: new Map() };
    const firstWeek = firstActWeekByUser.get(uid) ?? null;
    const firstW = firstWeek ? weeks.find((w) => w.start_date === firstWeek) : null;
    perUser.push({
      userId: uid, name: u.Name, state: u.State, team: u.Team,
      weekDecl: u.Week != null && String(u.Week).match(/^\d+$/) ? Number(u.Week) : null,
      startDate: u.StartDate ? String(u.StartDate).slice(0, 10) : null,
      firstActivityWeek: firstW ? `${firstW.season_key} W${firstW.week_number}` : null,
      firstActivityWeekStart: firstWeek,
      firstUnattrActDate: unattr.minDate,
      firstPointlog: firstLogByUser.get(uid) ?? null,
      successPlanned: success, v18Success: v18n, flips, reverse,
      actUnattrRows: unattr.rows, actUnattrActive: unattr.activeRows,
      unattrLabels: Object.fromEntries(unattr.labels),
      logUnattrRows: logUnattrByUser.get(uid) ?? 0,
      starDelta: u.balStar != null ? Number(u.balStar) - sumP : null,
      shieldD: u.balStar != null ? Number(u.balShield) - (sumA - sumPen) : null,
    });
  }

  // ── 최소 이관 범위 ──
  const oldest = perUser
    .filter((p) => p.firstActivityWeekStart)
    .sort((a, b) => a.firstActivityWeekStart.localeCompare(b.firstActivityWeekStart));
  const oldestUser = oldest[0] ?? null;
  // 미귀속 첫 활동이 더 이른 사용자 (범위 누락 방지 — fail-closed)
  // 제로데이트(0001-/1900-)는 pms 미입력 sentinel — 달력 의미 없음, 범위 산정 제외(별도 보고)
  const realDate = (d: string | null) => (d && d >= "2020-01-01" ? d : null);
  const zeroDateUsers = perUser.filter((p) => p.firstUnattrActDate && !realDate(p.firstUnattrActDate));
  const earlierUnattr = perUser.filter(
    (p) => realDate(p.firstUnattrActDate) && (!p.firstActivityWeekStart || realDate(p.firstUnattrActDate)! < p.firstActivityWeekStart),
  );
  const oldestStarts = perUser
    .map((p) => [p.firstActivityWeekStart, realDate(p.firstUnattrActDate)].filter(Boolean).sort()[0])
    .filter(Boolean)
    .sort() as string[];
  const minDate = oldestStarts[0] ?? null;
  const minWeek = minDate ? weekByRange(minDate) : null;
  const seasonOrder = [...new Set(weeks.map((w) => w.season_key))];
  const rangeSeasons = minWeek
    ? seasonOrder.filter((s) => {
        const first = weeks.find((w) => w.season_key === s)!;
        const minSeasonFirst = weeks.find((w) => w.season_key === minWeek.season_key)!;
        return first.start_date >= minSeasonFirst.start_date;
      })
    : [];

  // ── 범위 한정 지표 ──
  const withDecl = perUser.filter((p) => p.weekDecl != null);
  const weekExact = withDecl.filter((p) => p.weekDecl === p.successPlanned).length;
  const totalSuccess = perUser.reduce((s, p) => s + p.successPlanned, 0);
  const totalV18 = perUser.reduce((s, p) => s + p.v18Success, 0);
  const totalFlips = perUser.reduce((s, p) => s + p.flips, 0);
  const flipUsers = perUser.filter((p) => p.flips > 0).length;
  const actUnattrTotal = perUser.reduce((s, p) => s + p.actUnattrRows, 0);
  const actUnattrActive = perUser.reduce((s, p) => s + p.actUnattrActive, 0);
  const actUnattrUsers = perUser.filter((p) => p.actUnattrRows > 0).length;
  const logUnattrTotal = perUser.reduce((s, p) => s + p.logUnattrRows, 0);
  const adjBuckets = { "0": 0, "1~5": 0, "6~20": 0, "21~50": 0, "51~100": 0, "100+": 0 };
  for (const p of perUser) {
    if (p.starDelta === null) continue;
    const m = Math.max(Math.abs(p.starDelta), Math.abs(p.shieldD ?? 0));
    if (m === 0) adjBuckets["0"]++;
    else if (m <= 5) adjBuckets["1~5"]++;
    else if (m <= 20) adjBuckets["6~20"]++;
    else if (m <= 50) adjBuckets["21~50"]++;
    else if (m <= 100) adjBuckets["51~100"]++;
    else adjBuckets["100+"]++;
  }

  // 2023-spring / 2024-spring 영향
  const s23 = seasonStats.get("2023-spring");
  const s24 = seasonStats.get("2024-spring");
  const unattr24Users = perUser.filter((p) => Object.keys(p.unattrLabels).some((l) => l.startsWith("spring·2024")));

  // legacy 충돌 34 ∩ 활동자
  const { data: bridges } = await sb.from("users").select("legacy_user_id").not("legacy_user_id", "is", null).lt("legacy_user_id", 100000000).limit(2000);
  const collisionActive = (bridges ?? []).filter((b: any) => activeIds.has(Number(b.legacy_user_id)));

  const seasonTable = [...seasonStats.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, s]) => ({
    season: k, users: s.users.size, pmsSuccess: s.success, v18: s.v18, flips: s.flips,
    rate: s.success ? `${((1 - s.flips / s.success) * 100).toFixed(1)}%` : "-",
  }));

  const result = {
    generatedAt: "2026-06-07 PMS 활동 중 사용자 한정 감사 (read-only)",
    "1_2_사용자": { count: active.length, list: perUser.map((p) => ({ userId: p.userId, name: p.name, state: p.state, team: p.team, firstActivityWeek: p.firstActivityWeek, startDate: p.startDate })) },
    "3_최초활동주차": perUser.map((p) => ({ userId: p.userId, name: p.name, firstActivityWeek: p.firstActivityWeek, firstUnattrActDate: p.firstUnattrActDate, firstPointlog: p.firstPointlog })),
    "4_가장오래된주차": {
      귀속기준: oldestUser ? { userId: oldestUser.userId, name: oldestUser.name, week: oldestUser.firstActivityWeek, start: oldestUser.firstActivityWeekStart } : null,
      미귀속포함_최소일: minDate,
      제로데이트미귀속사용자: zeroDateUsers.map((p) => ({ userId: p.userId, name: p.name, labels: p.unattrLabels })),
      미귀속이귀속보다이른사용자: earlierUnattr.map((p) => ({ userId: p.userId, name: p.name, unattrDate: p.firstUnattrActDate, attrWeek: p.firstActivityWeek })),
      판정주차: minWeek ? `${minWeek.season_key} W${minWeek.week_number} (${minWeek.start_date})` : null,
    },
    "5_시즌범위": rangeSeasons,
    "추가1_범위지표": {
      Week재현: `${weekExact}/${withDecl.length} = ${((weekExact / Math.max(withDecl.length, 1)) * 100).toFixed(1)}%`,
      success재현: { pms: totalSuccess, v18: totalV18, rate: `${((1 - totalFlips / Math.max(totalSuccess, 1)) * 100).toFixed(2)}%` },
      FLIP: { rows: totalFlips, users: flipUsers },
      귀속실패: { 활동행: actUnattrTotal, 인정행: actUnattrActive, 사용자: actUnattrUsers, pointlogs: logUnattrTotal },
      adjustment분포: adjBuckets,
    },
    "추가2_조기시즌영향": {
      "2023-spring": s23 ? { users: s23.users.size, success: s23.success, flips: s23.flips } : { users: 0, note: "활동자 무관 — 졸업/정지 전용 이슈" },
      "2024-spring": s24 ? { users: s24.users.size, success: s24.success, flips: s24.flips } : { users: 0 },
      "2024-spring_귀속실패보유활동자": unattr24Users.map((p) => ({ userId: p.userId, name: p.name, labels: p.unattrLabels })),
    },
    "추가3_차단이슈재평가": {
      legacy충돌_활동자교집합: collisionActive.length,
    },
    시즌별: seasonTable,
    perUser,
  };
  writeFileSync(OUT, JSON.stringify(result, null, 1));

  console.log("\n══════ 활동 중 사용자 한정 감사 ══════");
  console.log(`①② 활동 중: ${active.length}명`);
  console.log(`④ 가장 오래된 귀속 활동: ${oldestUser?.firstActivityWeek} (${oldestUser?.name}, ${oldestUser?.firstActivityWeekStart}) · 미귀속 포함 최소일 ${minDate} → 판정 ${result["4_가장오래된주차"].판정주차 ?? "주차 외(미귀속)"}`);
  console.log(`   미귀속이 더 이른 사용자: ${earlierUnattr.length}명`);
  console.log(`⑤ 시즌 범위: ${rangeSeasons.join(" → ")}`);
  console.log(`추가1: Week ${result["추가1_범위지표"].Week재현} · success ${totalSuccess}→v18 ${totalV18} (${result["추가1_범위지표"].success재현.rate}) · FLIP ${totalFlips}행/${flipUsers}명 · 귀속실패 활동 ${actUnattrTotal}(인정 ${actUnattrActive})/${actUnattrUsers}명 · pointlogs ${logUnattrTotal}`);
  console.log(`   adjustment: ${JSON.stringify(adjBuckets)}`);
  console.log(`추가2: 2023-spring 활동자 ${s23?.users.size ?? 0}명 · 2024-spring 활동자 ${s24?.users.size ?? 0}명(FLIP ${s24?.flips ?? 0}) · 2024-spring 귀속실패 보유 활동자 ${unattr24Users.length}명`);
  console.log(`추가3: legacy 충돌 34 ∩ 활동자 = ${collisionActive.length}명`);
  console.log("시즌별(활동자):");
  for (const s of seasonTable) console.log(`   ${s.season}: 사용자 ${s.users} · pms ${s.pmsSuccess} · v18 ${s.v18} · FLIP ${s.flips} · 재현 ${s.rate}`);
  console.log(`\n→ ${OUT}`);

  await conn.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
