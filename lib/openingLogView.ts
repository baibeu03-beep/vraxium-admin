// /admin/line-opening/* 로그창 공용 뷰 헬퍼.
//   · 세 로그창(실무 정보/역량/경험)이 동일한 "표시 순서 + 자동 스크롤 변경 키" 규칙을 공유한다.
//   · 데이터 자체(정렬·조회)는 서버 그대로(created_at DESC = 최신순). 여기선 "표시 순서만" 뒤집는다.
//     → 화면: 오래된 로그가 위, 최신 로그가 아래(아래로 갈수록 최신). API/다른 화면 영향 없음.

// 로그창이 다루는 최소 형태 — id 와 생성 시각만 있으면 순서/변경 키를 만들 수 있다.
export type OpeningLogLike = { id: string; createdAt: string };

// 7개 이하=스크롤 없음 / 8개 이상=내부 스크롤. 경계 상수(단일 SoT).
export const OPENING_LOG_VISIBLE_ROWS = 7;
export const OPENING_LOG_SCROLL_THRESHOLD = OPENING_LOG_VISIBLE_ROWS + 1; // 8

// 서버는 최신순(created_at DESC)으로 준다 → 표시용으로 오래된순(위)~최신(아래)으로 뒤집는다.
//   원본 배열을 변형하지 않도록 복사본을 반환한다.
export function orderLogsOldestFirst<T extends OpeningLogLike>(logs: T[]): T[] {
  return logs.slice().reverse();
}

// 자동 하단 스크롤을 트리거할 "안정적인" 변경 키.
//   · 배열 객체 재생성(참조 변경)만으로는 바뀌지 않는다 → 불필요한 하단 튕김 방지.
//   · 개수 + 최신 로그(id·생성시각) 조합 → 새 로그가 실제로 추가/치환됐을 때만 값이 바뀐다.
//   · 입력은 서버 순서(최신순) 기준: 최신 로그 = logs[0].
export function logChangeKey(logs: OpeningLogLike[]): string {
  const newest = logs[0];
  return `${logs.length}|${newest?.id ?? ""}|${newest?.createdAt ?? ""}`;
}
