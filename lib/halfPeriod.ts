// ═══════════════════════════════════════════════════════════════════════════
// 반기(해당 시기) 공용 기준시점 해소기 — /admin/team-parts/info/* 전체의 유일한 asOf 원천.
// ═══════════════════════════════════════════════════════════════════════════
//
// 이 파일 하나가 "선택한 반기가 실제로 어느 시점을 의미하는가"를 결정한다. 화면·API 마다
// 임의의 기준일을 따로 계산하지 않는다 — 전부 resolveHalfPeriod() 결과만 쓴다.
//
// ── asOf 주차 선택 규칙(현재/과거 반기 공통 — 분기 없음) ──────────────────────────
//   candidates = weeks[ season_key ∈ halfKeyToSeasonKeys(half) ] ∧ week_number > 0
//              ∧ week_start_date ≤ today
//   asOfWeek = candidates.find(is_current_week) ?? candidates.at(-1) ?? null
//
//   ⚠ 날짜 범위로 자르지 않고 season_key **귀속**으로 주차를 고른다. 전환 주차는 DB 에
//     "다음 시즌 W0"으로 저장되므로(seasonCalendar.isTransitionWeek), 날짜만 클램프하면
//     반기 끝의 전환 주차가 다음 반기로 잘못 새어 들어온다(그 주차엔 이력이 비어 있어
//     인원이 0으로 잡히는 사고로 이어짐 — 2026-07-31 설계 검토에서 실측 확인).
//   ⚠ week_number > 0 은 신규 규칙이 아니라 기존 전환주차 제외 정책 재사용
//     (adminTeamSelectedWeekSummary.ts 의 selectableWeeks 필터와 동일).
//
// ── 원장(rosterSource/structureSource) 선택 규칙 ──────────────────────────────
//   isCurrentHalf 를 **먼저** 본다(2026-07-31 사용자 확정 — UPH 존재 여부로 판정하지 않는다):
//     현재 반기            → "live"              (지금 화면이 쓰는 라이브 원장 그대로)
//     과거 반기 + 이력 있음 → "position_history"  (UPH/team_halves 이력)
//     과거 반기 + 이력 없음 → "unavailable"       (소비처는 null 반환 → "기록 없음" 표시)
//   현재 반기는 UPH 백필 여부와 무관하게 항상 "live" — 지금 화면 숫자와 완전히 같아야 한다.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";
import {
  halfKeyToSeasonKeys,
  halfLabelKo,
  seasonKeyToSeasonLabel,
  type HalfPeriodKey,
} from "@/lib/teamHalf";

export type HalfDataSource = "live" | "position_history" | "snapshot" | "unavailable";

export type HalfPeriodMeta = {
  period: string; // "2026-H2"
  periodLabel: string; // "26년도 하반기"
  periodStart: string | null; // 반개방 구간 시작(표시용)
  periodEndExclusive: string | null; // 반개방 구간 끝(표시용, exclusive)
  asOfDate: string | null; // 기준 시점(현재 반기=오늘, 과거 반기=마지막 확정 주차 종료일)
  asOfWeekId: string | null;
  asOfWeekStart: string | null;
  seasonKey: string | null;
  seasonLabel: string | null; // "여름"
  seasonYear: number | null;
  weekNumber: number | null;
  weekLabel: string | null; // "[26년, 여름 시즌, 5주차]"
  isCurrentHalf: boolean;
  rosterSource: HalfDataSource;
  structureSource: HalfDataSource;
};

// 그 반기(두 시즌)에 UPH 행이 하나라도 있는지 — 존재 probe(count 불필요, limit 1).
async function hasPositionHistoryForHalf(seasonKeys: [string, string]): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("user_position_histories")
    .select("id")
    .in("season_key", seasonKeys)
    .limit(1);
  if (error) {
    console.warn("[halfPeriod] UPH 존재 확인 실패 → 기록 없음으로 취급", error.message);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

// 그 half_key 에 team_halves 행이 하나라도 있는지(조직 무관 — 클럽 전체 관점의 존재 여부).
async function hasTeamStructureForHalf(halfKey: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_team_halves")
    .select("id")
    .eq("half_key", halfKey)
    .limit(1);
  if (error) {
    console.warn("[halfPeriod] team_halves 존재 확인 실패 → 기록 없음으로 취급", error.message);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

// halfKey 는 호출부(API 라우트)가 normalizeHalfKeyParam() 으로 이미 검증·보정한 값을 넘긴다
//   (여기서는 형식만 재검증 — halfKeyToSeasonKeys 가 실패하면 empty 반환).
export async function resolveHalfPeriod(input: {
  halfKey: string;
  today?: string;
}): Promise<HalfPeriodMeta> {
  const todayIso = input.today ?? getCurrentActivityDateIso();
  const halfKey = input.halfKey;
  const seasons = halfKeyToSeasonKeys(halfKey);

  const empty: HalfPeriodMeta = {
    period: halfKey,
    periodLabel: halfLabelKo(halfKey),
    periodStart: null,
    periodEndExclusive: null,
    asOfDate: null,
    asOfWeekId: null,
    asOfWeekStart: null,
    seasonKey: null,
    seasonLabel: null,
    seasonYear: null,
    weekNumber: null,
    weekLabel: null,
    isCurrentHalf: false,
    rosterSource: "unavailable",
    structureSource: "unavailable",
  };
  if (!seasons) return empty;

  const { seasons: seasonDtos, rows } = await loadSeasonWeeks(todayIso);

  const halfSeasonDtos = seasonDtos.filter((s) => seasons.includes(s.season_key));
  const periodStart =
    halfSeasonDtos
      .map((s) => s.season_start_date)
      .filter((v): v is string => !!v)
      .sort()[0] ?? null;
  const seasonEnds = halfSeasonDtos
    .map((s) => s.season_end_date)
    .filter((v): v is string => !!v)
    .sort();
  const lastSeasonEnd = seasonEnds.length > 0 ? seasonEnds[seasonEnds.length - 1] : null;
  const periodEndExclusive = lastSeasonEnd ? addDaysIso(lastSeasonEnd, 1) : null;

  const candidates = rows
    .filter(
      (r) =>
        seasons.includes(r.season_key) &&
        (r.week_number ?? 0) > 0 &&
        !!r.week_start_date &&
        r.week_start_date <= todayIso,
    )
    .sort((a, b) => (a.week_start_date ?? "").localeCompare(b.week_start_date ?? ""));

  const asOfRow = candidates.find((r) => r.is_current_week) ?? candidates[candidates.length - 1] ?? null;
  const isCurrentHalf = asOfRow?.is_current_week ?? false;

  const [hasPositionHistory, hasTeamStructure] = await Promise.all([
    isCurrentHalf ? Promise.resolve(false) : hasPositionHistoryForHalf(seasons),
    isCurrentHalf ? Promise.resolve(false) : hasTeamStructureForHalf(halfKey),
  ]);

  const rosterSource: HalfDataSource = isCurrentHalf
    ? "live"
    : hasPositionHistory
      ? "position_history"
      : "unavailable";
  const structureSource: HalfDataSource = isCurrentHalf
    ? "live"
    : hasTeamStructure
      ? "position_history"
      : "unavailable";

  if (!asOfRow) {
    return {
      ...empty,
      periodStart,
      periodEndExclusive,
      rosterSource,
      structureSource,
    };
  }

  const asOfDate = isCurrentHalf ? todayIso : (asOfRow.week_end_date ?? asOfRow.week_start_date);
  const yearSourceIso =
    asOfRow.week_end_date ?? asOfRow.week_start_date ?? asOfRow.season_start_date ?? todayIso;
  const seasonYear = Number(String(yearSourceIso).slice(0, 4));
  const yy = String(((seasonYear % 100) + 100) % 100).padStart(2, "0");
  const seasonLabel = seasonKeyToSeasonLabel(asOfRow.season_key);

  return {
    period: halfKey,
    periodLabel: halfLabelKo(halfKey),
    periodStart,
    periodEndExclusive,
    asOfDate,
    asOfWeekId: asOfRow.week_id,
    asOfWeekStart: asOfRow.week_start_date,
    seasonKey: asOfRow.season_key,
    seasonLabel,
    seasonYear: Number.isFinite(seasonYear) ? seasonYear : null,
    weekNumber: asOfRow.week_number,
    weekLabel: `[${yy}년, ${seasonLabel} 시즌, ${asOfRow.week_number ?? "-"}주차]`,
    isCurrentHalf,
    rosterSource,
    structureSource,
  };
}

function addDaysIso(iso: string, days: number): string {
  const ms = Date.UTC(
    Number(iso.slice(0, 4)),
    Number(iso.slice(5, 7)) - 1,
    Number(iso.slice(8, 10)),
  );
  const d = new Date(ms + days * 86_400_000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export type { HalfPeriodKey };
