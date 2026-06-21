/**
 * diag-calendar-line-targets.ts  (READ-ONLY)
 * 캘린더 라인의 6명 타깃이 test/real 누구인지, org 가 무엇인지 확정.
 * 실행: npx tsx --env-file=.env.local scripts/diag-calendar-line-targets.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const TARGET_UIDS = [
  "f980b257",
  "fff3941f",
  "70abfec0",
  "98807fea",
  "614f78f4",
  "a80ea67a",
];

async function main() {
  const testIds = await fetchTestUserMarkerIds();

  // 타깃 6명 풀 UID 조회.
  const { data: tgts } = await sb
    .from("cluster4_line_targets")
    .select("target_user_id")
    .eq("line_id", "9d21e661-3b0f-41b1-9ff1-5073fb5476ce")
    .eq("target_mode", "user");
  const uids = Array.from(
    new Set(
      ((tgts ?? []) as Array<{ target_user_id: string | null }>)
        .map((t) => t.target_user_id)
        .filter((x): x is string => Boolean(x)),
    ),
  );

  const { data: profiles } = await sb
    .from("user_profiles")
    .select("user_id,display_name,organization_slug")
    .in("user_id", uids);
  const byId = new Map(
    ((profiles ?? []) as Array<{
      user_id: string;
      display_name: string | null;
      organization_slug: string | null;
    }>).map((p) => [p.user_id, p]),
  );

  console.log("\n=== 캘린더 라인 타깃 6명 ===");
  let testCount = 0;
  let realCount = 0;
  for (const uid of uids) {
    const p = byId.get(uid);
    const isTest = testIds.has(uid);
    if (isTest) testCount++;
    else realCount++;
    console.log(
      `  ${isTest ? "🧪TEST" : "👤REAL"} ${p?.display_name ?? "(이름없음)"}  org=${p?.organization_slug ?? "—"}  ${uid}`,
    );
  }
  console.log(`\n요약: TEST ${testCount}명 / REAL ${realCount}명 (전체 ${uids.length})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
