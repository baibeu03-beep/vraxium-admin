/**
 * READ-ONLY 검증: info-lines POST 의 target 스코프 가드(assertUserIdsInScope) 동작.
 *   npx tsx --env-file=.env.local scripts/verify-info-target-scope-guard.ts
 * cluster4_line_targets 에 운영↔테스트가 섞이지 않도록 write 직전 422 가드가 정확한지 확인.
 */
import { createClient } from "@supabase/supabase-js";
import { resolveUserScope, assertUserIdsInScope } from "@/lib/userScope";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

function expectThrow(label: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✗ ${label} — 통과되면 안 되는데 통과함 ❌`);
  } catch (e) {
    const status = (e as { status?: number })?.status;
    console.log(`  ${status === 422 ? "✓" : "✗"} ${label} — status=${status}`);
  }
}
function expectOk(label: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${label} — 통과 ✅`);
  } catch (e) {
    console.log(`  ✗ ${label} — 막히면 안 되는데 막힘: ${(e as Error).message} ❌`);
  }
}

async function main() {
  const testIds = [...(await fetchTestUserMarkerIds())];
  const testId = testIds[0];
  // 실사용자 1명(테스트 마커 아님) 확보.
  const { data } = await sb.from("user_profiles").select("user_id").eq("organization_slug", "oranke");
  const realId = (data ?? []).map((r: any) => r.user_id).find((id: string) => !testIds.includes(id));
  console.log("testId=", testId, "\nrealId=", realId);

  const op = await resolveUserScope("operating", null);
  const ts = await resolveUserScope("test", null);

  console.log("\n[operating 스코프 — 실사용자만 허용]");
  expectOk("operating + 실사용자 → 통과", () => assertUserIdsInScope(op, [realId]));
  expectThrow("operating + 테스트계정 → 422", () => assertUserIdsInScope(op, [testId]));
  expectThrow("operating + 혼합(실+테스트) → 422", () => assertUserIdsInScope(op, [realId, testId]));

  console.log("\n[test 스코프 — 테스트계정만 허용]");
  expectOk("test + 테스트계정 → 통과", () => assertUserIdsInScope(ts, [testId]));
  expectThrow("test + 실사용자 → 422", () => assertUserIdsInScope(ts, [realId]));
  expectThrow("test + 혼합 → 422", () => assertUserIdsInScope(ts, [realId, testId]));

  console.log("\n[0명 개설 — 양쪽 통과]");
  expectOk("operating + 0명 → 통과", () => assertUserIdsInScope(op, []));
  expectOk("test + 0명 → 통과", () => assertUserIdsInScope(ts, []));

  console.log("\n완료 (read-only)");
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
