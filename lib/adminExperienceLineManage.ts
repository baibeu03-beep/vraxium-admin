// 실무 경험 [라인 관리] 탭 — 팀 요약 보드 데이터 레이어(read-only).
//
// 팀마다 팀 총괄 라이브 보드(getTeamOverallBoard)를 재사용해 다음을 집계한다:
//   - 개설 완료/필요 상태 = 팀 총괄 status(opened ↔ 개설 완료, 신청/검수만 있음 ↔ 개설 필요).
//   - 파트별 [개설 신청] 여부(파트 신청 라이브).
//   - 라인(도출/분석/견문/관리/확장)별 강화 결과(전체/성공/미이행/평점 미비).
//   - 확장 라인은 확장 주간(cluster4_experience_extension_periods)일 때만 집계, 아니면 "해당 기간 아님".
//
// ⚠ 표시 전용 — cluster4_lines/snapshot 생성·조회·고객 반영 로직 무관. demoUserId 경로 없음(org·주차 스코프).
//   대상 주차 = 개설 대상(금요일 경계, openable) — 상태창(opening-status)·팀 총괄과 동일 SoT.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  describeWeekByStartMs,
  getOpenableWeekStartMs,
} from "@/lib/cluster4WeekPolicy";
import { listTeams } from "@/lib/adminExperienceLineData";
import { getTeamOverallBoard } from "@/lib/adminExperienceTeamOverall";
import { resolveUserScope, type ScopeMode } from "@/lib/userScope";
import { memberStatusLabel } from "@/lib/adminMembersTypes";
import { EXPERIENCE_OVERALL_CATEGORIES } from "@/lib/experienceTeamOverallTypes";
import type {
  ExperienceLineManageSummary,
  LineManageCategoryStat,
  LineManageHeadcount,
  LineManageTeam,
  LineManageTeamLeader,
} from "@/lib/experienceLineManageTypes";

const EMPTY_TOTALS = { teamCount: 0, openedCount: 0, neededCount: 0 };

// 팀 인원 요약 — 평가 대상 크루 명부(getTeamOverallBoard 코호트와 동일 필터, 단 휴식/중단 상태도 포함).
//   상태(활동/휴식/중단) 분류는 명부 전체를 분할하고, 등급(일반/파트장/에이전트)도 명부 전체를 분할한다.
//   ⚠ 현재 멤버십(is_current 우선) 기준 — 본 허브의 팀 총괄/파트장 입력과 동일 소스. 주차 강화 결과(라인별)
//      는 활동 크루만(코호트), 인원 요약 '전체'는 휴식/중단 포함이라 라인 '전체'(=활동)와 다를 수 있다.
const ROSTER_EXCLUDED_PARTS = new Set<string>(["일반"]);

function emptyHeadcount(): LineManageHeadcount {
  return { total: 0, active: 0, rest: 0, suspended: 0, normal: 0, partLeader: 0, agent: 0 };
}

// membership_state → 활동/휴식/중단. (실데이터: active·weekly_rest·일반·null. weekly_rest=휴식,
//  정지류=중단, 그 외(active·일반·null)=활동.) 하드코딩 팀 없이 상태 문자열만으로 분류.
function classifyState(state: string | null): "active" | "rest" | "suspended" {
  const s = (state ?? "").trim().toLowerCase();
  if (!s) return "active";
  if (s.includes("rest") || s === "휴식") return "rest";
  if (["suspended", "paused", "stopped", "inactive", "중단", "중지"].includes(s))
    return "suspended";
  return "active";
}

// 첫 비어있지 않은 문자열(학적 폴백 체인용). cluster4WeeklyPeopleData.preferString 과 동일 의도.
function preferString(...values: Array<string | null | undefined>): string | null {
  for (const v of values) if (typeof v === "string" && v.trim() !== "") return v;
  return null;
}

// org 전체 팀의 인원 요약 + 팀장 정보를 1회 스캔으로 산출 — 팀명 → {headcount, leader}.
//   팀장(label="팀장")은 명부(crew) 집계에서 제외하되, 카드 표시용으로 팀별 1명을 잡아둔다.
//   학교/학과는 user_educations(canonical)→user_profiles 폴백(cluster4WeeklyPeopleData 와 동일 규칙).
async function loadOrgTeamRoster(
  organization: string,
  mode: ScopeMode = "operating",
): Promise<{
  headcounts: Map<string, LineManageHeadcount>;
  leaders: Map<string, LineManageTeamLeader>;
}> {
  const headcounts = new Map<string, LineManageHeadcount>();
  const leaders = new Map<string, LineManageTeamLeader>();
  const { data: profiles } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,role,display_name,school_name,department_name")
    .eq("organization_slug", organization);
  type Prof = {
    user_id: string;
    role: string | null;
    display_name: string | null;
    school_name: string | null;
    department_name: string | null;
  };
  const profs = (profiles ?? []) as Prof[];
  if (profs.length === 0) return { headcounts, leaders };
  const ids = profs.map((p) => p.user_id);
  const profById = new Map(profs.map((p) => [p.user_id, p]));

  const [memRes, scope] = await Promise.all([
    supabaseAdmin
      .from("user_memberships")
      .select("user_id,team_name,part_name,membership_level,membership_state,is_current")
      .in("user_id", ids),
    // 모집단 스코프(operating=실사용자만 / test=테스트 유저만) — userScope resolver(SoT=test_user_markers).
    // org 필터는 위 profiles 조회가 적용하므로 scope.org=null(includes 판정은 org 무관).
    resolveUserScope(mode, null),
  ]);

  type Mem = {
    user_id: string;
    team_name: string | null;
    part_name: string | null;
    membership_level: string | null;
    membership_state: string | null;
    is_current: boolean | null;
  };
  // 현재 멤버십 1건(loadTeamMembersWithLeaders 와 동일 규칙: 첫 행, is_current 발견 시 승격).
  const memMap = new Map<string, Mem>();
  for (const m of (memRes.data ?? []) as Mem[]) {
    const ex = memMap.get(m.user_id);
    if (!ex || (m.is_current && !ex.is_current)) memMap.set(m.user_id, m);
  }

  // 팀명 → 팀장 user_id(팀별 첫 번째). 학적은 아래에서 일괄 조회 후 채운다.
  const leaderUserByTeam = new Map<string, string>();

  for (const p of profs) {
    // 모집단 스코프: operating=실사용자만 / test=테스트 유저만 (구 무조건 제외 버그 해소).
    if (!scope.includes(p.user_id)) continue;
    const m = memMap.get(p.user_id);
    if (!m || !m.team_name) continue;
    const label = memberStatusLabel(roleById(profById, p.user_id), m.membership_level);
    if (label === "팀장") {
      // 팀장은 crew 명부 집계 제외 — 카드 표시용으로 팀별 1명만 잡는다.
      if (!leaderUserByTeam.has(m.team_name)) leaderUserByTeam.set(m.team_name, p.user_id);
      continue;
    }
    const part = m.part_name?.trim() ?? "";
    if (!part || ROSTER_EXCLUDED_PARTS.has(part)) continue;
    let statusKey: "normal" | "partLeader" | "agent" | null = null;
    if (label === "일반") statusKey = "normal";
    else if (label === "심화(파트장)") statusKey = "partLeader";
    else if (label === "심화(에이전트)") statusKey = "agent";
    if (!statusKey) continue; // 관리자/크루(등급미상) 등은 명부 제외(팀 총괄 코호트와 동일).

    const hc = headcounts.get(m.team_name) ?? emptyHeadcount();
    hc.total++;
    hc[statusKey]++;
    hc[classifyState(m.membership_state)]++;
    headcounts.set(m.team_name, hc);
  }

  // 팀장 학적(user_educations canonical → user_profiles 폴백). 대표 학력 = is_primary→sort_order→updated_at.
  const leaderIds = Array.from(new Set(leaderUserByTeam.values()));
  const eduByUser = new Map<
    string,
    { school: string | null; major: string | null }
  >();
  if (leaderIds.length > 0) {
    const { data: eduRows } = await supabaseAdmin
      .from("user_educations")
      .select("user_id,school_name,major_name_1,is_primary,sort_order,updated_at")
      .in("user_id", leaderIds);
    type Edu = {
      user_id: string;
      school_name: string | null;
      major_name_1: string | null;
      is_primary: boolean | null;
      sort_order: number | null;
      updated_at: string | null;
    };
    const grouped = new Map<string, Edu[]>();
    for (const e of (eduRows ?? []) as Edu[]) {
      const list = grouped.get(e.user_id) ?? [];
      list.push(e);
      grouped.set(e.user_id, list);
    }
    for (const [uid, list] of grouped) {
      const primary = [...list].sort((a, b) => {
        const pd = Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary));
        if (pd !== 0) return pd;
        const sd =
          (a.sort_order ?? Number.MAX_SAFE_INTEGER) -
          (b.sort_order ?? Number.MAX_SAFE_INTEGER);
        if (sd !== 0) return sd;
        return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
      })[0];
      eduByUser.set(uid, {
        school: primary?.school_name ?? null,
        major: primary?.major_name_1 ?? null,
      });
    }
  }

  for (const [teamName, uid] of leaderUserByTeam) {
    const p = profById.get(uid);
    const edu = eduByUser.get(uid);
    leaders.set(teamName, {
      name: p?.display_name?.trim() || "(이름 없음)",
      school: preferString(edu?.school, p?.school_name),
      department: preferString(edu?.major, p?.department_name),
    });
  }

  return { headcounts, leaders };
}

// profById 기반 role lookup 헬퍼(가독성용).
function roleById(
  profById: Map<string, { role: string | null }>,
  userId: string,
): string | null {
  return profById.get(userId)?.role ?? null;
}

// "YYYY-MM-DD" → 주차 시작 ms(UTC 자정). cluster4WeekPolicy 내부 toMs 와 동일 기준.
function startDateToMs(iso: string): number {
  return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
}

// weekIdParam:
//   - 미지정(기본) → 개설 대상 주차(금요일 경계, openable). 상태창/팀 총괄과 동일 SoT.
//   - 지정(라인 관리 탭 주차 드롭다운) → 해당 weeks.id 의 주차로 집계. (snapshot/DTO 무관 — read-only 확장)
export async function getExperienceLineManageSummary(
  organization: string,
  weekIdParam?: string | null,
  mode: ScopeMode = "operating",
): Promise<ExperienceLineManageSummary> {
  let weekId: string | null = null;
  let targetWeek: ExperienceLineManageSummary["targetWeek"] = null;

  if (weekIdParam) {
    // 지정 주차 — weeks.start_date 로 시즌/주차 라벨 산출(같은 정책 헬퍼 재사용).
    const { data: wk } = await supabaseAdmin
      .from("weeks")
      .select("id,start_date")
      .eq("id", weekIdParam)
      .maybeSingle();
    const row = wk as { id: string; start_date: string } | null;
    if (row) {
      weekId = row.id;
      const info = describeWeekByStartMs(startDateToMs(row.start_date));
      targetWeek = info
        ? {
            year: info.year,
            seasonName: info.seasonName,
            weekNumber: info.weekNumber,
            startDate: info.weekStart,
            endDate: info.weekEnd,
          }
        : null;
    }
  } else {
    // 개설 대상 주차(금요일 경계, openable).
    const todayIso = new Date().toISOString().slice(0, 10);
    const openableStartMs = getOpenableWeekStartMs(todayIso);
    const targetInfo =
      openableStartMs != null ? describeWeekByStartMs(openableStartMs) : null;
    if (targetInfo) {
      targetWeek = {
        year: targetInfo.year,
        seasonName: targetInfo.seasonName,
        weekNumber: targetInfo.weekNumber,
        startDate: targetInfo.weekStart,
        endDate: targetInfo.weekEnd,
      };
      // 대상 주차 weeks.id(UUID). (opening-status 와 동일 해석)
      const { data: weekRow } = await supabaseAdmin
        .from("weeks")
        .select("id")
        .eq("iso_year", targetInfo.isoYear)
        .eq("iso_week", targetInfo.isoWeek)
        .maybeSingle();
      weekId = (weekRow as { id: string } | null)?.id ?? null;
    }
  }

  if (!weekId) {
    return {
      targetWeek,
      extensionActive: false,
      extensionKind: null,
      totals: { ...EMPTY_TOTALS },
      teams: [],
    };
  }

  // org 의 활성 팀(동적, 하드코딩 없음). 팀 스코프(operating=운영 팀만 / test=(T) 팀만)는
  // listTeams 가 filterTeamsByScope 단일 helper 로 적용한다(화면별 임시 필터 제거).
  const teamList = await listTeams(organization, mode);
  const [boards, roster] = await Promise.all([
    Promise.all(
      teamList.map((t) =>
        getTeamOverallBoard(organization, weekId, t.id, t.teamName, mode),
      ),
    ),
    loadOrgTeamRoster(organization, mode),
  ]);
  const { headcounts, leaders } = roster;

  let extensionActive = false;
  let extensionKind: "online" | "offline" | null = null;

  const teams: LineManageTeam[] = teamList.map((team, i) => {
    const board = boards[i];
    if (board.extensionActive) {
      extensionActive = true;
      extensionKind = board.extensionKind;
    }

    // 그리드 모델(크루 × 5 카테고리) — 모든 파트의 크루를 평탄화. 각 크루는 5개 셀 전부 보유.
    const crews = board.parts.flatMap((p) => p.crews);
    const total = crews.length;

    const categories: LineManageCategoryStat[] = EXPERIENCE_OVERALL_CATEGORIES.map(
      (cat) => {
        // 확장: 확장 주간이 아니면 집계하지 않고 "해당 기간 아님" 으로 표시.
        const applicable = cat.key === "extension" ? board.extensionActive : true;
        if (!applicable) {
          return {
            category: cat.key,
            label: cat.label,
            applicable: false,
            total: 0,
            success: 0,
            unchecked: 0,
            lowScore: 0,
          };
        }
        let unchecked = 0;
        let lowScore = 0;
        for (const crew of crews) {
          const cell = crew.cells[cat.key];
          if (!cell.checked) unchecked++;
          else if (cell.score <= 3) lowScore++;
        }
        return {
          category: cat.key,
          label: cat.label,
          applicable: true,
          total,
          success: total - unchecked - lowScore,
          unchecked,
          lowScore,
        };
      },
    );

    const opened = board.status === "opened";
    return {
      teamId: team.id,
      teamName: team.teamName,
      opened,
      statusLabel: opened ? "개설 완료" : "개설 필요",
      // 파트별 [개설 신청] 여부(라이브). 실제 파트 매핑 기준 — 하드코딩 없음.
      parts: board.parts.map((p) => ({
        partName: p.partName,
        submitted: p.submitted,
      })),
      headcount: headcounts.get(team.teamName) ?? emptyHeadcount(),
      teamLeader: leaders.get(team.teamName) ?? null,
      categories,
    };
  });

  const openedCount = teams.filter((t) => t.opened).length;
  return {
    targetWeek,
    extensionActive,
    extensionKind,
    totals: {
      teamCount: teams.length,
      openedCount,
      neededCount: teams.length - openedCount,
    },
    teams,
  };
}
