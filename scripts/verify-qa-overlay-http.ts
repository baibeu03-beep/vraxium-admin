/**
 * QA 오버레이 Phase A HTTP 검증 (dev server 필요).
 *   - 내부키(x-internal-api-key)로 고객 weekly-cards 엔드포인트 조회.
 *   - direct(snapshot) == HTTP(cards) 동치 확인.
 *   - QA check_threshold flip(테스트 유저 성공 주차 → 실패)이 테스트 유저 HTTP 응답에는 반영되고
 *     실유저 HTTP 응답에는 반영되지 않으며, OFF 시 복귀하는지 확인.
 *
 *   선행: (1) dev server 기동(npm run dev, :3000)  (2) qa_* 마이그레이션 적용.
 *   npx tsx --env-file=.env.local scripts/verify-qa-overlay-http.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { updateWeekCheckThreshold } from "@/lib/adminWeekRecognitionsData";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";

const BASE = process.env.ADMIN_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";
const KEY = process.env.INTERNAL_API_KEY ?? "";
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
  if (!ok) failed++;
}
async function httpCards(userId: string): Promise<any[] | null> {
  const res = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${userId}`, { headers: { "x-internal-api-key": KEY } });
  if (!res.ok) { console.log(`  HTTP ${res.status} for ${userId}`); return null; }
  const json: any = await res.json();
  // 엔벨로프: { success, data: Cluster4WeeklyCardDto[], ... } — data 가 곧 카드 배열.
  if (Array.isArray(json?.data)) return json.data as any[];
  return (json?.cards ?? json?.data?.cards ?? null) as any[] | null;
}
async function directCards(userId: string): Promise<any[] | null> {
  const { data } = await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("cards").eq("user_id", userId).maybeSingle();
  return ((data as { cards: any[] } | null)?.cards ?? null) as any[] | null;
}
async function recompute(u: string) { await recomputeWeeklyCardsSnapshotsForUsers([u], { concurrency: 1 }); }

async function main() {
  if (!KEY) { console.log("❌ INTERNAL_API_KEY 미설정."); process.exit(2); }
  {
    const { error } = await supabaseAdmin.from("qa_weeks_state").select("week_id", { head: true });
    if (error) { console.log(`❌ qa_weeks_state 미존재(${error.message}).`); process.exit(2); }
  }
  try {
    const h = await fetch(`${BASE}/api/health`);
    check("dev server 응답", h.ok, { base: BASE });
  } catch { console.log(`❌ dev server 미기동(${BASE}). npm run dev 후 재실행.`); process.exit(2); }

  const testIds = await fetchTestUserMarkerIds();
  const testUser = [...testIds][0];
  const { data: realRows } = await supabaseAdmin
    .from("user_week_statuses").select("user_id").not("user_id", "in", `(${[...testIds].join(",")})`).limit(1);
  const realUser = (realRows?.[0] as { user_id: string } | undefined)?.user_id ?? null;

  // 1) HTTP 조회로 snapshot 수렴 후 direct == HTTP.
  const httpT1 = await httpCards(testUser);
  const dirT1 = await directCards(testUser);
  check("direct(snapshot) == HTTP(cards) [테스트 유저]", JSON.stringify(httpT1) === JSON.stringify(dirT1), { httpLen: httpT1?.length, dirLen: dirT1?.length });
  if (realUser) {
    const httpR1 = await httpCards(realUser);
    const dirR1 = await directCards(realUser);
    check("direct(snapshot) == HTTP(cards) [실유저]", JSON.stringify(httpR1) === JSON.stringify(dirR1), { httpLen: httpR1?.length, dirLen: dirR1?.length });
  }

  // 2) QA check_threshold flip → 테스트 유저 HTTP 카드 변화 / 실유저 HTTP 불변.
  const succ = (dirT1 ?? []).find((c) => c?.userWeekStatus === "success" && c?.experienceGrowth?.checkGate?.enforced === true && c?.experienceGrowth?.checkGate?.passed === true);
  if (!succ) { console.log("⚠ 체크강제 성공 주차 미발견 — flip HTTP 검증 생략."); }
  else {
    const wId = succ.weekId; const earned = succ.experienceGrowth.checkGate.earned as number;
    console.log(`   flip target week=${succ.startDate} id=${wId} earned=${earned}`);
    const { data: wkBeforeRow } = await supabaseAdmin.from("weeks").select("check_threshold").eq("id", wId).maybeSingle();
    const opThresholdBefore = (wkBeforeRow as any)?.check_threshold ?? null;
    const realBefore = realUser ? JSON.stringify(await httpCards(realUser)) : "";
    try {
      await updateWeekCheckThreshold(wId, { check_threshold: earned + 50 }, "qa", null);
      await recompute(testUser);
      const httpT2 = await httpCards(testUser);
      const flipped = httpT2?.find((c) => c.weekId === wId);
      check("QA flip 후 테스트 유저 HTTP 카드 성공→실패", flipped?.userWeekStatus === "fail", { status: flipped?.userWeekStatus });
      check("QA flip 후 테스트 유저 HTTP 응답 변화", JSON.stringify(httpT2) !== JSON.stringify(httpT1));
      if (realUser) {
        const httpR2 = await httpCards(realUser);
        check("실유저 HTTP 카드 불변(QA 미노출)", JSON.stringify(httpR2) === realBefore);
        check("실유저 direct == HTTP 유지", JSON.stringify(httpR2) === JSON.stringify(await directCards(realUser)));
      }
      // 운영 weeks 불변(QA write 가 운영 컬럼을 건드리지 않음).
      const { data: wk } = await supabaseAdmin.from("weeks").select("check_threshold").eq("id", wId).maybeSingle();
      check("운영 weeks.check_threshold 불변", ((wk as any)?.check_threshold ?? null) === opThresholdBefore, { before: opThresholdBefore, after: (wk as any)?.check_threshold ?? null });
    } finally {
      await supabaseAdmin.from("qa_weeks_state").delete().eq("week_id", wId);
      await supabaseAdmin.from("qa_action_log").delete().eq("week_id", wId);
      await recompute(testUser);
    }
    // 3) OFF 복귀.
    const httpT3 = await httpCards(testUser);
    check("OFF 후 테스트 유저 HTTP 카드 baseline 복귀(== before)", JSON.stringify(httpT3) === JSON.stringify(httpT1));
  }

  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
