/**
 * B안 복합키 — 코드 경로 행동 검증 (read-only, write 0).
 *
 *   npx tsx --env-file=.env.local scripts/verify-composite-key-paths.ts
 *
 *   [1] resolveGrowthUserId: UUID 경로 / 숫자 1행 경로(248→박시은 UUID) / 부재 404
 *   [2] 모호성 분기: DB write 금지로 실제 2행 상태는 만들 수 없음 — limit(2) 쿼리 형태가
 *       현 데이터에서 1행을 반환함을 확인하고, >1 분기는 정적(코드) + 이관 dry-run 재검증 계약.
 *   [3] adminCrewData graft 가드: 28명(legacy 248~303, source NULL) → legacy 메타 graft 유지
 *       (display_name 폴백 등 현행 화면 동작 불변 확인).
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { resolveGrowthUserId } from "@/lib/cluster3GrowthData";
import { getAdminCrewDtoByLegacyUserId } from "@/lib/adminCrewData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
let pass = 0,
  fail = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

async function main() {
  // 기준 데이터: legacy 248 보유 사용자 (olympus 동일인 박시은 — NULL-source)
  const { data: u248 } = await sb
    .from("users")
    .select("id,source_system")
    .eq("legacy_user_id", 248)
    .limit(2);
  check("[0] legacy 248 현재 1행 (NULL-source)", (u248 ?? []).length === 1 && u248![0].source_system === null);
  const uuid248 = u248![0].id as string;

  // [1] resolveGrowthUserId
  const byUuid = await resolveGrowthUserId(uuid248);
  check("[1a] UUID 경로 — 자기 자신", byUuid === uuid248);
  const byLegacy = await resolveGrowthUserId("248");
  check("[1b] 숫자 1행 경로 — 248 → 동일 UUID", byLegacy === uuid248);
  let notFound = false;
  try {
    await resolveGrowthUserId("9999999");
  } catch (e) {
    notFound = (e as { status?: number }).status === 404;
  }
  check("[1c] 부재 숫자 → 404", notFound);

  // [2] limit(2) 쿼리 형태 — 현 데이터 전수에서 단일성 확인 (모호 후보 0)
  {
    const all: number[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await sb
        .from("users")
        .select("legacy_user_id")
        .not("legacy_user_id", "is", null)
        .order("id", { ascending: true })
        .range(from, from + 999);
      for (const r of (data ?? []) as { legacy_user_id: number }[]) all.push(r.legacy_user_id);
      if ((data ?? []).length < 1000) break;
    }
    const seen = new Set<number>();
    let dup = 0;
    for (const v of all) {
      if (seen.has(v)) dup++;
      seen.add(v);
    }
    check(
      "[2] 현재 숫자 중복 0 — 모호 분기는 이관 후 활성 (dry-run 재검증 계약)",
      dup === 0,
      `legacy 보유 ${all.length}행`,
    );
  }

  // [3] graft 가드 — NULL-source 사용자는 legacy_crew_import 메타 유지 (현행 화면 불변)
  const dto = await getAdminCrewDtoByLegacyUserId(uuid248);
  check(
    "[3] NULL-source 사용자 legacy 메타 graft 유지 (박시은 — 화면 회귀 없음)",
    !!dto && dto.displayName === "박시은",
    `displayName=${dto?.displayName}`,
  );

  console.log(`\n결과: PASS ${pass} / FAIL ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
