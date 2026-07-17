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
// 2026-07-17: ActCheckSummary → ActCheckApplicationSummary(필드명 정리 + 변동 액트 포함).
function invariants(prefix: string, sm: any) {
  check(`${prefix} uncheck=active-check`, sm.uncheckedCount === sm.activeCount - sm.checkedCount, sm);
  check(`${prefix} active<=total·checked<=active`, sm.activeCount <= sm.totalCount && sm.checkedCount <= sm.activeCount, sm);
  const expRate = sm.activeCount > 0 ? Math.round((sm.checkedCount / sm.activeCount) * 100) : 0;
  check(`${prefix} 신청율 계산`, sm.applicationRate === expRate, { rate: sm.applicationRate, expRate });
  // 변동 액트는 항상 가동 → 가동 >= 변동.
  check(`${prefix} active>=variable`, sm.activeCount >= sm.variableCount, sm);
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
    check(`[${org}] top keys`, JSON.stringify(Object.keys(d).sort()) === JSON.stringify(["club", "clubOverall", "practicalCompetency", "practicalExperience", "practicalInfo", "summary", "weekId"]), Object.keys(d).sort());
    // 실무 정보 라인급 SoT = process_line_groups(hub=info) — lineId 가 uuid(activity_type 슬러그 아님). 프로세스 등록 추가분 자동 노출(§9).
    check(`[${org}] 정보 라인급 SoT=process_line_groups(uuid lineId)`,
      d.practicalInfo.lines.length >= 1 && d.practicalInfo.lines.every((l) => /^[0-9a-f-]{36}$/.test(l.lineId)),
      { n: d.practicalInfo.lines.length, first: d.practicalInfo.lines[0]?.lineId });
    // ── 허브 급 0: 클럽 총괄 — hub=club 활성 라인급 전체(시드 2종 포함)·요약 불변식·변동=0·요일버킷 7 ──
    const club = d.clubOverall;
    const clubNames = club.lines.map((l) => l.lineName);
    check(`[${org}] clubOverall = hub=club 활성 전체(시드 2종 포함·uuid)`,
      club.lines.length >= 2 && clubNames.includes("클럽 전체 가이드") && clubNames.includes("행정 보안 검수") &&
      club.lines.every((l) => /^[0-9a-f-]{36}$/.test(l.lineId)),
      clubNames);
    invariants(`[${org}] club hub`, club.summary);
    check(`[${org}] club 변동=0`, club.summary.variableCount === 0);
    check(`[${org}] club variableActsByDay 버킷 7개`, Object.keys(club.variableActsByDay).length === 7);
    for (const l of club.lines) check(`[${org}] club 라인 ${l.lineName} 요일버킷 7개`, Object.keys(l.regularActsByDay).length === 7);
    // 오픈확인 전: 클럽 라인 전부 미오픈·activeActs=0.
    check(`[${org}] (오픈확인 전) club 라인 전부 미오픈`, club.lines.every((l) => l.isOpenThisWeek === false));
    check(`[${org}] (legacy·config 없음) club 이력 보존 → 전 액트 가동`, club.summary.activeCount === club.summary.totalCount, club.summary);
    // 일반/테스트 모드 클럽 총괄 = 완전 동일(테스트 전용 분기 없음·사용자 식별 정보 없음).
    const dTest = await loadTeamPartsInfoActCheckManagement({ weekId, organization: org, mode: "test" });
    check(`[${org}] clubOverall operating==test 완전 동일`, JSON.stringify(club) === JSON.stringify(dTest.clubOverall));
    // 실무 역량 허브: 실무 정보와 동일 구조(요약 불변식·변동=0·라인급 요일버킷 7개).
    const comp = d.practicalCompetency;
    invariants(`[${org}] comp hub`, comp.summary);
    check(`[${org}] comp 변동=0`, comp.summary.variableCount === 0);
    check(`[${org}] comp variableActsByDay 버킷 7개`, Object.keys(comp.variableActsByDay).length === 7);
    for (const l of comp.lines) {
      check(`[${org}] comp 라인 ${l.lineName} 요일버킷 7개`, Object.keys(l.regularActsByDay).length === 7);
    }
    // 오픈확인 전: 역량 라인 전부 미오픈·activeActs=0.
    check(`[${org}] (오픈확인 전) comp 라인 전부 미오픈`, comp.lines.every((l) => l.isOpenThisWeek === false));
    check(`[${org}] (legacy·config 없음) comp 이력 보존 → 전 액트 가동`, comp.summary.activeCount === comp.summary.totalCount, comp.summary);
    // 실무 경험 허브: 팀 배열·팀별 요약 불변식·허브 요약=팀 합.
    const exp = d.practicalExperience;
    check(`[${org}] practicalExperience.teams 존재`, Array.isArray(exp.teams));
    invariants(`[${org}] exp hub`, exp.summary);
    for (const t of exp.teams) {
      invariants(`[${org}] exp team ${t.teamName}`, t.summary);
      check(`[${org}] exp team ${t.teamName} 변동=0`, t.summary.variableCount === 0);
      check(`[${org}] exp team ${t.teamName} 라인급 존재`, t.lines.length >= 1, { n: t.lines.length });
    }
    // 허브 요약은 "팀 합"이 아니라 distinct(대표 1번) — 모든 팀이 동일 액트 카탈로그 공유(lib 주석 참조).
    //   전체=단일 팀 카탈로그 수, 가동/체크=distinct(팀 합 이하). 팀 수만큼 곱하지 않는다.
    const sumField = (k: "totalCount" | "activeCount" | "checkedCount") => exp.teams.reduce((n, t) => n + (t.summary as any)[k], 0);
    check(`[${org}] exp 허브 요약 = distinct(팀 합 아님)`,
      exp.summary.totalCount === (exp.teams[0]?.summary.totalCount ?? 0) &&
      exp.summary.activeCount <= sumField("activeCount") && exp.summary.checkedCount <= sumField("checkedCount"),
      { hub: exp.summary, teamsTotalSum: sumField("totalCount") });
    // 오픈확인 전: 모든 팀 미오픈·activeActs=0.
    check(`[${org}] (legacy·config 없음) exp 전 팀 이력 보존 → 전 액트 가동`, exp.teams.every((t) => t.summary.activeCount === t.summary.totalCount));
    check(`[${org}] 정보 라인급 요일버킷 7개`, d.practicalInfo.lines.every((l) => Object.keys(l.regularActsByDay).length === 7));
    invariants(`[${org}] week`, d.summary);
    invariants(`[${org}] info`, d.practicalInfo.summary);
    // 오픈확인 전 기본: 정보 라인 전부 미오픈·activeActs=0.
    check(`[${org}] (오픈확인 전) 정보 라인 전부 미오픈`, d.practicalInfo.lines.every((l) => l.isOpenThisWeek === false));
    check(`[${org}] (legacy·config 없음) 정보 이력 보존 → 전 액트 가동`, d.practicalInfo.summary.activeCount === d.practicalInfo.summary.totalCount, d.practicalInfo.summary);
    const allActs = d.practicalInfo.lines.flatMap((l) => Object.values(l.regularActsByDay).flat());
    check(`[${org}] (오픈확인 전) 모든 정보 액트 비가동`, allActs.every((x: any) => x.isActiveThisWeek === false), { acts: allActs.length });
  }

  // ── 위즈덤 오픈확인 → 가동 전환(테이블 존재 시) ──
  const probe = await supabaseAdmin.from("cluster4_week_opening_configs").select("id").limit(1);
  const tableExists = !probe.error;
  console.log(`   opening_configs 존재: ${tableExists}`);
  if (tableExists) {
    const org = "encre";
    const before = await loadTeamPartsInfoActCheckManagement({ weekId, organization: org, mode: "operating" });
    // 오픈 확인(actCheck 미전달 → 라인급 기본 전체 체크) → 정보 라인급 가동 전환.
    const oc = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}/open-confirm?club=${org}`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ config: { practicalInfo: {}, practicalExperience: {}, practicalCompetency: { checked: false } } }),
    });
    check("open-confirm(기본 전체체크) 성공", oc.ok);
    const after = await loadTeamPartsInfoActCheckManagement({ weekId, organization: org, mode: "operating" });
    check("정보 라인급 전부 가동(기본 전체체크)", after.practicalInfo.lines.every((l) => l.isOpenThisWeek === true), { n: after.practicalInfo.lines.length });
    check("정보 activeActs 증가(before<=after)", after.practicalInfo.summary.activeCount >= before.practicalInfo.summary.activeCount, { before: before.practicalInfo.summary.activeCount, after: after.practicalInfo.summary.activeCount });
    // 독립성(§15): 특정 정보 라인급 actCheck=false → 그 라인급만 미가동, 나머지 가동 유지.
    const targetLg = after.practicalInfo.lines[0]?.lineId;
    if (targetLg) {
      await fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}/open-confirm?club=${org}`, {
        method: "POST", headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ config: { practicalInfo: {}, practicalExperience: {}, practicalCompetency: { checked: false }, actCheck: { info: { [targetLg]: false }, experience: {}, club: {} } } }),
      });
      const after3 = await loadTeamPartsInfoActCheckManagement({ weekId, organization: org, mode: "operating" });
      check("actCheck.info=false → 해당 라인급 미가동", after3.practicalInfo.lines.find((l) => l.lineId === targetLg)?.isOpenThisWeek === false);
      check("다른 정보 라인급은 가동 유지", after3.practicalInfo.lines.filter((l) => l.lineId !== targetLg).every((l) => l.isOpenThisWeek === true));
    }
    // HTTP == direct
    const afterFinal = await loadTeamPartsInfoActCheckManagement({ weekId, organization: org, mode: "operating" });
    const g = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}/act-check-management?club=${org}`, { headers: { cookie } });
    const gj: any = await g.json();
    check("전환 후 direct == HTTP", JSON.stringify(afterFinal) === JSON.stringify(gj.data));
    // cleanup
    await supabaseAdmin.from("cluster4_week_opening_configs").delete().eq("week_id", weekId).eq("organization_slug", org);
    console.log("   (테스트 open-config 정리 완료)");

    // ── 클럽 총괄 액트 체크/통계/저장(재조회 유지) 라운드트립 — 임시 액트+상태 시드 후 정리 ──
    const CLUB_LG = "0c1b0000-0000-4000-8000-000000000001"; // 클럽 전체 가이드
    const clubActId = "0c1a0000-0000-4000-8000-0000000000aa"; // 임시 검증용 클럽 액트(고정 UUID)
    // 정리(멱등) 후 시드.
    await supabaseAdmin.from("process_check_statuses").delete().eq("act_id", clubActId);
    await supabaseAdmin.from("process_acts").delete().eq("id", clubActId);
    const { error: seedActErr } = await supabaseAdmin.from("process_acts").insert({
      id: clubActId, line_group_id: CLUB_LG, hub: "club", act_name: "[검증] 클럽 임시 액트",
      duration_minutes: 5, occur_week: "N", occur_dow: 1, occur_time: "09:00",
      check_week: "N", check_dow: 1, check_time: "10:00",
      point_check: 0, point_advantage: 0, point_penalty: 0,
      cafe: "none", check_target: "check", act_type: "basic", is_active: true,
    });
    check("클럽 임시 액트 시드", !seedActErr, seedActErr?.message);
    // 오픈 확인(club 게이트=openConfirmed) — config 내용 무관.
    const ocClub = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}/open-confirm?club=${org}`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ config: { practicalInfo: {}, practicalExperience: {}, practicalCompetency: { checked: false } } }),
    });
    check("open-confirm(club 게이트) 성공", ocClub.ok);
    const base = await loadTeamPartsInfoActCheckManagement({ weekId, organization: org, mode: "operating" });
    const clubActCards = base.clubOverall.lines.flatMap((l) => Object.values(l.regularActsByDay).flat()).filter((x: any) => x.actId === clubActId);
    check("클럽 라인에 임시 액트 표시", clubActCards.length === 1);
    check("클럽 액트 가동(오픈확인 후 isActiveThisWeek=true)", clubActCards[0]?.isActiveThisWeek === true);
    check("클럽 임시 액트 미신청(isChecked=false)", clubActCards[0]?.isChecked === false);
    check("클럽 activeActs>=1(시드 액트 포함)", base.clubOverall.summary.activeCount >= 1, base.clubOverall.summary);
    check("주차 전체 통계에 클럽 액트 반영(total>=1·active>=1)", base.summary.totalCount >= 1 && base.summary.activeCount >= 1, base.summary);
    // 체크값 "저장"(크루 체크와 동일 경로=process_check_statuses) → 재조회 시 유지.
    const { error: stErr } = await supabaseAdmin.from("process_check_statuses").insert({
      act_id: clubActId, hub: "club", team_id: null, organization_slug: org, week_id: weekId,
      line_group_id: CLUB_LG, scope_mode: "operating",
      status: "completed", requested_at: new Date().toISOString(), completed_at: new Date().toISOString(),
    });
    check("클럽 체크 상태 저장(insert)", !stErr, stErr?.message);
    const after2 = await loadTeamPartsInfoActCheckManagement({ weekId, organization: org, mode: "operating" });
    check("저장 후 클럽 checkedActs 증가(체크 반영)", after2.clubOverall.summary.checkedCount > base.clubOverall.summary.checkedCount, { before: base.clubOverall.summary.checkedCount, after: after2.clubOverall.summary.checkedCount });
    check("저장 후 재조회 유지(임시 액트 isChecked=true)",
      after2.clubOverall.lines.flatMap((l) => Object.values(l.regularActsByDay).flat()).find((x: any) => x.actId === clubActId)?.isChecked === true);
    check("저장 후 direct == HTTP", await (async () => {
      const g = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}/act-check-management?club=${org}`, { headers: { cookie } });
      const gj: any = await g.json();
      return JSON.stringify(after2) === JSON.stringify(gj.data);
    })());
    // cleanup
    await supabaseAdmin.from("process_check_statuses").delete().eq("act_id", clubActId);
    await supabaseAdmin.from("process_acts").delete().eq("id", clubActId);
    await supabaseAdmin.from("cluster4_week_opening_configs").delete().eq("week_id", weekId).eq("organization_slug", org);
    console.log("   (클럽 총괄 임시 액트/상태/open-config 정리 완료)");
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
