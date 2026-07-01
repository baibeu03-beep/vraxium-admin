/**
 * QA 기준 활동일(시간여행) — HTTP 검증 (dev server 필요).
 *   고객 weekly-cards 엔드포인트(내부키)로:
 *     - QA OFF: 테스트 유저 mode=test == 실시간(baseline).
 *     - QA ON(미래 시각): 테스트 유저 mode=test 응답이 변한다(현재 시각 전파). 실유저(operating) 불변.
 *     - 실유저 snapshot row 불변(테스트 유저만 재계산). 운영 weeks 불변(시계는 weeks 무접촉).
 *     - OFF 복귀: 테스트 유저 baseline 복귀.
 *
 *   선행: (1) dev server 기동(npm run dev, :3000)  (2) qa_clock_state 마이그레이션 적용.
 *   npx tsx --env-file=.env.local scripts/verify-qa-clock-http.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { writeQaClockState, readQaClockState } from "@/lib/qaClock";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";

const BASE = process.env.ADMIN_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";
const KEY = process.env.INTERNAL_API_KEY ?? "";
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
  if (!ok) failed++;
}
// mode=operating|test 별 weekly-cards 조회(내부키). mode=test → 라우트가 seedQaClock(qa).
async function httpBody(userId: string, mode: "operating" | "test"): Promise<string | null> {
  const q = mode === "test" ? `&mode=test` : "";
  const res = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${userId}${q}`, {
    headers: { "x-internal-api-key": KEY },
    cache: "no-store",
  });
  if (!res.ok) { console.log(`  HTTP ${res.status} for ${userId} mode=${mode}`); return null; }
  return JSON.stringify((await res.json())?.data ?? null);
}
async function snapshotRow(userId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("computed_at,cards")
    .eq("user_id", userId)
    .maybeSingle();
  return data ? JSON.stringify(data) : null;
}

async function main() {
  if (!KEY) { console.log("❌ INTERNAL_API_KEY 미설정."); process.exit(2); }
  {
    const { error } = await supabaseAdmin.from("qa_clock_state").select("id", { head: true });
    if (error) { console.log(`❌ qa_clock_state 미존재(${error.message}). 마이그레이션 수동 적용 요망.`); process.exit(2); }
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
  console.log(`testUser=${testUser} realUser=${realUser}`);

  // 0) QA OFF 상태 확정 + baseline.
  await writeQaClockState({ enabled: false, qaNowMs: null, actor: null });
  const baseTestOp = await httpBody(testUser, "operating");
  const baseTestQa = await httpBody(testUser, "test");
  check("QA OFF: 테스트 유저 operating==test (시계 무영향)", baseTestOp === baseTestQa);
  const baseRealOp = realUser ? await httpBody(realUser, "operating") : null;
  const realSnapBefore = realUser ? await snapshotRow(realUser) : null;

  try {
    // 1) QA ON: 미래(다음 시즌) 시각.
    const futureMs = Date.parse("2026-11-15T12:00:00+09:00"); // 가을/겨울 경계 — 현재와 분명히 다른 시즌
    await writeQaClockState({ enabled: true, qaNowMs: futureMs, actor: null });
    const st = await readQaClockState();
    check("qa_clock_state ON 저장 확인", st?.enabled === true && st?.qaNowMs === futureMs, st);

    const qaTest = await httpBody(testUser, "test");
    check("QA ON: 테스트 유저 mode=test 응답이 baseline 과 다름(시계 전파)", qaTest !== baseTestQa);

    // 2) 실유저(operating)는 QA 시계 영향 없음.
    if (realUser) {
      const realOpAfter = await httpBody(realUser, "operating");
      check("실유저 operating 응답 불변(QA 미노출)", realOpAfter === baseRealOp);
      const realSnapAfter = await snapshotRow(realUser);
      check("실유저 snapshot row 불변(재계산 없음)", realSnapAfter === realSnapBefore);
    }
  } finally {
    // 3) OFF 복귀 + 테스트 유저 baseline 재계산.
    await writeQaClockState({ enabled: false, qaNowMs: null, actor: null });
    await recomputeWeeklyCardsSnapshotsForUsers([testUser], { concurrency: 1 });
  }

  const offTest = await httpBody(testUser, "test");
  check("OFF 복귀: 테스트 유저 mode=test baseline 복귀", offTest === baseTestQa);

  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
