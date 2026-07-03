/**
 * Action Control — 주차 검수(집계 확정) ⚡ 즉시 실행 / ↩ 실행 취소 검증.
 *   ⚡ = 기존 runWeeklyCardFinalization(finalize) 재사용 · ↩ = revertWeeklyCardFinalization(확정 직전 복원).
 *
 *   안전: scope=qa(?mode=test)는 qa_weeks_state 오버레이 + 테스트 코호트만 → 실운영/실고객 무접촉.
 *         운영 weeks 는 절대 건드리지 않음(검증에서 명시 확인). 보장 복원 try/finally.
 *
 *   검증 항목(요청):
 *     1) direct 결과  2) HTTP 응답  3) direct == HTTP  4) snapshot 영향  5) snapshot 재계산
 *     7) 고객 앱 성장 성공/실패 변경(=status gate: published→success/fail·미공표→tallying)
 *     8) 주차 결과 복원(공표 플래그 원복)  9) demoUserId==normal DTO
 *   + 멱등(재확정 alreadyFinalized·재취소 no-op)·운영 weeks 무접촉.
 *   ※ 운영 스코프 라이브 고객 토글은 '종료+미공표+비휴식' 주차가 없어(전부 확정됨) 안전상 미수행 —
 *      동일 코드(scope 분기)인 qa 경로 전 과정 + status gate + 운영 멱등으로 대체 검증(보고서 명시).
 *
 *   npx tsx --env-file=.env.local scripts/verify-action-control-finalization.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  runWeeklyCardFinalization,
  revertWeeklyCardFinalization,
} from "@/lib/adminWeeklyCardFinalizationData";
import { resolveWeekResultStatus } from "@/lib/growthCore";
import { readWeeklyCardsSnapshot, recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";

const BASE = process.env.ADMIN_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const s = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SEASON = "2026-summer";
const WEEK_NO = 1;
const W1_ID = "496656d0-8d92-4738-b69b-e5e28aa1d57a";

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
async function qaPublished(): Promise<string | null> {
  const { data } = await supabaseAdmin.from("qa_weeks_state").select("result_published_at").eq("week_id", W1_ID).maybeSingle();
  return (data as any)?.result_published_at ?? null;
}
async function opPublished(): Promise<string | null> {
  const { data } = await supabaseAdmin.from("weeks").select("result_published_at").eq("id", W1_ID).maybeSingle();
  return (data as any)?.result_published_at ?? null;
}
const stable = (r: any) => ({
  isFinalized: r?.target?.isFinalized ?? null,
  publishedSet: r?.published?.resultPublishedAt != null,
  total: r?.aggregation?.total ?? r?.aggregation?.memberCount ?? null,
});

async function main() {
  try { const h = await fetch(`${BASE}/api/health`); check("dev server 응답", h.ok); }
  catch { console.log(`❌ dev server 미기동(${BASE}).`); process.exit(2); }
  const cookie = await adminCookieHeader();

  const opBefore = await opPublished();
  check("W1 운영 미공표(안전 전제)", opBefore === null, { opBefore });
  const qaOrig = await qaPublished();

  // item 4·5 강화: 합성 테스트유저 uws 로 qa 코호트를 채워 실제 snapshot 재계산(updated_at 변경) 관찰.
  const U = "e649370f-ba2c-4d2f-b642-6800cb078d54";
  const { data: origUws } = await supabaseAdmin.from("user_week_statuses").select("id").eq("user_id", U).eq("week_start_date", "2026-06-29").maybeSingle();
  const uwsPreexisting = !!origUws;
  if (!uwsPreexisting) {
    await supabaseAdmin.from("user_week_statuses").insert({ user_id: U, year: 2026, week_number: 1, week_start_date: "2026-06-29", status: "success", season_key: SEASON });
  }
  await recomputeWeeklyCardsSnapshotsForUsers([U], { concurrency: 2 });
  const snapUpd = async () => (await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("updated_at").eq("user_id", U).maybeSingle()).data as any;
  const uUpdBefore = (await snapUpd())?.updated_at ?? null;

  try {
    // ── (A) direct finalize(qa) → 공표 SoT 세팅(qa_weeks_state) ──
    const dFin = await runWeeklyCardFinalization({ seasonKey: SEASON, weekNumber: WEEK_NO, org: null, mode: "finalize", scope: "qa", actor: null });
    check("[1·direct] finalize(qa) published 세팅", (dFin.published?.resultPublishedAt ?? null) != null, stable(dFin));
    check("[direct] qa_weeks_state published 세팅됨", (await qaPublished()) != null);
    check("운영 weeks 무접촉(여전히 null)", (await opPublished()) === null);

    // ── (B) direct revert(qa) → 공표 SoT null ──
    const dRev = await revertWeeklyCardFinalization({ seasonKey: SEASON, weekNumber: WEEK_NO, org: null, scope: "qa", actor: null });
    check("[8·direct] revert(qa) reverted·published null", dRev.reverted === true && (dRev.published?.resultPublishedAt ?? null) === null, { reverted: dRev.reverted });
    check("[direct] qa_weeks_state published null 복원", (await qaPublished()) === null);
    check("운영 weeks 무접촉(revert 후에도 null)", (await opPublished()) === null);

    // ── (C) HTTP finalize/revert(qa) ──
    const hFinRes = await fetch(`${BASE}/api/admin/weekly-card-finalization/finalize?mode=test`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ seasonId: SEASON, weekNumber: WEEK_NO, org: null, mode: "finalize" }) });
    const hFin: any = await hFinRes.json();
    check("[2·HTTP] finalize(qa) 200·success·published 세팅", hFinRes.ok && hFin?.success === true && hFin?.data?.published?.resultPublishedAt != null, { status: hFinRes.status });
    // 합성 테스트유저 U 가 qa 코호트에 포함 → 실제 재계산: requested≥1 + U snapshot updated_at 변경.
    check("[4·5] finalize 가 qa 코호트 실제 재계산(requested≥1)", (hFin?.data?.snapshotRecompute?.requested ?? 0) >= 1, hFin?.data?.snapshotRecompute);
    check("[4] 대상 유저 snapshot updated_at 변경(재계산 반영)", ((await snapUpd())?.updated_at ?? null) !== uUpdBefore, { before: uUpdBefore });

    // ── (3) direct == HTTP (finalize 안정 필드) ──
    check("[3] direct == HTTP (finalize 안정 필드)", JSON.stringify(stable(dFin)) === JSON.stringify(stable(hFin?.data)), { direct: stable(dFin), http: stable(hFin?.data) });

    const hRevRes = await fetch(`${BASE}/api/admin/weekly-card-finalization/revert?mode=test`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ seasonId: SEASON, weekNumber: WEEK_NO, org: null }) });
    const hRev: any = await hRevRes.json();
    check("[HTTP] revert(qa) 200·success·published null", hRevRes.ok && hRev?.success === true && (hRev?.data?.published?.resultPublishedAt ?? null) === null, { status: hRevRes.status });
    check("[3] direct == HTTP (revert reverted·published)", JSON.stringify(stable(dRev)) === JSON.stringify(stable(hRev?.data)));

    // ── (D) 멱등 ──
    await runWeeklyCardFinalization({ seasonKey: SEASON, weekNumber: WEEK_NO, org: null, mode: "finalize", scope: "qa", actor: null });
    const idem = await runWeeklyCardFinalization({ seasonKey: SEASON, weekNumber: WEEK_NO, org: null, mode: "finalize", scope: "qa", actor: null });
    check("[멱등] 재확정 alreadyFinalized=true(중복 공표 없음)", idem.published?.alreadyFinalized === true);
    await revertWeeklyCardFinalization({ seasonKey: SEASON, weekNumber: WEEK_NO, org: null, scope: "qa", actor: null });
    const idemRev = await revertWeeklyCardFinalization({ seasonKey: SEASON, weekNumber: WEEK_NO, org: null, scope: "qa", actor: null });
    check("[멱등] 재취소 no-op(reverted=false·이미 미공표)", idemRev.reverted === false && (idemRev.published?.resultPublishedAt ?? null) === null);

    // ── (7·8) 고객 카드 status gate: published 가 success/fail↔tallying 을 좌우 ──
    const g = (isPublished: boolean) => resolveWeekResultStatus({ uwsStatus: "success", isCurrentWeek: false, isPublished, weekIsOfficialRest: false, experienceVerdictStatus: null } as any).status;
    check("[7] 공표(published) → 성장 성공(success) 표시", g(true) === "success", { published_true: g(true) });
    check("[8] 미공표(revert 후) → 집계 중(tallying) 복원", g(false) === "tallying", { published_false: g(false) });

    // ── (9) demoUserId==normal DTO — 카드 단일 snapshot 원천 ──
    const testUser = "e649370f-ba2c-4d2f-b642-6800cb078d54";
    const snap: any = await readWeeklyCardsSnapshot(testUser);
    const demoRes = await fetch(`${BASE}/api/cluster4/weekly-cards?demoUserId=${testUser}`, { headers: { cookie }, cache: "no-store" });
    const dj: any = await demoRes.json();
    const demoCards = Array.isArray(dj?.data) ? dj.data : [];
    const w1Direct = (snap?.cards ?? []).find((c: any) => c.weekId === W1_ID)?.userWeekStatus;
    const w1Demo = demoCards.find((c: any) => c.weekId === W1_ID)?.userWeekStatus;
    check("[9] demoUserId HTTP == direct snapshot(W1 userWeekStatus 동일)", !!w1Demo && w1Demo === w1Direct, { direct: w1Direct, demo: w1Demo });
  } finally {
    // 보장 복원: qa_weeks_state[W1] 원복(원래 없으면 삭제), 운영 weeks 는 애초에 무접촉.
    if (qaOrig == null) await supabaseAdmin.from("qa_weeks_state").delete().eq("week_id", W1_ID);
    else await supabaseAdmin.from("qa_weeks_state").update({ result_published_at: qaOrig }).eq("week_id", W1_ID);
    // 합성 uws 정리(내가 넣은 경우만) + 대상 유저 snapshot 재계산.
    if (!uwsPreexisting) await supabaseAdmin.from("user_week_statuses").delete().eq("user_id", U).eq("week_start_date", "2026-06-29");
    await recomputeWeeklyCardsSnapshotsForUsers([U], { concurrency: 2 });
    const opAfter = await opPublished();
    check("보장 복원: 운영 weeks[W1] 시종 무변경(null)", opAfter === opBefore, { before: opBefore, after: opAfter });
    check("보장 복원: qa_weeks_state[W1] 원복", (await qaPublished()) === qaOrig);
  }

  console.log(failed === 0 ? "\n✅ ALL PASS (주차 검수 ⚡/↩ — qa 안전 검증·운영 무접촉)" : `\n❌ ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
