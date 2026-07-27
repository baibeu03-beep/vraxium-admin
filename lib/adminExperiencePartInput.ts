// 실무 경험 파트장 입력 그리드 — 데이터 레이어(신규 전용 저장, standalone).
//
// cluster4_experience_part_submissions(헤더) + cluster4_experience_part_submission_cells(셀)만
// 읽고 쓴다. 기존 experience_drafts/검수/개설/snapshot 과 무연동(이번 phase 신청 저장/취소만).
//
// 크루/파트/상태는 user_profiles(role) + user_memberships(team_name/part_name/membership_level/state)
// 에서 resolve 한다. 클래스 판정은 공통 변환기(resolvePositionLabels) 단일 경로.
// 평가 대상 = 일반/에이전트(파트장·팀장 제외).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { normalizeMemberRole } from "@/lib/adminMembersTypes";
import { loadTeamWeekEffectiveRoster } from "@/lib/adminTeamSelectedWeekSummary";
import { loadEvaluationEligibility } from "@/lib/evaluationEligibility";
import type { OrganizationSlug } from "@/lib/organizations";
import {
  assertUserIdsInScope,
  resolveUserScope,
  type ScopeMode,
} from "@/lib/userScope";
import { assertWeekOpenable } from "@/lib/cluster4OfficialRestWeek";
import { assertExperienceLineOpenable } from "@/lib/experienceLineOpenGate";
import {
  EXPERIENCE_PART_LINE_KEYS,
  normalizePartInputCell,
  type ExperiencePartLineType,
  type PartInputCellDto,
  type PartInputCrew,
  type PartOverallAggregate,
} from "@/lib/experiencePartInputTypes";
import {
  buildLineIdCategoryMap,
  listExperienceLineOptions,
} from "@/lib/adminExperienceLineData";

// ── 실무 경험 주차 로스터(파트 카탈로그·평가 대상 크루 **공통 단일 원천**) ────────────────
//
// ⚠ 2026-07-27 정정. 종전엔 파트 목록만 주차 SoT(listOperatedTeamParts)를 쓰고, 크루 목록은
//   여기서 "현재 멤버십 + 현재 주차 override" 로 후보 풀을 다시 만들었다. 두 판정이 갈려
//   "드롭다운엔 있는데 평가 대상 크루가 없습니다" 가 발생했다(실측: encre 비주얼랩(T) '테스트').
//   이제 파트도 크루도 **선택 주차 effective 배정 결과(loadTeamWeekEffectiveRoster)** 하나만 판다.
//
// 이 로스터에 남는 조건(= 라인 개설 후보 규칙. 파트/크루 양쪽에 **동시에** 적용된다):
//   ① 그 주차 effective 팀 = teamName · 클래스 = 크루 3종(일반/에이전트/파트장)   ← 주차 SoT
//      (그 주차 시즌의 시즌 휴식자는 이 단계에서 이미 빠져 있다 — 팀·파트 미배정으로 본다)
//   ② effective 파트가 실제 파트(미배정·placeholder '일반' 제외)
// 평가 대상(도출/분석/견문 그리드)은 여기서 파트장만 더 뺀다 — isPartLeader.

// 파트가 아닌 placeholder part_name(미배정 기본값). 등급 단어 '일반' 이 part_name 으로 새는 경우 등.
// 실제 파트만 노출하기 위해 파트 목록/크루 목록에서 제외한다.
const EXCLUDED_PART_NAMES = new Set<string>(["일반"]);

export type ExperienceRosterRow = {
  userId: string;
  displayName: string;
  /** 그 주차 effective 파트(비어 있지 않음). */
  partName: string;
  positionCode: string;
  /** 상태 라벨 — 일반/에이전트/파트장. */
  statusLabel: string;
  isPartLeader: boolean;
  /**
   * 실무 평가 가능 모집단(집합 ②) 소속 여부 — 엘리트/바사노스면 false.
   * ⚠ 로스터에서 빼지 않고 플래그로 남긴다. 엘리트 파트장처럼 **평가 대상은 아니지만 평가자 역할은
   *   유지해야 하는** 사람이 있기 때문(팀 총괄 보드 행·관리 라인은 그대로 부여된다).
   */
  isEvaluable: boolean;
};

export type ExperienceWeekRoster = {
  /** 실제로 적용된 주차(요청 weekId 가 선택 불가면 현재 주차 폴백). 달력이 비면 null. */
  weekId: string | null;
  weekStartDate: string | null;
  rows: ExperienceRosterRow[];
};

// positionCode → 화면 상태 라벨. 라벨 문자열이 아니라 코드로만 판정한다(어휘 2종 혼선 차단).
function rosterStatus(code: string): { label: string; isPartLeader: boolean } | null {
  if (code === "regular") return { label: "일반", isPartLeader: false };
  if (code === "advanced_agent") return { label: "에이전트", isPartLeader: false };
  if (code === "advanced_part_leader") return { label: "파트장", isPartLeader: true };
  return null; // 팀장/관리자/앰배서더 등은 애초에 주차 로스터에 없다(방어적 기본값).
}

export async function loadExperienceWeekRoster(
  organization: string,
  teamName: string,
  mode: ScopeMode = "operating",
  weekId?: string | null,
): Promise<ExperienceWeekRoster> {
  const roster = await loadTeamWeekEffectiveRoster({
    organization: organization as OrganizationSlug,
    teamName,
    weekId: weekId ?? null,
    mode,
  });
  if (!roster.week || roster.members.length === 0) {
    return {
      weekId: roster.week?.weekId ?? null,
      weekStartDate: roster.week?.weekStartDate ?? null,
      rows: [],
    };
  }

  // ── 휴식 판정 정책 (2026-07-27 명문화) ───────────────────────────────────────
  //   ① 로스터 판정 기준은 **그 주차의 effective position** 하나뿐이다.
  //   ② 시즌 휴식 제외는 여기서 하지 않는다 — loadTeamWeekEffectiveRoster(공용 SoT)가 이미
  //      "그 주차 시즌의 시즌 휴식자 = 팀·파트 미배정"으로 처리한다(2026-07-27 정책).
  //      화면별로 조건을 덧붙이면 팀 상세와 다시 갈린다 — 절대 재추가하지 말 것.
  //   ③ legacy `user_memberships.membership_state`('rest')는 **로스터 판정에 사용하지 않는다.**
  //      이 값은 주차 개념이 없어 과거 주차 조회에서 "지금 휴식이면 그때도 빠짐"이 된다.
  //   ⚠ membership_state 는 여전히 **쓰기 가능한 자유 입력 필드**다(이력서 카드 편집기 →
  //     adminResumeCardData.MEMBERSHIP_FIELDS, 값 검증 없음). 누군가 'rest' 를 입력해도 이 로스터는
  //     반응하지 않는다. 주차 개념이 있는 휴식은 user_season_statuses / 주차 override 로 표현할 것.

  // 표시 이름 — 목록 정렬 기준(display_name 오름차순)도 여기서 확정한다.
  const ids = roster.members.map((m) => m.userId);
  const nameByUser = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    if (chunk.length === 0) break;
    const { data, error } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,display_name")
      .in("user_id", chunk);
    if (error) throw new Error(error.message);
    for (const p of (data ?? []) as Array<{ user_id: string; display_name: string | null }>) {
      nameByUser.set(p.user_id, p.display_name ?? "");
    }
  }

  // 집합 ② 실무 평가 가능 모집단 — 엘리트/바사노스 축(그 주차 기준). 공통 eligibility 단일 모듈.
  //   ⚠ 여기서 **행을 제거하지 않는다**. 엘리트 파트장은 평가 대상이 아니지만 평가자로 보드에 남아야 한다.
  const evalEligibility = await loadEvaluationEligibility({
    userIds: ids,
    weekStartDate: roster.week.weekStartDate,
    seasonKey: roster.week.seasonKey,
  });

  const rows: ExperienceRosterRow[] = [];
  for (const m of roster.members) {
    const part = m.rawPart?.trim() ?? "";
    if (!part || EXCLUDED_PART_NAMES.has(part)) continue; // 미배정/placeholder '일반'.
    const status = rosterStatus(m.positionCode);
    if (!status) continue;
    rows.push({
      userId: m.userId,
      displayName: nameByUser.get(m.userId) ?? "",
      partName: part,
      positionCode: m.positionCode,
      statusLabel: status.label,
      isPartLeader: status.isPartLeader,
      isEvaluable: evalEligibility.isEvaluable(m.userId),
    });
  }
  rows.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { weekId: roster.week.weekId, weekStartDate: roster.week.weekStartDate, rows };
}

// 평가 대상(도출/분석/견문 그리드) = 실무 평가 가능 모집단(집합 ②) ∩ 평가자 아님(파트장 제외).
//   상태 축(시즌휴식/활동중단/엘리트/바사노스) = isEvaluable · 역할 축 = isPartLeader. 둘을 섞지 않는다.
export function experienceEvaluableRows(
  rows: ReadonlyArray<ExperienceRosterRow>,
): ExperienceRosterRow[] {
  return rows.filter((r) => !r.isPartLeader && r.isEvaluable);
}

// 팀 총괄 보드 행 = 평가 대상 ∪ 평가자 역할자(파트장). 엘리트/바사노스 파트장은 여기 남는다.
export function experienceBoardRows(
  rows: ReadonlyArray<ExperienceRosterRow>,
): ExperienceRosterRow[] {
  return rows.filter((r) => r.isEvaluable || r.isPartLeader);
}

// 평가 대상 크루가 1명 이상인 파트 = 이 화면의 <운용> 파트. 드롭다운 옵션 SoT.
//   ⚠ "드롭다운엔 있는데 평가 대상 크루 0명" 이 구조적으로 불가능해진다 — 같은 배열에서 파생하기 때문.
export function experienceEvaluablePartNames(
  rows: ReadonlyArray<ExperienceRosterRow>,
): string[] {
  return Array.from(new Set(experienceEvaluableRows(rows).map((r) => r.partName))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function toPartInputCrew(r: ExperienceRosterRow): PartInputCrew {
  return {
    userId: r.userId,
    displayName: r.displayName,
    partName: r.partName,
    statusLabel: r.statusLabel,
  };
}

// ── Actor context (기본 팀탭/파트 결정) ──

export async function resolveActorContext(
  userId: string,
): Promise<{
  role: string | null;
  teamName: string | null;
  partName: string | null;
  memberRole: "team_leader" | "part_leader" | "agent" | "member";
}> {
  const { data: prof } = await supabaseAdmin
    .from("user_profiles")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();
  const { data: mems } = await supabaseAdmin
    .from("user_memberships")
    .select("team_name,part_name,membership_level,is_current")
    .eq("user_id", userId);
  const rows = (mems ?? []) as Array<{
    team_name: string | null;
    part_name: string | null;
    membership_level: string | null;
    is_current: boolean | null;
  }>;
  const chosen = rows.find((r) => r.is_current) ?? rows[0] ?? null;
  const role = (prof as { role: string | null } | null)?.role ?? null;
  return {
    role,
    teamName: chosen?.team_name ?? null,
    partName: chosen?.part_name ?? null,
    memberRole: normalizeMemberRole(role, chosen?.membership_level ?? null),
  };
}

// ── Parts / Crews ──

// 실무 경험 라인 개설 화면의 파트 드롭다운 — **평가 대상 크루가 1명 이상인 파트**만.
//
// ⚠ 팀 상세의 <운용> 파트(listOperatedTeamParts = 그 주차 배정 크루 ≥1, 파트장·휴식자 포함)와는
//   모수가 한 겹 다르다. 이 화면이 물어보는 건 "어떤 파트가 존재하는가"가 아니라 "어떤 파트를
//   지금 신청할 수 있는가"이고, 답은 평가 대상 크루 목록과 **같은 배열**에서 나와야 한다.
//   두 값 모두 loadExperienceWeekRoster 하나에서 파생하므로
//   "드롭다운엔 있는데 평가 대상 크루가 없습니다" 상태는 구조적으로 발생할 수 없다.
export async function listTeamParts(
  organization: string,
  teamName: string,
  mode: ScopeMode = "operating",
  weekId?: string | null,
): Promise<string[]> {
  const roster = await loadExperienceWeekRoster(organization, teamName, mode, weekId);
  return experienceEvaluablePartNames(roster.rows);
}

// 파트의 평가 대상 크루(파트장/팀장·시즌 휴식·미배정 제외).
//   weekId 미지정 = 현재 주차(체크 보드 등 "현재 시점" 호출부의 종전 동작 유지).
export async function listPartCrews(
  organization: string,
  teamName: string,
  part: string,
  mode: ScopeMode = "operating",
  weekId?: string | null,
): Promise<PartInputCrew[]> {
  const roster = await loadExperienceWeekRoster(organization, teamName, mode, weekId);
  return experienceEvaluableRows(roster.rows)
    .filter((r) => r.partName === part)
    .map(toPartInputCrew);
}

// 팀 전체(모든 파트 합집합)의 평가 대상 크루 — listPartCrews 와 동일 판정. 파트 필터만 없앤 형태.
//   팀 총괄(part_name=NULL) 스코프의 "체크 대상자 로스터" 로 쓴다.
export async function listTeamCrews(
  organization: string,
  teamName: string,
  mode: ScopeMode = "operating",
  weekId?: string | null,
): Promise<PartInputCrew[]> {
  const roster = await loadExperienceWeekRoster(organization, teamName, mode, weekId);
  return experienceEvaluableRows(roster.rows).map(toPartInputCrew);
}

// ── 신청 조회/저장/삭제 ──

async function findHeaderId(
  organization: string,
  weekId: string,
  teamId: string,
  part: string,
): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("cluster4_experience_part_submissions")
    .select("id")
    .eq("organization_slug", organization)
    .eq("week_id", weekId)
    .eq("team_id", teamId)
    .eq("part_name", part)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

async function fetchCells(submissionId: string): Promise<PartInputCellDto[]> {
  const { data } = await supabaseAdmin
    .from("cluster4_experience_part_submission_cells")
    .select("crew_user_id,line_type,checked,score,selected_line_id")
    .eq("submission_id", submissionId);
  return ((data ?? []) as Array<{
    crew_user_id: string;
    line_type: ExperiencePartLineType;
    checked: boolean;
    score: number;
    selected_line_id: string | null;
  }>).map((c) => normalizePartInputCell({
    crewUserId: c.crew_user_id,
    lineType: c.line_type,
    checked: c.checked,
    score: c.score,
    selectedLineId: c.selected_line_id ?? null,
  }));
}

export async function getPartSubmission(
  organization: string,
  weekId: string,
  teamId: string,
  part: string,
): Promise<{ submitted: boolean; cells: PartInputCellDto[] }> {
  const headerId = await findHeaderId(organization, weekId, teamId, part);
  if (!headerId) return { submitted: false, cells: [] };
  const cells = await fetchCells(headerId);
  return { submitted: true, cells };
}

// 팀 총괄 — 그 팀의 모든 파트 신청을 집계(읽기 전용).
export async function getTeamOverall(
  organization: string,
  weekId: string,
  teamId: string,
  teamName: string,
  mode: ScopeMode = "operating",
): Promise<PartOverallAggregate> {
  const { data: headers } = await supabaseAdmin
    .from("cluster4_experience_part_submissions")
    .select("id,part_name")
    .eq("organization_slug", organization)
    .eq("week_id", weekId)
    .eq("team_id", teamId);
  const headerRows = (headers ?? []) as Array<{ id: string; part_name: string }>;
  if (headerRows.length === 0) return { parts: [] };

  const headerIds = headerRows.map((h) => h.id);
  const { data: cellRows } = await supabaseAdmin
    .from("cluster4_experience_part_submission_cells")
    .select("submission_id,crew_user_id,line_type,checked,score,selected_line_id")
    .in("submission_id", headerIds);
  const cells = (cellRows ?? []) as Array<{
    submission_id: string;
    crew_user_id: string;
    line_type: ExperiencePartLineType;
    checked: boolean;
    score: number;
    selected_line_id: string | null;
  }>;

  // 크루 표시 정보(이름/상태) — 그 주차 로스터 1회 조회 후 맵(파트/크루 목록과 동일 원천).
  const roster = await loadExperienceWeekRoster(organization, teamName, mode, weekId);
  const crewMap = new Map(
    roster.rows.map((r) => [
      r.userId,
      { displayName: r.displayName, statusLabel: r.statusLabel },
    ]),
  );

  const parts = headerRows
    .map((h) => {
      const partCells = cells.filter((c) => c.submission_id === h.id);
      const byCrew = new Map<string, PartInputCellDto[]>();
      for (const c of partCells) {
        const list = byCrew.get(c.crew_user_id) ?? [];
        list.push(normalizePartInputCell({
          crewUserId: c.crew_user_id,
          lineType: c.line_type,
          checked: c.checked,
          score: c.score,
          selectedLineId: c.selected_line_id ?? null,
        }));
        byCrew.set(c.crew_user_id, list);
      }
      const crews = Array.from(byCrew.entries()).map(([userId, cs]) => {
        const info = crewMap.get(userId);
        return {
          userId,
          displayName: info?.displayName ?? "",
          statusLabel: info?.statusLabel ?? "-",
          cells: cs,
        };
      });
      return { partName: h.part_name, crews };
    })
    .sort((a, b) => a.partName.localeCompare(b.partName));

  return { parts };
}

export async function savePartSubmission(input: {
  organization: string;
  weekId: string;
  teamId: string;
  part: string;
  submittedBy: string | null;
  cells: PartInputCellDto[];
  mode?: ScopeMode;
}): Promise<{ submitted: true }> {
  // 0a. 공식 휴식 주차 차단(UI canOpen 과 동일 판정) — operating/test 무관, write 전 422.
  //   예외(line_opening_windows)는 org+hub 스코프 판정(Encre+실무경험 등록 시 그 org·경험만 통과).
  await assertWeekOpenable(input.weekId, input.organization, "experience");

  // 0a-2. 개설 기간 게이트 — 개설 신청도 개설 기간(cluster4_week_opening_configs)에서만 가능하다.
  //   개설 기간이 아닌 주차(오픈 확인 전/미체크)에는 신청 write 를 409 로 차단(팀 총괄 개설과 동일 SoT).
  await assertExperienceLineOpenable(input.organization, input.weekId, input.teamId);

  // 0b. 안전장치 — 셀의 crew userId 가 현재 모드 스코프에 전원 부합하는지 검증(헤더 upsert 전).
  //    operating: 테스트 계정이 / test: 실사용자가 하나라도 섞이면 422 로 중단.
  const cellUserIds = input.cells.map((c) => c.crewUserId).filter(Boolean);
  if (cellUserIds.length > 0) {
    const scope = await resolveUserScope(input.mode ?? "operating", null);
    assertUserIdsInScope(scope, cellUserIds);
  }

  // 1. 헤더 upsert(파트당 1행/주차) → id.
  const { data: header, error: headerError } = await supabaseAdmin
    .from("cluster4_experience_part_submissions")
    .upsert(
      {
        organization_slug: input.organization,
        week_id: input.weekId,
        team_id: input.teamId,
        part_name: input.part,
        submitted_by: input.submittedBy,
        submitted_at: new Date().toISOString(),
      },
      { onConflict: "organization_slug,week_id,team_id,part_name" },
    )
    .select("id")
    .single();
  if (headerError || !header) {
    throw new Error(headerError?.message ?? "신청 헤더 저장 실패");
  }
  const submissionId = (header as { id: string }).id;

  // 2. 셀 replace(기존 삭제 후 재삽입) — 유효 line_type 만.
  const { error: delError } = await supabaseAdmin
    .from("cluster4_experience_part_submission_cells")
    .delete()
    .eq("submission_id", submissionId);
  if (delError) throw new Error(delError.message);

  // normalizePartInputCell 이 점수 상태를 정규화한다(선택 라인은 평점과 무관하게 그대로 보존).
  const valid = input.cells
    .filter((c) => (EXPERIENCE_PART_LINE_KEYS as string[]).includes(c.lineType))
    .map(normalizePartInputCell);

  // 라인 유형 정합성 — 선택 라인은 반드시 그 셀 line_type 과 같은 유형이어야 한다(요구사항 §7).
  //   옵션 원천 = 개설 신청/검수/검증 공용 listExperienceLineOptions(org+공통).
  const lineIdCategory = buildLineIdCategoryMap(
    await listExperienceLineOptions(input.organization),
  );
  for (const c of valid) {
    if (!c.selectedLineId) continue; // 미선택('-') — 검증 불필요.
    if (lineIdCategory.get(c.selectedLineId) !== c.lineType) {
      throw Object.assign(
        new Error(
          "선택한 라인의 유형이 해당 평가 열과 일치하지 않습니다. 잘못된 라인 선택입니다.",
        ),
        { status: 422 },
      );
    }
  }

  if (valid.length > 0) {
    const { error: insError } = await supabaseAdmin
      .from("cluster4_experience_part_submission_cells")
      .insert(
        valid.map((c) => ({
          submission_id: submissionId,
          crew_user_id: c.crewUserId,
          line_type: c.lineType,
          checked: c.checked,
          score: Math.max(0, Math.min(10, Math.round(c.score))),
          selected_line_id: c.selectedLineId ?? null,
        })),
      );
    if (insError) throw new Error(insError.message);
  }

  return { submitted: true };
}

// ── [검수] 팀 총괄 보드에서 도출/분석/견문 라인 선택 편집 → 파트 신청 셀에 write-back ──
// 라인명 SoT 는 파트 신청 셀(selected_line_id) 하나뿐이므로, 검수 화면 편집도 같은 셀을 갱신한다.
//   · checked/score 는 건드리지 않는다(도출/분석/견문 점수는 파트장 소유·검수는 라인명만 편집).
//   · 라인명은 평점과 분리(2026-07-24) — 평점 0점(강화 실패) 셀에도 선택 라인을 그대로 저장한다.
//   · 유형 정합성: 선택 라인 유형 == 셀 line_type 아니면 422.
//   · 파트 미신청(셀 없음) 크루는 스킵(부착할 셀이 없음).
export async function updateOverallPartCellLines(input: {
  organization: string;
  weekId: string;
  teamId: string;
  selections: Array<{
    crewUserId: string;
    lineType: ExperiencePartLineType;
    selectedLineId: string | null;
  }>;
}): Promise<void> {
  const selections = input.selections.filter((s) =>
    (EXPERIENCE_PART_LINE_KEYS as string[]).includes(s.lineType),
  );
  if (selections.length === 0) return;

  // 대상 팀·주차의 신청 헤더 → 셀(도출/분석/견문) 조회. (crew::lineType) → 셀 메타 맵.
  const { data: headers } = await supabaseAdmin
    .from("cluster4_experience_part_submissions")
    .select("id")
    .eq("organization_slug", input.organization)
    .eq("week_id", input.weekId)
    .eq("team_id", input.teamId);
  const headerIds = ((headers ?? []) as Array<{ id: string }>).map((h) => h.id);
  if (headerIds.length === 0) return;

  const { data: cellRows } = await supabaseAdmin
    .from("cluster4_experience_part_submission_cells")
    .select("id,crew_user_id,line_type")
    .in("submission_id", headerIds);
  const cellMap = new Map<string, { id: string }>();
  for (const c of (cellRows ?? []) as Array<{
    id: string;
    crew_user_id: string;
    line_type: ExperiencePartLineType;
  }>) {
    cellMap.set(`${c.crew_user_id}::${c.line_type}`, { id: c.id });
  }

  const lineIdCategory = buildLineIdCategoryMap(
    await listExperienceLineOptions(input.organization),
  );

  for (const sel of selections) {
    const cell = cellMap.get(`${sel.crewUserId}::${sel.lineType}`);
    if (!cell) continue; // 파트 미신청 크루 — 부착할 셀 없음.
    // 라인명은 평점과 분리 — 강화 실패(0점) 셀에도 선택 라인을 그대로 저장한다(null 강제 없음).
    const nextId: string | null = sel.selectedLineId ?? null;
    if (nextId) {
      if (lineIdCategory.get(nextId) !== sel.lineType) {
        throw Object.assign(
          new Error(
            "선택한 라인의 유형이 해당 평가 열과 일치하지 않습니다. 잘못된 라인 선택입니다.",
          ),
          { status: 422 },
        );
      }
    }
    const { error } = await supabaseAdmin
      .from("cluster4_experience_part_submission_cells")
      .update({ selected_line_id: nextId })
      .eq("id", cell.id);
    if (error) throw new Error(error.message);
  }
}

export async function deletePartSubmission(
  organization: string,
  weekId: string,
  teamId: string,
  part: string,
): Promise<{ submitted: false }> {
  // 헤더 삭제 → 셀 CASCADE.
  const { error } = await supabaseAdmin
    .from("cluster4_experience_part_submissions")
    .delete()
    .eq("organization_slug", organization)
    .eq("week_id", weekId)
    .eq("team_id", teamId)
    .eq("part_name", part);
  if (error) throw new Error(error.message);
  return { submitted: false };
}
