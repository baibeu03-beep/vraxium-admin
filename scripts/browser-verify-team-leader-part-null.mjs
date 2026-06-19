// 검증(브라우저) — 팀장 part=null 실제 화면 표시.
//   /admin/members/[유재희 uid] 크루 상세에서 [소속 팀]=엔터테인먼트 · [파트]="-" · [클래스]="운영진(팀장)"
//   그리고 페이지 어디에도 "미배정" 경고가 없음을 확인. read-only.
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

let pass = 0,
  fail = 0;
const ck = (l, ok, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};

// 실제 운영 팀장 1명(비-T) — 유재희 우선.
const tls = (
  await sb
    .from("user_profiles")
    .select("user_id,display_name,current_team_name,current_part_name,role")
    .eq("role", "team_leader")
).data;
const tl = tls.find((t) => t.display_name === "유재희") ?? tls.find((t) => !(t.display_name ?? "").startsWith("T"));
ck("[전제] 운영 팀장 1명 확보", !!tl, tl ? `${tl.display_name} 팀=${tl.current_team_name} 파트(DB)=${tl.current_part_name ?? "null"}` : "없음");
if (!tl) process.exit(1);
ck("[전제] 팀장 DB 파트 null(정책 반영됨)", tl.current_part_name == null, JSON.stringify(tl.current_part_name));

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));

const browser = await chromium.launch({ channel: "chromium", headless: true });
try {
  const ctx = await browser.newContext();
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/members/${tl.user_id}`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=클럽 소속", { timeout: 15000 });

  // dt 라벨 → 다음 dd 값 추출.
  const fieldValue = async (label) =>
    page.evaluate((lb) => {
      const dts = Array.from(document.querySelectorAll("dt"));
      const dt = dts.find((d) => d.textContent.trim() === lb);
      const dd = dt?.nextElementSibling;
      return dd ? dd.textContent.trim() : null;
    }, label);

  const team = await fieldValue("소속 팀");
  const part = await fieldValue("파트");
  const cls = await fieldValue("클래스");
  console.log(`  화면: [소속 팀]=${JSON.stringify(team)} [파트]=${JSON.stringify(part)} [클래스]=${JSON.stringify(cls)}`);
  ck("[6] 화면 [소속 팀] 표시(팀 배정 O)", !!team && team === tl.current_team_name, team);
  ck('[6] 화면 [파트] = "-"(null → 대시, 깨짐/빈값 아님)', part === "-", part);
  ck('[6] 화면 [클래스] = "운영진(팀장)"', cls === "운영진(팀장)", cls);

  const bodyText = await page.evaluate(() => document.body.innerText);
  ck('[4] 페이지에 "미배정" 경고 없음', !bodyText.includes("미배정"), bodyText.includes("미배정") ? "발견" : "");
  ck('[4] 페이지에 "필수" 경고 없음', !/파트.*필수|필수.*파트/.test(bodyText), "");
} finally {
  await browser.close();
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
