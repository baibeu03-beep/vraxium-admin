/**
 * Action Control — Batch 1: 오픈 확인 ⚡ 즉시 실행 / ↩ 실행 취소(직전 단계 복원) 검증 (dev server 필요).
 *
 *   1) direct(saveWeekOpenConfirm / revertWeekOpenConfirm) 결과
 *   2) HTTP(POST / DELETE open-confirm) 응답 결과
 *   3) direct == HTTP (revert 결과 객체 동일)
 *   4) snapshot 영향 여부 — 고객 weekly-card snapshot 무변경(fingerprint)
 *   5) snapshot 재계산 필요 여부 — 불필요(cluster4_week_opening_configs 만 write)
 *   6) 직전 단계 복원 확인 — open_confirmed=false 로 복귀하되 config(오픈 설정) 보존
 *   + 멱등(중복 취소 안전) · 원본 상태 복원
 *
 *   npx tsx --env-file=.env.local scripts/verify-action-control-open-confirm.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";
import {
  loadTeamPartsInfoWeekDetail,
  saveWeekOpenConfirm,
  revertWeekOpenConfirm,
} from "@/lib/adminTeamPartsInfoWeekDetailData";

const BASE = process.env.ADMIN_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const s = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ORG = "encre" as const;

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
  const sv = createServerClient(u, a, {
    cookies: { getAll: () => [], setAll: (items) => cap.push(...items.map(({ name, value }: any) => ({ name, value }))) },
  });
  await sv.auth.setSession({ access_token: (v as any).session.access_token, refresh_token: (v as any).session.refresh_token });
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function snapshotFingerprint() {
  const { count } = await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true });
  const { data } = await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("updated_at").order("updated_at", { ascending: false }).limit(1);
  return { count: count ?? 0, latest: (data?.[0] as { updated_at: string } | undefined)?.updated_at ?? null };
}

type ConfigRow = {
  config: unknown;
  open_confirmed: boolean;
  open_confirmed_at: string | null;
  open_confirmed_by: string | null;
} | null;

async function readRow(weekId: string): Promise<ConfigRow> {
  const { data } = await supabaseAdmin
    .from("cluster4_week_opening_configs")
    .select("config,open_confirmed,open_confirmed_at,open_confirmed_by")
    .eq("week_id", weekId).eq("organization_slug", ORG).maybeSingle();
  return (data as ConfigRow) ?? null;
}

async function main() {
  try {
    const h = await fetch(`${BASE}/api/health`);
    check("dev server 응답", h.ok, { base: BASE });
  } catch {
    console.log(`❌ dev server 미기동(${BASE}).`); process.exit(2);
  }

  // 테이블 존재 여부.
  const probe = await supabaseAdmin.from("cluster4_week_opening_configs").select("week_id").limit(1);
  const tableExists = !probe.error || !/schema cache|does not exist|could not find the table/i.test(probe.error.message);
  if (!tableExists) {
    console.log("⚠ cluster4_week_opening_configs 마이그레이션 미적용 — 해피패스 검증 불가.");
    console.log("   (2026-07-02_cluster4_week_opening_configs.sql 적용 후 재실행)");
    // 미적용 시 route 는 controlled 500 이어야 한다(회귀 방지 최소 확인).
    const cookie = await adminCookieHeader();
    const { rows } = await loadSeasonWeeks();
    const wid = (rows.find((r) => !r.is_official_rest && r.week_start_date) ?? rows[0]).week_id;
    const res = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${wid}/open-confirm?club=${ORG}`, { method: "DELETE", headers: { cookie } });
    const json: any = await res.json();
    check("미적용 시 DELETE controlled 500", res.status === 500 && json?.success === false, { status: res.status, error: json?.error });
    console.log(failed === 0 ? "\n✅ (마이그레이션 미적용) 회귀 없음" : `\n❌ ${failed} FAIL`);
    process.exit(failed === 0 ? 0 : 1);
  }

  const cookie = await adminCookieHeader();
  const snapBefore = await snapshotFingerprint();

  const { rows } = await loadSeasonWeeks();
  const activityWeek = rows.find((r) => !r.is_official_rest && r.week_start_date) ?? rows[0];
  const weekId = activityWeek.week_id;
  console.log(`   test week = ${activityWeek.week_label} (${activityWeek.week_start_date}) id=${weekId.slice(0, 8)} org=${ORG}`);

  // 원본 상태 캡처(복원용).
  const orig = await readRow(weekId);

  const CONFIG = { practicalInfo: { wisdom: true }, practicalExperience: {}, practicalCompetency: { checked: false } };

  // ── (A) direct: save(확인) → revert(취소) ──────────────────────────────
  await saveWeekOpenConfirm({ weekId, organization: ORG, config: CONFIG, actorId: null });
  const afterSaveDirect = await readRow(weekId);
  check("[direct] save 후 open_confirmed=true", afterSaveDirect?.open_confirmed === true);

  const revDirect = await revertWeekOpenConfirm({ weekId, organization: ORG });
  const afterRevertDirect = await readRow(weekId);
  check("[direct] revert 결과 {openConfirmed:false, reverted:true}", revDirect.openConfirmed === false && revDirect.reverted === true, revDirect);
  check("[direct] revert 후 open_confirmed=false", afterRevertDirect?.open_confirmed === false);
  // config 보존 = revert 가 "저장된 config"를 바꾸지 않음(정규화 키순서 무관하게 save 직후 값과 동일).
  check("[direct] revert 후 config(오픈 설정) 보존", JSON.stringify(afterRevertDirect?.config) === JSON.stringify(afterSaveDirect?.config), afterRevertDirect?.config);
  check("[direct] revert 후 open_confirmed_at/by null(직전 단계)", afterRevertDirect?.open_confirmed_at === null && afterRevertDirect?.open_confirmed_by === null);

  // ── (B) HTTP: POST(확인) → DELETE(취소) ────────────────────────────────
  const post = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}/open-confirm?club=${ORG}`, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ config: CONFIG }),
  });
  const postJson: any = await post.json();
  check("[HTTP] POST 확인 성공(openConfirmed=true)", post.ok && postJson?.success === true && postJson?.data?.openConfirmed === true, { status: post.status });

  const del = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}/open-confirm?club=${ORG}`, { method: "DELETE", headers: { cookie } });
  const delJson: any = await del.json();
  check("[HTTP] DELETE 취소 성공(openConfirmed=false)", del.ok && delJson?.success === true && delJson?.data?.openConfirmed === false, { status: del.status, data: delJson?.data });

  // ── (C) direct == HTTP (revert 결과 객체 동일) ─────────────────────────
  const eq = JSON.stringify(revDirect) === JSON.stringify(delJson?.data);
  check("direct == HTTP (revert 결과 동일)", eq, { direct: revDirect, http: delJson?.data });

  // ── (D) GET 반영: managedWeek.openConfirmed=false, config 보존 ──────────
  const g = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}?club=${ORG}`, { headers: { cookie }, cache: "no-store" });
  const gj: any = await g.json();
  check("[HTTP GET] managedWeek.openConfirmed=false", gj?.data?.managedWeek?.openConfirmed === false);
  // DTO 경로 정정: openingConfig.lineOpening.practicalInfo (기존 오타 openingConfig.practicalInfo).
  const wisdom = gj?.data?.openingConfig?.lineOpening?.practicalInfo?.find((l: any) => l.lineId === "wisdom");
  check("[HTTP GET] 취소 후에도 config 보존(wisdom checked=true)", wisdom?.checked === true, { wisdom });

  // direct GET(loadTeamPartsInfoWeekDetail) == HTTP GET.
  const directGet = await loadTeamPartsInfoWeekDetail({ weekId, organization: ORG, mode: "operating" });
  check("GET direct == HTTP", JSON.stringify(directGet) === JSON.stringify(gj?.data));

  // ── (E) 멱등: 이미 취소 상태에서 DELETE 재요청 → reverted:false, 성공 ──
  const del2 = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}/open-confirm?club=${ORG}`, { method: "DELETE", headers: { cookie } });
  const del2Json: any = await del2.json();
  check("[HTTP] DELETE 멱등(재취소 reverted:false·성공)", del2.ok && del2Json?.success === true && del2Json?.data?.reverted === false, del2Json?.data);

  // ── (F) 원본 상태 복원 ─────────────────────────────────────────────────
  if (orig) {
    await supabaseAdmin.from("cluster4_week_opening_configs").upsert({
      week_id: weekId, organization_slug: ORG,
      config: orig.config as any, open_confirmed: orig.open_confirmed,
      open_confirmed_at: orig.open_confirmed_at, open_confirmed_by: orig.open_confirmed_by,
    }, { onConflict: "week_id,organization_slug" });
  } else {
    await supabaseAdmin.from("cluster4_week_opening_configs").delete().eq("week_id", weekId).eq("organization_slug", ORG);
  }
  // [오픈 확인 재실행 이력] save 마다 append 되는 버전 행 정리(이 테스트는 config 만 원복하므로 고아 방지).
  await supabaseAdmin.from("cluster4_week_opening_config_versions").delete().eq("week_id", weekId).eq("organization_slug", ORG);
  const restored = await readRow(weekId);
  check("원본 상태 복원", JSON.stringify(restored) === JSON.stringify(orig), { restored, orig });

  // ── (G) snapshot 무영향 ────────────────────────────────────────────────
  const snapAfter = await snapshotFingerprint();
  check("snapshot 무변경(count)", snapBefore.count === snapAfter.count, { before: snapBefore.count, after: snapAfter.count });
  check("snapshot 무변경(latest)", snapBefore.latest === snapAfter.latest);

  console.log(failed === 0 ? "\n✅ ALL PASS (Batch 1: 오픈 확인 ⚡/↩)" : `\n❌ ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
