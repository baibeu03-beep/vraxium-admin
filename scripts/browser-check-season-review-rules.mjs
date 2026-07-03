// 이력서 카드(어드민 ResumeCardEditor) 시즌 검수 규칙 브라우저 검증.
//   기대: 26 봄 시즌 review="승인 완료"(종전 "검수 중" 결함) + 26 여름 시즌 "진행 중" 즉시 노출.
//   read-only(백엔드 write 없음).
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
const USER = process.argv[2] || "209e27c2-"; // 실사용자(김세진) 기본
const ORG = "encre";

// USER prefix → 전체 UUID 해소.
let userId = USER;
if (!/^[0-9a-f-]{36}$/.test(USER)) {
  const { data } = await sb.from("user_week_statuses").select("user_id").eq("season_key", "2026-spring").limit(200);
  const ids = [...new Set((data ?? []).map((r) => r.user_id))];
  userId = ids.find((id) => id.startsWith(USER.replace(/-$/, ""))) ?? ids[0];
}
console.log("target userId:", userId);

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
await context.addCookies(cookies);
const page = await context.newPage();
await page.goto(`${BASE}/admin/crews/${ORG}/${userId}`, { waitUntil: "domcontentloaded", timeout: 90000 });

// 시즌 기록 표가 채워질 때까지 대기(연/시즌명/검수 텍스트 등장).
let rows = [];
for (let i = 0; i < 40; i++) {
  rows = await page.evaluate(() => {
    const trs = [...document.querySelectorAll("table tr")];
    const out = [];
    for (const tr of trs) {
      const cells = [...tr.querySelectorAll("td")].map((c) => c.textContent.trim());
      const joined = cells.join("|");
      if (/(봄|여름|가을|겨울)\s*시즌/.test(joined) && /(검수 중|승인 완료)/.test(joined)) {
        out.push(cells);
      }
    }
    return out;
  });
  if (rows.length > 0) break;
  await page.waitForTimeout(1500);
}

console.log("\n시즌 기록 행:");
for (const r of rows) console.log("  ", JSON.stringify(r));

const flat = rows.map((r) => r.join(" "));
const springApproved = flat.some((r) => r.includes("봄 시즌") && r.includes("승인 완료"));
const summerShown = flat.some((r) => r.includes("여름 시즌") && r.includes("진행 중"));
console.log(`\n26 봄 = 승인 완료 : ${springApproved ? "✅" : "❌"}`);
console.log(`26 여름 진행 중 노출 : ${summerShown ? "✅" : "❌"}`);

await page.screenshot({ path: "claudedocs/qa-season-review-rules.png", fullPage: false }).catch(() => {});
await browser.close();
process.exit(springApproved && summerShown ? 0 : 1);
