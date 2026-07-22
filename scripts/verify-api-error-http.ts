/**
 * 검증 — 어드민 API 오류 DTO ↔ 공통 파서(lib/apiError) 실제 HTTP 정합.
 *   실제 잘못된 요청을 보내서 status / 오류 DTO 키 / 파서가 만든 사용자 문구를 확인한다.
 *   일반 모드 · mode=test · 활동모드(test) 쿠키가 같은 status·같은 DTO·같은 문구를 내는지 확인한다.
 *
 *   ⚠ 실패하는 요청만 보낸다 — 정상 저장 경로는 건드리지 않는다(생성되는 행 없음).
 *   사전조건: dev 서버 :3000 · .env.local
 *   Usage: npx tsx scripts/verify-api-error-http.ts
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import {
  API_ERROR_NETWORK,
  API_ERROR_UNAUTHORIZED,
  getApiErrorMessage,
  readApiError,
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

// 사용자 문구에 개발 용어(내부 필드명 snake_case · 영문 validator 문장)가 남아 있으면 실패.
const DEV_TERM_RE = /[a-z][a-z0-9]*(?:_[a-z0-9]+)+|is required|must be|not found/i;
function noDevTerms(message: string): boolean {
  return !DEV_TERM_RE.test(message);
}

async function main() {
  const cookie = await cookieHeader();

  const post = async (path: string, body: unknown, extraCookie = ""): Promise<Res> =>
    fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { cookie: cookie + extraCookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, j: (await r.json().catch(() => ({}))) as Record<string, unknown> }));

  const baseBody = {
    line_name: "오류검증 임시라인",
    hub: "info",
    line_type: "일반",
    line_code: "IF BS-NN@0007", // 공백 + 특수문자 → 400
    main_title_mode: "fixed",
    main_title: "임시",
    estimated_duration_minutes: 60,
    organization_slug: "encre",
  };
  const FB = "라인 등록에 실패했습니다.";

  console.log("\n[1] line_code 형식 오류 (400) — 일반 모드");
  const r1 = await post("/api/admin/lines/registrations", baseBody);
  ck("status 400", r1.status === 400, `status=${r1.status}`);
  ck("DTO = success,error", dtoKeys(r1.j) === "error,success", dtoKeys(r1.j));
  console.log(`    서버 error: ${JSON.stringify(r1.j.error)}`);
  const m1 = resolveApiError({ status: r1.status, payload: r1.j, fallback: FB });
  console.log(`    토스트 문구: ${m1.message}`);
  ck("토스트 = 서버 원인 그대로", m1.source === "server" && m1.message === r1.j.error, m1.message);
  ck("라인 코드 안내(사용자 용어)", m1.message.includes("라인 코드"), m1.message);
  ck("개발 용어 미노출", noDevTerms(m1.message), m1.message);

  console.log("\n[2] 동일 요청 — mode=test 쿼리 경로");
  const r2 = await post("/api/admin/lines/registrations?mode=test", baseBody);
  const m2 = resolveApiError({ status: r2.status, payload: r2.j, fallback: FB });
  ck("status 동일", r2.status === r1.status, `${r1.status} vs ${r2.status}`);
  ck("DTO 키 동일", dtoKeys(r2.j) === dtoKeys(r1.j), `${dtoKeys(r1.j)} vs ${dtoKeys(r2.j)}`);
  ck("문구 동일", m2.message === m1.message, m2.message);

  console.log("\n[3] 동일 요청 — 활동 모드(test) 쿠키 경로");
  const r3 = await post("/api/admin/lines/registrations", baseBody, "; admin_activity_mode=test");
  const m3 = resolveApiError({ status: r3.status, payload: r3.j, fallback: FB });
  ck("status 동일", r3.status === r1.status, `${r1.status} vs ${r3.status}`);
  ck("DTO 키 동일", dtoKeys(r3.j) === dtoKeys(r1.j), dtoKeys(r3.j));
  ck("문구 동일", m3.message === m1.message, m3.message);

  console.log("\n[4] 필수 입력 누락 (400)");
  const r4 = await post("/api/admin/lines/registrations", { ...baseBody, line_name: "" });
  const m4 = resolveApiError({ status: r4.status, payload: r4.j, fallback: FB });
  ck("status 400", r4.status === 400, `status=${r4.status}`);
  ck("누락 필드를 사용자 용어로 안내", m4.message.includes("라인명"), m4.message);
  ck("개발 용어 미노출", noDevTerms(m4.message), m4.message);

  console.log("\n[5] 소요 시간 허용값 위반 (400)");
  const r5 = await post("/api/admin/lines/registrations", {
    ...baseBody,
    line_code: "IFBS-NN9999",
    estimated_duration_minutes: 45,
  });
  const m5 = resolveApiError({ status: r5.status, payload: r5.j, fallback: FB });
  ck("status 400", r5.status === 400, `status=${r5.status}`);
  ck("서버 안내 그대로 노출", m5.source === "server", m5.message);
  ck("개발 용어 미노출", noDevTerms(m5.message), m5.message);

  console.log("\n[5b] 중복 라인 코드 (409) — 이전에는 500 + Postgres 원문이었다");
  const { data: existing } = await sb
    .from("line_registrations")
    .select("hub,organization_slug,line_code,line_type")
    .not("organization_slug", "is", null)
    .eq("hub", "info")
    .limit(1);
  const dup = existing?.[0];
  if (!dup) {
    console.log("  · 기존 info 등록이 없어 건너뜀");
  } else {
    const rDup = await post("/api/admin/lines/registrations", {
      ...baseBody,
      line_type: dup.line_type,
      line_code: dup.line_code,
      organization_slug: dup.organization_slug,
    });
    const mDup = resolveApiError({ status: rDup.status, payload: rDup.j, fallback: FB });
    ck("status 409", rDup.status === 409, `status=${rDup.status}`);
    ck("중복 원인 안내", mDup.source === "server" && mDup.message.includes(dup.line_code), mDup.message);
    ck("개발 용어 미노출", noDevTerms(mDup.message.replace(dup.line_code, "")), mDup.message);
    ck(
      "Postgres 원문 미노출",
      !/duplicate key|unique constraint|line_registrations_/i.test(String(rDup.j.error)),
      String(rDup.j.error),
    );
  }

  console.log("\n[6] 존재하지 않는 대상 (404)");
  const r6: Res = await fetch(
    `${BASE}/api/admin/lines/registrations/00000000-0000-4000-8000-000000000000`,
    { headers: { cookie } },
  ).then(async (r) => ({ status: r.status, j: (await r.json().catch(() => ({}))) as Record<string, unknown> }));
  const m6 = resolveApiError({ status: r6.status, payload: r6.j, fallback: "조회에 실패했습니다." });
  ck("status 404", r6.status === 404, `status=${r6.status}`);
  console.log(`    문구: ${m6.message}`);
  ck("내부 원문 미노출", !/supabase|select |PGRST|relation /i.test(m6.message), m6.message);
  ck("개발 용어 미노출", noDevTerms(m6.message), m6.message);

  console.log("\n[7] 비인증 요청 (401)");
  const r7: Res = await fetch(`${BASE}/api/admin/lines/registrations?hub=info&limit=1`).then(
    async (r) => ({ status: r.status, j: (await r.json().catch(() => ({}))) as Record<string, unknown> }),
  );
  const m7 = resolveApiError({ status: r7.status, payload: r7.j });
  ck("status 401", r7.status === 401, `status=${r7.status}`);
  ck("세션 만료 고정 문구", m7.message === API_ERROR_UNAUTHORIZED, m7.message);
  ck("서버 원문 미노출", m7.message !== r7.j.error, `server="${String(r7.j.error)}"`);

  console.log("\n[8] JSON 아닌 오류 응답 / 네트워크 실패");
  const r8 = await fetch(`${BASE}/api/admin/__no_such_route__`, { headers: { cookie } });
  const err8 = await readApiError(r8, "요청에 실패했습니다.");
  console.log(`    status=${r8.status} → 문구: ${err8.userMessage}`);
  ck("비-JSON 본문을 사용자 문구로 쓰지 않음", !/[<>]/.test(err8.userMessage), err8.userMessage);
  let netMsg: string | null = null;
  try {
    await fetch("http://127.0.0.1:9/nope");
  } catch (e) {
    netMsg = getApiErrorMessage(e, "실패");
  }
  ck("네트워크 실패 안내", netMsg === API_ERROR_NETWORK, String(netMsg));

  // 잔여 행이 없어야 한다(모든 요청이 400/404/401 이었으므로).
  const { count } = await sb
    .from("line_registrations")
    .select("id", { count: "exact", head: true })
    .eq("line_name", baseBody.line_name);
  ck("검증용 행이 생성되지 않음", (count ?? 0) === 0, `count=${count}`);

  console.log("\n[9] 정상 등록 흐름 무회귀 — 올바른 line_code 는 그대로 201");
  const okCode = `QAERR-NN${String(Math.floor(Number(process.env.QA_SEQ ?? "9987")) % 10000).padStart(4, "0")}`;
  const rOk = await post("/api/admin/lines/registrations", { ...baseBody, line_code: okCode });
  ck("status 201", rOk.status === 201, `status=${rOk.status} ${JSON.stringify(rOk.j.error ?? "")}`);
  ck("success:true", rOk.j.success === true, JSON.stringify(rOk.j).slice(0, 200));
  const createdId = (rOk.j.data as { id?: string } | undefined)?.id ?? null;
  if (createdId) {
    // 검증 산출물 정리 — 이 스크립트가 만든 행만 삭제한다(다른 데이터 무영향).
    const { error: delErr } = await sb.from("line_registrations").delete().eq("id", createdId);
    ck("검증 행 정리 완료", !delErr, delErr?.message ?? "");
  }

  console.log(`\n═══ ${fail === 0 ? "PASS" : `FAIL(${fail})`} ═══`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
