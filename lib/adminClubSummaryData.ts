import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import { ORGANIZATIONS, type OrganizationSlug } from "@/lib/organizations";
import { SUPER_ADMIN_EXCLUDE_OR } from "@/lib/superAdmins";
import { resolveUserScope } from "@/lib/userScope";
import { memberStatusLabel } from "@/lib/adminMembersTypes";
import { resolveEffectiveScopeMode } from "@/lib/cluster4ExperienceTestScope";
import type { ScopeMode } from "@/lib/userScopeShared";
import {
  loadHalfRows,
  loadTeamPartsCurrentSummary,
  resolveCurrentHalfKey,
} from "@/lib/adminTeamHalvesData";

// ── 클럽 목록(상위 페이지) 요약 — 현재 접속 시점(Asia/Seoul) 기준 클럽별 현황 ──────────
//
//   `/admin/team-parts/info` 상위 목록 표의 각 행(클럽 1개)에 들어가는 10개 컬럼.
//   ⚠ 모든 값은 **현재 접속 시점(asOf) 기준**이다 — 상세 페이지의 `해당 시기`(selectedHalf)
//     select 와 무관하다. 과거 반기를 선택해도 이 목록 값은 변하지 않는다.
//
//   집계 원천(두 계열):
//     · 사람 수(운영진/팀장/앰배서더/클러빙/정규/심화/파트장/에이전트) = 라이브 로스터
//       = user_profiles(organization_slug) ∩ resolveUserScope(mode) − super_admin.
//       등급(membership_level) = user_memberships(is_current 우선). 역할 라벨 = memberStatusLabel.
//       ⚠ "주차 휴식"(membership_state='rest') 크루도 **포함**한다(현재 소속이므로 제외하지 않음).
//         완전 탈퇴/소속 종료/삭제는 애초에 org 로스터/스코프에 없으므로 자연 제외된다.
//     · 파트 수(파트 entity) = cluster4_team_parts 중 현재 반기 활성·스코프 팀(team_half_id) 소속 행 수.
//       (상단 요약 totalParts 와 동일 규칙을 org 단위로 분해.)
//
//   ⚠ 헤더 "팀 수" 컬럼의 값 = **팀장(운영진 중 role=team_leader) 인원 수**이지 팀 entity 수가 아니다.
//     실측상 `운영진 = 팀 수 + 앰배서더` 등식은 "팀 수"가 사람(팀장) 수일 때만 성립한다(팀 entity 수로는
//     깨짐). 사용자 요청대로 헤더 문구는 "팀 수"로 유지하되 내부 값/필드 의미는 팀장 인원 수다.
//     → 팀 entity 개수와 사람 수를 섞어 계산해 억지로 등식을 맞추지 않는다.
//
//   mode/org 분기 없음 — 일반/test/actAs/demo 모든 경로가 이 동일 함수·동일 DTO 를 쓴다(context 만 전달).

export type ClubCurrentSummaryRow = {
  clubId: string; // = 조직 slug(안정 식별자). 상세 라우팅 키.
  clubSlug: string; // = clubId (표시용 별칭, 현재 동일)
  clubName: string; // 한글 클럽명

  staffCount: number; // 운영진 = 팀장 수 + 앰배서더
  teamCount: number; // 헤더 "팀 수" — 값은 팀장(role=team_leader) 인원 수(entity 아님)
  ambassadorCount: number; // 앰배서더

  clubbingCount: number; // 클러빙 = 정규 + 심화
  regularCrewCount: number; // 정규 크루(일반/크루)
  advancedCrewCount: number; // 심화 크루 = 파트장 + 에이전트

  partCount: number; // 파트 수(현재 반기 활성·스코프 팀의 cluster4_team_parts 고유 행 수)
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
  rows: ClubCurrentSummaryRow[];
  totals: ClubCurrentSummaryTotals;
};

const CLUB_LABEL: Record<OrganizationSlug, string> = {
  encre: "엥크레",
  oranke: "오랑캐",
  phalanx: "팔랑크스",
};

// 순수 검증 함수 — 세 등식 성립 여부. 개발/검증에서 불일치 탐지용(숫자 보정 금지).
export function validateClubSummary(row: {
  staffCount: number;
  teamCount: number;
  ambassadorCount: number;
  clubbingCount: number;
  regularCrewCount: number;
  advancedCrewCount: number;
  partLeaderCount: number;
  agentCount: number;
}): { staffValid: boolean; clubbingValid: boolean; advancedValid: boolean } {
  return {
    staffValid: row.staffCount === row.teamCount + row.ambassadorCount,
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
  for (const r of roster) {
    const label = memberStatusLabel(r.role, levelByUser.get(r.user_id) ?? null);
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

// 한 조직의 현재 반기 활성·스코프 팀의 파트(entity) 수. 상단 요약 totalParts 의 org 분해판.
async function countCurrentHalfParts(
  organization: OrganizationSlug,
  currentHalfKey: string | null,
  wantQaTest: boolean,
): Promise<number> {
  if (!currentHalfKey) return 0;
  const rows = await loadHalfRows(organization, currentHalfKey, { activeOnly: true });
  const teamHalfIds = rows.filter((r) => r.is_qa_test === wantQaTest).map((r) => r.id);
  if (teamHalfIds.length === 0) return 0;
  // (team_half_id, part_name) UNIQUE → 행 id 기준 중복 없음. teamHalfIds ≤ 10(조직당 최대) — URL 절벽 무관.
  const { data, error } = await supabaseAdmin
    .from("cluster4_team_parts")
    .select("id")
    .in("team_half_id", teamHalfIds);
  if (error) throw new Error(error.message);
  return (data ?? []).length;
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

  // 현재 주차 라벨 + 현재 반기 — 상단 요약과 동일 SoT 재사용(별도 날짜/시즌 계산 금지).
  const [summary, currentHalfKey] = await Promise.all([
    loadTeamPartsCurrentSummary(mode, today),
    resolveCurrentHalfKey(today),
  ]);
  const currentWeekLabel = summary.currentWeek?.label ?? "-";
  const wantQaTest = resolveEffectiveScopeMode(mode) === "test";

  const rows: ClubCurrentSummaryRow[] = await Promise.all(
    orgs.map(async (org) => {
      const [roleCounts, partCount] = await Promise.all([
        buildClubRoleCounts(org, mode),
        countCurrentHalfParts(org, currentHalfKey, wantQaTest),
      ]);
      const advancedCrewCount = roleCounts.partLeaderCount + roleCounts.agentCount;
      const clubbingCount = roleCounts.regularCrewCount + advancedCrewCount;
      // "팀 수" 값 = 팀장 인원 수(사람). 운영진 = 팀장 + 앰배서더.
      const teamCount = roleCounts.teamLeaderCount;
      const staffCount = teamCount + roleCounts.ambassadorCount;
      const row: ClubCurrentSummaryRow = {
        clubId: org,
        clubSlug: org,
        clubName: CLUB_LABEL[org],
        staffCount,
        teamCount,
        ambassadorCount: roleCounts.ambassadorCount,
        clubbingCount,
        regularCrewCount: roleCounts.regularCrewCount,
        advancedCrewCount,
        partCount,
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

  // 합계 = 각 클럽 행의 값 합(요청 사항). 로스터는 organization_slug 단일값이라 사용자가 여러 클럽에
  //   중복 소속되지 않는다 → 행 합계 == 전체 고유 인원 수(중복 없음).
  const totals: ClubCurrentSummaryTotals = {
    staffCount: 0,
    teamCount: 0,
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
    totals.teamCount += r.teamCount;
    totals.ambassadorCount += r.ambassadorCount;
    totals.clubbingCount += r.clubbingCount;
    totals.regularCrewCount += r.regularCrewCount;
    totals.advancedCrewCount += r.advancedCrewCount;
    totals.partCount += r.partCount;
    totals.partLeaderCount += r.partLeaderCount;
    totals.agentCount += r.agentCount;
  }

  return { asOf, currentWeekLabel, rows, totals };
}
