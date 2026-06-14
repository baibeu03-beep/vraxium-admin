// READ-ONLY 진단: WEEKLY_CARDS_DTO_VERSION 분포 / stale / 테스터 대상 버전.
//   npx tsx --env-file=.env.local scripts/diag-dto-version-readonly.ts
import { createClient } from "@supabase/supabase-js";
import { WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const TABLE = "cluster4_weekly_card_snapshots";

async function exactCount(filter: (q: any) => any): Promise<number> {
  const q = filter(sb.from(TABLE).select("*", { count: "exact", head: true }));
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function main() {
  console.log("════════ 1. 코드 상수 ════════");
  console.log("WEEKLY_CARDS_DTO_VERSION =", WEEKLY_CARDS_DTO_VERSION);

  console.log("\n════════ 2. dto_version 분포 (exact count) ════════");
  const total = await exactCount((q) => q);
  const v18 = await exactCount((q) => q.eq("dto_version", 18));
  const v19 = await exactCount((q) => q.eq("dto_version", 19));
  const v20 = await exactCount((q) => q.eq("dto_version", 20));
  const known = v18 + v19 + v20;
  const others = total - known;
  console.log(`total            : ${total}`);
  console.log(`v18              : ${v18}`);
  console.log(`v19              : ${v19}`);
  console.log(`v20              : ${v20}`);
  console.log(`기타(그 외 버전) : ${others}`);

  console.log("\n════════ 3. is_stale=true (exact count) ════════");
  const stale = await exactCount((q) => q.eq("is_stale", true));
  const versionMismatch = total - v20; // 코드=20 이므로 v20 외 전부 version_mismatch
  const servedStale = await exactCount((q) =>
    q.or(`is_stale.eq.true,dto_version.neq.${WEEKLY_CARDS_DTO_VERSION}`),
  );
  console.log(`is_stale=true                         : ${stale}`);
  console.log(`version_mismatch (dto_version≠20)     : ${versionMismatch}`);
  console.log(`읽기에서 stale 서빙(둘 중 하나라도)   : ${servedStale}`);

  console.log("\n════════ 4. 테스터(test_user_markers) 대상 snapshot 버전 ════════");
  const markerRes = await sb.from("test_user_markers").select("user_id");
  if (markerRes.error) throw new Error(markerRes.error.message);
  const testerIds = ((markerRes.data ?? []) as { user_id: string }[])
    .map((r) => r.user_id)
    .filter(Boolean);
  console.log(`test_user_markers 등재 : ${testerIds.length}명`);

  // 90명 미만이므로 .in() 단일 호출 안전(1000 cap 무관). order+range 로 안전화.
  const snapRes = await sb
    .from(TABLE)
    .select("user_id,dto_version,is_stale,computed_at")
    .in("user_id", testerIds)
    .order("user_id", { ascending: true })
    .range(0, 999);
  if (snapRes.error) throw new Error(snapRes.error.message);
  const snaps = (snapRes.data ?? []) as {
    user_id: string;
    dto_version: number;
    is_stale: boolean;
    computed_at: string;
  }[];

  const byVer: Record<string, number> = {};
  let testerStale = 0;
  let testerMismatch = 0;
  for (const s of snaps) {
    byVer[s.dto_version] = (byVer[s.dto_version] ?? 0) + 1;
    if (s.is_stale) testerStale++;
    if (s.dto_version !== WEEKLY_CARDS_DTO_VERSION) testerMismatch++;
  }
  const noSnapshot = testerIds.length - snaps.length;
  console.log(`  snapshot 보유          : ${snaps.length}명`);
  console.log(`  snapshot 없음(miss)    : ${noSnapshot}명`);
  console.log(`  버전 분포              : ${JSON.stringify(byVer)}`);
  console.log(`  is_stale=true          : ${testerStale}명`);
  console.log(`  dto_version≠20(mismatch): ${testerMismatch}명`);

  console.log("\n════════ 5. direct vs HTTP 차이 원인 판정 ════════");
  console.log("  HTTP 경로 = readWeeklyCardsSnapshot (snapshot 우선, stale 시 구 cards graceful)");
  console.log("  direct 경로 = getCluster4WeeklyCardsForProfileUser (실시간 v20 계산)");
  if (testerMismatch > 0 || testerStale > 0) {
    console.log(
      `  → 테스터 중 ${Math.max(testerMismatch, testerStale)}명이 mismatch/stale 상태.`,
    );
    console.log(
      "    이 경우 HTTP 는 구버전 cards 를 graceful 서빙 → direct(v20 live)와 불일치 가능 = mismatch 원인 일치.",
    );
  } else {
    console.log(
      "  → 테스터 전원 v20·fresh. dto_version mismatch 는 차이 원인이 아님(다른 원인 의심: demo override·org 필터 등).",
    );
  }

  // 샘플: mismatch/stale 인 테스터 최대 10명 나열
  const flagged = snaps
    .filter((s) => s.dto_version !== WEEKLY_CARDS_DTO_VERSION || s.is_stale)
    .slice(0, 10);
  if (flagged.length) {
    console.log("\n  [샘플] mismatch/stale 테스터:");
    for (const s of flagged) {
      console.log(
        `    ${s.user_id}  v${s.dto_version}  stale=${s.is_stale}  computed_at=${s.computed_at}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
