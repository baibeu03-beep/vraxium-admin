/**
 * promote-restusers — RestUsers archive → Vraxium 승격 (2026-spring 시즌휴식 보존 · full-history 복원).
 *
 *   npx tsx --env-file=.env.local scripts/promote-restusers.ts                 # preview (write 0)
 *   npx tsx --env-file=.env.local scripts/promote-restusers.ts --limit 3       # preview 상위 N
 *   npx tsx --env-file=.env.local scripts/promote-restusers.ts --ids <id,id>   # 특정 archive.id 만
 *   npx tsx --env-file=.env.local scripts/promote-restusers.ts --apply         # 실제 적용
 *   npx tsx --env-file=.env.local scripts/promote-restusers.ts --apply --limit 3   # pilot apply
 *   npx tsx --env-file=.env.local scripts/promote-restusers.ts --rollback <runlog.json>
 *
 * 목적(사용자 확정 2026-06-18): /Users/RestUsers(usersinfo.Team='시즌전체휴식') 명단을
 *   Vraxium 에 "2026 봄 시즌 시즌휴식 회원" 으로 보존 복원한다. 활동 재개가 아니다.
 *     - user_profiles.status='active' · growth_status='seasonal_rest'
 *     - user_season_statuses(season_key='2026-spring', status='rest')  ← 2-write 정합(관리자 raw + 고객 파생)
 *   여름(2026-summer) 상태는 이번 작업에서 만들지 않는다(별도 작업).
 *
 * 데이터 출처/계약:
 *   - 타깃 = legacy_pms_restuser_archive (promotion_status='archived'). skipped(strong_dup) 자동 제외.
 *   - (source_system, legacy_user_id) 로 PMS 원본 직접 조회 → full-history(pointlogs/useractivities/
 *     manageractivities) 복원. apply-pms-source-batch 의 검증된 집계/FLIP/sentinel/[통합]라인 ensure/
 *     경험 보존 로직을 재사용한다.
 *   - **insert-only**: 3중 키(이름+생년월일+연락처) 강매칭이 발견되면 fail-closed throw
 *     (기존 active 사용자를 seasonal_rest 로 덮지 않는다 — "동일성 충돌 재발생시 즉시 중단").
 *   - status/growth_status 는 PMS State 매핑(resolveAccountStatusFromPmsState) 을 쓰지 않고
 *     active/seasonal_rest 로 고정(보존 정책). pms_state(졸업/운영진 포함)는 로그로만 노출.
 *   - 멱등키: users (source_system, legacy_user_id) / ledger (source_table, source_pk) /
 *     uwp sentinel (user, 1900-01-01) / uss (user, season_key) / 경험 (target_user_id, week_id).
 *   - snapshot 은 per-user recomputeAndStoreWeeklyCardsSnapshot 후, 배치 종료 시
 *     recomputeWeeklyCardsSnapshotsForUsers 로 1회 더 명시 생성(markStale 미사용).
 *   - 완료 사용자마다 archive UPDATE: promotion_status='promoted', promoted_user_id, promoted_at.
 *
 * rollback: run log 역순 — 경험/uss/uws/uwp/ledger 신규 행 삭제, 종속·users 삭제,
 *   archive promotion_status='archived'·promoted_user_id/at=NULL 복원, ensure 라인 제거.
 *   (insert-only 라 source_system NULL 복원 수동 SQL 불필요.)
 */
import { readFileSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";
import { ledgerSourceTable, resolveOrganizationSlug, mapUsersinfoTeamPart, type PmsSourceSystem } from "@/lib/pmsMigration";
import { recalcUserGrowthStats } from "@/lib/userGrowthStatsData";
import { recomputeAndStoreWeeklyCardsSnapshot, recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";
import { isExcludedPmsSeason, normalizePmsSeasonType } from "@/lib/pmsSeasonAttribution";

const APPLY = process.argv.includes("--apply");
const rbIdx = process.argv.indexOf("--rollback");
const ROLLBACK_FILE = rbIdx >= 0 ? process.argv[rbIdx + 1] : null;
const limIdx = process.argv.indexOf("--limit");
const LIMIT = limIdx >= 0 ? Number(process.argv[limIdx + 1]) : null;
const idsIdx = process.argv.indexOf("--ids");
const ONLY_IDS = idsIdx >= 0 ? process.argv[idsIdx + 1].split(",").map((s) => s.trim()).filter(Boolean) : null;
const orgIdx = process.argv.indexOf("--org");
const ONLY_ORG = orgIdx >= 0 ? process.argv[orgIdx + 1].trim() : null; // encre|oranke|phalanx — 분할 apply
const MODE = ROLLBACK_FILE ? "rollback" : APPLY ? "apply" : "preview";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = `claudedocs/promote-restusers-${MODE}-${STAMP}.json`;
const CREATED_BY = "promote-restusers";
const DEFAULT_THRESHOLD = 30;
const RATING_FAIL_MAX = 3;
const UNIFIED_MASTER_NAME = "[통합] 주차 활동 내역";
const UNIFIED_LINE_MAIN_TITLE =
  "한 주 동안 클럽에서 진행한 중앙, 팀 활동 내역을 아우르는 통합 기록입니다. (26년 6월 이전)";
const ADMIN_ID = "c28b2409-4118-49fc-a42e-68e18dbd194c";
const REST_SEASON_KEY = "2026-spring"; // 사용자 확정 2026-06-18: 봄 시즌 휴식자로 복원

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

const normPhone = (s: unknown) => {
  const d = String(s ?? "").replace(/\D/g, "");
  return d.length >= 8 ? d.slice(-8) : "";
};
const normEmail = (s: unknown) => String(s ?? "").trim().toLowerCase();
const addDays = (iso: string, d: number) => {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
};
// YYMMDD(6) + YYYYMMDD(8, 예: #20 최서윤 20040601) 모두 처리 — 8자리 선처리 요구 반영.
function parseBirthIso(bd: unknown): string | null {
  const s = String(bd ?? "").replace(/\D/g, "");
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (s.length === 6) {
    const yy = Number(s.slice(0, 2));
    return `${yy <= 26 ? "20" : "19"}${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}`;
  }
  return null;
}

type LiveWeek = {
  id: string; season_key: string; week_number: number; start_date: string; end_date: string;
  iso_year: number | null; iso_week: number | null; check_threshold: number | null;
};
type ArchiveRow = {
  id: string; source_system: PmsSourceSystem; legacy_user_id: number; organization_slug: string;
  name: string; phone_last8: string | null; birthday: string | null; email: string | null;
  pms_state: string | null; identity_status: string | null; needs_review: boolean;
  matched_active_user_id: string | null; promotion_status: string;
};

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

// ─────────────────────────────────────────────────────────────────────
async function rollback(file: string) {
  const log = JSON.parse(readFileSync(file, "utf8"));
  const issues: string[] = [];
  const del = async (table: string, ids: string[]) => {
    for (let i = 0; i < ids.length; i += 100) {
      const { error } = await sb.from(table).delete().in("id", ids.slice(i, i + 100));
      if (error) issues.push(`${table} delete: ${error.message}`);
    }
  };
  for (const u of [...(log.applied ?? [])].reverse()) {
    await del("user_season_statuses", u.inserted?.seasonStatusIds ?? []);
    await del("cluster4_experience_line_evaluations", u.inserted?.evaluationIds ?? []);
    await del("cluster4_line_submissions", u.inserted?.submissionIds ?? []);
    await del("cluster4_line_targets", u.inserted?.targetIds ?? []);
    await del("user_week_statuses", u.inserted?.uwsIds ?? []);
    await del("user_weekly_points", u.inserted?.uwpIds ?? []);
    await del("legacy_point_ledger", u.inserted?.ledgerIds ?? []);
    // insert-only — 종속 + users 전부 삭제 (source_system NULL 복원 불필요).
    await del("user_educations", u.inserted?.educationIds ?? []);
    await del("user_memberships", u.inserted?.membershipIds ?? []);
    await del("cluster4_weekly_card_snapshots", []); // PK=user_id (id 아님) → 아래 별도 삭제
    {
      const { error } = await sb.from("cluster4_weekly_card_snapshots").delete().eq("user_id", u.uuid);
      if (error) issues.push(`snapshot delete ${u.uuid}: ${error.message}`);
      const { error: e2 } = await sb.from("cluster4_roster_card_stats").delete().eq("user_id", u.uuid);
      if (e2) issues.push(`roster_stats delete ${u.uuid}: ${e2.message}`);
      const { error: e3 } = await sb.from("user_growth_stats").delete().eq("user_id", u.uuid);
      if (e3) issues.push(`growth_stats delete ${u.uuid}: ${e3.message}`);
    }
    // user_profiles PK = user_id (NOT id). del 헬퍼는 id 기준이라 직접 삭제.
    //   (users 삭제가 CASCADE 로 user_profiles 도 정리하지만 명시 삭제로 이중 안전.)
    if ((u.inserted?.profileIds ?? []).length) {
      const { error: pe } = await sb.from("user_profiles").delete().in("user_id", u.inserted.profileIds);
      if (pe) issues.push(`user_profiles delete ${u.uuid}: ${pe.message}`);
    }
    const { error } = await sb.from("users").delete().eq("id", u.uuid);
    if (error) issues.push(`users delete ${u.uuid}: ${error.message}`);
    // archive 되돌리기
    if (u.archiveId) {
      const { error: ae } = await sb.from("legacy_pms_restuser_archive")
        .update({ promotion_status: "archived", promoted_user_id: null, promoted_at: null })
        .eq("id", u.archiveId);
      if (ae) issues.push(`archive revert ${u.archiveId}: ${ae.message}`);
    }
  }
  for (const l of log.insertedLines ?? []) {
    const { error } = await sb.from("cluster4_lines").delete().eq("id", l.id).eq("source_file_name", CREATED_BY);
    if (error) issues.push(`line delete ${l.id}: ${error.message}`);
  }
  writeFileSync(OUT, JSON.stringify({ mode: "rollback", source: file, issues }, null, 1));
  console.log(issues.length ? issues.join("\n") : "rollback 완료 (이슈 0)");
  process.exit(issues.length ? 1 : 0);
}

// ─────────────────────────────────────────────────────────────────────
async function main() {
  if (ROLLBACK_FILE) return rollback(ROLLBACK_FILE);

  const conn = await mysql.createConnection({
    host: envGet("MYSQL_HOST"), port: Number(envGet("MYSQL_PORT") ?? 3306),
    user: envGet("MYSQL_USER"), password: envGet("MYSQL_PASSWORD"),
    dateStrings: true, ssl: { rejectUnauthorized: false },
  });

  // ── 공유 데이터 ──
  const weeks = await fetchAllSb<LiveWeek>("weeks", "id,season_key,week_number,start_date,end_date,iso_year,iso_week,check_threshold", "start_date");
  const weekByRange = (d: string) => weeks.find((w) => d >= w.start_date && d <= w.end_date) ?? null;
  const orgThr = new Map<string, Map<string, number>>();
  for (const org of ["oranke", "encre", "phalanx"]) {
    const m = new Map<string, number>();
    for (const r of await fetchAllSb<{ week_id: string; check_threshold: number }>(
      "org_week_thresholds", "week_id,check_threshold", "week_id", (q) => q.eq("organization_slug", org))) m.set(r.week_id, r.check_threshold);
    orgThr.set(org, m);
  }
  const markers = new Set((await fetchAllSb<{ user_id: string }>("test_user_markers", "user_id", "user_id")).map((m) => m.user_id));
  const { data: master } = await sb.from("cluster4_experience_line_masters").select("id,line_code").eq("line_name", UNIFIED_MASTER_NAME).maybeSingle();
  if (!master) throw new Error("[통합] 마스터 부재");
  // 개설 라인 line_code = 공식 라인 코드(/admin/lines/info=line_registrations.line_code 우선,
  //   미연결 시 마스터 line_code). 과거의 주차 날짜형(EXBS-EN{YYMMDD}) 생성은 폐기 — 고객 표시용
  //   displayLineCode 와 정합(내부 임시 코드 비노출). org 토큰(BS) 보존 → org 판정 불변.
  const { data: unifiedReg } = await sb
    .from("line_registrations")
    .select("line_code")
    .eq("bridged_master_id", (master as any).id)
    .maybeSingle();
  const UNIFIED_OFFICIAL_LINE_CODE: string | null =
    (unifiedReg as { line_code: string } | null)?.line_code ??
    (master as { line_code: string | null }).line_code ??
    null;
  if (!UNIFIED_OFFICIAL_LINE_CODE) {
    throw new Error(
      "[통합] 공식 라인 코드 부재 — line_registrations.bridged_master_id 또는 마스터 line_code 필요(날짜형 생성 금지)",
    );
  }
  const unifiedLines = await fetchAllSb<{ id: string; week_id: string | null }>(
    "cluster4_lines", "id,week_id", "id",
    (q) => q.eq("experience_line_master_id", (master as any).id).eq("is_active", true));
  const lineByWeekId = new Map<string, string>();
  for (const l of unifiedLines) if (l.week_id) lineByWeekId.set(l.week_id, l.id);

  // 2026-spring 휴식행은 currentSeasonKey 와 일치해야 고객 파생 표시가 flip 된다(검증).
  if (!weeks.some((w) => w.season_key === REST_SEASON_KEY)) throw new Error(`weeks 에 ${REST_SEASON_KEY} 부재 — 휴식 시즌키 불일치`);

  // ── 타깃 = archive(promotion_status='archived') ──
  let targets = await fetchAllSb<ArchiveRow>(
    "legacy_pms_restuser_archive",
    "id,source_system,legacy_user_id,organization_slug,name,phone_last8,birthday,email,pms_state,identity_status,needs_review,matched_active_user_id,promotion_status",
    "name", (q) => q.eq("promotion_status", "archived"));
  if (ONLY_ORG) targets = targets.filter((t) => t.organization_slug === ONLY_ORG);
  if (ONLY_IDS) targets = targets.filter((t) => ONLY_IDS.includes(t.id));
  if (LIMIT != null) targets = targets.slice(0, LIMIT);
  console.log(`[promote-restusers] 타깃 ${targets.length} (mode=${MODE}${ONLY_ORG ? ` org=${ONLY_ORG}` : ""})`);

  // ── 사용자별 plan ──
  async function computePlan(a: ArchiveRow) {
    const src = a.source_system, uid = a.legacy_user_id;
    const org = resolveOrganizationSlug(src);
    const thrOf = (w: LiveWeek) => orgThr.get(org)!.get(w.id) ?? (w.check_threshold != null && w.check_threshold >= 0 ? w.check_threshold : DEFAULT_THRESHOLD);

    const [[pms]] = (await conn.query(
      `SELECT UserId, Name, CAST(BirthDay AS CHAR) AS BirthDay, Gender, School, Major, Address, Contact, mail FROM ${src}.users WHERE UserId=?`, [uid])) as any;
    const [[info]] = (await conn.query(
      `SELECT Team, Part, Week, Level, State, CAST(StartDate AS CHAR) AS StartDate FROM ${src}.usersinfo WHERE UserID=?`, [uid])) as any;
    const [[bal]] = (await conn.query(`SELECT Star, Shield FROM ${src}.userspoint WHERE UserID=?`, [uid])) as any;
    if (!pms) throw new Error(`${src}/${uid} ${a.name}: PMS users 행 부재 — archive 무결성 위반`);

    // 3중 키 매칭 — 강매칭 발견 시 insert-only 정책상 fail-closed(기존 active 보호)
    const birthIso = parseBirthIso(pms.BirthDay);
    const { data: nameMatches } = await sb.from("user_profiles")
      .select("user_id,display_name,birth_date,contact_phone,contact_email").eq("display_name", String(pms.Name));
    const pmsPhone = normPhone(pms.Contact), pmsEmail = normEmail(pms.mail);
    const strong = (nameMatches ?? []).filter((c: any) =>
      (birthIso != null && c.birth_date === birthIso) ||
      (pmsPhone !== "" && normPhone(c.contact_phone) === pmsPhone) ||
      (pmsEmail !== "" && normEmail(c.contact_email) === pmsEmail));
    if (strong.length >= 1)
      throw new Error(`${src}/${uid} ${a.name}: 기존 프로필 강매칭 ${strong.length}건(${strong.map((s: any) => s.user_id).join(",")}) — insert-only fail-closed (수동 검수 필요)`);
    // 페어 점유(이미 이관된 (source,uid)) 방어
    const { data: pairRows } = await sb.from("users").select("id").eq("source_system", src).eq("legacy_user_id", uid);
    if ((pairRows ?? []).length > 0) throw new Error(`${src}/${uid} ${a.name}: (source,legacy) 페어 이미 점유 — 재이관 차단`);

    const uuid = randomUUID();

    // pointlogs → ledger + uwp 집계
    const CORR = `CASE WHEN YEAR(ActivityTime) BETWEEN 20 AND 99 THEN DATE(ActivityTime + INTERVAL 2000 YEAR)
                       WHEN YEAR(ActivityTime)=1 THEN DATE(createtime) ELSE DATE(ActivityTime) END`;
    const [plogs] = (await conn.query(
      `SELECT LogNum, code, log, Info, Star, Shield, IsDeleted, CAST(ActivityTime AS CHAR) AS ActivityTime,
              CAST(createtime AS CHAR) AS createtime, CAST(${CORR} AS CHAR) AS corrected
       FROM ${src}.pointlogs WHERE UserID=? ORDER BY LogNum`, [uid])) as any;
    const startIso = String(info?.StartDate ?? "").slice(0, 10);
    const protectUntil = startIso >= "2020-01-01" ? addDays(startIso, 14) : "0000-00-00";
    type Agg = { points: number; adv: number; pen: number };
    const agg = new Map<string, Agg>();
    let unattributed = 0;
    for (const r of plogs) {
      const w = weekByRange(String(r.corrected));
      if (!w) { if ((r.Star ?? 0) !== 0 || (r.Shield ?? 0) !== 0) unattributed++; continue; }
      let ag = agg.get(w.id);
      if (!ag) { ag = { points: 0, adv: 0, pen: 0 }; agg.set(w.id, ag); }
      let star = Number(r.Star ?? 0);
      if (star < 0 && String(r.corrected) < protectUntil) star = 0;
      ag.points += star;
      const sh = Number(r.Shield ?? 0);
      if (r.IsDeleted === 0) { if (sh > 0) ag.adv += sh; else if (sh < 0) ag.pen += -sh; }
    }

    // activities → uws/경험
    type WP = { week: LiveWeek; recognized: boolean; rating: number | null; subtitle: string | null };
    const wp = new Map<string, WP>();
    for (const table of ["useractivities", "manageractivities"]) {
      const [rows] = (await conn.query(
        `SELECT ActivityId, Season, SeasonWeek, Star, IsActive, Activity, CAST(StartDate AS CHAR) AS StartDate,
                CAST(EndDate AS CHAR) AS EndDate FROM ${src}.${table} WHERE UserId=?`, [uid])) as any;
      for (const r of rows) {
        if (isExcludedPmsSeason(r.Season)) continue;
        const type = normalizePmsSeasonType(r.Season);
        const cands = type ? weeks.filter((w) => w.season_key.endsWith(`-${type}`) && w.week_number === r.SeasonWeek) : [];
        const dates = [r.StartDate, r.EndDate].filter(Boolean).map((d: string) => String(d).slice(0, 10));
        let w: LiveWeek | null = null;
        for (const c of cands) {
          const lo = addDays(c.start_date, -60), hi = addDays(c.end_date, 180);
          if (dates.some((d: string) => d >= lo && d <= hi)) { w = c; break; }
        }
        if (!w && dates.length) w = weekByRange(dates[0]) ?? (dates[1] ? weekByRange(dates[1]) : null);
        if (!w) continue;
        let v = wp.get(w.id);
        if (!v) { v = { week: w, recognized: false, rating: null, subtitle: null }; wp.set(w.id, v); }
        if (r.IsActive === 1) v.recognized = true;
        // rating 은 cluster4_experience_line_evaluations.rating CHECK(0~10) 준수 — PMS Star 는
        //   최대 100 까지 존재(데이터 스케일 상이) → [0,10] clamp. FLIP(>3) 판정엔 영향 없음.
        if (r.Star != null) { const cl = Math.max(0, Math.min(10, Number(r.Star))); if (v.rating == null || cl > v.rating) v.rating = cl; }
        const text = String(r.Activity ?? "").trim();
        if (text && (!v.subtitle || text.length > v.subtitle.length)) v.subtitle = text;
      }
    }

    // 판정 + FLIP + 행 계획 (insert-only — 기존 행 없음)
    let flips = 0;
    const uwsPlans: Array<{ week: LiveWeek; status: string }> = [];
    const expPlans: Array<{ week: LiveWeek; subtitle: string | null; rating: number | null }> = [];
    const flipWeekIds = new Set<string>();
    const ensureWeeks: LiveWeek[] = [];
    let restSeasonConflict = 0; // 휴식 시즌(2026-spring)에 활동 주차가 잡히면 경고
    for (const [, v] of wp) {
      const ag = agg.get(v.week.id) ?? { points: 0, adv: 0, pen: 0 };
      const status = v.recognized ? "success" : "fail";
      if (v.recognized) {
        const ratingOk = v.rating == null || v.rating > RATING_FAIL_MAX;
        if (!(ratingOk && ag.points >= thrOf(v.week))) { flips++; flipWeekIds.add(v.week.id); }
      }
      if (v.week.season_key === REST_SEASON_KEY) restSeasonConflict++;
      uwsPlans.push({ week: v.week, status });
      expPlans.push({ week: v.week, subtitle: v.subtitle, rating: v.rating });
      if (!lineByWeekId.has(v.week.id)) ensureWeeks.push(v.week);
    }
    const uwpPlans: Array<{ week: LiveWeek; agg: Agg; cm: boolean }> = [];
    for (const [wid, ag] of agg) {
      const w = weeks.find((x) => x.id === wid)!;
      uwpPlans.push({ week: w, agg: ag, cm: !flipWeekIds.has(wid) });
    }
    const sumP = [...agg.values()].reduce((s, ag) => s + ag.points, 0);
    const sumA = [...agg.values()].reduce((s, ag) => s + ag.adv, 0);
    const sumPen = [...agg.values()].reduce((s, ag) => s + ag.pen, 0);
    const starDelta = Number(bal?.Star ?? 0) - sumP;
    const shieldDelta = Number(bal?.Shield ?? 0) - (sumA - sumPen);

    const tp = mapUsersinfoTeamPart(info ?? { Team: null, Part: null });
    return {
      archiveId: a.id, src, uid, name: String(pms.Name), org, uuid, pms, info, bal, tp, birthIso,
      pmsState: a.pms_state, identityStatus: a.identity_status, needsReview: a.needs_review,
      ledgerRows: plogs.length, plogs,
      uwpPlans, uwsPlans, expPlans, flips, unattributed, ensureWeeks, restSeasonConflict,
      sentinel: { points: starDelta, advantages: Math.max(shieldDelta, 0), penalty: Math.max(-shieldDelta, 0) },
    };
  }
  type UserPlan = Awaited<ReturnType<typeof computePlan>>;

  const plans: UserPlan[] = [];
  const failed: Array<{ archiveId: string; name: string; error: string }> = [];
  for (const a of targets) {
    try {
      plans.push(await computePlan(a));
    } catch (e) {
      failed.push({ archiveId: a.id, name: a.name, error: e instanceof Error ? e.message : String(e) });
      console.error(`  ⚠ skip-plan ${a.source_system}/${a.legacy_user_id} ${a.name}: ${e instanceof Error ? e.message : e}`);
    }
  }
  await conn.end();

  const ensureWeekById = new Map<string, LiveWeek>();
  for (const x of plans) for (const w of x.ensureWeeks) ensureWeekById.set(w.id, w);

  const totals = {
    targets: targets.length,
    planned: plans.length,
    failedPlan: failed.length,
    usersInsert: plans.length,
    uwsInsert: plans.reduce((s, x) => s + x.uwsPlans.length, 0),
    uwpInsert: plans.reduce((s, x) => s + x.uwpPlans.length, 0),
    sentinel: plans.length,
    checksMigratedFalse: plans.reduce((s, x) => s + x.flips, 0),
    ledger: plans.reduce((s, x) => s + x.ledgerRows, 0) + plans.length,
    expEach: plans.reduce((s, x) => s + x.expPlans.length, 0),
    seasonStatusRest: plans.length,
    ensureLinesDistinct: ensureWeekById.size,
    unattributed: plans.reduce((s, x) => s + x.unattributed, 0),
    restSeasonConflicts: plans.reduce((s, x) => s + x.restSeasonConflict, 0),
    negativeSentinels: plans.filter((x) => x.sentinel.points < 0).length,
    pmsStateNon활동정지: plans.filter((x) => x.pmsState !== "활동정지").map((x) => `${x.src}/${x.uid} ${x.name}(${x.pmsState})`),
  };

  const perUser = plans.map((x) => ({
    archiveId: x.archiveId, source: x.src, pmsId: x.uid, name: x.name, org: x.org, uuid: x.uuid,
    pmsState: x.pmsState, identityStatus: x.identityStatus, needsReview: x.needsReview,
    team: x.tp.teamName, part: x.tp.partName, birthIso: x.birthIso,
    writes: { ledger: x.ledgerRows + 1, uwp: x.uwpPlans.length + 1, uws: x.uwsPlans.length, experience: x.expPlans.length, seasonRest: 1 },
    flips: x.flips, sentinel: x.sentinel, unattributedHold: x.unattributed, restSeasonConflict: x.restSeasonConflict,
  }));

  const conflictExcludedPreview = plans.filter((x) => x.restSeasonConflict > 0)
    .map((x) => `${x.src}/${x.uid} ${x.name} (봄 ${x.restSeasonConflict}주, uws ${x.uwsPlans.length})`);
  const report = {
    generatedAt: `${STAMP} ${CREATED_BY} ${MODE}`, mode: MODE,
    restSeasonKey: REST_SEASON_KEY, totals,
    conflictExcluded: conflictExcludedPreview,
    applyEligible: plans.length - conflictExcludedPreview.length,
    failedPlan: failed, perUser,
    ensureLinesPlan: [...ensureWeekById.values()].sort((a, b) => a.start_date.localeCompare(b.start_date)).map((w) => ({
      week_id: w.id, season_key: w.season_key, week_number: w.week_number, start_date: w.start_date,
    })),
  };
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ mode: MODE, totals }, null, 2));
  console.log("→", OUT);

  if (!APPLY) {
    console.log("preview 통과 — apply 가능 (이번 실행은 write 0)");
    return;
  }

  // ════════ APPLY ════════
  const appliedLog: any[] = [];
  const insertedLines: Array<{ id: string; week_id: string; start_date: string }> = [];
  const flushLog = () => writeFileSync(OUT, JSON.stringify({ ...report, insertedLines, applied: appliedLog }, null, 1));

  // 0) [통합] 라인 ensure
  for (const w of [...ensureWeekById.values()].sort((a, b) => a.start_date.localeCompare(b.start_date))) {
    if (lineByWeekId.has(w.id)) continue;
    // 공식 라인 코드 사용(날짜형 생성 폐기 — 고객 displayLineCode 와 정합). 같은 통합 마스터의
    //   주차별 라인은 동일 공식 코드를 공유한다(line_code 유니크 제약 없음·week_id 로 구분).
    const code = UNIFIED_OFFICIAL_LINE_CODE;
    const { data, error } = await sb.from("cluster4_lines").insert({
      part_type: "experience", main_title: UNIFIED_LINE_MAIN_TITLE,
      experience_line_master_id: (master as any).id, line_code: code, week_id: w.id,
      submission_opens_at: weekOpensAtIso(w.start_date), submission_closes_at: weekClosesAtIso(w.start_date),
      is_active: true, source_file_name: CREATED_BY, created_by: ADMIN_ID, updated_by: ADMIN_ID,
    }).select("id").single();
    if (error || !data) { console.error(`라인 ensure 실패(${w.start_date}): ${error?.message}`); flushLog(); process.exit(1); }
    lineByWeekId.set(w.id, (data as any).id);
    insertedLines.push({ id: (data as any).id, week_id: w.id, start_date: w.start_date });
    flushLog();
  }
  if (insertedLines.length) console.log(`[통합] 라인 ensure: ${insertedLines.length}개 생성`);

  const promotedIds: string[] = [];
  // 봄 활동주차 보유자(restSeasonConflict>0)는 "2026-spring 시즌휴식"과 의미 모순 → 자동 적용 제외.
  //   (휴식행 + 봄 success/fail uws 공존 방지. 운영자 별도 판단 대상.)
  const conflictExcluded = plans.filter((x) => x.restSeasonConflict > 0)
    .map((x) => `${x.src}/${x.uid} ${x.name} (봄 ${x.restSeasonConflict}주)`);
  const applyPlans = plans.filter((x) => x.restSeasonConflict === 0);
  if (conflictExcluded.length) {
    console.log(`⚠ restSeasonConflict 제외 ${conflictExcluded.length}명: ${conflictExcluded.join(", ")}`);
    (report as any).conflictExcluded = conflictExcluded;
  }
  for (const x of applyPlans) {
    const u: any = {
      archiveId: x.archiveId, uuid: x.uuid, name: x.name,
      inserted: { profileIds: [], membershipIds: [], educationIds: [], ledgerIds: [], uwpIds: [], uwsIds: [], targetIds: [], submissionIds: [], evaluationIds: [], seasonStatusIds: [] },
    };
    try {
      const nowIso = new Date().toISOString();
      // 1) users (insert-only)
      {
        const { error } = await sb.from("users").insert({ id: x.uuid, legacy_user_id: x.uid, source_system: x.src });
        if (error) throw new Error(`users insert: ${error.message}`);
      }
      // 2) profile / membership / education — status=active · growth_status=seasonal_rest (보존 정책)
      {
        const { error: pe } = await sb.from("user_profiles").insert({
          user_id: x.uuid, display_name: x.name, birth_date: x.birthIso, gender: x.pms.Gender ?? null,
          contact_phone: x.pms.Contact ?? null, contact_email: x.pms.mail ?? null,
          organization_slug: x.org, school_name: x.pms.School ?? null,
          current_team_name: x.tp.teamName, current_part_name: x.tp.partName,
          status: "active", growth_status: "seasonal_rest",
          activity_started_at: String(x.info?.StartDate ?? "").slice(0, 10) || null,
        });
        if (pe) throw new Error(`profile insert: ${pe.message}`);
        u.inserted.profileIds.push(x.uuid);
        const mid = randomUUID();
        const { error: me } = await sb.from("user_memberships").insert({
          id: mid, user_id: x.uuid, team_name: x.tp.teamName, part_name: x.tp.partName,
          membership_level: x.info?.Level ?? null, membership_state: "active", is_current: true,
        });
        if (me) throw new Error(`membership insert: ${me.message}`);
        u.inserted.membershipIds.push(mid);
        if (x.pms.School) {
          const eid = randomUUID();
          const { error: ee } = await sb.from("user_educations").insert({ id: eid, user_id: x.uuid, school_name: x.pms.School, major_name_1: x.pms.Major ?? null });
          if (ee) throw new Error(`education insert: ${ee.message}`);
          u.inserted.educationIds.push(eid);
        }
      }
      // 3) ledger (+adjustment) — 멱등 upsert
      const ledgerRows = x.plogs.map((r: any) => ({
        id: randomUUID(), source_table: ledgerSourceTable(x.src, "pointlogs"), source_pk: r.LogNum,
        user_id: x.uuid, legacy_user_id: x.uid, week_id: weekByRange(String(r.corrected))?.id ?? null,
        occurred_at: `${String(r.corrected)}T00:00:00Z`, code: String(r.code ?? ""), reason: String(r.log ?? ""),
        star: Number(r.Star ?? 0), shield: Number(r.Shield ?? 0),
        entry_type: r.IsDeleted === 1 ? "POINTLOG_VOIDED" : "POINTLOG",
        snapshot: r, payload: { Info: r.Info ?? null, IsDeleted: r.IsDeleted }, migrated_at: nowIso, created_by: CREATED_BY,
      }));
      ledgerRows.push({
        id: randomUUID(), source_table: ledgerSourceTable(x.src, "pointlogs"), source_pk: -x.uid,
        user_id: x.uuid, legacy_user_id: x.uid, week_id: null, occurred_at: nowIso, code: "ADJ",
        reason: "MIGRATION_ADJUSTMENT (컷오버 잔액 항등)", star: x.sentinel.points,
        shield: x.sentinel.advantages - x.sentinel.penalty, entry_type: "MIGRATION_ADJUSTMENT",
        snapshot: x.bal, payload: { sums: true }, migrated_at: nowIso, created_by: CREATED_BY,
      } as any);
      for (let i = 0; i < ledgerRows.length; i += 200) {
        const c = ledgerRows.slice(i, i + 200);
        const { data: insRows, error } = await sb.from("legacy_point_ledger")
          .upsert(c, { onConflict: "source_table,source_pk", ignoreDuplicates: true }).select("id");
        if (error) throw new Error(`ledger insert: ${error.message}`);
        u.inserted.ledgerIds.push(...((insRows ?? []) as Array<{ id: string }>).map((r) => r.id));
      }
      // 4) uwp (+sentinel)
      for (const r of x.uwpPlans) {
        const id = randomUUID();
        const { error } = await sb.from("user_weekly_points").insert({
          id, user_id: x.uuid, year: r.week.iso_year ?? Number(r.week.start_date.slice(0, 4)),
          week_number: r.week.iso_week ?? r.week.week_number, week_start_date: r.week.start_date,
          points: r.agg.points, advantages: r.agg.adv, penalty: r.agg.pen, checks_migrated: r.cm,
        });
        if (error) throw new Error(`uwp insert ${r.week.start_date}: ${error.message}`);
        u.inserted.uwpIds.push(id);
      }
      {
        const id = randomUUID();
        const { error } = await sb.from("user_weekly_points").insert({
          id, user_id: x.uuid, year: 1900, week_number: 1, week_start_date: "1900-01-01",
          points: x.sentinel.points, advantages: x.sentinel.advantages, penalty: x.sentinel.penalty, checks_migrated: false,
        });
        if (error) throw new Error(`sentinel insert: ${error.message}`);
        u.inserted.uwpIds.push(id);
      }
      // 5) uws
      for (const r of x.uwsPlans) {
        const id = randomUUID();
        const { error } = await sb.from("user_week_statuses").insert({
          id, user_id: x.uuid, year: r.week.iso_year ?? Number(r.week.start_date.slice(0, 4)),
          week_number: r.week.iso_week ?? r.week.week_number, week_start_date: r.week.start_date,
          status: r.status, season_key: r.week.season_key,
        });
        if (error) throw new Error(`uws insert ${r.week.start_date}: ${error.message}`);
        u.inserted.uwsIds.push(id);
      }
      // 6) 경험 (targets → submissions → evaluations) — 기존 행 보존, 부재분만 insert
      for (const r of x.expPlans) {
        const lineId = lineByWeekId.get(r.week.id);
        if (!lineId) throw new Error(`[통합] 라인 부재 ${r.week.start_date}`);
        const tid = randomUUID();
        const { error: te } = await sb.from("cluster4_line_targets").insert({
          id: tid, line_id: lineId, week_id: r.week.id, target_mode: "user", target_user_id: x.uuid, target_rule: {},
        });
        if (te) throw new Error(`target insert: ${te.message}`);
        u.inserted.targetIds.push(tid);
        const sid = randomUUID();
        const { error: se } = await sb.from("cluster4_line_submissions").insert({
          id: sid, line_target_id: tid, user_id: x.uuid, subtitle: r.subtitle ?? "주차 활동 내역(PMS 이관)",
          submitted_at: `${r.week.end_date}T22:59:59Z`, output_links: [], output_images: [], growth_point: null,
        });
        if (se) throw new Error(`submission insert: ${se.message}`);
        u.inserted.submissionIds.push(sid);
        if (r.rating != null) {
          const eid = randomUUID();
          const { error: ee } = await sb.from("cluster4_experience_line_evaluations").insert({
            id: eid, line_target_id: tid, user_id: x.uuid, rating: r.rating, evaluated_at: `${r.week.end_date}T23:00:00Z`,
          });
          if (ee) throw new Error(`evaluation insert: ${ee.message}`);
          u.inserted.evaluationIds.push(eid);
        }
      }
      // 7) user_season_statuses(2026-spring, rest) — 2-write 정합. 멱등.
      {
        const { data: exU } = await sb.from("user_season_statuses").select("id").eq("user_id", x.uuid).eq("season_key", REST_SEASON_KEY).maybeSingle();
        if (!exU) {
          const id = randomUUID();
          const { error } = await sb.from("user_season_statuses").insert({ id, user_id: x.uuid, season_key: REST_SEASON_KEY, status: "rest" });
          if (error) throw new Error(`season_status insert: ${error.message}`);
          u.inserted.seasonStatusIds.push(id);
        }
      }
      // 8) recalc + snapshot
      await recalcUserGrowthStats(x.uuid);
      await recomputeAndStoreWeeklyCardsSnapshot(x.uuid);
      // 9) archive 업데이트
      {
        const { error } = await sb.from("legacy_pms_restuser_archive")
          .update({ promotion_status: "promoted", promoted_user_id: x.uuid, promoted_at: nowIso })
          .eq("id", x.archiveId);
        if (error) throw new Error(`archive update: ${error.message}`);
      }
      u.ok = true;
      promotedIds.push(x.uuid);
      appliedLog.push(u);
      flushLog();
      console.log(`✔ ${x.src}/${x.uid} ${x.name} apply 완료`);
    } catch (e) {
      u.ok = false;
      u.error = e instanceof Error ? e.message : String(e);
      appliedLog.push(u);
      flushLog();
      console.error(`✖ ${x.src}/${x.uid} ${x.name} 실패 — 중단. rollback: --rollback ${OUT}`);
      process.exit(1);
    }
  }

  // 10) snapshot 보정 — per-user recomputeAndStoreWeeklyCardsSnapshot 가 이미 행을 실제 생성했다.
  //     대규모 배치 2중 recompute(시간 2배) 회피: 누락/stale 행만 골라 재계산(보통 0건, 자가치유).
  if (promotedIds.length) {
    const missingOrStale: string[] = [];
    for (let i = 0; i < promotedIds.length; i += 200) {
      const chunk = promotedIds.slice(i, i + 200);
      const { data: snaps } = await sb.from("cluster4_weekly_card_snapshots")
        .select("user_id,is_stale").in("user_id", chunk);
      const byId = new Map((snaps ?? []).map((s: any) => [s.user_id, s.is_stale]));
      for (const id of chunk) { const st = byId.get(id); if (st === undefined || st === true) missingOrStale.push(id); }
    }
    console.log(`snapshot 점검: ${promotedIds.length}명 중 누락/stale ${missingOrStale.length}명 보정`);
    if (missingOrStale.length) await recomputeWeeklyCardsSnapshotsForUsers(missingOrStale);
  }
  flushLog();
  console.log(`apply 완료 ${promotedIds.length}명 — rollback: npx tsx --env-file=.env.local scripts/promote-restusers.ts --rollback ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
