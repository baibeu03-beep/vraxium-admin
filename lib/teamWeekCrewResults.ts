import { readWeeklyCardsSnapshotBatch } from "@/lib/cluster4WeeklyCardsSnapshot";
import {
  buildCrewActSummary,
  resolveCrewActKind,
  type CrewActSummaryRow,
} from "@/shared/crewActSummary";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

// ─────────────────────────────────────────────────────────────────────
// 팀 상세 [B] 크루 목록 — 조회 전용 결과 3종의 **주차·크루 단위 batch 로더**.
//   전부 weekly-cards snapshot SoT 직결(프론트/자체 재계산 금지). N+1 금지: 로스터 전원을
//   readWeeklyCardsSnapshotBatch 한 번(청크 50)으로 읽고, 각 유저의 카드에서 선택 주차 값을 뽑는다.
//
//   · 성장 성공(growthSuccessCount) = 선택 주차 시점 **누적 성장 성공 주차**(as-of).
//       카드 ASC 정렬 후 success 마다 +1·진행/집계 중 null — getCrewWeeklyResults(회원 상세 표)와 동일 산식.
//       ⚠ '주차 결과'(성공/실패/휴식, uws)와 별개 지표다. 같은 값으로 만들지 말 것.
//   · 라인 강화율(lineEnhancementRate) = 선택 주차 card.weeklyGrowthRate(정수 %). 허브 breakdownFromLines SoT.
//       누적/현재값 아님 — 선택 주차·해당 유저 단일 카드값(회원 상세 표 hubRates·CrewWeekLineHistory 와 동일 원천).
//   · 액트 체크율(actCheckRate) = 선택 주차 card.actLogs → buildCrewActSummary(공통 SoT).rate(정수 %).
//       크루 페이지·관리자 액트 탭과 동일 빌더. 취소 액트는 요약 입력에서 제외(크루 페이지와 수치 일치).
//
//   검수 완료 게이트는 **호출부**(getTeamSelectedWeekSummary)가 담당한다 — 미완료 주차는 이 함수를
//   호출하지 않아 3종 모두 null('-')로 남는다. 모드(일반/test/actAs/demo) 분기 없음 — 동일 snapshot SoT.
// ─────────────────────────────────────────────────────────────────────

export type WeeklyCrewResult = {
  growthSuccessCount: number | null; // 누적 성장 성공 주차(as-of 선택 주차). 진행/집계 중 = null.
  lineEnhancementRate: number | null; // 선택 주차 라인 강화율 %(card.weeklyGrowthRate).
  actCheckRate: number | null; // 선택 주차 액트 체크율 %(buildCrewActSummary.rate).
};

const EMPTY_RESULT: WeeklyCrewResult = {
  growthSuccessCount: null,
  lineEnhancementRate: null,
  actCheckRate: null,
};

// card.actLogs → 크루 액트 요약 rate(정수 %). 취소 행·라인 페이백(source='line')은 요약에서 제외.
//   (v43 이후 snapshot 은 actLogs 에서 source='line' 을 이미 뺐지만, 구 snapshot 방어로 명시 필터.)
function actCheckRateFromCard(card: Cluster4WeeklyCardDto): number | null {
  const logs = card.actLogs;
  if (!logs || logs.length === 0) return card.actLogs ? 0 : null;
  const rows: CrewActSummaryRow[] = logs
    .filter((l) => (l.source === "regular" || l.source === "irregular") && !l.cancelled)
    .map((l) => ({
      result: l.result === "checked" ? "checked" : "miss",
      source: l.source === "irregular" ? "irregular" : "regular",
      kindKey: resolveCrewActKind(l.source, l.kind).key,
      pointA: l.pointA,
      pointB: l.pointB,
      pointC: l.pointC,
    }));
  return buildCrewActSummary(rows).rate;
}

// 한 유저의 카드 배열에서 선택 주차(weekStartDate) 기준 결과 3종 추출.
//   누적 성장 성공은 카드를 ASC 로 훑으며 success 마다 +1(진행/집계 중은 미확정 → 미가산·null).
function extractForWeek(
  cards: Cluster4WeeklyCardDto[],
  weekStartDate: string,
): WeeklyCrewResult {
  if (cards.length === 0) return EMPTY_RESULT;
  const asc = [...cards].sort((a, b) =>
    a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0,
  );

  let cum = 0;
  let selected: Cluster4WeeklyCardDto | null = null;
  let growthSuccessCount: number | null = null;
  for (const card of asc) {
    const st = card.userWeekStatus;
    const undetermined = st === "running" || st === "tallying";
    if (!undetermined && st === "success") cum += 1;
    if (card.startDate === weekStartDate) {
      selected = card;
      growthSuccessCount = undetermined ? null : cum;
      break; // 선택 주차까지의 누적이면 충분(이후 주차는 무관).
    }
  }
  if (!selected) return EMPTY_RESULT;

  return {
    growthSuccessCount,
    lineEnhancementRate:
      typeof selected.weeklyGrowthRate === "number" ? selected.weeklyGrowthRate : null,
    actCheckRate: actCheckRateFromCard(selected),
  };
}

// 로스터 전원 × 선택 주차 결과 3종 — snapshot batch 1회(N+1 없음). 키 = userId.
//   snapshot 미보유/에러 유저는 EMPTY_RESULT(3종 null) — 화면은 '-' 로 표시.
export async function loadWeeklyCrewResults(params: {
  userIds: string[];
  weekStartDate: string;
}): Promise<Map<string, WeeklyCrewResult>> {
  const { userIds, weekStartDate } = params;
  const out = new Map<string, WeeklyCrewResult>();
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (ids.length === 0 || !weekStartDate) return out;

  const snapshots = await readWeeklyCardsSnapshotBatch(ids);
  for (const uid of ids) {
    const snap = snapshots.get(uid);
    const cards =
      snap && (snap.status === "hit" || snap.status === "stale") ? snap.cards : [];
    out.set(uid, extractForWeek(cards, weekStartDate));
  }
  return out;
}
