/**
 * QA 종료 정리 — is_qa_test=true 라인 숨김/삭제.
 *
 *   dry-run(기본):  npx tsx --env-file=.env.local scripts/qa-end-hide-qa-lines.ts
 *   소프트 숨김:     npx tsx --env-file=.env.local scripts/qa-end-hide-qa-lines.ts --apply
 *   하드 삭제:       npx tsx --env-file=.env.local scripts/qa-end-hide-qa-lines.ts --apply --purge
 *
 * 정책:
 *   - 대상 = cluster4_lines WHERE is_qa_test = true (생성 시 QA_HIDE_REAL_USERS 각인분).
 *   - 소프트 숨김(기본 --apply): is_active=false 로 내린다(가역·멱등). 모든 read 경로가 is_active 필터를
 *     공유하므로 카드/성장/스냅샷에서 즉시 사라진다. 되돌리려면 is_active=true 로 복구.
 *   - 하드 삭제(--purge): DELETE. cluster4_line_targets(ON DELETE CASCADE)·submissions 도 함께 삭제. 비가역.
 *   - dry-run(플래그 없음): 아무것도 바꾸지 않고 part_type별 라인/타깃/제출 카운트만 출력.
 *
 * ⚠ 마이그레이션(2026-07-06_cluster4_lines_is_qa_test) 이전에 생성된 QA 라인은 is_qa_test=false 라
 *   이 스크립트가 잡지 못한다. 그런 잔여가 있으면 line_code/created_at 로 수동 식별해 처리할 것.
 * ⚠ 종료 절차: (1) 이 스크립트 --apply → (2) lib/qaFixedScope.ts QA_HIDE_REAL_USERS=false 배포.
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(url, key);

const APPLY = process.argv.includes("--apply");
const PURGE = process.argv.includes("--purge");

async function fetchQaLines() {
  const rows: { id: string; part_type: string; is_active: boolean; line_code: string | null }[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from("cluster4_lines")
      .select("id, part_type, is_active, line_code")
      .eq("is_qa_test", true)
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    const batch = data ?? [];
    rows.push(...(batch as any));
    if (batch.length < 1000) break;
    from += 1000;
  }
  return rows;
}

async function countCascade(lineIds: string[]) {
  // 페이징 없이 count-only 헤드 요청(대상 라인 id in-filter).
  const chunk = 100;
  let targets = 0;
  let submissionsTargetIds = new Set<string>();
  for (let i = 0; i < lineIds.length; i += chunk) {
    const ids = lineIds.slice(i, i + chunk);
    const { data, error } = await sb
      .from("cluster4_line_targets")
      .select("id, line_id")
      .in("line_id", ids);
    if (error) throw new Error(error.message);
    for (const t of data ?? []) {
      targets++;
      submissionsTargetIds.add((t as any).id);
    }
  }
  // 제출 카운트(타깃 기준).
  let submissions = 0;
  const tIds = [...submissionsTargetIds];
  for (let i = 0; i < tIds.length; i += chunk) {
    const ids = tIds.slice(i, i + chunk);
    const { count, error } = await sb
      .from("cluster4_line_submissions")
      .select("id", { count: "exact", head: true })
      .in("line_target_id", ids);
    if (error) throw new Error(error.message);
    submissions += count ?? 0;
  }
  return { targets, submissions };
}

async function main() {
  const lines = await fetchQaLines();
  const byPart: Record<string, { total: number; active: number }> = {};
  for (const l of lines) {
    const b = (byPart[l.part_type] ??= { total: 0, active: 0 });
    b.total++;
    if (l.is_active) b.active++;
  }
  const ids = lines.map((l) => l.id);
  const cascade = ids.length ? await countCascade(ids) : { targets: 0, submissions: 0 };

  console.log("==== QA 라인(is_qa_test=true) 정리 ====");
  console.log(`mode: ${PURGE ? "PURGE(삭제)" : APPLY ? "SOFT-HIDE(is_active=false)" : "DRY-RUN"}`);
  console.log(`대상 라인: ${lines.length} (활성 ${lines.filter((l) => l.is_active).length})`);
  console.log(`part_type별:`, JSON.stringify(byPart));
  console.log(`cascade: targets=${cascade.targets} submissions=${cascade.submissions}`);

  if (!APPLY) {
    console.log("\n(dry-run — 변경 없음. 적용하려면 --apply, 삭제하려면 --apply --purge)");
    return;
  }
  if (ids.length === 0) {
    console.log("\n대상 없음 — 종료.");
    return;
  }

  if (PURGE) {
    // CASCADE 로 targets/submissions 함께 삭제.
    const chunk = 100;
    let deleted = 0;
    for (let i = 0; i < ids.length; i += chunk) {
      const batch = ids.slice(i, i + chunk);
      const { error } = await sb.from("cluster4_lines").delete().in("id", batch);
      if (error) throw new Error(error.message);
      deleted += batch.length;
    }
    console.log(`\nPURGED ${deleted} lines (targets/submissions cascade).`);
  } else {
    // 소프트 숨김 — 활성 라인만 is_active=false.
    const chunk = 100;
    let hidden = 0;
    const activeIds = lines.filter((l) => l.is_active).map((l) => l.id);
    for (let i = 0; i < activeIds.length; i += chunk) {
      const batch = activeIds.slice(i, i + chunk);
      const { error } = await sb
        .from("cluster4_lines")
        .update({ is_active: false })
        .in("id", batch);
      if (error) throw new Error(error.message);
      hidden += batch.length;
    }
    console.log(`\nHIDDEN ${hidden} lines (is_active=false, 가역).`);
  }
  console.log("다음: lib/qaFixedScope.ts QA_HIDE_REAL_USERS=false 배포로 모집단 복귀.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
