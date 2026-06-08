// B8 재감사 — v18 주차 인정 판정 뒤집힘 전수 리포트 (threshold=confirmStar=37/35 기준).
//
//   node scripts/b8-reaudit-threshold37.mjs
//
// 목적: B7 apply(weeks.check_threshold 백필) 전, b8AuditWeekSet 25주에 대해
//   기존 "주차 성공"이 v18 판정(평점>=4 AND point.check >= week.check_threshold)에서
//   fail 로 뒤집히는 케이스를 전수 산출한다.
//
// 판정 계약 (lib/lineAvailability.ts reduceLegacyUnifiedVerdict 미러 — 코드 수정 없음):
//   - 강화: rating==null(미평가) 또는 rating>=4 → success / rating<=3 → fail
//   - check 게이트: 강화 success 일 때만 평가. enforced = user_weekly_points.checks_migrated
//     행 단위 플래그 단독 (크기/분포 추론 금지). enforced && earned<required → 주차 fail.
//   - 게이트는 read-time 강등 전용 (uws 불변, success→promote 없음).
//
// 구성:
//   Part A (라이브): checks_migrated=true 행 보유 사용자 — B7 apply 즉시(이관 전) 뒤집힘.
//   Part B (pms 시뮬레이션): 이관 후 checks_migrated=true 가 될 실사용자 —
//     pms 인정(useractivities/manageractivities IsActive=1) vs v18 재판정
//     (rating=pms Star, check=pointlogs NET(net_all+신입14일보호) per ActivityTime 주차귀속).
//   Part C (잠정 교차): 이름 기반 잠정 매칭으로 라이브 실사용자 uws=success ↔ pms NET 교차.
//   Part D: reportlogs 대사 가능성 측정.
//
// 읽기 전용 보장: supabase 는 select 만, mysql 은 SELECT 만. write/upsert/rpc 일절 없음.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const env = readFileSync(resolve(root, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();

const OUT_JSON = resolve(root, "claudedocs", "b8-reaudit-37-20260606.json");
const DRYRUN_JSON = resolve(root, "claudedocs", "backfill-seasons-weeks-dryrun-20260605.json");

const DEFAULT_WEEK_CHECK_THRESHOLD = 30; // lib/lineAvailability.ts 와 동일
const RATING_FAIL_MAX = 3; // EXPERIENCE_RATING_FAIL_THRESHOLD
const LEGACY_UNIFIED_LINE_NAME = "[통합] 주차 활동 내역";

const sb = createClient(get("NEXT_PUBLIC_SUPABASE_URL"), get("SUPABASE_SERVICE_ROLE_KEY"));

// ── 공용: PostgREST 1000행 cap 방어 — order+range 전수 페이지네이션 ──
async function fetchAll(table, select, applyFilters, orderCol = "user_id") {
  const page = 1000;
  let from = 0;
  const out = [];
  for (;;) {
    let q = sb.from(table).select(select).order(orderCol, { ascending: true }).range(from, from + page - 1);
    if (applyFilters) q = applyFilters(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} select 실패: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < page) break;
    from += page;
  }
  return out;
}

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

const addDays = (iso, d) => {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
};

function quantiles(sorted) {
  if (sorted.length === 0) return null;
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { min: sorted[0], p10: q(0.1), p25: q(0.25), median: q(0.5), p75: q(0.75), max: sorted[sorted.length - 1], n: sorted.length };
}

// ── 시즌명 정규화 사전 (A3-⑩, fail-closed — backfill dry-run 과 동일 규칙) ──
//   trim → 공백/개행 제거 → '시즌' 접미사 제거 → 사전 룩업. 사전 밖 = null(보류).
const SEASON_DICT = new Map([
  ["봄", "spring"],
  ["여름", "summer"],
  ["가을", "autumn"],
  ["겨울", "winter"],
  ["거울", "winter"], // 오타 명시 등재
]);
function normalizeSeason(raw) {
  if (raw == null) return null;
  let s = String(raw).replace(/[\s\r\n ]+/g, "");
  if (s.endsWith("시즌")) s = s.slice(0, -2);
  return SEASON_DICT.get(s) ?? null;
}

async function main() {
  const report = {
    generatedAt: "2026-06-06 (B8 reaudit, read-only)",
    mode: "read-only audit (supabase select-only + mysql SELECT-only; DB writes: 0)",
    contract: {
      verdictMirror:
        "reduceLegacyUnifiedVerdict: 주차 성공 = (rating null|>=4) AND (!enforced OR points>=threshold). enforced=checks_migrated 행 단위 플래그 단독 — 크기/분포 추론 없음.",
      thresholdSource: "b8AuditWeekSet(weekssettings.confirmStar; 2026-winter W1~7 은 확정3 추론=37)",
      gateScope: "read-time 강등 전용 — uws/growth_stats 불변. 승격 없음(pms fail → v18 success 는 화면에 나타나지 않음).",
    },
  };

  // ════════════════ 0. 감사 주차 25 + 라이브 weeks 매칭 ════════════════
  const dryrun = JSON.parse(readFileSync(DRYRUN_JSON, "utf8"));
  const auditWeeks = dryrun.b8AuditWeekSet.weeks; // [{season_key, week_number, start_date, check_threshold, ...}]
  if (auditWeeks.length !== 25) throw new Error(`b8AuditWeekSet 25 expected, got ${auditWeeks.length}`);

  const auditStarts = auditWeeks.map((w) => w.start_date);
  let liveWeeks;
  {
    const sel = "id,start_date,end_date,week_number,iso_year,iso_week,check_threshold,result_published_at,is_official_rest";
    const { data, error } = await sb.from("weeks").select(sel).in("start_date", auditStarts);
    if (error) throw new Error(`weeks select 실패: ${error.message}`);
    liveWeeks = data;
  }
  if (liveWeeks.length !== 25) throw new Error(`라이브 weeks 매칭 ${liveWeeks.length}/25 — start_date 불일치`);

  // 감사 주차 메타 통합
  const weekByStart = new Map();
  for (const aw of auditWeeks) {
    const lw = liveWeeks.find((w) => w.start_date === aw.start_date);
    weekByStart.set(aw.start_date, {
      ...aw,
      weekId: lw.id,
      endDate: lw.end_date ?? addDays(aw.start_date, 6),
      isoYear: lw.iso_year,
      isoWeek: lw.iso_week,
      liveThreshold: lw.check_threshold, // 현재 라이브 값 (전부 NULL 기대 → 기본 30)
      published: lw.result_published_at != null,
      isOfficialRest: lw.is_official_rest === true,
      newThreshold: aw.check_threshold, // B7 apply 후 값 (37 또는 35)
    });
  }
  const weekById = new Map([...weekByStart.values()].map((w) => [w.weekId, w]));
  report.auditWeeks = [...weekByStart.values()].map((w) => ({
    season_key: w.season_key,
    week_number: w.week_number,
    start: w.start_date,
    end: w.endDate,
    newThreshold: w.newThreshold,
    liveThreshold: w.liveThreshold,
    published: w.published,
    isOfficialRest: w.isOfficialRest,
  }));

  // ════════════════ 1. 라이브 데이터 적재 ════════════════
  // 테스터 식별 = test_user_markers (ILIKE %T% 금지 — 메모리 정책)
  const testerRows = await fetchAll("test_user_markers", "user_id", null, "user_id");
  const testers = new Set(testerRows.map((r) => r.user_id));

  // uws (감사 주차 한정)
  const uwsRows = await fetchAll(
    "user_week_statuses",
    "user_id,week_start_date,status,year,week_number",
    (q) => q.in("week_start_date", auditStarts),
  );

  // uwp (감사 주차 iso year 들 — (year, iso_week) 쌍은 JS 필터)
  const isoYears = [...new Set([...weekByStart.values()].map((w) => w.isoYear).filter((y) => y != null))];
  const uwpRows = await fetchAll(
    "user_weekly_points",
    "user_id,year,week_number,points,checks_migrated",
    (q) => q.in("year", isoYears),
  );
  const isoKeyByStart = new Map(
    [...weekByStart.values()].filter((w) => w.isoYear != null).map((w) => [w.start_date, `${w.isoYear}-${w.isoWeek}`]),
  );
  const uwpByUserIso = new Map(); // `${user}|${year}-${week}` → row
  for (const r of uwpRows) uwpByUserIso.set(`${r.user_id}|${r.year}-${r.week_number}`, r);

  // 통합 라인 평점: master → lines → targets(감사 주차) → evaluations
  const { data: masterRow, error: mErr } = await sb
    .from("cluster4_experience_line_masters")
    .select("id")
    .eq("line_name", LEGACY_UNIFIED_LINE_NAME)
    .limit(1)
    .maybeSingle();
  if (mErr) throw new Error(`unified master 조회 실패: ${mErr.message}`);
  const masterId = masterRow?.id ?? null;

  const ratingByUserWeek = new Map(); // `${user}|${weekId}` → rating(number)
  const hasTargetByUserWeek = new Set(); // `${user}|${weekId}`
  if (masterId) {
    const { data: lineRows, error: lErr } = await sb
      .from("cluster4_lines")
      .select("id")
      .eq("part_type", "experience")
      .eq("experience_line_master_id", masterId)
      .eq("is_active", true);
    if (lErr) throw new Error(`unified lines 조회 실패: ${lErr.message}`);
    const lineIds = (lineRows ?? []).map((l) => l.id);
    const auditWeekIds = [...weekById.keys()];
    let targets = [];
    for (const lc of chunk(lineIds, 50)) {
      const part = await fetchAll(
        "cluster4_line_targets",
        "id,target_user_id,week_id,line_id",
        (q) => q.eq("target_mode", "user").in("line_id", lc).in("week_id", auditWeekIds),
        "id",
      );
      targets.push(...part);
    }
    const targetWeekById = new Map(targets.map((t) => [t.id, t]));
    for (const t of targets) hasTargetByUserWeek.add(`${t.target_user_id}|${t.week_id}`);
    for (const tc of chunk([...targetWeekById.keys()], 200)) {
      const { data: evals, error: eErr } = await sb
        .from("cluster4_experience_line_evaluations")
        .select("line_target_id,user_id,rating")
        .in("line_target_id", tc);
      if (eErr) throw new Error(`evaluations 조회 실패: ${eErr.message}`);
      for (const e of evals ?? []) {
        const t = targetWeekById.get(e.line_target_id);
        if (t) ratingByUserWeek.set(`${e.user_id}|${t.week_id}`, e.rating);
      }
    }
    report.liveRatingCoverage = { unifiedLines: lineIds.length, targetsInAuditWeeks: targets.length, evaluations: ratingByUserWeek.size };
  } else {
    report.liveRatingCoverage = { warning: "통합 마스터 미발견 — 평점 전부 미평가 취급" };
  }

  // 이름 (리포트 표기용)
  const involvedUserIds = [...new Set(uwsRows.map((r) => r.user_id))];
  const nameByUserId = new Map();
  for (const uc of chunk(involvedUserIds, 200)) {
    const { data, error } = await sb.from("user_profiles").select("user_id,display_name").in("user_id", uc);
    if (error) throw new Error(`user_profiles 조회 실패: ${error.message}`);
    for (const p of data ?? []) nameByUserId.set(p.user_id, p.display_name);
  }

  // ════════════════ 2. Part A — B7 apply 즉시 영향 (라이브, 이관 전) ════════════════
  //   현재 표시 success = uws success ∧ published ∧ 비휴식 ∧ ratingOk ∧ (!enforced ∨ points>=liveThr(=30))
  //   apply 후       = 동일하되 threshold → newThreshold(37/35)
  const partA = { universe: 0, flips: [], alreadyDemoted: [], notes: [] };
  const causeCount = (c) => ({ ratingBelow4: 0, ratingMissing_treatedPass: 0, checkBelowThreshold: 0, checkRowMissing: 0, thresholdMissing: 0, ...c });
  const partACauses = causeCount({});
  for (const r of uwsRows) {
    if (r.status !== "success") continue;
    const w = weekByStart.get(r.week_start_date);
    if (!w) continue;
    const isoKey = isoKeyByStart.get(r.week_start_date);
    const uwp = isoKey ? uwpByUserIso.get(`${r.user_id}|${isoKey}`) : null;
    const enforced = uwp?.checks_migrated === true;
    if (!enforced) continue; // Part A 는 현재 enforced 행만 — 미이관(실사용자)은 Part B/C 가 담당
    partA.universe++;
    if (!w.published) { partA.notes.push(`미공표 주차 enforced success: ${r.user_id.slice(0, 8)} ${r.week_start_date}`); continue; }
    if (w.isOfficialRest) continue; // 휴식 주차 — 게이트 무관 (resolver 가 official_rest 로 처리)
    const rating = ratingByUserWeek.get(`${r.user_id}|${w.weekId}`) ?? null;
    const ratingOk = rating == null || rating > RATING_FAIL_MAX;
    const points = uwp?.points ?? 0;
    const liveThr = w.liveThreshold != null && w.liveThreshold >= 0 ? w.liveThreshold : DEFAULT_WEEK_CHECK_THRESHOLD;
    const currentDisplaySuccess = ratingOk && points >= liveThr;
    const postApplySuccess = ratingOk && points >= w.newThreshold;
    const entry = {
      userId: r.user_id,
      name: nameByUserId.get(r.user_id) ?? null,
      isTester: testers.has(r.user_id),
      week: `${w.season_key} W${w.week_number}`,
      weekStart: r.week_start_date,
      rating,
      points,
      liveThreshold: liveThr,
      newThreshold: w.newThreshold,
    };
    if (currentDisplaySuccess && !postApplySuccess) {
      // 원인 분류 (apply 후 기준)
      if (!ratingOk) partACauses.ratingBelow4++;
      else if (!uwp) partACauses.checkRowMissing++;
      else if (points < w.newThreshold) partACauses.checkBelowThreshold++;
      if (rating == null) partACauses.ratingMissing_treatedPass++;
      partA.flips.push(entry);
    } else if (!currentDisplaySuccess) {
      partA.alreadyDemoted.push(entry); // 이미 현행(30) 기준에서도 표시 fail — apply 와 무관
    }
  }
  partA.causes = partACauses;
  partA.flipCount = partA.flips.length;
  partA.alreadyDemotedCount = partA.alreadyDemoted.length;
  // 사용자별/주차별 집계
  const groupCount = (arr, keyFn) => {
    const m = new Map();
    for (const x of arr) m.set(keyFn(x), (m.get(keyFn(x)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ key: k, flips: n }));
  };
  partA.byUser = groupCount(partA.flips, (f) => `${f.name ?? f.userId.slice(0, 8)}${f.isTester ? " (tester)" : ""}`);
  partA.byWeek = groupCount(partA.flips, (f) => f.week);
  report.partA_applyImmediate = partA;

  // 라이브 uws 분포 참고 (실사용자/테스터 × 주차)
  {
    const dist = new Map();
    for (const r of uwsRows) {
      if (r.status !== "success") continue;
      const w = weekByStart.get(r.week_start_date);
      if (!w) continue;
      const who = testers.has(r.user_id) ? "tester" : "real";
      const k = `${w.season_key} W${w.week_number} | ${who}`;
      dist.set(k, (dist.get(k) ?? 0) + 1);
    }
    report.liveUwsSuccessDistribution = [...dist.entries()].sort().map(([k, n]) => ({ key: k, n }));
  }

  // ════════════════ 3. Part B — pms 이관 후 시뮬레이션 ════════════════
  const conn = await mysql.createConnection({
    host: get("MYSQL_HOST"),
    port: Number(get("MYSQL_PORT") ?? 3306),
    user: get("MYSQL_USER"),
    password: get("MYSQL_PASSWORD"),
    database: get("MYSQL_DATABASE"),
    dateStrings: true,
    connectTimeout: 20000,
    ssl: { rejectUnauthorized: false },
  });

  // preflight — 필요한 컬럼 존재 확인 (MySQL 식별자는 대소문자 무관 → 소문자 비교)
  const [colRows] = await conn.query(
    `SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('useractivities','manageractivities','usersinfo','pointlogs','reportlogs','users')`,
  );
  const cols = new Map();
  for (const r of colRows) {
    if (!cols.has(r.t)) cols.set(r.t, new Set());
    cols.get(r.t).add(String(r.c).toLowerCase());
  }
  const need = (t, c) => {
    if (!cols.get(t)?.has(c.toLowerCase())) throw new Error(`preflight: ${t}.${c} 부재`);
  };
  for (const t of ["useractivities", "manageractivities"]) for (const c of ["UserId", "Season", "SeasonWeek", "Star", "IsActive"]) need(t, c);
  for (const c of ["UserID", "StartDate", "State", "Week"]) need("usersinfo", c);
  for (const c of ["UserID", "ActivityTime", "createtime", "Star"]) need("pointlogs", c);
  for (const c of ["UserId", "Season", "Week", "Log", "Created"]) need("reportlogs", c);
  for (const c of ["UserId", "Name"]) need("users", c);

  // usersinfo UserID 유일성 (JOIN 중복 합산 방어)
  const [[uiDup]] = await conn.query(`SELECT COUNT(*) c, COUNT(DISTINCT UserID) d FROM usersinfo`);
  if (uiDup.c !== uiDup.d) throw new Error(`usersinfo UserID 중복 (${uiDup.c} vs ${uiDup.d}) — JOIN 합산 왜곡, 중단`);

  // usersinfo 상태/주차 + users 이름
  const [uiRows] = await conn.query(
    `SELECT UserID AS UserId, CAST(StartDate AS CHAR) AS StartDate, State, Week FROM usersinfo`,
  );
  const uiByUser = new Map(uiRows.map((r) => [r.UserId, r]));
  const [pmsUserRows] = await conn.query(`SELECT UserId, Name FROM users`);
  const pmsNameById = new Map(pmsUserRows.map((r) => [r.UserId, r.Name]));

  // 활동 2세대 — 감사 주차 번호(1~13)만
  async function pullActivities(table) {
    const have = cols.get(table);
    const sel = ["UserId", "Season", "SeasonWeek", "Star", "IsActive"];
    for (const dc of ["StartDate", "CreateTime", "EndDate"]) if (have.has(dc.toLowerCase())) sel.push(`CAST(${dc} AS CHAR) AS ${dc}`);
    if (have.has("username")) sel.push("UserName");
    const [rows] = await conn.query(`SELECT ${sel.join(", ")} FROM ${table} WHERE SeasonWeek BETWEEN 1 AND 13`);
    return rows;
  }
  const uaRows = await pullActivities("useractivities");
  const maRows = await pullActivities("manageractivities");

  // 주차 귀속: (season_type, week_number) 일치 + 날짜 후보가 시즌 인스턴스 창 안 (연도 분리).
  //   창 = [start-60d, end+180d] — 동일 (type,number) 시즌이 1년 간격이라 안전.
  const auditByTypeNum = new Map(); // `${type}|${num}` → week meta
  for (const w of weekByStart.values()) {
    const type = w.season_key.split("-")[1];
    auditByTypeNum.set(`${type}|${w.week_number}`, w);
  }
  function attributeRow(r) {
    const type = normalizeSeason(r.Season);
    if (!type) return { week: null, reason: "season_dict_miss" };
    const w = auditByTypeNum.get(`${type}|${r.SeasonWeek}`);
    if (!w) return { week: null, reason: "not_in_audit_set" };
    const winLo = addDays(w.start_date, -60);
    const winHi = addDays(w.endDate, 180);
    const dates = [r.StartDate, r.CreateTime, r.EndDate].filter(Boolean).map((d) => String(d).slice(0, 10));
    if (dates.length === 0) return { week: null, reason: "no_date" };
    if (dates.some((d) => d >= winLo && d <= winHi)) return { week: w, reason: null };
    return { week: null, reason: "date_out_of_window" };
  }

  // (pmsUserId, weekStart) → 집계
  const pmsAgg = new Map();
  const attributionMisses = { season_dict_miss: 0, no_date: 0, date_out_of_window: 0 };
  const dictMissSamples = new Map();
  function foldActivity(r, source) {
    const { week, reason } = attributeRow(r);
    if (!week) {
      if (reason === "season_dict_miss") {
        attributionMisses.season_dict_miss++;
        const k = String(r.Season);
        dictMissSamples.set(k, (dictMissSamples.get(k) ?? 0) + 1);
      } else if (reason === "no_date") attributionMisses.no_date++;
      else if (reason === "date_out_of_window") attributionMisses.date_out_of_window++;
      return;
    }
    const key = `${r.UserId}|${week.start_date}`;
    let a = pmsAgg.get(key);
    if (!a) {
      a = { userId: r.UserId, weekStart: week.start_date, ua: 0, uaActive: 0, ma: 0, maActive: 0, ratings: [], userName: null };
      pmsAgg.set(key, a);
    }
    if (source === "ua") { a.ua++; if (r.IsActive === 1) a.uaActive++; }
    else { a.ma++; if (r.IsActive === 1) a.maActive++; }
    if (r.Star != null) a.ratings.push(Number(r.Star));
    if (r.UserName && !a.userName) a.userName = r.UserName;
  }
  for (const r of uaRows) foldActivity(r, "ua");
  for (const r of maRows) foldActivity(r, "ma");
  report.partB_attribution = {
    pulled: { useractivities: uaRows.length, manageractivities: maRows.length },
    attributedPairs: pmsAgg.size,
    misses: attributionMisses,
    seasonDictMissSamples: [...dictMissSamples.entries()].map(([k, n]) => ({ season: k, n })),
    note: "miss 는 감사 25주 범위 밖(과거 시즌/사전 미등재) — silent drop 아님, 건수 보고",
  };

  // pointlogs 주차 NET (net_all + 신입 14일 보호) — 주차당 1쿼리 × 25
  const CORR = `CASE WHEN YEAR(p.ActivityTime) BETWEEN 20 AND 99 THEN DATE(p.ActivityTime + INTERVAL 2000 YEAR)
                     WHEN YEAR(p.ActivityTime) = 1 THEN DATE(p.createtime)
                     ELSE DATE(p.ActivityTime) END`;
  const netByUserWeek = new Map(); // `${pmsUserId}|${weekStart}` → {net, netRaw, rows, protectedDelta}
  for (const w of weekByStart.values()) {
    const [rows] = await conn.query(
      `SELECT p.UserID AS userId,
              COUNT(*) AS logRows,
              SUM(COALESCE(p.Star,0)) AS netAll,
              SUM(CASE WHEN COALESCE(p.Star,0) < 0 AND ui.StartDate IS NOT NULL
                        AND YEAR(ui.StartDate) BETWEEN 1990 AND 2100
                        AND ${CORR} < DATE_ADD(DATE(ui.StartDate), INTERVAL 14 DAY)
                   THEN 0 ELSE COALESCE(p.Star,0) END) AS netProtected
       FROM pointlogs p
       LEFT JOIN usersinfo ui ON ui.UserID = p.UserID
       WHERE ${CORR} BETWEEN ? AND ?
       GROUP BY p.UserID`,
      [w.start_date, w.endDate],
    );
    for (const r of rows) {
      netByUserWeek.set(`${r.userId}|${w.start_date}`, {
        net: Number(r.netProtected),
        netRaw: Number(r.netAll),
        rows: Number(r.logRows),
      });
    }
  }

  // ── Part B verdict ──
  const partB = { universeRecognized: 0, flips: [], generationDivergence: 0, multiRatingPairs: 0 };
  const partBCauses = causeCount({});
  const netDistByWeek = new Map(); // weekStart → nets of recognized&ratingOk rows (threshold 정책용)
  for (const a of pmsAgg.values()) {
    const recognized = a.uaActive > 0 || a.maActive > 0;
    const uaSeen = a.ua > 0, maSeen = a.ma > 0;
    if (uaSeen && maSeen && (a.uaActive > 0) !== (a.maActive > 0)) partB.generationDivergence++;
    if (!recognized) continue; // pms 도 실패 — v18 fail 이어도 뒤집힘 아님 (승격 없음)
    partB.universeRecognized++;
    if (a.ratings.length > 1) partB.multiRatingPairs++;
    const w = weekByStart.get(a.weekStart);
    const rating = a.ratings.length ? Math.max(...a.ratings) : null;
    const ratingOk = rating == null || rating > RATING_FAIL_MAX;
    const netRow = netByUserWeek.get(`${a.userId}|${a.weekStart}`) ?? null;
    const net = netRow?.net ?? 0;
    if (ratingOk) {
      if (!netDistByWeek.has(a.weekStart)) netDistByWeek.set(a.weekStart, []);
      netDistByWeek.get(a.weekStart).push(net);
    }
    const v18success = ratingOk && net >= w.newThreshold;
    if (!v18success) {
      const ui = uiByUser.get(a.userId);
      const causes = [];
      if (rating != null && rating <= RATING_FAIL_MAX) { causes.push("rating<4"); partBCauses.ratingBelow4++; }
      if (rating == null) { causes.push("rating누락(현행로직=pass)"); partBCauses.ratingMissing_treatedPass++; }
      if (ratingOk && netRow == null) { causes.push("check행없음(net=0)"); partBCauses.checkRowMissing++; }
      else if (ratingOk && net < w.newThreshold) { causes.push(`check<${w.newThreshold}`); partBCauses.checkBelowThreshold++; }
      partB.flips.push({
        pmsUserId: a.userId,
        userName: pmsNameById.get(a.userId) ?? a.userName,
        state: ui?.State ?? null,
        week: `${w.season_key} W${w.week_number}`,
        weekStart: a.weekStart,
        rating,
        net,
        netRaw: netRow?.netRaw ?? 0,
        logRows: netRow?.rows ?? 0,
        threshold: w.newThreshold,
        causes,
        sources: { uaActive: a.uaActive, maActive: a.maActive },
      });
    }
  }
  partB.causes = partBCauses;
  partB.flipCount = partB.flips.length;
  partB.flipUsers = new Set(partB.flips.map((f) => f.pmsUserId)).size;
  partB.byUser = groupCount(partB.flips, (f) => `${f.userName ?? "?"} (pms ${f.pmsUserId})`).slice(0, 60);
  partB.byWeek = groupCount(partB.flips, (f) => f.week);
  partB.byState = groupCount(partB.flips, (f) => String(f.state ?? "null"));
  partB.flipRate = partB.universeRecognized ? +(partB.flipCount / partB.universeRecognized * 100).toFixed(2) : null;
  report.partB_postMigration = { ...partB, flips: partB.flips.slice(0, 400), flipsTruncatedFrom: partB.flips.length };

  // ── threshold 정책 분석: 인정 성공행 net 분포 + 대안 기준값별 뒤집힘 ──
  const thresholdAnalysis = [];
  for (const [ws, nets] of netDistByWeek) {
    const w = weekByStart.get(ws);
    const sorted = [...nets].sort((a, b) => a - b);
    const flipsAt = (t) => sorted.filter((n) => n < t).length;
    thresholdAnalysis.push({
      week: `${w.season_key} W${w.week_number}`,
      weekStart: ws,
      confirmStar: w.newThreshold,
      recognizedRatingOk: sorted.length,
      netQuantiles: quantiles(sorted),
      flipsAt30: flipsAt(30),
      flipsAt35: flipsAt(35),
      flipsAtConfirmStar: flipsAt(w.newThreshold),
      zeroFlipThreshold: sorted.length ? sorted[0] : null, // 이 값 이하로 내려야 뒤집힘 0
    });
  }
  thresholdAnalysis.sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  report.thresholdAnalysis = thresholdAnalysis;

  // ════════════════ 4. Part C — 라이브 실사용자 잠정 교차 (이름 매칭) ════════════════
  //   주의: legacy_user_id 동일인 매칭 미확정 (체크리스트 미완) — 이름 기반 잠정, 참고용.
  // 모호성 판정은 pms users 전체 기준 (동명이인 false-unique 방지)
  const pmsIdsByName = new Map();
  for (const [id, nm] of pmsNameById) {
    if (!nm) continue;
    if (!pmsIdsByName.has(nm)) pmsIdsByName.set(nm, []);
    pmsIdsByName.get(nm).push(id);
  }
  const partC = { matched: 0, ambiguous: 0, unmatched: 0, flips: [] };
  const liveRealSuccess = uwsRows.filter(
    (r) => r.status === "success" && !testers.has(r.user_id) && weekByStart.has(r.week_start_date),
  );
  const liveRealUsers = [...new Set(liveRealSuccess.map((r) => r.user_id))];
  const pmsIdByLiveUser = new Map();
  for (const uid of liveRealUsers) {
    const nm = nameByUserId.get(uid);
    const cands = nm ? pmsIdsByName.get(nm) ?? [] : [];
    if (cands.length === 1) { pmsIdByLiveUser.set(uid, cands[0]); partC.matched++; }
    else if (cands.length > 1) partC.ambiguous++;
    else partC.unmatched++;
  }
  for (const r of liveRealSuccess) {
    const pmsId = pmsIdByLiveUser.get(r.user_id);
    if (pmsId == null) continue;
    const w = weekByStart.get(r.week_start_date);
    if (!w.published || w.isOfficialRest) continue;
    const rating = ratingByUserWeek.get(`${r.user_id}|${w.weekId}`) ?? null;
    const ratingOk = rating == null || rating > RATING_FAIL_MAX;
    const netRow = netByUserWeek.get(`${pmsId}|${r.week_start_date}`) ?? null;
    const net = netRow?.net ?? 0;
    // 이관 후: uwp 가 pms 집계로 덮임 + checks_migrated=true → enforced
    if (!(ratingOk && net >= w.newThreshold)) {
      partC.flips.push({
        userId: r.user_id,
        name: nameByUserId.get(r.user_id) ?? null,
        pmsUserId: pmsId,
        week: `${w.season_key} W${w.week_number}`,
        weekStart: r.week_start_date,
        rating,
        pmsNet: net,
        threshold: w.newThreshold,
        cause: !ratingOk ? "rating<4" : netRow == null ? "check행없음(net=0)" : `check<${w.newThreshold}`,
      });
    }
  }
  partC.liveRealSuccessRows = liveRealSuccess.length;
  partC.flipCount = partC.flips.length;
  partC.caveat = "이름 기반 잠정 매칭 — legacy_user_id 동일인 확정 리스트(§10 체크리스트) 전 참고용";
  report.partC_liveRealCross = partC;

  // ════════════════ 5. Part D — reportlogs 대사 가능성 ════════════════
  const [rlRows] = await conn.query(
    `SELECT UserId, Season, Week, Log, CAST(Created AS CHAR) AS Created FROM reportlogs WHERE Week BETWEEN 1 AND 13`,
  );
  const rlByUserWeek = new Set();
  let rlAttributed = 0, rlMissed = 0;
  for (const r of rlRows) {
    const type = normalizeSeason(r.Season);
    const w = type ? auditByTypeNum.get(`${type}|${r.Week}`) : null;
    if (!w) { rlMissed++; continue; }
    const created = String(r.Created).slice(0, 10);
    // 결산 로그는 주차 종료 직후 생성 가정 — 창 [start, end+90d]
    if (created >= w.start_date && created <= addDays(w.endDate, 90)) {
      rlByUserWeek.add(`${r.UserId}|${w.start_date}`);
      rlAttributed++;
    } else rlMissed++;
  }
  let agreeBoth = 0, rlOnly = 0, activeOnly = 0;
  for (const a of pmsAgg.values()) {
    const recognized = a.uaActive > 0 || a.maActive > 0;
    const hasRl = rlByUserWeek.has(`${a.userId}|${a.weekStart}`);
    if (recognized && hasRl) agreeBoth++;
    else if (recognized && !hasRl) activeOnly++;
  }
  for (const k of rlByUserWeek) {
    const a = pmsAgg.get(k);
    if (!a || (a.uaActive === 0 && a.maActive === 0)) rlOnly++;
  }
  report.partD_reportlogsFeasibility = {
    pulled: rlRows.length,
    attributedToAuditWeeks: rlAttributed,
    outsideAuditWindow: rlMissed,
    agreement: { both: agreeBoth, reportlogOnly: rlOnly, isActiveOnly: activeOnly },
    verdict:
      "대사 가능 — (user, week) 키로 IsActive ↔ reportlogs 존재 비교 산출. " +
      "단 reportlogs 는 '누적 주차 변경' 발생 시에만 기록(무변경 결산 미기록 가능) — 완전 동치 기대 금지, 방향성 지표로 사용",
  };

  await conn.end();

  // ════════════════ 6. 영향 분석 (정책 #7 입력) ════════════════
  report.impactContract = {
    uwsWrites: "없음 — v18 게이트는 read-time 강등 전용. syncExperienceGrowthWeekStatuses 도 레거시 주차 update 금지(protectedWeekKeys 관찰만).",
    displayedAccumulated:
      "cluster4WeeklyGrowthData/cards 누적(accumulatedApprovedWeeks)은 verdict=fail 주차를 제외 — 뒤집힘 1건당 표시 누적 −1 (uws 기반 growth_stats.cumulative_weeks 는 불변 → 화면 간 분기 발생 지점)",
    snapshots:
      "weeks.check_threshold 변경은 자동 무효화 없음 — apply 후 checks_migrated=true 행 보유 사용자 snapshot 명시 재계산 필수 (현재 90명, 이관 후 전 사용자)",
    demoUserId:
      "weekly-cards 는 demoUserId=조회대상 override only(동일 snapshot DTO) — 경로 차이 없음. weekly-growth(front 정리 후 시즌 3필드)는 실시간 — 동일 입력이라 영향 동일.",
  };

  writeFileSync(OUT_JSON, JSON.stringify(report, null, 1));

  // ── 콘솔 요약 ──
  console.log("══ B8 재감사 (threshold=confirmStar) — read-only ══");
  console.log(`Part A (apply 즉시, enforced 행): universe=${partA.universe} flips=${partA.flipCount} alreadyDemoted=${partA.alreadyDemotedCount}`);
  console.log(`  byWeek:`, partA.byWeek.map((x) => `${x.key}:${x.flips}`).join(" "));
  console.log(`Part B (이관 후 시뮬레이션): recognized=${partB.universeRecognized} flips=${partB.flipCount} (${partB.flipRate}%) users=${partB.flipUsers}`);
  console.log(`  causes:`, JSON.stringify(partBCauses));
  console.log(`  세대 불일치(ua↔ma):`, partB.generationDivergence);
  console.log(`Part C (라이브 실사용자 잠정): liveRealSuccess=${partC.liveRealSuccessRows} matched=${partC.matched} flips=${partC.flipCount}`);
  console.log(`Part D (reportlogs): both=${agreeBoth} rlOnly=${rlOnly} activeOnly=${activeOnly}`);
  console.log(`\n→ ${OUT_JSON}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
