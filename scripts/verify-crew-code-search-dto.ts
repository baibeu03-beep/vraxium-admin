// ===================================================================
// 사용자 수동 검색 DTO — 크루 코드(crew_code) 표시 전환 회귀 검증.
//   실행: npx tsx --env-file=.env.local scripts/verify-crew-code-search-dto.ts
//
// 검증 대상은 HTTP GET /api/admin/cluster4/cafe-line-crew(수동 검색)·info-lines/crew 가
// 실제로 호출하는 데이터 레이어(loadCrewRecords / loadCrewRecordsByUserIds / filterCrewRecords).
// org × mode(운영/테스트) × by-id(demoUserId·info 수정) 경로가 동일 DTO(crewCode)를 내는지 확인.
//
// 회귀 조건:
//   1. DB 의 실제 crew_code 가 DTO 의 crewCode 로 전달된다.
//   2. 4자리 crew_no 는 crewCode 로 사용되지 않는다(별개 필드로 공존).
//   3. mode=test 와 일반 모드의 DTO shape(키 집합)가 동일하다.
//   4. crewCode 가 null 일 때 임의의 코드를 만들지 않는다(null 유지, crew_no 폴백 금지).
//   5. 검색 결과 레코드는 여전히 userId(UUID)를 식별자로 보유한다.
//   6. filterCrewRecords 가 crew_code 와 이름 모두로 검색된다.
// ===================================================================
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  loadCrewRecords,
  loadCrewRecordsByUserIds,
  filterCrewRecords,
  type CrewRecord,
} from "@/lib/cluster4CafeLineMatch";
import { resolveUserScope } from "@/lib/userScope";
import { isUuid } from "@/lib/isUuid";

let fail = 0;
function check(ok: boolean, label: string, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) fail += 1;
}

const ORGS = ["encre", "oranke", "phalanx"] as const;
const DTO_KEYS = [
  "userId",
  "crewNo",
  "crewCode",
  "name",
  "teamName",
  "partName",
  "schoolName",
  "majorName",
  "organization",
].sort();

function shapeOf(r: CrewRecord): string {
  return Object.keys(r).sort().join(",");
}

async function main() {
  for (const org of ORGS) {
    console.log(`\n=== org=${org} ===`);
    const crews = await loadCrewRecords(org);
    check(crews.length > 0, `${org}: loadCrewRecords 비어있지 않음`, `len=${crews.length}`);

    // DTO shape — crewCode 키 존재 + 정확한 키 집합.
    const shape = crews[0] ? shapeOf(crews[0]) : "";
    check(shape === DTO_KEYS.join(","), `${org}: DTO 키 집합 정확`, shape);

    // DB 원본과 대조 — crew_no / crew_code 를 직접 읽어 매핑 정확성 확인.
    const ids = crews.map((c) => c.userId);
    const byId = new Map(crews.map((c) => [c.userId, c]));
    const dbById = new Map<string, { crew_no: number | null; crew_code: string | null }>();
    for (let i = 0; i < ids.length; i += 500) {
      const { data } = await supabaseAdmin
        .from("user_profiles")
        .select("user_id,crew_no,crew_code")
        .in("user_id", ids.slice(i, i + 500));
      for (const row of (data ?? []) as Array<{ user_id: string; crew_no: number | null; crew_code: string | null }>) {
        dbById.set(row.user_id, { crew_no: row.crew_no, crew_code: row.crew_code });
      }
    }

    let withCode = 0;
    let nullCode = 0;
    let mismatchCode = 0;
    let mismatchNo = 0;
    let codeEqualsNo = 0;
    let badUserId = 0;
    for (const c of crews) {
      const db = dbById.get(c.userId);
      if (!db) continue;
      // (1) 실제 crew_code → crewCode.
      const expectCode = db.crew_code?.trim() || null;
      if (c.crewCode !== expectCode) mismatchCode += 1;
      // (2) crew_no → crewNo(별개 보존).
      if ((c.crewNo ?? null) !== (db.crew_no ?? null)) mismatchNo += 1;
      // (4) crewCode null 이면 합성/폴백 금지 — null 그대로여야.
      if (expectCode === null) {
        nullCode += 1;
        if (c.crewCode !== null) codeEqualsNo += 1; // 무언가로 채워졌으면 위반
      } else {
        withCode += 1;
        // crewCode 가 4자리 crew_no 문자열과 같으면(폴백 흔적) 위반.
        if (c.crewCode === String(db.crew_no)) codeEqualsNo += 1;
      }
      // (5) userId 는 여전히 UUID.
      if (!isUuid(c.userId)) badUserId += 1;
    }
    check(mismatchCode === 0, `${org}: (1) crew_code→crewCode 일치`, `mismatch=${mismatchCode}`);
    check(mismatchNo === 0, `${org}: (2) crew_no→crewNo 보존`, `mismatch=${mismatchNo}`);
    check(codeEqualsNo === 0, `${org}: (4) null/폴백 금지(합성·crew_no 폴백 없음)`, `viol=${codeEqualsNo}`);
    check(badUserId === 0, `${org}: (5) userId=UUID 유지`, `bad=${badUserId}`);
    console.log(`   · crewCode 보유 ${withCode} / 미생성(null) ${nullCode} / 총 ${crews.length}`);

    // (6) filterCrewRecords — 실제 코드로 검색 + 이름 검색(회귀).
    const sample = crews.find((c) => c.crewCode);
    if (sample) {
      const byCode = filterCrewRecords(crews, sample.crewCode!);
      check(byCode.some((c) => c.userId === sample.userId), `${org}: (6) crew_code 로 검색됨`, sample.crewCode!);
      const byName = filterCrewRecords(crews, sample.name);
      check(byName.some((c) => c.userId === sample.userId), `${org}: (6) 이름 검색 회귀 OK`, sample.name);
    }

    // (3) mode 파리티 — operating vs test 가 같은 DTO shape.
    const opScope = await resolveUserScope("operating", org);
    const testScope = await resolveUserScope("test", org);
    const opCrews = opScope.filter(crews, (c) => c.userId);
    const testCrews = testScope.filter(crews, (c) => c.userId);
    const opShape = opCrews[0] ? shapeOf(opCrews[0]) : DTO_KEYS.join(",");
    const testShape = testCrews[0] ? shapeOf(testCrews[0]) : DTO_KEYS.join(",");
    check(opShape === testShape, `${org}: (3) operating vs test DTO shape 동일`, `${opShape} | ${testShape}`);

    // by-id 경로(info-lines/crew·demoUserId) — 동일 crewCode.
    const idSample = crews.filter((c) => c.crewCode).slice(0, 3).map((c) => c.userId);
    if (idSample.length > 0) {
      const byIdRecs = await loadCrewRecordsByUserIds(idSample);
      const idMatch = byIdRecs.every((r) => byId.get(r.userId)?.crewCode === r.crewCode);
      check(idMatch, `${org}: by-id 경로 crewCode 동일(demo/info 수정)`, `n=${byIdRecs.length}`);
    }
  }

  console.log("\n" + "─".repeat(50));
  console.log(fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
