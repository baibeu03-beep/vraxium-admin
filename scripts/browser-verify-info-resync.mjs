// 브라우저(관리자 세션) 검증 — /admin/line-opening/practical-info?org=oranke 에 재동기화 반영.
//   1) 실제 관리자 쿠키로 페이지 로드 → 스크린샷.
//   2) 브라우저 컨텍스트 in-page fetch 로 info-line-results(live) 호출 → 변경된 제목/링크가 direct(DB)와 일치.
//   세 가지(direct·HTTP·브라우저 표시) 일치 확인. snapshot 무관(admin live read).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const requireAdmin = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = requireAdmin("@supabase/supabase-js");
const { createServerClient } = requireAdmin("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

const LINE_ID = "2a970769-c4f1-4360-a65f-5123026e97f5"; // 2026-W18 wisdom (제목 변경됨)

async function makeAdminCookies() {
  const b = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await sb.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await b.auth.verifyOtp({ email: adminEmail, token: linkData.properties.email_otp, type: "magiclink" });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (items) => captured.push(...items) } });
  await server.auth.setSession({ access_token: verifyData.session.access_token, refresh_token: verifyData.session.refresh_token });
  return captured.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

async function main() {
  // direct DB 기준값.
  const { data: lineRow } = await sb
    .from("cluster4_lines")
    .select("id,week_id,main_title,output_links")
    .eq("id", LINE_ID).single();
  const weekId = lineRow.week_id;
  const directTitle = lineRow.main_title;
  const directUrls = (lineRow.output_links ?? []).map((l) => l.url).sort().join(" ");

  const browser = await chromium.launch({ channel: "chromium", headless: true });
  const context = await browser.newContext();
  await context.addCookies(await makeAdminCookies());
  const page = await context.newPage();

  await page.goto(`${BASE}/admin/line-opening/practical-info?org=oranke`, { waitUntil: "networkidle" });
  await page.screenshot({ path: "claudedocs/browser-info-resync-oranke.png", fullPage: true });

  // 브라우저 세션 in-page fetch (실제 쿠키·실제 origin) → live info-lines.
  const browserData = await page.evaluate(async ({ weekId, lineId }) => {
    const r = await fetch(`/api/admin/cluster4/info-lines?week_id=${weekId}&organization=oranke`, { headers: { "Content-Type": "application/json" } });
    const j = await r.json().catch(() => ({}));
    const row = (j?.data?.rows ?? []).find((x) => x.id === lineId);
    return { status: r.status, mainTitle: row?.mainTitle ?? null, urls: (row?.outputLinks ?? []).map((l) => l.url).sort().join(" ") };
  }, { weekId, lineId: LINE_ID });

  const titleMatch = browserData.mainTitle === directTitle;
  const urlMatch = browserData.urls === directUrls;

  console.log(JSON.stringify({
    lineId: LINE_ID,
    weekId,
    direct: { title: directTitle, urls: directUrls },
    browserSessionFetch: browserData,
    match: { title: titleMatch, urls: urlMatch },
    screenshot: "claudedocs/browser-info-resync-oranke.png",
    conclusion: (browserData.status === 200 && titleMatch && urlMatch)
      ? "PASS — 브라우저 세션(real cookie/origin) live fetch == direct DB. 제목/링크 반영."
      : "FAIL",
  }, null, 2));

  await browser.close();
}

main().catch((e) => { console.error("ERR", e instanceof Error ? e.message : e); process.exit(1); });
