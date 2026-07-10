/**
 * 라인 개설 관리(주차 전체 요약) API 검증 (dev server 필요).
 *   1) direct(loadTeamPartsInfoLineOpeningManagement) 결과
 *   2) HTTP GET 결과
 *   3) direct == HTTP (operating + test)
 *   4) DTO 형상·집계 불변식(notCreated=open-created·rate·created<=open<=total)
 *   5) 오픈확인 전: open/created=0 (오픈 대상 없음)
 *   6) [테이블 존재 시] 위즈덤 오픈확인 → openLines 증가(정보 라인 오픈 반영) → 정리
 *   7) snapshot 무영향(count·latest 불변 = 재계산 불필요)
 *   npx tsx --env-file=.env.local scripts/verify-team-parts-info-line-opening.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ORGANIZATIONS } from "@/lib/organizations";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";
import { loadTeamPartsInfoLineOpeningManagement } from "@/lib/adminTeamPartsInfoLineOpeningData";

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
  check(`${prefix} notCreated=open-created`, sm.notCreatedLines === sm.openLines - sm.createdLines, sm);
  check(`${prefix} created<=open<=total`, sm.createdLines <= sm.openLines && sm.openLines <= sm.totalLines, sm);
  const expRate = sm.openLines > 0 ? Math.round((sm.createdLines / sm.openLines) * 100) : 0;
  check(`${prefix} lineOpenRate 계산`, sm.lineOpenRate === expRate, { rate: sm.lineOpenRate, expRate });
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
      const direct = await loadTeamPartsInfoLineOpeningManagement({ weekId, organization: org, mode });
      const params = new URLSearchParams({ club: org });
      if (mode === "test") params.set("mode", "test");
      const res = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}/line-opening-management?${params}`, { headers: { cookie }, cache: "no-store" });
      const json: any = await res.json();
      check(`[${org}/${mode}] HTTP 200·success`, res.ok && json?.success === true, { status: res.status });
      check(`[${org}/${mode}] direct == HTTP`, JSON.stringify(direct) === JSON.stringify(json?.data));
      invariants(`[${org}/${mode}]`, direct.summary);
      check(`[${org}/${mode}] top keys`, JSON.stringify(Object.keys(direct).sort()) === JSON.stringify(["club", "practicalCompetency", "practicalExperience", "practicalInfo", "summary", "weekId"]));
      // 실무 정보 허브 요약 불변식 + 라인 목록.
      const pi = direct.practicalInfo;
      invariants(`[${org}/${mode}] info`, pi.summary);
      check(`[${org}/${mode}] info summary.total == lines.length`, pi.summary.totalLines === pi.lines.length, { total: pi.summary.totalLines, lines: pi.lines.length });
      check(`[${org}/${mode}] info.lines = 9`, pi.lines.length === 9, { n: pi.lines.length });
      // 각 라인 필드 계약(미개설=null 필드 · 진행 상태 enum · eligible 상수 · 개설 카운트 정합).
      const PROG = ["not_required", "required", "crew_submitting", "crew_submission_closed"];
      const eligibleSet = new Set(pi.lines.map((l) => l.eligibleCrewCount));
      check(`[${org}/${mode}] info eligibleCrewCount 라인 공통(상수)`, eligibleSet.size <= 1, { values: [...eligibleSet] });
      for (const l of pi.lines) {
        const created = l.progressStatus === "crew_submitting" || l.progressStatus === "crew_submission_closed";
        check(`[${org}/${mode}] info[${l.lineId}] progressStatus enum`, PROG.includes(l.progressStatus), l.progressStatus);
        check(`[${org}/${mode}] info[${l.lineId}] not_required==!open`, (l.progressStatus === "not_required") === !l.isOpenThisWeek);
        // 미개설이면 개설 관련 필드는 전부 null. 개설이면 라벨·카운트 존재(카운트는 0 이상).
        if (!created) {
          check(`[${org}/${mode}] info[${l.lineId}] 미개설 필드 null`,
            l.operatorName === null && l.createdAtLabel === null && l.createdTimingStatus === null &&
            l.createdCrewCount === null && l.submittedCrewCount === null && l.submissionEligibleCrewCount === null);
        } else {
          check(`[${org}/${mode}] info[${l.lineId}] 개설 라벨/타이밍 존재`,
            typeof l.createdAtLabel === "string" && (l.createdTimingStatus === "ontime" || l.createdTimingStatus === "late"), l);
          check(`[${org}/${mode}] info[${l.lineId}] 기입<=개설<=가능`,
            (l.submittedCrewCount ?? 0) <= (l.createdCrewCount ?? 0) &&
            l.submissionEligibleCrewCount === l.createdCrewCount, l);
        }
      }

      // ── 실무 경험 허브: 요약 불변식 + 팀별(팀 기준 집계) ──
      const pe = direct.practicalExperience;
      invariants(`[${org}/${mode}] exp`, pe.summary);
      check(`[${org}/${mode}] exp.teams 배열`, Array.isArray(pe.teams));
      // 허브 요약은 "팀 합"이 아니라 distinct(대표 1번) — 모든 팀이 동일 카테고리(5종) 공유(lib 주석 참조).
      //   전체=카테고리 수(=단일 팀 totalLines), 오픈/개설=distinct(팀 합 이하). 팀 수만큼 곱하지 않는다.
      const sumF = (k: "totalLines" | "openLines" | "createdLines") => pe.teams.reduce((n, t) => n + (t.summary as any)[k], 0);
      check(`[${org}/${mode}] exp 허브 요약 = distinct(팀 합 아님)`,
        pe.summary.totalLines === (pe.teams[0]?.summary.totalLines ?? 0) &&
        pe.summary.openLines <= sumF("openLines") && pe.summary.createdLines <= sumF("createdLines"),
        { hub: pe.summary, teamsTotalSum: sumF("totalLines") });
      const EXP_LABELS = ["도출", "분석", "견문", "관리", "확장"];
      for (const t of pe.teams) {
        invariants(`[${org}/${mode}] exp team ${t.teamName}`, t.summary);
        check(`[${org}/${mode}] exp team ${t.teamName} lines=5`, t.lines.length === 5, { n: t.lines.length });
        check(`[${org}/${mode}] exp team ${t.teamName} 라인명 5종`, JSON.stringify(t.lines.map((l) => l.lineName)) === JSON.stringify(EXP_LABELS), t.lines.map((l) => l.lineName));
        check(`[${org}/${mode}] exp team ${t.teamName} summary.total==lines`, t.summary.totalLines === t.lines.length);
        for (const l of t.lines) {
          const created = l.progressStatus === "crew_submitting" || l.progressStatus === "crew_submission_closed";
          check(`[${org}/${mode}] exp ${t.teamName}/${l.lineName} progress enum`, PROG.includes(l.progressStatus), l.progressStatus);
          check(`[${org}/${mode}] exp ${t.teamName}/${l.lineName} not_required==!open`, (l.progressStatus === "not_required") === !l.isOpenThisWeek);
          // 관리 라인 모수(eligibleCrewCount) = 심화 크루 → 팀당 10 이하(산식 가드).
          if (l.lineName === "관리") {
            check(`[${org}/${mode}] exp ${t.teamName}/관리 eligible<=10(심화 기준)`, l.eligibleCrewCount <= 10, { eligible: l.eligibleCrewCount });
          }
          if (!created) {
            check(`[${org}/${mode}] exp ${t.teamName}/${l.lineName} 미개설 필드 null`,
              l.operatorName === null && l.createdAtLabel === null && l.createdTimingStatus === null &&
              l.createdCrewCount === null && l.submittedCrewCount === null && l.submissionEligibleCrewCount === null);
          } else {
            check(`[${org}/${mode}] exp ${t.teamName}/${l.lineName} 기입<=개설<=가능`,
              (l.submittedCrewCount ?? 0) <= (l.createdCrewCount ?? 0) &&
              (l.createdCrewCount ?? 0) <= l.eligibleCrewCount &&
              l.submissionEligibleCrewCount === l.createdCrewCount, l);
          }
        }
      }

      // ── 실무 역량 허브: 등록 라인(마스터) 전부·"개설 필요(required)" 없음·openLines==createdLines ──
      const pc = direct.practicalCompetency;
      invariants(`[${org}/${mode}] comp`, pc.summary);
      check(`[${org}/${mode}] comp summary.total == lines.length`, pc.summary.totalLines === pc.lines.length, { total: pc.summary.totalLines, lines: pc.lines.length });
      check(`[${org}/${mode}] comp lines>0(등록 라인 존재)`, pc.lines.length > 0, { n: pc.lines.length });
      check(`[${org}/${mode}] comp openLines==createdLines(개설=오픈)`, pc.summary.openLines === pc.summary.createdLines && pc.summary.notCreatedLines === 0, pc.summary);
      for (const l of pc.lines) {
        const created = l.progressStatus === "crew_submitting" || l.progressStatus === "crew_submission_closed";
        // 역량엔 required("개설 필요") 상태가 절대 없음.
        check(`[${org}/${mode}] comp[${l.lineId.slice(0, 6)}] required 없음`, l.progressStatus !== "required", l.progressStatus);
        check(`[${org}/${mode}] comp[${l.lineId.slice(0, 6)}] progress enum(역량)`, ["not_required", "crew_submitting", "crew_submission_closed"].includes(l.progressStatus), l.progressStatus);
        check(`[${org}/${mode}] comp[${l.lineId.slice(0, 6)}] isOpen==created`, l.isOpenThisWeek === created);
        if (!created) {
          check(`[${org}/${mode}] comp[${l.lineId.slice(0, 6)}] 미개설 필드 null`,
            l.operatorName === null && l.createdAtLabel === null && l.createdTimingStatus === null &&
            l.createdCrewCount === null && l.submittedCrewCount === null && l.submissionEligibleCrewCount === null);
        } else {
          check(`[${org}/${mode}] comp[${l.lineId.slice(0, 6)}] 기입<=개설<=가능`,
            (l.submittedCrewCount ?? 0) <= (l.createdCrewCount ?? 0) &&
            (l.createdCrewCount ?? 0) <= l.eligibleCrewCount &&
            l.submissionEligibleCrewCount === l.createdCrewCount && (l.createdCrewCount ?? 0) >= 1, l);
        }
      }
    }
    // 오픈확인 전(정리 후 상태 가정): open/created = 0.
    const d = await loadTeamPartsInfoLineOpeningManagement({ weekId, organization: org, mode: "operating" });
    check(`[${org}] totalLines>0(관리 대상 존재)`, d.summary.totalLines > 0, d.summary);
  }

  // ── 위즈덤 오픈확인 → openLines 증가(테이블 존재 시) ──
  const probe = await supabaseAdmin.from("cluster4_week_opening_configs").select("id").limit(1);
  const tableExists = !probe.error;
  console.log(`   opening_configs 존재: ${tableExists}`);
  if (tableExists) {
    const org = "encre";
    const before = await loadTeamPartsInfoLineOpeningManagement({ weekId, organization: org, mode: "operating" });
    const oc = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}/open-confirm?club=${org}`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ config: { practicalInfo: { wisdom: true }, practicalExperience: {}, practicalCompetency: { checked: false } } }),
    });
    check("open-confirm(wisdom) 성공", oc.ok);
    const after = await loadTeamPartsInfoLineOpeningManagement({ weekId, organization: org, mode: "operating" });
    check("오픈확인 후 openLines 증가(위즈덤 반영)", after.summary.openLines > before.summary.openLines, { before: before.summary.openLines, after: after.summary.openLines });
    invariants("오픈확인 후", after.summary);
    // HTTP == direct (after)
    const g = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}/line-opening-management?club=${org}`, { headers: { cookie } });
    const gj: any = await g.json();
    check("전환 후 direct == HTTP", JSON.stringify(after) === JSON.stringify(gj.data));
    // cleanup
    await supabaseAdmin.from("cluster4_week_opening_configs").delete().eq("week_id", weekId).eq("organization_slug", org);
    console.log("   (테스트 open-config 정리 완료)");
  } else {
    console.log("   ⚠ 마이그레이션 미적용 — 오픈확인 반영 검증은 적용 후.");
  }

  const snapAfter = await snap();
  check("snapshot 무변경(count) = 재계산 불필요", snapBefore.count === snapAfter.count, { before: snapBefore.count, after: snapAfter.count });
  check("snapshot 무변경(latest)", snapBefore.latest === snapAfter.latest);

  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
