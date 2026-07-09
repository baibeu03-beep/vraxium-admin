/**
 * auto_publish_hold E2E 검증 (operating scope, W1=마감 지난 주차).
 *   1) weeks / qa_weeks_state 컬럼 존재 확인
 *   2) 실행 취소(revertWeeklyCardFinalization) → hold=now·unpublished
 *   3) dueWeekActionsSweep(onlyIds=W1) → W1 재공표 차단(heldExcluded)
 *   4) 재공표(markWeekResultPublished) → hold=null 해제·republished
 *   finally: 원본 published/reviewed/hold 로 복원(무손상).
 *
 *   npx tsx --env-file=.env.local scripts/verify-auto-publish-hold-e2e.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { runDueWeekActionsSweep } from "@/lib/dueWeekActionsSweep";
import { revertWeeklyCardFinalization } from "@/lib/adminWeeklyCardFinalizationData";
import { markWeekResultPublished } from "@/lib/adminWeekRecognitionsData";

const W1 = process.argv[2] ?? "496656d0-8d92-4738-b69b-e5e28aa1d57a";
const ACTOR = "verify-auto-publish-hold";

type Wk = {
  id: string; season_key: string | null; week_number: number | null;
  start_date: string | null; end_date: string | null;
  result_published_at: string | null; result_reviewed_at: string | null;
  auto_publish_hold_at: string | null;
};

async function getWeek(): Promise<Wk> {
  const { data, error } = await supabaseAdmin
    .from("weeks")
    .select("id,season_key,week_number,start_date,end_date,result_published_at,result_reviewed_at,auto_publish_hold_at")
    .eq("id", W1).maybeSingle();
  if (error) throw new Error(error.message);
  return data as Wk;
}

const PASS = (b: boolean) => (b ? "✅ PASS" : "❌ FAIL");

async function main() {
  console.log("weekId:", W1);

  // ── 1) 컬럼 존재 확인 ──
  console.log("\n=== 1) 마이그레이션 컬럼 확인 ===");
  const c1 = await supabaseAdmin.from("weeks").select("auto_publish_hold_at").limit(1);
  const c2 = await supabaseAdmin.from("qa_weeks_state").select("auto_publish_hold_at").limit(1);
  console.log("  weeks.auto_publish_hold_at         :", c1.error ? "❌ MISSING (" + c1.error.message + ")" : "✅ 존재");
  console.log("  qa_weeks_state.auto_publish_hold_at:", c2.error ? "❌ MISSING (" + c2.error.message + ")" : "✅ 존재");
  if (c1.error || c2.error) { console.log("컬럼 미적용 — 중단"); process.exit(1); }

  const orig = await getWeek();
  console.log("\n[원본 상태] published:", orig.result_published_at, "| reviewed:", orig.result_reviewed_at, "| hold:", orig.auto_publish_hold_at);

  const results: Record<string, boolean> = {};
  try {
    // ── 2) 실행 취소 ──
    console.log("\n=== 2) 실행 취소 (revertWeeklyCardFinalization, operating) ===");
    await revertWeeklyCardFinalization({ seasonKey: orig.season_key!, weekNumber: orig.week_number!, org: null, scope: "operating", actor: ACTOR });
    const a = await getWeek();
    console.log("  → published:", a.result_published_at, "| hold:", a.auto_publish_hold_at);
    results["hold_set_on_revert"] = a.auto_publish_hold_at != null;
    results["unpublished_on_revert"] = a.result_published_at == null;
    console.log("  hold 세팅:", PASS(results["hold_set_on_revert"]), "| 미공표 복귀:", PASS(results["unpublished_on_revert"]));

    // ── 3) sweep — 재공표 차단 ──
    console.log("\n=== 3) dueWeekActionsSweep(onlyIds=W1, 실제 실행) — 자동 재공표 차단 확인 ===");
    const sweep = await runDueWeekActionsSweep({ onlyIds: [W1], dryRun: false, log: (m) => console.log("  [sweep]", m), actor: ACTOR });
    const b = await getWeek();
    const heldW1 = sweep.items.filter((i) => i.error === "manual_revert_hold" && i.weekId === W1).length;
    console.log("  publish.due:", sweep.publish.due, "| publish.done:", sweep.publish.done, "| heldExcluded(W1):", heldW1);
    results["sweep_did_not_republish"] = b.result_published_at == null;
    results["sweep_marked_held"] = heldW1 > 0;
    console.log("  sweep 후 여전히 미공표:", PASS(results["sweep_did_not_republish"]), "| heldExcluded 기록:", PASS(results["sweep_marked_held"]));

    // ── 4) 재검수(재공표) — hold 해제 ──
    console.log("\n=== 4) 재공표 (markWeekResultPublished, operating) — hold 해제 확인 ===");
    await markWeekResultPublished(W1, "operating", ACTOR);
    const d = await getWeek();
    console.log("  → published:", d.result_published_at, "| hold:", d.auto_publish_hold_at);
    results["hold_cleared_on_republish"] = d.auto_publish_hold_at == null;
    results["republished"] = d.result_published_at != null;
    console.log("  hold 해제:", PASS(results["hold_cleared_on_republish"]), "| 재공표됨:", PASS(results["republished"]));
  } finally {
    // ── 복원 ──
    await supabaseAdmin.from("weeks").update({
      result_published_at: orig.result_published_at,
      result_reviewed_at: orig.result_reviewed_at,
      auto_publish_hold_at: orig.auto_publish_hold_at,
    }).eq("id", W1);
    const r = await getWeek();
    console.log("\n[복원 상태] published:", r.result_published_at, "| reviewed:", r.result_reviewed_at, "| hold:", r.auto_publish_hold_at);
  }

  console.log("\n=== 종합 ===");
  const all = Object.entries(results);
  for (const [k, v] of all) console.log(" ", PASS(v), k);
  const ok = all.every(([, v]) => v);
  console.log(ok ? "\n🎉 전체 통과" : "\n⚠ 실패 항목 있음");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
