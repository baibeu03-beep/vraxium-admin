/**
 * §12 Dry Run — PMS 이관 전체 파이프라인 검증 (read-only, B안 composite key).
 *
 *   npx tsx --env-file=.env.local scripts/dryrun-pms-1092.ts                      # oranke 1092 (baseline)
 *   npx tsx --env-file=.env.local scripts/dryrun-pms-1092.ts --source hrdb --user 123
 *   npx tsx --env-file=.env.local scripts/dryrun-pms-1092.ts --source olympus --user 248
 *
 * (2026-06-07 B안 갱신 — 공통 이관 로더화) 3개 source system 공용:
 *   - 식별 = legacyIdentityFor(source, UserId) → (source_system, legacy_user_id) 복합키.
 *     offset 가산 전면 폐기 — legacy_user_id 는 PMS 원본 UserId 그대로.
 *   - 동일인 매칭 = 이름+생년월일+연락처 3중 키만 (숫자 단독 판단 금지 — FALSE_BRIDGE_NOTE).
 *   - 브리지 멱등 검증 = (source_system, legacy_user_id) 페어 점유 (uq_users_source_legacy).
 *     NULL-source 같은 숫자 행은 충돌 아님 — 정보성 병기.
 *   - 주차 기준값 = org_week_thresholds(소스 org) → weeks.check_threshold → 30 (라이브 해석).
 *
 * 계약: 실제 INSERT/UPDATE/DELETE 0건 — pms SELECT + Supabase select + direct/HTTP 비교만.
 *   snapshot-only·DTO/API 불변·checks_migrated 행 단위 플래그만 판정 SoT(크기/분포 추론 금지).
 *
 * 산출: claudedocs/dryrun-pms-{source}-{user}-20260607.json (oranke 1092 = 기존 경로 유지)
 *   ① 동일인 매칭 ② 프로필 매핑 diff ③ pointlogs→ledger 변환 계획 ④ uwp 생성 계획(§5-1)
 *   ⑤ uws 생성 계획 ⑥ checks_migrated 계획(+B8 PMS인정우선 옵션) ⑦ [통합] 실무 경험 계획(v17)
 *   ⑧ adjustment(§5-2) ⑨ snapshot 영향 ⑩ rollback 계획 + direct/HTTP baseline
 */
import { readFileSync, writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";
import {
  ledgerSourceTable,
  legacyIdentityFor,
  mapUsersinfoTeamPart,
  resolveOrganizationSlug,
  PMS_SOURCE_SYSTEMS,
  type PmsSourceSystem,
} from "@/lib/pmsMigration";
import { isExcludedPmsSeason, normalizePmsSeasonType } from "@/lib/pmsSeasonAttribution";

// CLI: --source oranke|hrdb|olympus (기본 oranke) · --user N (기본 1092)
const srcIdx = process.argv.indexOf("--source");
const usrIdx = process.argv.indexOf("--user");
const SOURCE_SYSTEM = (srcIdx >= 0 ? process.argv[srcIdx + 1] : "oranke") as PmsSourceSystem;
if (!(SOURCE_SYSTEM in PMS_SOURCE_SYSTEMS)) {
  console.error(`미등록 source system '${SOURCE_SYSTEM}'`);
  process.exit(1);
}
const PMS_USER_ID = usrIdx >= 0 ? Number(process.argv[usrIdx + 1]) : 1092;
const IDENTITY = legacyIdentityFor(SOURCE_SYSTEM, PMS_USER_ID); // fail-closed 가드 포함
const ORG_SLUG = resolveOrganizationSlug(SOURCE_SYSTEM);

const SUMMER_OVERLAY = process.argv.includes("--summer-pms-overlay");
if (SUMMER_OVERLAY && SOURCE_SYSTEM !== "oranke") {
  console.error("--summer-pms-overlay 는 oranke 전용 preview");
  process.exit(1);
}
const OUT = SUMMER_OVERLAY
  ? "claudedocs/dryrun-pms-1092-20260607-summer-overlay.json"
  : SOURCE_SYSTEM === "oranke" && PMS_USER_ID === 1092
    ? "claudedocs/dryrun-pms-1092-20260607.json"
    : `claudedocs/dryrun-pms-${SOURCE_SYSTEM}-${PMS_USER_ID}-20260607.json`;
const httpIdx = process.argv.indexOf("--http");
const ADMIN = httpIdx >= 0 ? process.argv[httpIdx + 1] : "http://localhost:3000";
const DEFAULT_THRESHOLD = 30;
const RATING_FAIL_MAX = 3;
const LEGACY_BOUNDARY = "2026-06-29"; // v17: 이 이전 시작 주차 = [통합] 라인 적용 범위 (≤ 2026 봄 W16)

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const report: Record<string, unknown> = {
  generatedAt: `2026-06-07 §12 dry-run (B안 composite key — ${SOURCE_SYSTEM} ${PMS_USER_ID})`,
  mode: "DRY-RUN — DB writes 0 (pms SELECT-only · supabase select-only)",
  sourceSystem: {
    source: SOURCE_SYSTEM,
    organizationSlug: ORG_SLUG,
    legacyIdentity: IDENTITY, // (source_system, legacy_user_id) — PMS 원본 보존
    offsetComparison: {
      deprecated_offsetPolicy:
        SOURCE_SYSTEM === "oranke"
          ? `${PMS_USER_ID} (offset 0 — B안과 동일 숫자)`
          : `${(SOURCE_SYSTEM === "hrdb" ? 10_000_000 : 20_000_000) + PMS_USER_ID} (구 offset 가산값 — 폐기)`,
      adopted_composite: `(${IDENTITY.sourceSystem}, ${IDENTITY.legacyUserId}) — 원본 보존`,
    },
    contract:
      "org=source system 매핑 단독 (usersinfo.Team 은 team_name 전용 — org 파생 금지) · 식별=(source_system, legacy_user_id) 복합키",
  },
};

// MYSQL_* 는 .env.local 직접 파싱 (--env-file 은 특수문자 비밀번호를 변형 — export-pms 스크립트와 동일 방식)
const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();

async function main() {
  const conn = await mysql.createConnection({
    host: envGet("MYSQL_HOST"),
    port: Number(envGet("MYSQL_PORT") ?? 3306),
    user: envGet("MYSQL_USER"),
    password: envGet("MYSQL_PASSWORD"),
    // B안 공통 로더: database 고정 대신 소스 스키마를 모든 쿼리에 명시 — 3소스 공용.
    dateStrings: true,
    ssl: { rejectUnauthorized: false },
  });
  const T = (table: string) => `${SOURCE_SYSTEM}.${table}`;

  // ════════ ① 동일인 매칭 (이름+생년월일+연락처 3중 키) ════════
  const [[pmsUser]] = (await conn.query(
    `SELECT UserId, Name, CAST(BirthDay AS CHAR) AS BirthDay, Gender, School, Major, Address, Contact, mail
     FROM ${T("users")} WHERE UserId = ?`,
    [PMS_USER_ID],
  )) as any;
  if (!pmsUser) throw new Error(`${SOURCE_SYSTEM} UserId ${PMS_USER_ID} 부재`);
  const [[pmsInfo]] = (await conn.query(
    `SELECT Team, Part, Week, Level, CAST(StartDate AS CHAR) AS StartDate, State FROM ${T("usersinfo")} WHERE UserID = ?`,
    [PMS_USER_ID],
  )) as any;
  const [[pmsPoint]] = (await conn.query(
    `SELECT Star, Shield FROM ${T("userspoint")} WHERE UserID = ?`,
    [PMS_USER_ID],
  )) as any;
  // BirthDay "980416" → 1998-04-16
  const bd = String(pmsUser.BirthDay ?? "");
  const birthIso =
    bd.length === 6 ? `${Number(bd.slice(0, 2)) <= 26 ? "20" : "19"}${bd.slice(0, 2)}-${bd.slice(2, 4)}-${bd.slice(4, 6)}` : null;

  const { data: nameMatches } = await sb
    .from("user_profiles")
    .select("user_id,display_name,birth_date,contact_phone,contact_email,organization_slug,status,growth_status,current_team_name,current_part_name,school_name,activity_started_at,role")
    .eq("display_name", pmsUser.Name);
  // 3중 키 비교 — 양쪽 모두 값이 있을 때만 일치 (null==null·""=="" 를 일치로 보지 않음:
  //   생일/연락처 누락 후보가 strong 에 끼어 단일 매칭을 모호로 만드는 버그 수정, 2026-06-07).
  const pmsPhoneDigits = String(pmsUser.Contact ?? "").replace(/\D/g, "");
  const pmsEmail = String(pmsUser.mail ?? "").trim().toLowerCase();
  const candidates = (nameMatches ?? []).map((p: any) => {
    const vPhone = String(p.contact_phone ?? "").replace(/\D/g, "");
    const vEmail = String(p.contact_email ?? "").trim().toLowerCase();
    return {
      ...p,
      birthMatch: birthIso != null && p.birth_date != null && p.birth_date === birthIso,
      phoneMatch: pmsPhoneDigits.length >= 8 && vPhone.length >= 8 && vPhone.slice(-8) === pmsPhoneDigits.slice(-8),
      emailMatch: pmsEmail !== "" && vEmail !== "" && vEmail === pmsEmail,
    };
  });
  const strong = candidates.filter((c) => c.birthMatch || c.phoneMatch || c.emailMatch);
  const matched = strong.length === 1 ? strong[0] : candidates.length === 1 ? candidates[0] : null;

  // ── 브리지 멱등 검증 (B안 composite key) ──
  //   페어 점유 = (source_system, legacy_user_id) — 기대: 이관 전 0행 / 재실행 시 자기 행 1.
  //   NULL-source 같은 숫자 행 = 충돌 아님 (uq_users_source_legacy 범위 밖) — 정보성 병기.
  const { data: pairRows } = await sb
    .from("users")
    .select("id,legacy_user_id,source_system")
    .eq("source_system", SOURCE_SYSTEM)
    .eq("legacy_user_id", PMS_USER_ID);
  const { data: nullSourceSameNumber } = await sb
    .from("users")
    .select("id,legacy_user_id,source_system")
    .is("source_system", null)
    .eq("legacy_user_id", PMS_USER_ID);
  // 테스터 오염 방지
  let isTester = false;
  let matchedUsersRow: { source_system: string | null; legacy_user_id: number | null } | null = null;
  if (matched) {
    const { data: tm } = await sb.from("test_user_markers").select("user_id").eq("user_id", matched.user_id).maybeSingle();
    isTester = Boolean(tm);
    const { data: mu } = await sb
      .from("users")
      .select("source_system,legacy_user_id")
      .eq("id", matched.user_id)
      .maybeSingle();
    matchedUsersRow = (mu as { source_system: string | null; legacy_user_id: number | null } | null) ?? null;
  }
  // 매칭 사용자가 이미 "다른 소스" 로 이관 기록된 경우 — 동일인 2중 이관 방지 fail-closed.
  if (matchedUsersRow?.source_system && matchedUsersRow.source_system !== SOURCE_SYSTEM) {
    throw new Error(
      `매칭 사용자 ${matched!.user_id} 는 이미 source_system='${matchedUsersRow.source_system}' 로 이관 기록됨 — 2중 이관 금지 (수동 검토)`,
    );
  }
  report.step1_matching = {
    pms: { ...pmsUser, birthIso },
    vraxiumCandidatesByName: candidates.length,
    candidates,
    matched: matched ? { userId: matched.user_id, keys: { birth: matched.birthMatch, phone: matched.phoneMatch, email: matched.emailMatch } } : null,
    matchedIsTester: isTester,
    matchedUsersRow,
    compositePairOccupied: pairRows ?? [], // 기대 0 (이관 전) — 멱등 재실행 시 자기 행
    nullSourceSameNumber_info: (nullSourceSameNumber ?? []).map((r: any) => r.id), // 충돌 아님 — 정보성
    plan: matched
      ? `기존 uuid ${matched.user_id} 사용 + users.(source_system='${SOURCE_SYSTEM}', legacy_user_id=${PMS_USER_ID}) 기록` +
        (matchedUsersRow?.legacy_user_id != null && matchedUsersRow.source_system == null
          ? ` — NULL-source 기존 행(legacy=${matchedUsersRow.legacy_user_id})에 source_system 최초 기록(불변 트리거 NULL→값 허용)`
          : " (신규 페어 점유)")
      : `Vraxium 부재 → 신규 채번 (users{uuid, source_system='${SOURCE_SYSTEM}', legacy_user_id=${PMS_USER_ID} 원본} + user_profiles{organization_slug='${ORG_SLUG}'})`,
  };
  if (isTester) throw new Error("매칭 대상이 테스터 — 중단");

  // ════════ ② 프로필 매핑 diff (기존 값 보존 + diff 리포트 원칙) ════════
  if (matched) {
    const diff: Record<string, { pms: unknown; vraxium: unknown }> = {};
    const cmp = (k: string, pv: unknown, vv: unknown) => {
      if ((pv ?? null) !== (vv ?? null)) diff[k] = { pms: pv ?? null, vraxium: vv ?? null };
    };
    cmp("birth_date", birthIso, matched.birth_date);
    cmp("contact_phone", String(pmsUser.Contact ?? ""), matched.contact_phone);
    cmp("contact_email", pmsUser.mail, matched.contact_email);
    cmp("school_name", pmsUser.School, matched.school_name);
    cmp("team", pmsInfo.Team, matched.current_team_name);
    cmp("part", pmsInfo.Part, matched.current_part_name);
    cmp("level", pmsInfo.Level, null); // membership_level 은 user_memberships — 아래 별도
    const { data: mem } = await sb
      .from("user_memberships")
      .select("team_name,part_name,membership_level,is_current")
      .eq("user_id", matched.user_id)
      .eq("is_current", true);
    report.step2_profileMapping = {
      policy: "운영 중 사용자 — 기존 Vraxium 값 보존 + diff 리포트 (§12-1)",
      diff,
      membershipCurrent: mem ?? [],
      pmsSnapshot: pmsInfo,
      writesPlanned: "users.legacy_user_id 기록 외 프로필 변경 없음 (diff 는 운영 검토용)",
    };
  } else {
    // 신규 채번 — organization_slug 는 source system 매핑 단독, Team/Part 는 team_name/part_name 패스스루
    const tp = mapUsersinfoTeamPart(pmsInfo);
    report.step2_profileMapping = {
      policy: "신규 채번 — organization_slug=source_system 매핑 (Team 으로 org 파생 금지)",
      organizationSlug: ORG_SLUG,
      teamName: tp.teamName,
      partName: tp.partName,
      membershipLevel: pmsInfo.Level,
      pmsSnapshot: pmsInfo,
      writesPlanned:
        `users(uuid 신규, source_system='${SOURCE_SYSTEM}', legacy_user_id=${PMS_USER_ID} 원본) · user_profiles(organization_slug='${ORG_SLUG}') · ` +
        `user_memberships(team_name='${tp.teamName}', part_name='${tp.partName}') · user_educations`,
    };
  }

  // ════════ 주차 차원 로드 (B7 적용 후 153행) ════════
  const weeks: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("weeks")
      .select("id,season_key,week_number,start_date,end_date,iso_year,iso_week,check_threshold,is_official_rest,result_published_at")
      .order("start_date")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    weeks.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }

  // ── --summer-pms-overlay: 2025-summer 를 pms 정본 W1~8 로 in-memory 치환한 preview ──
  // (apply-summer-pms-restore.ts 적용 후 상태의 사전 검증 — DB 무변경. W5~8 은 라이브 id 유지)
  if (SUMMER_OVERLAY) {
    const PLAN = [
      { week: 1, start: "2025-06-30", end: "2025-07-06", threshold: 24 },
      { week: 2, start: "2025-07-07", end: "2025-07-13", threshold: 24 },
      { week: 3, start: "2025-07-14", end: "2025-07-20", threshold: 34 },
      { week: 4, start: "2025-07-21", end: "2025-07-27", threshold: 34 },
      { week: 5, start: "2025-07-28", end: "2025-08-03", threshold: 37 },
      { week: 6, start: "2025-08-04", end: "2025-08-10", threshold: 37 },
      { week: 7, start: "2025-08-11", end: "2025-08-17", threshold: 35 },
      { week: 8, start: "2025-08-18", end: "2025-08-24", threshold: 37 },
    ];
    const liveSummer = new Map(
      weeks.filter((w) => w.season_key === "2025-summer").map((w) => [w.start_date, w]),
    );
    for (let i = weeks.length - 1; i >= 0; i--) if (weeks[i].season_key === "2025-summer") weeks.splice(i, 1);
    for (const p of PLAN) {
      const live = liveSummer.get(p.start);
      weeks.push({
        id: live?.id ?? `overlay-summer-w${p.week}`,
        season_key: "2025-summer",
        week_number: p.week,
        start_date: p.start,
        end_date: p.end,
        iso_year: live?.iso_year ?? null,
        iso_week: live?.iso_week ?? null,
        check_threshold: p.threshold,
        is_official_rest: false,
        result_published_at: null, // pms 미공표 정본
      });
    }
    weeks.sort((a, b) => a.start_date.localeCompare(b.start_date));
    report.summerOverlay = {
      mode: "preview — 2025-summer 를 pms 정본 W1~8 로 in-memory 치환 (DB 무변경)",
      plan: PLAN,
    };
    console.log("⚠ --summer-pms-overlay: 2025-summer pms 정본 W1~8 in-memory 치환 (preview)");
  }

  const weekByRange = (d: string) => weeks.find((w) => d >= w.start_date && d <= w.end_date) ?? null;

  // ════════ ③ pointlogs → legacy_point_ledger 변환 계획 ════════
  const CORR = `CASE WHEN YEAR(ActivityTime) BETWEEN 20 AND 99 THEN DATE(ActivityTime + INTERVAL 2000 YEAR)
                     WHEN YEAR(ActivityTime) = 1 THEN DATE(createtime) ELSE DATE(ActivityTime) END`;
  const [plogs] = (await conn.query(
    `SELECT LogNum, code, log, Info, Star, Shield, IsDeleted, IsHide,
            CAST(ActivityTime AS CHAR) AS ActivityTime, CAST(createtime AS CHAR) AS createtime,
            CAST(${CORR} AS CHAR) AS corrected
     FROM ${T("pointlogs")} WHERE UserID = ? ORDER BY LogNum`,
    [PMS_USER_ID],
  )) as any;
  report.step3_ledgerPlan = {
    ddlPrereq: "legacy_point_ledger DDL 적용 완료 (2026-06-07 확인 — UNIQUE(source_table, source_pk) arbiter 실증)",
    rowsToInsert: plogs.length,
    alive: plogs.filter((r: any) => r.IsDeleted === 0).length,
    deleted_voidedAt: plogs.filter((r: any) => r.IsDeleted === 1).length,
    code0000_included: plogs.filter((r: any) => r.code === "0000").length,
    starRows: plogs.filter((r: any) => (r.Star ?? 0) !== 0).length,
    shieldRows: plogs.filter((r: any) => (r.Shield ?? 0) !== 0).length,
    dateSubstituted: plogs.filter((r: any) => String(r.ActivityTime).startsWith("0001")).length,
    idempotencyKey: `(source_table='${ledgerSourceTable(SOURCE_SYSTEM, "pointlogs")}', source_pk=LogNum) UNIQUE — 소스 프리픽스로 시스템 간 PK 충돌 차단`,
    policy: "IsDeleted=1 포함 전 행 적재(voided_at 표시) — A3-⑤ alive 선별 금지",
  };

  // ════════ ④ uwp 생성 계획 (§5-1 확정식) ════════
  const startDateIso = String(pmsInfo.StartDate).slice(0, 10);
  const protectUntil = new Date(`${startDateIso}T00:00:00Z`);
  protectUntil.setUTCDate(protectUntil.getUTCDate() + 14);
  const protectUntilIso = protectUntil.toISOString().slice(0, 10);

  type Agg = { points: number; adv: number; pen: number; rows: number; protectedZeroed: number };
  const aggByWeekId = new Map<string, Agg>();
  let unattributedLogs = 0;
  for (const r of plogs) {
    const w = weekByRange(String(r.corrected));
    if (!w) {
      if ((r.Star ?? 0) !== 0 || (r.Shield ?? 0) !== 0) unattributedLogs++;
      continue;
    }
    let a = aggByWeekId.get(w.id);
    if (!a) {
      a = { points: 0, adv: 0, pen: 0, rows: 0, protectedZeroed: 0 };
      aggByWeekId.set(w.id, a);
    }
    a.rows++;
    let star = Number(r.Star ?? 0);
    if (star < 0 && String(r.corrected) < protectUntilIso) {
      a.protectedZeroed++;
      star = 0; // 신입 14일 보호 (A3-⑥) — ledger 원본 보존, 집계만 0
    }
    a.points += star; // net_all (IsDeleted 무관, A3-④⑤)
    const shield = Number(r.Shield ?? 0);
    if (r.IsDeleted === 0) {
      // Shield 는 alive-only (A2 원인③)
      if (shield > 0) a.adv += shield;
      else if (shield < 0) a.pen += -shield;
    }
  }

  // ════════ ⑤ uws 생성 계획 (useractivities IsActive SoT + manageractivities 병기) ════════
  async function pullActs(table: string) {
    const [rows] = (await conn.query(
      `SELECT ActivityId, Season, SeasonWeek, Star, IsActive, Activity,
              CAST(StartDate AS CHAR) AS StartDate, CAST(EndDate AS CHAR) AS EndDate
       FROM ${T(table)} WHERE UserId = ?`,
      [PMS_USER_ID],
    )) as any;
    return rows;
  }
  const ua = await pullActs("useractivities");
  const ma = await pullActs("manageractivities");
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
  // (2026-06-07 강화) 제외(테스트/전환) → null / 정규화 성공 → 시즌+주차+날짜창 /
  // 실패·창 불일치 → StartDate 날짜 기반 보조 귀속 (lib/pmsSeasonAttribution).
  let actExcluded = 0, actDateFallback = 0;
  const attributeAct = (r: any) => {
    if (isExcludedPmsSeason(r.Season)) { actExcluded++; return null; }
    const type = normalizePmsSeasonType(r.Season);
    const cands = type ? weeks.filter((w) => w.season_key.endsWith(`-${type}`) && w.week_number === r.SeasonWeek) : [];
    const dates = [r.StartDate, r.EndDate].filter(Boolean).map((d: string) => String(d).slice(0, 10));
    for (const w of cands) {
      const lo = addDays(w.start_date, -60), hi = addDays(w.end_date, 180);
      if (dates.some((d: string) => d >= lo && d <= hi)) return w;
    }
    if (dates.length) {
      const w = weekByRange(dates[0]) ?? (dates[1] ? weekByRange(dates[1]) : null);
      if (w) { actDateFallback++; return w; }
    }
    return null;
  };
  type WeekPlan = {
    week: any;
    uaActive: number; uaFail: number; maActive: number; maFail: number;
    rating: number | null; subtitle: string | null; multiRows: number;
  };
  const planByWeekId = new Map<string, WeekPlan>();
  let actUnattributed = 0;
  const fold = (r: any, src: "ua" | "ma") => {
    const w = attributeAct(r);
    if (!w) { actUnattributed++; return; }
    let p = planByWeekId.get(w.id);
    if (!p) {
      p = { week: w, uaActive: 0, uaFail: 0, maActive: 0, maFail: 0, rating: null, subtitle: null, multiRows: 0 };
      planByWeekId.set(w.id, p);
    }
    p.multiRows++;
    if (src === "ua") r.IsActive === 1 ? p.uaActive++ : p.uaFail++;
    else r.IsActive === 1 ? p.maActive++ : p.maFail++;
    if (r.Star != null && (p.rating == null || Number(r.Star) > p.rating)) p.rating = Number(r.Star);
    const text = String(r.Activity ?? "").trim();
    if (text && (!p.subtitle || text.length > p.subtitle.length)) p.subtitle = text;
  };
  for (const r of ua) fold(r, "ua");
  for (const r of ma) fold(r, "ma");

  // 기존 Vraxium uws/uwp (매칭 사용자)
  let existingUws: any[] = [], existingUwp: any[] = [];
  if (matched) {
    const { data: e1 } = await sb.from("user_week_statuses").select("week_start_date,status,year,week_number").eq("user_id", matched.user_id);
    existingUws = e1 ?? [];
    const { data: e2 } = await sb.from("user_weekly_points").select("week_start_date,year,week_number,points,advantages,penalty,checks_migrated").eq("user_id", matched.user_id);
    existingUwp = e2 ?? [];
  }
  const existingUwsByStart = new Map(existingUws.map((r) => [r.week_start_date, r]));
  const existingUwpByStart = new Map(existingUwp.map((r) => [r.week_start_date, r]));

  // ════════ ⑥ 판정 + checks_migrated 계획 + flip ════════
  // 기준값 해석 (2026-06-07 B안·org_week_thresholds): org행(소스 org) → weeks.check_threshold → 30.
  // 라이브 판정 경로(fetchLegacyUnifiedExperienceByWeek)와 동일 해석 — 이관 후 화면=계획 일치 보장.
  const orgThrByWeekId = new Map<string, number>();
  {
    const { data: orgRows, error: orgErr } = await sb
      .from("org_week_thresholds")
      .select("week_id,check_threshold")
      .eq("organization_slug", ORG_SLUG)
      .order("week_id", { ascending: true })
      .range(0, 4999);
    if (orgErr) throw new Error(`org_week_thresholds: ${orgErr.message}`);
    for (const r of (orgRows ?? []) as { week_id: string; check_threshold: number }[]) {
      orgThrByWeekId.set(r.week_id, r.check_threshold);
    }
  }
  let thrFromOrg = 0, thrFromWeeks = 0, thrFromDefault = 0;
  const weekRows: any[] = [];
  let flips = 0, agree = 0, reverse = 0;
  const uwpPlanWeekIds = new Set<string>([...aggByWeekId.keys(), ...planByWeekId.keys()]);
  for (const wid of uwpPlanWeekIds) {
    const p = planByWeekId.get(wid) ?? null;
    const w = p?.week ?? weeks.find((x) => x.id === wid);
    const a = aggByWeekId.get(wid) ?? { points: 0, adv: 0, pen: 0, rows: 0, protectedZeroed: 0 };
    const orgThr = orgThrByWeekId.get(wid);
    const thr =
      orgThr != null && orgThr >= 0
        ? (thrFromOrg++, orgThr)
        : w.check_threshold != null && w.check_threshold >= 0
          ? (thrFromWeeks++, w.check_threshold)
          : (thrFromDefault++, DEFAULT_THRESHOLD);
    const pmsRecognized = p ? p.uaActive > 0 || p.maActive > 0 : null; // 활동 행 없으면 uws 미생성
    const ratingOk = p ? p.rating == null || p.rating > RATING_FAIL_MAX : null;
    const v18 = p ? Boolean(ratingOk) && a.points >= thr : null;
    let verdictDiff: string | null = null;
    if (pmsRecognized === true && v18 === false) { flips++; verdictDiff = "FLIP(pms 인정→v18 fail)"; }
    else if (pmsRecognized === false && v18 === true) { reverse++; verdictDiff = "역방향(pms fail→v18 pass — 게이트는 승격 없음·표시 영향 없음)"; }
    else if (pmsRecognized != null) agree++;
    const exUws = existingUwsByStart.get(w.start_date) ?? null;
    const exUwp = existingUwpByStart.get(w.start_date) ?? null;
    weekRows.push({
      week: `${w.season_key} W${w.week_number}`,
      start: w.start_date,
      threshold: thr,
      published: w.result_published_at != null,
      isOfficialRest: w.is_official_rest,
      uwp: { points: a.points, advantages: a.adv, penalty: a.pen, logRows: a.rows, protectedZeroed: a.protectedZeroed },
      uws: p ? { status: p.uaActive > 0 || p.maActive > 0 ? "success" : "fail", rating: p.rating, actRows: p.multiRows, uaActive: p.uaActive, maActive: p.maActive } : null,
      v18: p ? { ratingOk, checkPass: a.points >= thr, success: v18 } : null,
      verdictDiff,
      existing: { uws: exUws ? exUws.status : null, uwp: exUwp ? { points: exUwp.points, checks_migrated: exUwp.checks_migrated } : null },
    });
  }
  weekRows.sort((x, y) => x.start.localeCompare(y.start));

  const uwpInserts = weekRows.filter((r) => !r.existing.uwp).length;
  const uwpOverwrites = weekRows.filter((r) => r.existing.uwp).length;
  const uwsInserts = weekRows.filter((r) => r.uws && !r.existing.uws).length;
  const uwsOverwrites = weekRows.filter((r) => r.uws && r.existing.uws).length;
  const uwsConflicts = weekRows.filter((r) => r.uws && r.existing.uws && r.existing.uws !== r.uws.status);

  report.step4_uwpPlan = {
    formula: "§5-1: points=Σ Star(net_all, 14일 보호) / advantages=Σ max(Shield,0) alive / penalty=Σ max(−Shield,0) alive",
    newbieProtection: { startDate: startDateIso, until: protectUntilIso, zeroedRows: weekRows.reduce((s, r) => s + r.uwp.protectedZeroed, 0) },
    rowsPlanned: uwpPlanWeekIds.size,
    inserts: uwpInserts,
    overwritesExisting_dummyPerOps: uwpOverwrites,
    zeroPointWeeksIncluded: weekRows.filter((r) => r.uwp.logRows === 0).length,
    unattributedPointlogRows_holdQueue: unattributedLogs,
  };
  report.step5_uwsPlan = {
    source: "useractivities.IsActive SoT (A3-⑧) + manageractivities 병기 — OR 인정",
    rowsPlanned: weekRows.filter((r) => r.uws).length,
    inserts: uwsInserts,
    overwrites_existingDummyPerOps: uwsOverwrites,
    statusConflicts: uwsConflicts.map((r) => ({ week: r.week, existing: r.existing.uws, plan: r.uws.status })),
    actUnattributed_holdQueue: actUnattributed,
    actExcluded_testTransition: actExcluded,
    actDateFallbackAttributed: actDateFallback,
    postWriteContract: "uws 쓰기 → recalcUserGrowthStats(전환 제외) → snapshot 재계산 (파이프라인 순서 강제)",
  };
  report.step6_checksMigratedPlan = {
    thresholdResolution: {
      contract: `org_week_thresholds('${ORG_SLUG}') → weeks.check_threshold → ${DEFAULT_THRESHOLD} (라이브 판정 경로와 동일)`,
      fromOrgRow: thrFromOrg,
      fromWeeksColumn: thrFromWeeks,
      fromDefault: thrFromDefault,
    },
    base: "생성 uwp 전 행 checks_migrated=true (0건 주차 포함 — v18 행 기록 계약)",
    flipRows: weekRows.filter((r) => r.verdictDiff?.startsWith("FLIP")),
    flips,
    agree,
    reverse,
    policyOptions: {
      pmsFirst_recommended: `flip ${flips}행만 checks_migrated=false (행 단위 provenance — 화면 뒤집힘 0)`,
      failAccept: `flip ${flips}행 read-time fail 표시 (uws 는 success 유지 — 표시 누적만 감소)`,
    },
  };

  // ════════ ⑦ [통합] 실무 경험 계획 (v17) ════════
  const expWeeks = weekRows.filter((r) => r.uws && r.start < LEGACY_BOUNDARY);
  report.step7_experiencePlan = {
    boundary: `start_date < ${LEGACY_BOUNDARY} (= 2026 봄 W16 까지 — 전 활동 주차 해당)`,
    mapping: "subtitle=Activity 원문(cluster4_line_submissions) / rating=Star(cluster4_experience_line_evaluations) / week 귀속=타깃.week_id",
    lineRowsToCreate: 0,
    lineReuse: "기존 active [통합] 마스터/라인 재사용 — 신규 라인 생성 금지 (v17·B7 dry-run tempLineRestorability 계약)",
    targetsToCreate: expWeeks.length,
    submissionsToCreate: expWeeks.filter((r) => weekRows.find((x) => x.start === r.start)).filter((r) => (planByWeekId.get(weeks.find((w) => w.start_date === r.start)?.id)?.subtitle ?? null) != null).length,
    evaluationsToCreate: expWeeks.filter((r) => r.uws.rating != null).length,
    subtitleMissing: expWeeks.filter((r) => (planByWeekId.get(weeks.find((w) => w.start_date === r.start)?.id)?.subtitle ?? null) == null).length,
    multiActivityWeeks: weekRows.filter((r) => r.uws && r.uws.actRows > 1).length,
  };

  // ════════ ⑧ adjustment (§5-2) — 컷오버 시점(=지금) 재계산 ════════
  const sumPoints = weekRows.reduce((s, r) => s + r.uwp.points, 0);
  const sumAdv = weekRows.reduce((s, r) => s + r.uwp.advantages, 0);
  const sumPen = weekRows.reduce((s, r) => s + r.uwp.penalty, 0);
  const starDelta = Number(pmsPoint.Star) - sumPoints;
  const shieldD = Number(pmsPoint.Shield) - (sumAdv - sumPen);
  report.step8_adjustment = {
    balanceNow: { star: pmsPoint.Star, shield: pmsPoint.Shield },
    weeklySums: { points: sumPoints, advantages: sumAdv, penalty: sumPen, advMinusPen: sumAdv - sumPen },
    unattributedNote: `미귀속 pointlogs ${unattributedLogs}행의 Star/Shield 는 주차 행에 없으므로 adjustment 가 흡수`,
    sentinelRow: {
      key: "year=1900, week_number=0, week_start_date=1900-01-01, checks_migrated=false",
      points: starDelta,
      advantages: Math.max(shieldD, 0),
      penalty: Math.max(-shieldD, 0),
    },
    ledgerRow: { entry_type: "MIGRATION_ADJUSTMENT", star_delta: starDelta, shield_delta: shieldD },
    identity: "적용 후 Σuwp.points = userspoint.Star / Σ(adv−pen) = userspoint.Shield (항등식 자동 성립)",
    caution: "본 수치는 오늘 잔액 기준 — 실제 apply 시 컷오버 직전 재계산 필수 (§5-2)",
  };

  // ════════ ⑨ snapshot 영향 + 검증 baseline (direct vs HTTP) ════════
  let snapshotInfo: Record<string, unknown> = { exists: false };
  let directHttp: Record<string, unknown> = { skipped: "매칭 사용자 없음" };
  if (matched) {
    const { data: snap } = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("dto_version,is_stale,computed_at,cards")
      .eq("user_id", matched.user_id)
      .maybeSingle();
    const snapCards = (snap as any)?.cards as Cluster4WeeklyCardDto[] | undefined;
    snapshotInfo = {
      exists: Boolean(snap),
      dto_version: (snap as any)?.dto_version ?? null,
      is_stale: (snap as any)?.is_stale ?? null,
      cardsNow: snapCards?.length ?? 0,
      cardsAfterMigration_expected: weekRows.filter((r) => r.uws).length,
      recomputeRequired: "필수 — 원장 직접 수정은 자동 무효화 안 됨 (uws/uwp 대량 쓰기 후 명시 재계산, 파이프라인 7단계)",
      sentinelLeak: "1900-W0 는 weeks 부재 → 카드 미생성 (§5-2 소비처 검증 완료 계약)",
    };

    // direct vs HTTP (현재 상태 baseline — dry-run 이므로 데이터 무변경 상태의 양 경로 동일성 실증)
    const direct = await getCluster4WeeklyCardsForProfileUser(matched.user_id);
    const res = await fetch(`${ADMIN}/api/cluster4/weekly-cards?userId=${matched.user_id}`, {
      headers: { "x-internal-api-key": process.env.INTERNAL_API_KEY ?? "" },
    });
    const http = res.ok ? (((await res.json()).data ?? []) as Cluster4WeeklyCardDto[]) : null;
    // snapshot JSONB 왕복은 객체 키 순서를 보존하지 않음 — 키 정렬 canonical 비교 (false positive 방지).
    const canon = (v: unknown): string =>
      JSON.stringify(v, (_k, val) =>
        val && typeof val === "object" && !Array.isArray(val)
          ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1)))
          : val,
      );
    let diffs = 0;
    const diffWeeks: string[] = [];
    if (http) {
      for (let i = 0; i < Math.max(direct.length, http.length); i++) {
        if (canon(direct[i]) !== canon(http[i])) {
          diffs++;
          diffWeeks.push(direct[i]?.startDate ?? http[i]?.startDate ?? "?");
        }
      }
    }
    directHttp = {
      httpStatus: res.status,
      directCards: direct.length,
      httpCards: http?.length ?? null,
      deepEqual: http != null && direct.length === http.length && diffs === 0,
      diffWeeks,
      currentAccumulated: direct.length ? Math.max(...direct.map((c) => c.accumulatedApprovedWeeks ?? 0)) : 0,
      currentShieldLightning: "카드별 points.shield 표기 — 이관 후 주차별 adv−pen 반영 예상",
    };
  }
  report.step9_snapshot = snapshotInfo;
  report.verification_directVsHttp = directHttp;

  // ════════ ⑩ rollback 계획 ════════
  report.step10_rollback = {
    order: [
      "1) cluster4 evaluations/submissions/targets — source_pk 멱등키(ActivityId) 기준 신규 행 삭제",
      "2) uws — 신규 insert 삭제 + 덮어쓴 행 prior 복원 (run log 의 before 값)",
      "3) uwp — sentinel(1900-W0) 삭제 + 신규 insert 삭제 + 덮어쓴 행 prior 복원 + checks_migrated=false 복귀",
      "4) legacy_point_ledger — source_pk 기준 삭제 (read-only 아카이브라 소비처 없음)",
      "5) users 페어 기록 롤백 — 신규 채번 행은 삭제, 기존(matched) 행은 source_system NULL 복귀" +
        " (⚠ 불변 트리거가 set 후 변경을 막으므로 rollback 은 트리거 일시 해제 또는 관리 SQL 경유 — run log 에 prior 기록)",
      "6) recalcUserGrowthStats + snapshot 재계산 → 이관 전 상태 diff=0 확인",
    ],
    precondition: "apply 구현 시 모든 쓰기 전 prior 값을 run log 에 기록 (B7 apply 와 동일 패턴)",
  };

  report.weekRows = weekRows;
  await conn.end();
  writeFileSync(OUT, JSON.stringify(report, null, 1));

  // ── 콘솔 요약 ──
  const m = report.step1_matching as any;
  console.log(`══ §12 Dry Run — ${SOURCE_SYSTEM} UserId ${PMS_USER_ID} ${pmsUser.Name} (read-only · B안 composite) ══`);
  console.log(`identity: (${IDENTITY.sourceSystem}, ${IDENTITY.legacyUserId}) · org=${ORG_SLUG} · 페어 점유 ${m.compositePairOccupied.length} · NULL-source 동수 ${m.nullSourceSameNumber_info.length}(정보성)`);
  console.log(`① 매칭: 후보 ${m.vraxiumCandidatesByName} → ${m.matched ? `확정 ${m.matched.userId.slice(0, 8)} (keys ${JSON.stringify(m.matched.keys)})` : "부재(신규 채번)"}`);
  console.log(`③ ledger: ${plogs.length}행 (alive ${(report.step3_ledgerPlan as any).alive} / voided ${(report.step3_ledgerPlan as any).deleted_voidedAt} / '0000' ${(report.step3_ledgerPlan as any).code0000_included})`);
  console.log(`④ uwp: ${uwpPlanWeekIds.size}행 (insert ${uwpInserts} / 덮어쓰기 ${uwpOverwrites} / 0건주차 ${(report.step4_uwpPlan as any).zeroPointWeeksIncluded} / 미귀속 ${unattributedLogs})`);
  console.log(`⑤ uws: ${weekRows.filter((r) => r.uws).length}행 (insert ${uwsInserts} / 덮어쓰기 ${uwsOverwrites} / 상태충돌 ${uwsConflicts.length})`);
  console.log(`⑥ 판정: 일치 ${agree} / FLIP ${flips} / 역방향 ${reverse} | thr 출처: org행 ${thrFromOrg} · weeks ${thrFromWeeks} · 기본값 ${thrFromDefault}`);
  console.log(`⑦ 경험: targets ${(report.step7_experiencePlan as any).targetsToCreate} / submissions ${(report.step7_experiencePlan as any).submissionsToCreate} / evaluations ${(report.step7_experiencePlan as any).evaluationsToCreate}`);
  console.log(`⑧ adjustment: Star ${starDelta >= 0 ? "+" : ""}${starDelta} / Shield D=${shieldD} → sentinel adv ${Math.max(shieldD, 0)} pen ${Math.max(-shieldD, 0)} (잔액 ${pmsPoint.Star}/${pmsPoint.Shield})`);
  console.log(`⑨ snapshot: ${JSON.stringify({ exists: (snapshotInfo as any).exists, cardsNow: (snapshotInfo as any).cardsNow, after: (snapshotInfo as any).cardsAfterMigration_expected })}`);
  console.log(`검증 direct==HTTP: ${JSON.stringify(directHttp)}`);
  console.log(`\n→ ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
