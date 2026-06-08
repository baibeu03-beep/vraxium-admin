/**
 * 3조직 활동자 전체 dry-run — B안 composite key (read-only, write 0 보장).
 *
 *   npx tsx --env-file=.env.local scripts/dryrun-pms-active-286.ts
 *
 * 대상: 각 소스 usersinfo.State IN ('일반','운영진').
 *   ⚠ 정책 1 (2026-06-07): **ORANKE 916 이유나 · 873 선우은교** ORANKE 소스 제외
 *     (cross-source 동일인 — HRDB/OLYMPUS 측 단일 기준).
 *   ⚠ 정책 2 (2026-06-07 확정): **운영진은 본인 주차 활동행(useractivities 또는
 *     manageractivities) 보유자만** 활성 계정 이관 대상에 포함. 활동행 0 운영진은 제외 —
 *     단, 그들의 pointlogs/운영 처리 로그는 legacy 원장 보존 대상으로만 유지(삭제 없음,
 *     본 dry-run 의 사용자 생성 경로 밖). 일반(State='일반')은 활동행 조건 없음.
 *   → 활동행 0 운영진 8명 제외 예상 (oranke 4 · hrdb 1=이유나 · olympus 3=선우은교 포함) = 276.
 * 계약 (dryrun-pms-1092.ts §12 per-user 파이프라인의 bulk 미러):
 *   - 식별 = (source_system, legacy_user_id=PMS 원본 UserId) — legacyIdentityFor 가드.
 *   - 동일인 매칭 = 이름+생년월일+연락처(+email) 3중 키만. 숫자 단독 판단 금지.
 *   - threshold = org_week_thresholds(소스 org) → weeks.check_threshold → 30 (라이브 해석).
 *   - 판정 = §5-1 net_all(14일 보호)·Shield alive / uws = useractivities IsActive OR ma.
 *   - 정책: PMS 인정 우선 — FLIP(pms 인정→v18 fail) 주차는 checks_migrated=false 예정.
 *
 * 산출: claudedocs/dryrun-pms-active-286-20260607.{json,md}
 */
import { readFileSync, writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";
import { legacyIdentityFor, resolveOrganizationSlug, type PmsSourceSystem } from "@/lib/pmsMigration";
import { isExcludedPmsSeason, normalizePmsSeasonType } from "@/lib/pmsSeasonAttribution";

const OUT_JSON = "claudedocs/dryrun-pms-active-286-20260607.json";
const OUT_MD = "claudedocs/dryrun-pms-active-286-20260607.md";
const SOURCES: PmsSourceSystem[] = ["oranke", "hrdb", "olympus"];
const DEFAULT_THRESHOLD = 30;
const RATING_FAIL_MAX = 3;

const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);

const normName = (s: unknown) => String(s ?? "").replace(/\s+/g, "").trim();
const normPhone = (s: unknown) => {
  const d = String(s ?? "").replace(/\D/g, "");
  return d.length >= 8 ? d.slice(-8) : d;
};
const normBirth = (s: unknown) => {
  const d = String(s ?? "").replace(/\D/g, "");
  if (d.length === 8) return d;
  if (d.length === 6) return (Number(d.slice(0, 2)) <= 26 ? "20" : "19") + d;
  return d;
};
const normEmail = (s: unknown) => String(s ?? "").trim().toLowerCase();
const addDays = (iso: string, d: number) => {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
};
const SEASON_DICT = new Map([["봄", "spring"], ["여름", "summer"], ["가을", "autumn"], ["겨울", "winter"], ["거울", "winter"]]);
const normSeason = (s: unknown) => {
  let x = String(s ?? "").replace(/[\s\r\n ]+/g, "");
  if (x.endsWith("시즌")) x = x.slice(0, -2);
  return SEASON_DICT.get(x) ?? null;
};

type LiveWeek = { id: string; season_key: string; week_number: number; start_date: string; end_date: string; check_threshold: number | null };
type VraxProfile = { user_id: string; display_name: string | null; birth_date: string | null; contact_phone: string | null; contact_email: string | null; organization_slug: string | null };

async function fetchAllSb<T>(table: string, select: string, orderCol: string, filt?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q: any = sb.from(table).select(select).order(orderCol, { ascending: true }).range(from, from + 999);
    if (filt) q = filt(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function main() {
  const t0 = Date.now();
  // ── Vraxium 공통 데이터 ──
  const weeks = await fetchAllSb<LiveWeek>("weeks", "id,season_key,week_number,start_date,end_date,check_threshold", "start_date");
  const weekByDate = (d: string) => weeks.find((w) => d >= w.start_date && d <= w.end_date) ?? null;
  const profiles = await fetchAllSb<VraxProfile>(
    "user_profiles",
    "user_id,display_name,birth_date,contact_phone,contact_email,organization_slug",
    "user_id",
  );
  const profByName = new Map<string, VraxProfile[]>();
  for (const p of profiles) {
    const k = normName(p.display_name);
    if (!k) continue;
    const a = profByName.get(k) ?? [];
    a.push(p);
    profByName.set(k, a);
  }
  const usersRows = await fetchAllSb<{ id: string; legacy_user_id: number | null; source_system: string | null }>(
    "users",
    "id,legacy_user_id,source_system",
    "id",
  );
  const usersById = new Map(usersRows.map((u) => [u.id, u]));
  const pairOccupied = new Set(
    usersRows.filter((u) => u.source_system != null && u.legacy_user_id != null).map((u) => `${u.source_system}|${u.legacy_user_id}`),
  );
  const markers = new Set(
    (await fetchAllSb<{ user_id: string }>("test_user_markers", "user_id", "user_id")).map((m) => m.user_id),
  );
  const uwsCounts = new Map<string, number>();
  for (const r of await fetchAllSb<{ user_id: string }>("user_week_statuses", "user_id", "user_id")) {
    uwsCounts.set(r.user_id, (uwsCounts.get(r.user_id) ?? 0) + 1);
  }
  const snapshotUsers = new Set(
    (await fetchAllSb<{ user_id: string }>("cluster4_weekly_card_snapshots", "user_id", "user_id")).map((s) => s.user_id),
  );

  const conn = await mysql.createConnection({
    host: envGet("MYSQL_HOST"),
    port: Number(envGet("MYSQL_PORT") ?? 3306),
    user: envGet("MYSQL_USER"),
    password: envGet("MYSQL_PASSWORD"),
    dateStrings: true,
    ssl: { rejectUnauthorized: false },
  });

  const perSource: Record<string, any> = {};
  const holdQueue: Array<Record<string, unknown>> = [];
  const targetsBySource: Record<string, any[]> = {}; // cross-source 동일인 교차용

  for (const src of SOURCES) {
    const org = resolveOrganizationSlug(src);
    // org threshold 맵
    const orgThr = new Map<string, number>();
    for (const r of await fetchAllSb<{ week_id: string; check_threshold: number }>(
      "org_week_thresholds",
      "week_id,check_threshold",
      "week_id",
      (q) => q.eq("organization_slug", org),
    )) orgThr.set(r.week_id, r.check_threshold);
    const thrOf = (w: LiveWeek) => orgThr.get(w.id) ?? (w.check_threshold != null && w.check_threshold >= 0 ? w.check_threshold : DEFAULT_THRESHOLD);

    // ── 대상자 ── (정책 1: ORANKE 916/873 제외 · 정책 2: 운영진=활동행 보유자만)
    const ORANKE_EXCLUDED_USER_IDS = [916, 873];
    const exclusion =
      src === "oranke" ? ` AND u.UserId NOT IN (${ORANKE_EXCLUDED_USER_IDS.join(",")})` : "";
    const [targets] = (await conn.query(`
      SELECT u.UserId, u.Name, CAST(u.BirthDay AS CHAR) AS BirthDay, u.Contact, u.mail,
             i.State, i.Week, CAST(i.StartDate AS CHAR) AS StartDate
      FROM ${src}.users u JOIN ${src}.usersinfo i ON i.UserID = u.UserId
      WHERE i.State IN ('일반','운영진')${exclusion}
        AND (i.State = '일반'
             OR EXISTS (SELECT 1 FROM ${src}.useractivities a WHERE a.UserId = u.UserId)
             OR EXISTS (SELECT 1 FROM ${src}.manageractivities m WHERE m.UserId = u.UserId))
      ORDER BY u.UserId`)) as [any[], unknown];
    // 제외된 운영진(활동행 0) — 리포트용 (legacy 원장 보존 대상)
    const [excludedOps] = (await conn.query(`
      SELECT u.UserId, u.Name FROM ${src}.users u JOIN ${src}.usersinfo i ON i.UserID = u.UserId
      WHERE i.State = '운영진'${exclusion}
        AND NOT EXISTS (SELECT 1 FROM ${src}.useractivities a WHERE a.UserId = u.UserId)
        AND NOT EXISTS (SELECT 1 FROM ${src}.manageractivities m WHERE m.UserId = u.UserId)
      ORDER BY u.UserId`)) as [any[], unknown];
    targetsBySource[src] = targets;

    // ── 매칭 분류 ──
    //   (2026-06-07) 기이관 사용자 = (source_system, legacy_user_id) 페어 보유 → 멱등 skip
    //   (재이관 plan 산출 제외 — pilot 5명 등). 페어는 이관만 기록하므로 자기 행 보증.
    let newUsers = 0, matchedUsers = 0, ambiguous = 0, testerBlocked = 0, crossSourceBlocked = 0, migratedSkip = 0;
    const matchedPlans: Array<Record<string, unknown>> = [];
    const matchedUserIds = new Map<number, string>(); // pmsId → uuid
    for (const t of targets) {
      legacyIdentityFor(src, Number(t.UserId)); // 가드 (fail-closed)
      if (pairOccupied.has(`${src}|${t.UserId}`)) { migratedSkip++; continue; }
      const vn = normName(t.Name), vb = normBirth(t.BirthDay), vp = normPhone(t.Contact), ve = normEmail(t.mail);
      const cands = profByName.get(vn) ?? [];
      const strong = cands.filter(
        (c) =>
          (vb && normBirth(c.birth_date) === vb) ||
          (vp && normPhone(c.contact_phone) === vp) ||
          (ve && normEmail(c.contact_email) === ve),
      );
      const m = strong.length === 1 ? strong[0] : cands.length === 1 && strong.length === 0 ? null : null;
      const matched = strong.length === 1 ? strong[0] : null;
      void m;
      if (strong.length > 1) {
        ambiguous++;
        holdQueue.push({ source: src, pmsId: t.UserId, name: t.Name, issue: `강한 일치 후보 ${strong.length}명 — 수동 확정 필요` });
        continue;
      }
      if (!matched) { newUsers++; continue; }
      if (markers.has(matched.user_id)) {
        testerBlocked++;
        holdQueue.push({ source: src, pmsId: t.UserId, name: t.Name, issue: "테스터 계정과 3중 키 일치 — 차단" });
        continue;
      }
      const uRow = usersById.get(matched.user_id);
      if (uRow?.source_system && uRow.source_system !== src) {
        crossSourceBlocked++;
        holdQueue.push({ source: src, pmsId: t.UserId, name: t.Name, issue: `이미 source_system='${uRow.source_system}' 이관 기록 — 2중 이관 차단` });
        continue;
      }
      matchedUsers++;
      matchedUserIds.set(Number(t.UserId), matched.user_id);
      matchedPlans.push({
        pmsId: t.UserId, name: t.Name, uuid: matched.user_id,
        existingLegacy: uRow?.legacy_user_id ?? null, existingSource: uRow?.source_system ?? null,
        existingUws: uwsCounts.get(matched.user_id) ?? 0,
        plan:
          uRow?.source_system == null
            ? `source_system='${src}' 최초 기록${uRow?.legacy_user_id === Number(t.UserId) ? " (legacy 숫자 동일 유지)" : ` + legacy_user_id ${uRow?.legacy_user_id}→${t.UserId} 재기록`}`
            : "페어 재검증 (멱등 재실행)",
      });
    }

    // ── pointlogs bulk 집계 (§5-1) ──
    const targetIds = new Set(targets.map((t: any) => Number(t.UserId)));
    const protectUntil = new Map<number, string>();
    for (const t of targets) {
      const sd = String(t.StartDate ?? "").slice(0, 10);
      if (sd >= "2020-01-01") protectUntil.set(Number(t.UserId), addDays(sd, 14));
    }
    type Agg = { points: number; adv: number; pen: number };
    const agg = new Map<string, Agg>(); // `${uid}|${weekId}`
    let logTotal = 0, logUnattr = 0;
    const CORR = `CASE WHEN YEAR(ActivityTime) BETWEEN 20 AND 99 THEN DATE(ActivityTime + INTERVAL 2000 YEAR)
                       WHEN YEAR(ActivityTime) = 1 THEN DATE(createtime) ELSE DATE(ActivityTime) END`;
    const [[{ maxLog }]] = (await conn.query(`SELECT MAX(LogNum) AS maxLog FROM ${src}.pointlogs`)) as any;
    for (let lo = 0; lo <= Number(maxLog); lo += 60000) {
      const [rows] = (await conn.query(`
        SELECT UserID, Star, Shield, IsDeleted, CAST(${CORR} AS CHAR) AS corrected
        FROM ${src}.pointlogs WHERE LogNum >= ${lo} AND LogNum < ${lo + 60000}`)) as [any[], unknown];
      for (const r of rows) {
        const uid = Number(r.UserID);
        if (!targetIds.has(uid)) continue;
        logTotal++;
        const w = weekByDate(String(r.corrected));
        if (!w) {
          if ((r.Star ?? 0) !== 0 || (r.Shield ?? 0) !== 0) logUnattr++;
          continue;
        }
        const k = `${uid}|${w.id}`;
        let a = agg.get(k);
        if (!a) { a = { points: 0, adv: 0, pen: 0 }; agg.set(k, a); }
        let star = Number(r.Star ?? 0);
        const pu = protectUntil.get(uid);
        if (star < 0 && pu && String(r.corrected) < pu) star = 0;
        a.points += star;
        const sh = Number(r.Shield ?? 0);
        if (r.IsDeleted === 0) { if (sh > 0) a.adv += sh; else if (sh < 0) a.pen += -sh; }
      }
    }

    // ── activities → uws/경험 계획 ──
    //   (2026-06-07 강화) 시즌 귀속: 제외(테스트/전환) → skip / 정규화 성공 → 시즌+주차+날짜창 /
    //   정규화 실패·창 불일치 → StartDate 날짜 기반 보조 귀속 (lib/pmsSeasonAttribution).
    type WP = { recognized: boolean; rating: number | null; hasSubtitle: boolean };
    const plan = new Map<string, WP>(); // `${uid}|${weekId}`
    let actTotal = 0, actUnattr = 0, actExcluded = 0, actDateFallback = 0;
    for (const table of ["useractivities", "manageractivities"]) {
      const [rows] = (await conn.query(`
        SELECT UserId, Season, SeasonWeek, Star, IsActive, Activity,
               CAST(StartDate AS CHAR) AS StartDate, CAST(EndDate AS CHAR) AS EndDate
        FROM ${src}.${table}`)) as [any[], unknown];
      for (const r of rows) {
        const uid = Number(r.UserId);
        if (!targetIds.has(uid)) continue;
        actTotal++;
        if (isExcludedPmsSeason(r.Season)) { actExcluded++; continue; }
        const type = normalizePmsSeasonType(r.Season);
        const cands = type ? weeks.filter((w) => w.season_key.endsWith(`-${type}`) && w.week_number === r.SeasonWeek) : [];
        const dates = [r.StartDate, r.EndDate].filter(Boolean).map((d: string) => String(d).slice(0, 10));
        let w: LiveWeek | null = null;
        for (const c of cands) {
          const lo = addDays(c.start_date, -60), hi = addDays(c.end_date, 180);
          if (dates.some((d: string) => d >= lo && d <= hi)) { w = c; break; }
        }
        if (!w && dates.length) {
          // 날짜 기반 보조 귀속 — StartDate(우선)/EndDate 가 속한 라이브 주차 (날짜=SoT).
          w = weekByDate(dates[0]) ?? (dates[1] ? weekByDate(dates[1]) : null);
          if (w) actDateFallback++;
        }
        if (!w) { actUnattr++; continue; }
        const k = `${uid}|${w.id}`;
        let p = plan.get(k);
        if (!p) { p = { recognized: false, rating: null, hasSubtitle: false }; plan.set(k, p); }
        if (r.IsActive === 1) p.recognized = true;
        if (r.Star != null && (p.rating == null || Number(r.Star) > p.rating)) p.rating = Number(r.Star);
        if (String(r.Activity ?? "").trim()) p.hasSubtitle = true;
      }
    }

    // ── 판정 + 재현율 + FLIP ──
    const weekById = new Map(weeks.map((w) => [w.id, w]));
    let uwsRows = 0, pmsSuccess = 0, v18Success = 0, flips = 0, withSubtitle = 0, withRating = 0;
    const recognizedByUser = new Map<number, number>();
    for (const [k, p] of plan) {
      const [uidS, wid] = k.split("|");
      const w = weekById.get(wid)!;
      const a = agg.get(k) ?? { points: 0, adv: 0, pen: 0 };
      uwsRows++;
      if (p.hasSubtitle) withSubtitle++;
      if (p.rating != null) withRating++;
      if (!p.recognized) continue;
      pmsSuccess++;
      recognizedByUser.set(Number(uidS), (recognizedByUser.get(Number(uidS)) ?? 0) + 1);
      const ratingOk = p.rating == null || p.rating > RATING_FAIL_MAX;
      const v18 = ratingOk && a.points >= thrOf(w);
      if (v18) v18Success++;
      else flips++; // PMS 인정 우선 — checks_migrated=false 예정
    }
    let weekReproduced = 0;
    for (const t of targets) {
      if ((recognizedByUser.get(Number(t.UserId)) ?? 0) === Number(t.Week ?? -1)) weekReproduced++;
    }

    // ── adjustment 분포 ──
    const [balances] = (await conn.query(
      `SELECT UserID, Star, Shield FROM ${src}.userspoint WHERE UserID IN (${[...targetIds].join(",")})`,
    )) as [any[], unknown];
    const sumByUser = new Map<number, number>();
    for (const [k, a] of agg) sumByUser.set(Number(k.split("|")[0]), (sumByUser.get(Number(k.split("|")[0])) ?? 0) + a.points);
    const adjBuckets: Record<string, number> = { "0": 0, "1~5": 0, "6~20": 0, "21~50": 0, "51~100": 0, "100+": 0 };
    for (const b of balances) {
      const d = Math.abs(Number(b.Star) - (sumByUser.get(Number(b.UserID)) ?? 0));
      adjBuckets[d === 0 ? "0" : d <= 5 ? "1~5" : d <= 20 ? "6~20" : d <= 50 ? "21~50" : d <= 100 ? "51~100" : "100+"]++;
    }

    // ── snapshot 계획 ──
    const matchedWithSnapshot = [...matchedUserIds.values()].filter((u) => snapshotUsers.has(u)).length;

    perSource[src] = {
      org,
      targets: targets.length,
      excludedOperatorsNoActivity: excludedOps.map((o: any) => `${o.UserId}:${o.Name}`),
      stateDist: targets.reduce((m: Record<string, number>, t: any) => ((m[t.State] = (m[t.State] ?? 0) + 1), m), {}),
      matching: { newUsers, matchedUsers, ambiguous, testerBlocked, crossSourceBlocked, migratedSkip },
      pairConflicts: 0, // 기이관 페어는 migratedSkip 으로 분류 (충돌 아님 — 멱등)
      uwpRowsPlanned: agg.size,
      uwsRowsPlanned: uwsRows,
      weekReproduced: `${weekReproduced}/${targets.length}`,
      pmsRecognizedWeeks: pmsSuccess,
      v18SuccessAmongRecognized: v18Success,
      successReproductionRate: pmsSuccess ? `${((v18Success / pmsSuccess) * 100).toFixed(2)}%` : "-",
      flips_checksMigratedFalse: flips,
      thresholdSource: { orgRows: orgThr.size },
      unattributed: { pointlogRows: logUnattr, activityRows: actUnattr, attributedLogRows: logTotal, activityExcluded: actExcluded, activityDateFallback: actDateFallback },
      experienceRestore: {
        subtitleRate: uwsRows ? `${((withSubtitle / uwsRows) * 100).toFixed(1)}%` : "-",
        ratingRate: uwsRows ? `${((withRating / uwsRows) * 100).toFixed(1)}%` : "-",
      },
      adjustmentDistribution: adjBuckets,
      snapshotPlan: {
        newSnapshots: targets.length - matchedUserIds.size,
        recomputeExisting: matchedWithSnapshot,
        matchedWithoutSnapshot: matchedUserIds.size - matchedWithSnapshot,
      },
      matchedPlans,
    };
    console.log(
      `[${src}] 대상 ${targets.length} | 기이관skip ${migratedSkip} 신규 ${newUsers} 매칭 ${matchedUsers} 모호 ${ambiguous} 테스터차단 ${testerBlocked}` +
        ` | uws ${uwsRows} 인정 ${pmsSuccess} v18 ${v18Success} FLIP ${flips} | 미귀속 log ${logUnattr}/act ${actUnattr} (제외 ${actExcluded}·날짜귀속 ${actDateFallback})`,
    );
  }
  await conn.end();

  // ── cross-source 동일인 교차 (이름+전화 — 생일 필드 쓰레기값 보완, 286 dry-run 교훈) ──
  //   제외 정책 적용 후 잔존 동일인 = apply 차단. 기대 0 (916/873 제외로 해소).
  const crossSourceSamePerson: Array<Record<string, unknown>> = [];
  {
    const pairs: Array<[PmsSourceSystem, PmsSourceSystem]> = [
      ["oranke", "hrdb"],
      ["oranke", "olympus"],
      ["hrdb", "olympus"],
    ];
    for (const [a, b] of pairs) {
      const idx = new Map<string, any>();
      for (const r of targetsBySource[a] ?? []) {
        const p = normPhone(r.Contact);
        if (p) idx.set(`${normName(r.Name)}|${p}`, r);
      }
      for (const r of targetsBySource[b] ?? []) {
        const p = normPhone(r.Contact);
        const m = p ? idx.get(`${normName(r.Name)}|${p}`) : null;
        if (m) {
          crossSourceSamePerson.push({
            person: r.Name,
            a: `${a} ${m.UserId}`,
            b: `${b} ${r.UserId}`,
            keys: "이름+전화",
          });
          holdQueue.push({
            source: `${a}+${b}`,
            pmsId: `${m.UserId}/${r.UserId}`,
            name: r.Name,
            issue: "cross-source 동일인 잔존 — primary source 결정 필요",
          });
        }
      }
    }
  }

  const totals = {
    targets: SOURCES.reduce((s, x) => s + perSource[x].targets, 0),
    newUsers: SOURCES.reduce((s, x) => s + perSource[x].matching.newUsers, 0),
    matched: SOURCES.reduce((s, x) => s + perSource[x].matching.matchedUsers, 0),
    ambiguous: SOURCES.reduce((s, x) => s + perSource[x].matching.ambiguous, 0),
    testerBlocked: SOURCES.reduce((s, x) => s + perSource[x].matching.testerBlocked, 0),
    crossSourceBlocked: SOURCES.reduce((s, x) => s + perSource[x].matching.crossSourceBlocked, 0),
    migratedSkip: SOURCES.reduce((s, x) => s + perSource[x].matching.migratedSkip, 0),
    pairConflicts: 0,
    flips: SOURCES.reduce((s, x) => s + perSource[x].flips_checksMigratedFalse, 0),
    crossSourceSamePerson: crossSourceSamePerson.length,
    holdQueue: holdQueue.length,
  };
  const report = {
    generatedAt: "2026-06-07 3조직 활동자 전체 dry-run (B안 composite key — read-only · 916/873 제외 정책 반영)",
    policy:
      "PMS 인정 우선 (FLIP=checks_migrated:false) · (source_system,legacy_user_id) 복합키 · 3중 키 매칭 · org_week_thresholds 해석 · ORANKE 916 이유나/873 선우은교 제외(HRDB/OLYMPUS 단일 기준)",
    totals,
    perSource,
    crossSourceSamePerson,
    holdQueue,
    durationMs: Date.now() - t0,
  };
  writeFileSync(OUT_JSON, JSON.stringify(report, null, 1));

  const md = [
    "# 3조직 활동자 전체 dry-run (2026-06-07 · B안 composite key · read-only)",
    "",
    `정책: ${report.policy}`,
    "",
    "| source | org | 대상 | 신규 | 매칭 | 모호 | 테스터차단 | 페어충돌 | uws계획 | PMS인정 | v18성공 | FLIP | 미귀속(log/act) | subtitle | rating |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...SOURCES.map((s) => {
      const p = perSource[s];
      return `| ${s} | ${p.org} | ${p.targets} | ${p.matching.newUsers} | ${p.matching.matchedUsers} | ${p.matching.ambiguous} | ${p.matching.testerBlocked} | ${p.pairConflicts} | ${p.uwsRowsPlanned} | ${p.pmsRecognizedWeeks} | ${p.v18SuccessAmongRecognized} | ${p.flips_checksMigratedFalse} | ${p.unattributed.pointlogRows}/${p.unattributed.activityRows} | ${p.experienceRestore.subtitleRate} | ${p.experienceRestore.ratingRate} |`;
    }),
    "",
    `합계: 대상 ${totals.targets} · 신규 ${totals.newUsers} · 매칭 ${totals.matched} · 모호 ${totals.ambiguous} · FLIP ${totals.flips} · hold queue ${totals.holdQueue}`,
    "",
    "## hold queue",
    ...(holdQueue.length ? holdQueue.map((h) => `- [${h.source}] ${h.pmsId} ${h.name}: ${h.issue}`) : ["- 없음"]),
  ];
  writeFileSync(OUT_MD, md.join("\n") + "\n");
  console.log(`\n합계: ${JSON.stringify(totals)}`);
  console.log("→", OUT_JSON, "/", OUT_MD);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
