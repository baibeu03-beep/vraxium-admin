/**
 * PMS 전체 사용자 이관 감사 (read-only — write 0, snapshot 생성/재계산 0).
 *
 *   npx tsx --env-file=.env.local scripts/audit-pms-full-migration.ts
 *
 * 계약: dryrun-pms-1092.ts 와 **동일 로직**을 전수 적용 (실측 — 추정 금지):
 *   매칭(이름+3중 키, strong1→약매칭1→실패) · §5-1 집계(net_all·14일 보호·Shield alive-only)
 *   · 활동 귀속(시즌 정규화+week_number+날짜 게이트 −60/+180) · v18 판정(thr 0 유효·rating>RATING_FAIL_MAX)
 *   · adjustment(잔액 − 주차합) · 실무 경험(subtitle/rating 보유) · weeks=라이브 153행(summer 정본 복원 후).
 * 산출: claudedocs/audit-pms-full-20260607.json (+콘솔 통계)
 */
import { writeFileSync } from "fs";
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";

const OUT = "claudedocs/audit-pms-full-20260607.json";
const DEFAULT_THRESHOLD = 30;
const RATING_FAIL_MAX = 3;
const LEGACY_BOUNDARY = "2026-06-29";

const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);

async function main() {
  const conn = await mysql.createConnection({
    host: envGet("MYSQL_HOST"), port: Number(envGet("MYSQL_PORT") ?? 3306),
    user: envGet("MYSQL_USER"), password: envGet("MYSQL_PASSWORD"), database: envGet("MYSQL_DATABASE"),
    dateStrings: true, ssl: { rejectUnauthorized: false },
  });

  // ════════ 입력 로드 ════════
  // 라이브 weeks (153 — summer pms 정본 복원 후)
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
  console.log(`weeks: ${weeks.length}행 (라이브)`);
  const weekById = new Map(weeks.map((w) => [w.id, w]));
  const weekByRange = (d: string) => weeks.find((w) => d >= w.start_date && d <= w.end_date) ?? null;

  // Vraxium 매칭 입력
  const profiles: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("user_profiles")
      .select("user_id,display_name,birth_date,contact_phone,contact_email,organization_slug")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    profiles.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const profByName = new Map<string, any[]>();
  for (const p of profiles) {
    const arr = profByName.get(p.display_name) ?? [];
    arr.push(p);
    profByName.set(p.display_name, arr);
  }
  const { data: markers } = await sb.from("test_user_markers").select("user_id").limit(2000);
  const testerSet = new Set((markers ?? []).map((m: any) => m.user_id));
  const { data: bridges } = await sb.from("users").select("id,legacy_user_id").not("legacy_user_id", "is", null).limit(5000);
  const bridgeByLegacy = new Map((bridges ?? []).map((b: any) => [Number(b.legacy_user_id), b]));

  // PMS 사용자/정보/잔액
  const [pmsUsers] = (await conn.query(
    `SELECT u.UserId, u.Name, CAST(u.BirthDay AS CHAR) AS BirthDay, u.Contact, u.mail,
            i.Week, i.State, CAST(i.StartDate AS CHAR) AS StartDate,
            p.Star AS balStar, p.Shield AS balShield
     FROM users u
     LEFT JOIN usersinfo i ON i.UserID = u.UserId
     LEFT JOIN userspoint p ON p.UserID = u.UserId
     ORDER BY u.UserId`,
  )) as any;
  console.log(`PMS users: ${pmsUsers.length}명`);
  const pmsNameCount = new Map<string, number>();
  for (const u of pmsUsers) pmsNameCount.set(u.Name, (pmsNameCount.get(u.Name) ?? 0) + 1);

  // pointlogs 전수 (chunk by LogNum) — §5-1 입력
  const CORR = `CASE WHEN YEAR(ActivityTime) BETWEEN 20 AND 99 THEN DATE(ActivityTime + INTERVAL 2000 YEAR)
                     WHEN YEAR(ActivityTime) = 1 THEN DATE(createtime) ELSE DATE(ActivityTime) END`;
  const [[{ maxLog }]] = (await conn.query(`SELECT MAX(LogNum) AS maxLog FROM pointlogs`)) as any;
  type UA = { points: number; adv: number; pen: number; rows: number; protectedZeroed: number };
  const agg = new Map<string, UA>(); // `${uid}|${weekId}`
  const unattributedByUser = new Map<number, number>();
  const unattributedByYear = new Map<string, number>();
  // 14일 보호 경계 (StartDate 보유 사용자만)
  const protectUntil = new Map<number, string>();
  let startDateNull = 0;
  for (const u of pmsUsers) {
    if (u.StartDate && !String(u.StartDate).startsWith("0001") && !String(u.StartDate).startsWith("1900")) {
      const t = new Date(`${String(u.StartDate).slice(0, 10)}T00:00:00Z`);
      t.setUTCDate(t.getUTCDate() + 14);
      protectUntil.set(Number(u.UserId), t.toISOString().slice(0, 10));
    } else startDateNull++;
  }
  let logTotal = 0, logAlive = 0, logVoided = 0, protectedZeroedTotal = 0;
  const CHUNK = 50000;
  for (let lo = 0; lo <= Number(maxLog); lo += CHUNK) {
    const [rows] = (await conn.query(
      `SELECT LogNum, UserID, Star, Shield, IsDeleted, CAST(${CORR} AS CHAR) AS corrected
       FROM pointlogs WHERE LogNum >= ? AND LogNum < ?`,
      [lo, lo + CHUNK],
    )) as any;
    for (const r of rows) {
      logTotal++;
      r.IsDeleted === 0 ? logAlive++ : logVoided++;
      const uid = Number(r.UserID);
      const w = weekByRange(String(r.corrected));
      if (!w) {
        if ((r.Star ?? 0) !== 0 || (r.Shield ?? 0) !== 0) {
          unattributedByUser.set(uid, (unattributedByUser.get(uid) ?? 0) + 1);
          const y = String(r.corrected).slice(0, 4);
          unattributedByYear.set(y, (unattributedByYear.get(y) ?? 0) + 1);
        }
        continue;
      }
      const k = `${uid}|${w.id}`;
      let a = agg.get(k);
      if (!a) { a = { points: 0, adv: 0, pen: 0, rows: 0, protectedZeroed: 0 }; agg.set(k, a); }
      a.rows++;
      let star = Number(r.Star ?? 0);
      const pu = protectUntil.get(uid);
      if (star < 0 && pu && String(r.corrected) < pu) { a.protectedZeroed++; protectedZeroedTotal++; star = 0; }
      a.points += star;
      const shield = Number(r.Shield ?? 0);
      if (r.IsDeleted === 0) {
        if (shield > 0) a.adv += shield;
        else if (shield < 0) a.pen += -shield;
      }
    }
    if (lo % 200000 === 0) console.log(`  pointlogs … ${logTotal}행 처리`);
  }
  console.log(`pointlogs: ${logTotal}행 (alive ${logAlive} / voided ${logVoided}) · 14일 보호 0처리 ${protectedZeroedTotal}행`);

  // 활동 전수 (ua+ma) — Activity 원문 대신 길이만 (전송량 절감, 보유 여부 판정 동일)
  const SEASON_DICT = new Map([["봄", "spring"], ["여름", "summer"], ["가을", "autumn"], ["겨울", "winter"], ["거울", "winter"]]);
  const normSeason = (s: unknown) => {
    let x = String(s ?? "").replace(/[\s\r\n ]+/g, "");
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
  type WP = { uaActive: number; maActive: number; anyFail: number; rating: number | null; hasSubtitle: boolean; rows: number };
  const plan = new Map<string, WP>(); // `${uid}|${weekId}`
  const actUnattrByUser = new Map<number, { rows: number; activeRows: number }>();
  const actUnattrBySeasonLabel = new Map<string, number>();
  let actTotal = 0;
  for (const table of ["useractivities", "manageractivities"]) {
    const [rows] = (await conn.query(
      `SELECT UserId, Season, SeasonWeek, Star, IsActive,
              CHAR_LENGTH(TRIM(COALESCE(Activity,''))) AS actLen,
              CAST(StartDate AS CHAR) AS StartDate, CAST(EndDate AS CHAR) AS EndDate
       FROM ${table}`,
    )) as any;
    for (const r of rows) {
      actTotal++;
      const uid = Number(r.UserId);
      const w = attributeAct(r);
      if (!w) {
        const e = actUnattrByUser.get(uid) ?? { rows: 0, activeRows: 0 };
        e.rows++;
        if (r.IsActive === 1) e.activeRows++;
        actUnattrByUser.set(uid, e);
        const label = `${normSeason(r.Season) ?? `미해석(${String(r.Season ?? "").slice(0, 10)})`}·${String(r.StartDate ?? "?").slice(0, 4)}`;
        actUnattrBySeasonLabel.set(label, (actUnattrBySeasonLabel.get(label) ?? 0) + 1);
        continue;
      }
      const k = `${uid}|${w.id}`;
      let p = plan.get(k);
      if (!p) { p = { uaActive: 0, maActive: 0, anyFail: 0, rating: null, hasSubtitle: false, rows: 0 }; plan.set(k, p); }
      p.rows++;
      if (r.IsActive === 1) table === "useractivities" ? p.uaActive++ : p.maActive++;
      else p.anyFail++;
      if (r.Star != null && (p.rating == null || Number(r.Star) > p.rating)) p.rating = Number(r.Star);
      if (Number(r.actLen) > 0) p.hasSubtitle = true;
    }
  }
  console.log(`activities(ua+ma): ${actTotal}행 · 주차계획 키 ${plan.size}`);

  // ════════ 사용자별 산출 ════════
  type UserAudit = {
    userId: number; name: string; state: string | null; weekDecl: number | null;
    matching: "신규채번" | "강매칭" | "약매칭" | "모호" | "테스터충돌";
    successPlanned: number; v18Success: number; flips: number; reverse: number; agree: number;
    flipRatingFail: number; flipCheckFail: number; flipBoth: number;
    actUnattrRows: number; actUnattrActive: number; logUnattrRows: number;
    uwpRows: number; expWeeks: number; expSubtitle: number; expRating: number;
    starDelta: number | null; shieldD: number | null;
    legacyCollision: boolean;
  };
  const audits: UserAudit[] = [];
  // 사용자→주차 키 인덱스
  const userWeekIds = new Map<number, Set<string>>();
  for (const k of new Set([...agg.keys(), ...plan.keys()])) {
    const [uidS, wid] = k.split("|");
    const uid = Number(uidS);
    let s = userWeekIds.get(uid);
    if (!s) { s = new Set(); userWeekIds.set(uid, s); }
    s.add(wid);
  }

  const seasonStats = new Map<string, { users: Set<number>; success: number; v18: number; flips: number; reverse: number; weeks: number }>();
  const phoneN = (s: unknown) => String(s ?? "").replace(/\D/g, "");

  for (const u of pmsUsers) {
    const uid = Number(u.UserId);
    // 매칭 (dry-run 규칙 미러)
    const bd = String(u.BirthDay ?? "");
    const birthIso = bd.length === 6 ? `${Number(bd.slice(0, 2)) <= 26 ? "20" : "19"}${bd.slice(0, 2)}-${bd.slice(2, 4)}-${bd.slice(4, 6)}` : null;
    const cands = (profByName.get(u.Name) ?? []).map((p: any) => ({
      ...p,
      key: p.birth_date === birthIso || phoneN(p.contact_phone) === phoneN(u.Contact) && phoneN(u.Contact) !== "" ||
        (p.contact_email ?? "").toLowerCase() === String(u.mail ?? "").toLowerCase() && u.mail,
    }));
    const strong = cands.filter((c: any) => c.key);
    const matched = strong.length === 1 ? strong[0] : cands.length === 1 ? cands[0] : null;
    let matching: UserAudit["matching"];
    if (matched && testerSet.has(matched.user_id)) matching = "테스터충돌";
    else if (strong.length === 1) matching = "강매칭";
    else if (matched) matching = "약매칭";
    else if (cands.length > 1 || strong.length > 1) matching = "모호";
    else matching = "신규채번";

    // 주차별 판정
    const wids = userWeekIds.get(uid) ?? new Set<string>();
    let successPlanned = 0, v18Success = 0, flips = 0, reverse = 0, agree = 0;
    let fRating = 0, fCheck = 0, fBoth = 0;
    let sumP = 0, sumA = 0, sumPen = 0;
    let expWeeks = 0, expSub = 0, expRat = 0;
    for (const wid of wids) {
      const w = weekById.get(wid)!;
      const a = agg.get(`${uid}|${wid}`) ?? { points: 0, adv: 0, pen: 0, rows: 0, protectedZeroed: 0 };
      const p = plan.get(`${uid}|${wid}`) ?? null;
      sumP += a.points; sumA += a.adv; sumPen += a.pen;
      const thr = w.check_threshold != null && w.check_threshold >= 0 ? w.check_threshold : DEFAULT_THRESHOLD;
      const ss = seasonStats.get(w.season_key) ?? { users: new Set(), success: 0, v18: 0, flips: 0, reverse: 0, weeks: 0 };
      seasonStats.set(w.season_key, ss);
      if (p) {
        ss.users.add(uid); ss.weeks++;
        const pmsRec = p.uaActive > 0 || p.maActive > 0;
        const ratingOk = p.rating == null || p.rating > RATING_FAIL_MAX;
        const checkPass = a.points >= thr;
        const v18 = ratingOk && checkPass;
        if (pmsRec) { successPlanned++; ss.success++; }
        if (v18) { v18Success++; ss.v18++; }
        if (pmsRec && !v18) {
          flips++; ss.flips++;
          if (!ratingOk && !checkPass) fBoth++;
          else if (!ratingOk) fRating++;
          else fCheck++;
        } else if (!pmsRec && v18) { reverse++; ss.reverse++; }
        else agree++;
        if (w.start_date < LEGACY_BOUNDARY) {
          expWeeks++;
          if (p.hasSubtitle) expSub++;
          if (p.rating != null) expRat++;
        }
      }
    }
    const hasBalance = u.balStar != null;
    const starDelta = hasBalance ? Number(u.balStar) - sumP : null;
    const shieldD = hasBalance ? Number(u.balShield) - (sumA - sumPen) : null;
    const unattr = actUnattrByUser.get(uid) ?? { rows: 0, activeRows: 0 };
    audits.push({
      userId: uid, name: u.Name, state: u.State ?? null,
      weekDecl: u.Week != null && String(u.Week).match(/^\d+$/) ? Number(u.Week) : null,
      matching,
      successPlanned, v18Success, flips, reverse, agree,
      flipRatingFail: fRating, flipCheckFail: fCheck, flipBoth: fBoth,
      actUnattrRows: unattr.rows, actUnattrActive: unattr.activeRows,
      logUnattrRows: unattributedByUser.get(uid) ?? 0,
      uwpRows: wids.size, expWeeks, expSubtitle: expSub, expRating: expRat,
      starDelta, shieldD,
      legacyCollision: bridgeByLegacy.has(uid),
    });
  }

  // ════════ 통계 산출 ════════
  const N = audits.length;
  const by = (f: (a: UserAudit) => boolean) => audits.filter(f).length;
  const matchDist = {
    신규채번: by((a) => a.matching === "신규채번"),
    강매칭: by((a) => a.matching === "강매칭"),
    약매칭: by((a) => a.matching === "약매칭"),
    모호: by((a) => a.matching === "모호"),
    테스터충돌: by((a) => a.matching === "테스터충돌"),
  };
  const withDecl = audits.filter((a) => a.weekDecl != null);
  const weekExact = withDecl.filter((a) => a.weekDecl === a.successPlanned);
  const weekDiffDist = new Map<number, number>();
  for (const a of withDecl) {
    const d = a.successPlanned - (a.weekDecl ?? 0);
    weekDiffDist.set(d, (weekDiffDist.get(d) ?? 0) + 1);
  }
  const totalPmsSuccess = audits.reduce((s, a) => s + a.successPlanned, 0);
  const totalV18 = audits.reduce((s, a) => s + a.v18Success, 0);
  const totalFlips = audits.reduce((s, a) => s + a.flips, 0);
  const totalReverse = audits.reduce((s, a) => s + a.reverse, 0);
  const totalAgree = audits.reduce((s, a) => s + a.agree, 0);
  const flipUsers = by((a) => a.flips > 0);
  const reverseUsers = by((a) => a.reverse > 0);
  const actUnattrTotal = audits.reduce((s, a) => s + a.actUnattrRows, 0);
  const actUnattrActiveTotal = audits.reduce((s, a) => s + a.actUnattrActive, 0);
  const actUnattrUsers = by((a) => a.actUnattrRows > 0);
  const logUnattrTotal = audits.reduce((s, a) => s + a.logUnattrRows, 0);
  const adjZero = by((a) => a.starDelta === 0 && a.shieldD === 0);
  const adjNonZero = by((a) => (a.starDelta ?? 0) !== 0 || (a.shieldD ?? 0) !== 0);
  const adjNoBalance = by((a) => a.starDelta === null);
  const absBuckets = { "0": 0, "1~5": 0, "6~20": 0, "21~50": 0, "51~100": 0, "100+": 0 };
  for (const a of audits) {
    if (a.starDelta === null) continue;
    const m = Math.max(Math.abs(a.starDelta), Math.abs(a.shieldD ?? 0));
    if (m === 0) absBuckets["0"]++;
    else if (m <= 5) absBuckets["1~5"]++;
    else if (m <= 20) absBuckets["6~20"]++;
    else if (m <= 50) absBuckets["21~50"]++;
    else if (m <= 100) absBuckets["51~100"]++;
    else absBuckets["100+"]++;
  }
  const top20 = [...audits]
    .filter((a) => a.starDelta !== null)
    .sort((x, y) => Math.max(Math.abs(y.starDelta!), Math.abs(y.shieldD!)) - Math.max(Math.abs(x.starDelta!), Math.abs(x.shieldD!)))
    .slice(0, 20)
    .map((a) => ({ userId: a.userId, name: a.name, state: a.state, starDelta: a.starDelta, shieldD: a.shieldD, logUnattr: a.logUnattrRows, actUnattr: a.actUnattrRows }));
  const totalUwpRows = audits.reduce((s, a) => s + a.uwpRows, 0);
  const sentinelUsers = adjNonZero;
  const expWeeksTotal = audits.reduce((s, a) => s + a.expWeeks, 0);
  const expSubTotal = audits.reduce((s, a) => s + a.expSubtitle, 0);
  const expRatTotal = audits.reduce((s, a) => s + a.expRating, 0);
  const collisions = audits.filter((a) => a.legacyCollision).map((a) => ({ userId: a.userId, name: a.name, state: a.state }));

  const seasonTable = [...seasonStats.entries()]
    .sort((x, y) => x[0].localeCompare(y[0]))
    .map(([k, s]) => ({
      season: k, users: s.users.size, activityWeeks: s.weeks, pmsSuccess: s.success, v18Success: s.v18,
      flips: s.flips, reverse: s.reverse,
      v18Rate: s.success ? `${((1 - s.flips / s.success) * 100).toFixed(1)}%` : "-",
    }));

  const result = {
    generatedAt: "2026-06-07 PMS 전체 사용자 이관 감사 (read-only)",
    weeksLive: weeks.length,
    "1_사용자수": {
      pmsTotal: N,
      매칭분포: matchDist,
      이관가능: matchDist.신규채번 + matchDist.강매칭,
      재검토필요: matchDist.약매칭 + matchDist.모호 + matchDist.테스터충돌,
      usersinfo부재: by((a) => a.state === null),
      userspoint부재: adjNoBalance,
    },
    "2_Week재현율": {
      Week선언보유: withDecl.length,
      완전일치: weekExact.length,
      일치율: `${((weekExact.length / Math.max(withDecl.length, 1)) * 100).toFixed(1)}%`,
      diff분포_planned_minus_decl: Object.fromEntries([...weekDiffDist.entries()].sort((a, b) => a[0] - b[0])),
      불일치사용자: withDecl.filter((a) => a.weekDecl !== a.successPlanned).slice(0, 30).map((a) => ({ userId: a.userId, name: a.name, decl: a.weekDecl, planned: a.successPlanned, actUnattrActive: a.actUnattrActive })),
    },
    "3_success재현율": {
      pms인정주차합: totalPmsSuccess,
      v18표시success합: totalV18,
      agree: totalAgree, flips: totalFlips, reverse: totalReverse,
      표시재현율: `${((1 - totalFlips / Math.max(totalPmsSuccess, 1)) * 100).toFixed(2)}%`,
      귀속실패로누락된인정활동행: actUnattrActiveTotal,
    },
    "4_FLIP": {
      flips: totalFlips, flipUsers, reverse: totalReverse, reverseUsers,
      원인: {
        checkFail만: audits.reduce((s, a) => s + a.flipCheckFail, 0),
        ratingFail만: audits.reduce((s, a) => s + a.flipRatingFail, 0),
        둘다: audits.reduce((s, a) => s + a.flipBoth, 0),
      },
    },
    "5_활동귀속실패": {
      행수: actUnattrTotal, 인정행: actUnattrActiveTotal, 사용자수: actUnattrUsers,
      시즌별: Object.fromEntries([...actUnattrBySeasonLabel.entries()].sort((a, b) => b[1] - a[1])),
      pointlogs미귀속행: logUnattrTotal,
      pointlogs미귀속연도별: Object.fromEntries([...unattributedByYear.entries()].sort()),
    },
    "6_adjustment": {
      zero사용자: adjZero, 발생사용자: adjNonZero, 잔액부재: adjNoBalance,
      절대값분포: absBuckets, top20,
    },
    "7_checksMigrated": {
      true예정_uwp행: totalUwpRows - totalFlips,
      false예정: { flip행_PMS인정우선: totalFlips, sentinel행: sentinelUsers },
      사유: "false = ① FLIP 행(PMS 인정 우선 — 게이트 비적용 보존) ② sentinel(1900-W0 — 주차 도메인 비오염)",
    },
    "8_실무경험": {
      대상주차: expWeeksTotal,
      subtitle보유: expSubTotal, subtitle복원율: `${((expSubTotal / Math.max(expWeeksTotal, 1)) * 100).toFixed(1)}%`,
      rating보유: expRatTotal, rating복원율: `${((expRatTotal / Math.max(expWeeksTotal, 1)) * 100).toFixed(1)}%`,
      누락: { subtitle: expWeeksTotal - expSubTotal, rating: expWeeksTotal - expRatTotal },
    },
    "9_legacy충돌": {
      충돌수: collisions.length, 대상: collisions,
      유형: "기존 Vraxium 구 sequence 합성값(248~309)과 수치 충돌 — 06-07 0/28 동일인 아님 실증(false-bridge)",
      영향: "이관 시 legacy_user_id 브리지 신뢰 금지(3중 키 매칭) + 34명 선처리(재채번/제외) 필요",
    },
    "10_시즌별": seasonTable,
  };

  writeFileSync(OUT, JSON.stringify(result, null, 1));

  // ── 콘솔 요약 ──
  console.log("\n══════ PMS 전체 이관 감사 (read-only) ══════");
  console.log(`① 사용자: 전체 ${N} · 이관가능 ${result["1_사용자수"].이관가능} (신규 ${matchDist.신규채번}/강매칭 ${matchDist.강매칭}) · 재검토 ${result["1_사용자수"].재검토필요} (약 ${matchDist.약매칭}/모호 ${matchDist.모호}/테스터 ${matchDist.테스터충돌})`);
  console.log(`② Week 재현: ${weekExact.length}/${withDecl.length} = ${result["2_Week재현율"].일치율}`);
  console.log(`③ success: pms ${totalPmsSuccess} vs v18 ${totalV18} · 표시재현율 ${result["3_success재현율"].표시재현율}`);
  console.log(`④ FLIP ${totalFlips}행/${flipUsers}명 (check ${result["4_FLIP"].원인.checkFail만}/rating ${result["4_FLIP"].원인.ratingFail만}/둘다 ${result["4_FLIP"].원인.둘다}) · 역방향 ${totalReverse}행/${reverseUsers}명`);
  console.log(`⑤ 활동 귀속실패 ${actUnattrTotal}행(인정 ${actUnattrActiveTotal})/${actUnattrUsers}명 · pointlogs 미귀속 ${logUnattrTotal}행`);
  console.log(`⑥ adjustment: 0인 사용자 ${adjZero} · 발생 ${adjNonZero} · 분포 ${JSON.stringify(absBuckets)}`);
  console.log(`⑦ checks_migrated: true ${result["7_checksMigrated"].true예정_uwp행} · false flip ${totalFlips}+sentinel ${sentinelUsers}`);
  console.log(`⑧ 실무경험: subtitle ${result["8_실무경험"].subtitle복원율} · rating ${result["8_실무경험"].rating복원율} (대상 ${expWeeksTotal}주)`);
  console.log(`⑨ legacy 충돌: ${collisions.length}명`);
  console.log("⑩ 시즌별:");
  for (const s of seasonTable) console.log(`   ${s.season}: 사용자 ${s.users} · 활동주 ${s.activityWeeks} · pms성공 ${s.pmsSuccess} · v18 ${s.v18Success} · FLIP ${s.flips} · 역방향 ${s.reverse} · 재현 ${s.v18Rate}`);
  console.log(`\n→ ${OUT}`);

  await conn.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
