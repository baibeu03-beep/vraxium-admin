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
    // 라인 개설(8) 기본(불변): 정보 전부 unchecked · 역량 checked · 경험 도출/분석/견문/관리=true.
    check(`[${org}] 라인개설 정보 기본 전부 unchecked`, oc.lineOpening.practicalInfo.every((l) => l.checked === false), { infoLines: oc.lineOpening.practicalInfo.length });
    check(`[${org}] 역량 기본 checked`, oc.practicalCompetency.checked === true);
    const expOk = oc.lineOpening.practicalExperience.every((t) => {
      const m = Object.fromEntries(t.lines.map((l) => [l.type, l.checked]));
      return m.derive === true && m.analysis === true && m.research === true && m.management === true;
    });
    check(`[${org}] 라인개설 경험 도출·분석·견문·관리 기본 checked`, oc.lineOpening.practicalExperience.length === 0 || expOk, { teams: oc.lineOpening.practicalExperience.length });
    const expansionVals = oc.lineOpening.practicalExperience.map((t) => t.lines.find((l) => l.type === "expansion")?.checked);
    const uniformExpansion = expansionVals.every((v) => v === expansionVals[0]);
    check(`[${org}] 확장 기본값 팀 전체 동일(=isExpansionWeek)`, oc.lineOpening.practicalExperience.length === 0 || uniformExpansion, { expansion: expansionVals[0] });
    // 액트 체크(7) 라인급 기본: 전부 checked(§4 통일). SoT = process_line_groups.
    check(`[${org}] 액트체크 정보 라인급 기본 전부 checked`, oc.actCheck.info.every((g) => g.checked === true), { n: oc.actCheck.info.length });
    check(`[${org}] 액트체크 클럽 라인급 기본 전부 checked`, oc.actCheck.club.every((g) => g.checked === true), { n: oc.actCheck.club.length });
    check(`[${org}] 액트체크 경험 라인급 기본 전부 checked`, oc.actCheck.experience.every((t) => t.lineGroups.every((g) => g.checked === true)));
  }

  // DTO 키 형상.
  {
    const res = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}?club=encre`, { headers: { cookie } });
    const json: any = await res.json();
    const d = json.data;
    check("DTO top keys", JSON.stringify(Object.keys(d).sort()) === JSON.stringify(["currentWeek", "managedWeek", "openingConfig"]), { keys: Object.keys(d) });
    check("openingConfig keys", JSON.stringify(Object.keys(d.openingConfig).sort()) === JSON.stringify(["actCheck", "lineOpening", "practicalCompetency"]));
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

  // ── 검수 완료(review=finalize) 라운드트립 — 안전(공표 불변) ──
  //   review 는 이제 공표+검수 확정이다. 미공표 주차를 공표하면 실크루가 영향받으므로,
  //   이미 공표된 주차의 result_reviewed_at 만 임시 null→검수→원본 시각 원복(published 내내 불변).
  //   상세 검수 완료(publish/finalize) 전체 경로는 verify-team-parts-info-week-review.ts 에서 검증.
  {
    const { data: pubWeek } = await supabaseAdmin
      .from("weeks").select("id,result_published_at,result_reviewed_at")
      .not("result_published_at", "is", null).order("start_date", { ascending: false }).limit(1).maybeSingle();
    const rw = (pubWeek as { id: string } | null)?.id;
    const origPub = (pubWeek as any)?.result_published_at as string | undefined;
    const origRev = (pubWeek as any)?.result_reviewed_at as string | null | undefined;
    if (!rw) {
      console.log("⚠ 공표된 주차 없음 — review 라운드트립 생략.");
    } else {
      await supabaseAdmin.from("weeks").update({ result_reviewed_at: null }).eq("id", rw);
      const res = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${rw}/review?club=encre`, { method: "POST", headers: { cookie } });
      const json: any = await res.json();
      check("review POST 성공(ok·reviewed)", res.ok && json?.success === true && json?.ok === true && json?.data?.reviewed === true, { status: res.status });
      check("review: 공표 불변(alreadyPublished=true)", json?.data?.alreadyPublished === true);
      const { data: after } = await supabaseAdmin.from("weeks").select("result_published_at,result_reviewed_at").eq("id", rw).maybeSingle();
      check("review 후 weeks.result_reviewed_at 세팅", (after as any)?.result_reviewed_at != null);
      check("review 후 weeks.result_published_at 불변", (after as any)?.result_published_at === origPub);
      // GET 반영 확인.
      const g = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${rw}?club=encre`, { headers: { cookie } });
      const gj: any = await g.json();
      check("review 후 GET managedWeek.reviewed=true", gj?.data?.managedWeek?.reviewed === true);
      // 원복(원본 검수 시각 — published 는 건드리지 않음).
      await supabaseAdmin.from("weeks").update({ result_reviewed_at: origRev ?? null }).eq("id", rw);
      const { data: rev } = await supabaseAdmin.from("weeks").select("result_reviewed_at").eq("id", rw).maybeSingle();
      check("review 원복(원본 시각)", (rev as any)?.result_reviewed_at === (origRev ?? null));
    }
  }

  // ── open-confirm (테이블 존재 여부 분기) ──
  {
    const tableProbe = await supabaseAdmin.from("cluster4_week_opening_configs").select("id").limit(1);
    const tableExists =
      !tableProbe.error ||
      !/schema cache|does not exist|could not find the table/i.test(tableProbe.error.message);
    console.log(`   cluster4_week_opening_configs 존재: ${tableExists}`);
    // 라인 개설(8)=practicalInfo(activity_type id) · 액트 체크(7)=actCheck.info(line_group id) 독립 저장.
    const dirNow = await loadTeamPartsInfoWeekDetail({ weekId, organization: "encre", mode: "operating" });
    const lineInfoId = dirNow.openingConfig.lineOpening.practicalInfo[0]?.lineId;
    const actLgId = dirNow.openingConfig.actCheck.info[0]?.lineGroupId;
    const body = JSON.stringify({
      config: {
        practicalInfo: lineInfoId ? { [lineInfoId]: true } : {},
        practicalExperience: {},
        practicalCompetency: { checked: false },
        actCheck: { info: actLgId ? { [actLgId]: false } : {}, experience: {}, club: {} },
      },
    });
    const res = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}/open-confirm?club=encre`, {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body,
    });
    const json: any = await res.json();
    if (tableExists) {
      check("open-confirm POST 성공", res.ok && json?.success === true && json?.data?.openConfirmed === true, { status: res.status });
      // GET 반영(저장 config 우선) — 두 네임스페이스 독립.
      const g = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}?club=encre`, { headers: { cookie } });
      const gj: any = await g.json();
      const li = gj?.data?.openingConfig?.lineOpening?.practicalInfo?.find((l: any) => l.lineId === lineInfoId);
      check("open-confirm 후 GET: 라인개설 정보 저장값 우선(true)", !lineInfoId || li?.checked === true, { li });
      const ai = gj?.data?.openingConfig?.actCheck?.info?.find((g2: any) => g2.lineGroupId === actLgId);
      check("open-confirm 후 GET: 액트체크 정보 저장값 우선(false)", !actLgId || ai?.checked === false, { ai });
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
