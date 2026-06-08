/**
 * legacy growth_status NULL 백필 — DRY-RUN 전용 (write 코드 없음, 승인 전 실행 금지 대상은 백필 자체).
 *
 *   대상: user_profiles.growth_status ∈ ('graduating','seasonal_rest','weekly_rest')
 *         → NULL 백필 후보 (2026-06-07 auto/override 분리 후 표시 무영향 legacy 값)
 *   출력:
 *     1) 변경 대상 preview (이름/조직/테스터 여부/현재 raw/표시 상태)
 *     2) 표시 불변 증명 — 각 대상의 manualOverrideStatus===null (display=auto, raw 무관)
 *     3) CHECK 축소 영향 preview — 백필 후 분포 vs 신규 CHECK 집합 위반 0건 확인
 *     4) 승인 후 SQL Editor 에 실행할 백필+CHECK 마이그레이션 SQL 초안 출력
 *
 * Usage: npx tsx --env-file=.env.local scripts/dryrun-legacy-growth-status-null.ts
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { supabaseAdmin } from "../lib/supabaseAdmin";
import { getGrowthIndicatorsInternal } from "../lib/cluster3GrowthData";

const LEGACY_VALUES = ["graduating", "seasonal_rest", "weekly_rest"] as const;
// 백필 후 CHECK 축소안: active 는 생성 경로/목록 필터 호환을 위해 이번 단계에서 유지.
const NEW_CHECK_SET = ["active", "paused", "suspended", "graduated"] as const;

async function main() {
  // ── 0. 전체 분포 ────────────────────────────────────────────────────
  const { data: allRows, error } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,organization_slug,growth_status");
  if (error) throw new Error(error.message);
  const rows = (allRows ?? []) as Array<{
    user_id: string;
    display_name: string | null;
    organization_slug: string | null;
    growth_status: string | null;
  }>;

  const { data: markers } = await supabaseAdmin
    .from("test_user_markers")
    .select("user_id");
  const testerIds = new Set(
    ((markers ?? []) as Array<{ user_id: string }>).map((m) => m.user_id),
  );

  const dist = new Map<string, number>();
  for (const r of rows) {
    const k = r.growth_status ?? "NULL";
    dist.set(k, (dist.get(k) ?? 0) + 1);
  }
  console.log("=== 0) 현재 growth_status 분포 ===");
  for (const [k, c] of [...dist.entries()].sort()) console.log(`  ${k}: ${c}`);

  // ── 1. 백필 대상 preview ───────────────────────────────────────────
  const targets = rows.filter(
    (r) => r.growth_status && (LEGACY_VALUES as readonly string[]).includes(r.growth_status),
  );
  console.log(`\n=== 1) NULL 백필 대상 — ${targets.length}건 (write 없음, preview) ===`);
  for (const t of targets) {
    console.log(
      `  [${testerIds.has(t.user_id) ? "T" : "실"}] ${t.display_name} (${t.organization_slug ?? "?"}) raw=${t.growth_status} → NULL  ${t.user_id}`,
    );
  }
  const realTargets = targets.filter((t) => !testerIds.has(t.user_id));
  console.log(`  테스터 ${targets.length - realTargets.length} / 실사용자 ${realTargets.length}`);

  // ── 2. 표시 불변 증명 ──────────────────────────────────────────────
  //   override 추출은 3종만 인정 → legacy 값 보유자는 이미 override=null,
  //   display=auto. raw 를 NULL 로 바꿔도 display 입력이 변하지 않는다.
  console.log("\n=== 2) 표시 불변 증명 — 대상 전원 override=null (display=auto) ===");
  let invariantOk = 0,
    invariantFail = 0;
  for (const t of targets) {
    const g = await getGrowthIndicatorsInternal(t.user_id);
    const ok = g.process.manualOverrideStatus === null;
    if (ok) invariantOk++;
    else {
      invariantFail++;
      console.log(`  ✗ ${t.display_name}: override=${g.process.manualOverrideStatus} (예상 밖)`);
    }
    console.log(
      `  ${ok ? "✓" : "✗"} ${t.display_name}: raw=${t.growth_status} → display=${g.process.growthDisplayKey}(auto=${g.process.autoGrowthStatusKey}) — NULL 백필 후에도 동일`,
    );
  }
  console.log(`  불변 ${invariantOk} / 위반 ${invariantFail}`);

  // ── 3. CHECK 축소 영향 preview ─────────────────────────────────────
  console.log("\n=== 3) CHECK 축소 영향 — 신규 집합 ('active','paused','suspended','graduated') ∪ NULL ===");
  const wouldViolateNow = rows.filter(
    (r) =>
      r.growth_status !== null &&
      !(NEW_CHECK_SET as readonly string[]).includes(r.growth_status),
  );
  console.log(`  현재 상태에서 신규 CHECK 위반: ${wouldViolateNow.length}건 (= 백필 대상과 일치해야 함)`);
  const mismatch =
    wouldViolateNow.length !== targets.length ||
    wouldViolateNow.some((v) => !targets.find((t) => t.user_id === v.user_id));
  console.log(
    mismatch
      ? "  ✗ 백필 대상과 불일치 — 백필 SQL 의 IN 목록 재검토 필요"
      : "  ✓ 백필 후 위반 0건 — CHECK 추가 안전 (백필과 동일 트랜잭션 실행 전제)",
  );

  // ── 4. 승인 후 실행할 마이그레이션 SQL 초안 ────────────────────────
  const sql = `-- 2026-06-XX_growth_status_legacy_null_backfill.sql (초안 — 승인 후 날짜 확정)
-- legacy growth_status NULL 백필 + CHECK 축소. dry-run: scripts/dryrun-legacy-growth-status-null.ts
-- 전제: auto/override 분리(54c6c0f) 배포 후. 표시 무영향(대상 전원 override=null 실측).
BEGIN;

-- 롤백용 백업 (실행 전 결과를 별도 보관)
-- SELECT user_id, growth_status FROM public.user_profiles
--  WHERE growth_status IN ('graduating','seasonal_rest','weekly_rest');

UPDATE public.user_profiles
   SET growth_status = NULL
 WHERE growth_status IN ('graduating','seasonal_rest','weekly_rest');
-- 기대 행수: ${targets.length} (dry-run ${new Date().toISOString().slice(0, 10)} 기준)

ALTER TABLE public.user_profiles
  DROP CONSTRAINT IF EXISTS user_profiles_growth_status_check;
ALTER TABLE public.user_profiles
  ADD CONSTRAINT user_profiles_growth_status_check
  CHECK (growth_status IS NULL OR growth_status IN ('active','paused','suspended','graduated'));

COMMIT;

-- 롤백: 위 백업 SELECT 결과로 행별 UPDATE 복원 후,
-- CHECK 를 2026-06-01_user_profiles_status_growth_check.sql 의 7종 집합으로 재생성.
`;
  const outPath = resolve(__dirname, "..", "claudedocs", "legacy-growth-status-backfill-draft.sql");
  writeFileSync(outPath, sql);
  console.log(`\n=== 4) 승인 후 실행할 SQL 초안 ===\n${sql}`);
  console.log(`초안 저장: claudedocs/legacy-growth-status-backfill-draft.sql`);
  console.log("\n⚠ 본 스크립트는 어떤 write 도 수행하지 않았습니다. 백필 실행은 승인 후 SQL Editor 에서.");
}

void main();
