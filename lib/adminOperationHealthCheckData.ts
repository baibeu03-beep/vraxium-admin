// Server-only data layer for the admin "운영 정합성 점검" 화면.
//
// 조회 전용(read-only). 기존 데이터를 일절 수정하지 않으며, 시즌/주차/성장 통계
// 테이블을 읽어 정합성 문제만 진단한다. 자동 수정은 하지 않는다.
//
// 점검 항목과 issue_type 매핑은 lib/adminOperationHealthCheckTypes 주석 참조.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  HEALTH_ISSUE_TYPE_META,
  type HealthIssue,
  type HealthIssueType,
  type OperationHealthCheckDto,
} from "@/lib/adminOperationHealthCheckTypes";

// issues 배열 안전 상한. 초과 시 잘라내고 truncated=true. summary 카운트는 전체 기준.
const MAX_ISSUES = 500;

// 테이블이 커도 한 번에 읽을 수 있는 보수적 상한(앱 규모상 충분).
const SELECT_CAP = 50000;

type ProfileRow = {
  user_id: string;
  display_name: string | null;
  organization_slug: string | null;
};

type GrowthRow = {
  user_id: string;
  approved_weeks: number | null;
  cumulative_weeks: number | null;
};

type WeekStatusRow = {
  id: string;
  user_id: string;
  year: number | null;
  week_number: number | null;
  season_key: string | null;
  status: string;
};

type SeasonStatusRow = {
  user_id: string;
  season_key: string;
  status: string;
};

type WeekRow = {
  id: string;
  season_key: string | null;
  iso_year: number | null;
  iso_week: number | null;
};

function isoKey(year: number | null, week: number | null): string | null {
  if (year == null || week == null) return null;
  return `${year}::${week}`;
}

// PostgREST 는 단발 요청당 최대 1000행만 돌려준다(.limit(n) 으로도 우회되지 않음).
// 전체 행을 읽기 위해 .range() 로 페이지네이션한다. SELECT_CAP 안전 상한을 넘지 않는다.
//   - build(): 매 페이지마다 .range() 를 적용하지 않은 새 select 쿼리를 반환해야 한다
//     (Supabase 쿼리 빌더는 await 후 재사용 불가하므로 페이지마다 새로 만든다).
const PAGE_SIZE = 1000;

async function fetchAllRows<T>(
  build: () => { range: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }> },
  cap: number = SELECT_CAP,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < cap; from += PAGE_SIZE) {
    const to = Math.min(from + PAGE_SIZE - 1, cap - 1);
    const { data, error } = await build().range(from, to);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    // 마지막 페이지(요청 크기 미만)면 종료. cap 경계에서도 자연 종료.
    if (rows.length < to - from + 1) break;
  }
  return out;
}

type GrowthAgg = { total: number; success: number };

// 성장 통계 불일치 판정(SoT). user_growth_stats 캐시값과 user_week_statuses 집계를
// 비교해 불일치 항목을 돌려준다. health-check 항목 1·2 와 수동 재집계가 공유한다.
//   - missing_row : growth row 자체가 없는데 uws 가 존재(누적 캐시 부재)
//   - approved    : approved_weeks ≠ uws(status='success') 수
//   - cumulative  : cumulative_weeks ≠ uws 전체 row 수
type GrowthMismatchKind = "missing_row" | "approved" | "cumulative";

type GrowthMismatch = {
  user_id: string;
  kind: GrowthMismatchKind;
  expected: number;
  actual: number | null;
};

function collectGrowthStatsMismatches(
  aggByUser: Map<string, GrowthAgg>,
  growthMap: Map<string, GrowthRow>,
): GrowthMismatch[] {
  const out: GrowthMismatch[] = [];
  // growth_stats 가 있는 사용자와 uws 가 있는 사용자의 합집합을 검사한다.
  const userUnion = new Set<string>([...growthMap.keys(), ...aggByUser.keys()]);
  for (const userId of userUnion) {
    const agg = aggByUser.get(userId) ?? { total: 0, success: 0 };
    const growth = growthMap.get(userId);

    if (!growth) {
      if (agg.total > 0) {
        out.push({
          user_id: userId,
          kind: "missing_row",
          expected: agg.total,
          actual: null,
        });
      }
      continue;
    }

    if ((growth.approved_weeks ?? 0) !== agg.success) {
      out.push({
        user_id: userId,
        kind: "approved",
        expected: agg.success,
        actual: growth.approved_weeks ?? 0,
      });
    }
    if ((growth.cumulative_weeks ?? 0) !== agg.total) {
      out.push({
        user_id: userId,
        kind: "cumulative",
        expected: agg.total,
        actual: growth.cumulative_weeks ?? 0,
      });
    }
  }
  return out;
}

// uws status 목록만으로 사용자별 (전체/ success) 집계를 만든다.
function aggregateGrowthByUser(
  rows: { user_id: string; status: string }[],
): Map<string, GrowthAgg> {
  const aggByUser = new Map<string, GrowthAgg>();
  for (const r of rows) {
    const ua = aggByUser.get(r.user_id) ?? { total: 0, success: 0 };
    ua.total += 1;
    if (r.status === "success") ua.success += 1;
    aggByUser.set(r.user_id, ua);
  }
  return aggByUser;
}

// 성장 통계가 불일치한 user_id 목록(정렬·중복제거). 수동 재집계 all_mismatched 모드용.
// health-check 항목 1·2 와 동일 기준(collectGrowthStatsMismatches)을 사용한다.
// 읽기 전용 — 어떤 테이블도 수정하지 않는다.
export async function getGrowthStatsMismatchedUserIds(): Promise<string[]> {
  // 전체 행 페이지네이션 — 1000행 캡으로 인한 과소 집계 방지.
  const [growthRows, weekStatuses] = await Promise.all([
    fetchAllRows<GrowthRow>(() =>
      supabaseAdmin
        .from("user_growth_stats")
        .select("user_id,approved_weeks,cumulative_weeks"),
    ),
    fetchAllRows<{ user_id: string; status: string }>(() =>
      supabaseAdmin.from("user_week_statuses").select("user_id,status"),
    ),
  ]);

  const growthMap = new Map<string, GrowthRow>();
  for (const g of growthRows) {
    growthMap.set(g.user_id, g);
  }
  const aggByUser = aggregateGrowthByUser(weekStatuses);

  const ids = Array.from(
    new Set(collectGrowthStatsMismatches(aggByUser, growthMap).map((m) => m.user_id)),
  );
  ids.sort();
  return ids;
}

export async function getOperationHealthCheck(): Promise<OperationHealthCheckDto> {
  // 1) 필요한 테이블을 병렬로 읽는다(모두 read-only).
  //    PostgREST 1000행 캡을 피하기 위해 전부 fetchAllRows 로 페이지네이션한다.
  //    (season_definitions/weeks 는 소량이지만 일관성·미래 증가 대비를 위해 동일 경로 사용.)
  const [seasonRows, profiles, growthRows, weekStatuses, seasonStatuses, weeks] =
    await Promise.all([
      fetchAllRows<{ season_key: string }>(() =>
        supabaseAdmin.from("season_definitions").select("season_key"),
      ),
      fetchAllRows<ProfileRow>(() =>
        supabaseAdmin
          .from("user_profiles")
          .select("user_id,display_name,organization_slug"),
      ),
      fetchAllRows<GrowthRow>(() =>
        supabaseAdmin
          .from("user_growth_stats")
          .select("user_id,approved_weeks,cumulative_weeks"),
      ),
      fetchAllRows<WeekStatusRow>(() =>
        supabaseAdmin
          .from("user_week_statuses")
          .select("id,user_id,year,week_number,season_key,status"),
      ),
      fetchAllRows<SeasonStatusRow>(() =>
        supabaseAdmin.from("user_season_statuses").select("user_id,season_key,status"),
      ),
      fetchAllRows<WeekRow>(() =>
        supabaseAdmin.from("weeks").select("id,season_key,iso_year,iso_week"),
      ),
    ]);

  const seasonKeys = new Set(seasonRows.map((s) => s.season_key));

  const profileMap = new Map<string, ProfileRow>();
  for (const p of profiles) profileMap.set(p.user_id, p);

  const userName = (userId: string | null) =>
    userId ? profileMap.get(userId)?.display_name ?? null : null;
  const userOrg = (userId: string | null) =>
    userId ? profileMap.get(userId)?.organization_slug ?? null : null;

  // weeks 의 (iso_year, iso_week) 집합 — 주차 매핑 판정용.
  const weekIsoSet = new Set<string>();
  for (const w of weeks) {
    const k = isoKey(w.iso_year, w.iso_week);
    if (k) weekIsoSet.add(k);
  }

  // 사용자별 uws 집계: 전체 row 수 / status='success' 수.
  const aggByUser = aggregateGrowthByUser(weekStatuses);
  // (user, season_key) 별 집계: 전체 / personal_rest 수.
  const aggByUserSeason = new Map<
    string,
    { total: number; personalRest: number }
  >();
  for (const r of weekStatuses) {
    if (r.season_key) {
      const key = `${r.user_id}::${r.season_key}`;
      const sa = aggByUserSeason.get(key) ?? { total: 0, personalRest: 0 };
      sa.total += 1;
      if (r.status === "personal_rest") sa.personalRest += 1;
      aggByUserSeason.set(key, sa);
    }
  }

  const growthMap = new Map<string, GrowthRow>();
  for (const g of growthRows) growthMap.set(g.user_id, g);

  const issues: HealthIssue[] = [];
  const push = (
    issueType: HealthIssueType,
    fields: Omit<HealthIssue, "issue_type" | "severity">,
  ) => {
    issues.push({
      issue_type: issueType,
      severity: HEALTH_ISSUE_TYPE_META[issueType].severity,
      ...fields,
    });
  };

  // ── 항목 1·2: user_growth_stats 캐시 vs uws 집계 불일치 ───────────────
  // 판정 기준은 수동 재집계와 공유(collectGrowthStatsMismatches)한다.
  for (const m of collectGrowthStatsMismatches(aggByUser, growthMap)) {
    const base = {
      user_id: m.user_id,
      user_name: userName(m.user_id),
      organization_slug: userOrg(m.user_id),
      season_key: null,
      week_id: null,
    };
    if (m.kind === "missing_row") {
      push("growth_cumulative_mismatch", {
        ...base,
        message:
          "user_week_statuses 는 존재하지만 user_growth_stats row 가 없습니다.",
        expected_value: String(m.expected),
        actual_value: "(row 없음)",
      });
    } else if (m.kind === "approved") {
      push("growth_approved_mismatch", {
        ...base,
        message:
          "user_growth_stats.approved_weeks 가 user_week_statuses(status='success') 수와 다릅니다.",
        expected_value: String(m.expected),
        actual_value: String(m.actual ?? 0),
      });
    } else {
      push("growth_cumulative_mismatch", {
        ...base,
        message:
          "user_growth_stats.cumulative_weeks 가 user_week_statuses 전체 row 수와 다릅니다.",
        expected_value: String(m.expected),
        actual_value: String(m.actual ?? 0),
      });
    }
  }

  // ── 항목 3·4: user_season_statuses 와 해당 시즌 주차 상태 정합성 ──────
  for (const ss of seasonStatuses) {
    const key = `${ss.user_id}::${ss.season_key}`;
    const sa = aggByUserSeason.get(key);

    if (ss.status === "rest") {
      // 시즌 휴식인데 해당 시즌 주차에 personal_rest 가 전혀 없음.
      const personalRest = sa?.personalRest ?? 0;
      if (personalRest === 0) {
        push("season_rest_without_personal_rest", {
          user_id: ss.user_id,
          user_name: userName(ss.user_id),
          organization_slug: userOrg(ss.user_id),
          season_key: ss.season_key,
          week_id: null,
          message:
            "시즌 상태가 'rest' 이지만 해당 시즌 user_week_statuses 에 personal_rest 주차가 없습니다.",
          expected_value: "personal_rest ≥ 1",
          actual_value: `personal_rest ${personalRest} / 주차 ${sa?.total ?? 0}`,
        });
      }
    } else if (ss.status === "success") {
      // 시즌 참여인데 해당 시즌 모든 주차가 personal_rest (주차가 1개 이상일 때만).
      if (sa && sa.total > 0 && sa.personalRest === sa.total) {
        push("season_success_all_personal_rest", {
          user_id: ss.user_id,
          user_name: userName(ss.user_id),
          organization_slug: userOrg(ss.user_id),
          season_key: ss.season_key,
          week_id: null,
          message:
            "시즌 상태가 'success' 이지만 해당 시즌 모든 주차가 personal_rest 입니다.",
          expected_value: "personal_rest < 전체 주차",
          actual_value: `personal_rest ${sa.personalRest} / 주차 ${sa.total}`,
        });
      }
    }
  }

  // ── 항목 5: weeks.season_key 가 season_definitions 에 없음 ────────────
  for (const w of weeks) {
    if (w.season_key == null || !seasonKeys.has(w.season_key)) {
      push("week_season_key_orphan", {
        user_id: null,
        user_name: null,
        organization_slug: null,
        season_key: w.season_key,
        week_id: w.id,
        message:
          "weeks.season_key 가 season_definitions 에 정의되어 있지 않습니다.",
        expected_value: "season_definitions 에 존재",
        actual_value: w.season_key == null ? "(null)" : w.season_key,
      });
    }
  }

  // ── 항목 6·7: user_week_statuses 의 season_key / 주차 매핑 ────────────
  for (const r of weekStatuses) {
    // 6) season_key 가 정의에 없음(FK 상 보통 null 누락).
    if (r.season_key == null || !seasonKeys.has(r.season_key)) {
      push("uws_season_key_orphan", {
        user_id: r.user_id,
        user_name: userName(r.user_id),
        organization_slug: userOrg(r.user_id),
        season_key: r.season_key,
        week_id: null,
        message:
          "user_week_statuses.season_key 가 season_definitions 에 정의되어 있지 않습니다.",
        expected_value: "season_definitions 에 존재",
        actual_value: r.season_key == null ? "(null)" : r.season_key,
      });
    }

    // 7) (year, week_number) 가 weeks(iso_year, iso_week) 로 매핑되지 않음.
    const k = isoKey(r.year, r.week_number);
    if (k == null || !weekIsoSet.has(k)) {
      push("uws_week_unmapped", {
        user_id: r.user_id,
        user_name: userName(r.user_id),
        organization_slug: userOrg(r.user_id),
        season_key: r.season_key,
        week_id: null,
        message:
          "user_week_statuses 가 weeks(iso_year, iso_week) 와 (year, week_number) 로 매칭되지 않습니다.",
        expected_value: "weeks 에 매칭되는 주차 존재",
        actual_value:
          k == null
            ? "(year/week_number 누락)"
            : `${r.year}년 ${r.week_number}주(매칭 없음)`,
      });
    }
  }

  // ── 집계: 분류별 카운트(잘리기 전 전체 기준) ─────────────────────────
  let growth = 0;
  let seasonRest = 0;
  let seasonKey = 0;
  let weekMapping = 0;
  for (const issue of issues) {
    const category = HEALTH_ISSUE_TYPE_META[issue.issue_type].category;
    if (category === "growth_stats") growth += 1;
    else if (category === "season_rest") seasonRest += 1;
    else if (category === "season_key") seasonKey += 1;
    else if (category === "week_mapping") weekMapping += 1;
  }

  // 표시 정렬: 심각도(error 먼저) → issue_type → 사용자명.
  const severityRank = (s: HealthIssue["severity"]) => (s === "error" ? 0 : 1);
  issues.sort((a, b) => {
    if (a.severity !== b.severity)
      return severityRank(a.severity) - severityRank(b.severity);
    if (a.issue_type !== b.issue_type)
      return a.issue_type < b.issue_type ? -1 : 1;
    const an = a.user_name ?? "";
    const bn = b.user_name ?? "";
    return an < bn ? -1 : an > bn ? 1 : 0;
  });

  const totalIssues = issues.length;
  const truncated = totalIssues > MAX_ISSUES;
  const returnedIssues = truncated ? issues.slice(0, MAX_ISSUES) : issues;

  return {
    summary: {
      total_issues: totalIssues,
      growth_stats_mismatch_count: growth,
      season_rest_mismatch_count: seasonRest,
      season_key_mismatch_count: seasonKey,
      week_mapping_mismatch_count: weekMapping,
    },
    issues: returnedIssues,
    truncated,
    generated_at: new Date().toISOString(),
  };
}
