/**
 * olympus 38명 배치 PMS 이관 apply (preview 기본 · --apply · --rollback <runlog>).
 *   pilot-apply-5 의 검증된 computePlan/apply/rollback 계약을 source 단위 배치로 확장.
 *
 *   npx tsx --env-file=.env.local scripts/apply-pms-olympus-batch.ts            # preview (write 0)
 *   npx tsx --env-file=.env.local scripts/apply-pms-olympus-batch.ts --apply
 *   npx tsx --env-file=.env.local scripts/apply-pms-olympus-batch.ts --rollback <runlog.json>
 *
 * 대상 (2026-06-08): olympus State 일반/운영진(활동행 보유자) 38명 — 기이관(P3·P4·P5) migratedSkip,
 *   실제 작업 35명. 대상 동적 구성(dryrun-pms-active-286 과 동일 필터·정책 1/2 반영).
 *
 * 계약: B안 composite key(legacyIdentityFor) · 3중 키 매칭(빈 키 일치 금지) · PMS 인정 우선
 *   (FLIP 주차 uwp.checks_migrated=false) · org_week_thresholds 해석 · 숫자 단독 동일인 판단 금지 ·
 *   시즌 강화 정규화 + W0 제외 + 날짜 보조 귀속(lib/pmsSeasonAttribution).
 *
 * 안전 가드 (computePlan throw — 하나라도 걸리면 그 사용자에서 즉시 중단):
 *   - 모호 매칭(strong>1) · 테스터 매칭 · cross-source 2중 이관 · 페어 점유(비자기)
 *   (배치는 EXPECTED 고정 게이트 없음 — 인원·주차 가변. preview 집계로 검토 후 승인.)
 *
 * [통합] 라인 (2026-06-07 정책 확정 — 조사 반영):
 *   실사용자 PMS 활동은 전부 [통합] 주차 활동 내역 라인으로 이관. 라인 부재 주차는
 *   차단이 아니라 **ensure 생성** (v17·테스터 시드와 동일 규칙: week_id 직접 연결 ·
 *   line_code EXBS-EN{YYMMDD}(2026-06-07 접두어 정정 — 기존 UN 라인은 별도 rename) · opens/closes=주차 경계(KST) · 동일 main_title · is_active).
 *   기존 라인/타깃 수정 금지 — 부재분만 insert, insertedLines run log 기록(rollback 포함).
 *
 * sentinel (2026-06-07 보정): user_weekly_points_week_number_check CHECK(1~53) 때문에
 *   기존 설계(week_number=0) insert 불가 → **year=1900, week_number=1, week_start_date
 *   1900-01-01** 로 보정. weeks 에 1900 행이 없어 카드/판정 미소비는 동일하고, 이력서
 *   누적 포인트(uwp 전기간 합산)에는 포함(§5-2 잔액 항등 의도). points 음수 CHECK 없음 확인.
 *
 * apply 구조: P1→P5 순차, 사용자 단위 트랜잭션적 진행(실패 시 즉시 중단 — run log 의
 *   기록분만 --rollback 으로 역순 복구). 모든 write 의 prior 를 run log 에 기록.
 *   사용자별 순서: users → profiles/memberships/educations → ledger → uwp(+sentinel)
 *   → uws → 경험(targets→submissions→evaluations) → recalcUserGrowthStats → snapshot 재계산.
 *
 * rollback: run log 역순 — 경험/uws/uwp/ledger 신규 행 삭제·덮어쓰기 prior 복원,
 *   신규 users(+종속) 삭제. matched users 의 source_system NULL 복원은 불변 트리거가
 *   막으므로 수동 SQL 을 출력만 한다 (관리 SQL 경유 계약).
 */
import { readFileSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";
import { legacyIdentityFor, ledgerSourceTable, resolveOrganizationSlug, mapUsersinfoTeamPart, type PmsSourceSystem } from "@/lib/pmsMigration";
import { recalcUserGrowthStats } from "@/lib/userGrowthStatsData";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { isExcludedPmsSeason, normalizePmsSeasonType } from "@/lib/pmsSeasonAttribution";

const APPLY = process.argv.includes("--apply");
// --resume: 부분 적용 후 재개 — EXPECTED drift 는 기록만(차단 해제). 행 단위 멱등 가드 +
// 페어/테스터/모호/cross 안전 가드는 그대로 유지. (2026-06-07 P3 중단 재개용)
const RESUME = process.argv.includes("--resume");
const rbIdx = process.argv.indexOf("--rollback");
const ROLLBACK_FILE = rbIdx >= 0 ? process.argv[rbIdx + 1] : null;
const MODE = ROLLBACK_FILE ? "rollback" : APPLY ? "apply" : "preview";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = `claudedocs/olympus-batch-${MODE}-${STAMP}.json`;
const CREATED_BY = "olympus-batch-38";
const DEFAULT_THRESHOLD = 30;
const RATING_FAIL_MAX = 3;
const UNIFIED_MASTER_NAME = "[통합] 주차 활동 내역";
const BATCH_SOURCE: PmsSourceSystem = "olympus";

// PILOT 은 main() 에서 동적 구성 (olympus 활동행 보유 대상 − 기이관 페어).
let PILOT: Array<{ p: string; src: PmsSourceSystem; uid: number; name: string }> = [];

// 배치는 EXPECTED 고정 게이트 없음 (인원·주차 가변) — preview 집계 + computePlan 안전 가드로 검증.

// 라인 ensure payload 규칙 — apply-tester-summer-weeks.ts / v17 마이그레이션과 동일.
const UNIFIED_LINE_MAIN_TITLE =
  "한 주 동안 클럽에서 진행한 중앙, 팀 활동 내역을 아우르는 통합 기록입니다. (26년 6월 이전)";
const ADMIN_ID = "c28b2409-4118-49fc-a42e-68e18dbd194c"; // 시드와 동일 운영 계정
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

const normName = (s: unknown) => String(s ?? "").replace(/\s+/g, "").trim();
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
const SEASON_DICT = new Map([["봄", "spring"], ["여름", "summer"], ["가을", "autumn"], ["겨울", "winter"], ["거울", "winter"]]);
const normSeason = (s: unknown) => {
  let x = String(s ?? "").replace(/[\s\r\n ]+/g, "");
  if (x.endsWith("시즌")) x = x.slice(0, -2);
  return SEASON_DICT.get(x) ?? null;
};

type LiveWeek = {
  id: string; season_key: string; week_number: number; start_date: string; end_date: string;
  iso_year: number | null; iso_week: number | null; check_threshold: number | null;
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
  // 역순: 경험 → uws → uwp → ledger → 종속 → users
  for (const u of [...(log.applied ?? [])].reverse()) {
    await del("cluster4_experience_line_evaluations", u.inserted?.evaluationIds ?? []);
    await del("cluster4_line_submissions", u.inserted?.submissionIds ?? []);
    await del("cluster4_line_targets", u.inserted?.targetIds ?? []);
    for (const o of u.overwrites?.uws ?? []) {
      const { error } = await sb.from("user_week_statuses").update({ status: o.prior }).eq("id", o.id).eq("status", o.next);
      if (error) issues.push(`uws restore ${o.id}: ${error.message}`);
    }
    await del("user_week_statuses", u.inserted?.uwsIds ?? []);
    for (const o of u.overwrites?.uwp ?? []) {
      const { error } = await sb.from("user_weekly_points")
        .update({ points: o.prior.points, advantages: o.prior.advantages, penalty: o.prior.penalty, checks_migrated: o.prior.checks_migrated })
        .eq("id", o.id);
      if (error) issues.push(`uwp restore ${o.id}: ${error.message}`);
    }
    await del("user_weekly_points", u.inserted?.uwpIds ?? []);
    await del("legacy_point_ledger", u.inserted?.ledgerIds ?? []);
    if (u.usersAction === "insert") {
      await del("user_educations", u.inserted?.educationIds ?? []);
      await del("user_memberships", u.inserted?.membershipIds ?? []);
      await del("user_profiles", u.inserted?.profileIds ?? []);
      const { error } = await sb.from("users").delete().eq("id", u.uuid);
      if (error) issues.push(`users delete ${u.uuid}: ${error.message}`);
    } else {
      issues.push(`[수동 SQL 필요] ${u.uuid}: UPDATE public.users SET source_system=NULL${u.priorLegacy != null ? `, legacy_user_id=${u.priorLegacy}` : ""} WHERE id='${u.uuid}'; -- 불변 트리거 우회는 SQL Editor 에서`);
    }
    try {
      await recalcUserGrowthStats(u.uuid);
      if (u.usersAction !== "insert") await recomputeAndStoreWeeklyCardsSnapshot(u.uuid);
    } catch (e) {
      issues.push(`recalc/snapshot ${u.uuid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // ensure 생성한 [통합] 라인 — 타깃 삭제 후 마지막에 제거 (기존 라인은 절대 미접촉:
  // run log 의 insertedLines id 만, source_file_name 가드 동반).
  for (const l of log.insertedLines ?? []) {
    const { error } = await sb
      .from("cluster4_lines")
      .delete()
      .eq("id", l.id)
      .eq("source_file_name", CREATED_BY);
    if (error) issues.push(`line delete ${l.id}: ${error.message}`);
  }
  writeFileSync(OUT, JSON.stringify({ mode: "rollback", source: file, issues }, null, 1));
  console.log(issues.length ? issues.join("\n") : "rollback 완료 (이슈 0)");
  process.exit(issues.filter((i) => !i.startsWith("[수동 SQL")).length ? 1 : 0);
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
  // [통합] 마스터 + 주차별 라인 (line_code EXBS-UN{YYMMDD} ↔ 주차 시작일)
  const { data: master } = await sb.from("cluster4_experience_line_masters").select("id").eq("line_name", UNIFIED_MASTER_NAME).maybeSingle();
  if (!master) throw new Error("[통합] 마스터 부재");
  // 라인↔주차 매핑: cluster4_lines.week_id 직접 (line_code 파싱 폐기 — 2026-06-07 조사 반영).
  const unifiedLines = await fetchAllSb<{ id: string; week_id: string | null }>(
    "cluster4_lines", "id,week_id", "id",
    (q) => q.eq("experience_line_master_id", (master as any).id).eq("is_active", true));
  const lineByWeekId = new Map<string, string>();
  for (const l of unifiedLines) if (l.week_id) lineByWeekId.set(l.week_id, l.id);

  // ── 대상 동적 구성 (olympus 활동행 보유 − 기이관 페어 migratedSkip) ──
  const pairOccupied = new Set(
    (await fetchAllSb<{ legacy_user_id: number | null; source_system: string | null }>(
      "users", "legacy_user_id,source_system", "id"))
      .filter((u) => u.source_system === BATCH_SOURCE && u.legacy_user_id != null)
      .map((u) => u.legacy_user_id as number),
  );
  // 정책: State 일반/운영진 · 운영진=활동행 보유자만 (dryrun-pms-active-286 동일 필터).
  const [batchRows] = (await conn.query(`
    SELECT u.UserId, u.Name FROM ${BATCH_SOURCE}.users u JOIN ${BATCH_SOURCE}.usersinfo i ON i.UserID=u.UserId
    WHERE i.State IN ('일반','운영진')
      AND (i.State='일반'
           OR EXISTS (SELECT 1 FROM ${BATCH_SOURCE}.useractivities a WHERE a.UserId=u.UserId)
           OR EXISTS (SELECT 1 FROM ${BATCH_SOURCE}.manageractivities m WHERE m.UserId=u.UserId))
    ORDER BY u.UserId`)) as [any[], unknown];
  const migratedSkip: Array<{ uid: number; name: string }> = [];
  PILOT = [];
  let seq = 0;
  for (const r of batchRows) {
    const uid = Number(r.UserId);
    if (pairOccupied.has(uid)) { migratedSkip.push({ uid, name: String(r.Name) }); continue; }
    PILOT.push({ p: `O${++seq}`, src: BATCH_SOURCE, uid, name: String(r.Name) });
  }
  console.log(`[olympus batch] 대상 ${batchRows.length} | 기이관 skip ${migratedSkip.length} | 작업 ${PILOT.length}`);

  // ── 사용자별 plan 산출 ──
  type UserPlan = Awaited<ReturnType<typeof computePlan>>;
  async function computePlan(p: string, src: PmsSourceSystem, uid: number) {
    const identity = legacyIdentityFor(src, uid);
    const org = resolveOrganizationSlug(src);
    const thrOf = (w: LiveWeek) => orgThr.get(org)!.get(w.id) ?? (w.check_threshold != null && w.check_threshold >= 0 ? w.check_threshold : DEFAULT_THRESHOLD);

    const [[pms]] = (await conn.query(
      `SELECT UserId, Name, CAST(BirthDay AS CHAR) AS BirthDay, Gender, School, Major, Address, Contact, mail FROM ${src}.users WHERE UserId=?`, [uid])) as any;
    const [[info]] = (await conn.query(
      `SELECT Team, Part, Week, Level, State, CAST(StartDate AS CHAR) AS StartDate FROM ${src}.usersinfo WHERE UserID=?`, [uid])) as any;
    const [[bal]] = (await conn.query(`SELECT Star, Shield FROM ${src}.userspoint WHERE UserID=?`, [uid])) as any;
    if (info.State !== "일반" && info.State !== "운영진") throw new Error(`${p} State='${info.State}' — 대상 아님`);

    // 3중 키 매칭 (빈 키 일치 금지)
    const bd = String(pms.BirthDay ?? "");
    const birthIso = bd.length === 6 ? `${Number(bd.slice(0, 2)) <= 26 ? "20" : "19"}${bd.slice(0, 2)}-${bd.slice(2, 4)}-${bd.slice(4, 6)}` : null;
    const { data: nameMatches } = await sb.from("user_profiles")
      .select("user_id,display_name,birth_date,contact_phone,contact_email").eq("display_name", String(pms.Name));
    const pmsPhone = normPhone(pms.Contact), pmsEmail = normEmail(pms.mail);
    const strong = (nameMatches ?? []).filter((c: any) =>
      (birthIso != null && c.birth_date === birthIso) ||
      (pmsPhone !== "" && normPhone(c.contact_phone) === pmsPhone) ||
      (pmsEmail !== "" && normEmail(c.contact_email) === pmsEmail));
    if (strong.length > 1) throw new Error(`${p} 매칭 모호 (${strong.length}) — fail-closed`);
    const matched = strong.length === 1 ? (strong[0] as any) : null;
    if (matched && markers.has(matched.user_id)) throw new Error(`${p} 테스터 매칭 — fail-closed`);
    let matchedUsersRow: { legacy_user_id: number | null; source_system: string | null } | null = null;
    if (matched) {
      const { data: mu } = await sb.from("users").select("legacy_user_id,source_system").eq("id", matched.user_id).maybeSingle();
      matchedUsersRow = mu as any;
      if (matchedUsersRow?.source_system && matchedUsersRow.source_system !== src)
        throw new Error(`${p} 이미 source_system='${matchedUsersRow.source_system}' — 2중 이관 차단`);
    }
    const { data: pairRows } = await sb.from("users").select("id").eq("source_system", src).eq("legacy_user_id", uid);
    if ((pairRows ?? []).length > 0 && (!matched || (pairRows as any)[0].id !== matched.user_id))
      throw new Error(`${p} (${src},${uid}) 페어 이미 점유 — fail-closed`);

    // pointlogs → ledger + uwp 집계
    const CORR = `CASE WHEN YEAR(ActivityTime) BETWEEN 20 AND 99 THEN DATE(ActivityTime + INTERVAL 2000 YEAR)
                       WHEN YEAR(ActivityTime)=1 THEN DATE(createtime) ELSE DATE(ActivityTime) END`;
    const [plogs] = (await conn.query(
      `SELECT LogNum, code, log, Info, Star, Shield, IsDeleted, CAST(ActivityTime AS CHAR) AS ActivityTime,
              CAST(createtime AS CHAR) AS createtime, CAST(${CORR} AS CHAR) AS corrected
       FROM ${src}.pointlogs WHERE UserID=? ORDER BY LogNum`, [uid])) as any;
    const startIso = String(info.StartDate ?? "").slice(0, 10);
    const protectUntil = startIso >= "2020-01-01" ? addDays(startIso, 14) : "0000-00-00";
    type Agg = { points: number; adv: number; pen: number };
    const agg = new Map<string, Agg>();
    let unattributed = 0;
    for (const r of plogs) {
      const w = weekByRange(String(r.corrected));
      if (!w) { if ((r.Star ?? 0) !== 0 || (r.Shield ?? 0) !== 0) unattributed++; continue; }
      let a = agg.get(w.id);
      if (!a) { a = { points: 0, adv: 0, pen: 0 }; agg.set(w.id, a); }
      let star = Number(r.Star ?? 0);
      if (star < 0 && String(r.corrected) < protectUntil) star = 0;
      a.points += star;
      const sh = Number(r.Shield ?? 0);
      if (r.IsDeleted === 0) { if (sh > 0) a.adv += sh; else if (sh < 0) a.pen += -sh; }
    }

    // activities → uws/경험 계획
    type WP = { week: LiveWeek; recognized: boolean; rating: number | null; subtitle: string | null };
    const wp = new Map<string, WP>();
    for (const table of ["useractivities", "manageractivities"]) {
      const [rows] = (await conn.query(
        `SELECT ActivityId, Season, SeasonWeek, Star, IsActive, Activity, CAST(StartDate AS CHAR) AS StartDate,
                CAST(EndDate AS CHAR) AS EndDate FROM ${src}.${table} WHERE UserId=?`, [uid])) as any;
      for (const r of rows) {
        // (2026-06-07 강화) 제외(테스트/전환)→skip / 정규화 성공→시즌+주차+날짜창 / 실패→날짜 보조 귀속.
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
        if (r.Star != null && (v.rating == null || Number(r.Star) > v.rating)) v.rating = Number(r.Star);
        const text = String(r.Activity ?? "").trim();
        if (text && (!v.subtitle || text.length > v.subtitle.length)) v.subtitle = text;
      }
    }

    // 기존 uws/uwp (matched)
    const existingUws = new Map<string, { id: string; status: string }>();
    const existingUwp = new Map<string, { id: string; points: number; advantages: number; penalty: number; checks_migrated: boolean }>();
    if (matched) {
      for (const r of await fetchAllSb<any>("user_week_statuses", "id,week_start_date,status", "id", (q) => q.eq("user_id", matched.user_id)))
        existingUws.set(r.week_start_date, r);
      for (const r of await fetchAllSb<any>("user_weekly_points", "id,week_start_date,points,advantages,penalty,checks_migrated", "id", (q) => q.eq("user_id", matched.user_id)))
        existingUwp.set(r.week_start_date, r);
    }

    // 판정 + FLIP + 행 계획
    let flips = 0;
    const uwsPlans: Array<{ week: LiveWeek; status: string; prior?: { id: string; status: string } }> = [];
    const expPlans: Array<{ week: LiveWeek; subtitle: string | null; rating: number | null }> = [];
    const flipWeekIds = new Set<string>();
    const ensureWeeks: LiveWeek[] = []; // [통합] 라인 ensure 생성 예정 주차 (차단 아님)
    for (const [, v] of wp) {
      const a = agg.get(v.week.id) ?? { points: 0, adv: 0, pen: 0 };
      const status = v.recognized ? "success" : "fail";
      if (v.recognized) {
        const ratingOk = v.rating == null || v.rating > RATING_FAIL_MAX;
        if (!(ratingOk && a.points >= thrOf(v.week))) { flips++; flipWeekIds.add(v.week.id); }
      }
      const prior = existingUws.get(v.week.start_date);
      uwsPlans.push({ week: v.week, status, prior: prior && prior.status !== status ? prior : prior });
      expPlans.push({ week: v.week, subtitle: v.subtitle, rating: v.rating });
      if (!lineByWeekId.has(v.week.id)) ensureWeeks.push(v.week);
    }
    const uwpPlans: Array<{ week: LiveWeek; agg: Agg; cm: boolean; prior?: any }> = [];
    for (const [wid, a] of agg) {
      const w = weeks.find((x) => x.id === wid)!;
      uwpPlans.push({ week: w, agg: a, cm: !flipWeekIds.has(wid), prior: existingUwp.get(w.start_date) });
    }
    // adjustment sentinel
    const sumP = [...agg.values()].reduce((s, a) => s + a.points, 0);
    const sumA = [...agg.values()].reduce((s, a) => s + a.adv, 0);
    const sumPen = [...agg.values()].reduce((s, a) => s + a.pen, 0);
    const starDelta = Number(bal.Star) - sumP;
    const shieldDelta = Number(bal.Shield) - (sumA - sumPen);

    const { count: snapCount } = await sb.from("cluster4_weekly_card_snapshots").select("user_id", { count: "exact", head: true }).eq("user_id", matched?.user_id ?? "00000000-0000-0000-0000-000000000000");
    return {
      p, src, uid, name: String(pms.Name), org, identity,
      usersAction: matched ? ("update" as const) : ("insert" as const),
      uuid: matched?.user_id ?? randomUUID(),
      priorLegacy: matchedUsersRow?.legacy_user_id ?? null,
      legacyRewrite: matched != null && matchedUsersRow?.legacy_user_id !== uid,
      pms, info, bal,
      ledgerRows: plogs.length, plogs,
      uwpPlans, uwsPlans, expPlans, flips, unattributed, ensureWeeks,
      sentinel: { points: starDelta, advantages: Math.max(shieldDelta, 0), penalty: Math.max(-shieldDelta, 0) },
      snapshotAction: matched ? ((snapCount ?? 0) > 0 ? "recompute" : "new") : "new",
    };
  }

  const plans: UserPlan[] = [];
  for (const t of PILOT) {
    plans.push(await computePlan(t.p, t.src, t.uid));
    console.log(`  …plan ${t.p} ${t.src} ${t.uid} 완료`);
  }
  await conn.end();

  // ── 집계 + EXPECTED 게이트 ──
  const agg = {
    usersInsert: plans.filter((x) => x.usersAction === "insert").length,
    usersUpdate: plans.filter((x) => x.usersAction === "update").length,
    profilesInsert: plans.filter((x) => x.usersAction === "insert").length,
    uwsInsert: plans.reduce((s, x) => s + x.uwsPlans.filter((r) => !r.prior).length, 0),
    uwsOverwrite: plans.reduce((s, x) => s + x.uwsPlans.filter((r) => r.prior).length, 0),
    uwsConflicts: plans.reduce((s, x) => s + x.uwsPlans.filter((r) => r.prior && r.prior.status !== r.status).length, 0),
    uwpInsert: plans.reduce((s, x) => s + x.uwpPlans.filter((r) => !r.prior).length, 0),
    uwpOverwrite: plans.reduce((s, x) => s + x.uwpPlans.filter((r) => r.prior).length, 0),
    sentinel: plans.length,
    checksMigratedFalse: plans.reduce((s, x) => s + x.flips, 0),
    ledger: plans.reduce((s, x) => s + x.ledgerRows, 0) + plans.length, // +MIGRATION_ADJUSTMENT 5행
    expEach: plans.reduce((s, x) => s + x.expPlans.length, 0),
    snapshotNew: plans.filter((x) => x.snapshotAction === "new").length,
    snapshotRecompute: plans.filter((x) => x.snapshotAction === "recompute").length,
    ensureLinesUserWeeks: plans.reduce((s, x) => s + x.ensureWeeks.length, 0),
    ensureLinesDistinct: new Set(plans.flatMap((x) => x.ensureWeeks.map((w) => w.id))).size,
    unattributed: plans.reduce((s, x) => s + x.unattributed, 0),
    negativeSentinels: plans.filter((x) => x.sentinel.points < 0).length,
  };
  // ensure 대상 distinct 주차 (apply 시 생성 — 기존 라인/타깃 무수정·중복 생성 없음)
  const ensureWeekById = new Map<string, LiveWeek>();
  for (const x of plans) for (const w of x.ensureWeeks) ensureWeekById.set(w.id, w);
  // 배치는 EXPECTED 고정 게이트 없음 — 안전 가드(computePlan throw)가 이미 통과한 상태이므로
  // preview 는 항상 통과(blocked=false). 검토자가 집계/perUser 를 확인하고 --apply 승인.
  const drift: string[] = [];
  const blocked = false;

  const perUser = plans.map((x) => ({
    pilot: x.p, source: x.src, pmsId: x.uid, name: x.name,
    identity: x.identity, usersAction: x.usersAction, uuid: x.uuid,
    legacyRewrite: x.legacyRewrite ? `${x.priorLegacy}→${x.uid}` : null,
    writes: {
      ledger: x.ledgerRows + 1,
      uwp: { insert: x.uwpPlans.filter((r) => !r.prior).length, overwrite: x.uwpPlans.filter((r) => r.prior).length, sentinel: 1, cmFalse: x.flips },
      uws: { insert: x.uwsPlans.filter((r) => !r.prior).length, overwrite: x.uwsPlans.filter((r) => r.prior).length, conflicts: x.uwsPlans.filter((r) => r.prior && r.prior.status !== r.status).length },
      experience: x.expPlans.length,
      snapshot: x.snapshotAction,
    },
    sentinel: x.sentinel, unattributedHold: x.unattributed,
    ensureWeeks: x.ensureWeeks.map((w) => `${w.season_key} W${w.week_number} (${w.start_date})`),
  }));

  const report = {
    generatedAt: `2026-06-08 olympus-batch-38 ${MODE}`,
    mode: MODE, blocked, drift, migratedSkip, workCount: PILOT.length, totals: agg, perUser,
    ensureLinesPlan: [...ensureWeekById.values()]
      .sort((a, b) => a.start_date.localeCompare(b.start_date))
      .map((w) => ({
        week_id: w.id, season_key: w.season_key, week_number: w.week_number, start_date: w.start_date,
        line_code: `EXBS-EN${w.start_date.slice(2, 4)}${w.start_date.slice(5, 7)}${w.start_date.slice(8, 10)}`, // 2026-06-07 접두어 정정(UN→EN) — BS 토큰 유지로 org 판정 common 동일
        opens: weekOpensAtIso(w.start_date), closes: weekClosesAtIso(w.start_date),
      })),
    sentinelContract: "year=1900, week_number=1 (CHECK 1~53 보정), week_start_date=1900-01-01, checks_migrated=false — weeks 부재로 카드/판정 미소비·누적 포인트 합산 포함",
  };
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ mode: MODE, blocked, drift, totals: agg }, null, 2));
  for (const u of perUser) console.log(`${u.pilot} ${u.name}: ${u.usersAction}${u.legacyRewrite ? `(legacy ${u.legacyRewrite})` : ""} | ledger ${u.writes.ledger} uwp ${u.writes.uwp.insert}+${u.writes.uwp.overwrite}덮 uws ${u.writes.uws.insert}+${u.writes.uws.overwrite}덮(충돌${u.writes.uws.conflicts}) exp ${u.writes.experience} | sentinel ${JSON.stringify(u.sentinel)} | snapshot ${u.writes.snapshot} | 라인 ensure ${u.ensureWeeks.length}`);
  console.log("→", OUT);

  if (!APPLY) {
    if (blocked) { console.error("⚠ drift/차단 — apply 불가 상태"); process.exit(1); }
    console.log("preview 통과 — apply 가능 (이번 실행은 write 0)");
    return;
  }
  if (blocked) { console.error("fail-closed — apply 중단 (write 0)"); process.exit(1); }

  // ════════ APPLY (--apply 명시 시에만 도달) ════════
  const appliedLog: any[] = [];
  const insertedLines: Array<{ id: string; week_id: string; start_date: string; line_code: string }> = [];
  const flushLog = () => writeFileSync(OUT, JSON.stringify({ ...report, insertedLines, applied: appliedLog }, null, 1));

  // 0) [통합] 라인 ensure — distinct 부재 주차만 insert (기존 라인 무수정·중복 생성 없음:
  //    재조회 후 잔존 부재만, line_code/week_id 는 시드 규칙 동일).
  for (const w of [...ensureWeekById.values()].sort((a, b) => a.start_date.localeCompare(b.start_date))) {
    if (lineByWeekId.has(w.id)) continue; // 경합/재실행 멱등
    const code = `EXBS-EN${w.start_date.slice(2, 4)}${w.start_date.slice(5, 7)}${w.start_date.slice(8, 10)}`; // UN→EN 정정 (2026-06-07)
    const { data, error } = await sb
      .from("cluster4_lines")
      .insert({
        part_type: "experience",
        main_title: UNIFIED_LINE_MAIN_TITLE,
        experience_line_master_id: (master as any).id,
        line_code: code,
        week_id: w.id,
        submission_opens_at: weekOpensAtIso(w.start_date),
        submission_closes_at: weekClosesAtIso(w.start_date),
        is_active: true,
        source_file_name: CREATED_BY,
        created_by: ADMIN_ID,
        updated_by: ADMIN_ID,
      })
      .select("id")
      .single();
    if (error || !data) { console.error(`라인 ensure 실패(${w.start_date}): ${error?.message}`); flushLog(); process.exit(1); }
    lineByWeekId.set(w.id, (data as any).id);
    insertedLines.push({ id: (data as any).id, week_id: w.id, start_date: w.start_date, line_code: code });
    flushLog();
  }
  if (insertedLines.length) console.log(`[통합] 라인 ensure: ${insertedLines.length}개 생성`);
  for (const x of plans) {
    const u: any = {
      pilot: x.p, uuid: x.uuid, usersAction: x.usersAction, priorLegacy: x.priorLegacy,
      inserted: { profileIds: [], membershipIds: [], educationIds: [], ledgerIds: [], uwpIds: [], uwsIds: [], targetIds: [], submissionIds: [], evaluationIds: [] },
      overwrites: { uws: [], uwp: [] },
    };
    try {
      const nowIso = new Date().toISOString();
      // 1) users
      if (x.usersAction === "insert") {
        const { error } = await sb.from("users").insert({ id: x.uuid, legacy_user_id: x.uid, source_system: x.src });
        if (error) throw new Error(`users insert: ${error.message}`);
      } else {
        const patch: any = { source_system: x.src, updated_at: nowIso };
        if (x.legacyRewrite) patch.legacy_user_id = x.uid;
        const { error } = await sb.from("users").update(patch).eq("id", x.uuid).is("source_system", null);
        if (error) throw new Error(`users update: ${error.message}`);
      }
      // 2) profiles/memberships/educations (신규만)
      if (x.usersAction === "insert") {
        const tp = mapUsersinfoTeamPart(x.info);
        const bd = String(x.pms.BirthDay ?? "");
        const birthIso = bd.length === 6 ? `${Number(bd.slice(0, 2)) <= 26 ? "20" : "19"}${bd.slice(0, 2)}-${bd.slice(2, 4)}-${bd.slice(4, 6)}` : null;
        const { error: pe } = await sb.from("user_profiles").insert({
          user_id: x.uuid, display_name: x.name, birth_date: birthIso, gender: x.pms.Gender ?? null,
          contact_phone: x.pms.Contact ?? null, contact_email: x.pms.mail ?? null,
          organization_slug: x.org, school_name: x.pms.School ?? null,
          current_team_name: tp.teamName, current_part_name: tp.partName,
          activity_started_at: String(x.info.StartDate ?? "").slice(0, 10) || null,
        });
        if (pe) throw new Error(`profile insert: ${pe.message}`);
        u.inserted.profileIds.push(x.uuid);
        const mid = randomUUID();
        const { error: me } = await sb.from("user_memberships").insert({
          id: mid, user_id: x.uuid, team_name: tp.teamName, part_name: tp.partName,
          membership_level: x.info.Level ?? null, membership_state: "active", is_current: true,
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
      // 3) ledger (+adjustment)
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
        reason: "MIGRATION_ADJUSTMENT (§5-2 컷오버 잔액 항등)", star: x.sentinel.points,
        shield: x.sentinel.advantages - x.sentinel.penalty, entry_type: "MIGRATION_ADJUSTMENT",
        snapshot: x.bal, payload: { sums: true }, migrated_at: nowIso, created_by: CREATED_BY,
      } as any);
      for (let i = 0; i < ledgerRows.length; i += 200) {
        const c = ledgerRows.slice(i, i + 200);
        // 멱등: (source_table, source_pk) 기존 행은 보존(ignoreDuplicates) — 재실행 시 신규만 삽입.
        const { data: insRows, error } = await sb
          .from("legacy_point_ledger")
          .upsert(c, { onConflict: "source_table,source_pk", ignoreDuplicates: true })
          .select("id");
        if (error) throw new Error(`ledger insert: ${error.message}`);
        u.inserted.ledgerIds.push(...((insRows ?? []) as Array<{ id: string }>).map((r) => r.id));
      }
      // 4) uwp (+sentinel)
      for (const r of x.uwpPlans) {
        if (r.prior) {
          u.overwrites.uwp.push({ id: r.prior.id, prior: { points: r.prior.points, advantages: r.prior.advantages, penalty: r.prior.penalty, checks_migrated: r.prior.checks_migrated } });
          const { error } = await sb.from("user_weekly_points")
            .update({ points: r.agg.points, advantages: r.agg.adv, penalty: r.agg.pen, checks_migrated: r.cm, updated_at: nowIso }).eq("id", r.prior.id);
          if (error) throw new Error(`uwp update: ${error.message}`);
        } else {
          const id = randomUUID();
          const { error } = await sb.from("user_weekly_points").insert({
            id, user_id: x.uuid, year: r.week.iso_year ?? Number(r.week.start_date.slice(0, 4)),
            week_number: r.week.iso_week ?? r.week.week_number, week_start_date: r.week.start_date,
            points: r.agg.points, advantages: r.agg.adv, penalty: r.agg.pen, checks_migrated: r.cm,
          });
          if (error) throw new Error(`uwp insert ${r.week.start_date}: ${error.message}`);
          u.inserted.uwpIds.push(id);
        }
      }
      {
        // sentinel: week_number=1 (CHECK 1~53 보정 — 2026-06-07). weeks 1900 부재로 소비처 영향 0.
        // 멱등: 기존 (user, 1900-01-01) 행 존재 시 skip (재실행 보호).
        const { data: exS } = await sb
          .from("user_weekly_points").select("id").eq("user_id", x.uuid).eq("week_start_date", "1900-01-01").maybeSingle();
        if (!exS) {
          const id = randomUUID();
          const { error } = await sb.from("user_weekly_points").insert({
            id, user_id: x.uuid, year: 1900, week_number: 1, week_start_date: "1900-01-01",
            points: x.sentinel.points, advantages: x.sentinel.advantages, penalty: x.sentinel.penalty, checks_migrated: false,
          });
          if (error) throw new Error(`sentinel insert: ${error.message}`);
          u.inserted.uwpIds.push(id);
        }
      }
      // 5) uws
      for (const r of x.uwsPlans) {
        if (r.prior) {
          u.overwrites.uws.push({ id: r.prior.id, prior: r.prior.status, next: r.status });
          const { error } = await sb.from("user_week_statuses").update({ status: r.status, updated_at: nowIso }).eq("id", r.prior.id);
          if (error) throw new Error(`uws update: ${error.message}`);
        } else {
          const id = randomUUID();
          const { error } = await sb.from("user_week_statuses").insert({
            id, user_id: x.uuid, year: r.week.iso_year ?? Number(r.week.start_date.slice(0, 4)),
            week_number: r.week.iso_week ?? r.week.week_number, week_start_date: r.week.start_date,
            status: r.status, season_key: r.week.season_key,
          });
          if (error) throw new Error(`uws insert ${r.week.start_date}: ${error.message}`);
          u.inserted.uwsIds.push(id);
        }
      }
      // 6) 경험 (targets → submissions → evaluations)
      //    기존 행 재사용/보존 (2026-06-07 P3 결함 수정): matched 사용자의 기존 주차에는
      //    v17 마이그레이션이 만든 타깃/제출/평가가 이미 있다 (Vraxium-native=원본 정책).
      //    (target_user_id, week_id) 유니크 — 기존 타깃 재사용(rollback 비대상), 부재분만 insert.
      const planWeekIds = x.expPlans.map((r) => r.week.id);
      const existingTargetByWeek = new Map<string, string>();
      for (let i = 0; i < planWeekIds.length; i += 100) {
        const { data: exT } = await sb
          .from("cluster4_line_targets").select("id,week_id")
          .eq("target_user_id", x.uuid).in("week_id", planWeekIds.slice(i, i + 100));
        for (const t of (exT ?? []) as Array<{ id: string; week_id: string }>) existingTargetByWeek.set(t.week_id, t.id);
      }
      const existingSubTargets = new Set<string>();
      const existingEvalTargets = new Set<string>();
      {
        const tids = [...existingTargetByWeek.values()];
        for (let i = 0; i < tids.length; i += 100) {
          const { data: exS } = await sb.from("cluster4_line_submissions").select("line_target_id").in("line_target_id", tids.slice(i, i + 100));
          for (const s of (exS ?? []) as Array<{ line_target_id: string }>) existingSubTargets.add(s.line_target_id);
          const { data: exE } = await sb.from("cluster4_experience_line_evaluations").select("line_target_id").in("line_target_id", tids.slice(i, i + 100));
          for (const e of (exE ?? []) as Array<{ line_target_id: string }>) existingEvalTargets.add(e.line_target_id);
        }
      }
      u.reused = { targetIds: [] as string[], submissionsKept: 0, evaluationsKept: 0 };
      for (const r of x.expPlans) {
        const lineId = lineByWeekId.get(r.week.id);
        if (!lineId) throw new Error(`[통합] 라인 부재 ${r.week.start_date} — ensure 단계 누락 (불변식 위반)`);
        let tid = existingTargetByWeek.get(r.week.id) ?? null;
        if (tid) {
          u.reused.targetIds.push(tid); // 기존(원본) 재사용 — rollback 비대상
        } else {
          tid = randomUUID();
          const { error: te } = await sb.from("cluster4_line_targets").insert({
            id: tid, line_id: lineId, week_id: r.week.id, target_mode: "user", target_user_id: x.uuid, target_rule: {},
          });
          if (te) throw new Error(`target insert: ${te.message}`);
          u.inserted.targetIds.push(tid);
          existingTargetByWeek.set(r.week.id, tid);
        }
        if (existingSubTargets.has(tid)) {
          u.reused.submissionsKept++; // 기존 제출 보존 (Vraxium-native 원본 우선)
        } else {
          const sid = randomUUID();
          const { error: se } = await sb.from("cluster4_line_submissions").insert({
            id: sid, line_target_id: tid, user_id: x.uuid, subtitle: r.subtitle ?? "주차 활동 내역(PMS 이관)",
            submitted_at: `${r.week.end_date}T22:59:59Z`, output_links: [], output_images: [], growth_point: r.subtitle ?? null,
          });
          if (se) throw new Error(`submission insert: ${se.message}`);
          u.inserted.submissionIds.push(sid);
          existingSubTargets.add(tid);
        }
        if (r.rating != null) {
          if (existingEvalTargets.has(tid)) {
            u.reused.evaluationsKept++; // 기존 평가 보존
          } else {
            const eid = randomUUID();
            const { error: ee } = await sb.from("cluster4_experience_line_evaluations").insert({
              id: eid, line_target_id: tid, user_id: x.uuid, rating: r.rating, evaluated_at: `${r.week.end_date}T23:00:00Z`,
            });
            if (ee) throw new Error(`evaluation insert: ${ee.message}`);
            u.inserted.evaluationIds.push(eid);
            existingEvalTargets.add(tid);
          }
        }
      }
      // 7) recalc + snapshot
      await recalcUserGrowthStats(x.uuid);
      await recomputeAndStoreWeeklyCardsSnapshot(x.uuid);
      u.ok = true;
      appliedLog.push(u);
      flushLog();
      console.log(`✔ ${x.p} ${x.name} apply 완료`);
    } catch (e) {
      u.ok = false;
      u.error = e instanceof Error ? e.message : String(e);
      appliedLog.push(u);
      flushLog();
      console.error(`✖ ${x.p} ${x.name} 실패 — 중단. rollback: --rollback ${OUT}`);
      process.exit(1);
    }
  }
  flushLog();
  console.log(`apply 완료 — rollback: npx tsx --env-file=.env.local scripts/apply-pms-pilot-5.ts --rollback ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
