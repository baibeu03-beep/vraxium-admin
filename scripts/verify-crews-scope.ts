// 검증(READ-ONLY) — /admin/crews 모집단 스코프(operating/test) 정합.
//   npx tsx --env-file=.env.local scripts/verify-crews-scope.ts
// write 없음. listAdminCrewDtos(encre, mode) 결과를 test_user_markers 와 대조한다.

import { listAdminCrewDtos } from "@/lib/adminCrewData";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import type { OrganizationSlug } from "@/lib/organizations";

const ORG = "encre" as OrganizationSlug;

async function main() {
  const testIds = await fetchTestUserMarkerIds();

  const operating = await listAdminCrewDtos(ORG, "operating");
  const test = await listAdminCrewDtos(ORG, "test");
  const legacyNoMode = await listAdminCrewDtos(ORG); // mode 미지정 == operating 이어야

  const opTesters = operating.filter((c) => testIds.has(c.userId));
  const testReals = test.filter((c) => !testIds.has(c.userId));
  const testAllTesters = test.every((c) => testIds.has(c.userId));

  console.log("═══════════════════════════════════════");
  console.log(`  /admin/crews 스코프 검증 — org=${ORG}`);
  console.log("═══════════════════════════════════════");
  console.log(`test_user_markers 총 ${testIds.size}명 (전 org)\n`);

  console.log(`operating 인원: ${operating.length}명`);
  console.log(`  └ 그 중 test_user_markers 포함: ${opTesters.length}명 (기대 0)`);
  if (opTesters.length > 0) {
    console.log("    ⚠ 누설된 테스트 유저:");
    for (const c of opTesters) console.log(`      - ${c.displayName} (${c.userId})`);
  }

  console.log(`\ntest 인원: ${test.length}명`);
  console.log(`  └ 그 중 실사용자(비-marker): ${testReals.length}명 (기대 0)`);
  console.log(`  └ 전원 test_user_markers 인가: ${testAllTesters}`);

  console.log(`\nmode 미지정 인원: ${legacyNoMode.length}명`);
  const sameAsOperating =
    legacyNoMode.length === operating.length &&
    legacyNoMode.every((c, i) => c.userId === operating[i].userId);
  console.log(`  └ operating 과 동일(순서까지): ${sameAsOperating}`);

  const overlap = operating.filter((c) => test.some((t) => t.userId === c.userId));
  console.log(`\noperating ∩ test 교집합: ${overlap.length}명 (기대 0)`);

  const pass =
    opTesters.length === 0 &&
    testReals.length === 0 &&
    testAllTesters &&
    sameAsOperating &&
    overlap.length === 0;

  console.log(`\n결과: ${pass ? "PASS ✅" : "FAIL ❌"}`);
  console.log(
    JSON.stringify(
      {
        org: ORG,
        operatingCount: operating.length,
        testCount: test.length,
        noModeCount: legacyNoMode.length,
        opTesterLeak: opTesters.length,
        testRealLeak: testReals.length,
      },
      null,
      2,
    ),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
