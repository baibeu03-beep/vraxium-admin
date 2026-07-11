// PostgREST `.in(col, ids)` 필터 청크 크기 — 요청 URL 길이 상한 대비 SoT.
//
// 배경(실측): supabase-js 의 .in("user_id", ids) 는 GET 쿼리스트링에
//   `?user_id=in.(uuid1,uuid2,...)` 로 전개된다. UUID 1개당 약 37B 이므로 ids 가 많으면
//   요청 URL 이 급격히 커지고, 약 14KB(≈400 UUID)를 넘기면 Node 전역 fetch(undici)/풀러 단에서
//   `TypeError: fetch failed` 가 수 초~30초 지연 후 발생한다(비결정적 — "새로고침하면 열리기도"의 정체).
//   임계 실측: 300개(11.1KB) 정상 120ms / 400개(14.8KB) 실패 7.6s.
//
// 그래서 id 리스트 기반 .in() 은 이 청크로 나눠 URL 을 ~7KB 이하로 유지한다(200개 ≈ 7.4KB).
//   여러 번 나눠도 각 요청이 빠르고 안정적이라 총 지연이 오히려 크게 줄어든다(30s 실패 → 수백 ms).
//   ⚠ 이 값은 "요청 URL 길이" 상한용이며, PostgREST 응답 1000행 cap(페이징)과는 별개 관심사다.
export const IN_FILTER_ID_CHUNK = 200;
