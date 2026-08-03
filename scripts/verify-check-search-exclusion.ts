/**
 * irregular/info/competency/club/experience 수동부여 검색이 시즌휴식/활동중단을 제외하는지
 * 실제 HTTP로 확인한다. READ-ONLY. Usage: npx tsx --env-file=.env.local scripts/_verify-check-search-exclusion.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const baseUrl = "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let fail = 0;
const ck = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function cookieHeader(): Promise<string> {
  const { data: admins } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const email = (admins?.[0] as { email: string }).email;
  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const { data: verified } = await anon.auth.verifyOtp({
    email,
    token: link.properties!.email_otp,
    type: "magiclink",
  });
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items.map(({ name, value }) => ({ name, value }))) },
  });
  await server.auth.setSession({
    access_token: verified.session!.access_token,
    refresh_token: verified.session!.refresh_token,
  });
  return captured.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function search(cookie: string, params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${baseUrl}/api/admin/cluster4/cafe-line-crew?${qs}`, { headers: { cookie } });
  const json = await res.json();
  return { status: res.status, crews: (json?.data?.crews ?? []) as Array<{ userId: string; name: string }> };
}

async function main() {
  const cookie = await cookieHeader();

  // ⚠ 이 환경은 QA_HIDE_REAL_USERS=true(lib/qaFixedScope.ts) 라 operating/test 모두 테스트
  //   마커 모집단으로 고정된다 — 실사용자 표본은 항상 빈 결과([])가 나온다(회귀 아님).
  //   따라서 표본은 test_user_markers 소속으로 고른다.
  const suspendedUser = { org: "oranke", name: "T조하은", userId: "cc05522b-7a71-48fb-a291-3aaaefdf4865" }; // growth_status=paused(=활동중단)
  const restUser = { org: "encre", name: "T김기연", userId: "28c60d60-aa17-4614-9127-fd65a8aebcaf" }; // 2026-summer 시즌휴식
  const activeUser = { org: "oranke", name: "T김예령", userId: "13b8e55e-ff49-43f3-a01f-cb68bfb74581" };

  console.log("\n[1. excludeSeasonRest=1 없이(기존 동작) — 무필터엔 그대로 나옴]");
  {
    const { crews } = await search(cookie, { organization: suspendedUser.org, q: suspendedUser.name, mode: "test" });
    ck("무필터 검색엔 활동중단자도 그대로 나옴(회귀 아님 확인)", crews.some((c) => c.userId === suspendedUser.userId), JSON.stringify(crews));
  }

  console.log("\n[2. excludeSeasonRest=1 — 활동 중단자(paused) 제외 확인]");
  {
    const { status, crews } = await search(cookie, { organization: suspendedUser.org, q: suspendedUser.name, excludeSeasonRest: "1", mode: "test" });
    ck("HTTP 200", status === 200);
    ck("활동 중단자(T조하은) 검색 결과에서 제외됨", !crews.some((c) => c.userId === suspendedUser.userId), JSON.stringify(crews));
  }

  console.log("\n[3. excludeSeasonRest=1 — 시즌 휴식자 제외 확인]");
  {
    const { crews } = await search(cookie, { organization: restUser.org, q: restUser.name, excludeSeasonRest: "1", mode: "test" });
    ck("시즌 휴식자(T김기연) 검색 결과에서 제외됨", !crews.some((c) => c.userId === restUser.userId), JSON.stringify(crews));
  }

  console.log("\n[4. excludeSeasonRest=1 — 정상 활동자는 그대로 포함]");
  {
    const { crews } = await search(cookie, { organization: activeUser.org, q: activeUser.name, excludeSeasonRest: "1", mode: "test" });
    ck("정상 활동자는 검색됨", crews.some((c) => c.userId === activeUser.userId), JSON.stringify(crews));
  }

  console.log("\n[5. 일반 모드(operating)도 같은 함수 — QA 스위치 하에서 test 와 동일 모집단]");
  {
    const opRes = await search(cookie, { organization: activeUser.org, q: activeUser.name, excludeSeasonRest: "1" });
    const teRes = await search(cookie, { organization: activeUser.org, q: activeUser.name, excludeSeasonRest: "1", mode: "test" });
    ck("operating/test 결과 동일(현재 QA 스위치 하)", JSON.stringify(opRes.crews) === JSON.stringify(teRes.crews));
  }

  console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAIL`}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
