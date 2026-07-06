// QA-OPERATING-VERIFY 잔재 라인 정리 — 2026-07-01 QA 검증 스크립트가 남긴 stray operating 라인 삭제.
//   대상: cluster4_lines line_code LIKE '%QAOP%' 또는 main_title LIKE 'QA-OPERATING-VERIFY%'
//     (EX-QAOP-77835377 experience·CP-QAOP-77835377 competency — team_id=null·is_qa_test=false·
//      example.com 링크·제출/평가 0). 팀 없는 라인이 [실무 경험] 팀 스코프 판정에서 잡음이 되어
//      실사용자 카드에 노출됐던 원인(로직은 v33 fail-closed 로 이미 무해화, 여기선 데이터 자체 제거).
//
//   안전: dry-run 기본. --apply 로만 삭제. 삭제 전 lines+targets 전체를 rollback JSON 으로 보존.
//         targets 명시 삭제 후 lines 삭제(FK cascade 의존 안 함). 삭제 후 대상자 snapshot 재계산.
//
//   실행: npx tsx --env-file=.env.local scripts/cleanup-qaop-verify-artifacts.ts [--apply]

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const APPLY = process.argv.includes("--apply");

async function main() {
  // 1. 대상 라인 수집(코드 OR 타이틀).
  const [{ data: byCode }, { data: byTitle }] = await Promise.all([
    supabaseAdmin.from("cluster4_lines").select("*").ilike("line_code", "%QAOP%"),
    supabaseAdmin.from("cluster4_lines").select("*").ilike("main_title", "QA-OPERATING-VERIFY%"),
  ]);
  const lineMap = new Map<string, any>();
  for (const r of [...(byCode ?? []), ...(byTitle ?? [])] as any[]) lineMap.set(r.id, r);
  const lines = [...lineMap.values()];
  const lineIds = lines.map((l) => l.id);
  console.log(`대상 QAOP 라인: ${lines.length}개`);
  for (const l of lines) console.log(`  ${l.line_code} | ${l.part_type} | team=${l.team_id} | qa=${l.is_qa_test} | ${l.main_title}`);
  if (lineIds.length === 0) { console.log("삭제 대상 없음 — 종료"); return; }

  // 2. 의존 targets 수집(rollback 보존 + 재계산 대상자).
  const { data: targets } = await supabaseAdmin
    .from("cluster4_line_targets").select("*").in("line_id", lineIds);
  const targetRows = (targets ?? []) as any[];
  const affectedUsers = [...new Set(targetRows.map((t) => t.target_user_id).filter(Boolean))];
  console.log(`의존 targets: ${targetRows.length} · 재계산 대상자: ${affectedUsers.length}명`);

  // 3. 안전 가드 — 제출/평가가 있으면(운영 실데이터 가능성) 중단.
  const tids = targetRows.map((t) => t.id);
  if (tids.length) {
    const [{ count: subCount }, { count: evCount }, { count: cevCount }] = await Promise.all([
      supabaseAdmin.from("cluster4_line_submissions").select("id", { count: "exact", head: true }).in("line_target_id", tids),
      supabaseAdmin.from("cluster4_experience_line_evaluations").select("id", { count: "exact", head: true }).in("line_target_id", tids),
      supabaseAdmin.from("cluster4_competency_line_evaluations").select("id", { count: "exact", head: true }).in("line_target_id", tids),
    ]);
    if ((subCount ?? 0) + (evCount ?? 0) + (cevCount ?? 0) > 0) {
      console.error(`거부: 제출/평가 존재(sub=${subCount} exp=${evCount} comp=${cevCount}) — 운영 실데이터 가능성. 수동 확인 필요.`);
      process.exit(2);
    }
  }

  // 4. rollback 로그 보존(삭제 전 전체 행).
  const stamp = "20260706";
  const logPath = resolve(process.cwd(), "claudedocs", `cleanup-qaop-verify-artifacts-${stamp}.json`);
  writeFileSync(logPath, JSON.stringify({ deletedAt_note: "run-time", lines, targets: targetRows, affectedUsers }, null, 2));
  console.log(`rollback 로그: ${logPath}`);

  if (!APPLY) {
    console.log("\n[dry-run] --apply 미지정 → 삭제하지 않음. 위 대상 확인 후 --apply 로 실행.");
    return;
  }

  // 5. 삭제 — targets 먼저(명시), 그다음 lines.
  if (tids.length) {
    const { error: tErr } = await supabaseAdmin.from("cluster4_line_targets").delete().in("id", tids);
    if (tErr) throw new Error(`targets 삭제 실패: ${tErr.message}`);
    console.log(`targets 삭제: ${tids.length}`);
  }
  const { error: lErr } = await supabaseAdmin.from("cluster4_lines").delete().in("id", lineIds);
  if (lErr) throw new Error(`lines 삭제 실패: ${lErr.message}`);
  console.log(`lines 삭제: ${lineIds.length}`);

  // 6. 대상자 snapshot 재계산(라인 제거 반영).
  for (const uid of affectedUsers) {
    await recomputeAndStoreWeeklyCardsSnapshot(uid);
    console.log(`snapshot 재계산: ${uid}`);
  }

  // 7. 검증 — 라인 잔존 0.
  const { data: remain } = await supabaseAdmin.from("cluster4_lines").select("id").in("id", lineIds);
  console.log(`\n검증: 라인 잔존 ${(remain ?? []).length}개 (0이어야 함)`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
