// 공통 SoT lib/crewSearchExclude 검증 — 크루 검색 결과에서 이미 추가된 크루 제외 규칙.
//   요구사항 매핑:
//   - userId 기준 판정(이름 아님)
//   - 이미 추가된 크루는 결과에서 완전 제외
//   - 추가 직후 즉시 사라짐 / 삭제 시 다시 나타남 (상태 변화 → 재계산)
//   - 결과·대상 키가 다른 경우(예: results.userId vs apps.targetUserId)도 동일 처리
//   - 순수 함수 — 입력 DTO 동일이면 출력 동일(모드/스코프 무관)
import { excludeAddedByUserId, toUserIdSet } from "../lib/crewSearchExclude";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}  ${detail}`);
  }
}

type Crew = { userId: string; name: string };
const A = { userId: "u1", name: "홍길동" };
const B = { userId: "u2", name: "김철수" };
const C = { userId: "u3", name: "홍길동" }; // A 와 동명이인(이름 같고 userId 다름)
const results: Crew[] = [A, B, C];

// 1) userId 기준 제외 — roster=[A] → A 만 빠지고, 동명이인 C 는 남는다(이름 아님).
{
  const roster: Crew[] = [A];
  const out = excludeAddedByUserId(results, roster, (c) => c.userId);
  check(
    "userId 기준 제외(이름 아님): A 제외, 동명이인 C 유지",
    out.length === 2 && out.some((c) => c.userId === "u2") && out.some((c) => c.userId === "u3") && !out.some((c) => c.userId === "u1"),
    JSON.stringify(out.map((c) => c.userId)),
  );
}

// 2) 완전 제외(비활성 아님) — 제외 대상은 배열에서 사라진다(원소 개수 감소).
{
  const roster: Crew[] = [A, B];
  const out = excludeAddedByUserId(results, roster, (c) => c.userId);
  check("완전 제외: A,B 사라지고 C 만 남음", out.length === 1 && out[0].userId === "u3", JSON.stringify(out.map((c) => c.userId)));
}

// 3) 추가 직후 즉시 제외 / 삭제 시 재노출 — 대상 목록 변화만으로 결과가 바뀐다(재검색 불필요).
{
  let roster: Crew[] = [];
  const before = excludeAddedByUserId(results, roster, (c) => c.userId);
  check("추가 전: 전원 노출", before.length === 3);
  roster = [...roster, A]; // A 추가
  const afterAdd = excludeAddedByUserId(results, roster, (c) => c.userId);
  check("추가 직후: A 즉시 제외", !afterAdd.some((c) => c.userId === "u1") && afterAdd.length === 2);
  roster = roster.filter((c) => c.userId !== "u1"); // A 삭제
  const afterRemove = excludeAddedByUserId(results, roster, (c) => c.userId);
  check("삭제 후: A 다시 노출", afterRemove.some((c) => c.userId === "u1") && afterRemove.length === 3);
}

// 4) 결과·대상 키가 다른 경우 — results.userId vs apps.targetUserId (CompetencyApplicantSection).
{
  const apps = [{ targetUserId: "u2" }, { targetUserId: "u3" }];
  const out = excludeAddedByUserId(
    results,
    apps,
    (c) => c.userId,
    (a) => a.targetUserId,
  );
  check("다른 키(userId vs targetUserId): u2,u3 제외", out.length === 1 && out[0].userId === "u1", JSON.stringify(out.map((c) => c.userId)));
}

// 5) 순수성 — 원본 results 는 변형되지 않는다(새 배열 반환).
{
  const roster: Crew[] = [A];
  const snapshot = results.map((c) => c.userId).join(",");
  const out = excludeAddedByUserId(results, roster, (c) => c.userId);
  check(
    "원본 불변(순수 함수)",
    results.map((c) => c.userId).join(",") === snapshot && out !== (results as unknown),
  );
}

// 6) 빈 대상 목록 — 전원 그대로(복사본).
{
  const out = excludeAddedByUserId(results, [], (c) => c.userId);
  check("빈 대상: 전원 노출(복사본)", out.length === 3 && out !== (results as unknown as Crew[]));
}

// 7) Set 직접 전달 + 누락 userId 안전.
{
  const set = toUserIdSet([A, B], (c) => c.userId);
  const withNull: Array<Crew | { userId: null; name: string }> = [A, { userId: null, name: "널" }, C];
  const out = excludeAddedByUserId(withNull, set, (c) => (c.userId as string | null) ?? null);
  // A 제외, userId=null 은 유지(제외 대상 아님), C 유지 → 2개.
  check("Set 전달 + null userId 안전", out.length === 2 && !out.some((c) => c.userId === "u1"), JSON.stringify(out.map((c) => c.userId)));
}

console.log(`\n${fail === 0 ? "ALL PASS" : "SOME FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
