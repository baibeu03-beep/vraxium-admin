// 검수 크루 목록(CafeCrewPicker) 표시 정렬 — 순수 로직(React 무의존 · 단위 테스트 가능).
//   ⚠ 클라이언트 표시 순서만 바꾼다: candidates(SoT)/API 응답/DTO/snapshot/저장 로직 불변.
//   CafeCrew 이외의 새 필드/조회 없이, 이미 받은 필드만으로 정렬한다(DTO 불변 제약).

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

// 지원 정렬:
//   comment(기본)   = 카페 댓글 시간순(candidates 원본 순서 그대로).
//   name            = 이름순(한글 locale, 오름차순).
//   crewCode        = 크루 코드순(오름차순, 빈 코드는 뒤).
//   incompleteFirst = 미작성(프로필 미완성) 우선.
//   completeFirst   = 작성 완료(프로필 완성) 우선.
export type CrewSortKey =
  | "comment"
  | "name"
  | "crewCode"
  | "incompleteFirst"
  | "completeFirst";

// 검수 크루 선택 화면의 정렬 드롭다운에 노출되는 옵션.
//   프로필 작성 여부(incompleteFirst/completeFirst)는 컬럼으로만 확인하고 정렬 옵션에서는 제외.
//   판정 로직(isCrewProfileComplete)·sortCafeCrews의 해당 case·컬럼 표시는 그대로 유지한다.
export const CREW_SORT_OPTIONS: { value: CrewSortKey; label: string }[] = [
  { value: "comment", label: "댓글 시간순" },
  { value: "name", label: "이름순" },
  { value: "crewCode", label: "크루 코드순" },
];

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

// 표시용 정렬 — 입력 배열은 mutate 하지 않고 복사본을 정렬해 반환한다.
//   Array.prototype.sort 는 안정 정렬이라, 동순위(같은 이름/코드/작성상태)는 원본
//   댓글 시간순을 그대로 유지한다. "comment" 는 원본 참조를 그대로 반환.
export function sortCafeCrews(
  candidates: CafeCrew[],
  sortKey: CrewSortKey,
): CafeCrew[] {
  if (sortKey === "comment") return candidates;
  const byName = (a: CafeCrew, b: CafeCrew) =>
    (a.name || "").localeCompare(b.name || "", "ko");
  const next = [...candidates];
  switch (sortKey) {
    case "name":
      next.sort(byName);
      break;
    case "crewCode":
      next.sort((a, b) => {
        const af = crewFieldFilled(a.crewCode);
        const bf = crewFieldFilled(b.crewCode);
        if (af && bf)
          return (a.crewCode as string).localeCompare(b.crewCode as string, "ko");
        if (af) return -1; // 빈 코드는 항상 뒤로
        if (bf) return 1;
        return 0; // 둘 다 빈값 → 원본(댓글) 순서 유지
      });
      break;
    case "incompleteFirst":
      // 미작성(false=0) 우선.
      next.sort(
        (a, b) =>
          Number(isCrewProfileComplete(a)) - Number(isCrewProfileComplete(b)),
      );
      break;
    case "completeFirst":
      // 작성 완료(true) 우선.
      next.sort(
        (a, b) =>
          Number(isCrewProfileComplete(b)) - Number(isCrewProfileComplete(a)),
      );
      break;
  }
  return next;
}
