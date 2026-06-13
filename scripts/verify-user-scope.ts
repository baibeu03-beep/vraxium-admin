// 검증(READ-ONLY) — lib/userScope.ts Phase 1 골격.
//   npx tsx --env-file=.env.local scripts/verify-user-scope.ts
// DB write 없음. test_user_markers 조회만. resolver 의미/기본값/격리만 확인(호출부 미변경).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  parseScopeMode,
  readScopeMode,
  appendModeQuery,
  resolveUserScope,
  listScopedOrgUserIds,
} from "@/lib/userScope";

let pass = 0;
let fail = 0;
const ck = (l: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};

async function main() {
  // ── 파싱: operating 기본 / test 리터럴만 ──
  ck("[parse] 미지정 → operating", parseScopeMode(null) === "operating");
  ck("[parse] '' → operating", parseScopeMode("") === "operating");
  ck("[parse] 'TEST'(대문자) → operating(리터럴만 인정)", parseScopeMode("TEST") === "operating");
  ck("[parse] 'test' → test", parseScopeMode("test") === "test");
  ck("[parse] 오타 'tset' → operating", parseScopeMode("tset") === "operating");
  ck("[read] searchParams ?mode=test → test", readScopeMode(new URLSearchParams("mode=test")) === "test");
  ck("[read] searchParams 없음 → operating", readScopeMode(new URLSearchParams("")) === "operating");

  // ── 링크 전파: operating 은 byte-identical, test 만 부착 ──
  ck("[link] operating href 불변", appendModeQuery("/crews?org=encre", "operating") === "/crews?org=encre");
  ck(
    "[link] test href 에 mode=test 부착",
    appendModeQuery("/crews?org=encre", "test").includes("mode=test"),
    appendModeQuery("/crews?org=encre", "test"),
  );

  // ── 실제 마커로 의미 검증 ──
  const { data: markers } = await supabaseAdmin.from("test_user_markers").select("user_id");
  const ids = ((markers ?? []) as Array<{ user_id: string }>).map((m) => m.user_id);
  const aTest = ids[0];
  // 실사용자 1명(마커 비등재).
  const { data: profs } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id")
    .eq("organization_slug", "encre")
    .limit(400);
  const testSet = new Set(ids);
  const aReal =
    ((profs ?? []) as Array<{ user_id: string }>).map((p) => p.user_id).find((id) => !testSet.has(id)) ?? null;
  console.log(`  (sample) testUser=${aTest} realUser=${aReal}`);

  const op = await resolveUserScope("operating", "encre");
  const ts = await resolveUserScope("test", "encre");

  ck("[operating] 실사용자 includes=true", aReal ? op.includes(aReal) : false);
  ck("[operating] 테스트 유저 includes=false", aTest ? op.includes(aTest) === false : false);
  ck("[test] 테스트 유저 includes=true", aTest ? ts.includes(aTest) : false);
  ck("[test] 실사용자 includes=false", aReal ? ts.includes(aReal) === false : false);

  // ── filter / 쿼리 제약 헬퍼 ──
  const mixed = [aReal, aTest].filter(Boolean) as string[];
  ck("[operating] filter → 실사용자만", JSON.stringify(op.filter(mixed)) === JSON.stringify([aReal]));
  ck("[test] filter → 테스트 유저만", JSON.stringify(ts.filter(mixed)) === JSON.stringify([aTest]));
  ck("[operating] includeUserIds=null · excludeUserIds=테스트전체", op.includeUserIds === null && op.excludeUserIds.length === ids.length);
  ck("[test] includeUserIds=테스트전체 · excludeUserIds=[]", ts.includeUserIds?.length === ids.length && ts.excludeUserIds.length === 0);

  // ── listScopedOrgUserIds (encre) ──
  const opOrg = await listScopedOrgUserIds(op);
  const tsOrg = await listScopedOrgUserIds(ts);
  const opHasTest = opOrg.some((id) => testSet.has(id));
  const tsAllTest = tsOrg.length > 0 && tsOrg.every((id) => testSet.has(id));
  ck("[operating] encre 명부에 테스트 유저 0명", !opHasTest, `total=${opOrg.length}`);
  ck("[test] encre 명부 = 전원 테스트 유저", tsAllTest, `total=${tsOrg.length}`);
  ck("[격리] operating ∩ test = ∅ (모집단 분리)", opOrg.filter((id) => tsOrg.includes(id)).length === 0);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
