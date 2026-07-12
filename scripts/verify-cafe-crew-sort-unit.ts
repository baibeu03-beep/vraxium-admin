// 단위 검증 — 실제 sortCafeCrews(lib/cafeCrewSort) 를 혼합 데이터로 검사.
//   브라우저 검증(browser-verify-cafe-crew-sort.mjs)은 실 population 이 전원 작성완료·
//   빈 크루코드라 미작성/코드 정렬이 vacuous 로만 통과 → 여기서 혼합 데이터로 규칙을 실증한다.
//   ⚠ 정렬은 표시 순서만: 입력 배열 mutate 없음 · comment 는 원본 참조 반환.
import { sortCafeCrews, type CafeCrew } from "../lib/cafeCrewSort";

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

// comment: 원본 참조 그대로.
const c0 = sortCafeCrews(base, "comment");
check("comment: 원본 순서 유지", ids(c0) === "1,2,3,4,5", ids(c0));
check("comment: 원본 배열 참조 반환(무복사)", c0 === base);

// name: 한글 오름차순(가온<나린<다래<라온<마루).
const cn = sortCafeCrews(base, "name");
check("name: 이름 오름차순", ids(cn) === "2,3,1,5,4", ids(cn));
check("name: 입력 배열 불변", ids(base) === before);

// crewCode: 채워진 코드 오름차순(C100<C200<C300) 먼저, 빈코드(null/"-")는 뒤(원본 순서 유지 2→4).
const cc = sortCafeCrews(base, "crewCode");
check("crewCode: 코드 오름차순 + 빈값 뒤", ids(cc) === "3,5,1,2,4", ids(cc));

// incompleteFirst: 미작성(2,4,5) 먼저, 완성(1,3) 뒤. 각 그룹 내부는 원본 순서(안정).
const ci = sortCafeCrews(base, "incompleteFirst");
const compFlagsI = ci.map((c) => [c.teamName, c.partName, c.schoolName, c.majorName].every((v) => v && v.trim() !== "" && v.trim() !== "-"));
const incThenComp = (() => { let seen = false; for (const f of compFlagsI) { if (f) seen = true; else if (seen) return false; } return true; })();
check("incompleteFirst: 미작성이 앞", incThenComp, ids(ci));
check("incompleteFirst: 미작성 그룹 원본순서(2,4,5)", ids(ci).startsWith("2,4,5"), ids(ci));

// completeFirst: 완성(1,3) 먼저, 미작성(2,4,5) 뒤.
const cf = sortCafeCrews(base, "completeFirst");
const compFlagsF = cf.map((c) => [c.teamName, c.partName, c.schoolName, c.majorName].every((v) => v && v.trim() !== "" && v.trim() !== "-"));
const compThenInc = (() => { let seenInc = false; for (const f of compFlagsF) { if (!f) seenInc = true; else if (seenInc) return false; } return true; })();
check("completeFirst: 완성이 앞", compThenInc, ids(cf));
check("completeFirst: 완성 그룹 원본순서(1,3)", ids(cf).startsWith("1,3"), ids(cf));

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
