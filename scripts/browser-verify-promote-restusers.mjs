// 검증(브라우저) — 승격 RestUsers 가 /admin/members/[userId] 크루 상세에 "시즌 휴식" 으로 실제 렌더.
//   1) 크루 이름 노출  2) 현재 시즌 "휴식 중" 텍스트  3) 상태 배지(시즌 휴식/Recharging 계열)
//   사전: admin dev :3000. Usage: node scripts/browser-verify-promote-restusers.mjs
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
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE), brow = createClient(URL_, ANON);
const EMAIL = "vanuatu.golden@gmail.com";

let fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));

const orgIdx = process.argv.indexOf("--org");
const ORG = orgIdx >= 0 ? process.argv[orgIdx + 1].trim() : null;
const sampleIdx = process.argv.indexOf("--sample");
const SAMPLE = sampleIdx >= 0 ? Number(process.argv[sampleIdx + 1]) : 3;
let q = sb.from("legacy_pms_restuser_archive")
  .select("source_system,legacy_user_id,name,promoted_user_id,organization_slug").eq("promotion_status", "promoted").order("legacy_user_id");
if (ORG) q = q.eq("organization_slug", ORG);
const { data: all } = await q;
const arr = all ?? [];
const promoted = arr.length <= SAMPLE ? arr
  : Array.from({ length: SAMPLE }, (_, i) => arr[Math.floor((i * (arr.length - 1)) / (SAMPLE - 1))]);
console.log(`브라우저 검증 표본 ${promoted.length}/${arr.length}${ORG ? ` org=${ORG}` : ""}`);

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
await context.addCookies(cookies);
const page = await context.newPage();

for (const p of promoted ?? []) {
  const uid = p.promoted_user_id;
  console.log(`\n=== ${p.source_system}/${p.legacy_user_id} ${p.name} ===`);
  await page.goto(`${BASE}/admin/members/${uid}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  const body = await page.evaluate(() => document.body.innerText);
  ck("크루 이름 노출", body.includes(p.name), p.name);
  ck("현재 시즌 '휴식 중' 렌더", body.includes("휴식 중"));
  ck("'시즌 휴식' 또는 'Recharging' 배지", body.includes("시즌 휴식") || body.toLowerCase().includes("recharging"));
}

await browser.close();
console.log(`\n${fail === 0 ? "✅ 브라우저 검증 통과" : "✗ " + fail + "건 실패"}`);
process.exit(fail ? 1 : 0);
