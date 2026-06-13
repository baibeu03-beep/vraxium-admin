// 검증(HTTP) — /api/admin/crews 모집단 스코프 + direct 대조.
//   node scripts/verify-crews-scope-http.mjs   (dev server :3000 필요)
// read-only. 인증 = magiclink 세션 쿠키(브라우저 검증과 동일). DB write 없음.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL"),
  ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE),
  brow = createClient(URL_, ANON);
const EMAIL = "vanuatu.golden@gmail.com";
const ORG = "encre";

let pass = 0,
  fail = 0;
const ck = (l, ok, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};

// 세션 쿠키 헤더 구성.
const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({
  email: EMAIL,
  token: link.properties.email_otp,
  type: "magiclink",
});
const cap = [];
const srv = createServerClient(URL_, ANON, {
  cookies: { getAll: () => [], setAll: (i) => cap.push(...i) },
});
await srv.auth.setSession({
  access_token: v.session.access_token,
  refresh_token: v.session.refresh_token,
});
const cookieHeader = cap.map((i) => `${i.name}=${i.value}`).join("; ");

// test_user_markers 전수.
const { data: markerRows } = await sb.from("test_user_markers").select("user_id");
const testIds = new Set((markerRows ?? []).map((r) => r.user_id));

async function fetchCrews(mode) {
  const url =
    mode === "test"
      ? `${BASE}/api/admin/crews?organization=${ORG}&mode=test`
      : `${BASE}/api/admin/crews?organization=${ORG}`;
  const res = await fetch(url, { headers: { cookie: cookieHeader }, cache: "no-store" });
  const json = await res.json();
  if (!res.ok || !json.success) throw new Error(json?.error ?? `HTTP ${res.status}`);
  return json.data;
}

console.log("═══════════════════════════════════════");
console.log(`  /api/admin/crews HTTP 스코프 검증 — org=${ORG}`);
console.log("═══════════════════════════════════════");

const operating = await fetchCrews("operating");
const test = await fetchCrews("test");

const opTesters = operating.filter((c) => testIds.has(c.userId));
const testReals = test.filter((c) => !testIds.has(c.userId));

ck(`operating 에 test_user_markers 미포함 (${operating.length}명)`, opTesters.length === 0, `누설 ${opTesters.length}`);
ck(`test 전원 test_user_markers (${test.length}명)`, testReals.length === 0, `실유저 ${testReals.length}`);
ck("operating ∩ test = 0", operating.every((c) => !test.some((t) => t.userId === c.userId)));

// ── direct 대조 (동일 lib 호출) ──
const { listAdminCrewDtos } = await import("../lib/adminCrewData.ts").catch(() => ({}));
let directOk = true;
if (listAdminCrewDtos) {
  const dOp = await listAdminCrewDtos(ORG, "operating");
  const dTest = await listAdminCrewDtos(ORG, "test");
  const sameOp =
    dOp.length === operating.length &&
    new Set(dOp.map((c) => c.userId)).size === new Set(operating.map((c) => c.userId)).size &&
    dOp.every((c) => operating.some((h) => h.userId === c.userId));
  const sameTest =
    dTest.length === test.length && dTest.every((c) => test.some((h) => h.userId === c.userId));
  ck("direct == HTTP (operating 집합 일치)", sameOp, `direct ${dOp.length} / http ${operating.length}`);
  ck("direct == HTTP (test 집합 일치)", sameTest, `direct ${dTest.length} / http ${test.length}`);
  directOk = sameOp && sameTest;
} else {
  console.log("  (direct import 생략 — .ts 동적 import 불가 환경)");
}

console.log(
  JSON.stringify({ org: ORG, httpOperating: operating.length, httpTest: test.length }, null, 2),
);
console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
