/**
 * 액트 체크 관리 API 검증 (dev server 필요).
 *   1) direct(loadTeamPartsInfoActCheckManagement) 결과
 *   2) HTTP GET 결과
 *   3) direct == HTTP (operating + test)
 *   4) DTO 형상·집계 불변식(uncheck=active-check·rate·active<=total)
 *   5) 기본(오픈확인 전): 정보 라인 전부 isOpenThisWeek=false·정보 activeActs=0·액트 비가동
 *   6) [테이블 존재 시] 위즈덤 오픈확인 → 위즈덤 라인/액트 가동 전환 → 정리
 *   7) snapshot 무영향
 *   npx tsx --env-file=.env.local scripts/verify-team-parts-info-act-check.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ORGANIZATIONS } from "@/lib/organizations";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";
import { loadTeamPartsInfoActCheckManagement } from "@/lib/adminTeamPartsInfoActCheckData";

const BASE = process.env.ADMIN_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const s = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let failed = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) failed++;
};

async function cookieHeader(): Promise<string> {
  const { data: adm } = await supabaseAdmin.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (adm?.[0] as any)?.email;
  const A = createClient(u, s), N = createClient(u, a);
  const { data: l } = await A.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await N.auth.verifyOtp({ email, token: (l as any).properties.email_otp, type: "magiclink" });
  const cap: any[] = [];
  const sv = createServerClient(u, a, { cookies: { getAll: () => [], setAll: (it) => cap.push(...it.map(({ name, value }: any) => ({ name, value }))) } });
  await sv.auth.setSession({ access_token: (v as any).session.access_token, refresh_token: (v as any).session.refresh_token });
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}
async function snap() {
  const { count } = await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true });
  const { data } = await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("updated_at").order("updated_at", { ascending: false }).limit(1);
  return { count: count ?? 0, latest: (data?.[0] as any)?.updated_at ?? null };
}
function invariants(prefix: string, sm: any) {
  check(`${prefix} uncheck=active-check`, sm.uncheckedActs === sm.activeActs - sm.checkedActs, sm);
  check(`${prefix} active<=total·checked<=active`, sm.activeActs <= sm.totalActs && sm.checkedActs <= sm.activeActs, sm);
  const expRate = sm.activeActs > 0 ? Math.round((sm.checkedActs / sm.activeActs) * 100) : 0;
  check(`${prefix} rate 계산`, sm.actCheckRate === expRate, { rate: sm.actCheckRate, expRate });
}

async function main() {
  try { const h = await fetch(`${BASE}/api/health`); check("dev server", h.ok); }
  catch { console.log("❌ dev server 미기동"); process.exit(2); }
  const cookie = await cookieHeader();
  const snapBefore = await snap();

  const { rows } = await loadSeasonWeeks();
  const week = rows.find((r) => !r.is_official_rest && r.week_start_date) ?? rows[0];
  const weekId = week.week_id;
  console.log(`   week=${week.week_label} id=${weekId.slice(0, 8)}`);

  for (const org of ORGANIZATIONS) {
    for (const mode of ["operating", "test"] as const) {
      const direct = await loadTeamPartsInfoActCheckManagement({ weekId, organization: org, mode });
      const params = new URLSearchParams({ club: org });
      if (mode === "test") params.set("mode", "test");
      const res = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}/act-check-management?${params}`, { headers: { cookie }, cache: "no-store" });
      const json: any = await res.json();
      check(`[${org}/${mode}] HTTP 200·success`, res.ok && json?.success === true, { status: res.status });
      check(`[${org}/${mode}] direct == HTTP`, JSON.stringify(direct) === JSON.stringify(json?.data));
    }
    // 형상·불변식(operating).
    const d = await loadTeamPartsInfoActCheckManagement({ weekId, organization: org, mode: "operating" });
    check(`[${org}] top keys`, JSON.stringify(Object.keys(d).sort()) === JSON.stringify(["club", "practicalInfo", "summary", "weekId"]));
    check(`[${org}] practicalInfo.lines = 9`, d.practicalInfo.lines.length === 9, { n: d.practicalInfo.lines.length });
    const wisdom = d.practicalInfo.lines.find((l) => l.lineId === "wisdom");
    check(`[${org}] 위즈덤 라인 존재·요일버킷 7개`, !!wisdom && Object.keys(wisdom!.regularActsByDay).length === 7);
    invariants(`[${org}] week`, d.summary);
    invariants(`[${org}] info`, d.practicalInfo.summary);
    // 오픈확인 전 기본: 정보 라인 전부 미오픈·activeActs=0.
    check(`[${org}] (오픈확인 전) 정보 라인 전부 미오픈`, d.practicalInfo.lines.every((l) => l.isOpenThisWeek === false));
    check(`[${org}] (오픈확인 전) 정보 activeActs=0`, d.practicalInfo.summary.activeActs === 0, d.practicalInfo.summary);
    const allActs = d.practicalInfo.lines.flatMap((l) => Object.values(l.regularActsByDay).flat());
    check(`[${org}] (오픈확인 전) 모든 정보 액트 비가동`, allActs.every((x: any) => x.isActiveThisWeek === false), { acts: allActs.length });
  }

  // ── 위즈덤 오픈확인 → 가동 전환(테이블 존재 시) ──
  const probe = await supabaseAdmin.from("cluster4_week_opening_configs").select("id").limit(1);
  const tableExists = !probe.error;
  console.log(`   opening_configs 존재: ${tableExists}`);
  if (tableExists) {
    const org = "encre";
    // before
    const before = await loadTeamPartsInfoActCheckManagement({ weekId, organization: org, mode: "operating" });
    // open-confirm wisdom
    const oc = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}/open-confirm?club=${org}`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ config: { practicalInfo: { wisdom: true }, practicalExperience: {}, practicalCompetency: { checked: false } } }),
    });
    check("open-confirm(wisdom) 성공", oc.ok);
    const after = await loadTeamPartsInfoActCheckManagement({ weekId, organization: org, mode: "operating" });
    const wAfter = after.practicalInfo.lines.find((l) => l.lineId === "wisdom");
    check("위즈덤 라인 isOpenThisWeek=true", wAfter?.isOpenThisWeek === true);
    const wActs = wAfter ? Object.values(wAfter.regularActsByDay).flat() : [];
    check("위즈덤 액트 isActiveThisWeek=true", wActs.length > 0 && wActs.every((x: any) => x.isActiveThisWeek === true), { acts: wActs.length });
    check("정보 activeActs 증가(before<after)", after.practicalInfo.summary.activeActs > before.practicalInfo.summary.activeActs, { before: before.practicalInfo.summary.activeActs, after: after.practicalInfo.summary.activeActs });
    // HTTP == direct (after)
    const g = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}/act-check-management?club=${org}`, { headers: { cookie } });
    const gj: any = await g.json();
    check("전환 후 direct == HTTP", JSON.stringify(after) === JSON.stringify(gj.data));
    // cleanup
    await supabaseAdmin.from("cluster4_week_opening_configs").delete().eq("week_id", weekId).eq("organization_slug", org);
    console.log("   (테스트 open-config 정리 완료)");
  } else {
    console.log("   ⚠ 마이그레이션 미적용 — 위즈덤 가동 전환 검증은 적용 후. (기본=전부 비가동 확인됨)");
  }

  const snapAfter = await snap();
  check("snapshot 무변경(count)", snapBefore.count === snapAfter.count, { before: snapBefore.count, after: snapAfter.count });
  check("snapshot 무변경(latest)", snapBefore.latest === snapAfter.latest);

  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
