/**
 * READ-ONLY 검증: 라인 개설 크루 매칭의 org + mode(운영/테스트) 스코프.
 *   npx tsx --env-file=.env.local scripts/verify-cafe-crew-mode-scope.ts
 *
 * direct: loadCrewRecords(org) → scope.filter (라우트 loadScopedCrews 와 동일 경로).
 * operating=실사용자만 / test=test_user_markers 만, 서로 겹치지 않아야 한다.
 */
import { loadCrewRecords } from "@/lib/cluster4CafeLineMatch";
import { resolveUserScope } from "@/lib/userScope";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";

async function main() {
  const orgs = ["oranke", "encre", "phalanx"] as const;
  const testIds = await fetchTestUserMarkerIds();
  console.log("test_user_markers 총:", testIds.size);

  for (const org of orgs) {
    const crews = await loadCrewRecords(org); // org 격리(이전 단계)
    const opScope = await resolveUserScope("operating", org);
    const tsScope = await resolveUserScope("test", org);

    const op = opScope.filter(crews, (c) => c.userId); // 라우트 loadScopedCrews(operating)
    const ts = tsScope.filter(crews, (c) => c.userId); // 라우트 loadScopedCrews(test)

    const opHasTest = op.filter((c) => testIds.has(c.userId));
    const tsHasReal = ts.filter((c) => !testIds.has(c.userId));
    const overlap = op.filter((c) => ts.some((t) => t.userId === c.userId));

    console.log(`\norg='${org}' (전체 ${crews.length})`);
    console.log(
      `  operating → ${op.length}명, 그 중 테스트계정 ${opHasTest.length} ${opHasTest.length === 0 ? "✅" : "❌"}`,
    );
    console.log(
      `  test      → ${ts.length}명, 그 중 실사용자 ${tsHasReal.length} ${tsHasReal.length === 0 ? "✅" : "❌"}`,
    );
    console.log(`  operating∩test 겹침: ${overlap.length} ${overlap.length === 0 ? "✅" : "❌"}`);
    console.log(`  분리 합 = ${op.length}+${ts.length}=${op.length + ts.length} (전체 ${crews.length})`);
    if (ts.length > 0) {
      console.log(
        "  test 표본:",
        ts.slice(0, 3).map((c) => `${c.name}(${c.teamName ?? "-"})`).join(", "),
      );
    }
  }
  console.log("\n완료 (read-only)");
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
