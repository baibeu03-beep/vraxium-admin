// 브라우저 전용 — **진행 중인** 동일 GET 요청 합치기(in-flight coalescing).
//
// 배경(2026-07-28 실측): [라인 개설]/[개설 취소] 성공 직후 한 핸들러가 여러 갱신 트리거를 동시에
//   쏘아 올린다. 실무 정보 기준 onOpened 한 번에
//     · 개설 폼 재조회        GET /api/admin/cluster4/info-lines?activity_type_id&week_id&organization
//     · 상태창 재조회         GET /api/admin/cluster4/info-lines?(같은 파라미터)   ← 완전히 동일
//     · 상위 목록 재조회      GET /api/admin/cluster4/info-lines?(같은 파라미터)   ← 완전히 동일
//   가 나가 **같은 응답을 3번** 받아온다(서버 왕복 3회 · 각 1~3s).
//
// 이 헬퍼는 캐시가 아니다 — 저장하지 않고, TTL 도 없다.
//   "아직 응답이 오지 않은 동일 URL 요청"만 하나로 합치고, 응답이 오면 즉시 맵에서 지운다.
//   → 나중에 다시 부르면 항상 새로 요청한다(개설/취소 직후 stale 노출 위험 0).
//   → 같은 tick 에 겹쳐 나간 중복만 사라지므로, 각 호출부가 받는 데이터는 종전과 동일하다.
//
// ⚠ GET 전용. 쓰기(POST/PATCH/DELETE)는 절대 합치지 않는다(멱등하지 않다).
// ⚠ 호출부는 res.json() 을 그대로 쓸 수 있다 — 공유 응답의 clone() 을 각자 받는다.

const inflight = new Map<string, Promise<Response>>();

function keyOf(url: string, init?: RequestInit): string {
  // credentials/headers 가 다르면 다른 요청으로 취급(현재 호출부는 전부 기본값).
  const headers = init?.headers ? JSON.stringify(init.headers) : "";
  return `${url}\n${init?.credentials ?? ""}\n${headers}`;
}

/** 진행 중인 동일 GET 이 있으면 그 응답을 공유한다. 없으면 새로 요청한다. */
export function coalescedGet(url: string, init?: RequestInit): Promise<Response> {
  const key = keyOf(url, init);
  const existing = inflight.get(key);
  if (existing) return existing.then((res) => res.clone());

  const p = fetch(url, init).finally(() => {
    // 응답 도착 즉시 해제 — 다음 호출은 반드시 새 요청이 된다(캐시 아님).
    inflight.delete(key);
  });
  inflight.set(key, p);
  return p.then((res) => res.clone());
}
