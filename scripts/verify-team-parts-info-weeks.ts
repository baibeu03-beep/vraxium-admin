/**
 * 클럽 정보 > 주차 내역 검증 (dev server 필요).
 *   1) direct 함수(loadTeamPartsInfoWeeks) 결과
 *   2) HTTP API(/api/admin/team-parts/info/weeks) 응답 (관리자 세션 쿠키)
 *   3) direct == HTTP 동치
 *   4) snapshot 영향 여부: 고객 weekly-card snapshot(cluster4_weekly_card_snapshots) 무변경
 *   5) snapshot 재계산 필요 없음(조회 전용 — write 경로 없음)
 *   6) 통합(club=all) 준비중 400 / 잘못된 club 400
 *
 *   선행: npm run dev (:3000)
 *   npx tsx --env-file=.env.local scripts/verify-team-parts-info-weeks.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ORGANIZATIONS } from "@/lib/organizations";
import { loadTeamPartsInfoWeeks } from "@/lib/adminTeamPartsInfoWeeksData";

const BASE = process.env.ADMIN_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const s = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
  if (!ok) failed++;
}

// 활성 관리자 → magiclink OTP → 세션 쿠키 캡처(브라우저 세션 재현).
async function adminCookieHeader(): Promise<string> {
  const { data: adm } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const email = (adm?.[0] as { email: string } | undefined)?.email;
  if (!email) throw new Error("활성 관리자 없음");
  const A = createClient(u, s);
  const N = createClient(u, a);
  const { data: l } = await A.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await N.auth.verifyOtp({
    email,
    token: (l as any).properties.email_otp,
    type: "magiclink",
  });
  const cap: { name: string; value: string }[] = [];
  const sv = createServerClient(u, a, {
    cookies: {
      getAll: () => [],
      setAll: (items) => cap.push(...items.map(({ name, value }: any) => ({ name, value }))),
    },
  });
  await sv.auth.setSession({
    access_token: (v as any).session.access_token,
    refresh_token: (v as any).session.refresh_token,
  });
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function snapshotFingerprint() {
  const { count } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("*", { count: "exact", head: true });
  const { data } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("updated_at")
    .order("updated_at", { ascending: false })
    .limit(1);
  return { count: count ?? 0, latest: (data?.[0] as { updated_at: string } | undefined)?.updated_at ?? null };
}

async function main() {
  // dev server 확인.
  try {
    const h = await fetch(`${BASE}/api/health`);
    check("dev server 응답", h.ok, { base: BASE });
  } catch {
    console.log(`❌ dev server 미기동(${BASE}). npm run dev 후 재실행.`);
    process.exit(2);
  }

  const cookie = await adminCookieHeader();

  const snapBefore = await snapshotFingerprint();

  // info-only 기준선(개정 전 산식) — 개정 후 전체 라인/전체 액트가 이보다 커야 한다.
  const { count: infoActsBase } = await supabaseAdmin
    .from("process_acts").select("*", { count: "exact", head: true })
    .eq("hub", "info").eq("is_active", true);
  const { count: infoLineSlots } = await supabaseAdmin
    .from("activity_types").select("*", { count: "exact", head: true })
    .eq("cluster_id", "practical_info").eq("is_active", true);
  console.log(`   baseline(info-only): acts=${infoActsBase ?? 0} lineSlots=${infoLineSlots ?? 0}`);
  const newTotals: Record<string, { totalActs: number; totalLines: number }> = {};

  for (const org of ORGANIZATIONS) {
    const direct = await loadTeamPartsInfoWeeks({ organization: org, page: 1, pageSize: 20 });

    const res = await fetch(
      `${BASE}/api/admin/team-parts/info/weeks?club=${org}&page=1&pageSize=20`,
      { headers: { cookie }, cache: "no-store" },
    );
    const json: any = await res.json();
    check(`[${org}] HTTP 200 · success`, res.ok && json?.success === true, { status: res.status });
    const http = json?.data;

    // 오늘 경계로 direct/HTTP 의 todayLabel·현재주차가 갈릴 수 있어 두 번 비교(구조/값).
    const dEq = JSON.stringify(direct) === JSON.stringify(http);
    check(`[${org}] direct == HTTP`, dEq, dEq ? { items: direct.items.length } : {
      directItems: direct.items.length,
      httpItems: http?.items?.length,
      directCur: direct.currentWeek,
      httpCur: http?.currentWeek,
    });

    // 페이지네이션·아이템 형상 확인.
    check(`[${org}] pageSize=20 · items<=20`, (http?.items?.length ?? 99) <= 20, { items: http?.items?.length });
    const first = http?.items?.[0];
    if (first) {
      const keys = Object.keys(first).sort().join(",");
      check(`[${org}] item DTO 키 정합(필드명 불변)`, keys === [
        "actCheckRate", "activeActs", "clubActivityStatus", "isCurrentWeek", "lineOpenRate",
        "openLines", "totalActs", "totalLines", "weekName", "weekReviewed", "weekId",
      ].sort().join(","), { keys });
      newTotals[org] = { totalActs: first.totalActs, totalLines: first.totalLines };
      // 개정 후 값이 info-only 기준선 이상(라인은 최소 info 9 슬롯 포함).
      check(`[${org}] totalActs >= info-only baseline`, first.totalActs >= (infoActsBase ?? 0), { totalActs: first.totalActs, baseline: infoActsBase });
      check(`[${org}] totalLines >= info 슬롯(${infoLineSlots ?? 0})`, first.totalLines >= (infoLineSlots ?? 0), { totalLines: first.totalLines });
      // 개설율/체크율 ≤100% 보장.
      const badRate = (http.items as any[]).find((it) => it.actCheckRate > 100 || it.lineOpenRate > 100);
      check(`[${org}] 모든 주차 체크율·개설율 ≤100%`, !badRate, badRate ? { weekName: badRate.weekName, actCheckRate: badRate.actCheckRate, lineOpenRate: badRate.lineOpenRate } : undefined);
    }
  }

  // 전체 허브 합산이 info-only 보다 실제로 늘었는가(experience/competency 반영 확인).
  //   3개 org 중 최소 하나는 totalLines>info슬롯 또는 totalActs>info액트 여야 한다(운영 시드=oranke 마스터 다수).
  const anyLineIncrease = ORGANIZATIONS.some((o) => (newTotals[o]?.totalLines ?? 0) > (infoLineSlots ?? 0));
  const anyActIncrease = ORGANIZATIONS.some((o) => (newTotals[o]?.totalActs ?? 0) > (infoActsBase ?? 0));
  check("전체 라인 수가 info-only 보다 증가(experience/competency 포함)", anyLineIncrease, { newTotals, infoLineSlots });
  check("전체 액트 수가 info-only 보다 증가(라인 허브 전체 포함)", anyActIncrease, { newTotals, infoActsBase });

  // 통합/잘못된 club → 400.
  {
    const r1 = await fetch(`${BASE}/api/admin/team-parts/info/weeks?club=all`, { headers: { cookie } });
    check("club=all → 400(준비중)", r1.status === 400);
    const r2 = await fetch(`${BASE}/api/admin/team-parts/info/weeks?club=nope`, { headers: { cookie } });
    check("club=invalid → 400", r2.status === 400);
  }

  const snapAfter = await snapshotFingerprint();
  check("고객 weekly-card snapshot 무변경(count)", snapBefore.count === snapAfter.count, { before: snapBefore.count, after: snapAfter.count });
  check("고객 weekly-card snapshot 무변경(latest updated_at)", snapBefore.latest === snapAfter.latest, { before: snapBefore.latest, after: snapAfter.latest });

  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
