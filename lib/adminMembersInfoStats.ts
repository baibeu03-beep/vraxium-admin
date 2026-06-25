// 멤버 관리 > 크루 정보 탭 [섹션.1] 집계 — 통합/클럽별 역대 누적 + 주차별 데이터.
//
// SoT 정책(2026-06-24 확정):
//   · [섹션.1-A] 역대 누적 = user_profiles (클럽 수 = 조직 상수, 누적 클러빙 = activity_started_at
//     보유, 누적 엘리트 = growth_status='graduated', 누적 활동중단 = growth_status∈suspended/paused).
//   · [섹션.1-B] 주차별 데이터 = weekly-cards snapshot 단일 SoT (readWeeklyCardsSnapshotBatch).
//       주차 휴식 = personal_rest · 시즌 휴식 = official_rest · 성공 = success · 실패 = fail.
//       클러빙 = success+fail+personal_rest+official_rest. 활동중단·엘리트 = 주차 SoT 없음 → null(placeholder).
//       주차 성장률(d) = 성공/실패 크루의 snapshot weeklyGrowthRate 평균(분모>0만). 성공율(c)=a/(a+b)*100.
//     ⚠ 주차별 표는 user_season_statuses / growth_status 를 조인하지 않는다(snapshot-only 정합).
//
// snapshot-only: 본 모듈은 snapshot 을 읽기만 한다(recompute/생성 호출 없음). demoUserId 무관
//   (org 전체 집계 — 개인 뷰 아님). mode(operating/test)로 모집단만 분리. 일반/테스트 경로 동일 DTO.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ORGANIZATIONS, type OrganizationSlug } from "@/lib/organizations";
import { SUPER_ADMIN_EXCLUDE_OR } from "@/lib/superAdmins";
import { resolveUserScope, type ScopeMode } from "@/lib/userScope";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";
import { weekName, type SeasonWeekRow } from "@/lib/practicalInfoSeasonWeeks";
import { getSeasonForDate } from "@/lib/seasonCalendar";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

const SNAPSHOT_TABLE = "cluster4_weekly_card_snapshots";

// snapshot 카드 배치 읽기(읽기 전용·snapshot-only) — 집계에 필요한 카드 배열만 받는다.
//   동일 SoT(cluster4_weekly_card_snapshots). stale/version_mismatch 여도 cards 배열이면 사용
//   (공용 readWeeklyCardsSnapshotBatch 와 동일 노출 정책). miss/error/손상 → null(부분 실패 카운트).
//   IN() URL 길이 방어 + Postgres statement timeout 방어를 위해 50개씩 순차 청크.
//   ⚠ 공용 함수/snapshot 생성·조회 정책은 건드리지 않는다(별도 read 경로).
//   ⚠ 성능: 600 크루 fat jsonb 전송이라 통합 탭은 수십 초 — 클라이언트가 (org,mode)별 캐시.
//      근본 단축은 DB측 jsonb 집계(RPC) 후속 과제(수동 마이그레이션 필요).
async function readSnapshotCards(
  userIds: string[],
): Promise<Map<string, Cluster4WeeklyCardDto[] | null>> {
  const out = new Map<string, Cluster4WeeklyCardDto[] | null>();
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  const CHUNK = 50;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { data, error } = await supabaseAdmin
      .from(SNAPSHOT_TABLE)
      .select("user_id,cards")
      .in("user_id", chunk);
    if (error) {
      for (const id of chunk) out.set(id, null); // 청크 실패 → 전원 미조회(부분 실패)
      continue;
    }
    for (const row of (data ?? []) as Array<{ user_id: string; cards: unknown }>) {
      out.set(row.user_id, Array.isArray(row.cards) ? (row.cards as Cluster4WeeklyCardDto[]) : null);
    }
  }
  return out;
}

// 누적 활동중단으로 보는 growth_status override 값(메모 SoT: suspended/paused).
//   (누적 엘리트=graduated 는 졸업/엘리트 기획 미정으로 현재 null 처리 — counting 미수행.)
const SUSPENDED_STATUSES = new Set(["suspended", "paused"]);

const SEASON_KEY_TO_KO: Record<string, string> = {
  spring: "봄",
  summer: "여름",
  autumn: "가을",
  fall: "가을",
  winter: "겨울",
};

const pad2 = (n: number) => String(n).padStart(2, "0");
const yy2 = (year: number) => pad2(((year % 100) + 100) % 100);

function seasonKoFromKey(seasonKey: string | null | undefined): string | null {
  if (!seasonKey) return null;
  for (const part of seasonKey.toLowerCase().split("-")) {
    const ko = SEASON_KEY_TO_KO[part];
    if (ko) return ko;
  }
  return null;
}

export type InfoCumulativeStats = {
  // 0. 데이터 시작 — 집계 데이터가 존재하는 가장 오래된 확정 주차명("24년 여름시즌 2주차"). 없으면 null.
  dataStartWeekLabel: string | null;
  // 1. 클럽 수 — 현재 스코프가 포괄하는 클럽 수(통합=3, 단일=1).
  clubCount: number;
  // 2. 누적 클러빙 — 클럽 등록 이력 보유자 전체(activity_started_at 보유). 모든 상태 포함.
  cumulativeClubbing: number;
  // 3. 누적 엘리트 — 정상 졸업자 누적. 졸업/엘리트 기획 미정 → null(필드 유지).
  cumulativeElite: number | null;
  // 4. 누적 활동 중단 — 활동 중단자 누적(growth_status∈suspended/paused).
  cumulativeSuspended: number;
};

// 주차별 표 우측 Po.A/B/C — 해당 주 스코프(조직) 내 최고 포인트 크루 TOP 3.
//   points = snapshot 카드 points.star(= user_weekly_points.points). 조직별 탭에서만 노출.
export type InfoTopCrew = { name: string; points: number };

export type InfoOldestCrew = {
  // 활동 시작 주차 라벨("24-여름-2"). 산정 불가 시 null.
  startWeekLabel: string | null;
  name: string;
  clubLabel: string;
};

export type InfoWeekRow = {
  weekId: string;
  // 시즌 & 주차("26년 여름시즌 7주차").
  seasonWeekName: string;
  // 1. 클럽 상태 — 공식 활동 | 공식 휴식(전환 주차 = 공식 휴식).
  clubStatus: "공식 활동" | "공식 휴식";
  // 확정(result_published_at) 여부. false 면 아래 집계값은 모두 null(프론트 "-").
  finalized: boolean;
  // 3. 클럽 수(해당 주 운영 클럽 수)
  clubCount: number | null;
  // 4. 클러빙
  clubbing: number | null;
  // 5. 시즌 휴식
  seasonalRest: number | null;
  // 6. 엘리트(기획 전 — placeholder null)
  elite: number | null;
  // 7. 활동 중단(주차 SoT 없음 — placeholder null)
  suspended: number | null;
  // 8. 주차 휴식
  weeklyRest: number | null;
  // 9. 성장 성공(a)
  growthSuccess: number | null;
  // 10. 성장 실패(b)
  growthFail: number | null;
  // 11. 성장 성공율(c) = a/(a+b)*100, 분모 0이면 null.
  growthSuccessRate: number | null;
  // 12. 주차 성장률(d) = 활동 크루(a+b) snapshot weeklyGrowthRate 평균, 대상 없으면 null.
  weeklyGrowthRate: number | null;
  // 13. Oldest(해당 주 활동 크루 중 최장 활동). 없으면 null.
  oldest: InfoOldestCrew | null;
  // 14~16. Po.A/B/C — 해당 주 스코프 최고 포인트 크루 TOP 3(내림차순). 없으면 null.
  //   조직별 탭에서만 표시(통합 탭은 컬럼 미노출). DTO 는 항상 채운다(조직 필터만 다름).
  weeklyTopPoints: InfoTopCrew[] | null;
};

export type MembersInfoStatsDto = {
  scope: { organization: OrganizationSlug | "all"; mode: ScopeMode; orgs: OrganizationSlug[] };
  cumulative: InfoCumulativeStats;
  weeks: InfoWeekRow[]; // 최신 주차 최상단(내림차순). 클라이언트가 20/page 페이지네이션.
  // 일부 크루 snapshot 미조회(miss/error) 안내 — 집계는 가능한 만큼 진행.
  partialFailure: { snapshotUnavailable: number } | null;
  generatedAt: string;
};

type RosterRow = {
  user_id: string;
  organization_slug: string | null;
  display_name: string | null;
  activity_started_at: string | null;
  growth_status: string | null;
};

const CLUB_LABEL_KO: Record<string, string> = {
  encre: "엥크레",
  oranke: "오랑캐",
  phalanx: "팔랑크스",
};
function clubLabelKo(slug: string | null): string {
  if (!slug) return "-";
  return CLUB_LABEL_KO[slug] ?? slug;
}

// user_profiles 스코프 로스터 — org∈orgs, activity_started_at 보유, super admin 제외, mode 스코프.
//   PostgREST 1000행 cap 회피를 위해 range 페이지네이션.
async function loadScopedRoster(
  orgs: OrganizationSlug[],
  mode: ScopeMode,
): Promise<RosterRow[]> {
  const scope = await resolveUserScope(mode, null);
  const PAGE = 1000;
  const out: RosterRow[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabaseAdmin
      .from("user_profiles")
      .select("user_id, organization_slug, display_name, activity_started_at, growth_status")
      .in("organization_slug", orgs)
      .not("activity_started_at", "is", null)
      .or(SUPER_ADMIN_EXCLUDE_OR)
      .order("user_id", { ascending: true })
      .range(from, from + PAGE - 1);
    // test 모드는 화이트리스트로 좁힌다(쿼리 비용 절감). operating 은 아래에서 제외 필터.
    if (mode === "test") {
      const ids = scope.includeUserIds ?? [];
      if (ids.length === 0) return out;
      q = q.in("user_id", ids);
    }
    const { data, error } = await q;
    if (error) {
      console.warn("[members-info-stats] roster 조회 실패", error.message);
      break;
    }
    const rows = (data ?? []) as RosterRow[];
    for (const r of rows) {
      if (mode === "operating" && !scope.includes(r.user_id)) continue; // 테스트 유저 제외
      out.push(r);
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

// 주차별 누산기.
type WeekAcc = {
  success: number;
  fail: number;
  personalRest: number;
  officialRest: number;
  // 진행 중(running/tallying) 카드 수 — 1개라도 있으면 그 주차는 아직 확정 아님(미확정 게이트).
  inProgress: number;
  rateSum: number;
  rateCount: number;
  orgsWithClubbing: Set<string>;
  oldest: { startedAt: string; name: string; clubLabel: string } | null;
  // 해당 주 포인트(star>0) 보유 크루 — 행 조립에서 정렬·TOP3 산출(Po.A/B/C).
  topPoints: { name: string; points: number }[];
};

function newAcc(): WeekAcc {
  return {
    success: 0,
    fail: 0,
    personalRest: 0,
    officialRest: 0,
    inProgress: 0,
    rateSum: 0,
    rateCount: 0,
    orgsWithClubbing: new Set(),
    oldest: null,
    topPoints: [],
  };
}

const WEEK_MS = 7 * 86_400_000;
function dateMs(iso: string): number {
  return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
}

// 활동 시작일 → "24-여름-2" 시즌/주차 라벨.
//   ① DB weeks(loadSeasonWeeks)에서 포함 주차 우선(2023+ 운영 데이터 SoT 일치).
//   ② DB 범위 밖(예: 2021/2022 — weeks 테이블 시작 2023-03-06 이전)은 seasonCalendar(순수 캘린더,
//      앵커 2023-01-02·연 52주 순환·과거로 무한 확장)로 폴백 계산. user_season_statuses/growth_status
//      와 무관한 날짜→시즌 변환일 뿐(주차표 집계 SoT 미변경). 둘 다 실패하면 null + 경고 로그(보고용).
function activityStartLabel(
  startedAtIso: string | null,
  allWeeks: SeasonWeekRow[],
): string | null {
  if (!startedAtIso) return null;
  const date = startedAtIso.slice(0, 10);
  // ① DB weeks
  const w = allWeeks.find(
    (x) =>
      x.week_start_date != null &&
      x.week_end_date != null &&
      x.week_start_date <= date &&
      date <= x.week_end_date,
  );
  if (w && w.week_number != null) {
    const ko = seasonKoFromKey(w.season_key);
    const yearSource = w.week_end_date ?? w.week_start_date;
    const year = yearSource ? Number(yearSource.slice(0, 4)) : NaN;
    if (ko && Number.isFinite(year)) return `${yy2(year)}-${ko}-${w.week_number}`;
  }
  // ② seasonCalendar 폴백(DB 범위 밖 — 과거 시작일)
  const season = getSeasonForDate(date);
  if (season) {
    const weekIndex = Math.floor((dateMs(date) - dateMs(season.startDate)) / WEEK_MS);
    if (weekIndex >= 0) return `${yy2(season.year)}-${season.type}-${weekIndex + 1}`;
  }
  console.warn("[members-info-stats] Oldest 활동시작주차 미해석", { startedAt: startedAtIso });
  return null;
}

export async function loadMembersInfoStats(opts: {
  organization: OrganizationSlug | "all";
  mode: ScopeMode;
}): Promise<MembersInfoStatsDto> {
  const orgs: OrganizationSlug[] =
    opts.organization === "all" ? [...ORGANIZATIONS] : [opts.organization];

  // ── 로스터 + 주차 메타 ──
  const [roster, seasonWeeks] = await Promise.all([
    loadScopedRoster(orgs, opts.mode),
    loadSeasonWeeks(),
  ]);

  // ── [섹션.1-A] 역대 누적 ──
  let cumulativeSuspended = 0;
  for (const r of roster) {
    if (r.growth_status != null && SUSPENDED_STATUSES.has(r.growth_status)) cumulativeSuspended++;
  }
  const cumulative: InfoCumulativeStats = {
    dataStartWeekLabel: null, // weeks 조립 후 설정(가장 오래된 확정·데이터 보유 주차).
    clubCount: orgs.length,
    cumulativeClubbing: roster.length,
    cumulativeElite: null, // 졸업/엘리트 기획 미정 → null(필드 유지).
    cumulativeSuspended,
  };

  // ── 주차 목록(시작된 주차만, 로스터 활동 시작 이후) ──
  const today = new Date().toISOString().slice(0, 10);
  const allWeeks = seasonWeeks.rows as SeasonWeekRow[];
  const orgByUser = new Map(roster.map((r) => [r.user_id, r.organization_slug]));
  const metaByUser = new Map(
    roster.map((r) => [r.user_id, { name: r.display_name ?? "-", startedAt: r.activity_started_at }]),
  );

  // 로스터 최초 활동 시작일(이전 빈 주차 노출 방지 하한).
  let earliestStart: string | null = null;
  for (const r of roster) {
    const s = r.activity_started_at ? r.activity_started_at.slice(0, 10) : null;
    if (s && (earliestStart == null || s < earliestStart)) earliestStart = s;
  }

  const weeksAsc = seasonWeeks.rows.filter((w) => {
    if (!w.week_start_date || w.week_start_date > today) return false; // 미래 주차 제외
    if (earliestStart && w.week_end_date && w.week_end_date < earliestStart) return false; // 활동 이전 제외
    return true;
  });

  // 확정 게이트 = 주차 종료(week_end_date < 오늘) 여부. 현재/미래 주차는 "-".
  //   (확정성은 result_published_at 이 아니라 snapshot 카드 상태로 판정 — 아래 inProgress 게이트.)
  const weekEndedById = new Map<string, boolean>();
  for (const w of weeksAsc) {
    weekEndedById.set(w.week_id, !!(w.week_end_date && w.week_end_date < today));
  }

  // ── [섹션.1-B] snapshot 단일 SoT 집계 ──
  const accByWeekId = new Map<string, WeekAcc>();
  for (const w of weeksAsc) accByWeekId.set(w.week_id, newAcc());

  const userIds = roster.map((r) => r.user_id);
  const snapshots = await readSnapshotCards(userIds);
  let snapshotUnavailable = 0;
  for (const uid of userIds) {
    const cards = snapshots.get(uid);
    if (!cards) {
      snapshotUnavailable++;
      continue;
    }
    const org = orgByUser.get(uid) ?? null;
    const meta = metaByUser.get(uid);
    for (const card of cards) {
      if (!card.weekId) continue;
      const acc = accByWeekId.get(card.weekId);
      if (!acc) continue; // 표시 대상 주차가 아님

      let belongs = false;
      switch (card.userWeekStatus) {
        case "success":
          acc.success++;
          belongs = true;
          if (card.growthDenominator > 0) {
            acc.rateSum += card.weeklyGrowthRate;
            acc.rateCount++;
          }
          break;
        case "fail":
          acc.fail++;
          belongs = true;
          if (card.growthDenominator > 0) {
            acc.rateSum += card.weeklyGrowthRate;
            acc.rateCount++;
          }
          break;
        case "personal_rest":
          acc.personalRest++;
          belongs = true;
          break;
        case "official_rest":
          acc.officialRest++;
          belongs = true;
          break;
        default:
          acc.inProgress++; // running/tallying = 아직 진행/집계 중(미확정 신호)
          break;
      }
      if (belongs) {
        if (org) acc.orgsWithClubbing.add(org);
        // Oldest — 최장 활동(최소 activity_started_at) 갱신.
        const startedAt = meta?.startedAt ? meta.startedAt.slice(0, 10) : null;
        if (startedAt) {
          if (acc.oldest == null || startedAt < acc.oldest.startedAt) {
            acc.oldest = {
              startedAt: meta!.startedAt as string,
              name: meta?.name ?? "-",
              clubLabel: clubLabelKo(org),
            };
          }
        }
      }
      // Po.A/B/C — 해당 주 포인트(star = user_weekly_points.points) 보유 크루 수집(>0만).
      const star = card.points?.star;
      if (typeof star === "number" && star > 0) {
        acc.topPoints.push({ name: meta?.name ?? "-", points: star });
      }
    }
  }

  // ── 행 조립(최신 주차 최상단) ──
  const weeksDesc = [...weeksAsc].reverse();
  const weeks: InfoWeekRow[] = weeksDesc.map((w) => {
    const clubStatus: "공식 활동" | "공식 휴식" =
      w.is_official_rest === true || w.is_transition === true ? "공식 휴식" : "공식 활동";
    const seasonWeekName = weekName(w as SeasonWeekRow);
    const acc0 = accByWeekId.get(w.week_id) ?? newAcc();
    const confirmedCount = acc0.success + acc0.fail + acc0.personalRest + acc0.officialRest;
    // 확정 판정(snapshot 단일 SoT) — 주차 종료 + 확정 카드 존재 + 진행중(running/tallying) 0.
    //   공식 휴식 주차라도 snapshot 에 official_rest 등 확정 카드가 있으면 집계를 표시한다.
    //   현재/미래 주차(미종료) 또는 확정 카드 없음/진행중 잔존 = 미확정 → "-".
    const finalized =
      weekEndedById.get(w.week_id) === true && confirmedCount > 0 && acc0.inProgress === 0;
    if (!finalized) {
      return {
        weekId: w.week_id,
        seasonWeekName,
        clubStatus,
        finalized: false,
        clubCount: null,
        clubbing: null,
        seasonalRest: null,
        elite: null,
        suspended: null,
        weeklyRest: null,
        growthSuccess: null,
        growthFail: null,
        growthSuccessRate: null,
        weeklyGrowthRate: null,
        oldest: null,
        weeklyTopPoints: null,
      };
    }
    const acc = acc0;
    const a = acc.success;
    const b = acc.fail;
    const clubbing = a + b + acc.personalRest + acc.officialRest;
    const denom = a + b;
    const growthSuccessRate = denom > 0 ? Math.round((a / denom) * 100) : null;
    const weeklyGrowthRate =
      acc.rateCount > 0 ? Math.round((acc.rateSum / acc.rateCount) * 10) / 10 : null;
    const oldest: InfoOldestCrew | null = acc.oldest
      ? {
          startWeekLabel: activityStartLabel(acc.oldest.startedAt, allWeeks),
          name: acc.oldest.name,
          clubLabel: acc.oldest.clubLabel,
        }
      : null;
    // Po.A/B/C — 포인트 내림차순(동점 이름순) TOP 3. 없으면 null.
    const sortedTop = [...acc.topPoints].sort(
      (p, q) => q.points - p.points || p.name.localeCompare(q.name, "ko"),
    );
    const weeklyTopPoints: InfoTopCrew[] | null =
      sortedTop.length > 0 ? sortedTop.slice(0, 3) : null;
    return {
      weekId: w.week_id,
      seasonWeekName,
      clubStatus,
      finalized: true,
      clubCount: acc.orgsWithClubbing.size,
      clubbing,
      seasonalRest: acc.officialRest,
      elite: null, // placeholder(기획 전)
      suspended: null, // placeholder(주차 SoT 없음)
      weeklyRest: acc.personalRest,
      growthSuccess: a,
      growthFail: b,
      growthSuccessRate,
      weeklyGrowthRate,
      oldest,
      weeklyTopPoints,
    };
  });

  // 데이터 시작 — 집계 데이터가 있는 가장 오래된 확정 주차(weeks 는 desc → 뒤에서부터 탐색).
  const oldestWithData =
    [...weeks].reverse().find((w) => w.finalized && (w.clubbing ?? 0) > 0) ?? null;
  cumulative.dataStartWeekLabel = oldestWithData ? oldestWithData.seasonWeekName : null;

  return {
    scope: { organization: opts.organization, mode: opts.mode, orgs },
    cumulative,
    weeks,
    partialFailure: snapshotUnavailable > 0 ? { snapshotUnavailable } : null,
    generatedAt: new Date().toISOString(),
  };
}
