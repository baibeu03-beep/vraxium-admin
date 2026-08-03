import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadCurrentWeekOverrideLabels, resolvePositionAtBatch } from "@/lib/positionResolver";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import {
  ORGANIZATIONS,
  organizationLabelKo,
  type OrganizationSlug,
} from "@/lib/organizations";
import { SUPER_ADMIN_EXCLUDE_OR, SUPER_ADMIN_ROLE } from "@/lib/superAdmins";
import { resolveUserScope } from "@/lib/userScope";
import { memberStatusLabel } from "@/lib/adminMembersTypes";
import type { ScopeMode } from "@/lib/userScopeShared";
import {
  loadCurrentClubStructure,
  loadClubStructure,
} from "@/lib/adminTeamHalvesData";
import { halfKeyForDate, halfKeyToSeasonKeys } from "@/lib/teamHalf";
import { resolveHalfPeriod, type HalfPeriodMeta } from "@/lib/halfPeriod";

// ── 클럽 목록(상위 페이지) 요약 — 선택 반기(period) 기준 클럽별 현황 ──────────────────
//
//   `/admin/team-parts/info` 상위 목록 표의 각 행(클럽 1개), `/admin/team-parts/info/[clubId]`
//   상세의 현재/과거 시점 스트립이 **모두 이 함수 하나**를 쓴다(2026-07-31 확장).
//   halfKey 미지정 = 현재 반기 — "현재"도 lib/halfPeriod.ts 의 동일 period 해석 경로를 타는
//   특수 케이스일 뿐, 별도 로직이 아니다(요구 11).
//
//   두 계열의 원천 — 각자의 SoT 를 그대로 파생(별도 재집계 금지):
//     · **구조 숫자(teamEntityCount·partCount)** = `loadCurrentClubStructure`(상단 요약 '전체 팀/파트 수'
//       와 **동일 함수**). ∴ SUM(rows.partCount) === structureTotals.totalParts,
//       SUM(rows.teamEntityCount) === structureTotals.totalTeams 가 항상 성립한다.
//       partCount = Σ listOperatedTeamParts(org, team, 현재 주차, mode).length — 그 주차 effective
//       배정 크루 ≥1 인 파트('일반' 제외). 카탈로그 레코드 수 아님·크루 0 파트 제외.
//       ⚠ 여기서 파트를 다시 세지 않는다(2026-07-27 C2). 규칙 변경은 listOperatedTeamParts 에서.
//     · **역할 기반 사람 수(운영진/팀장/앰배서더/클러빙/정규·심화/파트장/에이전트)** = 라이브 로스터
//       (user_profiles ∩ resolveUserScope(mode) − super_admin, 등급=user_memberships). 주차 휴식 포함.
//
//   ⚠ 헤더 "팀 수" 컬럼의 표시값 = **teamLeaderCount(role=team_leader 인원 수)** — 팀 entity 수 아님.
//     `운영진 = 팀장 수 + 앰배서더` 등식은 사람 수 기준에서만 성립. 실제 팀 entity 수는 teamEntityCount 로
//     별도 노출(상단 '전체 팀 수'와 동일 SoT). 두 값은 서로 다른 개념 — 섞어 계산하지 않는다.
//
//   mode/org 분기 없음 — 일반/test/actAs/demo 모든 경로가 이 동일 함수·동일 DTO 를 쓴다(context 만 전달).

// 숫자 필드는 반기(period) 기능 도입 후 number | null 이다.
//   null = "그 반기는 원장 자체가 없어 복원 불가"(rosterSource/structureSource==="unavailable").
//   0 은 "원장을 조회했고 실제로 0명/0개"라는 별개의 사실 — 절대 섞지 않는다.
//   halfKey 를 넘기지 않는 기존 호출(= 현재 반기)은 rosterSource/structureSource 가 항상
//   "live" 라 이 필드들이 실질적으로 항상 숫자다(무회귀).
export type ClubCurrentSummaryRow = {
  clubId: string; // = 조직 slug(안정 식별자). 상세 라우팅 키.
  clubSlug: string; // = clubId (표시용 별칭)
  clubName: string; // 한글 클럽명

  staffCount: number | null; // 운영진 = 팀장 수 + 앰배서더
  teamLeaderCount: number | null; // 헤더 "팀 수" 표시값 — role=team_leader 인원 수(사람, entity 아님)
  teamEntityCount: number | null; // 실제 팀 entity 수(선택 반기 활성·스코프). 상단 '전체 팀 수'와 동일 SoT
  ambassadorCount: number | null; // 앰배서더

  clubbingCount: number | null; // 클러빙 = 정규 + 심화
  regularCrewCount: number | null; // 정규 크루(일반/크루)
  advancedCrewCount: number | null; // 심화 크루 = 파트장 + 에이전트

  partCount: number | null; // 파트 수(선택 반기 asOf 시점 멤버 ≥1 활성 파트). 상단 '전체 파트 수'와 동일 SoT
  partLeaderCount: number | null; // 심화(파트장) 인원 수
  agentCount: number | null; // 심화(에이전트) 인원 수
};

export type ClubCurrentSummaryTotals = Omit<
  ClubCurrentSummaryRow,
  "clubId" | "clubSlug" | "clubName"
>;

export type ClubCurrentSummaryResponse = {
  asOf: string; // 현재 접속 시점 date-only ISO(Asia/Seoul) — period.asOfDate 와 동일 값(하위호환 유지)
  currentWeekLabel: string; // "[26년, 여름 시즌, 3주차]" (없으면 "-") — period.weekLabel 과 동일 값
  // 상단 요약 구조 합계(SoT). SUM(rows.partCount)===totalParts, SUM(rows.teamEntityCount)===totalTeams.
  //   과거 반기에서 structureSource==="unavailable" 이면 이 합계도 전부 0(집계 대상 자체가 없음).
  structureTotals: { totalClubs: number; totalTeams: number; totalParts: number };
  rows: ClubCurrentSummaryRow[];
  totals: ClubCurrentSummaryTotals;
  // 선택 반기 공용 메타 — /admin/team-parts/info/* 전체가 이 블록 하나만 신뢰한다.
  period: HalfPeriodMeta;
};

// 클럽 표시명 = lib/organizations 단일 SoT(organizationLabelKo). 여기서 한글을 재작성하지 않는다.

// 순수 검증 함수 — 세 등식 성립 여부. 개발/검증에서 불일치 탐지용(숫자 보정 금지).
//   null 이 섞인 행(기록 없음)은 검증 대상이 아니다 — 셋 다 숫자일 때만 등식을 판정한다.
export function validateClubSummary(row: {
  staffCount: number | null;
  teamLeaderCount: number | null;
  ambassadorCount: number | null;
  clubbingCount: number | null;
  regularCrewCount: number | null;
  advancedCrewCount: number | null;
  partLeaderCount: number | null;
  agentCount: number | null;
}): { staffValid: boolean; clubbingValid: boolean; advancedValid: boolean } {
  const n = (v: number | null): v is number => v != null;
  return {
    staffValid:
      !n(row.staffCount) || !n(row.teamLeaderCount) || !n(row.ambassadorCount)
        ? true
        : row.staffCount === row.teamLeaderCount + row.ambassadorCount,
    clubbingValid:
      !n(row.clubbingCount) || !n(row.regularCrewCount) || !n(row.advancedCrewCount)
        ? true
        : row.clubbingCount === row.regularCrewCount + row.advancedCrewCount,
    advancedValid:
      !n(row.advancedCrewCount) || !n(row.partLeaderCount) || !n(row.agentCount)
        ? true
        : row.advancedCrewCount === row.partLeaderCount + row.agentCount,
  };
}

// 한 조직의 **라이브** 로스터 → 역할별 인원 수(현재 반기 전용, 종전 로직 그대로 — 무회귀).
//   userId 기준 중복 없음(user_profiles 는 user 당 1행).
async function buildClubRoleCountsLive(
  organization: OrganizationSlug,
  mode: ScopeMode,
): Promise<{
  teamLeaderCount: number;
  ambassadorCount: number;
  regularCrewCount: number;
  partLeaderCount: number;
  agentCount: number;
}> {
  // 1) org 프로필(super_admin 제외).
  const { data: profs, error: pErr } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,role")
    .eq("organization_slug", organization)
    .or(SUPER_ADMIN_EXCLUDE_OR);
  if (pErr) throw new Error(pErr.message);

  // 2) 모집단 스코프(operating=실사용자·test=테스트 마커) 교집합 — /admin/members 목록과 동일 SoT.
  const scope = await resolveUserScope(mode, null);
  const roster = ((profs ?? []) as Array<{ user_id: string; role: string | null }>).filter(
    (p) => scope.includes(p.user_id),
  );

  // 3) 등급(membership_level) 배치 — is_current 우선(fetchMembershipLevels 와 동일 규칙).
  const levelByUser = new Map<string, string | null>();
  const uids = roster.map((r) => r.user_id);
  for (let i = 0; i < uids.length; i += 100) {
    const chunk = uids.slice(i, i + 100);
    if (chunk.length === 0) break;
    const { data: mems, error: mErr } = await supabaseAdmin
      .from("user_memberships")
      .select("user_id,membership_level,is_current")
      .in("user_id", chunk);
    if (mErr) throw new Error(mErr.message);
    for (const m of (mems ?? []) as Array<{
      user_id: string;
      membership_level: string | null;
      is_current: boolean | null;
    }>) {
      if (!levelByUser.has(m.user_id) || m.is_current)
        levelByUser.set(m.user_id, m.membership_level);
    }
  }

  // 4) 역할 라벨 버킷팅(memberStatusLabel 단일 SoT). userId 기준 → 자동 고유(한 사람 = 한 버킷).
  let teamLeaderCount = 0;
  let ambassadorCount = 0;
  let regularCrewCount = 0;
  let partLeaderCount = 0;
  let agentCount = 0;
  // 현재 주차 override 가 있으면 그 클래스로 버킷팅한다(회원 목록·팀 상세 [A] 와 동일 정책).
  const weekOverrides = await loadCurrentWeekOverrideLabels(roster.map((r) => r.user_id), organization);
  for (const r of roster) {
    const label =
      weekOverrides.get(r.user_id)?.statusLabel ??
      memberStatusLabel(r.role, levelByUser.get(r.user_id) ?? null);
    switch (label) {
      case "팀장":
        teamLeaderCount++;
        break;
      case "앰배서더":
        ambassadorCount++;
        break;
      case "심화(파트장)":
        partLeaderCount++;
        break;
      case "심화(에이전트)":
        agentCount++;
        break;
      case "일반":
      case "크루":
        regularCrewCount++;
        break;
      // 관리자/최고 관리자 등 = 운영진(팀장/앰배서더)·크루 어디에도 속하지 않음(미집계).
      default:
        break;
    }
  }
  return {
    teamLeaderCount,
    ambassadorCount,
    regularCrewCount,
    partLeaderCount,
    agentCount,
  };
}

type RoleCounts = {
  teamLeaderCount: number;
  ambassadorCount: number;
  regularCrewCount: number;
  partLeaderCount: number;
  agentCount: number;
};

// 한 조직의 **과거 반기** 로스터 → 역할별 인원 수. 3절 설계(2026-07-31 확정):
//   후보 풀 = user_profiles(org, 현재 소속) ∪ UPH 유저(org, 그 반기 두 시즌) — 합집합.
//   asOf 주차 기준 resolvePositionAtBatch 로 해소하고, source ∈ {override, uph} 인 사람만 집계한다.
//   membership fallback(=지금 소속을 그대로 대입한 값)으로 채워진 사람은 **집계에서 제외** —
//   현재 사용자 상태를 과거 반기에 대입하지 않기 위함(요구 6).
async function buildClubRoleCountsHistorical(
  organization: OrganizationSlug,
  mode: ScopeMode,
  period: HalfPeriodMeta,
): Promise<RoleCounts> {
  const zero: RoleCounts = {
    teamLeaderCount: 0,
    ambassadorCount: 0,
    regularCrewCount: 0,
    partLeaderCount: 0,
    agentCount: 0,
  };
  const seasons = halfKeyToSeasonKeys(period.period);
  if (!seasons || !period.asOfWeekStart) return zero;

  const [{ data: profs, error: pErr }, { data: uphRows, error: uErr }] = await Promise.all([
    supabaseAdmin.from("user_profiles").select("user_id,role").eq("organization_slug", organization),
    supabaseAdmin
      .from("user_position_histories")
      .select("user_id")
      .eq("organization", organization)
      .in("season_key", seasons),
  ]);
  if (pErr) throw new Error(pErr.message);
  if (uErr) throw new Error(uErr.message);

  const profileRows = (profs ?? []) as Array<{ user_id: string; role: string | null }>;
  const roleByUser = new Map(profileRows.map((p) => [p.user_id, p.role]));
  const uphUserIds = Array.from(
    new Set(((uphRows ?? []) as Array<{ user_id: string }>).map((r) => r.user_id)),
  );

  const candidateIds = Array.from(new Set([...roleByUser.keys(), ...uphUserIds]));
  if (candidateIds.length === 0) return zero;

  // 모집단 스코프(operating=실사용자·test=테스트 마커) 교집합 — 라이브 경로와 동일 축.
  const scope = await resolveUserScope(mode, null);
  const scoped = candidateIds.filter((id) => scope.includes(id));
  if (scoped.length === 0) return zero;

  // UPH 전용 후보(현재 이 조직 프로필에 없음)의 role 을 별도로 채운다(super_admin 제외 판정용).
  const missingRoleIds = scoped.filter((id) => !roleByUser.has(id));
  for (let i = 0; i < missingRoleIds.length; i += 100) {
    const chunk = missingRoleIds.slice(i, i + 100);
    if (chunk.length === 0) continue;
    const { data: extraProfs, error: eErr } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,role")
      .in("user_id", chunk);
    if (eErr) throw new Error(eErr.message);
    for (const p of (extraProfs ?? []) as Array<{ user_id: string; role: string | null }>) {
      roleByUser.set(p.user_id, p.role);
    }
  }
  const eligible = scoped.filter((id) => roleByUser.get(id) !== SUPER_ADMIN_ROLE);
  if (eligible.length === 0) return zero;

  const resolved = await resolvePositionAtBatch({
    userIds: eligible,
    targetWeekStart: period.asOfWeekStart,
    organization,
  });

  let teamLeaderCount = 0;
  let ambassadorCount = 0;
  let regularCrewCount = 0;
  let partLeaderCount = 0;
  let agentCount = 0;
  for (const id of eligible) {
    const r = resolved.get(id);
    if (!r || (r.source !== "override" && r.source !== "uph")) continue; // membership/none = 제외
    switch (r.statusLabel) {
      case "팀장":
        teamLeaderCount++;
        break;
      case "앰배서더":
        ambassadorCount++;
        break;
      case "심화(파트장)":
        partLeaderCount++;
        break;
      case "심화(에이전트)":
        agentCount++;
        break;
      case "일반":
      case "크루":
        regularCrewCount++;
        break;
      default:
        break;
    }
  }
  return { teamLeaderCount, ambassadorCount, regularCrewCount, partLeaderCount, agentCount };
}

// 로스터 판정 단일 진입점 — period.rosterSource 로 원천만 갈리고, 이후 라벨링·버킷팅·DTO 조립은
//   호출부(loadClubCurrentSummary) 한 경로다(요구 11).
async function buildClubRoleCounts(
  organization: OrganizationSlug,
  mode: ScopeMode,
  period: HalfPeriodMeta,
): Promise<RoleCounts | null> {
  if (period.rosterSource === "unavailable") return null;
  if (period.rosterSource === "live") return buildClubRoleCountsLive(organization, mode);
  return buildClubRoleCountsHistorical(organization, mode, period);
}

function sumOrNull(values: Array<number | null>): number | null {
  if (values.every((v) => v == null)) return null;
  return values.reduce((sum: number, v) => sum + (v ?? 0), 0);
}

// 상위 목록 요약 로드. orgs 미지정 시 전 조직. halfKey 미지정 시 현재 반기(= period 입력의
//   특수 케이스일 뿐 — 별도 경로 아님).
export async function loadClubCurrentSummary(opts: {
  mode?: ScopeMode;
  orgs?: OrganizationSlug[];
  today?: string;
  halfKey?: string;
} = {}): Promise<ClubCurrentSummaryResponse> {
  const mode = opts.mode ?? "operating";
  const orgs = opts.orgs ?? [...ORGANIZATIONS];
  const today = opts.today;
  const todayIso = today ?? getCurrentActivityDateIso();
  const halfKey = opts.halfKey ?? halfKeyForDate(todayIso);

  const period = await resolveHalfPeriod({ halfKey, today });

  // 구조 숫자(teamEntity·part) — 현재 반기는 종전 함수를 그대로 호출(byte-identical), 과거 반기는
  //   halfKey 파라미터화 버전을 쓴다. structureSource==="unavailable" 이면 조회 자체를 생략한다.
  let structByOrg = new Map<string, { teamEntityCount: number; partCount: number }>();
  let structureTotals = { totalClubs: 0, totalTeams: 0, totalParts: 0 };
  if (period.isCurrentHalf) {
    const structure = await loadCurrentClubStructure(mode, today);
    structByOrg = new Map(structure.perOrg.map((r) => [r.orgSlug, r]));
    structureTotals = structure.totals;
  } else if (period.structureSource !== "unavailable") {
    const structure = await loadClubStructure({
      halfKey: period.period,
      asOfWeekId: period.asOfWeekId,
      mode,
      today,
    });
    structByOrg = new Map(structure.perOrg.map((r) => [r.orgSlug, r]));
    structureTotals = structure.totals;
  }

  const rows: ClubCurrentSummaryRow[] = await Promise.all(
    orgs.map(async (org) => {
      const roleCounts = await buildClubRoleCounts(org, mode, period);
      const struct = structByOrg.get(org) ?? { teamEntityCount: 0, partCount: 0 };
      const teamEntityCount = period.structureSource === "unavailable" ? null : struct.teamEntityCount;
      const partCount = period.structureSource === "unavailable" ? null : struct.partCount;

      if (roleCounts === null) {
        return {
          clubId: org,
          clubSlug: org,
          clubName: organizationLabelKo(org),
          staffCount: null,
          teamLeaderCount: null,
          teamEntityCount,
          ambassadorCount: null,
          clubbingCount: null,
          regularCrewCount: null,
          advancedCrewCount: null,
          partCount,
          partLeaderCount: null,
          agentCount: null,
        } satisfies ClubCurrentSummaryRow;
      }

      const advancedCrewCount = roleCounts.partLeaderCount + roleCounts.agentCount;
      const clubbingCount = roleCounts.regularCrewCount + advancedCrewCount;
      // "팀 수" 표시값 = 팀장 인원 수(사람). 운영진 = 팀장 + 앰배서더.
      const teamLeaderCount = roleCounts.teamLeaderCount;
      const staffCount = teamLeaderCount + roleCounts.ambassadorCount;
      const row: ClubCurrentSummaryRow = {
        clubId: org,
        clubSlug: org,
        clubName: organizationLabelKo(org),
        staffCount,
        teamLeaderCount,
        teamEntityCount,
        ambassadorCount: roleCounts.ambassadorCount,
        clubbingCount,
        regularCrewCount: roleCounts.regularCrewCount,
        advancedCrewCount,
        partCount, // 상단 '전체 파트 수'와 동일 SoT(그 asOf 주차 <운용> 파트)
        partLeaderCount: roleCounts.partLeaderCount,
        agentCount: roleCounts.agentCount,
      };
      // 개발 검증 — 세 등식 불일치 시 경고(운영 화면은 값 그대로 노출·숫자 보정 금지).
      const v = validateClubSummary(row);
      if (!v.staffValid || !v.clubbingValid || !v.advancedValid) {
        console.warn("[club-summary] 등식 불일치", org, period.period, v, row);
      }
      return row;
    }),
  );

  // 합계 = 각 클럽 행 값의 합(non-null 만). 로스터는 organization_slug 단일값이라 사용자가 여러
  //   클럽에 중복 소속되지 않는다 → 행 합계 == 전체 고유 인원 수.
  const totals: ClubCurrentSummaryTotals = {
    staffCount: sumOrNull(rows.map((r) => r.staffCount)),
    teamLeaderCount: sumOrNull(rows.map((r) => r.teamLeaderCount)),
    teamEntityCount: sumOrNull(rows.map((r) => r.teamEntityCount)),
    ambassadorCount: sumOrNull(rows.map((r) => r.ambassadorCount)),
    clubbingCount: sumOrNull(rows.map((r) => r.clubbingCount)),
    regularCrewCount: sumOrNull(rows.map((r) => r.regularCrewCount)),
    advancedCrewCount: sumOrNull(rows.map((r) => r.advancedCrewCount)),
    partCount: sumOrNull(rows.map((r) => r.partCount)),
    partLeaderCount: sumOrNull(rows.map((r) => r.partLeaderCount)),
    agentCount: sumOrNull(rows.map((r) => r.agentCount)),
  };

  return {
    asOf: period.asOfDate ?? todayIso,
    currentWeekLabel: period.weekLabel ?? "-",
    structureTotals,
    rows,
    totals,
    period,
  };
}
