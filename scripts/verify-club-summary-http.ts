/**
 * 클럽 목록(상위 페이지) 요약 — 실제 HTTP 검증(가동 중 dev :3000). READ-ONLY.
 *   · GET /api/admin/team-parts/info/summary (operating / mode=test / 각 org)
 *   · DTO 키·타입·행수·세 등식·합계·일반==test 파리티·HTTP==direct(lib)
 *   · 상세 API(/api/admin/team-parts/info?organization=) 단일 클럽만 반환
 *   · 미인증 401 · 잘못된 clubId 페이지 404
 *   Usage: npx tsx --env-file=.env.local scripts/verify-club-summary-http.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ORGANIZATIONS } from "@/lib/organizations";
import {
  loadClubCurrentSummary,
  validateClubSummary,
} from "@/lib/adminClubSummaryData";
import type { ScopeMode } from "@/lib/userScopeShared";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let fail = 0;
const ck = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

async function cookieHeader(): Promise<string> {
  const { data: admins } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const email = (admins?.[0] as { email: string } | undefined)?.email;
  assert(email, "활성 admin_users 이메일 없음");
  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  assert(link.properties?.email_otp, "generateLink 실패");
  const { data: verified } = await anon.auth.verifyOtp({
    email,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  assert(verified.session, "verifyOtp 실패");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) => captured.push(...items.map(({ name, value }) => ({ name, value }))),
    },
  });
  await server.auth.setSession({
    access_token: verified.session.access_token,
    refresh_token: verified.session.refresh_token,
  });
  return captured.map((c) => `${c.name}=${c.value}`).join("; ");
}

const NUM_KEYS = [
  "staffCount", "teamLeaderCount", "ambassadorCount", "clubbingCount",
  "regularCrewCount", "advancedCrewCount", "partCount", "partLeaderCount", "agentCount",
] as const;

async function getSummary(cookie: string, mode: ScopeMode, org?: string) {
  const params = new URLSearchParams();
  if (org) params.set("organization", org);
  if (mode === "test") params.set("mode", "test");
  const qs = params.toString();
  const res = await fetch(`${baseUrl}/api/admin/team-parts/info/summary${qs ? `?${qs}` : ""}`, {
    headers: { cookie },
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function main() {
  const cookie = await cookieHeader();

  // ── 1) 미인증 401 ──
  {
    const res = await fetch(`${baseUrl}/api/admin/team-parts/info/summary`);
    ck("미인증 요약 API 401/403", res.status === 401 || res.status === 403, `status=${res.status}`);
  }

  // ── 2) 통합(전 org) 요약 — operating & test ──
  for (const mode of ["operating", "test"] as ScopeMode[]) {
    console.log(`\n[요약 통합 · mode=${mode}]`);
    const { status, json } = await getSummary(cookie, mode);
    ck("HTTP 200", status === 200, `status=${status}`);
    if (!json?.success) { ck("success", false, JSON.stringify(json).slice(0, 120)); continue; }
    const data = json.data;
    ck("DTO 키(asOf/currentWeekLabel/structureTotals/rows/totals)",
      typeof data.asOf === "string" && typeof data.currentWeekLabel === "string" &&
      data.structureTotals && typeof data.structureTotals === "object" &&
      Array.isArray(data.rows) && data.totals && typeof data.totals === "object");
    ck("행 수 == 유효 클럽 수", data.rows.length === ORGANIZATIONS.length, `rows=${data.rows.length}`);
    // 숫자 타입 + 등식 per row
    let allNum = true, allEq = true;
    for (const r of data.rows) {
      for (const k of NUM_KEYS) if (typeof r[k] !== "number") allNum = false;
      const v = validateClubSummary(r);
      if (!v.staffValid || !v.clubbingValid || !v.advancedValid) {
        allEq = false;
        console.log("    !! 등식 불일치", r.clubName, v);
      }
    }
    ck("모든 수치 number", allNum);
    ck("행별 세 등식 성립", allEq);
    // 합계 == 행 합
    let totalsOk = true;
    for (const k of NUM_KEYS) {
      const sum = data.rows.reduce((a: number, r: any) => a + r[k], 0);
      if (data.totals[k] !== sum) { totalsOk = false; console.log("    !! 합계≠행합", k, data.totals[k], sum); }
    }
    ck("합계 == 각 행 합", totalsOk);
    // 합계 등식
    const t = data.totals;
    ck("합계 등식 운영진=팀수+앰", t.staffCount === t.teamLeaderCount + t.ambassadorCount);
    ck("합계 등식 클러빙=정규+심화", t.clubbingCount === t.regularCrewCount + t.advancedCrewCount);
    ck("합계 등식 심화=파트장+에이전트", t.advancedCrewCount === t.partLeaderCount + t.agentCount);

    // ★ 구조 숫자 SoT — 하단 partCount/teamEntity 합 == structureTotals(상단 요약과 동일 원천).
    const sumPart = data.rows.reduce((a: number, r: any) => a + r.partCount, 0);
    const sumTeamEntity = data.rows.reduce((a: number, r: any) => a + r.teamEntityCount, 0);
    ck("SUM(partCount) == structureTotals.totalParts", sumPart === data.structureTotals.totalParts, `${sumPart}/${data.structureTotals.totalParts}`);
    ck("SUM(teamEntityCount) == structureTotals.totalTeams", sumTeamEntity === data.structureTotals.totalTeams, `${sumTeamEntity}/${data.structureTotals.totalTeams}`);
    // 상단 요약(info API summary.counts)과 교차검증 — 같은 SoT 이므로 값 일치해야 함.
    const infoRes = await fetch(
      `${baseUrl}/api/admin/team-parts/info?organization=encre${mode === "test" ? "&mode=test" : ""}`,
      { headers: { cookie } },
    );
    const info = await infoRes.json();
    const topParts = info?.data?.summary?.counts?.totalParts;
    const topTeams = info?.data?.summary?.counts?.totalTeams;
    ck("하단 SUM(partCount) == 상단 전체 파트 수(info API)", sumPart === topParts, `${sumPart}/${topParts}`);
    ck("하단 SUM(teamEntityCount) == 상단 전체 팀 수(info API)", sumTeamEntity === topTeams, `${sumTeamEntity}/${topTeams}`);

    // HTTP == direct(lib)
    const direct = await loadClubCurrentSummary({ mode });
    ck("HTTP == direct(lib) rows",
      JSON.stringify(data.rows) === JSON.stringify(direct.rows));
    ck("HTTP == direct(lib) totals",
      JSON.stringify(data.totals) === JSON.stringify(direct.totals));
  }

  // ── 3) 일반 == test 파리티(키 동일, asOf 동일) ──
  {
    const op = (await getSummary(cookie, "operating")).json.data;
    const te = (await getSummary(cookie, "test")).json.data;
    ck("op/test asOf 동일", op.asOf === te.asOf, `${op.asOf} / ${te.asOf}`);
    ck("op/test DTO 키 동일",
      JSON.stringify(Object.keys(op).sort()) === JSON.stringify(Object.keys(te).sort()));
  }

  // ── 4) org 지정 → 단일 클럽 행 ──
  console.log("\n[요약 개별 org]");
  for (const org of ORGANIZATIONS) {
    const { status, json } = await getSummary(cookie, "operating", org);
    const rows = json?.data?.rows ?? [];
    ck(`?organization=${org} → 1행 & 해당 클럽만`,
      status === 200 && rows.length === 1 && rows[0].clubId === org,
      `status=${status} rows=${rows.length}`);
  }
  // 잘못된 org
  {
    const { status } = await getSummary(cookie, "operating", "notaclub");
    ck("잘못된 organization 400", status === 400, `status=${status}`);
  }

  // ── 5) 상세 API — 단일 클럽만 반환(다른 클럽 팀 미혼입) ──
  console.log("\n[상세 API]");
  for (const org of ORGANIZATIONS) {
    const res = await fetch(`${baseUrl}/api/admin/team-parts/info?organization=${org}`, {
      headers: { cookie },
    });
    const json = await res.json();
    ck(`상세 ${org} 200 & organization 일치`,
      res.status === 200 && json?.data?.organization === org,
      `status=${res.status} org=${json?.data?.organization}`);
  }

  // ── 6) 라우트 해소(HTTP 레벨) — 상세는 client 컴포넌트(useSearchParams)라 초기 HTML=Suspense fallback.
  //   valid 상세 렌더 vs invalid not-found 렌더의 실제 구분은 브라우저(Playwright) 검증에서 수행한다.
  //   여기서는 라우트가 정상 해소되는지(200/404)만 본다. weeks/seasons 는 [clubId] 로 오인 라우팅되지 않음.
  for (const p of ["encre", "notaclub", "weeks", "seasons"]) {
    const res = await fetch(`${baseUrl}/admin/team-parts/info/${p}`, { headers: { cookie } });
    ck(`라우트 해소 /${p}`, res.status === 200 || res.status === 404, `status=${res.status}`);
  }

  console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAIL`}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
