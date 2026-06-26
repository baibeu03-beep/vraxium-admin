/**
 * apply-jeonhyeonseong-migration — 전현성(oranke PMS UserId=1051) 단독 전체 이력 이관 + 2026-summer 휴식.
 *   npx tsx --env-file=.env.local scripts/apply-jeonhyeonseong-migration.ts            # PREVIEW (write 0)
 *   npx tsx --env-file=.env.local scripts/apply-jeonhyeonseong-migration.ts --apply
 *   npx tsx --env-file=.env.local scripts/apply-jeonhyeonseong-migration.ts --rollback <runlog.json>
 *
 * 사용자 확정(2026-06-26) — B안 전체 이력 복원:
 *   - 대상 = oranke (source_system) / legacy_user_id=1051 / Name=전현성 단 1명(고정 가드).
 *   - promote-restusers / apply-pms-source-batch 의 검증된 집계(CORR·protect·FLIP·sentinel·[통합]라인 ensure·경험)를
 *     단일 사용자로 적용. pointlogs→ledger+uwp · useractivities/manageractivities→uws/경험 · 잔액 sentinel.
 *   - status='active' · growth_status='active' (전인 seasonal_rest 금지 — 여름 휴식은 season_status 로만).
 *   - 이관 후 user_season_statuses(2026-summer, rest) 추가. 과거 시즌은 PMS 원천대로(소급 없음).
 *   - insert-only · 3중키 강매칭 fail-closed · (source,legacy) 페어 점유 fail-closed.
 *   - 다른 회원 무수정.
 *
 * rollback: run log 역순 — 경험/uss/uws/uwp/ledger/education/membership/snapshot/roster/growth/profile/users 삭제 + ensure 라인 제거.
 */
import { readFileSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";
import { ledgerSourceTable, resolveOrganizationSlug, mapUsersinfoTeamPart, type PmsSourceSystem } from "@/lib/pmsMigration";
import { recalcUserGrowthStats } from "@/lib/userGrowthStatsData";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { isExcludedPmsSeason, normalizePmsSeasonType } from "@/lib/pmsSeasonAttribution";

const SRC: PmsSourceSystem = "oranke";
const UID = 1051;
const EXPECT_NAME = "전현성";
const SUMMER_KEY = "2026-summer";

const APPLY = process.argv.includes("--apply");
const rbIdx = process.argv.indexOf("--rollback");
const ROLLBACK_FILE = rbIdx >= 0 ? process.argv[rbIdx + 1] : null;
const MODE = ROLLBACK_FILE ? "rollback" : APPLY ? "apply" : "preview";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = `claudedocs/jeonhyeonseong-migration-${MODE}-${STAMP}.json`;
const CREATED_BY = "jeonhyeonseong-migration";
const DEFAULT_THRESHOLD = 30;
const RATING_FAIL_MAX = 3;
const UNIFIED_MASTER_NAME = "[통합] 주차 활동 내역";
const UNIFIED_LINE_MAIN_TITLE =
  "한 주 동안 클럽에서 진행한 중앙, 팀 활동 내역을 아우르는 통합 기록입니다. (26년 6월 이전)";
const ADMIN_ID = "c28b2409-4118-49fc-a42e-68e18dbd194c";

const weekOpensAtIso = (startDate: string) => {
  const ms = Date.UTC(+startDate.slice(0, 4), +startDate.slice(5, 7) - 1, +startDate.slice(8, 10));
  return new Date(ms - 9 * 3_600_000).toISOString();
};
const weekClosesAtIso = (startDate: string) => {
  const ms = Date.UTC(+startDate.slice(0, 4), +startDate.slice(5, 7) - 1, +startDate.slice(8, 10));
  return new Date(ms + 7 * 86_400_000 - 9 * 3_600_000 - 1000).toISOString();
};

const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);
const line = (s = "") => console.log(s);

const normPhone = (s: unknown) => { const d = String(s ?? "").replace(/\D/g, ""); return d.length >= 8 ? d.slice(-8) : ""; };
const normEmail = (s: unknown) => String(s ?? "").trim().toLowerCase();
const addDays = (iso: string, d: number) => { const t = new Date(`${iso}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };
function parseBirthIso(bd: unknown): string | null {
  const s = String(bd ?? "").replace(/\D/g, "");
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (s.length === 6) { const yy = Number(s.slice(0, 2)); return `${yy <= 26 ? "20" : "19"}${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}`; }
  return null;
}

type LiveWeek = { id: string; season_key: string; week_number: number; start_date: string; end_date: string; iso_year: number | null; iso_week: number | null; check_threshold: number | null; };

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

async function rollback(file: string) {
  const log = JSON.parse(readFileSync(file, "utf8"));
  const u = log.applied;
  const issues: string[] = [];
  if (!u) { line("run log 에 applied 없음"); return; }
  const del = async (table: string, ids: string[]) => {
    for (let i = 0; i < (ids ?? []).length; i += 100) {
      const { error } = await sb.from(table).delete().in("id", ids.slice(i, i + 100));
      if (error) issues.push(`${table}: ${error.message}`);
    }
  };
  await del("user_season_statuses", u.inserted?.seasonStatusIds ?? []);
  await del("cluster4_experience_line_evaluations", u.inserted?.evaluationIds ?? []);
  await del("cluster4_line_submissions", u.inserted?.submissionIds ?? []);
  await del("cluster4_line_targets", u.inserted?.targetIds ?? []);
  await del("user_week_statuses", u.inserted?.uwsIds ?? []);
  await del("user_weekly_points", u.inserted?.uwpIds ?? []);
  await del("legacy_point_ledger", u.inserted?.ledgerIds ?? []);
  await del("user_educations", u.inserted?.educationIds ?? []);
  await del("user_memberships", u.inserted?.membershipIds ?? []);
  for (const t of ["cluster4_weekly_card_snapshots", "cluster4_roster_card_stats", "user_growth_stats"]) {
    const { error } = await sb.from(t).delete().eq("user_id", u.uuid);
    if (error) issues.push(`${t} ${u.uuid}: ${error.message}`);
  }
  { const { error } = await sb.from("user_profiles").delete().eq("user_id", u.uuid); if (error) issues.push(`user_profiles: ${error.message}`); }
  { const { error } = await sb.from("users").delete().eq("id", u.uuid); if (error) issues.push(`users: ${error.message}`); }
  for (const l of log.insertedLines ?? []) {
    const { error } = await sb.from("cluster4_lines").delete().eq("id", l.id).eq("source_file_name", CREATED_BY);
    if (error) issues.push(`line ${l.id}: ${error.message}`);
  }
  writeFileSync(OUT, JSON.stringify({ mode: "rollback", source: file, issues }, null, 1));
  line(issues.length ? issues.join("\n") : "rollback 완료 (이슈 0)");
  process.exit(issues.length ? 1 : 0);
}

async function main() {
  if (ROLLBACK_FILE) return rollback(ROLLBACK_FILE);

  const org = resolveOrganizationSlug(SRC);
  const conn = await mysql.createConnection({
    host: envGet("MYSQL_HOST"), port: Number(envGet("MYSQL_PORT") ?? 3306),
    user: envGet("MYSQL_USER"), password: envGet("MYSQL_PASSWORD"), dateStrings: true, ssl: { rejectUnauthorized: false },
  });

  // 공유 데이터
  const weeks = await fetchAllSb<LiveWeek>("weeks", "id,season_key,week_number,start_date,end_date,iso_year,iso_week,check_threshold", "start_date");
  const weekByRange = (d: string) => weeks.find((w) => d >= w.start_date && d <= w.end_date) ?? null;
  const orgThrMap = new Map<string, number>();
  for (const r of await fetchAllSb<{ week_id: string; check_threshold: number }>("org_week_thresholds", "week_id,check_threshold", "week_id", (q) => q.eq("organization_slug", org))) orgThrMap.set(r.week_id, r.check_threshold);
  const thrOf = (w: LiveWeek) => orgThrMap.get(w.id) ?? (w.check_threshold != null && w.check_threshold >= 0 ? w.check_threshold : DEFAULT_THRESHOLD);

  const { data: master } = await sb.from("cluster4_experience_line_masters").select("id,line_code").eq("line_name", UNIFIED_MASTER_NAME).maybeSingle();
  if (!master) throw new Error("[통합] 마스터 부재");
  const { data: unifiedReg } = await sb.from("line_registrations").select("line_code").eq("bridged_master_id", (master as any).id).maybeSingle();
  const UNIFIED_OFFICIAL_LINE_CODE: string | null = (unifiedReg as any)?.line_code ?? (master as any).line_code ?? null;
  if (!UNIFIED_OFFICIAL_LINE_CODE) throw new Error("[통합] 공식 라인 코드 부재");
  const unifiedLines = await fetchAllSb<{ id: string; week_id: string | null }>("cluster4_lines", "id,week_id", "id", (q) => q.eq("experience_line_master_id", (master as any).id).eq("is_active", true));
  const lineByWeekId = new Map<string, string>();
  for (const l of unifiedLines) if (l.week_id) lineByWeekId.set(l.week_id, l.id);
  if (!weeks.some((w) => w.season_key === SUMMER_KEY)) throw new Error(`weeks 에 ${SUMMER_KEY} 부재`);

  // PMS 원천
  const [[pms]] = (await conn.query(`SELECT UserId, Name, CAST(BirthDay AS CHAR) AS BirthDay, Gender, School, Major, Address, Contact, mail FROM ${SRC}.users WHERE UserId=?`, [UID])) as any;
  if (!pms) throw new Error(`${SRC}/${UID} PMS users 행 부재`);
  if (String(pms.Name) !== EXPECT_NAME) throw new Error(`이름 가드 불일치: PMS='${pms.Name}' 기대='${EXPECT_NAME}'`);
  const [[info]] = (await conn.query(`SELECT Team, Part, Week, Level, State, CAST(StartDate AS CHAR) AS StartDate FROM ${SRC}.usersinfo WHERE UserID=?`, [UID])) as any;
  const [[bal]] = (await conn.query(`SELECT Star, Shield FROM ${SRC}.userspoint WHERE UserID=?`, [UID])) as any;

  // 3중 키 강매칭 fail-closed
  const birthIso = parseBirthIso(pms.BirthDay);
  const { data: nameMatches } = await sb.from("user_profiles").select("user_id,display_name,birth_date,contact_phone,contact_email").eq("display_name", String(pms.Name));
  const pmsPhone = normPhone(pms.Contact), pmsEmail = normEmail(pms.mail);
  const strong = (nameMatches ?? []).filter((c: any) => (birthIso != null && c.birth_date === birthIso) || (pmsPhone !== "" && normPhone(c.contact_phone) === pmsPhone) || (pmsEmail !== "" && normEmail(c.contact_email) === pmsEmail));
  if (strong.length >= 1) throw new Error(`기존 프로필 강매칭 ${strong.length}건(${strong.map((s: any) => s.user_id).join(",")}) — insert-only fail-closed`);
  const { data: pairRows } = await sb.from("users").select("id").eq("source_system", SRC).eq("legacy_user_id", UID);
  if ((pairRows ?? []).length > 0) throw new Error(`(source,legacy) 페어 이미 점유 — 재이관 차단`);

  const uuid = randomUUID();

  // pointlogs → ledger + uwp 집계
  const CORR = `CASE WHEN YEAR(ActivityTime) BETWEEN 20 AND 99 THEN DATE(ActivityTime + INTERVAL 2000 YEAR)
                     WHEN YEAR(ActivityTime)=1 THEN DATE(createtime) ELSE DATE(ActivityTime) END`;
  const [plogs] = (await conn.query(
    `SELECT LogNum, code, log, Info, Star, Shield, IsDeleted, CAST(ActivityTime AS CHAR) AS ActivityTime,
            CAST(createtime AS CHAR) AS createtime, CAST(${CORR} AS CHAR) AS corrected
     FROM ${SRC}.pointlogs WHERE UserID=? ORDER BY LogNum`, [UID])) as any;
  const startIso = String(info?.StartDate ?? "").slice(0, 10);
  const protectUntil = startIso >= "2020-01-01" ? addDays(startIso, 14) : "0000-00-00";
  type Agg = { points: number; adv: number; pen: number };
  const agg = new Map<string, Agg>();
  let unattributed = 0;
  for (const r of plogs) {
    const w = weekByRange(String(r.corrected));
    if (!w) { if ((r.Star ?? 0) !== 0 || (r.Shield ?? 0) !== 0) unattributed++; continue; }
    let ag = agg.get(w.id); if (!ag) { ag = { points: 0, adv: 0, pen: 0 }; agg.set(w.id, ag); }
    let star = Number(r.Star ?? 0); if (star < 0 && String(r.corrected) < protectUntil) star = 0;
    ag.points += star;
    const sh = Number(r.Shield ?? 0);
    if (r.IsDeleted === 0) { if (sh > 0) ag.adv += sh; else if (sh < 0) ag.pen += -sh; }
  }

  // activities → uws/경험
  type WP = { week: LiveWeek; recognized: boolean; rating: number | null; subtitle: string | null };
  const wp = new Map<string, WP>();
  for (const table of ["useractivities", "manageractivities"]) {
    const [rows] = (await conn.query(`SELECT ActivityId, Season, SeasonWeek, Star, IsActive, Activity, CAST(StartDate AS CHAR) AS StartDate, CAST(EndDate AS CHAR) AS EndDate FROM ${SRC}.${table} WHERE UserId=?`, [UID])) as any;
    for (const r of rows) {
      if (isExcludedPmsSeason(r.Season)) continue;
      const type = normalizePmsSeasonType(r.Season);
      const cands = type ? weeks.filter((w) => w.season_key.endsWith(`-${type}`) && w.week_number === r.SeasonWeek) : [];
      const dates = [r.StartDate, r.EndDate].filter(Boolean).map((d: string) => String(d).slice(0, 10));
      let w: LiveWeek | null = null;
      for (const c of cands) { const lo = addDays(c.start_date, -60), hi = addDays(c.end_date, 180); if (dates.some((d: string) => d >= lo && d <= hi)) { w = c; break; } }
      if (!w && dates.length) w = weekByRange(dates[0]) ?? (dates[1] ? weekByRange(dates[1]) : null);
      if (!w) continue;
      let v = wp.get(w.id); if (!v) { v = { week: w, recognized: false, rating: null, subtitle: null }; wp.set(w.id, v); }
      if (r.IsActive === 1) v.recognized = true;
      if (r.Star != null) { const cl = Math.max(0, Math.min(10, Number(r.Star))); if (v.rating == null || cl > v.rating) v.rating = cl; }
      const text = String(r.Activity ?? "").trim();
      if (text && (!v.subtitle || text.length > v.subtitle.length)) v.subtitle = text;
    }
  }
  await conn.end();

  // 판정 + FLIP + 행 계획
  let flips = 0;
  const uwsPlans: Array<{ week: LiveWeek; status: string }> = [];
  const expPlans: Array<{ week: LiveWeek; subtitle: string | null; rating: number | null }> = [];
  const flipWeekIds = new Set<string>();
  const ensureWeeks: LiveWeek[] = [];
  let summerConflict = 0;
  for (const [, v] of wp) {
    const ag = agg.get(v.week.id) ?? { points: 0, adv: 0, pen: 0 };
    const status = v.recognized ? "success" : "fail";
    if (v.recognized) { const ratingOk = v.rating == null || v.rating > RATING_FAIL_MAX; if (!(ratingOk && ag.points >= thrOf(v.week))) { flips++; flipWeekIds.add(v.week.id); } }
    if (v.week.season_key === SUMMER_KEY) summerConflict++; // 여름 활동주차가 잡히면 휴식과 모순 — 경고(기대 0)
    uwsPlans.push({ week: v.week, status });
    expPlans.push({ week: v.week, subtitle: v.subtitle, rating: v.rating });
    if (!lineByWeekId.has(v.week.id)) ensureWeeks.push(v.week);
  }
  const uwpPlans: Array<{ week: LiveWeek; agg: Agg; cm: boolean }> = [];
  for (const [wid, ag] of agg) { const w = weeks.find((x) => x.id === wid)!; uwpPlans.push({ week: w, agg: ag, cm: !flipWeekIds.has(wid) }); }
  const sumP = [...agg.values()].reduce((s, ag) => s + ag.points, 0);
  const sumA = [...agg.values()].reduce((s, ag) => s + ag.adv, 0);
  const sumPen = [...agg.values()].reduce((s, ag) => s + ag.pen, 0);
  const starDelta = Number(bal?.Star ?? 0) - sumP;
  const shieldDelta = Number(bal?.Shield ?? 0) - (sumA - sumPen);
  const sentinel = { points: starDelta, advantages: Math.max(shieldDelta, 0), penalty: Math.max(-shieldDelta, 0) };
  const tp = mapUsersinfoTeamPart(info ?? { Team: null, Part: null });

  const seasonBreakdown: Record<string, number> = {};
  for (const p of uwsPlans) seasonBreakdown[p.week.season_key] = (seasonBreakdown[p.week.season_key] ?? 0) + 1;

  const report: any = {
    generatedAt: STAMP, mode: MODE, target: { src: SRC, uid: UID, name: pms.Name, org, uuid },
    pms: { birthIso, gender: pms.Gender, school: pms.School, major: pms.Major, contact: pms.Contact, mail: pms.mail, team: info?.Team, part: info?.Part, level: info?.Level, state: info?.State, startDate: startIso, week: info?.Week, balStar: bal?.Star, balShield: bal?.Shield },
    teamPart: tp,
    counts: { pointlogs: plogs.length, ledger: plogs.length + 1, uwp: uwpPlans.length + 1, uws: uwsPlans.length, experience: expPlans.length, flips, unattributed, ensureLines: ensureWeeks.length, summerConflict },
    seasonBreakdown, sentinel,
    seasonStatus: { season_key: SUMMER_KEY, status: "rest" },
  };
  line(JSON.stringify(report, null, 2));
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  line(`→ ${OUT}`);
  if (summerConflict > 0) line(`⚠ summerConflict=${summerConflict} — 여름 활동주차가 잡힘(휴식과 모순). 검토 필요.`);

  if (!APPLY) { line("PREVIEW — 쓰기 0. 적용하려면 --apply."); return; }

  // ════════ APPLY ════════
  const insertedLines: Array<{ id: string; week_id: string; start_date: string }> = [];
  const u: any = { uuid, archiveId: null, inserted: { profileIds: [], membershipIds: [], educationIds: [], ledgerIds: [], uwpIds: [], uwsIds: [], targetIds: [], submissionIds: [], evaluationIds: [], seasonStatusIds: [] } };
  const flushLog = () => writeFileSync(OUT, JSON.stringify({ ...report, insertedLines, applied: u }, null, 1));

  // 0) [통합] 라인 ensure
  const ensureById = new Map<string, LiveWeek>(); for (const w of ensureWeeks) ensureById.set(w.id, w);
  for (const w of [...ensureById.values()].sort((a, b) => a.start_date.localeCompare(b.start_date))) {
    if (lineByWeekId.has(w.id)) continue;
    const { data, error } = await sb.from("cluster4_lines").insert({
      part_type: "experience", main_title: UNIFIED_LINE_MAIN_TITLE, experience_line_master_id: (master as any).id,
      line_code: UNIFIED_OFFICIAL_LINE_CODE, week_id: w.id, submission_opens_at: weekOpensAtIso(w.start_date),
      submission_closes_at: weekClosesAtIso(w.start_date), is_active: true, source_file_name: CREATED_BY, created_by: ADMIN_ID, updated_by: ADMIN_ID,
    }).select("id").single();
    if (error || !data) { line(`라인 ensure 실패(${w.start_date}): ${error?.message}`); flushLog(); process.exit(1); }
    lineByWeekId.set(w.id, (data as any).id);
    insertedLines.push({ id: (data as any).id, week_id: w.id, start_date: w.start_date });
    flushLog();
  }

  try {
    const nowIso = new Date().toISOString();
    // 1) users
    { const { error } = await sb.from("users").insert({ id: uuid, legacy_user_id: UID, source_system: SRC }); if (error) throw new Error(`users: ${error.message}`); }
    // 2) profile / membership / education — status=active · growth_status=active
    {
      const { error: pe } = await sb.from("user_profiles").insert({
        user_id: uuid, display_name: pms.Name, birth_date: birthIso, gender: pms.Gender ?? null,
        contact_phone: pms.Contact ?? null, contact_email: pms.mail ?? null, organization_slug: org,
        school_name: pms.School ?? null, current_team_name: tp.teamName, current_part_name: tp.partName,
        status: "active", growth_status: "active", activity_started_at: startIso || null,
      });
      if (pe) throw new Error(`profile: ${pe.message}`); u.inserted.profileIds.push(uuid);
      const mid = randomUUID();
      const { error: me } = await sb.from("user_memberships").insert({ id: mid, user_id: uuid, team_name: tp.teamName, part_name: tp.partName, membership_level: info?.Level ?? null, membership_state: "active", is_current: true });
      if (me) throw new Error(`membership: ${me.message}`); u.inserted.membershipIds.push(mid);
      if (pms.School) { const eid = randomUUID(); const { error: ee } = await sb.from("user_educations").insert({ id: eid, user_id: uuid, school_name: pms.School, major_name_1: pms.Major ?? null }); if (ee) throw new Error(`education: ${ee.message}`); u.inserted.educationIds.push(eid); }
    }
    // 3) ledger (+adjustment)
    const ledgerRows = plogs.map((r: any) => ({
      id: randomUUID(), source_table: ledgerSourceTable(SRC, "pointlogs"), source_pk: r.LogNum, user_id: uuid, legacy_user_id: UID,
      week_id: weekByRange(String(r.corrected))?.id ?? null, occurred_at: `${String(r.corrected)}T00:00:00Z`, code: String(r.code ?? ""), reason: String(r.log ?? ""),
      star: Number(r.Star ?? 0), shield: Number(r.Shield ?? 0), entry_type: r.IsDeleted === 1 ? "POINTLOG_VOIDED" : "POINTLOG",
      snapshot: r, payload: { Info: r.Info ?? null, IsDeleted: r.IsDeleted }, migrated_at: nowIso, created_by: CREATED_BY,
    }));
    ledgerRows.push({ id: randomUUID(), source_table: ledgerSourceTable(SRC, "pointlogs"), source_pk: -UID, user_id: uuid, legacy_user_id: UID, week_id: null, occurred_at: nowIso, code: "ADJ", reason: "MIGRATION_ADJUSTMENT (컷오버 잔액 항등)", star: sentinel.points, shield: sentinel.advantages - sentinel.penalty, entry_type: "MIGRATION_ADJUSTMENT", snapshot: bal, payload: { sums: true }, migrated_at: nowIso, created_by: CREATED_BY } as any);
    for (let i = 0; i < ledgerRows.length; i += 200) {
      const { data: insRows, error } = await sb.from("legacy_point_ledger").upsert(ledgerRows.slice(i, i + 200), { onConflict: "source_table,source_pk", ignoreDuplicates: true }).select("id");
      if (error) throw new Error(`ledger: ${error.message}`); u.inserted.ledgerIds.push(...((insRows ?? []) as any[]).map((r) => r.id));
    }
    // 4) uwp (+sentinel)
    for (const r of uwpPlans) {
      const id = randomUUID();
      const { error } = await sb.from("user_weekly_points").insert({ id, user_id: uuid, year: r.week.iso_year ?? Number(r.week.start_date.slice(0, 4)), week_number: r.week.iso_week ?? r.week.week_number, week_start_date: r.week.start_date, points: r.agg.points, advantages: r.agg.adv, penalty: r.agg.pen, checks_migrated: r.cm });
      if (error) throw new Error(`uwp ${r.week.start_date}: ${error.message}`); u.inserted.uwpIds.push(id);
    }
    { const id = randomUUID(); const { error } = await sb.from("user_weekly_points").insert({ id, user_id: uuid, year: 1900, week_number: 1, week_start_date: "1900-01-01", points: sentinel.points, advantages: sentinel.advantages, penalty: sentinel.penalty, checks_migrated: false }); if (error) throw new Error(`sentinel: ${error.message}`); u.inserted.uwpIds.push(id); }
    // 5) uws
    for (const r of uwsPlans) {
      const id = randomUUID();
      const { error } = await sb.from("user_week_statuses").insert({ id, user_id: uuid, year: r.week.iso_year ?? Number(r.week.start_date.slice(0, 4)), week_number: r.week.iso_week ?? r.week.week_number, week_start_date: r.week.start_date, status: r.status, season_key: r.week.season_key });
      if (error) throw new Error(`uws ${r.week.start_date}: ${error.message}`); u.inserted.uwsIds.push(id);
    }
    // 6) 경험 (targets→submissions→evaluations)
    for (const r of expPlans) {
      const lineId = lineByWeekId.get(r.week.id); if (!lineId) throw new Error(`[통합] 라인 부재 ${r.week.start_date}`);
      const tid = randomUUID();
      const { error: te } = await sb.from("cluster4_line_targets").insert({ id: tid, line_id: lineId, week_id: r.week.id, target_mode: "user", target_user_id: uuid, target_rule: {} });
      if (te) throw new Error(`target: ${te.message}`); u.inserted.targetIds.push(tid);
      const sid = randomUUID();
      const { error: se } = await sb.from("cluster4_line_submissions").insert({ id: sid, line_target_id: tid, user_id: uuid, subtitle: r.subtitle ?? "주차 활동 내역(PMS 이관)", submitted_at: `${r.week.end_date}T22:59:59Z`, output_links: [], output_images: [], growth_point: null });
      if (se) throw new Error(`submission: ${se.message}`); u.inserted.submissionIds.push(sid);
      if (r.rating != null) { const eid = randomUUID(); const { error: ee } = await sb.from("cluster4_experience_line_evaluations").insert({ id: eid, line_target_id: tid, user_id: uuid, rating: r.rating, evaluated_at: `${r.week.end_date}T23:00:00Z` }); if (ee) throw new Error(`evaluation: ${ee.message}`); u.inserted.evaluationIds.push(eid); }
    }
    // 7) user_season_statuses(2026-summer, rest)
    { const id = randomUUID(); const { error } = await sb.from("user_season_statuses").insert({ id, user_id: uuid, season_key: SUMMER_KEY, status: "rest", note: "2026 여름 시즌 전체 휴식 (확정 명단 2026-06-26, PMS 단독이관)" }); if (error) throw new Error(`season_status: ${error.message}`); u.inserted.seasonStatusIds.push(id); }
    // 8) recalc + snapshot
    await recalcUserGrowthStats(uuid);
    await recomputeAndStoreWeeklyCardsSnapshot(uuid);
    u.ok = true; flushLog();
    line(`✔ ${SRC}/${UID} ${pms.Name} apply 완료 — uuid=${uuid}`);
    line(`rollback: npx tsx --env-file=.env.local scripts/apply-jeonhyeonseong-migration.ts --rollback ${OUT}`);
  } catch (e) {
    u.ok = false; u.error = e instanceof Error ? e.message : String(e); flushLog();
    line(`✖ 실패 — 중단. rollback: --rollback ${OUT}\n  ${u.error}`);
    process.exit(1);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
