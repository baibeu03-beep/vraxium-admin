/**
 * 검증 — Batch 2(실무 경험 · 실무 경력) 오류 처리 실제 HTTP.
 *   ⚠ 실패하는 요청만 보낸다 — 라인/초안/평가를 실제로 만들거나 바꾸지 않는다.
 *   사전조건: dev 서버 :3000 · .env.local
 *   npx tsx scripts/verify-api-error-batch2.ts
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
const DEV_TERM_RE = /[a-z][a-z0-9]*(?:_[a-z0-9]+)+|is required|must be|not found|Failed to/i;
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

const DTO_KEYS = ["success", "error", "message", "details", "reason", "code", "warnings"];
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

  // ── 1. 실무 경험 파트 입력 저장 — 필수 파라미터 누락 (400) ──
  console.log("\n[1] 실무 경험 파트 입력 저장 — 필수 파라미터 누락");
  const r1 = await call("/api/admin/cluster4/experience/part-input", {
    method: "POST",
    body: JSON.stringify({}),
  });
  const m1 = show(r1, "파트 입력 데이터를 불러오지 못했습니다");
  ck("4xx status", r1.status >= 400 && r1.status < 500, `status=${r1.status}`);
  ck("DTO = success,error", dtoKeys(r1.j) === "error,success", dtoKeys(r1.j));
  ck("사용자 용어 안내", !DEV_TERM_RE.test(m1.message), m1.message);
  console.log(`    문구: ${m1.message}`);

  // ── 2. 실무 경험 팀 총괄 — 필수 파라미터 누락 (400) ──
  console.log("\n[2] 실무 경험 팀 총괄 — 필수 파라미터 누락");
  const r2 = await call("/api/admin/cluster4/experience/team-overall");
  const m2 = show(r2, "팀 총괄 데이터를 불러오지 못했습니다");
  ck("4xx status", r2.status >= 400 && r2.status < 500, `status=${r2.status}`);
  ck("사용자 용어 안내", !DEV_TERM_RE.test(m2.message), m2.message);
  console.log(`    문구: ${m2.message}`);

  // ── 3. 실무 경력 — 존재하지 않는 항목 수정 ──
  console.log("\n[3] 실무 경력 — 존재하지 않는 항목 수정");
  const r3 = await call("/api/admin/career-projects/00000000-0000-4000-8000-000000000000", {
    method: "PATCH",
    body: JSON.stringify({ line_name: "오류검증" }),
  });
  const m3 = show(r3, "실무 경력 항목을 수정하지 못했습니다");
  ck("4xx status", r3.status >= 400 && r3.status < 500, `status=${r3.status}`);
  ck("개발 용어 미노출", !DEV_TERM_RE.test(m3.message), m3.message);
  ck("내부 원문 미노출", !INTERNAL_RE.test(m3.message), m3.message);

  // ── 4. 실무 경력 — 존재하지 않는 항목 삭제 ──
  console.log("\n[4] 실무 경력 — 존재하지 않는 항목 삭제");
  const r4 = await call("/api/admin/career-projects/00000000-0000-4000-8000-000000000000", {
    method: "DELETE",
  });
  const m4 = show(r4, "실무 경력 항목을 삭제하지 못했습니다");
  ck("4xx status", r4.status >= 400 && r4.status < 500, `status=${r4.status}`);
  ck("개발 용어 미노출", !DEV_TERM_RE.test(m4.message), m4.message);

  // ── 5. 역량 신청 — 존재하지 않는 항목 갱신 ──
  console.log("\n[5] 역량 신청 — 존재하지 않는 항목 갱신");
  const r5 = await call(
    "/api/admin/cluster4/competency/applications/00000000-0000-4000-8000-000000000000",
    { method: "PATCH", body: JSON.stringify({ status: "approved" }) },
  );
  const m5 = show(r5, "변경에 실패했습니다");
  ck("4xx status", r5.status >= 400 && r5.status < 500, `status=${r5.status}`);
  ck("개발 용어 미노출", !DEV_TERM_RE.test(m5.message), m5.message);

  // ── 6. 실무 경험 초안 개설 — 대상 없음 ──
  console.log("\n[6] 실무 경험 초안 개설 — 대상 없음");
  const r6 = await call("/api/admin/cluster4/experience-drafts/open", {
    method: "POST",
    body: JSON.stringify({ draft_ids: ["00000000-0000-4000-8000-000000000000"] }),
  });
  const m6 = show(r6, "개설에 실패했습니다.");
  ck("4xx status", r6.status >= 400 && r6.status < 500, `status=${r6.status}`);
  ck("개발 용어 미노출", !DEV_TERM_RE.test(m6.message), m6.message);
  ck("내부 원문 미노출", !INTERNAL_RE.test(m6.message), m6.message);
  console.log(`    문구: ${m6.message}`);

  // ── 7. 이미지 업로드 — 파일 없음 (400) ──
  console.log("\n[7] 이미지 업로드 — 파일 없음");
  const r7: Res = await fetch(`${BASE}/api/admin/cluster4/upload-image`, {
    method: "POST",
    headers: { cookie },
    body: new FormData(),
  }).then(async (r) => ({
    status: r.status,
    j: (await r.json().catch(() => ({}))) as Record<string, unknown>,
  }));
  const m7 = show(r7, "업로드에 실패했습니다.");
  ck("4xx status", r7.status >= 400 && r7.status < 500, `status=${r7.status}`);
  ck("개발 용어 미노출", !DEV_TERM_RE.test(m7.message), m7.message);
  console.log(`    문구: ${m7.message}`);

  // ── 8. 비인증 (401) ──
  console.log("\n[8] 비인증 요청 (401)");
  const r8: Res = await fetch(`${BASE}/api/admin/career-projects?limit=1`).then(async (r) => ({
    status: r.status,
    j: (await r.json().catch(() => ({}))) as Record<string, unknown>,
  }));
  const m8 = resolveApiError({ status: r8.status, payload: r8.j });
  ck("status 401", r8.status === 401, `status=${r8.status}`);
  ck("세션 만료 고정 문구", m8.message === API_ERROR_UNAUTHORIZED, m8.message);

  // ── 9. 일반 · 테스트 모드 동등성 ──
  console.log("\n[9] 일반 · mode=test · 활동모드 쿠키 동등성");
  const p = "/api/admin/cluster4/experience/part-input";
  const init: RequestInit = { method: "POST", body: JSON.stringify({}) };
  const a = await call(p, init);
  const b = await call(`${p}?mode=test`, init);
  const c = await call(p, init, "; admin_activity_mode=test");
  const [ma, mb, mc] = [a, b, c].map((r) => show(r, "파트 입력 데이터를 불러오지 못했습니다"));
  ck("status 동일", a.status === b.status && b.status === c.status, `${a.status}/${b.status}/${c.status}`);
  ck("DTO 키 동일", dtoKeys(a.j) === dtoKeys(b.j) && dtoKeys(b.j) === dtoKeys(c.j), dtoKeys(a.j));
  ck("문구 동일", ma.message === mb.message && mb.message === mc.message, ma.message);

  // ── 10. 부작용 없음 ──
  console.log("\n[10] 부작용 없음 확인");
  const { count } = await sb
    .from("career_projects")
    .select("id", { count: "exact", head: true })
    .eq("line_name", "오류검증");
  ck("검증용 실무 경력 미생성", (count ?? 0) === 0, `count=${count}`);

  console.log(`\n═══ ${fail === 0 ? "PASS" : `FAIL(${fail})`} ═══`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
