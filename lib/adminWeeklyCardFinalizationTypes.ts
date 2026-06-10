// 주차 카드 집계 확정(weekly-card-finalization) — browser-safe 타입.
//
// "집계 중"(tallying)은 read-time 표시 상태이며 SoT 는 weeks.result_published_at 이다.
//   NULL → 미확정(고객 카드 "성장(집계 중)"), 값 존재 → 확정(success/fail 노출).
// 본 기능은 새 SoT/새 계산 기준을 만들지 않는다:
//   - 확정 = weeks.result_published_at 세팅(기존 publishWeekResult 와 동일 단일 경로).
//   - 집계 분포 = growthCore.resolveWeekResultStatus(기존 카드/주차인정 요약과 동일 판정).
//   - 스냅샷 = recomputeWeeklyCardsSnapshotsForUsers(기존 재계산 경로).
// 클라이언트 컴포넌트가 import 하므로 DB/서버 모듈을 끌어오지 않는다.

// 선택 옵션 — 시즌 드롭다운.
export type FinalizationSeasonOption = {
  seasonKey: string;
  seasonLabel: string;
};

// 선택 옵션 — 주차 드롭다운(시즌별로 그룹핑).
export type FinalizationWeekOption = {
  weekId: string;
  seasonKey: string | null;
  weekNumber: number | null;
  weekLabel: string;
  startDate: string | null;
  endDate: string | null;
  // 확정(공표) 시점. null = 미확정(집계 중).
  resultPublishedAt: string | null;
  // 오늘이 속한 주차인가(확정해도 running 으로 남아 의미 없음 → UI 에서 확정 비활성).
  isCurrentWeek: boolean;
  // 공식 휴식 주차인가(seasonCalendar rule ∨ official_rest_periods overlap).
  isOfficialRest: boolean;
};

// 선택 주차의 현재 상태.
export type FinalizationWeekStatus = {
  weekId: string;
  seasonKey: string | null;
  weekNumber: number | null;
  weekLabel: string;
  startDate: string | null;
  endDate: string | null;
  resultPublishedAt: string | null;
  // 확정 완료 여부 = result_published_at 존재.
  isFinalized: boolean;
  isCurrentWeek: boolean;
  isOfficialRest: boolean;
  // 코호트 스냅샷 신선도 요약(stale 여부).
  snapshot: FinalizationSnapshotHealth;
};

// 코호트(해당 주차 uws 보유자) 스냅샷 신선도.
export type FinalizationSnapshotHealth = {
  cohortSize: number; // 코호트 인원(= 전체 크루, org 필터 반영)
  present: number; // 스냅샷 행 존재 인원
  fresh: number; // 현재 dto_version + is_stale=false
  stale: number; // is_stale=true 또는 dto_version 불일치
  missing: number; // 스냅샷 행 없음
  isStale: boolean; // stale>0 || missing>0
};

// 집계 분포(미리보기/확정 공통). 모든 값은 org 필터 반영 + 시드 테스트 유저(test_user_markers)
//   제외 코호트 기준이다(weekly-ranking 과 동일 기준). 예: 2026-spring W13 oranke 105→80.
//   파티션(확정 후 분포): totalCrew = growthSuccess + growthFail + personalRest + officialRest + uncategorized
//   growthChallenge(성장 도전) = growthSuccess + growthFail (성장 활동 참여자 — 파생/중첩 지표).
//   pendingTally(미확정 인원)  = 현재 "집계 중"으로 표시되는 인원. 위 파티션과 중첩되는 정보값이다
//     (미공표 주차에서는 success/fail 인원이 모두 집계중으로 마스킹 → pendingTally == growthChallenge,
//      확정하면 0). 따라서 파티션 합산에 더하지 않는다.
export type FinalizationAggregation = {
  totalCrew: number; // 전체 크루
  growthChallenge: number; // 성장 도전 (= success + fail)
  growthSuccess: number; // 성장 성공
  growthFail: number; // 성장 실패
  personalRest: number; // 개인 휴식
  officialRest: number; // 공식 휴식
  // 아직 "집계 중"으로 남는 인원(현재 published 플래그 기준). 확정 후엔 0 이 된다.
  pendingTally: number;
  // 위 6종 어디에도 안 들어간 인원(no_data/running 등 — 정합 디버그용).
  uncategorized: number;
};

// GET preview 응답.
export type WeeklyCardFinalizationPreview = {
  seasons: FinalizationSeasonOption[];
  weeks: FinalizationWeekOption[];
  // seasonId+weekNumber 가 주어졌을 때만 채워진다.
  target: FinalizationWeekStatus | null;
  aggregation: FinalizationAggregation | null;
  org: string | null;
  generatedAt: string;
};

// POST finalize/recompute 모드.
export type FinalizationMode = "finalize" | "recompute";

// POST 응답.
export type WeeklyCardFinalizationResult = {
  mode: FinalizationMode;
  target: FinalizationWeekStatus;
  aggregation: FinalizationAggregation;
  // 확정(공표) 결과 — mode=finalize 일 때만. 이미 확정돼 있었으면 alreadyFinalized=true.
  published: {
    resultPublishedAt: string | null;
    alreadyFinalized: boolean;
  } | null;
  // 스냅샷 재계산 결과(코호트 전체 — 공표는 주차 전역 이벤트라 org 필터 미적용).
  snapshotRecompute: {
    requested: number;
    recomputed: number;
    failed: number;
  };
  org: string | null;
  generatedAt: string;
};
