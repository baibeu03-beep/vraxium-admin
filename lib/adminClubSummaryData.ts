import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadCurrentWeekOverrideLabels } from "@/lib/positionResolver";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import {
  ORGANIZATIONS,
  organizationLabelKo,
  type OrganizationSlug,
} from "@/lib/organizations";
import { SUPER_ADMIN_EXCLUDE_OR } from "@/lib/superAdmins";
import { resolveUserScope } from "@/lib/userScope";
import { memberStatusLabel } from "@/lib/adminMembersTypes";
import type { ScopeMode } from "@/lib/userScopeShared";
import {
  loadCurrentClubStructure,
  resolveCurrentWeekInfo,
} from "@/lib/adminTeamHalvesData";

// ── 클럽 목록(상위 페이지) 요약 — 현재 접속 시점(Asia/Seoul) 기준 클럽별 현황 ──────────
//
//   `/admin/team-parts/info` 상위 목록 표의 각 행(클럽 1개). 모든 값 = **현재 접속 시점(asOf) 기준**
//   (상세 페이지의 `해당 시기` select 와 무관).
//
//   두 계열의 원천 — 각자의 SoT 를 그대로 파생(별도 재집계 금지):
//     · **구조 숫자(teamEntityCount·partCount)** = `loadCurrentClubStructure`(상단 요약 '전체 팀/파트 수'
//       와 **동일 함수**). ∴ SUM(rows.partCount) === structureTotals.totalParts,
//       SUM(rows.teamEntityCount) === structureTotals.totalTeams 가 항상 성립한다.
//       partCount = "현재 소속 멤버 ≥1 활성 파트" 수(카탈로그 레코드 수 아님·멤버 0 파트 제외).
//     · **역할 기반 사람 수(운영진/팀장/앰배서더/클러빙/정규·심화/파트장/에이전트)** = 라이브 로스터
//       (user_profiles ∩ resolveUserScope(mode) − super_admin, 등급=user_memberships). 주차 휴식 포함.
//
//   ⚠ 헤더 "팀 수" 컬럼의 표시값 = **teamLeaderCount(role=team_leader 인원 수)** — 팀 entity 수 아님.
//     `운영진 = 팀장 수 + 앰배서더` 등식은 사람 수 기준에서만 성립. 실제 팀 entity 수는 teamEntityCount 로
//     별도 노출(상단 '전체 팀 수'와 동일 SoT). 두 값은 서로 다른 개념 — 섞어 계산하지 않는다.
//
//   mode/org 분기 없음 — 일반/test/actAs/demo 모든 경로가 이 동일 함수·동일 DTO 를 쓴다(context 만 전달).

export type ClubCurrentSummaryRow = {
  clubId: string; // = 조직 slug(안정 식별자). 상세 라우팅 키.
  clubSlug: string; // = clubId (표시용 별칭)
  clubName: string; // 한글 클럽명

  staffCount: number; // 운영진 = 팀장 수 + 앰배서더
  teamLeaderCount: number; // 헤더 "팀 수" 표시값 — role=team_leader 인원 수(사람, entity 아님)
  teamEntityCount: number; // 실제 팀 entity 수(현재 반기 활성·스코프). 상단 '전체 팀 수'와 동일 SoT
  ambassadorCount: number; // 앰배서더

  clubbingCount: number; // 클러빙 = 정규 + 심화
  regularCrewCount: number; // 정규 크루(일반/크루)
  advancedCrewCount: number; // 심화 크루 = 파트장 + 에이전트

  partCount: number; // 파트 수(현재 소속 멤버 ≥1 활성 파트). 상단 '전체 파트 수'와 동일 SoT
  partLeaderCount: number; // 심화(파트장) 인원 수
  agentCount: number; // 심화(에이전트) 인원 수
};

export type ClubCurrentSummaryTotals = Omit<
  ClubCurrentSummaryRow,
  "clubId" | "clubSlug" | "clubName"
>;

export type ClubCurrentSummaryResponse = {
  asOf: string; // 현재 접속 시점 date-only ISO(Asia/Seoul)
  currentWeekLabel: string; // "[26년, 여름 시즌, 3주차]" (없으면 "-")
  // 상단 요약 구조 합계(SoT). SUM(rows.partCount)===totalParts, SUM(rows.teamEntityCount)===totalTeams.
  structureTotals: { totalClubs: number; totalTeams: number; totalParts: number };
  rows: ClubCurrentSummaryRow[];
  totals: ClubCurrentSummaryTotals;
};

// 클럽 표시명 = lib/organizations 단일 SoT(organizationLabelKo). 여기서 한글을 재작성하지 않는다.

// 순수 검증 함수 — 세 등식 성립 여부. 개발/검증에서 불일치 탐지용(숫자 보정 금지).
export function validateClubSummary(row: {
  staffCount: number;
  teamLeaderCount: number;
  ambassadorCount: number;
  clubbingCount: number;
  regularCrewCount: number;
  advancedCrewCount: number;
  partLeaderCount: number;
  agentCount: number;
}): { staffValid: boolean; clubbingValid: boolean; advancedValid: boolean } {
  return {
    staffValid: row.staffCount === row.teamLeaderCount + row.ambassadorCount,
    clubbingValid:
      row.clubbingCount === row.regularCrewCount + row.advancedCrewCount,
    advancedValid:
      row.advancedCrewCount === row.partLeaderCount + row.agentCount,
  };
}

// 한 조직의 라이브 로스터 → 역할별 인원 수. userId 기준 중복 없음(user_profiles 는 user 당 1행).
async function buildClubRoleCounts(
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

// 상위 목록 요약 로드. orgs 미지정 시 전 조직. 모든 값 = 현재 접속 시점 기준.
export async function loadClubCurrentSummary(opts: {
  mode?: ScopeMode;
  orgs?: OrganizationSlug[];
  today?: string;
} = {}): Promise<ClubCurrentSummaryResponse> {
  const mode = opts.mode ?? "operating";
  const orgs = opts.orgs ?? [...ORGANIZATIONS];
  const today = opts.today;
  const asOf = today ?? getCurrentActivityDateIso();

  // 날짜·주차 + 구조 숫자(teamEntity·part) — 상단 요약과 **동일 SoT** 함수에서 파생.
  const [week, structure] = await Promise.all([
    resolveCurrentWeekInfo(today),
    loadCurrentClubStructure(mode, today),
  ]);
  const currentWeekLabel = week.currentWeek?.label ?? "-";
  const structByOrg = new Map(structure.perOrg.map((r) => [r.orgSlug, r]));

  const rows: ClubCurrentSummaryRow[] = await Promise.all(
    orgs.map(async (org) => {
      const roleCounts = await buildClubRoleCounts(org, mode);
      const struct = structByOrg.get(org) ?? { teamEntityCount: 0, partCount: 0 };
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
        teamEntityCount: struct.teamEntityCount,
        ambassadorCount: roleCounts.ambassadorCount,
        clubbingCount,
        regularCrewCount: roleCounts.regularCrewCount,
        advancedCrewCount,
        partCount: struct.partCount, // 상단 '전체 파트 수'와 동일 SoT(멤버 ≥1 활성 파트)
        partLeaderCount: roleCounts.partLeaderCount,
        agentCount: roleCounts.agentCount,
      };
      // 개발 검증 — 세 등식 불일치 시 경고(운영 화면은 값 그대로 노출·숫자 보정 금지).
      const v = validateClubSummary(row);
      if (!v.staffValid || !v.clubbingValid || !v.advancedValid) {
        console.warn("[club-summary] 등식 불일치", org, v, row);
      }
      return row;
    }),
  );

  // 합계 = 각 클럽 행 값의 합. 로스터는 organization_slug 단일값이라 사용자가 여러 클럽에 중복 소속되지
  //   않는다 → 행 합계 == 전체 고유 인원 수. 구조 합계(part/teamEntity)는 structureTotals 와 동일.
  const totals: ClubCurrentSummaryTotals = {
    staffCount: 0,
    teamLeaderCount: 0,
    teamEntityCount: 0,
    ambassadorCount: 0,
    clubbingCount: 0,
    regularCrewCount: 0,
    advancedCrewCount: 0,
    partCount: 0,
    partLeaderCount: 0,
    agentCount: 0,
  };
  for (const r of rows) {
    totals.staffCount += r.staffCount;
    totals.teamLeaderCount += r.teamLeaderCount;
    totals.teamEntityCount += r.teamEntityCount;
    totals.ambassadorCount += r.ambassadorCount;
    totals.clubbingCount += r.clubbingCount;
    totals.regularCrewCount += r.regularCrewCount;
    totals.advancedCrewCount += r.advancedCrewCount;
    totals.partCount += r.partCount;
    totals.partLeaderCount += r.partLeaderCount;
    totals.agentCount += r.agentCount;
  }

  return {
    asOf,
    currentWeekLabel,
    structureTotals: structure.totals,
    rows,
    totals,
  };
}
