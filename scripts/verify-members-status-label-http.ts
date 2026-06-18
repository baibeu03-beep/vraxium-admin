/**
 * 실제 HTTP 검증 — GET /api/admin/members 의 statusLabel 이
 * membership_level SoT(lib/adminMembersTypes.memberStatusLabel) 기준으로 내려오는지 확인한다.
 *
 *   1) SoT 단위 단언(원래 의도 보존, 데이터 비의존):
 *        - memberStatusLabel("part_leader", "일반")        → "일반"  (파트장 role 이라도 level=일반이면 일반)
 *        - memberStatusLabel("part_leader", "심화(파트장)") → "심화(파트장)"
 *        - memberStatusLabel("part_leader", "심화")        → "심화(파트장)"
 *   2) 데이터 주도 HTTP 단언: 실 DB 에서 라벨별 실존 멤버를 골라, HTTP statusLabel == SoT(role,level) 확인.
 *        (하드코딩 이름 픽스처 제거 — 명단이 바뀌어도 깨지지 않는다.)
 *
 *   사전조건: dev 서버 기동 (기본 http://localhost:3000, SMOKE_BASE_URL 로 변경).
 *   npx tsx --env-file=.env.local scripts/verify-members-status-label-http.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { memberStatusLabel } from "@/lib/adminMembersTypes";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

// cluster4-line-smoke.ts 와 동일한 admin 세션 쿠키 생성 (magiclink OTP).
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
        captured.push(...items.map((item) => ({ name: item.name, value: item.value })));
      },
    },
  });
  const { error: setError } = await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  if (setError) throw new Error(setError.message);

  return captured.map((item) => `${item.name}=${item.value}`).join("; ");
}

type MemberDto = {
  userId: string;
  displayName: string | null;
  role: string | null;
  membershipLevel: string | null;
  statusLabel: string;
  status: string | null;
};

// HTTP 검색 결과에서 userId 로 정확히 매칭(동명이인 안전).
async function fetchMemberById(cookieHeader: string, name: string, userId: string) {
  const res = await fetch(
    `${baseUrl}/api/admin/members?q=${encodeURIComponent(name)}&limit=50`,
    { headers: { Cookie: cookieHeader } },
  );
  const json = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    error?: string;
    data?: { members?: MemberDto[] };
  };
  if (!res.ok || !json.success) {
    throw new Error(`GET /api/admin/members q=${name} → ${res.status} ${json.error ?? ""}`);
  }
  const member = (json.data?.members ?? []).find((m) => m.userId === userId);
  if (!member) throw new Error(`member not found in HTTP response: ${name} (${userId})`);
  return member;
}

// 실 DB 에서 라벨별 실존 멤버 1명씩 선정(테스트 마커 'T' 접두 제외 — 운영 명단 기준).
async function pickRealMembersByLabel(targets: string[]) {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");
  const sb = createClient(supabaseUrl, serviceRoleKey);

  const { data: mem } = await sb
    .from("user_memberships")
    .select("user_id,membership_level")
    .limit(10000);
  const levelByUser = new Map((mem ?? []).map((m) => [m.user_id, m.membership_level]));

  const { data: profs } = await sb
    .from("user_profiles")
    .select("user_id,display_name,role,organization_slug")
    .not("display_name", "is", null)
    .order("user_id", { ascending: true })
    .limit(10000);

  const chosen = new Map<string, { uid: string; name: string; role: string | null; level: string | null }>();
  for (const p of profs ?? []) {
    const name = (p.display_name ?? "").trim();
    if (name.length < 2 || name.startsWith("T")) continue; // 테스트 마커/빈 이름 제외
    const level = (levelByUser.get(p.user_id) ?? null) as string | null;
    const label = memberStatusLabel(p.role, level);
    if (targets.includes(label) && !chosen.has(label)) {
      chosen.set(label, { uid: p.user_id, name, role: p.role, level });
    }
  }
  return chosen;
}

async function main() {
  const cookieHeader = await makeAdminCookieHeader();

  let failed = 0;
  const ck = (ok: boolean, msg: string) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${msg}`);
    if (!ok) failed += 1;
  };

  // 1) SoT 단위 단언 — 원래 픽스처가 검증하던 의도(파트장 role × level 분기)를 데이터 비의존으로 보존.
  ck(memberStatusLabel("part_leader", "일반") === "일반",
    `SoT memberStatusLabel(part_leader, 일반) → "일반" (level=일반이면 파트장 표기 금지)`);
  ck(memberStatusLabel("part_leader", "심화(파트장)") === "심화(파트장)",
    `SoT memberStatusLabel(part_leader, 심화(파트장)) → "심화(파트장)"`);
  ck(memberStatusLabel("part_leader", "심화") === "심화(파트장)",
    `SoT memberStatusLabel(part_leader, 심화) → "심화(파트장)"`);

  // 2) 데이터 주도 HTTP 단언 — 라벨별 실존 멤버의 HTTP statusLabel == SoT(role, level).
  const targets = ["일반", "심화(파트장)", "심화(에이전트)", "팀장", "앰배서더"];
  const chosen = await pickRealMembersByLabel(targets);
  if (chosen.size === 0) throw new Error("후보 멤버를 DB 에서 찾지 못했습니다.");

  for (const label of targets) {
    const c = chosen.get(label);
    if (!c) {
      console.log(`SKIP "${label}" — 현재 명단에 해당 라벨 운영 멤버 없음`);
      continue;
    }
    const m = await fetchMemberById(cookieHeader, c.name, c.uid);
    const expected = memberStatusLabel(c.role, c.level); // == label
    const ok = m.statusLabel === expected;
    ck(ok,
      `${m.displayName} → HTTP statusLabel=${JSON.stringify(m.statusLabel)} == SoT ${JSON.stringify(expected)} [role=${m.role}, level=${m.membershipLevel}]`);
  }

  if (failed > 0) {
    console.error(`\n${failed}건 실패`);
    process.exit(1);
  }
  console.log("\n모든 케이스 통과 — /admin/members HTTP statusLabel == membership_level SoT 검증 완료");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
