/**
 * QA 데이터 보정: test_user_markers 등록 테스트 유저를 현재 운영 시즌(2026-summer)
 * user_season_statuses 에 시드한다 — QA 모드 크루 목록(roster)이 현재 시즌 게이트에서
 * 테스트 크루를 표시하도록.  (Phase A 코드와 무관한 데이터 보정.)
 *
 *   - 대상: test_user_markers 등록 유저만(실유저 절대 무접촉).
 *   - 상태: 각 유저의 2026-spring season_status 를 미러(success→active · rest→rest ·
 *           fail→stopped · 없음/기타→active) → 현실적인 QA 코호트.
 *   - idempotent: 이미 2026-summer 행이 있는 유저는 건너뜀(중복 생성 안 함).
 *   - rollback: note '[QA-SEED]' 표식 + --rollback 으로 정확히 그 행만 삭제.
 *
 *   미리보기(기본):  npx tsx --env-file=.env.local scripts/seed-qa-test-users-summer-season.ts
 *   적용:            ... seed-qa-test-users-summer-season.ts --apply
 *   롤백:            ... seed-qa-test-users-summer-season.ts --rollback
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";

const TARGET_SEASON = "2026-summer";
const MIRROR_SEASON = "2026-spring";
const SEED_NOTE = "[QA-SEED] 2026-summer 테스트 시즌 참가 (rollback: scripts/seed-qa-test-users-summer-season.ts --rollback)";

function mirrorStatus(spring: string | undefined): "active" | "rest" | "stopped" {
  if (spring === "rest") return "rest";
  if (spring === "fail" || spring === "stopped") return "stopped";
  return "active"; // success / 없음 / 기타 → active
}

async function summerCounts(testIds: string[]) {
  const { data } = await supabaseAdmin
    .from("user_season_statuses").select("user_id,status,note").eq("season_key", TARGET_SEASON).in("user_id", testIds);
  const rows = (data ?? []) as { user_id: string; status: string; note: string | null }[];
  const seeded = rows.filter((r) => (r.note ?? "").startsWith("[QA-SEED]"));
  const dist: Record<string, number> = {};
  for (const r of rows) dist[r.status] = (dist[r.status] || 0) + 1;
  return { total: rows.length, seeded: seeded.length, dist };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const rollback = process.argv.includes("--rollback");
  const testIds = [...(await fetchTestUserMarkerIds())];
  if (testIds.length === 0) { console.log("❌ test_user_markers 비어있음."); process.exit(2); }
  const testSet = new Set(testIds);
  console.log(`test_user_markers: ${testIds.length}`);

  // ── ROLLBACK ──
  if (rollback) {
    const before = await summerCounts(testIds);
    console.log(`[before] 테스트 유저 ${TARGET_SEASON} 행: ${before.total} (그 중 QA-SEED ${before.seeded})`);
    // 안전: QA-SEED 표식 + 테스트 유저 한정으로만 삭제.
    const { data: del, error } = await supabaseAdmin
      .from("user_season_statuses").delete()
      .eq("season_key", TARGET_SEASON).like("note", "[QA-SEED]%").in("user_id", testIds).select("user_id");
    if (error) { console.log(`❌ rollback 실패: ${error.message}`); process.exit(1); }
    const after = await summerCounts(testIds);
    console.log(`✅ rollback 삭제 ${del?.length ?? 0}행 → 테스트 유저 ${TARGET_SEASON} 행: ${after.total} (QA-SEED ${after.seeded})`);
    process.exit(0);
  }

  // ── SEED (preview/apply) ──
  // 안전 가드: 실유저 혼입 0 검증(대상 전원 test marker).
  const leak = testIds.filter((id) => !testSet.has(id));
  if (leak.length) { console.log("❌ 비-테스트 유저 혼입 감지 — 중단."); process.exit(1); }

  // 이미 summer 행이 있는 유저 제외(idempotent).
  const { data: existRows } = await supabaseAdmin
    .from("user_season_statuses").select("user_id").eq("season_key", TARGET_SEASON).in("user_id", testIds);
  const existSet = new Set(((existRows ?? []) as { user_id: string }[]).map((r) => r.user_id));
  const toSeed = testIds.filter((id) => !existSet.has(id));

  // 각 대상의 spring status 조회(미러).
  const { data: springRows } = await supabaseAdmin
    .from("user_season_statuses").select("user_id,status").eq("season_key", MIRROR_SEASON).in("user_id", toSeed);
  const springByUser = new Map(((springRows ?? []) as { user_id: string; status: string }[]).map((r) => [r.user_id, r.status]));
  const plan = toSeed.map((id) => ({ user_id: id, season_key: TARGET_SEASON, status: mirrorStatus(springByUser.get(id)), note: SEED_NOTE }));
  const planDist: Record<string, number> = {};
  for (const p of plan) planDist[p.status] = (planDist[p.status] || 0) + 1;

  const before = await summerCounts(testIds);
  console.log(`[before] 테스트 유저 ${TARGET_SEASON} 행: ${before.total} (QA-SEED ${before.seeded}) dist=${JSON.stringify(before.dist)}`);
  console.log(`이미 ${TARGET_SEASON} 보유(건너뜀): ${existSet.size} | 신규 시드 대상: ${plan.length} | 시드 분포: ${JSON.stringify(planDist)}`);

  if (!apply) {
    console.log("\n(미리보기 — 적용하려면 --apply)");
    process.exit(0);
  }
  if (plan.length === 0) {
    console.log("✅ 시드 대상 0 (이미 전원 보유) — 변경 없음(idempotent).");
    process.exit(0);
  }
  const { error } = await supabaseAdmin.from("user_season_statuses").insert(plan);
  if (error) { console.log(`❌ insert 실패: ${error.message}`); process.exit(1); }
  const after = await summerCounts(testIds);
  console.log(`✅ 시드 ${plan.length}행 적용 → 테스트 유저 ${TARGET_SEASON} 행: ${after.total} (QA-SEED ${after.seeded}) dist=${JSON.stringify(after.dist)}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
