// 검수 크루 목록(CafeCrewPicker) 표시 정렬 — 순수 로직(React 무의존 · 단위 테스트 가능).
//   ⚠ 클라이언트 표시 순서만 바꾼다: candidates(SoT)/API 응답/DTO/snapshot/저장 로직 불변.
//   CafeCrew 이외의 새 필드/조회 없이, 이미 받은 필드만으로 정렬한다(DTO 불변 제약).
//   정렬 UI = 테이블 컬럼 헤더(SortableTh + cycleSort). 구 드롭다운(정렬 select)은 폐지.

import type { SortDirection } from "@/shared/detailLogSort";

export type CafeCrew = {
  userId: string;
  crewNo: number | null;
  crewCode: string | null;
  name: string;
  teamName: string | null;
  partName: string | null;
  schoolName: string | null;
  majorName: string | null;
  organization: string | null;
};

// 빈값 정규화: null/빈문자열/공백/"-" 는 모두 "미작성/빈값"으로 취급.
export function crewFieldFilled(v: string | null | undefined): boolean {
  if (v == null) return false;
  const t = v.trim();
  return t !== "" && t !== "-";
}

// 프로필 작성 완료 = 표에 표시되는 팀명·파트명·학교명·전공명 4개가 모두 채워짐.
export function isCrewProfileComplete(c: CafeCrew): boolean {
  return (
    crewFieldFilled(c.teamName) &&
    crewFieldFilled(c.partName) &&
    crewFieldFilled(c.schoolName) &&
    crewFieldFilled(c.majorName)
  );
}

// 컬럼 헤더 정렬 키 — 렌더 컬럼과 1:1(SortableTh 로 배선).
//   commentTime = 카페 댓글 시간순(candidates 원본 인덱스). 기본(state=null)도 이 순서.
//   name        = 이름순(한글 locale).
//   crewCode    = 크루 코드순(빈 코드는 방향 무관 항상 뒤).
//   writeStatus = 프로필 작성 상태. asc = 미작성 우선, desc = 작성 완료 우선.
export type CrewColumnKey = "commentTime" | "name" | "crewCode" | "writeStatus";
export type CrewSortState = { key: CrewColumnKey; dir: SortDirection } | null;

// 표시용 정렬 — 입력 배열은 mutate 하지 않고 복사본을 정렬해 반환한다.
//   · state=null(기본) = 원본(댓글 시간) 순서 — 원본 참조를 그대로 반환(무복사).
//   · 안정 정렬: 동순위(같은 이름/코드/작성상태)는 원본 인덱스(=댓글 시간)로 tie-break.
//   · crewCode 의 빈값과 commentTime 은 방향과 무관하게 원본 순서를 기준으로 다룬다.
export function sortCafeCrewsByColumn(
  candidates: CafeCrew[],
  state: CrewSortState,
): CafeCrew[] {
  if (!state) return candidates; // 기본 = 원본(댓글 시간) 순서
  const { key, dir } = state;
  const sign = dir === "asc" ? 1 : -1;
  const decorated = candidates.map((c, index) => ({ c, index }));
  decorated.sort((x, y) => {
    // 방향 무관(항상 원본 순서 기준) 케이스는 early-return 으로 sign 을 적용하지 않는다.
    if (key === "commentTime") return (x.index - y.index) * sign;
    if (key === "crewCode") {
      const xf = crewFieldFilled(x.c.crewCode);
      const yf = crewFieldFilled(y.c.crewCode);
      if (xf !== yf) return xf ? -1 : 1; // 빈 코드는 방향 무관 항상 뒤
      if (!xf) return x.index - y.index; // 둘 다 빈값 → 원본 순서
      const c = (x.c.crewCode as string).localeCompare(
        y.c.crewCode as string,
        "ko",
      );
      return c !== 0 ? c * sign : x.index - y.index;
    }
    let c = 0;
    if (key === "name") {
      c = (x.c.name || "").localeCompare(y.c.name || "", "ko");
    } else if (key === "writeStatus") {
      // 완료=1, 미작성=0. asc → 미작성(0) 먼저, desc → 완료(1) 먼저.
      c = Number(isCrewProfileComplete(x.c)) - Number(isCrewProfileComplete(y.c));
    }
    return c !== 0 ? c * sign : x.index - y.index; // tie → 원본(댓글) 순서
  });
  return decorated.map((d) => d.c);
}
