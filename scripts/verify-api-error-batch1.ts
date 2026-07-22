/**
 * 검증 — Batch 1(계정·권한·사용자 관리) 오류 처리 실제 HTTP.
 *   각 실패 요청의 status / 오류 DTO 키 / 공통 파서가 만드는 사용자 문구를 확인한다.
 *   일반 모드 · mode=test 가 같은 status·DTO·문구를 내는지도 함께 본다.
 *
 *   ⚠ 실패하는 요청만 보낸다 — 계정/권한을 실제로 바꾸지 않는다(생성·수정 없음).
 *   사전조건: dev 서버 :3000 · .env.local
 *   npx tsx scripts/verify-api-error-batch1.ts
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import {
  API_ERROR_NOT_FOUND,
  API_ERROR_SERVER,
  API_ERROR_UNAUTHORIZED,
  resolveApiError,
} from "@/lib/apiError";

const adminRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim() ?? "";
const BASE = process.env.BASE_URL || "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE);
const brow = createClient(URL_, ANON);

let fail = 0;
const ck = (label: string, ok: boolean, detail: unknown = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${String(detail)}` : ""}`);
  if (!ok) fail++;
};

// 사용자 문구에 개발 용어가 남으면 실패.
const DEV_TERM_RE = /[a-z][a-z0-9]*(?:_[a-z0-9]+)+|is required|must be|not found|Failed to/i;
// 내부 원문(DB/SQL/Supabase) 이 새면 실패.
const INTERNAL_RE = /supabase|duplicate key|unique constraint|relation |PGRST|select |insert into/i;

async function cookieHeader(): Promise<string> {
  const { data: admins } = await sb
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const email = admins?.[0]?.email as string;
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await brow.auth.verifyOtp({
    email,
    token: link!.properties!.email_otp,
    type: "magiclink",
  });
  const cap: { name: string; value: string }[] = [];
  const srv = createServerClient(URL_, ANON, {
    cookies: { getAll: () => [], setAll: (items) => cap.push(...items) },
  });
  await srv.auth.setSession({
    access_token: v.session!.access_token,
    refresh_token: v.session!.refresh_token,
  });
  console.log(`admin: ${email}`);
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

const DTO_KEYS = ["success", "error", "message", "details", "reason", "code", "step"];
const dtoKeys = (j: unknown) =>
  Object.keys((j ?? {}) as object)
    .filter((k) => DTO_KEYS.includes(k))
    .sort()
    .join(",");

type Res = { status: number; j: Record<string, unknown> };

async function main() {
  const cookie = await cookieHeader();
  const call = async (
    path: string,
    init: RequestInit = {},
    extraCookie = "",
  ): Promise<Res> =>
    fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        cookie: cookie + extraCookie,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    }).then(async (r) => ({
      status: r.status,
      j: (await r.json().catch(() => ({}))) as Record<string, unknown>,
    }));

  const show = (r: Res, fallback: string) =>
    resolveApiError({ status: r.status, payload: r.j, fallback });

  // ── 1. 계정 생성 400 (이메일 형식) ──
  console.log("\n[1] 계정 생성 — 이메일 형식 오류 (400)");
  const r1 = await call("/api/admin/accounts", {
    method: "POST",
    body: JSON.stringify({
      email: "not-an-email",
      display_name: "오류검증",
      admin_role: "viewer",
      is_active: true,
      send_invite_email: false,
    }),
  });
  const m1 = show(r1, "계정을 생성하지 못했습니다.");
  ck("status 400", r1.status === 400, `status=${r1.status}`);
  ck("DTO = success,error", dtoKeys(r1.j) === "error,success", dtoKeys(r1.j));
  ck("사용자 용어 안내", m1.source === "server" && !DEV_TERM_RE.test(m1.message), m1.message);

  // ── 2. 계정 생성 400 (이름 누락) ──
  console.log("\n[2] 계정 생성 — 이름 누락 (400)");
  const r2 = await call("/api/admin/accounts", {
    method: "POST",
    body: JSON.stringify({
      email: `qa.err.${Date.now() % 100000}@example.com`,
      display_name: "   ",
      admin_role: "viewer",
      is_active: true,
      send_invite_email: false,
    }),
  });
  const m2 = show(r2, "계정을 생성하지 못했습니다.");
  ck("status 400", r2.status === 400, `status=${r2.status}`);
  ck("누락 항목 안내", m2.message.includes("이름"), m2.message);
  ck("개발 용어 미노출", !DEV_TERM_RE.test(m2.message), m2.message);

  // ── 3. 계정 생성 409 (이미 등록된 이메일) ──
  console.log("\n[3] 계정 생성 — 이미 등록된 이메일 (409)");
  const { data: existing } = await sb
    .from("admin_users")
    .select("email")
    .not("email", "is", null)
    .limit(1);
  const dupEmail = existing?.[0]?.email as string | undefined;
  if (!dupEmail) {
    console.log("  · 기존 운영 계정이 없어 건너뜀");
  } else {
    const r3 = await call("/api/admin/accounts", {
      method: "POST",
      body: JSON.stringify({
        email: dupEmail,
        display_name: "오류검증",
        admin_role: "viewer",
        is_active: true,
        send_invite_email: false,
      }),
    });
    const m3 = show(r3, "계정을 생성하지 못했습니다.");
    ck("status 409", r3.status === 409, `status=${r3.status}`);
    ck("중복 원인 안내", m3.source === "server" && m3.message.includes("이미"), m3.message);
    ck("내부 원문 미노출", !INTERNAL_RE.test(String(r3.j.error)), String(r3.j.error));
  }

  // ── 4. 계정 수정 400 (잘못된 권한 등급) ──
  console.log("\n[4] 계정 수정 — 잘못된 권한 등급 (400)");
  const { data: anyAdmin } = await sb.from("admin_users").select("id").limit(1);
  const targetId = anyAdmin?.[0]?.id as string | undefined;
  if (!targetId) {
    console.log("  · 대상 계정이 없어 건너뜀");
  } else {
    const r4 = await call(`/api/admin/accounts/${targetId}`, {
      method: "PATCH",
      body: JSON.stringify({ admin_role: "not_a_role" }),
    });
    const m4 = show(r4, "계정 정보를 수정하지 못했습니다.");
    ck("status 400", r4.status === 400, `status=${r4.status}`);
    ck("사용자 용어 안내", !DEV_TERM_RE.test(m4.message), m4.message);
  }

  // ── 5. 계정 수정 404/400 (존재하지 않는 대상) ──
  console.log("\n[5] 계정 수정 — 존재하지 않는 대상");
  const r5 = await call("/api/admin/accounts/00000000-0000-4000-8000-000000000000", {
    method: "PATCH",
    body: JSON.stringify({ is_active: false }),
  });
  const m5 = show(r5, "계정 정보를 수정하지 못했습니다.");
  ck("4xx status", r5.status >= 400 && r5.status < 500, `status=${r5.status}`);
  ck("찾을 수 없음/업무 안내", m5.message.length > 0 && !DEV_TERM_RE.test(m5.message), m5.message);

  // ── 6. 권한 저장 400 (잘못된 boolean) ──
  console.log("\n[6] 권한 저장 — 잘못된 값 (400)");
  const r6 = await call("/api/admin/permissions/some.permission.key", {
    method: "PATCH",
    body: JSON.stringify({ role: "viewer", is_allowed: "yes" }),
  });
  const m6 = show(r6, "권한을 저장하지 못했습니다.");
  ck("4xx status", r6.status >= 400 && r6.status < 500, `status=${r6.status}`);
  ck("사용자 용어 안내", !DEV_TERM_RE.test(m6.message), m6.message);

  // ── 7. 크루 메모 404 (존재하지 않는 사용자) ──
  console.log("\n[7] 크루 메모 저장 — 존재하지 않는 대상");
  const r7 = await call("/api/admin/members/00000000-0000-4000-8000-000000000000/note", {
    method: "PUT",
    body: JSON.stringify({ note: "오류검증" }),
  });
  const m7 = show(r7, "메모를 저장하지 못했습니다.");
  ck("4xx status", r7.status >= 400 && r7.status < 500, `status=${r7.status}`);
  ck("개발 용어 미노출", !DEV_TERM_RE.test(m7.message), m7.message);

  // ── 8. 가입 요청 거절 — 존재하지 않는 대상 ──
  console.log("\n[8] 가입 요청 거절 — 존재하지 않는 대상");
  const r8 = await call("/api/admin/applicants/00000000-0000-4000-8000-000000000000/reject", {
    method: "POST",
  });
  const m8 = show(r8, "가입 요청을 거절하지 못했습니다.");
  ck("4xx status", r8.status >= 400 && r8.status < 500, `status=${r8.status}`);
  ck("개발 용어 미노출", !DEV_TERM_RE.test(m8.message), m8.message);
  ck("내부 원문 미노출", !INTERNAL_RE.test(m8.message), m8.message);

  // ── 9. 비인증 (401) ──
  console.log("\n[9] 비인증 요청 (401)");
  const r9: Res = await fetch(`${BASE}/api/admin/accounts?limit=1`).then(async (r) => ({
    status: r.status,
    j: (await r.json().catch(() => ({}))) as Record<string, unknown>,
  }));
  const m9 = resolveApiError({ status: r9.status, payload: r9.j });
  ck("status 401", r9.status === 401, `status=${r9.status}`);
  ck("세션 만료 고정 문구", m9.message === API_ERROR_UNAUTHORIZED, m9.message);

  // ── 10. 일반 모드 == 테스트 모드 ──
  console.log("\n[10] 일반 모드 · mode=test · 활동모드 쿠키 동등성");
  const body = JSON.stringify({ email: "not-an-email", display_name: "오류검증" });
  const a = await call("/api/admin/accounts", { method: "POST", body });
  const b = await call("/api/admin/accounts?mode=test", { method: "POST", body });
  const c = await call("/api/admin/accounts", { method: "POST", body }, "; admin_activity_mode=test");
  const [ma, mb, mc] = [a, b, c].map((r) => show(r, "계정을 생성하지 못했습니다."));
  ck("status 동일", a.status === b.status && b.status === c.status, `${a.status}/${b.status}/${c.status}`);
  ck("DTO 키 동일", dtoKeys(a.j) === dtoKeys(b.j) && dtoKeys(b.j) === dtoKeys(c.j), dtoKeys(a.j));
  ck("문구 동일", ma.message === mb.message && mb.message === mc.message, ma.message);

  // ── 11. 5xx 안전 문구 계약 (파서 단위) ──
  console.log("\n[11] 5xx · 네트워크 안전 문구 계약");
  const m500 = resolveApiError({
    status: 500,
    payload: { success: false, error: 'duplicate key value violates unique constraint "admin_users_pkey"' },
  });
  ck("5xx 원문 차단", m500.message === API_ERROR_SERVER, m500.message);
  const m404 = resolveApiError({ status: 404, payload: {} });
  ck("404 기본 문구", m404.message === API_ERROR_NOT_FOUND, m404.message);

  // ── 12. 검증으로 생성된 계정이 없어야 한다 ──
  console.log("\n[12] 부작용 없음 확인");
  const { count } = await sb
    .from("admin_users")
    .select("id", { count: "exact", head: true })
    .ilike("email", "qa.err.%@example.com");
  ck("검증용 계정 미생성", (count ?? 0) === 0, `count=${count}`);

  console.log(`\n═══ ${fail === 0 ? "PASS" : `FAIL(${fail})`} ═══`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
