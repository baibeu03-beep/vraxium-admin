// 액트 체크 신청율 — 주차별 정규/변동 입력 로더(목록·상세 공통 SoT).
// ─────────────────────────────────────────────────────────────────────
// 목록(/admin/team-parts/info/weeks)과 상세(활동 관리 > 액트 체크 관리)가 **같은 입력·같은 빌더**를
//   쓰도록 여기서 한 번만 판정한다. 화면별 reduce/별도 쿼리 금지(요구).
//
// 판정 SoT(신규 규칙 없음 — 기존 도메인 함수 재사용):
//   · 가동  = weekOpenGate.isActOpenForWeek(프로세스 체크 보드·활동 관리와 동일 함수)
//            + check_target='check'(기존 두 화면 공통 조건 승계 — 현재 전 액트가 'check' 라 실질 no-op)
//     ⚠ **이력 보존(legacy 주차 한정)**: `config 행 없음` AND `과거 주차`  → 게이트 미적용(전 정규 액트 가동).
//       · 왜: 오픈 설정은 2026-07 도입이라 과거 주차 대부분이 행이 없다. 엄격 적용 시 162주차 중 ~157주차가
//         가동 0 → 신청율 0% 로 죽는다. 라인 개설 결과 조회(getInfoLineResultsForWeek)의
//         "config 없는 과거 주차는 게이트 미적용" 선례와 동일.
//       · **현재/미래 주차는 예외 없이 게이트 적용**: 아직 오픈 확인(open_confirmed)을 안 한 이번 주를
//         "전부 가동"으로 보면 [오픈 확인] 기능의 의미(확인 전 = 미가동)가 깨진다. 기존 동작 보존.
//       · config 행이 있으면 과거/현재 무관하게 게이트 적용(open_confirmed=false 면 미가동).
//   · 신청  = process_check_statuses.status ∈ {pending, completed}. **'needed'(행은 있으나 미신청) 제외**.
//            ⚠ completed 만 세지 않는다 — 이 지표는 완료율이 아니라 신청율이다.
//   · 변동  = effectiveIrregularStatus(kind,status,scheduled_check_at,now) === 'completed'
//            (manual_grant=생성 즉시 completed / review_request=pending 이면 미체크·검수시점 경과 시 완료).
//            origin='emergency_rest'(긴급 휴식 Po.C 내부 액트)는 액트가 아니므로 전 집계에서 제외.
//
// 스코프: 정규 = (org, hub∈ACT_HUBS, week). 변동 = (org, week, scope_mode=mode).
//   ⚠ 변동은 scope_mode 로 갈리므로 **이 로더는 mode 를 받는다**. mode 는 "어떤 변동 액트 모집단이냐"만
//     바꾸며 산식/DTO 는 동일하다(인증·스코프 어댑터만 다름 — 요구).
// ─────────────────────────────────────────────────────────────────────

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isActOpenForWeek } from "@/lib/weekOpenGate";
import { listTeams } from "@/lib/adminExperienceLineData";
import { effectiveIrregularStatus } from "@/lib/adminProcessIrregularTypes";
import { getCurrentWeekStartMs } from "@/lib/cluster4WeekPolicy";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import type {
  ActCheckRegularInput,
  ActCheckVariableInput,
  ActCheckWeekInputs,
} from "@/lib/actCheckApplicationSummary";
import type { OrganizationSlug } from "@/lib/organizations";
import type { ScopeMode } from "@/lib/userScopeShared";

// 액트 체크 대상 허브 — 상세(활동 관리) 기준. 목록도 이 범위로 통일한다(요구).
//   ⚠ 기존 목록은 club 을 빼고 3허브만 세어 상세(4허브)와 전체/가동이 달랐다(11 vs 19).
export const ACT_CHECK_HUBS = ["info", "experience", "competency", "club"] as const;

type ActRow = {
  id: string;
  hub: string;
  line_group_id: string | null;
  check_target: string | null;
};

type SavedConfig = Parameters<typeof isActOpenForWeek>[0]["config"];

type WeekConfig = {
  /** config 행 존재 여부 — 없으면 게이트 미적용(이력 보존). */
  hasRow: boolean;
  openConfirmed: boolean;
  config: SavedConfig;
};

// PostgREST 1000행 cap 회피(전 주차 집계 시 필수) — order + range 페이징.
const PG_RANGE = 1000;
async function selectAllPaged<T>(
  makeOrderedQuery: () => {
    range: (
      from: number,
      to: number,
    ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
  },
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PG_RANGE) {
    const { data, error } = await makeOrderedQuery().range(from, from + PG_RANGE - 1);
    if (error) throw new Error(error.message);
    const chunk = data ?? [];
    out.push(...chunk);
    if (chunk.length < PG_RANGE) break;
  }
  return out;
}

/**
 * 이 (week, org) 에 오픈 게이트를 적용할지 — **이력 보존 판정 단일 SoT**.
 *   true  = 게이트 적용(isActOpenForWeek 그대로)
 *   false = 이력 보존(게이트 미적용 → 정규 액트 전부 가동)
 * 규칙: `config 행 없음 AND 과거 주차` 일 때만 false.
 * ⚠ 액트 **가동 집계 전용**이다. 라인 행의 isOpenThisWeek(표시)에는 적용하지 않는다
 *    (legacy 주차 라인은 기존대로 "미오픈"으로 보여야 한다 — 표시 회귀 방지).
 */
export async function resolveActCheckGateActive(
  weekId: string,
  organization: OrganizationSlug,
): Promise<boolean> {
  const configs = await loadWeekConfigs([weekId], organization);
  if (configs.get(weekId)?.hasRow === true) return true;
  return !(await isPastWeek(weekId));
}

/** 과거 주차 = 시작일이 현재 주차 시작(월요일)보다 이전. 달력 갭이면 보수적으로 false(게이트 적용). */
async function isPastWeek(weekId: string): Promise<boolean> {
  const currentWeekStartMs = getCurrentWeekStartMs(getCurrentActivityDateIso());
  if (currentWeekStartMs == null) return false;
  const { data } = await supabaseAdmin
    .from("weeks")
    .select("start_date")
    .eq("id", weekId)
    .maybeSingle();
  const startDate = (data as { start_date: string | null } | null)?.start_date;
  if (!startDate) return false;
  const ms = Date.parse(`${startDate}T00:00:00Z`);
  return !Number.isNaN(ms) && ms < currentWeekStartMs;
}

/** (week,org) 오픈 설정 벌크 — 행 존재 여부까지 보존(이력 보존 판정에 필요). */
async function loadWeekConfigs(
  weekIds: string[],
  organization: OrganizationSlug,
): Promise<Map<string, WeekConfig>> {
  const map = new Map<string, WeekConfig>();
  if (weekIds.length === 0) return map;
  const { data, error } = await supabaseAdmin
    .from("cluster4_week_opening_configs")
    .select("week_id,config,open_confirmed")
    .eq("organization_slug", organization)
    .in("week_id", weekIds);
  if (error) {
    // 미적용/일시 오류 → 행 없음으로 degrade = 게이트 미적용(이력 보존). 수치가 0% 로 죽지 않는다.
    console.warn("[act-check-inputs] week_opening_configs read unavailable:", error.message);
    return map;
  }
  for (const r of (data ?? []) as Array<{
    week_id: string;
    config: SavedConfig;
    open_confirmed: boolean | null;
  }>) {
    map.set(r.week_id, {
      hasRow: true,
      openConfirmed: r.open_confirmed === true,
      config: r.config ?? null,
    });
  }
  return map;
}

/**
 * 주차별 정규/변동 입력 — 목록(전 주차)·상세(단일 주차) 공통.
 *   반환 Map 은 요청한 weekIds 전부에 대해 엔트리를 갖는다(데이터 없으면 빈 배열).
 */
export async function loadActCheckApplicationInputsByWeek(opts: {
  weekIds: string[];
  organization: OrganizationSlug;
  mode: ScopeMode;
  /** 변동 액트 유효 상태 판정 기준 시각(검수 시점 경과 자동 완료). 미지정 시 호출 시각. */
  nowMs?: number;
}): Promise<Map<string, ActCheckWeekInputs>> {
  const { weekIds, organization, mode } = opts;
  const nowMs = opts.nowMs ?? Date.now();
  const out = new Map<string, ActCheckWeekInputs>();
  for (const w of weekIds) out.set(w, { regular: [], variable: [] });
  if (weekIds.length === 0) return out;

  // ── 1) 정규 액트 카탈로그 + 활성 라인급(비활성/미등록 라인그룹 액트 제외 — 상세와 동일) ──
  const [{ data: actData, error: actErr }, { data: lgData }] = await Promise.all([
    supabaseAdmin
      .from("process_acts")
      .select("id,hub,line_group_id,check_target")
      .in("hub", ACT_CHECK_HUBS as unknown as string[])
      .eq("is_active", true),
    supabaseAdmin
      .from("process_line_groups")
      .select("id")
      .in("hub", ACT_CHECK_HUBS as unknown as string[])
      .eq("is_active", true),
  ]);
  if (actErr) throw new Error(actErr.message);
  const activeLgIds = new Set(((lgData ?? []) as Array<{ id: string }>).map((r) => r.id));
  const acts = ((actData ?? []) as ActRow[]).filter(
    (a) => a.line_group_id != null && activeLgIds.has(a.line_group_id),
  );

  // ── 2) 팀(experience 게이트/신청 판정에 필요) ──
  const teams = await listTeams(organization, mode).catch((e) => {
    console.warn("[act-check-inputs] listTeams unavailable:", e instanceof Error ? e.message : e);
    return [] as Array<{ id: string }>;
  });

  // ── 3) 주차별 오픈 설정 + 과거 주차 판정(이력 보존 스코프) ──
  const configs = await loadWeekConfigs(weekIds, organization);
  // 과거 주차 = 시작일이 현재 주차 시작(월요일)보다 이전. 현재/미래 주차는 이력 보존 대상이 아니다.
  //   달력 갭(현재 주차 판별 불가)이면 보수적으로 "과거 아님" 취급 → 게이트 적용(기존 동작 유지).
  const currentWeekStartMs = getCurrentWeekStartMs(getCurrentActivityDateIso());
  const pastWeekIds = new Set<string>();
  if (currentWeekStartMs != null) {
    const { data: wk } = await supabaseAdmin
      .from("weeks")
      .select("id,start_date")
      .in("id", weekIds);
    for (const w of (wk ?? []) as Array<{ id: string; start_date: string | null }>) {
      if (!w.start_date) continue;
      const ms = Date.parse(`${w.start_date}T00:00:00Z`);
      if (!Number.isNaN(ms) && ms < currentWeekStartMs) pastWeekIds.add(w.id);
    }
  }

  // ── 4) 상태행(신청 여부) — (week, act) / experience 는 (week, act, team) ──
  const appliedByWeekAct = new Map<string, Set<string>>(); // weekId → actId
  const appliedByWeekActTeam = new Map<string, Set<string>>(); // weekId → `${actId}::${teamId}`
  try {
    const rows = await selectAllPaged<{
      week_id: string | null;
      act_id: string | null;
      hub: string | null;
      team_id: string | null;
      status: string | null;
    }>(() =>
      supabaseAdmin
        .from("process_check_statuses")
        .select("week_id,act_id,hub,team_id,status")
        .eq("organization_slug", organization)
        .in("hub", ACT_CHECK_HUBS as unknown as string[])
        .in("week_id", weekIds)
        .order("week_id")
        .order("act_id"),
    );
    for (const r of rows) {
      if (!r.week_id || !r.act_id) continue;
      // 신청 = pending | completed. 'needed'(행은 있으나 미신청)는 제외.
      if (r.status !== "pending" && r.status !== "completed") continue;
      if (r.hub === "experience" && r.team_id) {
        const s = appliedByWeekActTeam.get(r.week_id) ?? new Set<string>();
        s.add(`${r.act_id}::${r.team_id}`);
        appliedByWeekActTeam.set(r.week_id, s);
      }
      const s = appliedByWeekAct.get(r.week_id) ?? new Set<string>();
      s.add(r.act_id);
      appliedByWeekAct.set(r.week_id, s);
    }
  } catch (e) {
    console.warn(
      "[act-check-inputs] process_check_statuses read unavailable:",
      e instanceof Error ? e.message : e,
    );
  }

  // ── 5) 변동 액트(org, week, scope_mode) — emergency_rest 제외 ──
  const variableByWeek = new Map<string, ActCheckVariableInput[]>();
  {
    const IRR_COLS = "id,week_id,kind,status,scheduled_check_at";
    const run = (cols: string) =>
      supabaseAdmin
        .from("process_irregular_acts")
        .select(cols)
        .eq("organization_slug", organization)
        .eq("scope_mode", mode)
        .in("week_id", weekIds);
    let hasOrigin = true;
    let res = await run(IRR_COLS + ",origin");
    if (res.error && (res.error as { code?: string }).code === "42703") {
      hasOrigin = false;
      res = await run(IRR_COLS);
    }
    if (res.error) {
      console.warn("[act-check-inputs] irregular acts read unavailable:", res.error.message);
    } else {
      const raw = (res.data ?? []) as unknown as Array<{
        id: string;
        week_id: string | null;
        kind: string | null;
        status: string | null;
        scheduled_check_at: string | null;
        origin?: string | null;
      }>;
      // 긴급 휴식(Po.C 내부 액트)은 액트가 아니므로 전체/가동/체크/미체크/변동 전부에서 제외.
      const rows = hasOrigin ? raw.filter((r) => r.origin !== "emergency_rest") : raw;
      for (const r of rows) {
        if (!r.week_id) continue;
        const kind = r.kind === "manual_grant" ? "manual_grant" : "review_request";
        const rawStatus = r.status === "completed" ? "completed" : "pending";
        const isChecked =
          effectiveIrregularStatus(kind, rawStatus, r.scheduled_check_at, nowMs) === "completed";
        const arr = variableByWeek.get(r.week_id) ?? [];
        arr.push({ id: r.id, isChecked });
        variableByWeek.set(r.week_id, arr);
      }
    }
  }

  // ── 6) 주차별 조립 ──
  for (const weekId of weekIds) {
    const cfg = configs.get(weekId) ?? null;
    // 이력 보존: **config 행 없음 AND 과거 주차** 일 때만 게이트 미적용(전 정규 액트 가동).
    //   현재/미래 주차는 config 가 없어도 게이트 적용 → 오픈 확인 전 미가동(기존 동작 보존).
    const gateActive = cfg?.hasRow === true || !pastWeekIds.has(weekId);
    const openConfirmed = cfg?.openConfirmed === true;
    const config = cfg?.config ?? null;
    const appliedActs = appliedByWeekAct.get(weekId) ?? new Set<string>();
    const appliedActTeams = appliedByWeekActTeam.get(weekId) ?? new Set<string>();

    const isActive = (a: ActRow): boolean => {
      if (a.check_target !== "check") return false; // 기존 두 화면 공통 조건 승계
      if (!gateActive) return true; // 이력 보존(설정 없는 legacy 주차)
      if (a.hub === "experience") {
        // 팀 중 하나라도 그 라인급이 체크되어 있으면 가동(상세 허브 요약과 동일 판정).
        return teams.some((t) =>
          isActOpenForWeek({
            hub: "experience",
            openConfirmed,
            config,
            lineGroupId: a.line_group_id,
            teamId: t.id,
          }),
        );
      }
      return isActOpenForWeek({
        hub: a.hub,
        openConfirmed,
        config,
        lineGroupId: a.line_group_id,
      });
    };

    const isApplied = (a: ActRow): boolean =>
      a.hub === "experience"
        ? teams.some((t) => appliedActTeams.has(`${a.id}::${t.id}`))
        : appliedActs.has(a.id);

    const regular: ActCheckRegularInput[] = acts.map((a) => ({
      actId: a.id,
      hub: a.hub,
      isActive: isActive(a),
      isApplied: isApplied(a),
    }));

    out.set(weekId, { regular, variable: variableByWeek.get(weekId) ?? [] });
  }

  return out;
}
