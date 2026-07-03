/**
 * Action Control — Batch 2: Process Check ↩ 실행 취소(완료→pending, 포인트 회수·snapshot 재계산) 검증.
 *   ↩ 는 운영/테스트 공용(QA 전용 아님) — 멱등·가역 Action 이라 운영에서도 제공.
 *   POST /api/admin/processes/check/rollback · lib/processCheckRollback.rollbackProcessCheckCompletion.
 *
 *   1) direct 결과  2) HTTP 응답  3) direct == HTTP  4) snapshot 영향(대상자만 재계산)
 *   5) 재계산 수행(recompute.requested>0·대상 유저 hit)  6) 직전 단계 복원(completed→pending·원장/recipients 삭제·uwp 재합산)
 *   + 운영 스코프 수용(422 아님)·운영 스코프 풀사이클·not_found·멱등·전 상태 복원
 *
 *   실제 테스트 행에 합성 적립상태를 얹었다 되돌리고 원본을 정확히 복원. 운영 풀사이클은 테스트 행의
 *   scope_mode 를 임시 'operating' 으로 바꿔(실운영 행 무접촉) 전 경로를 태운 뒤 복원한다.
 *   npx tsx --env-file=.env.local scripts/verify-action-control-process-check-rollback.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { rollbackProcessCheckCompletion } from "@/lib/processCheckRollback";
import { readWeeklyCardsSnapshotBatch } from "@/lib/cluster4WeeklyCardsSnapshot";

const BASE = process.env.ADMIN_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const s = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ROLLBACK_URL = `${BASE}/api/admin/processes/check/rollback`;

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
  if (!ok) failed++;
}

async function adminCookieHeader(): Promise<string> {
  const { data: adm } = await supabaseAdmin
    .from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (adm?.[0] as { email: string } | undefined)?.email;
  const A = createClient(u, s), N = createClient(u, a);
  const { data: l } = await A.auth.admin.generateLink({ type: "magiclink", email: email! });
  const { data: v } = await N.auth.verifyOtp({ email: email!, token: (l as any).properties.email_otp, type: "magiclink" });
  const cap: { name: string; value: string }[] = [];
  const sv = createServerClient(u, a, { cookies: { getAll: () => [], setAll: (items) => cap.push(...items.map(({ name, value }: any) => ({ name, value }))) } });
  await sv.auth.setSession({ access_token: (v as any).session.access_token, refresh_token: (v as any).session.refresh_token });
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}
async function snapCount() {
  const { count } = await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true });
  return count ?? 0;
}
async function rollbackHttp(cookie: string, statusId: string) {
  const r = await fetch(ROLLBACK_URL, { method: "POST", headers: { cookie, "content-type": "application/json" }, cache: "no-store", body: JSON.stringify({ statusId }) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
}
const stable = (r: any) => ({
  ok: r?.ok, status: r?.status, scopeMode: r?.scopeMode,
  revokedUserIds: [...(r?.revokedUserIds ?? [])].sort(),
  recipientsDeleted: r?.recipientsDeleted, recomputeRequested: r?.recompute?.requested ?? 0,
});

async function main() {
  try { const h = await fetch(`${BASE}/api/health`); check("dev server 응답", h.ok, { base: BASE }); }
  catch { console.log(`❌ dev server 미기동(${BASE}).`); process.exit(2); }
  const cookie = await adminCookieHeader();

  const { data: testRows } = await supabaseAdmin
    .from("process_check_statuses").select("id,status,scope_mode,week_id,act_id,organization_slug,completed_at,checked_crew_count")
    .eq("scope_mode", "test").limit(1);
  const R = testRows?.[0] as any;
  check("테스트 스코프 정규 행 존재", !!R, R ? { id: String(R.id).slice(0, 8) } : "none");
  if (!R) { console.log("⚠ 테스트 행 없음."); process.exit(1); }
  const { data: opRow } = await supabaseAdmin.from("process_check_statuses").select("id,status,scope_mode").neq("scope_mode", "test").not("status", "eq", "completed").limit(1);
  const OP = opRow?.[0] as any;
  const { data: tus } = await supabaseAdmin.from("test_user_markers").select("user_id").limit(1);
  const U = (tus?.[0] as any)?.user_id as string;
  const { data: wk } = await supabaseAdmin.from("weeks").select("iso_year,iso_week,start_date").eq("id", R.week_id).maybeSingle();
  const year = (wk as any)?.iso_year as number, week = (wk as any)?.iso_week as number, wstart = (wk as any)?.start_date as string;
  check("앵커 유저/주차 확보", !!U && Number.isFinite(year), { U: String(U).slice(0, 8), year, week });

  const origStatus = { status: R.status, completed_at: R.completed_at, checked_crew_count: R.checked_crew_count, scope_mode: R.scope_mode };
  const { data: origLedger } = await supabaseAdmin.from("process_point_awards").select("*").eq("source", "regular").eq("ref_id", R.id);
  const { data: origRecips } = await supabaseAdmin.from("process_check_review_recipients").select("*").eq("source", "regular").eq("ref_id", R.id);
  const { data: origUwp } = await supabaseAdmin.from("user_weekly_points").select("*").eq("user_id", U).eq("year", year).eq("week_number", week).maybeSingle();
  const snapBefore = await snapCount();

  // scopeMode 파라미터로 합성 완료상태 셋업.
  async function setupAccrued(scopeMode: "operating" | "test") {
    await supabaseAdmin.from("process_check_statuses").update({ status: "completed", completed_at: new Date().toISOString(), checked_crew_count: 1, scope_mode: scopeMode }).eq("id", R.id);
    await supabaseAdmin.from("process_point_awards").upsert({ source: "regular", ref_id: R.id, user_id: U, year, week_number: week, point_check: 10, point_advantage: 0, point_penalty: 0, organization_slug: R.organization_slug, scope_mode: scopeMode }, { onConflict: "source,ref_id,user_id" });
    // 결정성: 기존(실) recipients 를 비우고 합성 1건만 → recipientsDeleted 가 direct/HTTP 모두 1(원본은 마지막에 복원).
    await supabaseAdmin.from("process_check_review_recipients").delete().eq("source", "regular").eq("ref_id", R.id);
    await supabaseAdmin.from("process_check_review_recipients").insert({ source: "regular", ref_id: R.id, organization_slug: R.organization_slug, scope_mode: scopeMode, user_id: U, nickname: "__ac_test__", match_type: "matched", match_reason: "verify" });
    await supabaseAdmin.from("user_weekly_points").upsert({ user_id: U, year, week_number: week, week_start_date: wstart, points: 10, advantages: 0, penalty: 0, checks_migrated: true }, { onConflict: "user_id,year,week_number" });
  }

  // ── (A) DIRECT (test scope) ──
  await setupAccrued("test");
  const beforeUwp = (await supabaseAdmin.from("user_weekly_points").select("points").eq("user_id", U).eq("year", year).eq("week_number", week).maybeSingle()).data as any;
  const resDirect = await rollbackProcessCheckCompletion({ statusId: R.id, actor: null });
  check("[direct] ok·status=pending·scopeMode=test·revoke U", resDirect.ok && resDirect.status === "pending" && resDirect.scopeMode === "test" && resDirect.revokedUserIds.includes(U), stable(resDirect));
  const sAfterD = await supabaseAdmin.from("process_check_statuses").select("status,completed_at").eq("id", R.id).maybeSingle();
  check("[direct] completed→pending·completed_at null", (sAfterD.data as any)?.status === "pending" && (sAfterD.data as any)?.completed_at === null);
  const ledD = await supabaseAdmin.from("process_point_awards").select("id").eq("source", "regular").eq("ref_id", R.id);
  const recD = await supabaseAdmin.from("process_check_review_recipients").select("id").eq("source", "regular").eq("ref_id", R.id);
  check("[direct] 원장·recipients 삭제", (ledD.data ?? []).length === 0 && (recD.data ?? []).length === 0);
  const uwpD = (await supabaseAdmin.from("user_weekly_points").select("points").eq("user_id", U).eq("year", year).eq("week_number", week).maybeSingle()).data as any;
  check("[direct] uwp 재합산(10→0)", (beforeUwp?.points ?? 0) === 10 && (uwpD?.points ?? 0) === 0, { before: beforeUwp?.points, after: uwpD?.points });
  const stD = (await readWeeklyCardsSnapshotBatch([U])).get(U) as any;
  check("[direct] 대상 유저 snapshot 재계산(hit)", stD?.status === "hit", { state: stD?.status });

  // ── (B) HTTP (test scope) ──
  await setupAccrued("test");
  const h = await rollbackHttp(cookie, R.id);
  check("[HTTP] 200·success·status=pending", h.status === 200 && h.json?.success === true && h.json?.data?.status === "pending", { status: h.status });

  // ── (C) direct == HTTP ──
  check("direct == HTTP (안정 필드 동일)", JSON.stringify(stable(resDirect)) === JSON.stringify(stable(h.json?.data)), { direct: stable(resDirect), http: stable(h.json?.data) });

  // ── (D) 운영 스코프 수용(422 아님) — 비완료 운영 행 no-op ──
  if (OP) {
    const ro = await rollbackHttp(cookie, OP.id);
    check("[HTTP] 운영 비완료 행 → 200 수용(422 아님·no-op)", ro.status === 200 && ro.json?.success === true && ro.json?.data?.scopeMode === "operating" && ro.json?.data?.revokedUserIds?.length === 0, { status: ro.status, data: ro.json?.data });
  } else check("운영 비완료 행 없음 — skip", true);

  // ── (E) 운영 스코프 풀사이클(테스트 행 scope 임시 operating) ──
  await setupAccrued("operating");
  const opRes = await rollbackHttp(cookie, R.id);
  check("[HTTP] 운영 스코프 완료행 풀 롤백(revoke+pending)", opRes.status === 200 && opRes.json?.data?.status === "pending" && opRes.json?.data?.scopeMode === "operating" && opRes.json?.data?.revokedUserIds?.includes(U), { data: stable(opRes.json?.data) });
  const uwpOp = (await supabaseAdmin.from("user_weekly_points").select("points").eq("user_id", U).eq("year", year).eq("week_number", week).maybeSingle()).data as any;
  check("[HTTP] 운영 스코프 uwp 회수(→0)", (uwpOp?.points ?? 0) === 0);

  // ── (F) not_found + 멱등 ──
  const nf = await rollbackHttp(cookie, "00000000-0000-0000-0000-000000000000");
  check("[HTTP] 없는 행 → not_found", nf.json?.data?.status === "not_found" && nf.json?.data?.ok === false);
  const idem = await rollbackProcessCheckCompletion({ statusId: R.id, actor: null });
  check("[direct] 비완료 멱등 no-op", idem.ok && idem.status === "pending" && idem.revokedUserIds.length === 0, stable(idem));

  // ── (G) 전 상태 복원 ──
  await supabaseAdmin.from("process_check_statuses").update(origStatus).eq("id", R.id);
  await supabaseAdmin.from("process_point_awards").delete().eq("source", "regular").eq("ref_id", R.id);
  if ((origLedger ?? []).length) await supabaseAdmin.from("process_point_awards").insert(origLedger as any);
  await supabaseAdmin.from("process_check_review_recipients").delete().eq("source", "regular").eq("ref_id", R.id);
  if ((origRecips ?? []).length) await supabaseAdmin.from("process_check_review_recipients").insert((origRecips as any).map((x: any) => { const { id, created_at, ...rest } = x; return rest; }));
  if (origUwp) await supabaseAdmin.from("user_weekly_points").upsert({ user_id: U, year, week_number: week, week_start_date: (origUwp as any).week_start_date, points: (origUwp as any).points, advantages: (origUwp as any).advantages, penalty: (origUwp as any).penalty, checks_migrated: (origUwp as any).checks_migrated }, { onConflict: "user_id,year,week_number" });
  else await supabaseAdmin.from("user_weekly_points").delete().eq("user_id", U).eq("year", year).eq("week_number", week);
  const { recomputeWeeklyCardsSnapshotsForUsers } = await import("@/lib/cluster4WeeklyCardsSnapshot");
  await recomputeWeeklyCardsSnapshotsForUsers([U], { concurrency: 2 });
  const restored = await supabaseAdmin.from("process_check_statuses").select("status,scope_mode").eq("id", R.id).maybeSingle();
  check("앵커 행 status·scope_mode 원복", (restored.data as any)?.status === origStatus.status && (restored.data as any)?.scope_mode === origStatus.scope_mode);
  check("snapshot count 불변", snapBefore === (await snapCount()), { before: snapBefore });

  console.log(failed === 0 ? "\n✅ ALL PASS (Batch 2: Process Check ↩ 운영/테스트 공용)" : `\n❌ ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
