/**
 * 쓰기 경로 통합 검증(자가 정리) — 실무 역량 테스트 모드 13주차 개설.
 *   npx tsx --env-file=.env.local scripts/verify-competency-w13-write-path.ts
 *
 * 시나리오(전부 sentinel line_name 으로 격리 + finally 전수 정리):
 *   A) 혼입 가드 : 테스트+실사용자 승인 신청 → openCompetencyHub(test) → 422, write 0.
 *   B) 정상 개설 : 테스트 사용자 승인 신청만 → open(test) → W13 competency 라인/타깃 생성,
 *                 타깃 week_id=W13 · target_user_id=테스트 사용자 · 혼입 0 → cancel(test) 원복.
 *   C) 운영 차단 : W13 테스트 신청이 pending 인 채 open(operating) → 대상=W15 라 W13 미개설(pending 유지).
 *   D) snapshot : resolveUserScope('test').filter([test, real]) == [test] (무효화 대상 테스트 한정).
 */
import { createClient } from "@supabase/supabase-js";
import {
  openCompetencyHub,
  cancelCompetencyHub,
  getCompetencyOpeningStatus,
} from "@/lib/adminCompetencyLineOpening";
import { resolveUserScope } from "@/lib/userScope";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const ORG = "oranke" as const;
const W13 = "a2112b50-64d2-42d6-a243-faf9fcdc6ffc";
const TEST_USER = "13b8e55e-ff49-43f3-a01f-cb68bfb74581"; // T한지윤 (oranke, test marker)
const REAL_USER = "e2e65fb6-6b56-4ae3-a1d7-16d6e894c308"; // 김이브 (oranke, 실사용자)
const SENTINEL = "[W13-VERIFY-SENTINEL]";

let pass = 0, fail = 0;
const ok = (cond: boolean, label: string) => {
  console.log(`  ${cond ? "✓" : "✗"} ${label} ${cond ? "" : "❌"}`);
  cond ? pass++ : fail++;
};

async function insertApp(userId: string, approval: boolean): Promise<string> {
  const { data, error } = await sb
    .from("cluster4_competency_applications")
    .insert({
      organization_slug: ORG,
      week_id: W13,
      target_user_id: userId,
      competency_line_master_id: null,
      line_name: SENTINEL,
      source: "manual",
      approval_checked: approval,
      resolution: "pending",
    })
    .select("id")
    .single();
  if (error) throw new Error(`insertApp: ${error.message}`);
  return (data as { id: string }).id;
}

// sentinel 로 만든 모든 신청 + 그 신청이 개설한 라인/타깃 전수 정리.
async function cleanup(): Promise<void> {
  const { data: apps } = await sb
    .from("cluster4_competency_applications")
    .select("id,opened_line_id")
    .eq("organization_slug", ORG)
    .eq("week_id", W13)
    .eq("line_name", SENTINEL);
  const lineIds = (apps ?? [])
    .map((a) => (a as { opened_line_id: string | null }).opened_line_id)
    .filter((id): id is string => !!id);
  if (lineIds.length > 0) {
    await sb.from("cluster4_line_targets").delete().in("line_id", lineIds);
    await sb.from("cluster4_lines").delete().in("id", lineIds);
  }
  await sb
    .from("cluster4_competency_applications")
    .delete()
    .eq("organization_slug", ORG)
    .eq("week_id", W13)
    .eq("line_name", SENTINEL);
}

// sentinel 신청 중 개설(opened) 처리된 건수 — 혼입 가드 후 write 0 확인용.
async function w13CompetencyLineCount(): Promise<number> {
  const { count } = await sb
    .from("cluster4_competency_applications")
    .select("id", { count: "exact", head: true })
    .eq("organization_slug", ORG)
    .eq("week_id", W13)
    .eq("line_name", SENTINEL)
    .eq("resolution", "opened");
  return count ?? 0;
}

async function main() {
  const testIds = await fetchTestUserMarkerIds();
  ok(testIds.has(TEST_USER), `픽스처: TEST_USER 가 test_user_markers 등재`);
  ok(!testIds.has(REAL_USER), `픽스처: REAL_USER 는 실사용자`);

  await cleanup(); // 이전 잔여 정리

  try {
    // ── A) 혼입 가드(write 0) ───────────────────────────────────────
    console.log("\n=== A) 혼입 가드: test 모드 + (테스트∪실사용자) 승인 → 422 ===");
    await insertApp(TEST_USER, true);
    await insertApp(REAL_USER, true);
    let threw = 0;
    try {
      await openCompetencyHub({ organization: ORG, adminId: null, mode: "test" });
    } catch (e) {
      threw = (e as { status?: number })?.status ?? -1;
    }
    ok(threw === 422, `open(test) 혼입 → 422 (status=${threw})`);
    const openedAfterGuard = await w13CompetencyLineCount();
    ok(openedAfterGuard === 0, `가드 후 opened 신청 0 (write 0) — 부분 반영 없음`);
    await cleanup();

    // ── B) 정상 개설(test) ──────────────────────────────────────────
    console.log("\n=== B) 정상 개설: test 모드 + 테스트 사용자 승인만 ===");
    const appId = await insertApp(TEST_USER, true);
    const res = await openCompetencyHub({ organization: ORG, adminId: null, mode: "test" });
    ok(res.openedCrews >= 1, `open(test) openedCrews=${res.openedCrews} (≥1)`);

    const { data: appRow } = await sb
      .from("cluster4_competency_applications")
      .select("resolution,opened_line_id")
      .eq("id", appId)
      .maybeSingle();
    const openedLineId = (appRow as { opened_line_id: string | null } | null)?.opened_line_id ?? null;
    ok((appRow as { resolution: string } | null)?.resolution === "opened", `신청 resolution=opened`);
    ok(!!openedLineId, `opened_line_id 설정됨`);

    if (openedLineId) {
      const { data: line } = await sb
        .from("cluster4_lines")
        .select("id,part_type,is_active")
        .eq("id", openedLineId)
        .maybeSingle();
      ok((line as { part_type: string } | null)?.part_type === "competency", `생성 라인 part_type=competency`);
      ok((line as { is_active: boolean } | null)?.is_active === true, `생성 라인 is_active=true`);

      const { data: tgts } = await sb
        .from("cluster4_line_targets")
        .select("week_id,target_user_id")
        .eq("line_id", openedLineId);
      const rows = (tgts ?? []) as Array<{ week_id: string; target_user_id: string }>;
      ok(rows.length >= 1 && rows.every((t) => t.week_id === W13), `타깃 week_id 전부 W13 (n=${rows.length})`);
      ok(rows.every((t) => t.target_user_id === TEST_USER), `타깃 target_user_id = 테스트 사용자만`);
      ok(rows.every((t) => testIds.has(t.target_user_id)), `타깃 전원 test_user_markers (실사용자/타org 혼입 0)`);
    }

    // 원복(cancel) — 라인/타깃 제거 + resolution=pending.
    await cancelCompetencyHub({ organization: ORG, adminId: null, mode: "test" });
    const { data: appAfter } = await sb
      .from("cluster4_competency_applications")
      .select("resolution,opened_line_id")
      .eq("id", appId)
      .maybeSingle();
    ok((appAfter as { resolution: string } | null)?.resolution === "pending", `cancel(test) → resolution=pending 원복`);
    if (openedLineId) {
      const { data: gone } = await sb.from("cluster4_lines").select("id").eq("id", openedLineId).maybeSingle();
      ok(!gone, `cancel(test) → 생성 라인 삭제됨`);
    }
    await cleanup();

    // ── C) 운영 모드 W13 차단 유지 ──────────────────────────────────
    console.log("\n=== C) 운영 모드: open(operating) 대상=W15 라 W13 미개설 ===");
    const stOp = await getCompetencyOpeningStatus(ORG, "operating");
    ok(stOp.targetWeek?.weekNumber === 15, `operating 개설 대상=W15(${stOp.targetWeek?.startDate}) — W13 아님`);
    const appIdC = await insertApp(TEST_USER, true);
    await openCompetencyHub({ organization: ORG, adminId: null, mode: "operating" });
    const { data: appC } = await sb
      .from("cluster4_competency_applications")
      .select("resolution")
      .eq("id", appIdC)
      .maybeSingle();
    ok((appC as { resolution: string } | null)?.resolution === "pending", `operating open → W13 신청 pending 유지(미개설)`);
    await cleanup();

    // ── D) snapshot 무효화 스코프(test 한정) ─────────────────────────
    console.log("\n=== D) snapshot 무효화 대상 테스트 한정 ===");
    const tsScope = await resolveUserScope("test", ORG);
    const filtered = tsScope.filter([TEST_USER, REAL_USER]);
    ok(
      filtered.length === 1 && filtered[0] === TEST_USER,
      `resolveUserScope('test').filter([test,real]) == [test] (실사용자 snapshot 무효화 차단)`,
    );
  } finally {
    await cleanup();
    // 정리 확인.
    const { count } = await sb
      .from("cluster4_competency_applications")
      .select("id", { count: "exact", head: true })
      .eq("line_name", SENTINEL);
    console.log(`\n[정리] 잔여 sentinel 신청 = ${count ?? 0} (0 이어야 함)`);
    ok((count ?? 0) === 0, `테스트 잔여 0 (자가 정리 완료)`);
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => {
  console.error("ERR", e);
  await cleanup();
  process.exit(1);
});
