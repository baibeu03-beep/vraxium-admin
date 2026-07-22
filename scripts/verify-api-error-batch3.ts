/**
 * 검증 — Batch 3(프로세스 · 활동 처리) 오류 처리 실제 HTTP.
 *   실행 · 수동 지급 · 상태 변경 · 실행 취소 경로의 실패 응답을 확인한다.
 *   ⚠ 실패하는 요청만 보낸다 — 액트/체크/휴식을 실제로 만들거나 바꾸지 않는다.
 *   npx tsx scripts/verify-api-error-batch3.ts
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { API_ERROR_UNAUTHORIZED, resolveApiError } from "@/lib/apiError";

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
const DEV_TERM_RE = /[a-z][a-z0-9]*(?:_[a-z0-9]+)+|is required|must be|not found|Failed/i;
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

const DTO_KEYS = ["success", "error", "message", "details", "reason", "code"];
const dtoKeys = (j: unknown) =>
  Object.keys((j ?? {}) as object)
    .filter((k) => DTO_KEYS.includes(k))
    .sort()
    .join(",");

type Res = { status: number; j: Record<string, unknown> };

async function main() {
  const cookie = await cookieHeader();
  const call = async (path: string, init: RequestInit = {}, extra = ""): Promise<Res> =>
    fetch(`${BASE}${path}`, {
      ...init,
      headers: { cookie: cookie + extra, "content-type": "application/json", ...(init.headers ?? {}) },
    }).then(async (r) => ({
      status: r.status,
      j: (await r.json().catch(() => ({}))) as Record<string, unknown>,
    }));
  const show = (r: Res, fb: string) => resolveApiError({ status: r.status, payload: r.j, fallback: fb });

  // ── 1. 라인급 등록 — 이름 누락 (400) ──
  console.log("\n[1] 라인급 등록 — 필수값 누락");
  const r1 = await call("/api/admin/processes/line-groups", {
    method: "POST",
    body: JSON.stringify({ hub: "info" }),
  });
  const m1 = show(r1, "라인급 등록에 실패했습니다");
  ck("4xx status", r1.status >= 400 && r1.status < 500, `status=${r1.status}`);
  ck("DTO = success,error", dtoKeys(r1.j) === "error,success", dtoKeys(r1.j));
  ck("사용자 용어 안내", !DEV_TERM_RE.test(m1.message), m1.message);
  console.log(`    문구: ${m1.message}`);

  // ── 2. 라인급 삭제 — 존재하지 않는 대상 ──
  console.log("\n[2] 라인급 삭제 — 존재하지 않는 대상");
  const r2 = await call("/api/admin/processes/line-groups/00000000-0000-4000-8000-000000000000", {
    method: "DELETE",
  });
  const m2 = show(r2, "라인급 삭제에 실패했습니다");
  ck("4xx status", r2.status >= 400 && r2.status < 500, `status=${r2.status}`);
  ck("개발 용어 미노출", !DEV_TERM_RE.test(m2.message), m2.message);
  ck("내부 원문 미노출", !INTERNAL_RE.test(m2.message), m2.message);

  // ── 3. 액트 삭제 — 존재하지 않는 대상 ──
  console.log("\n[3] 액트 삭제 — 존재하지 않는 대상");
  const r3 = await call("/api/admin/processes/acts/00000000-0000-4000-8000-000000000000", {
    method: "DELETE",
  });
  const m3 = show(r3, "삭제에 실패했습니다");
  ck("4xx status", r3.status >= 400 && r3.status < 500, `status=${r3.status}`);
  ck("개발 용어 미노출", !DEV_TERM_RE.test(m3.message), m3.message);

  // ── 4. 체크 신청 — 필수값 누락 (400) ──
  console.log("\n[4] 체크 신청 — 필수값 누락");
  const r4 = await call("/api/admin/processes/check", {
    method: "POST",
    body: JSON.stringify({ action: "request" }),
  });
  const m4 = show(r4, "체크 신청에 실패했습니다.");
  ck("4xx status", r4.status >= 400 && r4.status < 500, `status=${r4.status}`);
  ck("사용자 용어 안내", !DEV_TERM_RE.test(m4.message), m4.message);
  console.log(`    문구: ${m4.message}`);

  // ── 5. 수동 지급 — 대상자 없음 (400) ──
  console.log("\n[5] 수동 지급 — 대상자 없음");
  const r5 = await call("/api/admin/processes/check", {
    method: "POST",
    body: JSON.stringify({
      action: "manual_grant",
      hub: "info",
      organization: "encre",
      act_name: "오류검증",
      target_user_ids: [],
    }),
  });
  const m5 = show(r5, "수동 지급에 실패했습니다.");
  ck("4xx status", r5.status >= 400 && r5.status < 500, `status=${r5.status}`);
  ck("사용자 용어 안내", !DEV_TERM_RE.test(m5.message), m5.message);
  console.log(`    문구: ${m5.message}`);

  // ── 6. 변동 액트 검수 취소 — 존재하지 않는 대상 ──
  console.log("\n[6] 변동 액트 검수 취소 — 존재하지 않는 대상");
  const r6 = await call("/api/admin/processes/check/irregular", {
    method: "DELETE",
    body: JSON.stringify({ id: "00000000-0000-4000-8000-000000000000", organization: "encre" }),
  });
  const m6 = show(r6, "검수 취소에 실패했습니다.");
  ck("4xx status", r6.status >= 400 && r6.status < 500, `status=${r6.status}`);
  ck("개발 용어 미노출", !DEV_TERM_RE.test(m6.message), m6.message);
  ck("내부 원문 미노출", !INTERNAL_RE.test(m6.message), m6.message);

  // ── 7. 실행 취소(rollback) ──
  //   체크 실행 취소는 멱등 설계다(대상이 없어도 200 성공) → 오류 경로가 아니다.
  //   실제 실패 경로는 변동 액트 실행 취소의 입력 검증(400)이므로 그쪽을 확인한다.
  console.log("\n[7] 실행 취소 — 멱등 성공 + 변동 액트 실행 취소 입력 검증");
  const r7a = await call("/api/admin/processes/check/rollback", {
    method: "POST",
    body: JSON.stringify({ statusId: "00000000-0000-4000-8000-000000000000" }),
  });
  ck("체크 실행 취소는 멱등(200)", r7a.status === 200, `status=${r7a.status}`);
  const r7 = await call("/api/admin/processes/check/irregular/rollback", {
    method: "POST",
    body: JSON.stringify({ id: "not-a-uuid", organization: "encre" }),
  });
  const m7 = show(r7, "실행 취소에 실패했습니다.");
  ck("4xx status", r7.status >= 400 && r7.status < 500, `status=${r7.status}`);
  ck("개발 용어 미노출", !DEV_TERM_RE.test(m7.message), m7.message);
  console.log(`    문구: ${m7.message}`);

  // ── 8. 긴급 휴식 신청 — 필수값 누락 ──
  console.log("\n[8] 긴급 휴식 신청 — 필수값 누락");
  const r8 = await call("/api/admin/rest-management/emergency", {
    method: "POST",
    body: JSON.stringify({}),
  });
  const m8 = show(r8, "긴급 휴식 신청에 실패했습니다.");
  ck("4xx status", r8.status >= 400 && r8.status < 500, `status=${r8.status}`);
  ck("개발 용어 미노출", !DEV_TERM_RE.test(m8.message), m8.message);
  console.log(`    문구: ${m8.message}`);

  // ── 9. 비인증 (401) ──
  console.log("\n[9] 비인증 요청 (401)");
  const r9: Res = await fetch(`${BASE}/api/admin/processes/info?hub=all`).then(async (r) => ({
    status: r.status,
    j: (await r.json().catch(() => ({}))) as Record<string, unknown>,
  }));
  const m9 = resolveApiError({ status: r9.status, payload: r9.j });
  ck("status 401", r9.status === 401, `status=${r9.status}`);
  ck("세션 만료 고정 문구", m9.message === API_ERROR_UNAUTHORIZED, m9.message);

  // ── 10. 일반 · 테스트 모드 동등성 ──
  console.log("\n[10] 일반 · mode=test · 활동모드 쿠키 동등성");
  const init: RequestInit = { method: "POST", body: JSON.stringify({ action: "request" }) };
  const a = await call("/api/admin/processes/check", init);
  const b = await call("/api/admin/processes/check?mode=test", init);
  const c = await call("/api/admin/processes/check", init, "; admin_activity_mode=test");
  const [ma, mb, mc] = [a, b, c].map((r) => show(r, "체크 신청에 실패했습니다."));
  ck("status 동일", a.status === b.status && b.status === c.status, `${a.status}/${b.status}/${c.status}`);
  ck("DTO 키 동일", dtoKeys(a.j) === dtoKeys(b.j) && dtoKeys(b.j) === dtoKeys(c.j), dtoKeys(a.j));
  ck("문구 동일", ma.message === mb.message && mb.message === mc.message, ma.message);

  // ── 11. 부작용 없음 ──
  console.log("\n[11] 부작용 없음 확인");
  const { count } = await sb
    .from("process_acts")
    .select("id", { count: "exact", head: true })
    .eq("act_name", "오류검증");
  ck("검증용 액트 미생성", (count ?? 0) === 0, `count=${count}`);

  console.log(`\n═══ ${fail === 0 ? "PASS" : `FAIL(${fail})`} ═══`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
