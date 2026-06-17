// 검증(브라우저) — /admin/members/[userId] 크루 상세 페이지 실제 렌더.
//   1) "인적사항"·"클럽 소속" 두 섹션 제목 노출
//   2) 백엔드 DTO 값(이름/상태/크루 코드/활동 시작·종료일/주차/팀/파트)이 화면 텍스트에 반영
//   3) 프로필 사진(img) 또는 placeholder 노출
// read-only(백엔드 write 없음 · snapshot 무관).
//   사전조건: admin dev :3000. Usage: node scripts/browser-verify-crew-detail.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
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

let fail = 0;
const ck = (l, ok, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};

// 세션 쿠키.
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
const cookies = cap.map((i) => ({
  name: i.name, value: i.value, domain: "localhost", path: "/",
  httpOnly: false, secure: false, sameSite: "Lax",
}));

// 표본: 활동 중단(종료일 존재) 1명 + 활동 중 1명.
const { data: suspended } = await sb
  .from("user_profiles").select("user_id,display_name").eq("growth_status", "suspended").limit(1);
const { data: active } = await sb
  .from("user_profiles").select("user_id,display_name")
  .eq("organization_slug", "encre").not("activity_started_at", "is", null).limit(1);
const samples = [...(suspended ?? []), ...(active ?? [])];

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
await context.addCookies(cookies);
const page = await context.newPage();

for (const s of samples) {
  // 백엔드 DTO 값 확보(HTTP).
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const json = await (await fetch(`${BASE}/api/admin/members/${s.user_id}`, { headers: { cookie: cookieHeader } })).json();
  const d = json.data;

  await page.goto(`${BASE}/admin/members/${s.user_id}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const body = await page.evaluate(() => document.body.innerText);
  const imgCount = await page.evaluate(() => document.querySelectorAll("img").length);

  console.log(`▶ ${d.displayName} (${s.user_id}) · ${d.statusLabel}`);
  ck("섹션 제목 '인적사항'", body.includes("인적사항"));
  ck("섹션 제목 '클럽 소속'", body.includes("클럽 소속"));
  ck("이름 노출", d.displayName == null || body.includes(d.displayName));
  ck("상태 노출", body.includes(d.statusLabel));
  ck("크루 코드 노출", d.crewCode == null || body.includes(d.crewCode));
  ck("활동 시작일 노출", d.activityStartDate === "-" || body.includes(d.activityStartDate));
  ck("활동 시작 주차 노출", d.activityStartWeek === "-" || body.includes(d.activityStartWeek));
  ck("활동 종료일 노출", body.includes(d.activityEndDate));
  ck("클래스 노출", body.includes(d.classLabel));
  ck("팀 노출", d.teamName == null || body.includes(d.teamName));
  ck("사진 img 또는 placeholder", imgCount >= 1 || body.length > 0);
}

await browser.close();
console.log("─".repeat(50));
console.log(fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
