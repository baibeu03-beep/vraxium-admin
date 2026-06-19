/**
 * READ-ONLY 진단 — 카카오 연결 7개 T사용자가 운영 모드 app-users 목록에 새는지 직접 함수로 확인.
 *   npx tsx --env-file=.env.local scripts/diag-kakao-operating-leak.ts
 */
import { listAppUsers } from "@/lib/adminAppUsersData";
import { resolveUserScope } from "@/lib/userScope";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";

const SEVEN: Array<{ name: string; id: string }> = [
  { name: "T임시우", id: "a80ea67a-8836-4c13-8568-66dff79d7a66" },
  { name: "T황민서", id: "614f78f4-c372-4c11-a17f-46b9e7bd4523" },
  { name: "T조예린", id: "98807fea-2137-4160-ba5c-dedcbdced0e8" },
  { name: "T임다인", id: "42864260-e4ea-4150-a87f-cff545b02af1" },
  { name: "T장소율", id: "f980b257-12b1-4f9c-ae71-307336071785" },
  { name: "T정하은", id: "fff3941f-071c-4cca-b99a-da8bd6d2fae2" },
  { name: "T정시현", id: "70abfec0-660b-4af3-a940-5d318f76bd4e" },
];

async function main() {
  const markers = await fetchTestUserMarkerIds();
  console.log(`\n[markers] test_user_markers 총 ${markers.size}건`);

  const opScope = await resolveUserScope("operating", null);
  console.log(`[scope.operating] excludeUserIds=${opScope.excludeUserIds.length} includeUserIds=${opScope.includeUserIds === null ? "null" : opScope.includeUserIds.length}`);

  console.log(`\n── 7명 marker/scope 판정 ──`);
  for (const { name, id } of SEVEN) {
    console.log(
      `  ${name} ${id}  inMarkers=${markers.has(id)}  opScope.includes(=운영포함?)=${opScope.includes(id)}`,
    );
  }

  const op = await listAppUsers({ mode: "operating", limit: 500 });
  const test = await listAppUsers({ mode: "test", limit: 500 });
  const opIds = new Set(op.data.map((u) => u.userId));
  const testIds = new Set(test.data.map((u) => u.userId));

  console.log(`\n[listAppUsers operating] total=${op.total} displayed=${op.data.length}`);
  console.log(`[listAppUsers test]      total=${test.total} displayed=${test.data.length}`);

  console.log(`\n── 7명 목록 포함 여부 (direct function) ──`);
  console.log(`name\t\toperating(제외돼야)\ttest(포함돼야)`);
  for (const { name, id } of SEVEN) {
    console.log(`  ${name}\t op=${opIds.has(id) ? "보임❌" : "없음✅"}\t test=${testIds.has(id) ? "보임✅" : "없음❌"}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
