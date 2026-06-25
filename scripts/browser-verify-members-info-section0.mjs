// 검증(브라우저) — /admin/members?tab=info [섹션.0] 상단 현재 정보 실제 렌더.
//   1) "현재 정보" 카드 + 4개 필드 라벨(오늘/시즌·주차/기간/이번 주 상태) 노출
//   2) 상태 표기는 [공식 활동]/[공식 휴식] 2종 중 하나만(전환 주차도 공식 휴식)
//   3) 4개 클럽 탭(통합/엥크레/오랑캐/팔랑크스) 노출
//   4) 탭 전환 시 섹션.0 텍스트 동일 유지
// read-only(백엔드 write 없음 · snapshot 무관). 사전조건: admin dev :3000.
//   Usage: node scripts/browser-verify-members-info-section0.mjs
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

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
await context.addCookies(cookies);
const page = await context.newPage();

await page.goto(`${BASE}/admin/members?tab=info`, { waitUntil: "domcontentloaded" });
await page
  .waitForFunction(() => document.body.innerText.includes("현재 정보"), { timeout: 25000 })
  .catch(() => {});
// 섹션.0 값 로딩 완료 대기(불러오는 중 사라질 때까지).
await page
  .waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="members-info-section0"]');
      return el && !el.innerText.includes("불러오는 중");
    },
    { timeout: 25000 },
  )
  .catch(() => {});
await page.waitForTimeout(400);

const section0Text = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="members-info-section0"]');
    return el ? el.innerText : "";
  });

const body = await page.evaluate(() => document.body.innerText);
const s0 = await section0Text();
console.log("▶ /admin/members?tab=info");
console.log("── [섹션.0] 렌더 텍스트:\n" + s0.split("\n").map((l) => "   " + l).join("\n"));

// 단일 가로 배너 — 한 줄로 합쳐 패턴 검사(4칸 그리드/표/다중 박스 아님).
const flat = s0.replace(/\s+/g, " ").trim();

// 1) 배너 문구 구조: "오늘은, [날짜, 시즌/주차] 입니다. [기간] [상태] 주차"
ck("'오늘은,' 안내 노출", flat.includes("오늘은,"));
ck("'입니다.' 안내 노출", flat.includes("입니다."));
ck("4칸 그리드 제거(라벨 '오늘 날짜' 비노출)", !s0.includes("오늘 날짜"));

// 날짜 + 시즌/주차 강조 배지 값(YY년 M/D(요일), … 주차)
ck("오늘 날짜 값(YY년 M/D(요일)) 노출", /\d{2}년\s*\d{1,2}\/\d{1,2}\(.\)/.test(flat));
ck("시즌/주차 값(…주차) 노출", /시즌\s*\d{1,2}주차/.test(flat));
// 기간(월~일) pill
ck(
  "기간 값(YY년 M/D(월) ~ YY년 M/D(일)) 노출",
  /\d{2}년\s*\d{1,2}\/\d{1,2}\(.\)\s*~\s*\d{2}년\s*\d{1,2}\/\d{1,2}\(.\)/.test(flat),
);

// 2) 상태 강조 배지 — [공식 활동]/[공식 휴식] 중 하나 + "주차" 접미.
const hasRest = flat.includes("공식 휴식 주차");
const hasActive = flat.includes("공식 활동 주차");
ck("상태 배지 [공식 활동]/[공식 휴식] 중 하나", hasRest !== hasActive, hasRest ? "공식 휴식" : hasActive ? "공식 활동" : "(없음)");
ck("'전환' 상태 비노출(전환 주차도 휴식 취급)", !flat.includes("전환"));

// 3) 4개 클럽 탭
for (const t of ["통합", "엥크레", "오랑캐", "팔랑크스"]) {
  ck(`클럽 탭 '${t}' 노출`, body.includes(t));
}

// 4) 탭 전환 시 섹션.0 동일 유지
const baseline = s0;
for (const t of ["엥크레", "오랑캐", "팔랑크스", "통합"]) {
  await page.getByRole("button", { name: t, exact: true }).click();
  await page.waitForTimeout(250);
  const after = await section0Text();
  ck(`'${t}' 탭 전환 후 섹션.0 동일`, after === baseline, after === baseline ? "" : "텍스트 변경됨");
}

await browser.close();
console.log(`\n${fail === 0 ? "✅ PASS" : `❌ FAIL (${fail})`}`);
process.exit(fail === 0 ? 0 : 1);
