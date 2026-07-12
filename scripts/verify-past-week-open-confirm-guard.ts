/**
 * 활동 관리(상세) — 과거 주차 [오픈 확인] 재확인 모달 게이트 검증 (dev server 필요).
 *
 *   이번 작업의 서버측 변경은 DTO 에 `managedWeek.weekPhase`("past"|"current"|"future") 를
 *   추가한 것뿐이다(저장/N/검수/포인트/snapshot 로직 무변경). 모달 자체는 클라이언트 UI 게이트다.
 *   따라서 여기서는 다음을 HTTP + direct 로 검증한다:
 *     1) dev server 응답
 *     2) weekPhase 판정이 공통 주차 판정(loadSeasonWeeks.is_current_week + 종료일<오늘)과 일치
 *     3) direct(loadTeamPartsInfoWeekDetail) == HTTP GET  (라우트가 동일 lib 호출)
 *     4) operating 과 test 가 동일 URL·method·동일 weekPhase (모드로 갈라지지 않음)
 *     5) 서로 다른 조직 2개 이상에서 weekPhase 동일(org 무관 — 주차 진행단계는 조직 독립)
 *     6) open-confirm/DTO 응답 형태 불변(weekRecognitionCount 필드 유지) — 회귀 없음
 *
 *   npx tsx --env-file=.env.local scripts/verify-past-week-open-confirm-guard.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ORGANIZATIONS } from "@/lib/organizations";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
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

// 공통 판정 재현(스크립트 자체 검산용) — lib 과 동일 규칙.
function expectedPhase(r: { is_current_week: boolean; week_end_date: string | null }, today: string): "past" | "current" | "future" {
  if (r.is_current_week) return "current";
  if (r.week_end_date != null && r.week_end_date < today) return "past";
  return "future";
}

async function main() {
  try {
    const h = await fetch(`${BASE}/api/health`);
    check("dev server 응답", h.ok, { base: BASE });
  } catch {
    console.log(`❌ dev server 미기동(${BASE}).`); process.exit(2);
  }
  const cookie = await adminCookieHeader();
  const today = getCurrentActivityDateIso();
  console.log(`   today(activity) = ${today}`);

  const { rows } = await loadSeasonWeeks();
  const past = rows.find((r) => !r.is_current_week && r.week_end_date != null && r.week_end_date < today && r.week_start_date);
  const current = rows.find((r) => r.is_current_week);
  const future = rows.find((r) => !r.is_current_week && r.week_start_date != null && r.week_start_date > today);

  check("샘플 주차 확보(past/current/future 중 최소 past)", !!past, {
    past: past?.week_label, current: current?.week_label, future: future?.week_label,
  });

  const samples = [
    { kind: "past", row: past },
    { kind: "current", row: current },
    { kind: "future", row: future },
  ].filter((x) => x.row) as { kind: string; row: NonNullable<typeof past> }[];

  const orgs = ORGANIZATIONS.slice(0, 2); // 서로 다른 조직 2개
  for (const { kind, row } of samples) {
    const weekId = row.week_id;
    const want = expectedPhase(row, today);
    console.log(`\n── [${kind}] ${row.week_label} (${row.week_start_date}~${row.week_end_date}) expect weekPhase=${want}`);

    const phasePerOrgMode: Record<string, string> = {};
    for (const org of orgs) {
      for (const mode of ["operating", "test"] as const) {
        // direct
        const direct = await loadTeamPartsInfoWeekDetail({ weekId, organization: org, mode });
        // HTTP — operating/test 동일 URL(모드만 쿼리)·동일 method(GET)
        const url = `${BASE}/api/admin/team-parts/info/weeks/${weekId}?club=${org}${mode === "test" ? "&mode=test" : ""}`;
        const res = await fetch(url, { headers: { cookie }, cache: "no-store" });
        const json: any = await res.json();
        check(`[${kind}/${org}/${mode}] HTTP 200·success`, res.ok && json?.success === true, { status: res.status });
        // weekPhase 판정 == 공통 판정
        check(`[${kind}/${org}/${mode}] weekPhase=${want}`, direct.managedWeek.weekPhase === want, { got: direct.managedWeek.weekPhase });
        // direct == HTTP
        const eq = JSON.stringify(direct) === JSON.stringify(json?.data);
        check(`[${kind}/${org}/${mode}] direct == HTTP`, eq);
        // 응답 형태 불변 — weekRecognitionCount 필드 유지(회귀 없음)
        check(`[${kind}/${org}/${mode}] managedWeek 필드 불변(weekRecognitionCount 존재)`,
          "weekRecognitionCount" in direct.managedWeek && "openConfirmed" in direct.managedWeek);
        phasePerOrgMode[`${org}/${mode}`] = direct.managedWeek.weekPhase;
      }
    }
    // operating == test, org 무관 — 모두 동일 weekPhase
    const uniq = new Set(Object.values(phasePerOrgMode));
    check(`[${kind}] weekPhase 가 org·mode 무관 동일(${want})`, uniq.size === 1 && uniq.has(want), phasePerOrgMode);
  }

  console.log(`\n${failed === 0 ? "🎉 ALL PASS" : `❌ ${failed} FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
