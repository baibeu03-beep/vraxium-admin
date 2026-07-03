/**
 * Action Control — 주차 검수(team-parts) ⚡ 즉시 실행 / ↩ 실행 취소 검증.
 *   대상 페이지: /admin/team-parts/info/weeks/[weekId] 의 기존 [주차 검수] 버튼 옆.
 *   ⚡ = 기존 markTeamPartsWeekReviewed(POST /review·공표+검수+재계산) 재사용.
 *   ↩ = revertTeamPartsWeekReview(DELETE /review) → weekId→season/weekNumber 해석 후
 *       공용 revertWeeklyCardFinalization(rollback 로직) 위임(집계 확정 역연산과 동일).
 *
 *   안전: scope=qa(?mode=test)=qa_weeks_state 오버레이·테스트 코호트만·운영 weeks 무접촉. 보장 복원.
 *   ※ 재계산·status gate·고객카드·demoUserId 등 깊은 로직은 revertWeeklyCardFinalization 을
 *      직접 태우는 verify-action-control-finalization.ts(21 PASS)에서 이미 검증 — 여기선 위임·라우트·
 *      weekId 해석·direct==HTTP 를 확인.
 *
 *   npx tsx --env-file=.env.local scripts/verify-action-control-week-review.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { runWeeklyCardFinalization } from "@/lib/adminWeeklyCardFinalizationData";
import { revertTeamPartsWeekReview } from "@/lib/adminTeamPartsInfoWeekDetailData";

const BASE = process.env.ADMIN_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const s = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SEASON = "2026-summer", WEEK_NO = 1, W1_ID = "496656d0-8d92-4738-b69b-e5e28aa1d57a", ORG = "encre";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
  if (!ok) failed++;
}
async function adminCookieHeader(): Promise<string> {
  const { data: adm } = await supabaseAdmin.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (adm?.[0] as { email: string } | undefined)?.email;
  const A = createClient(u, s), N = createClient(u, a);
  const { data: l } = await A.auth.admin.generateLink({ type: "magiclink", email: email! });
  const { data: v } = await N.auth.verifyOtp({ email: email!, token: (l as any).properties.email_otp, type: "magiclink" });
  const cap: { name: string; value: string }[] = [];
  const sv = createServerClient(u, a, { cookies: { getAll: () => [], setAll: (items) => cap.push(...items.map(({ name, value }: any) => ({ name, value }))) } });
  await sv.auth.setSession({ access_token: (v as any).session.access_token, refresh_token: (v as any).session.refresh_token });
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}
const qaPub = async () => (await supabaseAdmin.from("qa_weeks_state").select("result_published_at").eq("week_id", W1_ID).maybeSingle()).data as any;
const opPub = async () => (await supabaseAdmin.from("weeks").select("result_published_at").eq("id", W1_ID).maybeSingle()).data as any;
const stable = (r: any) => ({ reverted: r?.reverted, publishedAt: r?.publishedAt ?? null });

async function main() {
  try { const h = await fetch(`${BASE}/api/health`); check("dev server 응답", h.ok); }
  catch { console.log(`❌ dev server 미기동(${BASE}).`); process.exit(2); }
  const cookie = await adminCookieHeader();

  const opBefore = (await opPub())?.result_published_at ?? null;
  check("W1 운영 미공표(안전 전제)", opBefore === null);
  const qaOrig = (await qaPub())?.result_published_at ?? null;

  try {
    // ── (A) direct: qa 확정 → revertTeamPartsWeekReview(qa) ──
    await runWeeklyCardFinalization({ seasonKey: SEASON, weekNumber: WEEK_NO, org: null, mode: "finalize", scope: "qa", actor: null });
    check("[전제] qa 확정으로 published 세팅", ((await qaPub())?.result_published_at ?? null) != null);
    const dRev = await revertTeamPartsWeekReview(W1_ID, "qa", null);
    check("[1·direct] revertTeamPartsWeekReview reverted=true·published null", dRev.reverted === true && dRev.publishedAt === null, stable(dRev));
    check("[direct] qa_weeks_state published null 복원", ((await qaPub())?.result_published_at ?? null) === null);
    check("[direct] weekId→season/weekNumber 해석 위임 성공(reverted)", dRev.reverted === true);
    check("운영 weeks 무접촉(direct)", ((await opPub())?.result_published_at ?? null) === null);

    // ── (B) HTTP: qa 확정 → DELETE /review?mode=test ──
    await runWeeklyCardFinalization({ seasonKey: SEASON, weekNumber: WEEK_NO, org: null, mode: "finalize", scope: "qa", actor: null });
    const del = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${W1_ID}/review?club=${ORG}&mode=test`, { method: "DELETE", headers: { cookie } });
    const dj: any = await del.json();
    check("[2·HTTP] DELETE /review 200·success·reverted", del.ok && dj?.success === true && dj?.data?.reverted === true, { status: del.status });
    check("[HTTP] qa_weeks_state published null 복원", ((await qaPub())?.result_published_at ?? null) === null);
    check("운영 weeks 무접촉(HTTP)", ((await opPub())?.result_published_at ?? null) === null);

    // ── (3) direct == HTTP ──
    check("[3] direct == HTTP (revert 안정 필드)", JSON.stringify(stable(dRev)) === JSON.stringify(stable(dj?.data)), { direct: stable(dRev), http: stable(dj?.data) });

    // ── (C) 멱등: 이미 미공표에서 재취소 → reverted=false ──
    const idem = await revertTeamPartsWeekReview(W1_ID, "qa", null);
    check("[멱등] 재취소 no-op(reverted=false)", idem.reverted === false);

    // ── (D) 404 가드: 존재하지 않는 주차 ──
    const nf = await fetch(`${BASE}/api/admin/team-parts/info/weeks/00000000-0000-0000-0000-000000000000/review?club=${ORG}&mode=test`, { method: "DELETE", headers: { cookie } });
    check("[HTTP] 없는 주차 DELETE → 404", nf.status === 404);
  } finally {
    if (qaOrig == null) await supabaseAdmin.from("qa_weeks_state").delete().eq("week_id", W1_ID);
    else await supabaseAdmin.from("qa_weeks_state").update({ result_published_at: qaOrig }).eq("week_id", W1_ID);
    check("보장 복원: 운영 weeks[W1] 시종 무변경", ((await opPub())?.result_published_at ?? null) === opBefore);
    check("보장 복원: qa_weeks_state[W1] 원복", ((await qaPub())?.result_published_at ?? null) === qaOrig);
  }

  console.log(failed === 0 ? "\n✅ ALL PASS (주차 검수 team-parts ⚡/↩ — qa 안전·운영 무접촉·위임 검증)" : `\n❌ ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
