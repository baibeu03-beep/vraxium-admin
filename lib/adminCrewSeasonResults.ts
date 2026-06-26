import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { computeSeasonRecords } from "@/lib/cluster1ResumeData";
import { computeSeasonActivityStatuses } from "@/lib/cluster4WeeklyGrowthData";
import { computeSeasonAreaProgress } from "@/lib/cluster4SeasonCircles";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { getSeasonCalendar, toDbSeasonKey, type Season } from "@/lib/seasonCalendar";
import { classLabel } from "@/lib/adminMembersTypes";

// ─────────────────────────────────────────────────────────────────────
// 클럽 결과(시즌) 하단부 — 시즌별 결과 표(/admin/members 상세).
//
// 한 행 = 크루가 활동한 한 시즌. 모두 고객 "시즌 그로스" 와 동일 SoT 직결(프론트 재계산 금지):
//   · 시즌 결과 라벨 = computeSeasonRecords(이력서 seasonRecords).progressStatus 를
//     고객 deriveSeasonStatus 와 동일하게 매핑 — 고객이 이 admin DTO 를 graft 하는 단일 출처.
//   · Po.A/B/C = user_weekly_points 를 시즌(week_start_date→season_key)별로 합산(시즌 단위·비누적).
//   · 허브 강화율 4종 = computeSeasonAreaProgress(weekly-cards snapshot, seasonKey) — area-7 동일 산식.
//   · 소속&클래스 = computeSeasonActivityStatuses(seasonKey 범위) — area-8 동일 산식(시즌별 다건).
//
// 정렬 = 현재 시즌(진행 중) 맨 위, 그 아래 시작일 DESC. 페이지네이션 없음(시즌 ≤ ~10개).
// 읽기 전용 — snapshot/포인트/uws 무접촉.
// ─────────────────────────────────────────────────────────────────────

const SEASON_TYPE_KO: Record<string, string> = {
  winter: "겨울",
  spring: "봄",
  summer: "여름",
  autumn: "가을",
};
// computeSeasonRecords.seasonName("봄 시즌") → season_key type(역매핑, 고객 graft 와 동일).
const SEASON_NAME_TO_TYPE: Record<string, string> = {
  봄: "spring",
  여름: "summer",
  가을: "autumn",
  겨울: "winter",
};
// 정규 시즌 키만(전환/break 시즌 제외).
const CANON_KEY = /^(\d{4})-(winter|spring|summer|autumn)$/;

export type CrewSeasonMembership = {
  teamName: string | null;
  partName: string | null;
  classLabel: string; // 일반/심화(에이전트)/심화(파트장)/팀장(…)/앰배서더/-
};

export type CrewSeasonResultRow = {
  seasonKey: string; // "2026-spring"
  seasonNameShort: string; // "26-봄"
  seasonResultLabel: "진행 중" | "시즌 성공" | "시즌 휴식" | "시즌 중단";
  poA: number; // Σ points (시즌 단위)
  poB: number; // Σ advantages
  poC: number; // Σ penalty
  hubRates: {
    info: number | null; // 실무 정보 강화율(%) — 데이터 없음 null
    experience: number | null; // 실무 경험
    ability: number | null; // 실무 역량(competency)
    career: number | null; // 실무 경력
  };
  memberships: CrewSeasonMembership[]; // 시즌 내 복수 소속/클래스(없으면 [])
};

// 고객 deriveSeasonStatus(app/(host)/api/cluster4/weekly-growth) 동치 — 5종 라벨 산출.
function deriveSeasonStatusLabel(args: {
  isCurrent: boolean;
  endDate: string | null;
  today: string;
  growthStatus: string | null;
  userStatus: string | null;
  resumeProgressStatus: string | null;
  resumeGraftLoaded: boolean;
  // 현재 시즌(isCurrent)의 시즌 스코프 상태 — user_season_statuses(현재 시즌). whole-person 아님.
  currentSeasonRest: boolean;
  currentSeasonStopped: boolean;
}): string {
  const { isCurrent, endDate, today, growthStatus, userStatus, resumeProgressStatus, resumeGraftLoaded, currentSeasonRest, currentSeasonStopped } = args;
  const gs = String(growthStatus || "").toLowerCase();
  const st = String(userStatus || "").toLowerCase();
  // 시즌 중단 = 현재 시즌 stopped(시즌 스코프) 또는 whole-person 운영 override. 휴식보다 우선.
  const isFailed =
    currentSeasonStopped || gs === "suspended" || gs === "withdrawn" || gs === "expelled" || gs === "deferred" || st === "suspended";
  // 시즌 휴식 = 현재 시즌 rest(시즌 스코프). 종전 whole-person growth_status 판정을 정정.
  const isRest = currentSeasonRest;

  // 시즌 중 졸업 — 최우선(이력서 "정상 졸업" 또는 graft 미확보 시 현재 시즌 graduated 폴백).
  if (resumeProgressStatus === "정상 졸업" || (!resumeGraftLoaded && isCurrent && gs === "graduated")) {
    return "시즌 중 졸업";
  }

  let status: "active" | "ended" | "rest";
  let seasonResult: "success" | "failed" | "none";
  if (isCurrent) {
    if (isFailed) {
      status = "ended";
      seasonResult = "failed";
    } else if (isRest) {
      status = "rest";
      seasonResult = "none";
    } else {
      status = "active";
      seasonResult = "none";
    }
  } else if (endDate && today > endDate) {
    if (resumeProgressStatus === "활동 중단") {
      status = "ended";
      seasonResult = "failed";
    } else if (resumeProgressStatus === "통합 휴식") {
      status = "rest";
      seasonResult = "none";
    } else {
      // 정상 졸업/정상 완료/미확보 → 시즌 성공(기존 기본값 보존).
      status = "ended";
      seasonResult = "success";
    }
  } else {
    status = "active";
    seasonResult = "none";
  }

  return status === "active"
    ? "시즌 진행 중"
    : status === "rest"
      ? "시즌 휴식"
      : seasonResult === "success"
        ? "시즌 성공"
        : seasonResult === "failed"
          ? "시즌 중단"
          : "시즌 휴식";
}

// 고객 5종 라벨 → 어드민 4종 라벨(시즌 중 졸업=시즌 성공 통일).
function toAdminLabel(customerLabel: string): CrewSeasonResultRow["seasonResultLabel"] {
  switch (customerLabel) {
    case "시즌 진행 중":
      return "진행 중";
    case "시즌 휴식":
      return "시즌 휴식";
    case "시즌 중단":
      return "시즌 중단";
    default:
      // 시즌 성공 / 시즌 중 졸업
      return "시즌 성공";
  }
}

// season_key("2026-spring") → 해당 시즌 Season(startDate/endDate 포함). 미일치 null.
function seasonKeyToSeason(seasonKey: string): Season | null {
  const m = seasonKey.match(CANON_KEY);
  if (!m) return null;
  const year = Number(m[1]);
  return getSeasonCalendar(year).find((s) => toDbSeasonKey(s.year, s.type) === seasonKey) ?? null;
}

// season_key("2026-spring") → "26-봄".
function seasonKeyToShort(seasonKey: string): string {
  const m = seasonKey.match(CANON_KEY);
  if (!m) return seasonKey;
  return `${m[1].slice(2)}-${SEASON_TYPE_KO[m[2]] ?? m[2]}`;
}

export async function getCrewSeasonResults(
  userId: string,
  todayIso: string,
): Promise<CrewSeasonResultRow[]> {
  const [wpRes, wsRes, profileRes, records, snapshot, seasonStatusRes] = await Promise.all([
    supabaseAdmin
      .from("user_weekly_points")
      .select("week_start_date,points,advantages,penalty")
      .eq("user_id", userId),
    supabaseAdmin.from("user_week_statuses").select("week_start_date").eq("user_id", userId),
    supabaseAdmin.from("user_profiles").select("growth_status,status").eq("user_id", userId).maybeSingle(),
    computeSeasonRecords(userId),
    readWeeklyCardsSnapshot(userId),
    // 시즌 스코프 휴식/중단 — user_season_statuses(season_key 별). 현재 시즌 라벨에만 사용.
    supabaseAdmin.from("user_season_statuses").select("season_key,status").eq("user_id", userId),
  ]);
  // season_key → {rest, stopped}
  const seasonStatusByKey = new Map<string, { rest: boolean; stopped: boolean }>();
  for (const r of (seasonStatusRes.data ?? []) as Array<{ season_key: string; status: string }>) {
    const e = seasonStatusByKey.get(r.season_key) ?? { rest: false, stopped: false };
    if (r.status === "rest") e.rest = true;
    else if (r.status === "stopped") e.stopped = true;
    seasonStatusByKey.set(r.season_key, e);
  }

  const weeklyPoints = (wpRes.data ?? []) as Array<{
    week_start_date: string | null;
    points: number | null;
    advantages: number | null;
    penalty: number | null;
  }>;
  const weekStatuses = (wsRes.data ?? []) as Array<{ week_start_date: string | null }>;

  // 활동 주차(포인트 + 주차상태)의 week_start_date 후보.
  const candidateDates = new Set<string>();
  for (const p of weeklyPoints) if (p.week_start_date) candidateDates.add(p.week_start_date);
  for (const r of weekStatuses) if (r.week_start_date) candidateDates.add(r.week_start_date);
  if (candidateDates.size === 0) return [];

  // week_start_date → season_key(정규 시즌만).
  const { data: dateWeeks } = await supabaseAdmin
    .from("weeks")
    .select("start_date,season_key")
    .in("start_date", [...candidateDates]);
  const seasonKeyByStart = new Map<string, string>();
  const seasonKeys = new Set<string>();
  for (const w of (dateWeeks ?? []) as Array<{ start_date: string | null; season_key: string | null }>) {
    if (!w.start_date || !w.season_key || !CANON_KEY.test(w.season_key)) continue;
    seasonKeyByStart.set(w.start_date, w.season_key);
    seasonKeys.add(w.season_key);
  }
  if (seasonKeys.size === 0) return [];

  // 시즌별 기간(min start / max end) — isCurrent + 종료 판정용.
  const { data: seasonWeeks } = await supabaseAdmin
    .from("weeks")
    .select("start_date,end_date,season_key")
    .in("season_key", [...seasonKeys]);
  const rangeByKey = new Map<string, { start: string; end: string | null }>();
  for (const w of (seasonWeeks ?? []) as Array<{
    start_date: string | null;
    end_date: string | null;
    season_key: string | null;
  }>) {
    if (!w.season_key || !CANON_KEY.test(w.season_key) || !w.start_date) continue;
    const cur = rangeByKey.get(w.season_key);
    const start = !cur || w.start_date < cur.start ? w.start_date : cur.start;
    const end =
      w.end_date == null ? (cur?.end ?? null) : cur?.end == null || w.end_date > cur.end ? w.end_date : cur.end;
    rangeByKey.set(w.season_key, { start, end });
  }

  // 이력서 시즌 판정(progressStatus) by season_key — 고객 graft 와 동일 역매핑.
  const resumeByKey = new Map<string, string>();
  for (const r of records) {
    const token = String(r.seasonName ?? "").replace(/\s*시즌\s*$/, "").trim();
    const type = SEASON_NAME_TO_TYPE[token];
    const yy = String(r.year ?? "");
    if (!type || !/^\d{2}$/.test(yy) || !r.progressStatus) continue;
    resumeByKey.set(`20${yy}-${type}`, r.progressStatus);
  }
  const resumeGraftLoaded = resumeByKey.size > 0;

  const cards = snapshot.status === "hit" || snapshot.status === "stale" ? snapshot.cards : [];
  const growthStatus = (profileRes.data as { growth_status: string | null } | null)?.growth_status ?? null;
  const userStatus = (profileRes.data as { status: string | null } | null)?.status ?? null;

  // 시즌별 Po.A/B/C(시즌 단위 합 — 비누적).
  const pointsByKey = new Map<string, { poA: number; poB: number; poC: number }>();
  for (const p of weeklyPoints) {
    const key = p.week_start_date ? seasonKeyByStart.get(p.week_start_date) : undefined;
    if (!key) continue;
    const acc = pointsByKey.get(key) ?? { poA: 0, poB: 0, poC: 0 };
    acc.poA += p.points ?? 0;
    acc.poB += p.advantages ?? 0;
    acc.poC += p.penalty ?? 0;
    pointsByKey.set(key, acc);
  }

  // 시즌별 행 구성(허브 강화율·소속은 시즌별 병렬 산출).
  const rows = await Promise.all(
    [...seasonKeys].map(async (seasonKey): Promise<CrewSeasonResultRow & { _start: string; _current: boolean }> => {
      const range = rangeByKey.get(seasonKey) ?? { start: "", end: null };
      const isCurrent = !!(range.start && range.end && todayIso >= range.start && todayIso <= range.end);

      const seasonScoped = seasonStatusByKey.get(seasonKey) ?? { rest: false, stopped: false };
      const customerLabel = deriveSeasonStatusLabel({
        isCurrent,
        endDate: range.end,
        today: todayIso,
        growthStatus,
        userStatus,
        resumeProgressStatus: resumeByKey.get(seasonKey) ?? null,
        resumeGraftLoaded,
        // 현재 시즌(isCurrent)에만 시즌 스코프 휴식/중단 적용 — 과거 시즌은 resumeProgressStatus 가 판정.
        currentSeasonRest: isCurrent && seasonScoped.rest,
        currentSeasonStopped: isCurrent && seasonScoped.stopped,
      });

      // 허브 강화율 — area-7 동일 산식(카드 라인 earned/total), total 0 → null("-").
      const ap = computeSeasonAreaProgress(cards, seasonKey);
      const byKey = new Map<string, (typeof ap)[number]>(ap.map((x) => [x.key as string, x]));
      const rate = (k: string): number | null => {
        const x = byKey.get(k);
        return x && x.total > 0 ? x.rate : null;
      };

      // 소속&클래스 — area-8 동일 산식(시즌 범위 오버랩).
      const season = seasonKeyToSeason(seasonKey);
      const acts = season ? await computeSeasonActivityStatuses(userId, season) : [];
      // 클래스 = 어드민 단일 SoT classLabel(role, level) — 5종(정규/심화(파트장)/심화(에이전트)/
      //   운영진(앰배서더)/운영진(팀장)). area-8 statusLabel("일반"/"팀장(00 팀)" 등)을 그대로 쓰지 않는다.
      const memberships: CrewSeasonMembership[] = acts.map((a) => ({
        teamName: a.teamLabel === "-" ? null : a.teamLabel,
        partName: a.partLabel === "-" ? null : a.partLabel,
        classLabel: classLabel(a.rawRole, a.rawMembershipLevel),
      }));

      const pts = pointsByKey.get(seasonKey) ?? { poA: 0, poB: 0, poC: 0 };

      return {
        seasonKey,
        seasonNameShort: seasonKeyToShort(seasonKey),
        seasonResultLabel: toAdminLabel(customerLabel),
        poA: pts.poA,
        poB: pts.poB,
        poC: pts.poC,
        hubRates: {
          info: rate("practical_info"),
          experience: rate("practical_experience"),
          ability: rate("practical_competency"),
          career: rate("practical_career"),
        },
        memberships,
        _start: range.start,
        _current: isCurrent,
      };
    }),
  );

  // 현재 시즌(진행 중) 맨 위 → 그 아래 시작일 DESC.
  rows.sort((a, b) => {
    if (a._current !== b._current) return a._current ? -1 : 1;
    return a._start < b._start ? 1 : a._start > b._start ? -1 : 0;
  });

  return rows.map(({ _start, _current, ...row }) => row);
}
