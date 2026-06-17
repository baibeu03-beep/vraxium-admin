import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { excludeSuperAdmins } from "@/lib/superAdmins";
import { resolveUserScope } from "@/lib/userScope";
import type { ScopeMode } from "@/lib/userScopeShared";
import type { OrganizationSlug } from "@/lib/organizations";
import {
  assignNameOrders,
  birthYearDigits,
  buildCrewCode,
  clubDigit,
  effectiveGrade,
  genderDigit,
  isSeasonType,
  CREW_CODE_FORMULA_VERSION,
  type NameOrderCrew,
  type SeasonType,
  type StartWeek,
} from "@/lib/crewCode";

// 크루 코드 (재)생성/조회 — DB 연동. 순수 로직은 lib/crewCode.ts.
// ──────────────────────────────────────────────────────────────────────────
//   · 코드 = 운영 식별자. 최초 1회 생성 후 고정(freeze).
//   · 일회성 공식 전환만 generate(force) — 교체 전 old→new 를 crew_code_log 에 적재.
//   · 신규 크루는 lazyEnsureCrewCode 로 detail 조회 시 파티션 append 생성.
//   · snapshot/포인트 무접촉(운영 식별자일 뿐 DTO 입력 아님).
// ──────────────────────────────────────────────────────────────────────────

type ProfileRow = {
  user_id: string;
  display_name: string | null;
  gender: string | null;
  birth_date: string | null;
  organization_slug: string | null;
  activity_started_at: string | null;
  application_grade: number | null;
  crew_code: string | null;
};

const PROFILE_SELECT =
  "user_id,display_name,gender,birth_date,organization_slug,activity_started_at,application_grade,crew_code";

type WeekRow = {
  start_date: string | null;
  end_date: string | null;
  season_key: string | null;
  week_number: number | null;
};

// activity_started_at(timestamptz) → date(YYYY-MM-DD), KST 기준 활동 시작일(항상 월요일).
function toDateOnly(value: string | null): string | null {
  if (!value) return null;
  const m = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// season_key("2026-summer") + week_number → StartWeek 의미값. 파싱 실패 시 null.
function toStartWeek(seasonKey: string | null, weekNumber: number | null): StartWeek | null {
  if (!seasonKey || weekNumber == null) return null;
  const m = seasonKey.match(/^(\d{4})-(winter|spring|summer|autumn)$/);
  if (!m) return null;
  const year = Number(m[1]);
  const seasonType = m[2] as SeasonType;
  if (!Number.isFinite(year) || !isSeasonType(seasonType)) return null;
  return { year, seasonType, weekNumber };
}

export function startWeekKey(sw: StartWeek): string {
  return `${sw.year}-${sw.seasonType}-${sw.weekNumber}`;
}

// weeks 전 행 로드(소량 — 수백 행). date → 포함 주차 매핑에 사용.
async function loadWeeks(): Promise<WeekRow[]> {
  const { data, error } = await supabaseAdmin
    .from("weeks")
    .select("start_date,end_date,season_key,week_number")
    .not("start_date", "is", null)
    .order("start_date", { ascending: true })
    .range(0, 9999);
  if (error) throw new Error(`weeks load failed: ${error.message}`);
  return (data ?? []) as unknown as WeekRow[];
}

type ResolvedWeek = { startWeek: StartWeek; startDate: string; endDate: string };

// date(YYYY-MM-DD) → 포함 주차(start_date ≤ date ≤ end_date). 미일치 null.
function matchWeek(weeks: WeekRow[], date: string): ResolvedWeek | null {
  for (const w of weeks) {
    if (!w.start_date || !w.end_date) continue;
    if (date >= w.start_date && date <= w.end_date) {
      const sw = toStartWeek(w.season_key, w.week_number);
      if (sw) return { startWeek: sw, startDate: w.start_date, endDate: w.end_date };
    }
  }
  return null;
}

// 코드 앞 6자리 중 이름순 3자리(index 3..5)를 파싱. 형식 불일치 시 null.
function parseNameOrder(code: string | null): number | null {
  if (!code) return null;
  const m = code.match(/^\d{2}\d(\d{3})-/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

async function loadProfilesForScope(options: {
  organization?: OrganizationSlug | null;
  mode: ScopeMode;
}): Promise<ProfileRow[]> {
  const scope = await resolveUserScope(options.mode, options.organization ?? null);
  const out: ProfileRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let query = supabaseAdmin.from("user_profiles").select(PROFILE_SELECT);
    if (options.organization) {
      query = query.eq("organization_slug", options.organization);
    }
    query = excludeSuperAdmins(query)
      .order("user_id", { ascending: true })
      .range(from, from + PAGE - 1);
    const { data, error } = await query;
    if (error) throw new Error(`user_profiles load failed: ${error.message}`);
    const rows = (data ?? []) as unknown as ProfileRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  // operating=실사용자만 / test=test_user_markers 만 (목록 스코프).
  return scope.filter(out, (p) => p.user_id);
}

export type CrewCodePlan = {
  userId: string;
  displayName: string;
  orgSlug: string | null;
  oldCode: string | null;
  newCode: string | null;
  nameOrder: number | null;
  grade: number | null;
  startWeekKey: string | null;
  reason: string | null; // newCode==null 사유 또는 변경 사유('replace'/'create'/'unchanged')
};

export type GenerateResult = {
  total: number;
  planned: CrewCodePlan[];
  created: number;
  replaced: number;
  unchanged: number;
  unresolved: number; // newCode 생성 불가(데이터 누락)
  skippedFrozen: number; // crew_code 이미 존재(force 아님)로 미변경
  duplicateCodes: string[]; // 생성 결과 내 중복(있으면 안 됨)
  dryRun: boolean;
};

// 미생성 사유 진단(어떤 파생값이 빠졌는지).
function missingReason(row: ProfileRow, sw: StartWeek | null): string {
  const miss: string[] = [];
  if (!toDateOnly(row.birth_date)) miss.push("birth_date");
  if (!row.gender) miss.push("gender");
  if (!row.organization_slug) miss.push("organization_slug");
  if (!row.activity_started_at) miss.push("activity_started_at");
  else if (!sw) miss.push("week_unresolved");
  return miss.length ? `missing:${miss.join(",")}` : "unknown";
}

// 전체(조직/모집단 스코프) 크루 코드 (재)생성.
//   force=false → crew_code NULL 인 행만 채움(freeze 유지).
//   force=true  → 전부 새 공식으로 재생성(공식 전환). 교체 시 old→new 로그.
//   dryRun=true → 계획만 반환, write 없음.
export async function generateCrewCodes(options: {
  organization?: OrganizationSlug | null;
  mode?: ScopeMode;
  force?: boolean;
  dryRun?: boolean;
  generatedBy?: string | null;
}): Promise<GenerateResult> {
  const mode: ScopeMode = options.mode ?? "operating";
  const force = options.force ?? false;
  const dryRun = options.dryRun ?? false;

  const [profiles, weeks] = await Promise.all([
    loadProfilesForScope({ organization: options.organization ?? null, mode }),
    loadWeeks(),
  ]);

  // 1) 시작주차 해석 + NameOrderCrew 구성(가나다 001.. 부여).
  //    이름순은 "코드를 실제로 받는(=필수 파생값을 모두 갖춘)" 크루만 대상으로 번호를 매긴다.
  //    그래야 미생성 크루가 번호를 점유해 생성 코드가 002/004…로 비는 일이 없다(gapless).
  const startWeekByUser = new Map<string, StartWeek | null>();
  const nameOrderCrews: NameOrderCrew[] = [];
  for (const p of profiles) {
    const date = toDateOnly(p.activity_started_at);
    const matched = date ? matchWeek(weeks, date) : null;
    const sw = matched?.startWeek ?? null;
    startWeekByUser.set(p.user_id, sw);

    // 필수 파생값(년생/성별/클럽/시작주차)을 모두 갖춘 크루만 번호 부여 대상.
    const codeReady =
      birthYearDigits(p.birth_date) != null &&
      genderDigit(p.gender) != null &&
      clubDigit(p.organization_slug) != null &&
      sw != null;
    if (!codeReady) continue;

    nameOrderCrews.push({
      userId: p.user_id,
      orgSlug: p.organization_slug,
      startWeekKey: startWeekKey(sw!),
      displayName: (p.display_name ?? p.user_id).trim() || p.user_id,
    });
  }
  const nameOrders = assignNameOrders(nameOrderCrews);

  // 2) 행별 계획 수립.
  const planned: CrewCodePlan[] = [];
  for (const p of profiles) {
    const sw = startWeekByUser.get(p.user_id) ?? null;
    const nameOrder = nameOrders.get(p.user_id) ?? null;
    const grade = effectiveGrade(sw, p.application_grade);
    const swKey = sw ? startWeekKey(sw) : null;

    const newCode =
      nameOrder != null
        ? buildCrewCode({
            birthDate: p.birth_date,
            gender: p.gender,
            orgSlug: p.organization_slug,
            startWeek: sw,
            nameOrder,
            grade,
          })
        : null;

    let reason: string | null;
    if (newCode == null) {
      reason = missingReason(p, sw);
    } else if (p.crew_code == null) {
      reason = "create";
    } else if (p.crew_code !== newCode) {
      reason = force ? "replace" : "frozen"; // force 아니면 기존 유지
    } else {
      reason = "unchanged";
    }

    planned.push({
      userId: p.user_id,
      displayName: (p.display_name ?? p.user_id).trim() || p.user_id,
      orgSlug: p.organization_slug,
      oldCode: p.crew_code,
      newCode,
      nameOrder,
      grade: newCode ? grade : null,
      startWeekKey: swKey,
      reason,
    });
  }

  // 3) 실제 write 대상 결정.
  //    - create: 기존 NULL + 신규 생성 가능
  //    - replace: force && 기존 코드 ≠ 신규(생성 가능)
  const writes = planned.filter(
    (pl) =>
      pl.newCode != null &&
      (pl.reason === "create" || pl.reason === "replace"),
  );

  // 중복 검사(생성 결과 + 변경 안 되는 기존 코드까지 합쳐서).
  const finalCodeByUser = new Map<string, string | null>();
  for (const pl of planned) {
    const willWrite = writes.some((w) => w.userId === pl.userId);
    finalCodeByUser.set(pl.userId, willWrite ? pl.newCode : pl.oldCode);
  }
  const seen = new Map<string, string[]>();
  for (const [userId, code] of finalCodeByUser) {
    if (!code) continue;
    const list = seen.get(code) ?? [];
    list.push(userId);
    seen.set(code, list);
  }
  const duplicateCodes = [...seen.entries()].filter(([, ids]) => ids.length > 1).map(([code]) => code);

  if (!dryRun && duplicateCodes.length > 0) {
    throw new Error(
      `크루 코드 중복 발생 — write 중단: ${duplicateCodes.slice(0, 5).join(", ")}${duplicateCodes.length > 5 ? " …" : ""}`,
    );
  }

  // 4) write (dryRun 아니면).
  if (!dryRun) {
    const nowIso = new Date().toISOString();
    for (const w of writes) {
      const { error: upErr } = await supabaseAdmin
        .from("user_profiles")
        .update({ crew_code: w.newCode, crew_code_generated_at: nowIso })
        .eq("user_id", w.userId);
      if (upErr) throw new Error(`crew_code update failed (${w.userId}): ${upErr.message}`);

      const { error: logErr } = await supabaseAdmin.from("crew_code_log").insert({
        user_id: w.userId,
        old_code: w.oldCode,
        new_code: w.newCode,
        formula_version: CREW_CODE_FORMULA_VERSION,
        reason: w.reason,
        generated_by: options.generatedBy ?? null,
      });
      if (logErr) throw new Error(`crew_code_log insert failed (${w.userId}): ${logErr.message}`);
    }
  }

  return {
    total: profiles.length,
    planned,
    created: planned.filter((p) => p.reason === "create" && p.newCode).length,
    replaced: planned.filter((p) => p.reason === "replace" && p.newCode).length,
    unchanged: planned.filter((p) => p.reason === "unchanged").length,
    unresolved: planned.filter((p) => p.newCode == null).length,
    skippedFrozen: planned.filter((p) => p.reason === "frozen").length,
    duplicateCodes,
    dryRun,
  };
}

// 단건 크루 코드 조회(detail API). row 없으면 null.
export async function getCrewCode(userId: string): Promise<string | null> {
  const id = String(userId ?? "").trim();
  if (!id) return null;
  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select("crew_code")
    .eq("user_id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { crew_code: string | null } | null)?.crew_code ?? null;
}

// detail 조회 시 코드가 없으면 파티션 append 로 1건 생성(freeze: 기존 코드는 건드리지 않음).
//   파티션(org+시작주차) 내 기존 코드의 max(이름순)+1 부여 → 초기 배치 가나다 이후 합류자 append.
//   생성 불가(데이터 누락)면 null 반환(앱은 "미생성" 표시).
export async function lazyEnsureCrewCode(
  userId: string,
  generatedBy?: string | null,
): Promise<string | null> {
  const id = String(userId ?? "").trim();
  if (!id) return null;

  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select(PROFILE_SELECT)
    .eq("user_id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as unknown as ProfileRow | null;
  if (!row) return null;
  if (row.crew_code) return row.crew_code; // freeze.

  const date = toDateOnly(row.activity_started_at);
  if (!date) return null;
  const weeks = await loadWeeks();
  const matched = matchWeek(weeks, date);
  if (!matched) return null;
  const sw = matched.startWeek;

  // 파티션 peers(같은 org + 같은 주차 범위) 의 기존 코드 → max(이름순)+1.
  let peerQuery = supabaseAdmin
    .from("user_profiles")
    .select("crew_code,activity_started_at")
    .not("crew_code", "is", null)
    .gte("activity_started_at", `${matched.startDate}T00:00:00`)
    .lte("activity_started_at", `${matched.endDate}T23:59:59`);
  peerQuery = row.organization_slug
    ? peerQuery.eq("organization_slug", row.organization_slug)
    : peerQuery.is("organization_slug", null);
  const { data: peers, error: peerErr } = await peerQuery.range(0, 9999);
  if (peerErr) throw new Error(peerErr.message);

  const swKey = startWeekKey(sw);
  let maxOrder = 0;
  for (const peer of (peers ?? []) as Array<{ crew_code: string | null }>) {
    const order = parseNameOrder(peer.crew_code);
    if (order != null && order > maxOrder) maxOrder = order;
  }
  const nameOrder = maxOrder + 1;
  const grade = effectiveGrade(sw, row.application_grade);
  const newCode = buildCrewCode({
    birthDate: row.birth_date,
    gender: row.gender,
    orgSlug: row.organization_slug,
    startWeek: sw,
    nameOrder,
    grade,
  });
  if (!newCode) return null;

  // 동시성: unique index 가 최종 보호막. 충돌(23505) 시 1회 재조회 후 기존값 반환.
  const nowIso = new Date().toISOString();
  const { error: upErr } = await supabaseAdmin
    .from("user_profiles")
    .update({ crew_code: newCode, crew_code_generated_at: nowIso })
    .eq("user_id", id)
    .is("crew_code", null); // freeze 가드.
  if (upErr) {
    if ((upErr as { code?: string }).code === "23505") {
      return await getCrewCode(id);
    }
    throw new Error(upErr.message);
  }

  await supabaseAdmin.from("crew_code_log").insert({
    user_id: id,
    old_code: null,
    new_code: newCode,
    formula_version: CREW_CODE_FORMULA_VERSION,
    reason: `lazy:${swKey}`,
    generated_by: generatedBy ?? null,
  });

  return newCode;
}
