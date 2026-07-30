import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { deriveEndStatus, GRADUATING_FROM_APPROVED_WEEKS } from "@/lib/growthCore";
import { getSeasonRestUserIds, resolveSeasonKeyForWeekStart } from "@/lib/currentSeasonRest";
import { getApprovedRestWeekUserIdsBulk } from "@/lib/approvedRestWeeks";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";

// ═══════════════════════════════════════════════════════════════════════════
// 모집단 자격(eligibility) — **단일 권위 모듈**. 화면·API 가 상태 문자열을 다시 비교하지 않는다.
//
// 집합 2종만 존재한다(2026-07-27 정책 확정, 2026-07-30 주차 휴식 축 추가):
//
//   ① 팀·파트 활동 가능 모집단  = 전체 − 시즌 휴식 − 주차 휴식 − (효력 발생 후) 활동 중단
//        · 팀 소속 크루 / 파트 소속 크루 / <운용> 파트 판정이 쓰는 집합.
//        · 엘리트·바사노스는 **여기 남는다** — 소속과 평가자·운영자 역할을 유지한다.
//
//   ② 실무 평가 가능 모집단     = ① − 엘리트 − 바사노스
//        · 실무 정보/경험/역량의 라인 개설 후보 · 평가 대상 크루 · 체크 대상 · Point C 모집단.
//        · "평가자 전용 역할"(실무 경험의 파트장 등) 제외는 **역할 축**이라 호출부가 담당한다
//          (positionCode 로 판정 — 여기서 상태와 섞지 않는다).
//
// ⚠ **시점 규칙이 이 모듈의 핵심이다.** 현재 상태를 과거 주차에 소급하지 않는다.
//   과거 snapshot·공표 결과는 재해석 대상이 아니다(이 모듈은 조회 모집단만 좁힌다).
// ═══════════════════════════════════════════════════════════════════════════

export type EligibilityFlags = {
  /** 그 주차 시즌의 시즌 휴식(user_season_statuses.status='rest'). */
  seasonRest: boolean;
  /** 그 주차 자체의 개인 승인 휴식(vacation_requests.status='approved', 긴급 휴식 포함). */
  weekRest: boolean;
  /** 그 주차 시점에 활동 중단 효력이 발생했는가. */
  suspended: boolean;
  /** 그 주차 시점에 엘리트(졸업)인가. */
  elite: boolean;
  /** 그 주차까지 승인 주차 누적 ≥ 29(바사노스). */
  basanos: boolean;
};

export type Eligibility = {
  /** 판정 기준 주차(week_start_date). */
  weekStartDate: string;
  flags(userId: string): EligibilityFlags;
  /** ① 팀·파트 활동 가능 = !seasonRest && !weekRest && !suspended. */
  isTeamActive(userId: string): boolean;
  /** ② 실무 평가 가능 = ① && !elite && !basanos. */
  isEvaluable(userId: string): boolean;
};

const NO_FLAGS: EligibilityFlags = {
  seasonRest: false,
  weekRest: false,
  suspended: false,
  elite: false,
  basanos: false,
};

type Input = {
  userIds: readonly string[];
  /** 판정 기준 주차의 week_start_date(YYYY-MM-DD). */
  weekStartDate: string;
  /** 그 주차의 season_key. 미지정이면 weekStartDate 로 해소. */
  seasonKey?: string | null;
  /** 오늘(현재 활동일). 시점 정보가 없는 상태를 "현재·미래에만" 적용하기 위한 경계. */
  today?: string;
};

const CHUNK = 200;

// 날짜(ISO) → 그 날짜가 속한 주차의 week_start_date. 없으면 null.
async function weekStartContaining(dateIso: string | null): Promise<string | null> {
  if (!dateIso) return null;
  const d = String(dateIso).slice(0, 10);
  const { data, error } = await supabaseAdmin
    .from("weeks")
    .select("start_date")
    .lte("start_date", d)
    .gte("end_date", d)
    .order("start_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { start_date?: string } | null)?.start_date?.slice(0, 10) ?? null;
}

// 여러 주차를 한 번에 판정한다(주차별 재호출 금지 — 26주 매트릭스가 N+1 이 되지 않게).
//   공유 원천(프로필·중단 주차·현재 주차)은 1패스, 시즌축 원천(휴식/중단)은 **시즌 키별 1회**만 읽고
//   주차 루프는 메모리에서 돈다. 판정식은 단일 주차와 완전히 같은 코드다(아래 judge 루프 하나뿐).
type BulkInput = {
  userIds: readonly string[];
  /** 판정 기준 주차들. seasonKey 미지정(undefined)이면 weekStartDate 로 해소. */
  weeks: ReadonlyArray<{ weekStartDate: string; seasonKey?: string | null }>;
  today?: string;
};

function makeResolver(
  weekStartDate: string,
  flagsByUser: Map<string, EligibilityFlags>,
): Eligibility {
  return {
    weekStartDate,
    flags: (userId) => flagsByUser.get(userId) ?? NO_FLAGS,
    isTeamActive: (userId) => {
      const f = flagsByUser.get(userId) ?? NO_FLAGS;
      return !f.seasonRest && !f.weekRest && !f.suspended;
    },
    isEvaluable: (userId) => {
      const f = flagsByUser.get(userId) ?? NO_FLAGS;
      return !f.seasonRest && !f.weekRest && !f.suspended && !f.elite && !f.basanos;
    },
  };
}

async function loadEligibilityBulkInternal(
  input: BulkInput,
  withEvaluationAxes: boolean,
): Promise<Map<string, Eligibility>> {
  const ids = Array.from(new Set(input.userIds.filter(Boolean)));

  // 주차 정규화(중복 제거·seasonKey 미지정은 나중에 해소).
  const weekList: Array<{ weekStartDate: string; seasonKey: string | null | undefined }> = [];
  const seenWeek = new Set<string>();
  for (const w of input.weeks) {
    const ws = String(w.weekStartDate ?? "").slice(0, 10);
    if (!ws || seenWeek.has(ws)) continue;
    seenWeek.add(ws);
    weekList.push({ weekStartDate: ws, seasonKey: w.seasonKey });
  }

  const flagsByWeek = new Map<string, Map<string, EligibilityFlags>>();
  const out = new Map<string, Eligibility>();
  for (const w of weekList) {
    const flagsByUser = new Map<string, EligibilityFlags>();
    flagsByWeek.set(w.weekStartDate, flagsByUser);
    out.set(w.weekStartDate, makeResolver(w.weekStartDate, flagsByUser));
  }
  if (ids.length === 0 || weekList.length === 0) return out;

  for (const w of weekList) {
    if (w.seasonKey === undefined) w.seasonKey = await resolveSeasonKeyForWeekStart(w.weekStartDate);
  }

  // 현재 주차 시작일 — 시점 정보가 없는 상태(활동 중단/엘리트)를 "현재·미래에만" 적용하는 경계.
  //   과거 주차 조회에는 적용하지 않는다(소급 금지).
  const currentWeekStart = await weekStartContaining(input.today ?? getCurrentActivityDateIso());

  // ── 원천 조회 ────────────────────────────────────────────────────────────
  //   ① 시즌 휴식 = 그 주차 시즌의 rest 집합(lib/currentSeasonRest 단일 규칙).
  //   ①' 주차 휴식 = 그 주차 자체의 승인된 개인 휴식(lib/approvedRestWeeks 단일 SoT,
  //       vacation_requests.status='approved' — 긴급 휴식도 이 테이블에 함께 있어 자동 포함).
  //   ② 프로필 = growth_status(수동 override) + suspended_week_id + activity_ended_at.
  //   ③ 시즌 중단 = 그 주차 시즌의 stopped 집합.
  const seasonKeys = Array.from(new Set(weekList.map((w) => w.seasonKey ?? null)));
  const [seasonRestBySeason, weekRestByWeek, profileRows, seasonStoppedBySeason] = await Promise.all([
    (async () => {
      const m = new Map<string | null, Set<string>>();
      for (const sk of seasonKeys) m.set(sk, await getSeasonRestUserIds(sk));
      return m;
    })(),
    getApprovedRestWeekUserIdsBulk({
      userIds: ids,
      weekStartDates: weekList.map((w) => w.weekStartDate),
    }),
    (async () => {
      const out: Array<{
        user_id: string;
        growth_status: string | null;
        suspended_week_id: string | null;
        activity_ended_at: string | null;
      }> = [];
      for (let i = 0; i < ids.length; i += CHUNK) {
        const { data, error } = await supabaseAdmin
          .from("user_profiles")
          .select("user_id,growth_status,suspended_week_id,activity_ended_at")
          .in("user_id", ids.slice(i, i + CHUNK));
        if (error) throw new Error(error.message);
        out.push(...((data ?? []) as typeof out));
      }
      return out;
    })(),
    (async () => {
      const m = new Map<string | null, Set<string>>();
      for (const sk of seasonKeys) {
        const set = new Set<string>();
        m.set(sk, set);
        if (!sk) continue;
        for (let i = 0; i < ids.length; i += CHUNK) {
          const { data, error } = await supabaseAdmin
            .from("user_season_statuses")
            .select("user_id")
            .eq("season_key", sk)
            .eq("status", "stopped")
            .in("user_id", ids.slice(i, i + CHUNK));
          if (error) throw new Error(error.message);
          for (const r of (data ?? []) as Array<{ user_id: string }>) set.add(r.user_id);
        }
      }
      return m;
    })(),
  ]);

  // suspended_week_id(weeks.id) → week_start_date. 활동 중단 효력 주차.
  const suspendedWeekIds = Array.from(
    new Set(profileRows.map((p) => p.suspended_week_id).filter((x): x is string => Boolean(x))),
  );
  const suspendedWeekStartById = new Map<string, string>();
  if (suspendedWeekIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("weeks")
      .select("id,start_date")
      .in("id", suspendedWeekIds);
    if (error) throw new Error(error.message);
    for (const w of (data ?? []) as Array<{ id: string; start_date: string }>)
      suspendedWeekStartById.set(w.id, String(w.start_date).slice(0, 10));
  }

  // 엘리트 종료 주차 — activity_ended_at 이 있으면 그 날짜가 속한 주차가 **마지막 활동 주차**다.
  const eliteEndWeekByUser = new Map<string, string | null>();
  if (withEvaluationAxes) {
    const endDates = Array.from(
      new Set(
        profileRows
          .filter((p) => p.growth_status === "graduated" && p.activity_ended_at)
          .map((p) => String(p.activity_ended_at).slice(0, 10)),
      ),
    );
    const weekStartByDate = new Map<string, string | null>();
    for (const d of endDates) weekStartByDate.set(d, await weekStartContaining(d));
    for (const p of profileRows) {
      if (p.growth_status !== "graduated") continue;
      const d = p.activity_ended_at ? String(p.activity_ended_at).slice(0, 10) : null;
      eliteEndWeekByUser.set(p.user_id, d ? weekStartByDate.get(d) ?? null : null);
    }
  }

  const profileByUser = new Map(profileRows.map((p) => [p.user_id, p]));

  // ── 판정(주차별) ─────────────────────────────────────────────────────────
  for (const w of weekList) {
    const weekStartDate = w.weekStartDate;
    const seasonKey = w.seasonKey ?? null;
    const flagsByUser = flagsByWeek.get(weekStartDate) as Map<string, EligibilityFlags>;
    const seasonRestIds = seasonRestBySeason.get(seasonKey) ?? new Set<string>();
    const weekRestIds = weekRestByWeek.get(weekStartDate) ?? new Set<string>();
    const seasonStoppedIds = seasonStoppedBySeason.get(seasonKey) ?? new Set<string>();
    const isCurrentOrFuture = currentWeekStart ? weekStartDate >= currentWeekStart : true;

    // 바사노스 — **그 주차까지의 승인 주차 누적**(user_week_statuses.status='success', week_start_date ≤ W).
    //   ⚠ 현재 누적(cluster4_roster_card_stats.success_weeks)을 과거 주차에 쓰지 않는다(소급 금지).
    //     그 캐시는 진행 주차 처리 차이로 ±1 이 날 수 있어 임계값 판정에도 부적합하다.
    //   주차마다 누적이 달라 이 축만 주차별 조회다 — 축 ②(평가)는 실제로 항상 단일 주차 호출이다.
    const approvedByUser = new Map<string, number>();
    if (withEvaluationAxes) {
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        const { data, error } = await supabaseAdmin
          .from("user_week_statuses")
          .select("user_id")
          .eq("status", "success")
          .lte("week_start_date", weekStartDate)
          .in("user_id", chunk);
        if (error) throw new Error(error.message);
        for (const r of (data ?? []) as Array<{ user_id: string }>)
          approvedByUser.set(r.user_id, (approvedByUser.get(r.user_id) ?? 0) + 1);
      }
    }

    for (const uid of ids) {
      const p = profileByUser.get(uid);
      const growthStatus = p?.growth_status ?? null;

      // ② 활동 중단 — 우선순위: suspended_week_id → 시즌 stopped → 시점 없는 growth_status.
      let suspended = false;
      const susWeek = p?.suspended_week_id ? suspendedWeekStartById.get(p.suspended_week_id) : null;
      if (susWeek) {
        // 중단 주차 자체는 마지막 활동 주차로 본다(주차 결과 표시 정책과 동일) → 그 **다음** 주차부터 제외.
        suspended = weekStartDate > susWeek;
      } else if (seasonStoppedIds.has(uid)) {
        // 그 시즌 전체가 중단 — 해당 시즌 주차에서 제외(과거 시즌 무영향).
        suspended = true;
      } else if (deriveEndStatus(growthStatus) === "stopped") {
        // 시점 정보 없음 → **현재·미래 주차에만** 적용. 과거 주차는 그대로 둔다(소급 금지).
        suspended = isCurrentOrFuture;
      }

      let elite = false;
      let basanos = false;
      if (withEvaluationAxes) {
        // ③ 엘리트 — activity_ended_at 이 있으면 그 주차 다음부터, 없으면 현재·미래만.
        if (growthStatus === "graduated") {
          const endWeek = eliteEndWeekByUser.get(uid) ?? null;
          elite = endWeek ? weekStartDate > endWeek : isCurrentOrFuture;
        }
        // ④ 바사노스 — 그 주차까지 누적 승인 ≥ 29. 엘리트(졸업 확정)는 바사노스로 이중 계산하지 않는다.
        if (!elite && growthStatus !== "graduated") {
          basanos = (approvedByUser.get(uid) ?? 0) >= GRADUATING_FROM_APPROVED_WEEKS;
        }
      }

      flagsByUser.set(uid, {
        seasonRest: seasonRestIds.has(uid),
        weekRest: weekRestIds.has(uid),
        suspended,
        elite,
        basanos,
      });
    }
  }
  return out;
}

async function loadEligibilityInternal(
  input: Input,
  withEvaluationAxes: boolean,
): Promise<Eligibility> {
  const weekStartDate = String(input.weekStartDate ?? "").slice(0, 10);
  const flagsByUser = new Map<string, EligibilityFlags>();
  if (!weekStartDate) return makeResolver(weekStartDate, flagsByUser);
  const byWeek = await loadEligibilityBulkInternal(
    {
      userIds: input.userIds,
      weeks: [{ weekStartDate, seasonKey: input.seasonKey }],
      today: input.today,
    },
    withEvaluationAxes,
  );
  return byWeek.get(weekStartDate) ?? makeResolver(weekStartDate, flagsByUser);
}

/**
 * ① 팀·파트 활동 가능 모집단 — 시즌 휴식 + 주차 휴식 + (효력 발생 후) 활동 중단만 판정한다.
 *   엘리트/바사노스 축은 조회하지 않는다(항상 false) — 팀 소속·운용 파트에서는 유지되기 때문.
 */
export async function loadTeamActivityEligibility(input: Input): Promise<Eligibility> {
  return loadEligibilityInternal(input, false);
}

/**
 * ① 을 여러 주차에 대해 한 번에 — 파트×주차 존재표처럼 26주를 동시에 판정할 때 쓴다.
 *   반환 = weekStartDate → Eligibility. 판정식은 단일 주차와 **같은 코드**(N+1 만 없앤 형태).
 */
export async function loadTeamActivityEligibilityBulk(
  input: BulkInput,
): Promise<Map<string, Eligibility>> {
  return loadEligibilityBulkInternal(input, false);
}

/**
 * ② 실무 평가 가능 모집단 — ① 에 엘리트·바사노스 축을 더해 판정한다.
 *   평가자 전용 역할(파트장 등) 제외는 호출부가 positionCode 로 판정한다.
 */
export async function loadEvaluationEligibility(input: Input): Promise<Eligibility> {
  return loadEligibilityInternal(input, true);
}
