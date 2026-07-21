import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";
import { resolveUserScope } from "@/lib/userScope";
import {
  loadWeekOrgResultStates,
  resolveWeekOrgResultState,
  resolveOrgResultScope,
} from "@/lib/weekOrgResultState";
import { seasonKeyToHalfKey, seasonKeyToSeasonLabel } from "@/lib/teamHalf";
import {
  resolveCurrentHalfKey,
  DEFAULT_PART_NAME,
  getLeaderBasicsBatch,
} from "@/lib/adminTeamHalvesData";
import { SUPER_ADMIN_EXCLUDE_OR } from "@/lib/superAdmins";
import { memberStatusLabel } from "@/lib/adminMembersTypes";
import { loadWeekPositionOverrides } from "@/lib/teamWeekPositionOverride";
import { loadWeeklyCrewResults, type WeeklyCrewResult } from "@/lib/teamWeekCrewResults";
import { loadWeekGradeHistory, type WeekGradeHistoryEntry } from "@/lib/userWeekGradeHistory";
import { POSITION_CODE_TO_LABEL, type PositionCode } from "@/lib/positionHistory";
import type { ScopeMode } from "@/lib/userScopeShared";
import { type OrganizationSlug } from "@/lib/organizations";

// ── 팀 상세 [A] — 선택 주차 요약 ─────────────────────────────────────────────
//   특정 (organization, teamName, weekId) 에 대해 그 주차 기준 크루 수·성장 결과·운용 파트를 반환.
//   모든 값은 기존 SoT 를 파생(신규 판정 로직 없음):
//     · 검수 완료 = cluster4_week_org_result_states.status==='published'(org·scope, 레거시 폴백).
//     · 주차 로스터/정규·심화/파트별 크루 수 = user_position_histories(UPH) position_code + raw_part.
//       (UPH 없는 "현재 반기 진행 주차"는 매트릭스와 동일하게 현재 멤버십 폴백 — 운용 판정 SoT 일치.)
//     · 성장 결과 = user_week_statuses.status(success/fail/personal_rest/official_rest); 미확정 나머지는
//       현재 주차=running / 그 외=tallying(shared/growth.contracts 어휘). 억지 실패/휴식 분류 없음.
//   ⚠ 운용 파트 판정 = "그 주차 배정 크루 ≥1"(파트 종류 무관 — '일반'도 예외 없음). 매트릭스 data-pw-cell 과 일치.
//   ⚠ mode(operating/test)/actAs/demo/snapshot 모두 동일 함수·동일 DTO(스코프만 입력값으로 다름).

const stripParen = (s: string): string => s.replace(/\(.*?\)/g, "").trim();
const isCrewPosition = (pc: string | null) =>
  pc === "regular" || pc === "advanced_agent" || pc === "advanced_part_leader";
const isAdvancedPosition = (pc: string | null) =>
  pc === "advanced_agent" || pc === "advanced_part_leader";
// 폴백(현재 멤버십) 라벨 → UPH position_code. 운영진/관리자 등 크루 아님 = null.
function labelToPositionCode(label: string): string | null {
  if (label === "심화(파트장)") return "advanced_part_leader";
  if (label === "심화(에이전트)") return "advanced_agent";
  if (label === "일반" || label === "크루") return "regular";
  return null;
}
// uws.status → [B] 주차 결과 표시 라벨(검수 완료 후에만 호출).
function weekResultLabel(status: string | undefined): string | null {
  switch (status) {
    case "success":
      return "성장 성공";
    case "fail":
      return "성장 실패";
    case "personal_rest":
    case "official_rest":
      return "주차 휴식";
    default:
      return null;
  }
}

export type SelectableWeek = {
  weekId: string;
  label: string; // week_label(예: "4주차") — 그대로 유지(폴백/식별).
  year: number; // 표시용 연도(주차 종료일 기준·resolveCurrentWeekInfo 와 동일 파생). "26년, 여름, 4주차" 조합용.
  weekNumber: number | null;
  seasonLabel: string | null; // 시즌명(예: "여름")
  weekStartDate: string;
  isCurrent: boolean;
};

export type TeamSelectedWeekSummary = {
  // 선택 가능한 주차(현재+과거, 미래 제외). 최신순. 드롭다운 옵션 SoT.
  selectableWeeks: SelectableWeek[];
  week: {
    weekId: string;
    label: string;
    weekNumber: number | null;
    seasonLabel: string | null;
    weekStartDate: string;
    isCurrentWeek: boolean;
    reviewCompleted: boolean; // cluster4_week_org_result_states published
    canEdit: boolean; // !reviewCompleted
  } | null;
  // 전체 크루 = 정규 + 심화(운영진 제외·개인 휴식 포함·userId 고유).
  crew: { total: number; regular: number; advanced: number };
  // 전체 크루 = success + failure + rest + running + tallying (rest = personal + official).
  //   card 는 성공/실패/휴식 3개만 노출하고, running/tallying 은 정합 재구성용.
  growth: {
    success: number;
    failure: number;
    rest: number;
    running: number;
    tallying: number;
  };
  // 그 주차 배정 크루 ≥1 파트(‘일반’ 포함). crewCount = distinct userId. 최신 표시순('일반' 우선).
  operatedParts: Array<{ partName: string; crewCount: number }>;
  // [B] 편집표 행 — 전체 크루(정규+심화). 소속 파트(rawPart)·클래스(positionCode)만 편집 대상, 나머지 조회전용.
  crewRows: CrewRow[];
};

export type CrewRow = {
  userId: string;
  name: string | null;
  gender: string | null;
  birth6: string | null; // YYMMDD (년생 = 앞 2자리)
  school: string | null;
  major: string | null;
  residence: string | null;
  rawPart: string | null; // effective 소속 파트(편집 대상)
  positionCode: PositionCode; // effective 클래스(편집 대상)
  classLabel: string; // positionCode 표시 라벨
  gradeLabel: string | null; // 품계(검수 후만)
  gradeRank: number | null; // 품계 숫자 등급(1=정승…10=정9품, 검수 후만) — [B] 품계 컬럼 정렬 SoT.
  weekResult: string | null; // 주차 결과(검수 후만)
  growthSuccessCount: number | null; // 조회전용(검수 후 SoT 배선 예정) — 현재 null
  lineEnhancementRate: number | null; // 조회전용(동상)
  actCheckRate: number | null; // 조회전용(동상)
};

function emptyBody(): Pick<
  TeamSelectedWeekSummary,
  "crew" | "growth" | "operatedParts" | "crewRows"
> {
  return {
    crew: { total: 0, regular: 0, advanced: 0 },
    growth: { success: 0, failure: 0, rest: 0, running: 0, tallying: 0 },
    operatedParts: [],
    crewRows: [],
  };
}

export async function getTeamSelectedWeekSummary(opts: {
  organization: OrganizationSlug;
  teamName: string;
  weekId?: string | null;
  mode?: ScopeMode;
  today?: string;
}): Promise<TeamSelectedWeekSummary> {
  const { organization, teamName } = opts;
  const mode = opts.mode ?? "operating";
  const today = opts.today;
  const todayIso = today ?? getCurrentActivityDateIso();

  // 1) 선택 가능 주차 = 현재+과거(week_start_date <= 현재 활동일). 미래 제외 + **0주차(전환 주차) 제외**. 최신순.
  //    ⚠ 이 페이지 전용 UI 필터(공식 week_number 기준) — DB 의 0주차 데이터·다른 페이지(기간 관리 등)엔 영향 없음.
  //    현재 활동일은 월요일 00:01 KST 경계(getCurrentActivityDateIso) — "그 주 월요일 00:01부터 현재 주차 노출".
  const { rows: weekRows } = await loadSeasonWeeks(today);
  const selectable = weekRows
    .filter(
      (w) => w.week_start_date && w.week_start_date <= todayIso && (w.week_number ?? 0) > 0,
    )
    .sort((a, b) => (b.week_start_date ?? "").localeCompare(a.week_start_date ?? ""));
  const yearOf = (w: (typeof selectable)[number]): number => {
    // 표시 연도 — 주차 종료일 우선(주 경계 넘김 대비), 없으면 시작/시즌 시작일. resolveCurrentWeekInfo 와 동일.
    const iso = w.week_end_date ?? w.week_start_date ?? w.season_start_date ?? "";
    const y = Number(String(iso).slice(0, 4));
    return Number.isFinite(y) ? y : 0;
  };
  const selectableWeeks: SelectableWeek[] = selectable.map((w) => ({
    weekId: w.week_id,
    label: w.week_label,
    year: yearOf(w),
    weekNumber: w.week_number,
    // 시즌명 = 간결한 "여름/봄/가을/겨울"(seasonKeyToSeasonLabel, 프로젝트 공식 파생). season_label/name 은
    //   "2026년도 여름시즌"이라 연도 중복 → 사용 안 함.
    seasonLabel: w.season_key ? seasonKeyToSeasonLabel(w.season_key) : w.season_name,
    weekStartDate: w.week_start_date as string,
    isCurrent: w.is_current_week,
  }));

  // 2) 대상 주차 = weekId(선택 가능 목록 내) 또는 현재 주차(없으면 최신).
  const currentRow = selectable.find((w) => w.is_current_week) ?? selectable[0] ?? null;
  const targetRow =
    (opts.weekId && selectable.find((w) => w.week_id === opts.weekId)) || currentRow;
  if (!targetRow || !targetRow.week_start_date) {
    return { selectableWeeks, week: null, ...emptyBody() };
  }
  const weekStart = targetRow.week_start_date;
  const isCurrentWeek = targetRow.is_current_week;

  // 3) 검수 완료(org·scope) — 레거시 주차는 weeks.result_published_at 폴백.
  const scope = resolveOrgResultScope(mode);
  const [states, legacyRow] = await Promise.all([
    loadWeekOrgResultStates([targetRow.week_id], organization, scope),
    supabaseAdmin.from("weeks").select("result_published_at").eq("id", targetRow.week_id).limit(1),
  ]);
  const legacyPublished =
    ((legacyRow.data ?? []) as Array<{ result_published_at: string | null }>)[0]
      ?.result_published_at != null;
  const reviewStatus = resolveWeekOrgResultState(
    states.get(targetRow.week_id),
    weekStart,
    legacyPublished,
  ).status;
  const reviewCompleted = reviewStatus === "published";

  const week = {
    weekId: targetRow.week_id,
    label: targetRow.week_label,
    weekNumber: targetRow.week_number,
    seasonLabel: targetRow.season_label,
    weekStartDate: weekStart,
    isCurrentWeek,
    reviewCompleted,
    canEdit: !reviewCompleted,
  };

  // 4) 모집단 스코프(operating=실사용자·test=테스트 마커).
  const scopeSet = await resolveUserScope(mode, null);

  // 5) effective 로스터 — 팀(teamName) 소속 유저별 {positionCode, rawPart}. base(UPH 우선, 폴백=현재 멤버십)
  //    위에 관리자 override(override ?? base) 를 coalesce. [A]/[B]/매트릭스 공용 규칙([[teamWeekPositionOverride]]).
  const baseByUser = new Map<string, { positionCode: string | null; rawPart: string | null }>();

  const { data: uphData } = await supabaseAdmin
    .from("user_position_histories")
    .select("user_id,raw_team,raw_part,position_code")
    .eq("organization", organization)
    .eq("week_start_date", weekStart);
  for (const r of ((uphData ?? []) as Array<{
    user_id: string;
    raw_team: string | null;
    raw_part: string | null;
    position_code: string | null;
  }>)) {
    const rt = r.raw_team ?? "";
    if (!((rt === teamName || stripParen(rt) === teamName) && scopeSet.includes(r.user_id))) continue;
    if (!baseByUser.has(r.user_id))
      baseByUser.set(r.user_id, { positionCode: r.position_code, rawPart: r.raw_part });
  }

  if (baseByUser.size === 0) {
    // UPH 없음 — 매트릭스와 동일 조건(현재 반기 & 경과 주차)에서만 현재 멤버십 폴백.
    const currentHalfKey = await resolveCurrentHalfKey(today);
    const weekHalf = targetRow.season_key ? seasonKeyToHalfKey(targetRow.season_key) : null;
    const fallback = weekHalf != null && weekHalf === currentHalfKey && weekStart <= todayIso;
    if (fallback) {
      const { data: profs } = await supabaseAdmin
        .from("user_profiles")
        .select("user_id,role")
        .eq("organization_slug", organization)
        .or(SUPER_ADMIN_EXCLUDE_OR);
      const roleByUser = new Map<string, string | null>();
      for (const p of (profs ?? []) as Array<{ user_id: string; role: string | null }>)
        if (scopeSet.includes(p.user_id)) roleByUser.set(p.user_id, p.role);
      const uids = [...roleByUser.keys()];
      for (let i = 0; i < uids.length; i += 100) {
        const chunk = uids.slice(i, i + 100);
        if (chunk.length === 0) break;
        const { data: mems } = await supabaseAdmin
          .from("user_memberships")
          .select("user_id,team_name,part_name,membership_level,membership_state,is_current")
          .in("user_id", chunk)
          .eq("is_current", true);
        for (const m of (mems ?? []) as Array<{
          user_id: string;
          team_name: string | null;
          part_name: string | null;
          membership_level: string | null;
          membership_state: string | null;
        }>) {
          if ((m.team_name ?? "").trim() !== teamName) continue;
          if (baseByUser.has(m.user_id)) continue;
          const label = memberStatusLabel(roleByUser.get(m.user_id) ?? null, m.membership_level ?? null);
          const code = labelToPositionCode(label);
          if (code === null) continue; // 운영진/관리자 등 = 크루 아님(미집계)
          // 파트 — 매트릭스 폴백과 동일: 비휴식만 part_name 반영(휴식 크루는 전체엔 포함·파트엔 미포함).
          baseByUser.set(m.user_id, {
            positionCode: code,
            rawPart: m.membership_state !== "rest" ? m.part_name : null,
          });
        }
      }
    }
  }

  // override coalesce — teamName 대상 override 로 base 를 대체(없던 유저면 추가).
  const overrides = await loadWeekPositionOverrides(organization, weekStart);
  const effectiveByUser = new Map(baseByUser);
  for (const [key, v] of overrides) {
    if (v.rawTeam !== teamName) continue;
    const uid = key.slice(0, key.indexOf("::"));
    if (!scopeSet.includes(uid)) continue;
    effectiveByUser.set(uid, { positionCode: v.positionCode, rawPart: v.rawPart });
  }

  // 집계 — 전체 크루(정규+심화·운영진 제외·userId 고유) + 파트별 크루 수.
  const crewUserIds = new Set<string>();
  let regular = 0;
  let advanced = 0;
  const partUsers = new Map<string, Set<string>>();
  for (const [uid, v] of effectiveByUser) {
    const p = (v.rawPart ?? "").trim();
    if (p) {
      const s = partUsers.get(p) ?? new Set<string>();
      s.add(uid);
      partUsers.set(p, s);
    }
    if (isCrewPosition(v.positionCode)) {
      crewUserIds.add(uid);
      if (isAdvancedPosition(v.positionCode)) advanced++;
      else regular++;
    }
  }
  const crew = { total: regular + advanced, regular, advanced };

  // 6) 성장 결과(uws) — 크루 로스터 기준. success/fail/personal_rest/official_rest 확정, 나머지=running/tallying.
  const growth = { success: 0, failure: 0, rest: 0, running: 0, tallying: 0 };
  const crewIds = [...crewUserIds];
  const confirmed = new Set<string>();
  const uwsStatusByUser = new Map<string, string>(); // [B] 주차 결과 표시용(검수 후).
  for (let i = 0; i < crewIds.length; i += 100) {
    const chunk = crewIds.slice(i, i + 100);
    if (chunk.length === 0) break;
    const { data: uws } = await supabaseAdmin
      .from("user_week_statuses")
      .select("user_id,status")
      .eq("week_start_date", weekStart)
      .in("user_id", chunk);
    for (const u of (uws ?? []) as Array<{ user_id: string; status: string | null }>) {
      if (u.status) uwsStatusByUser.set(u.user_id, u.status);
      if (confirmed.has(u.user_id)) continue;
      if (u.status === "success") {
        growth.success++;
        confirmed.add(u.user_id);
      } else if (u.status === "fail") {
        growth.failure++;
        confirmed.add(u.user_id);
      } else if (u.status === "personal_rest" || u.status === "official_rest") {
        growth.rest++;
        confirmed.add(u.user_id);
      }
    }
  }
  const unresolved = crewUserIds.size - confirmed.size;
  if (isCurrentWeek) growth.running = unresolved;
  else growth.tallying = unresolved;

  // 7) 운용 파트(배정 크루 ≥1) — '일반' 우선, 그다음 크루 수 내림차순.
  const operatedParts = [...partUsers.entries()]
    .map(([partName, ids]) => ({ partName, crewCount: ids.size }))
    .filter((p) => p.crewCount > 0)
    .sort((a, b) => {
      if (a.partName === DEFAULT_PART_NAME) return -1;
      if (b.partName === DEFAULT_PART_NAME) return 1;
      return b.crewCount - a.crewCount || a.partName.localeCompare(b.partName);
    });

  // 8) [B] 크루 행 — 전체 크루(정규+심화) 각자의 프로필 + effective 파트/클래스 + 주차결과.
  //    ⚠ 파트/클래스는 effective(override ?? UPH), 프로필/품계/결과는 기존 SoT. 결과류는 검수 완료 전 null(-).
  const basics = await getLeaderBasicsBatch(crewIds);
  // 조회 전용 결과류 — 검수 완료 주차만 batch(N+1 없음). 미완료 주차는 호출 자체를 생략 → 전부 null('-').
  //   · 3종(성장 성공·라인 강화율·액트 체크율) = weekly-cards snapshot SoT.
  //   · 품계 = **주차 확정 품계 이력**(user_week_grade_histories) — 현재값(user_grade_stats) fallback 금지.
  //     이력 행 없으면 '-'(지시 #5·#9). 게이트 전(reviewCompleted=false)엔 조회하지 않는다.
  const [weekResults, gradeHistory] =
    reviewCompleted && weekStart
      ? await Promise.all([
          loadWeeklyCrewResults({ userIds: crewIds, weekStartDate: weekStart }),
          loadWeekGradeHistory({ userIds: crewIds, weekStartDate: weekStart }),
        ])
      : [new Map<string, WeeklyCrewResult>(), new Map<string, WeekGradeHistoryEntry>()];
  const crewRows: CrewRow[] = crewIds
    .map((uid) => {
      const eff = effectiveByUser.get(uid);
      const b = basics.get(uid);
      const wr = weekResults.get(uid);
      const gh = gradeHistory.get(uid);
      const code = (eff?.positionCode ?? "regular") as PositionCode;
      return {
        userId: uid,
        name: b?.name ?? null,
        gender: b?.gender ?? null,
        birth6: b?.birth6 ?? null,
        school: b?.school ?? null,
        major: b?.major ?? null,
        residence: b?.residence ?? null,
        rawPart: eff?.rawPart ?? null,
        positionCode: code,
        classLabel: POSITION_CODE_TO_LABEL[code] ?? "정규",
        // 검수 완료 후에만 결과류 공개(#21). 성장성공수/라인강화율/액트체크율 = snapshot SoT(weekResults).
        //   품계 = 주차 확정 품계 이력(gradeHistory). gradeRank=grade(1=정승…10=정9품, 정렬용).
        //   현재값 fallback 금지 — 이력 없으면 null('-').
        gradeLabel: reviewCompleted ? gh?.gradeLabel ?? null : null,
        gradeRank: reviewCompleted ? gh?.grade ?? null : null,
        weekResult: reviewCompleted ? weekResultLabel(uwsStatusByUser.get(uid)) : null,
        growthSuccessCount: wr?.growthSuccessCount ?? null,
        lineEnhancementRate: wr?.lineEnhancementRate ?? null,
        actCheckRate: wr?.actCheckRate ?? null,
      };
    })
    .sort((a, b) =>
      (a.rawPart ?? "").localeCompare(b.rawPart ?? "") || (a.name ?? "").localeCompare(b.name ?? ""),
    );

  return { selectableWeeks, week, crew, growth, operatedParts, crewRows };
}
