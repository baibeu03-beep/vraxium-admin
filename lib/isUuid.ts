// Postgres 의 `uuid` 컬럼은 RFC 4122 의 version/variant 비트를 강제하지 않는다.
// 백필 마이그레이션이 만든 합성 id (예: 00000000-0000-0000-0000-202605210002) 도
// 정상 row 로 저장되어 있으므로, 클라이언트가 그대로 다시 보낼 수 있어야 한다.
// 따라서 strict RFC 4122 (version=1-5, variant=8-b) 대신, Postgres 가 허용하는
// "8-4-4-4-12 hex with hyphens" 형태만 검사한다.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string) {
  return UUID_PATTERN.test(value.trim());
}
