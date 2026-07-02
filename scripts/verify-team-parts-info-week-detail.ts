/**
 * 클럽 정보 > 주차 내역 > 활동 관리(상세) 검증 (dev server 필요).
 *   1) direct(loadTeamPartsInfoWeekDetail) 결과
 *   2) HTTP GET 결과
 *   3) direct == HTTP
 *   4) 기본 체크 정책(info 전부 unchecked·experience 4 checked+확장=isExpansion·competency checked)
 *   5) review 라운드트립(weeks.result_reviewed_at 세팅 → 복원) + snapshot 무영향
 *   6) open-confirm: 테이블 존재 시 저장 라운드트립(GET 반영·정리), 미적용 시 controlled 에러 확인
 *   7) 고객 weekly-card snapshot 무변경
 *
 *   npx tsx --env-file=.env.local scripts/verify-team-parts-info-week-detail.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ORGANIZATIONS } from "@/lib/organizations";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";
import { loadTeamPartsInfoWeekDetail } from "@/lib/adminTeamPartsInfoWeekDetailData";

const BASE = process.env.ADMIN_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const s = process.env.SUPABASE_SERVICE_ROLE_KEY!;

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

async function main() {
  try {
    const h = await fetch(`${BASE}/api/health`);
    check("dev server 응답", h.ok, { base: BASE });
  } catch {
    console.log(`❌ dev server 미기동(${BASE}).`); process.exit(2);
  }
  const cookie = await adminCookieHeader();
  const snapBefore = await snapshotFingerprint();

  const { rows } = await loadSeasonWeeks();
  const activityWeek = rows.find((r) => !r.is_official_rest && r.week_start_date) ?? rows[0];
  const weekId = activityWeek.week_id;
  console.log(`   test week = ${activityWeek.week_label} (${activityWeek.week_start_date}) id=${weekId.slice(0, 8)}`);

  // ── GET direct == HTTP (3 club) ──
  for (const org of ORGANIZATIONS) {
    const direct = await loadTeamPartsInfoWeekDetail({ weekId, organization: org, mode: "operating" });
    const res = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}?club=${org}`, { headers: { cookie }, cache: "no-store" });
    const json: any = await res.json();
    check(`[${org}] HTTP 200·success`, res.ok && json?.success === true, { status: res.status });
    const eq = JSON.stringify(direct) === JSON.stringify(json?.data);
    check(`[${org}] direct == HTTP`, eq, eq ? undefined : { directTeams: direct.openingConfig.practicalExperience.length, httpTeams: json?.data?.openingConfig?.practicalExperience?.length });

    // 기본 정책(저장 config 없을 때).
    const oc = direct.openingConfig;
    check(`[${org}] 실무정보 기본 전부 unchecked`, oc.practicalInfo.every((l) => l.checked === false), { infoLines: oc.practicalInfo.length });
    check(`[${org}] 실무역량 기본 checked`, oc.practicalCompetency.checked === true);
    const expOk = oc.practicalExperience.every((t) => {
      const m = Object.fromEntries(t.lines.map((l) => [l.type, l.checked]));
      return m.derive === true && m.analysis === true && m.research === true && m.management === true;
    });
    check(`[${org}] 실무경험 도출·분석·견문·관리 기본 checked`, oc.practicalExperience.length === 0 || expOk, { teams: oc.practicalExperience.length });
    // 확장 = isExpansionWeek (활동 주차·확장기간 밖이면 전부 false 일 것).
    const expansionVals = oc.practicalExperience.map((t) => t.lines.find((l) => l.type === "expansion")?.checked);
    const uniformExpansion = expansionVals.every((v) => v === expansionVals[0]);
    check(`[${org}] 확장 기본값이 팀 전체 동일(=isExpansionWeek)`, oc.practicalExperience.length === 0 || uniformExpansion, { expansion: expansionVals[0] });
  }

  // DTO 키 형상.
  {
    const res = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}?club=encre`, { headers: { cookie } });
    const json: any = await res.json();
    const d = json.data;
    check("DTO top keys", JSON.stringify(Object.keys(d).sort()) === JSON.stringify(["currentWeek", "managedWeek", "openingConfig"]), { keys: Object.keys(d) });
    check("openingConfig keys", JSON.stringify(Object.keys(d.openingConfig).sort()) === JSON.stringify(["practicalCompetency", "practicalExperience", "practicalInfo"]));
    check("managedWeek.weekId 일치", d.managedWeek.weekId === weekId);
  }

  // ── 400/404 가드 ──
  {
    const r1 = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}?club=all`, { headers: { cookie } });
    check("club=all → 400", r1.status === 400);
    const r2 = await fetch(`${BASE}/api/admin/team-parts/info/weeks/not-a-uuid?club=encre`, { headers: { cookie } });
    check("weekId non-uuid → 400", r2.status === 400);
    const fakeUuid = "00000000-0000-0000-0000-000000000000";
    const r3 = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${fakeUuid}?club=encre`, { headers: { cookie } });
    check("존재하지 않는 week → 404", r3.status === 404);
  }

  // ── review 라운드트립(복원) ──
  {
    const { data: nullWeek } = await supabaseAdmin
      .from("weeks").select("id,result_reviewed_at").is("result_reviewed_at", null).limit(1).maybeSingle();
    const rw = (nullWeek as { id: string } | null)?.id;
    if (!rw) {
      console.log("⚠ result_reviewed_at NULL 주차 없음 — review 라운드트립 생략.");
    } else {
      const res = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${rw}/review?club=encre`, { method: "POST", headers: { cookie } });
      const json: any = await res.json();
      check("review POST 성공", res.ok && json?.success === true && json?.data?.reviewed === true, { status: res.status });
      const { data: after } = await supabaseAdmin.from("weeks").select("result_reviewed_at").eq("id", rw).maybeSingle();
      check("review 후 weeks.result_reviewed_at 세팅", (after as any)?.result_reviewed_at != null);
      // GET 반영 확인.
      const g = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${rw}?club=encre`, { headers: { cookie } });
      const gj: any = await g.json();
      check("review 후 GET managedWeek.reviewed=true", gj?.data?.managedWeek?.reviewed === true);
      // 복원(원상태 = null).
      await supabaseAdmin.from("weeks").update({ result_reviewed_at: null }).eq("id", rw);
      const { data: rev } = await supabaseAdmin.from("weeks").select("result_reviewed_at").eq("id", rw).maybeSingle();
      check("review 복원(null)", (rev as any)?.result_reviewed_at == null);
    }
  }

  // ── open-confirm (테이블 존재 여부 분기) ──
  {
    const tableProbe = await supabaseAdmin.from("cluster4_week_opening_configs").select("id").limit(1);
    const tableExists =
      !tableProbe.error ||
      !/schema cache|does not exist|could not find the table/i.test(tableProbe.error.message);
    console.log(`   cluster4_week_opening_configs 존재: ${tableExists}`);
    const body = JSON.stringify({
      config: {
        practicalInfo: { wisdom: true },
        practicalExperience: {},
        practicalCompetency: { checked: false },
      },
    });
    const res = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}/open-confirm?club=encre`, {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body,
    });
    const json: any = await res.json();
    if (tableExists) {
      check("open-confirm POST 성공", res.ok && json?.success === true && json?.data?.openConfirmed === true, { status: res.status });
      // GET 반영(저장 config 우선).
      const g = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}?club=encre`, { headers: { cookie } });
      const gj: any = await g.json();
      const wisdom = gj?.data?.openingConfig?.practicalInfo?.find((l: any) => l.lineId === "wisdom");
      check("open-confirm 후 GET: wisdom checked=true", wisdom?.checked === true, { wisdom });
      check("open-confirm 후 GET: competency checked=false(저장값 우선)", gj?.data?.openingConfig?.practicalCompetency?.checked === false);
      check("open-confirm 후 GET: managedWeek.openConfirmed=true", gj?.data?.managedWeek?.openConfirmed === true);
      // 정리(테스트 config 삭제).
      await supabaseAdmin.from("cluster4_week_opening_configs").delete().eq("week_id", weekId).eq("organization_slug", "encre");
      console.log("   (테스트 open-config 정리 완료)");
    } else {
      check("open-confirm 테이블 미적용 시 controlled 500", res.status === 500 && json?.success === false, { status: res.status, error: json?.error });
      console.log("   ⚠ cluster4_week_opening_configs 마이그레이션 미적용 — open-confirm 해피패스는 적용 후 검증.");
    }
  }

  const snapAfter = await snapshotFingerprint();
  check("고객 weekly-card snapshot 무변경(count)", snapBefore.count === snapAfter.count, { before: snapBefore.count, after: snapAfter.count });
  check("고객 weekly-card snapshot 무변경(latest)", snapBefore.latest === snapAfter.latest);

  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
