// ─────────────────────────────────────────────────────────────────────
// cluster-4-1 area-6-circles 집계 — 순수 함수(browser-safe, DB/서버 import 금지).
//
// 단일 출처(SoT) = weekly-cards 스냅샷의 cards 배열. 이 함수는 그 cards 만 입력으로
// 받아 결정적으로 3개 지표(주차 활용도 / 일정 신뢰도 / 시즌 성장률)를 산출한다.
//   → 동일 cards 입력 == 동일 결과. 따라서:
//     · demoUserId / 일반 모드가 같은 스냅샷을 읽으면 같은 DTO가 나온다.
//     · API 가 반환하는 값(스냅샷 cards 기반)과 direct 계산(동일 cards 기반)이 갈라지지 않는다.
//
// 현재 시즌 단위로만 집계한다(currentSeasonKey). 전환 주차(isTransition)와 공식 휴식은
// 분모/분자에서 제외한다 — admin Cluster4 성장 집계 정책(foldGrowthMetrics /
// computeSeasonGrowthRates)과 1:1 동일.
// ─────────────────────────────────────────────────────────────────────

import type {
  Cluster4AreaSixCirclesDto,
  Cluster4LinePartType,
  Cluster4SeasonAreaProgressDto,
  Cluster4SeasonAreaProgressKey,
  Cluster4WeeklyCardDto,
} from "@/shared/cluster4.contracts";
import type { SeasonActivityStatus } from "@/lib/cluster4WeeklyGrowthTypes";

// area-8-season-status 시즌별 맵 — 순수 함수(browser-safe). 단일 출처(SoT) = weekly-cards 스냅샷
// cards 의 주차별 roleLabel(= cluster-4-card 역할 배지와 동일 값·동일 라벨, user_position_histories
// 기반 v26). 한 시즌의 카드를 시작일 순으로 정렬해 연속 동일 roleLabel 을 한 구간으로 병합한다
// (상태가 바뀌면 별도 행 — 예: W1~3 정규 → W4~ 심화(에이전트) = 2행). 최신 상태로 덮어쓰지 않는다.
//   · 카드 기반이라 area-8 == 카드 배지(같은 시즌/주차) 정합이 구조적으로 보장된다.
//   · demoUserId/일반 모드가 같은 스냅샷 cards 를 읽으면 같은 결과(분기 없음).
//   · teamLabel/partLabel = 카드의 teamName/partName(없으면 "-"). 빈 roleLabel 카드는 스킵.
const MAX_ACTIVITY_SEGMENTS = 6;
export function computeSeasonActivityStatusesFromCards(
  cards: Cluster4WeeklyCardDto[],
): Record<string, SeasonActivityStatus[]> {
  const bySeason = new Map<string, Cluster4WeeklyCardDto[]>();
  for (const c of cards) {
    if (!c.seasonKey) continue;
    const arr = bySeason.get(c.seasonKey) ?? [];
    arr.push(c);
    bySeason.set(c.seasonKey, arr);
  }
  const out: Record<string, SeasonActivityStatus[]> = {};
  for (const [seasonKey, list] of bySeason) {
    const sorted = [...list].sort((a, b) =>
      a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0,
    );
    const segs: SeasonActivityStatus[] = [];
    for (const c of sorted) {
      const statusLabel = (c.roleLabel ?? "").trim();
      if (!statusLabel) continue; // 라벨 없는 카드는 구간에서 제외
      const teamLabel = (c.teamName ?? "").trim() || "-";
      const partLabel = (c.partName ?? "").trim() || "-";
      const prev = segs[segs.length - 1];
      if (prev && prev.statusLabel === statusLabel) {
        // 같은 상태 연속 → 구간 종료일만 연장(별도 행 만들지 않음).
        prev.endedAt = c.startDate ?? prev.endedAt;
        continue;
      }
      segs.push({
        id: `card-${seasonKey}-${c.startDate}`,
        order: 0,
        teamLabel,
        partLabel,
        statusLabel,
        rawRole: null,
        rawMembershipLevel: null,
        startedAt: c.startDate ?? null,
        endedAt: c.startDate ?? null,
      });
    }
    if (segs.length > 0) {
      out[seasonKey] = segs
        .slice(0, MAX_ACTIVITY_SEGMENTS)
        .map((e, i) => ({ ...e, order: i + 1 }));
    }
  }
  return out;
}

// roundGrowthRate(lib/lineAvailability)와 동일 규칙. 그 파일은 server 의존이라
// browser-safe 유지를 위해 순수 동작만 인라인한다(값 불변: available 0 → 0).
function pct(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 100);
}

// 현재 시즌(currentSeasonKey)의 카드만 추려 3개 원형 지표를 집계한다.
//   currentSeasonKey 가 null 이거나 해당 시즌 카드가 없으면 전부 0(빈 DTO).
//
//   주차 정의(공식 휴식·전환 주차 제외):
//     approvedWeeks(a) = userWeekStatus==="success"
//     restWeeks(c)     = userWeekStatus==="personal_rest"
//     failedWeeks      = userWeekStatus==="fail"
//     availableWeeks(e)= a + failedWeeks + c
//     (running / tallying / official_rest 은 어느 분모/분자에도 들어가지 않는다.)
//   라인 정의: 현재 시즌·비전환 카드의 growthNumerator / growthDenominator 합
//     (휴식 주차는 카드 단계에서 이미 denominator=0 이므로 자연 제외).
export function computeAreaSixCircles(
  cards: Cluster4WeeklyCardDto[],
  currentSeasonKey: string | null,
): Cluster4AreaSixCirclesDto {
  const empty: Cluster4AreaSixCirclesDto = {
    seasonKey: currentSeasonKey,
    weekUsage: 0,
    approvedWeeks: 0,
    scheduleReliability: 0,
    reliableWeeks: 0,
    restWeeks: 0,
    availableWeeks: 0,
    seasonGrowth: 0,
    completedLines: 0,
    availableLines: 0,
  };
  if (!currentSeasonKey) return empty;

  let approvedWeeks = 0; // a
  let failedWeeks = 0;
  let restWeeks = 0; // c
  let completedLines = 0;
  let availableLines = 0;

  for (const c of cards) {
    if (c.seasonKey !== currentSeasonKey) continue;
    if (c.isTransition) continue; // 전환 주차 제외

    switch (c.userWeekStatus) {
      case "success":
        approvedWeeks++;
        break;
      case "fail":
        failedWeeks++;
        break;
      case "personal_rest":
        restWeeks++;
        break;
      // official_rest / running / tallying → 집계 제외
    }

    // 라인 합산(휴식 주차는 denominator=0 → 영향 없음).
    completedLines += c.growthNumerator;
    availableLines += c.growthDenominator;
  }

  const availableWeeks = approvedWeeks + failedWeeks + restWeeks; // e
  const reliableWeeks = approvedWeeks + restWeeks; // a + c

  return {
    seasonKey: currentSeasonKey,
    weekUsage: pct(approvedWeeks, availableWeeks),
    approvedWeeks,
    scheduleReliability: pct(reliableWeeks, availableWeeks),
    reliableWeeks,
    restWeeks,
    availableWeeks,
    seasonGrowth: pct(completedLines, availableLines),
    completedLines,
    availableLines,
  };
}

// ─────────────────────────────────────────────────────────────────────
// area-7-progress: 현재 시즌 실무 4허브(정보/경험/역량/경력) 강화율 누적.
//
// 단일 출처(SoT) = computeAreaSixCircles 와 동일한 weekly-cards 스냅샷 cards.
//   각 part 의 시즌 누적 earned/total 을 합산해 rate 를 낸다(= cluster-4-card 의
//   주차 성장률/허브 강화율과 동일 source: 카드 라인 breakdown).
//   · 같은 카드·같은 part 의 sub-line 들은 동일 part 집계값(numerator/denominator)을
//     공유하므로(attachLineBreakdown) 카드당 part 1회만 합산한다(이중계산 방지).
//   · available<=0(미개설)·휴식 주차 라인은 numerator/denominator=null → 자연 제외.
//   · 전환 주차(isTransition)·다른 시즌 카드는 제외 — area-6 시즌 성장률과 1:1 동일 범위.
//   → 4개 part earned 합 == area-6 seasonGrowth 의 completedLines, total 합 == availableLines.
// ─────────────────────────────────────────────────────────────────────
const AREA_PROGRESS_ORDER: ReadonlyArray<{
  partType: Cluster4LinePartType;
  key: Cluster4SeasonAreaProgressKey;
  label: string;
}> = [
  { partType: "information", key: "practical_info", label: "실무 정보" },
  { partType: "experience", key: "practical_experience", label: "실무 경험" },
  { partType: "competency", key: "practical_competency", label: "실무 역량" },
  { partType: "career", key: "practical_career", label: "실무 경력" },
];

export function computeSeasonAreaProgress(
  cards: Cluster4WeeklyCardDto[],
  currentSeasonKey: string | null,
): Cluster4SeasonAreaProgressDto {
  // part 별 누적 합. 항상 4개 part 키를 0 으로 초기화(빈/미상 시즌도 4행 고정 반환).
  const acc = new Map<Cluster4LinePartType, { earned: number; total: number }>();
  for (const { partType } of AREA_PROGRESS_ORDER) {
    acc.set(partType, { earned: 0, total: 0 });
  }

  if (currentSeasonKey) {
    for (const c of cards) {
      if (c.seasonKey !== currentSeasonKey) continue;
      if (c.isTransition) continue; // 전환 주차 제외
      const lines = Array.isArray(c.lines) ? c.lines : [];

      // 카드당 part 1회만 집계 — sub-line 중복 합산 방지(모두 동일 part 집계값을 공유).
      const perPart = new Map<Cluster4LinePartType, { earned: number; total: number }>();
      for (const line of lines) {
        if (perPart.has(line.partType)) continue;
        const num = line.numerator;
        const den = line.denominator;
        if (num == null || den == null || den <= 0) continue; // 미개설/휴식 → 제외
        perPart.set(line.partType, { earned: num, total: den });
      }
      for (const [partType, v] of perPart) {
        const a = acc.get(partType);
        if (!a) continue;
        a.earned += v.earned;
        a.total += v.total;
      }
    }
  }

  return AREA_PROGRESS_ORDER.map(({ partType, key, label }) => {
    const a = acc.get(partType) ?? { earned: 0, total: 0 };
    return {
      key,
      label,
      earned: a.earned,
      total: a.total,
      rate: pct(a.earned, a.total),
    };
  });
}
