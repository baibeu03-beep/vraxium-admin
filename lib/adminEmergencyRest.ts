// 긴급 휴식 신청(Emergency Rest Request) 서비스 — /admin/rest-management 의 [긴급 휴식 신청].
// ─────────────────────────────────────────────────────────────────────
// 스펙 핵심: mode(operating/test)·actAsTestUserId·demoUserId·org(통합/개별) 여부와 무관하게
//   동일 서비스·동일 DTO 를 탄다. "신청자(actor)"는 서버가 결정한다(클라 입력·URL org 신뢰 금지).
//
// 데이터:
//   · 휴식 행 = vacation_requests(request_type='urgent', status='approved', requested_by_user_id,
//     week_id, po_c_act_id). status 는 항상 approved 로 생성(pending/requested 없음). 진행 상태
//     표기(휴식 이행/휴식 승인)는 조회 시 week_start_date 로 파생(adminRestManagementData).
//   · Po.C ×2 = 기존 irregular-act(manual_grant) 적립 파이프라인 재사용(accrueForCompletedIrregular).
//     그 액트는 origin='emergency_rest' 로 표식해 변동 액트 보드에서만 숨긴다(Detail Log·주간
//     포인트엔 정상 반영 — 그 경로는 process_point_awards 원장을 읽는다).
//
// 원자성: Supabase JS 는 다중문 트랜잭션이 없다 → 순서 실행 + 실패 시 보상(생성물 전량 회수)으로
//   "부분 성공(휴식만 생성·포인트 미지급)"을 방지한다. 멱등성 = (크루,주차) 중복 가드 + 원장 UNIQUE.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { AdminContext } from "@/lib/adminAuth";
import { resolveAdminOrgAccess } from "@/lib/adminOrgAccess";
import { resolveEffectiveActorUserId } from "@/lib/experienceImpersonation";
import { resolveActorContext } from "@/lib/adminExperiencePartInput";
import { loadAdminDisplayName } from "@/lib/adminMe";
import { resolveCurrentHalfKey, listHalfTeams } from "@/lib/adminTeamHalvesData";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";
import { isWeekOfficialRestById } from "@/lib/cluster4OfficialRestWeek";
import { resolveUserScope, assertUserIdsInScope } from "@/lib/userScope";
import { accrueForCompletedIrregular, revokeForAct } from "@/lib/processPointAccrual";
import { fetchCrewCodeMap } from "@/lib/adminCrewCode";
import { classLabel, memberStatusLabel } from "@/lib/adminMembersTypes";
import { formatClubDate } from "@/lib/clubDate";
import {
  getCurrentActivityDateIso,
  hasWeekStartedKst,
  operationalSeasonDbKey,
} from "@/lib/seasonCalendar";
import {
  ORGANIZATIONS,
  type OrganizationSlug,
} from "@/lib/organizations";
import type { ScopeMode } from "@/lib/userScopeShared";

// ── 오류 타입(라우트가 status 로 응답) ────────────────────────────────────────
export class EmergencyRestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "EmergencyRestError";
    this.status = status;
  }
}

// ── DTO ───────────────────────────────────────────────────────────────────
export type EmergencyActorRole = "leader" | "ambassador" | "admin";

export type EmergencyActorDto = {
  roleLabel: string; // 팀장 | 앰배서더 | 관리자
  displayName: string; // user_profiles.display_name → email → "관리자"
  teamName: string | null; // 연결된 팀(팀장/앰배서더만). 관리자=null.
};

export type EmergencyTeamOptionDto = {
  teamId: string; // cluster4_team_halves.id (teamHalfId)
  teamName: string;
  organization: OrganizationSlug;
};

export type EmergencyWeekOptionDto = {
  weekId: string; // weeks.id
  seasonKey: string;
  weekStartDate: string;
  weekEndDate: string;
  weekLabel: string; // "여름 시즌 3주차"
  dateRangeLabel: string; // "26 - 07 - 20 (월) ~ 26 - 07 - 26 (일)"
  isCurrent: boolean;
  // 생성 즉시 목록에 표기될 진행 상태(현재 주차=이행 / 다음 주차=승인).
  resultingStatus: "fulfilled" | "approved";
};

export type EmergencyContextDto = {
  organization: OrganizationSlug;
  seasonKey: string | null;
  seasonLabel: string; // "26년 여름 시즌"
  actor: EmergencyActorDto;
  teams: EmergencyTeamOptionDto[];
  weeks: EmergencyWeekOptionDto[]; // {현재,다음} − 공식 휴식
  poC: 2; // 고정 지급량(읽기 전용 안내)
};

export type EmergencyCrewDto = {
  userId: string;
  crewName: string;
  crewCode: string | null;
  classLabel: string; // 심화(에이전트) 등
  teamId: string;
};

const SEASON_CODE_KO: Record<string, string> = {
  winter: "겨울",
  spring: "봄",
  summer: "여름",
  autumn: "가을",
};

// "2026-summer" → "26년 여름 시즌"
function seasonLabelKo(seasonKey: string | null): string {
  if (!seasonKey) return "";
  const [year, code] = seasonKey.split("-");
  const ko = code ? SEASON_CODE_KO[code] : undefined;
  const yy = year && year.length >= 2 ? year.slice(2) : year;
  return ko ? `${yy}년 ${ko} 시즌` : seasonKey;
}

const DAY_MS = 86_400_000;
function isoToUtcMs(iso: string): number {
  return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
}
function addDaysIso(iso: string, days: number): string {
  return new Date(isoToUtcMs(iso) + days * DAY_MS).toISOString().slice(0, 10);
}

// ── Actor 해소(서버 결정) ─────────────────────────────────────────────────
// effectiveUserId = 임퍼소네이션(actAsTestUserId·mode=test) 유효 시 그 test user, 아니면 실 admin.
//   역할 판정:
//     · user_profiles.role === team_leader → leader
//     · user_profiles.role === ambassador  → ambassador
//     · 임퍼 비활성 + admin/owner            → admin(허용 org 전체 팀)
//     · 그 외(임퍼된 일반/에이전트·viewer 등) → restricted(팀 없음 → POST 차단)
export type EmergencyActorResolution = {
  effectiveUserId: string;
  role: EmergencyActorRole | "restricted";
  roleLabel: string;
  displayName: string;
  teamName: string | null;
  allowedOrgs: OrganizationSlug[];
  allowedTeams: EmergencyTeamOptionDto[];
};

export async function resolveEmergencyActor(
  admin: AdminContext,
  opts: { mode: ScopeMode; actAsTestUserId: string | null },
): Promise<EmergencyActorResolution> {
  const { effectiveUserId, impersonation } = await resolveEffectiveActorUserId(
    admin.userId,
    { mode: opts.mode, actAsTestUserId: opts.actAsTestUserId },
  );
  const impersonationActive = impersonation.active;

  const { allowedOrgs } = await resolveAdminOrgAccess(admin);
  const displayName =
    (await loadAdminDisplayName(effectiveUserId)) ?? admin.email ?? "관리자";

  // effectiveUserId 의 운영 역할(user_profiles.role) + 연결 팀.
  const actorCtx = await resolveActorContext(effectiveUserId);
  const profileRole = actorCtx.role;

  let role: EmergencyActorRole | "restricted";
  if (profileRole === "team_leader") role = "leader";
  else if (profileRole === "ambassador") role = "ambassador";
  else if (
    !impersonationActive &&
    (admin.role === "owner" ||
      admin.role === "admin" ||
      profileRole === "admin" ||
      profileRole === "super_admin")
  )
    role = "admin";
  else role = "restricted";

  const roleLabel =
    role === "leader"
      ? "팀장"
      : role === "ambassador"
        ? "앰배서더"
        : role === "admin"
          ? "관리자"
          : memberStatusLabel(profileRole, null);

  const halfKey = await resolveCurrentHalfKey(getCurrentActivityDateIso());

  let allowedTeams: EmergencyTeamOptionDto[] = [];
  let teamName: string | null = null;

  if (role === "admin") {
    // 허용 org 전체의 활성 팀.
    for (const org of allowedOrgs) {
      const teams = await listHalfTeams(org, halfKey ?? "");
      for (const t of teams) {
        allowedTeams.push({ teamId: t.teamHalfId, teamName: t.teamName, organization: org });
      }
    }
  } else if (role === "leader") {
    // 자신이 팀장인 팀(현재 반기·활성·허용 org).
    allowedTeams = await teamsLedBy(effectiveUserId, halfKey, allowedOrgs);
    teamName = allowedTeams[0]?.teamName ?? actorCtx.teamName ?? null;
  } else if (role === "ambassador") {
    // 연결된 팀(멤버십 team_name)을 팀 SoT 에서 활성 확인.
    teamName = actorCtx.teamName ?? null;
    if (teamName) {
      allowedTeams = await teamsByName(teamName, halfKey, allowedOrgs);
    }
  }
  // restricted → allowedTeams = [] (POST 차단).

  return {
    effectiveUserId,
    role,
    roleLabel,
    displayName,
    teamName,
    allowedOrgs,
    allowedTeams,
  };
}

// leader_user_id 가 actor 인 활성 팀(현재 반기·허용 org).
async function teamsLedBy(
  leaderUserId: string,
  halfKey: string | null,
  allowedOrgs: OrganizationSlug[],
): Promise<EmergencyTeamOptionDto[]> {
  if (!halfKey || allowedOrgs.length === 0) return [];
  const { data, error } = await supabaseAdmin
    .from("cluster4_team_halves")
    .select("id,team_name,organization_slug,is_active,half_key,leader_user_id")
    .eq("leader_user_id", leaderUserId)
    .eq("half_key", halfKey)
    .eq("is_active", true);
  if (error) throw new EmergencyRestError(500, error.message);
  return ((data ?? []) as Array<{
    id: string;
    team_name: string;
    organization_slug: string;
  }>)
    .filter((r) => (allowedOrgs as readonly string[]).includes(r.organization_slug))
    .map((r) => ({
      teamId: r.id,
      teamName: r.team_name,
      organization: r.organization_slug as OrganizationSlug,
    }));
}

// team_name 으로 활성 팀 SoT 행 조회(현재 반기·허용 org). 앰배서더 연결 팀 확정용.
async function teamsByName(
  teamName: string,
  halfKey: string | null,
  allowedOrgs: OrganizationSlug[],
): Promise<EmergencyTeamOptionDto[]> {
  if (!halfKey || allowedOrgs.length === 0) return [];
  const { data, error } = await supabaseAdmin
    .from("cluster4_team_halves")
    .select("id,team_name,organization_slug,is_active,half_key")
    .eq("team_name", teamName)
    .eq("half_key", halfKey)
    .eq("is_active", true);
  if (error) throw new EmergencyRestError(500, error.message);
  return ((data ?? []) as Array<{
    id: string;
    team_name: string;
    organization_slug: string;
  }>)
    .filter((r) => (allowedOrgs as readonly string[]).includes(r.organization_slug))
    .map((r) => ({
      teamId: r.id,
      teamName: r.team_name,
      organization: r.organization_slug as OrganizationSlug,
    }));
}

// ── 신청 가능 주차(현재·다음 − 공식 휴식) ──────────────────────────────────
async function loadEligibleWeeks(nowMs: number = Date.now()): Promise<EmergencyWeekOptionDto[]> {
  const todayIso = getCurrentActivityDateIso(nowMs);
  const { rows } = await loadSeasonWeeks(todayIso);
  const current = rows.find((r) => r.is_current_week) ?? null;
  const out: EmergencyWeekOptionDto[] = [];

  const toOption = (r: (typeof rows)[number]): EmergencyWeekOptionDto | null => {
    if (!r.week_start_date || !r.week_end_date || r.is_official_rest) return null;
    // 상태 = 실제 타임스탬프 비교(now vs 주 월요일 00:01 KST) — 생성/조회 공통 SoT.
    const started = hasWeekStartedKst(r.week_start_date, nowMs);
    return {
      weekId: r.week_id,
      seasonKey: r.season_key,
      weekStartDate: r.week_start_date,
      weekEndDate: r.week_end_date,
      weekLabel: `${r.season_name ?? ""} ${r.week_number ?? "?"}주차`.trim(),
      dateRangeLabel: `${formatClubDate(r.week_start_date)} ~ ${formatClubDate(r.week_end_date)}`,
      isCurrent: started,
      resultingStatus: started ? "fulfilled" : "approved",
    };
  };

  if (current) {
    const opt = toOption(current);
    if (opt) out.push(opt);
    const nextStart = addDaysIso(current.week_start_date ?? todayIso, 7);
    const next = rows.find((r) => r.week_start_date === nextStart) ?? null;
    if (next) {
      const nopt = toOption(next);
      if (nopt) out.push(nopt);
    }
  }
  return out;
}

// ── 모달 초기 컨텍스트 ─────────────────────────────────────────────────────
export async function loadEmergencyContext(
  organization: OrganizationSlug,
  mode: ScopeMode,
  admin: AdminContext,
  actAsTestUserId: string | null,
): Promise<EmergencyContextDto> {
  const actor = await resolveEmergencyActor(admin, { mode, actAsTestUserId });
  return buildContext(organization, actor);
}

async function buildContext(
  organization: OrganizationSlug,
  actor: EmergencyActorResolution,
): Promise<EmergencyContextDto> {
  // 이 org 로 스코프된 팀만 노출(관리자=허용 org 전체 중 이 org, 팀장/앰배서더=자기 팀이 이 org 일 때).
  const teams = actor.allowedTeams.filter((t) => t.organization === organization);
  const weeks = await loadEligibleWeeks();
  const seasonKey = operationalSeasonDbKey(getCurrentActivityDateIso());

  return {
    organization,
    seasonKey: seasonKey ?? null,
    seasonLabel: seasonLabelKo(seasonKey),
    actor: {
      roleLabel: actor.roleLabel,
      displayName: actor.displayName,
      teamName: actor.teamName,
    },
    teams,
    weeks,
    poC: 2,
  };
}

// ── 팀 소속 크루 목록 ──────────────────────────────────────────────────────
type MembershipRow = {
  user_id: string;
  team_name: string | null;
  membership_level: string | null;
  is_current: boolean | null;
  membership_state: string | null;
};

// teamId(teamHalfId) → {teamName, org}. org 불일치/미존재는 404/403.
async function resolveTeamHalf(
  teamId: string,
  organization: OrganizationSlug,
): Promise<{ teamName: string }> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_team_halves")
    .select("id,team_name,organization_slug,is_active")
    .eq("id", teamId)
    .maybeSingle();
  if (error) throw new EmergencyRestError(500, error.message);
  const row = data as {
    team_name: string;
    organization_slug: string;
    is_active: boolean;
  } | null;
  if (!row) throw new EmergencyRestError(404, "팀을 찾을 수 없습니다.");
  if (row.organization_slug !== organization) {
    throw new EmergencyRestError(403, "이 클럽의 팀이 아닙니다.");
  }
  return { teamName: row.team_name };
}

export async function listEmergencyCrews(
  organization: OrganizationSlug,
  teamId: string,
  mode: ScopeMode,
): Promise<EmergencyCrewDto[]> {
  const { teamName } = await resolveTeamHalf(teamId, organization);
  const scope = await resolveUserScope(mode, organization);

  const { data: mems, error: mErr } = await supabaseAdmin
    .from("user_memberships")
    .select("user_id,team_name,membership_level,is_current,membership_state")
    .in("team_name", [teamName])
    .eq("is_current", true);
  if (mErr) throw new EmergencyRestError(500, mErr.message);

  const rows = ((mems ?? []) as MembershipRow[]).filter(
    (m) => m.team_name === teamName && m.membership_state !== "rest",
  );
  const uids = Array.from(new Set(rows.map((r) => r.user_id).filter(Boolean)));
  if (uids.length === 0) return [];

  // org 매칭 + 이름/역할.
  const { data: profs, error: pErr } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,role,organization_slug")
    .in("user_id", uids);
  if (pErr) throw new EmergencyRestError(500, pErr.message);
  const profById = new Map(
    ((profs ?? []) as Array<{
      user_id: string;
      display_name: string | null;
      role: string | null;
      organization_slug: string | null;
    }>).map((p) => [p.user_id, p]),
  );
  const levelByUser = new Map<string, string | null>();
  for (const r of rows) levelByUser.set(r.user_id, r.membership_level);

  // 모집단 스코프(operating=실사용자만/test=테스트 유저만) + org 매칭.
  const crewUids = uids.filter((u) => {
    const p = profById.get(u);
    return p?.organization_slug === organization && scope.includes(u);
  });
  if (crewUids.length === 0) return [];

  const crewCodes = await fetchCrewCodeMap(crewUids);

  const out: EmergencyCrewDto[] = crewUids.map((u) => {
    const p = profById.get(u);
    return {
      userId: u,
      crewName: p?.display_name?.trim() || "(이름 없음)",
      crewCode: crewCodes.get(u) ?? null,
      classLabel: classLabel(p?.role ?? null, levelByUser.get(u) ?? null),
      teamId,
    };
  });
  out.sort((a, b) => a.crewName.localeCompare(b.crewName, "ko"));
  return out;
}

// ── 긴급 휴식 생성(원자적 흐름 + 보상) ─────────────────────────────────────
const ACT_NAME_MAX = 60;
function buildActName(crewName: string): string {
  const base = `긴급 휴식 · ${crewName}`;
  return base.length > ACT_NAME_MAX ? base.slice(0, ACT_NAME_MAX) : base;
}

function isMissingColumn(error: { code?: string; message?: string } | null): boolean {
  const code = error?.code;
  return code === "42703" || code === "PGRST204";
}

export async function createEmergencyRest(input: {
  admin: AdminContext;
  mode: ScopeMode;
  actAsTestUserId: string | null;
  organization: OrganizationSlug;
  teamId: string;
  crewUserId: string;
  weekId: string;
  reason: string;
}): Promise<{ id: string; poCActId: string; resultingStatus: "fulfilled" | "approved" }> {
  const { admin, mode, actAsTestUserId, organization, teamId, crewUserId, weekId } = input;

  // 1) 서버 actor 해소(클라 신뢰 금지).
  const actor = await resolveEmergencyActor(admin, { mode, actAsTestUserId });

  // 2) 사유 검증(1~50자, 공백만=미입력).
  const reason = (input.reason ?? "").trim();
  if (reason.length < 1 || reason.length > 50) {
    throw new EmergencyRestError(400, "긴급 신청 상황은 1~50자로 입력해 주세요.");
  }

  // 3) 팀 권한 — teamId 가 actor 의 허용 팀이며 이 org 인지.
  const team = actor.allowedTeams.find((t) => t.teamId === teamId);
  if (!team) {
    throw new EmergencyRestError(403, "이 팀에 긴급 휴식을 신청할 권한이 없습니다.");
  }
  if (team.organization !== organization) {
    throw new EmergencyRestError(403, "선택한 팀이 이 클럽 소속이 아닙니다.");
  }

  // 4) 주차 — 신청 가능(현재/다음 − 공식 휴식) 목록에 있는 weekId 만.
  const eligible = await loadEligibleWeeks();
  const week = eligible.find((w) => w.weekId === weekId);
  if (!week) {
    throw new EmergencyRestError(422, "신청할 수 없는 주차입니다(현재/다음 주차만, 공식 휴식 제외).");
  }
  // 공식 휴식 재확인(방어적).
  const rest = await isWeekOfficialRestById(weekId);
  if (rest.rest) {
    throw new EmergencyRestError(422, "공식 휴식 주차에는 긴급 휴식을 신청할 수 없습니다.");
  }

  // 5) 크루 — 선택 팀 소속 + 모집단 스코프 내.
  const crews = await listEmergencyCrews(organization, teamId, mode);
  const crew = crews.find((c) => c.userId === crewUserId);
  if (!crew) {
    throw new EmergencyRestError(403, "선택한 크루가 이 팀 소속이 아니거나 대상이 아닙니다.");
  }
  // 스코프 재검증(fail-closed 422) — test=테스트 유저만/operating=실사용자만.
  const scope = await resolveUserScope(mode, organization);
  assertUserIdsInScope(scope, [crewUserId]);

  // 6) 중복 가드 — 동일 크루·동일 주차 기존 휴식이 있으면 409.
  {
    const { data: dup, error: dErr } = await supabaseAdmin
      .from("vacation_requests")
      .select("id")
      .eq("user_id", crewUserId)
      .eq("week_start_date", week.weekStartDate)
      .limit(1);
    if (dErr) throw new EmergencyRestError(500, dErr.message);
    if ((dup ?? []).length > 0) {
      throw new EmergencyRestError(409, "이미 해당 주차에 신청된 휴식이 있습니다.");
    }
  }

  // 7) 휴식 행 생성(status=approved · request_type=urgent · 추적 컬럼).
  const nowIso = new Date().toISOString();
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from("vacation_requests")
    .insert({
      user_id: crewUserId,
      org: organization,
      season_key: week.seasonKey,
      week_start_date: week.weekStartDate,
      week_id: weekId,
      reason,
      request_type: "urgent",
      status: "approved",
      requested_by_user_id: actor.effectiveUserId,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .select("id")
    .single();
  if (insErr) {
    if (isMissingColumn(insErr)) {
      throw new EmergencyRestError(
        500,
        "긴급 휴식 컬럼이 없습니다. db/migrations/2026-07-12_emergency_rest.sql 을 SQL Editor 에서 적용해주세요.",
      );
    }
    throw new EmergencyRestError(500, insErr.message);
  }
  const restId = (inserted as { id: string }).id;

  // 8) Po.C ×2 지급(변동 액트 파이프라인) — 실패 시 7)까지 전량 보상.
  let actId: string | null = null;
  try {
    const applicantAdminName = actor.displayName;
    const { data: act, error: actErr } = await supabaseAdmin
      .from("process_irregular_acts")
      .insert({
        origin: "emergency_rest",
        organization_slug: organization,
        week_id: weekId,
        kind: "manual_grant",
        act_name: buildActName(crew.crewName),
        applicant_admin_id: actor.effectiveUserId,
        applicant_admin_name: applicantAdminName,
        target_user_id: null,
        target_user_name: null,
        scope_mode: mode,
        duration_minutes: null,
        reason,
        point_a: 0,
        point_b: 0,
        point_c: 2,
        crew_reaction: "partial",
        review_link: null,
        scheduled_check_at: nowIso,
        status: "completed",
        completed_at: nowIso,
      })
      .select("id")
      .single();
    if (actErr) {
      if (isMissingColumn(actErr)) {
        throw new EmergencyRestError(
          500,
          "process_irregular_acts.origin 컬럼이 없습니다. db/migrations/2026-07-12_emergency_rest.sql 을 적용해주세요.",
        );
      }
      throw new EmergencyRestError(500, actErr.message);
    }
    actId = (act as { id: string }).id;

    // 대상 크루 recipient(matched) — 적립 대상 로드 키.
    const { error: recErr } = await supabaseAdmin
      .from("process_check_review_recipients")
      .insert({
        source: "irregular",
        ref_id: actId,
        organization_slug: organization,
        scope_mode: mode,
        user_id: crewUserId,
        nickname: crew.crewName,
        match_type: "matched",
        match_reason: "emergency_rest",
      });
    if (recErr) throw new EmergencyRestError(500, recErr.message);

    // 적립 실행 — skipped/오류/미적립(0명)은 모두 실패로 간주(부분 성공 금지).
    const acc = await accrueForCompletedIrregular(actId);
    if (("skipped" in acc && acc.skipped) || acc.accruedUserIds.length === 0) {
      const reasonMsg =
        "skipped" in acc && acc.skipped ? acc.reason : "적립 대상이 없습니다";
      throw new EmergencyRestError(
        500,
        `Po.C 적립에 실패했습니다(${reasonMsg}).`,
      );
    }

    // 링크 저장(po_c_act_id).
    const { error: linkErr } = await supabaseAdmin
      .from("vacation_requests")
      .update({ po_c_act_id: actId, updated_at: new Date().toISOString() })
      .eq("id", restId);
    if (linkErr) throw new EmergencyRestError(500, linkErr.message);
  } catch (err) {
    // ── 보상: 생성물 전량 회수(원장·recipients·act·휴식 행) ──
    await compensate(restId, actId);
    if (err instanceof EmergencyRestError) throw err;
    throw new EmergencyRestError(
      500,
      err instanceof Error ? err.message : "긴급 휴식 신청 처리에 실패했습니다.",
    );
  }

  return { id: restId, poCActId: actId, resultingStatus: week.resultingStatus };
}

// 보상 — best-effort 로 각 단계를 되돌린다(부분 성공 방지). 순서: 원장 회수 → recipients → act → 휴식 행.
async function compensate(restId: string, actId: string | null): Promise<void> {
  if (actId) {
    try {
      await revokeForAct("irregular", actId); // 원장 삭제 + user_weekly_points 재계산 + snapshot 무효화
    } catch (e) {
      console.warn("[emergency-rest] 보상: revokeForAct 실패", {
        actId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
    try {
      await supabaseAdmin
        .from("process_check_review_recipients")
        .delete()
        .eq("source", "irregular")
        .eq("ref_id", actId);
    } catch (e) {
      console.warn("[emergency-rest] 보상: recipients 삭제 실패", { actId, message: String(e) });
    }
    try {
      await supabaseAdmin.from("process_irregular_acts").delete().eq("id", actId);
    } catch (e) {
      console.warn("[emergency-rest] 보상: act 삭제 실패", { actId, message: String(e) });
    }
  }
  try {
    await supabaseAdmin.from("vacation_requests").delete().eq("id", restId);
  } catch (e) {
    console.warn("[emergency-rest] 보상: 휴식 행 삭제 실패", { restId, message: String(e) });
  }
}

// 검증/진단용 — 허용 org 상수 재노출(라우트 org 파싱 편의).
export const EMERGENCY_ALLOWED_ORGS = ORGANIZATIONS;
