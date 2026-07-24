// 단위 검증 — 실제 sortCafeCrewsByColumn(lib/cafeCrewSort) 를 혼합 데이터로 검사.
//   컬럼 헤더 정렬(commentTime/name/crewCode/writeStatus)의 asc/desc/기본 규칙을 실증한다.
//   브라우저 검증(browser-verify-cafe-crew-sort.mjs)은 실 population 이 전원 작성완료·빈 크루코드라
//   미작성/코드 정렬이 vacuous 로만 통과 → 여기서 혼합 데이터로 규칙을 실증한다.
//   ⚠ 정렬은 표시 순서만: 입력 배열 mutate 없음 · 기본(state=null)은 원본 참조 반환.
import { sortCafeCrewsByColumn, type CafeCrew } from "../lib/cafeCrewSort";

let pass = 0,
  fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

function crew(p: Partial<CafeCrew> & { userId: string; name: string }): CafeCrew {
  return {
    crewNo: null,
    crewCode: null,
    teamName: null,
    partName: null,
    schoolName: null,
    majorName: null,
    organization: "oranke",
    ...p,
  };
}

const full = { teamName: "T", partName: "P", schoolName: "S", majorName: "M" };
// 혼합: 완성/미완성, 코드 있음/없음, 이름 뒤섞임. 배열 인덱스 = 원본(댓글) 순서.
const base: CafeCrew[] = [
  crew({ userId: "1", name: "다래", crewCode: "C300", ...full }), // 완성, 코드
  crew({ userId: "2", name: "가온", crewCode: null, teamName: "T" }), // 미완성(부분), 코드없음
  crew({ userId: "3", name: "나린", crewCode: "C100", ...full }), // 완성, 코드
  crew({ userId: "4", name: "마루", crewCode: "-", schoolName: "S" }), // 미완성, 코드 "-"(빈값)
  crew({ userId: "5", name: "라온", crewCode: "C200", ...full, partName: "  " }), // 공백 파트=미완성
];
const ids = (arr: CafeCrew[]) => arr.map((c) => c.userId).join(",");
const before = ids(base);

// 기본(state=null): 원본(댓글 시간) 순서 그대로 + 원본 참조 반환.
const d0 = sortCafeCrewsByColumn(base, null);
check("기본(null): 원본 순서 유지", ids(d0) === "1,2,3,4,5", ids(d0));
check("기본(null): 원본 배열 참조 반환(무복사)", d0 === base);

// commentTime: asc=원본, desc=역순.
check(
  "commentTime asc: 원본 순서",
  ids(sortCafeCrewsByColumn(base, { key: "commentTime", dir: "asc" })) === "1,2,3,4,5",
);
check(
  "commentTime desc: 역순",
  ids(sortCafeCrewsByColumn(base, { key: "commentTime", dir: "desc" })) === "5,4,3,2,1",
);

// name: asc=한글 오름차순(가온<나린<다래<라온<마루), desc=반대.
check(
  "name asc: 이름 오름차순",
  ids(sortCafeCrewsByColumn(base, { key: "name", dir: "asc" })) === "2,3,1,5,4",
);
check(
  "name desc: 이름 내림차순",
  ids(sortCafeCrewsByColumn(base, { key: "name", dir: "desc" })) === "4,5,1,3,2",
);
check("name: 입력 배열 불변", ids(base) === before);

// crewCode: asc=코드 오름차순(C100<C200<C300) + 빈값 뒤, desc=코드 내림차순 + 빈값 여전히 뒤.
check(
  "crewCode asc: 코드 오름 + 빈값 뒤",
  ids(sortCafeCrewsByColumn(base, { key: "crewCode", dir: "asc" })) === "3,5,1,2,4",
);
check(
  "crewCode desc: 코드 내림 + 빈값 여전히 뒤(원본순)",
  ids(sortCafeCrewsByColumn(base, { key: "crewCode", dir: "desc" })) === "1,5,3,2,4",
);

// writeStatus: asc=미작성 우선(2,4,5) → 완료(1,3), desc=완료 우선(1,3) → 미작성(2,4,5).
check(
  "writeStatus asc: 미작성 우선",
  ids(sortCafeCrewsByColumn(base, { key: "writeStatus", dir: "asc" })) === "2,4,5,1,3",
);
check(
  "writeStatus desc: 작성 완료 우선",
  ids(sortCafeCrewsByColumn(base, { key: "writeStatus", dir: "desc" })) === "1,3,2,4,5",
);

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
