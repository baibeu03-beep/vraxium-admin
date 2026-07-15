// 크루 검색 결과에서 "이미 현재 대상에 추가된 크루"를 제외하는 공통 SoT.
//
// "크루(회원) 검색 → [추가]" 패턴을 가진 모든 어드민 화면이 공유한다. 화면별 중복 구현 금지.
//
// 규칙(요구사항):
//   - **userId 기준** 중복 판정(이름/크루코드 아님).
//   - 이미 추가된 크루는 검색 결과에서 **완전히 제외**(비활성화·회색표시 아님).
//   - "현재 대상 목록"은 React 상태이므로 useMemo 로 감싸면: 추가 즉시 재계산되어 사라지고,
//     삭제하면 다시 나타난다(추가 후 재검색 불필요).
//   - **순수 함수** — org / mode / operating / test / actAsTestUserId / demoUserId 와 무관하게
//     동일한 검색 DTO 입력에 동일한 출력. 모드별 분기 없음(같은 DTO·같은 로직).
//
// 사용법:
//   const visibleResults = useMemo(
//     () => excludeAddedByUserId(results, roster, (c) => c.userId),
//     [results, roster],
//   );
//   // 이후 render/empty-check 는 results 대신 visibleResults 를 사용.

/** userId 추출기가 가리키는 필드로 Set<string> 구성(빈/누락 id 는 무시). */
export function toUserIdSet<T>(
  items: Iterable<T>,
  getUserId: (item: T) => string | null | undefined,
): Set<string> {
  const set = new Set<string>();
  for (const it of items) {
    const id = getUserId(it);
    if (id) set.add(id);
  }
  return set;
}

/**
 * 검색 결과에서 이미 추가된 userId 를 제외한 새 배열을 반환한다.
 * @param results     검색 결과(원본 불변 — 새 배열 반환)
 * @param added       이미 추가된 대상 목록(배열) 또는 userId Set
 * @param getUserId   결과 항목에서 userId 를 뽑는 함수(예: (c) => c.userId)
 * @param getAddedUserId 대상 목록 항목의 userId 추출기(생략 시 getUserId 재사용 —
 *                       결과·대상이 같은 형태({userId})일 때).
 */
export function excludeAddedByUserId<R, A = R>(
  results: readonly R[],
  added: ReadonlySet<string> | Iterable<A>,
  getUserId: (item: R) => string | null | undefined,
  getAddedUserId?: (item: A) => string | null | undefined,
): R[] {
  const addedSet =
    added instanceof Set
      ? (added as ReadonlySet<string>)
      : toUserIdSet(
          added as Iterable<A>,
          getAddedUserId ??
            (getUserId as unknown as (item: A) => string | null | undefined),
        );
  if (addedSet.size === 0) return results.slice();
  return results.filter((r) => {
    const id = getUserId(r);
    return id ? !addedSet.has(id) : true;
  });
}
