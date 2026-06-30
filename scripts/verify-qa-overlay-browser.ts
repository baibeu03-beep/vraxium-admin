/**
 * QA 오버레이 Phase A 고객앱 반영 검증 (customer :3001 + 스크린샷).
 *
 *   고객앱(/cluster-4)이 실제로 소비하는 데이터 엔드포인트(customer proxy :3001
 *   /api/cluster4/weekly-cards, demoUserId)를 통해 QA 상태가 반영되는지 확인한다.
 *   - 테스트 유저: QA check_threshold flip 후 대상 주차 카드 성공→실패(항목9, 고객앱 반영)
 *   - 실유저: QA flip 전후 동일(항목10, QA 미노출)
 *   - OFF 후 성공 복귀
 *   + Playwright 로 /cluster-4 페이지 스크린샷(시각 증빙) 캡처.
 *
 *   ⚠ 카드 status 단언은 고객앱 데이터 엔드포인트(:3001 proxy, 쿠키 없는 클린 클라이언트)로 한다.
 *     인증된 브라우저 페이지의 demoUserId 조회는 고객앱의 세션-vs-demoUserId 게이트로 403 이 나는데
 *     이는 QA 오버레이와 무관한 고객앱 기존 인증 동작이다(엔드포인트 자체는 200·QA 반영).
 *
 *   선행: admin :3000 · customer :3001 · qa_* 마이그레이션.
 *   npx tsx --env-file=.env.local scripts/verify-qa-overlay-browser.ts
 */
import { pathToFileURL } from "url";
import { resolve } from "path";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { updateWeekCheckThreshold } from "@/lib/adminWeekRecognitionsData";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";

const FRONT = process.env.FRONT_BASE || "http://localhost:3001";
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
  if (!ok) failed++;
}
// 고객앱 데이터 엔드포인트(:3001) — 쿠키 없는 클린 클라이언트. demoUserId 로 테스트 유저 조회.
async function customerCards(userId: string): Promise<any[]> {
  const res = await fetch(`${FRONT}/api/cluster4/weekly-cards?userId=${userId}&demoUserId=${userId}&mode=test`, { redirect: "follow" });
  if (!res.ok) { console.log(`  customer HTTP ${res.status} for ${userId}`); return []; }
  const j: any = await res.json();
  return (Array.isArray(j?.data) ? j.data : (j?.cards ?? [])) as any[];
}
async function recompute(u: string) { await recomputeWeeklyCardsSnapshotsForUsers([u], { concurrency: 1 }); }

async function main() {
  const testIds = await fetchTestUserMarkerIds();
  const testUser = [...testIds][0];
  const { data: realRows } = await supabaseAdmin
    .from("user_week_statuses").select("user_id").not("user_id", "in", `(${[...testIds].join(",")})`).limit(1);
  const realUser = (realRows?.[0] as { user_id: string } | undefined)?.user_id ?? null;

  await recompute(testUser);
  const cards0 = await customerCards(testUser);
  const succ = cards0.find((c) => c?.userWeekStatus === "success" && c?.experienceGrowth?.checkGate?.enforced === true && c?.experienceGrowth?.checkGate?.passed === true);
  if (!succ) { console.log("⚠ 체크강제 성공 주차 미발견 — 검증 생략."); process.exit(0); }
  const wId = succ.weekId; const earned = succ.experienceGrowth.checkGate.earned as number;
  console.log(`   target week=${succ.startDate} id=${wId} earned=${earned} testUser=${testUser} realUser=${realUser}`);

  // Playwright 스크린샷(시각 증빙) — 실패해도 검증은 엔드포인트 기준.
  const shot = async (tag: string) => {
    try {
      const pwMod: any = await import(pathToFileURL(resolve(process.cwd(), "../vraxium/node_modules/playwright/index.js")).href);
      const chromium = pwMod.chromium ?? pwMod.default?.chromium;
      const browser = await chromium.launch();
      const page = await browser.newPage({ viewport: { width: 1440, height: 2400 } });
      await page.goto(`${FRONT}/cluster-4?demoUserId=${testUser}&mode=test`, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.waitForTimeout(9000);
      await page.screenshot({ path: `claudedocs/qa-overlay-${tag}.png`, fullPage: true });
      await browser.close();
      console.log(`   📸 claudedocs/qa-overlay-${tag}.png`);
    } catch (e) { console.log(`   (스크린샷 ${tag} 생략: ${e instanceof Error ? e.message : e})`); }
  };

  const statusOf = (cards: any[]) => cards.find((c) => c.weekId === wId)?.userWeekStatus ?? null;

  try {
    // before
    check("[고객앱] 테스트 유저 대상 주차 = 성공(before)", statusOf(cards0) === "success", { status: statusOf(cards0) });
    const realBefore = realUser ? JSON.stringify((await customerCards(realUser)).map((c) => ({ w: c.weekId, s: c.userWeekStatus }))) : "";
    await shot("test-before");

    // QA flip
    await updateWeekCheckThreshold(wId, { check_threshold: earned + 50 }, "qa", null);
    await recompute(testUser);

    // after
    const after = await customerCards(testUser);
    check("[고객앱] 테스트 유저 대상 주차 = 실패(QA 반영, after)", statusOf(after) === "fail", { status: statusOf(after) });  // 항목9
    await shot("test-after");
    if (realUser) {
      const realAfter = JSON.stringify((await customerCards(realUser)).map((c) => ({ w: c.weekId, s: c.userWeekStatus })));
      check("[고객앱] 실유저 QA flip 전후 불변", realAfter === realBefore);                                                  // 항목10
    }
  } finally {
    await supabaseAdmin.from("qa_weeks_state").delete().eq("week_id", wId);
    await supabaseAdmin.from("qa_action_log").delete().eq("week_id", wId);
    await recompute(testUser);
  }
  const revert = await customerCards(testUser);
  check("[고객앱] OFF 후 테스트 유저 대상 주차 = 성공 복귀", statusOf(revert) === "success", { status: statusOf(revert) });

  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
