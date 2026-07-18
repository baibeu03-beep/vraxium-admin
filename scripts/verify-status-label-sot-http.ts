/**
 * 상태 표기 SoT 통일(A2·A4) 실제 HTTP 검증.
 *   표면 3종 × 케이스 3종:
 *     - GET /api/admin/members?q=…                      → statusLabel
 *     - GET /api/admin/crews/{id}/cluster4/weekly-growth → seasonActivityStatuses[].statusLabel (area-8)
 *     - GET /api/admin/crews/{id}/resume-card/resume     → seasonRecords[].position (이력서 시즌 직책)
 *   케이스:
 *     1) T최수빈 role=part_leader, level=일반  → 일반(멤버십 상태) / 정규 / 정규(클래스)
 *     2) T임시우 role=part_leader, level=심화  → 심화(파트장) ×3
 *     3) 심화 agent 1명 (DB 에서 자동 선정)    → 심화(에이전트) ×3
 *
 *   사전조건: dev 서버 (기본 http://localhost:3000, SMOKE_BASE_URL 로 변경).
 *   npx tsx --env-file=.env.local scripts/verify-status-label-sot-http.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

async function makeAdminCookieHeader() {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceRoleKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");
  const admin = createClient(supabaseUrl, serviceRoleKey);
  const browser = createClient(supabaseUrl, anonKey);
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  if (linkError || !linkData?.properties?.email_otp) {
    throw new Error(linkError?.message ?? "Failed to generate admin magic link");
  }
  const { data: verifyData, error: verifyError } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties.email_otp,
    type: "magiclink",
  });
  if (verifyError || !verifyData.session) {
    throw new Error(verifyError?.message ?? "Failed to verify admin OTP");
  }
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll() {
        return [];
      },
      setAll(items) {
        captured.push(...items.map((i) => ({ name: i.name, value: i.value })));
      },
    },
  });
  const { error: setError } = await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  if (setError) throw new Error(setError.message);
  return captured.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function getJson(cookieHeader: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Cookie: cookieHeader },
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || !(json as { success?: boolean }).success) {
    throw new Error(`GET ${path} → ${res.status} ${(json as { error?: string }).error ?? ""}`);
  }
  return (json as { data?: unknown }).data as Record<string, unknown>;
}

type Case = { name: string; userId: string; expectMembers: string; expectArea8: string; expectResume: string };

let failures = 0;
function check(label: string, actual: string | string[], expected: string) {
  const values = Array.isArray(actual) ? actual : [actual];
  const ok = values.length > 0 && values.every((v) => v === expected);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(Array.isArray(actual) ? values : values[0])} (기대 ${JSON.stringify(expected)})`,
  );
}

async function main() {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");
  const sb = createClient(supabaseUrl, serviceRoleKey);

  // 케이스 3: 심화 + role=agent 사용자 자동 선정.
  const { data: mems, error: memErr } = await sb
    .from("user_memberships")
    .select("user_id,membership_level,is_current")
    .eq("membership_level", "심화")
    .eq("is_current", true);
  if (memErr) throw memErr;
  const advancedIds = (mems ?? []).map((m: { user_id: string }) => m.user_id);
  const { data: agents, error: agentErr } = await sb
    .from("user_profiles")
    .select("user_id,display_name,role")
    .eq("role", "agent")
    .in("user_id", advancedIds)
    .limit(1);
  if (agentErr) throw agentErr;
  const agent = (agents ?? [])[0] as
    | { user_id: string; display_name: string | null }
    | undefined;
  if (!agent) throw new Error("심화 + role=agent 사용자를 찾지 못했습니다.");

  const cases: Case[] = [
    {
      name: "T최수빈",
      userId: "36138fb1-6fea-4b22-b6d2-9c46cba47314",
      expectMembers: "일반",
      expectArea8: "정규",
      expectResume: "정규",
    },
    {
      name: "T임시우",
      userId: "a80ea67a-0000-0000-0000-000000000000", // placeholder — 아래에서 display_name 으로 재해석
      expectMembers: "심화(파트장)",
      expectArea8: "심화(파트장)",
      expectResume: "심화(파트장)",
    },
    {
      name: agent.display_name ?? agent.user_id,
      userId: agent.user_id,
      expectMembers: "심화(에이전트)",
      expectArea8: "심화(에이전트)",
      expectResume: "심화(에이전트)",
    },
  ];

  // T임시우 실제 user_id 조회 (prefix 만 알려져 있어 display_name 으로 확정).
  const { data: lim, error: limErr } = await sb
    .from("user_profiles")
    .select("user_id")
    .eq("display_name", "T임시우")
    .single();
  if (limErr || !lim) throw new Error("T임시우 user_id 조회 실패");
  cases[1].userId = (lim as { user_id: string }).user_id;

  const cookieHeader = await makeAdminCookieHeader();

  for (const c of cases) {
    console.log(`\n=== ${c.name} (${c.userId.slice(0, 8)}) ===`);

    // 1) /admin/members
    const membersData = await getJson(
      cookieHeader,
      `/api/admin/members?q=${encodeURIComponent(c.name)}&limit=10`,
    );
    const member = ((membersData.members ?? []) as Array<{
      displayName: string | null;
      statusLabel: string;
    }>).find((m) => (m.displayName ?? "") === c.name);
    check("/admin/members statusLabel", member?.statusLabel ?? "<없음>", c.expectMembers);

    // 2) area-8 시즌활동상태 (weekly-growth live)
    const growth = await getJson(
      cookieHeader,
      `/api/admin/crews/${encodeURIComponent(c.userId)}/cluster4/weekly-growth`,
    );
    const statuses = (growth.seasonActivityStatuses ?? []) as Array<{
      statusLabel: string;
    }>;
    check(
      "area-8 seasonActivityStatuses[].statusLabel",
      statuses.map((s) => s.statusLabel),
      c.expectArea8,
    );

    // 3) 이력서 시즌 직책
    const resume = await getJson(
      cookieHeader,
      `/api/admin/crews/${encodeURIComponent(c.userId)}/resume-card/resume`,
    );
    const records = (resume.seasonRecords ?? []) as Array<{ position: string }>;
    check(
      "이력서 seasonRecords[].position",
      records.map((r) => r.position),
      c.expectResume,
    );
  }

  if (failures > 0) {
    console.error(`\n${failures}건 실패`);
    process.exit(1);
  }
  console.log("\n전체 통과 — 상태 표기 SoT(A2·A4) HTTP 검증 완료");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
