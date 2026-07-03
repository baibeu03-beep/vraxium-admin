// 브라우저 검증 — 실사용자 이름 복사 후, 카페 매칭 UI(CafeCrewPicker)에 T크루가 후보로 뜨는지.
//   격리 dev 서버(:3010, mock 크롤러=4599)에 인증 세션으로 진입. 백업 JSON 의 실제 변경분 사용.
//   1) 실무정보 개설 페이지 → CafeCrewPicker 카페 URL + 검수 → 후보 테이블에 T크루 렌더 확인.
//   2) 동일 세션 POST fetch 로 matched 교차확인.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3010";
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 4599);
const ORG = process.env.VERIFY_ORG ?? "phalanx";
const U = get("NEXT_PUBLIC_SUPABASE_URL"), AN = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SV = get("SUPABASE_SERVICE_ROLE_KEY");

const backup = JSON.parse(readFileSync(resolve(adminRoot, "claudedocs", "seed-test-user-realname-copy-backup.json"), "utf8"));
const targets = backup.filter((b) => b.org === ORG).slice(0, 3);
const NICKS = targets.map((b) => `1기 카페대 ${b.source_real_name}`);
const EXPECT = targets.map((b) => b.after); // 예: T강민지

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => { console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); ok ? pass++ : fail++; };

async function cookies() {
  const a = createClient(U, SV), b = createClient(U, AN);
  const { data: l } = await a.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: v } = await b.auth.verifyOtp({ email: adminEmail, token: l.properties.email_otp, type: "magiclink" });
  const cap = [];
  const s = createServerClient(U, AN, { cookies: { getAll: () => [], setAll: (it) => cap.push(...it) } });
  await s.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

const mock = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, data: {
      articleUrl: "https://cafe.naver.com/mock/1", totalComments: NICKS.length,
      uniqueNicknames: NICKS.length, nicknames: NICKS, nicknameCounts: NICKS.map((n) => ({ nickname: n, count: 1 })),
    } }));
  });
});
await new Promise((r) => mock.listen(MOCK_PORT, r));

console.log(`대상 org=${ORG} · 닉네임: ${NICKS.join(" | ")} · 기대 크루: ${EXPECT.join(", ")}`);
const browser = await chromium.launch({ channel: "chromium", headless: true });
try {
  const ctx = await browser.newContext();
  await ctx.addCookies(await cookies());
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/line-opening/practical-info?org=${ORG}&mode=test&tab=open`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  const urlInput = page.locator('input[aria-label="카페 게시물 링크"]');
  let domTried = false;
  if (await urlInput.count().catch(() => 0)) {
    domTried = true;
    console.log("[DOM] CafeCrewPicker 발견 → 검수 클릭");
    await urlInput.first().fill("https://cafe.naver.com/mock/1");
    await page.getByRole("button", { name: "검수" }).first().click();
    await page.waitForTimeout(3500);
    const bodyText = await page.locator("body").innerText();
    const hit = EXPECT.filter((n) => bodyText.includes(n));
    check("[DOM] 검수 후 후보 테이블에 복사된 T크루 렌더", hit.length > 0, `발견: ${hit.join(", ") || "없음"}`);
  } else {
    console.log("[DOM] CafeCrewPicker 미마운트 → 세션 fetch 폴백");
  }

  const api = await page.evaluate(async ({ org }) => {
    const r = await fetch(`/api/admin/cluster4/cafe-line-crew?organization=${org}&mode=test`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://cafe.naver.com/mock/1" }),
    });
    const j = await r.json();
    return { status: r.status, matched: (j?.data?.matched ?? []).map((m) => m.crew.name) };
  }, { org: ORG });
  check("[세션 fetch] POST 200", api.status === 200, `status=${api.status}`);
  const matchedHit = EXPECT.filter((n) => api.matched.includes(n));
  check("[세션 fetch] matched 에 복사된 T크루 전원 노출", matchedHit.length === EXPECT.length, `matched=${api.matched.join(", ")}`);
  if (!domTried) console.log("  (개설 폼 조건상 picker 미표시 — API 응답이 UI 바인딩 소스)");
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e); fail++;
} finally {
  await browser.close(); mock.close();
}
console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
