/**
 * Phase 2 검증 — is_qa_test 라인 분리(운영 조회 제외 / QA 조회 노출).
 *
 *   (마이그레이션 2026-07-06_cluster4_lines_is_qa_test 적용 후)
 *   npx tsx --env-file=.env.local scripts/verify-qa-line-visibility.ts
 *
 * 임시 라인 2개(QA=is_qa_test true, 운영=false)를 한 테스트 유저·한 주차에 심고,
 * 라인 렌더 helper 가 쓰는 것과 "동일한" 쿼리를 재현해 필터 동작을 검증한 뒤 정리한다.
 *   - 운영 쿼리(is_active AND is_qa_test=false): QA 라인 제외, 운영 라인 포함.
 *   - QA 쿼리(is_active only):                 두 라인 모두 포함.
 * 실데이터 무변경(임시 라인만 생성 후 삭제·CASCADE).
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(url, key);

const TAG = "QAVIS-" + "TESTLINE";
const PAST = "2020-01-01T00:00:00Z";

const TARGET_WITH_LINE = `
  id, line_id, week_id, target_mode, target_user_id,
  cluster4_lines!inner(id, part_type, is_active)
`;

async function main() {
  // 0. 컬럼 존재 확인.
  {
    const { error } = await sb.from("cluster4_lines").select("id,is_qa_test").limit(1);
    if (error) {
      console.error("✗ is_qa_test 컬럼 없음 — 마이그레이션(2026-07-06_cluster4_lines_is_qa_test) 먼저 적용:", error.message);
      process.exit(2);
    }
  }

  // 1. 테스트 유저 1명 + 주차 1개 확보.
  const { data: markers } = await sb.from("test_user_markers").select("user_id").limit(1);
  const testUser = markers?.[0]?.user_id as string | undefined;
  const { data: weeks } = await sb.from("weeks").select("id").order("start_date", { ascending: false }).limit(1);
  const weekId = weeks?.[0]?.id as string | undefined;
  if (!testUser || !weekId) {
    console.error("✗ 테스트 유저/주차 확보 실패", { testUser, weekId });
    process.exit(1);
  }
  console.log("fixture:", { testUser, weekId });

  const created: string[] = [];
  async function makeLine(isQa: boolean, label: string): Promise<string> {
    const { data, error } = await sb
      .from("cluster4_lines")
      .insert({
        part_type: "info",
        main_title: `${TAG} ${label}`,
        line_code: `IFOK-${TAG}${isQa ? "Q" : "O"}`,
        week_id: weekId,
        submission_opens_at: PAST,
        submission_closes_at: PAST,
        is_active: true,
        is_qa_test: isQa,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`makeLine ${label}: ${error?.message}`);
    created.push(data.id);
    // 타깃(테스트 유저) 1건.
    const { error: tErr } = await sb.from("cluster4_line_targets").insert({
      line_id: data.id, week_id: weekId, target_mode: "user", target_user_id: testUser,
    });
    if (tErr) throw new Error(`target ${label}: ${tErr.message}`);
    return data.id;
  }

  let ok = true;
  try {
    const qaLineId = await makeLine(true, "qa");
    const opLineId = await makeLine(false, "operating");

    // 운영 쿼리(is_qa_test=false 필터) — 라인 렌더 helper 의 operating 분기와 동일.
    const { data: opRows, error: opErr } = await sb
      .from("cluster4_line_targets")
      .select(TARGET_WITH_LINE)
      .eq("week_id", weekId)
      .eq("cluster4_lines.is_active", true)
      .eq("cluster4_lines.is_qa_test", false)
      .eq("target_user_id", testUser);
    if (opErr) throw new Error("operating query: " + opErr.message);
    const opLineIds = new Set((opRows ?? []).map((r: any) => r.line_id));

    // QA 쿼리(필터 없음) — QA 분기.
    const { data: qaRows, error: qaErr } = await sb
      .from("cluster4_line_targets")
      .select(TARGET_WITH_LINE)
      .eq("week_id", weekId)
      .eq("cluster4_lines.is_active", true)
      .eq("target_user_id", testUser);
    if (qaErr) throw new Error("qa query: " + qaErr.message);
    const qaLineIds = new Set((qaRows ?? []).map((r: any) => r.line_id));

    const checks = [
      ["운영 조회: QA 라인 제외", !opLineIds.has(qaLineId)],
      ["운영 조회: 운영 라인 포함", opLineIds.has(opLineId)],
      ["QA 조회: QA 라인 포함", qaLineIds.has(qaLineId)],
      ["QA 조회: 운영 라인 포함", qaLineIds.has(opLineId)],
    ] as const;
    for (const [label, pass] of checks) {
      console.log(`${pass ? "✓" : "✗"} ${label}`);
      if (!pass) ok = false;
    }
  } finally {
    // 정리(CASCADE 로 target 함께 삭제).
    if (created.length) {
      const { error } = await sb.from("cluster4_lines").delete().in("id", created);
      console.log(error ? `cleanup 실패: ${error.message}` : `cleanup: ${created.length} temp lines 삭제`);
    }
  }

  console.log(ok ? "\nPHASE2 VERIFY: PASS" : "\nPHASE2 VERIFY: FAIL");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
