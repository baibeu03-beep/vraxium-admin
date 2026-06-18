// 브라우저 검증 — /admin/processes/check 하위(공용 ProcessCheckManager) 섹션 제목 추가.
//   [액트 관리]=상태창/로그창 위 · [액트 체크]=액트 테이블 위. info/experience/competency/club 공통.
//   기존 카드/테이블/체크 필요 버튼/org 쿼리 유지(읽기 전용 회귀 확인). net-zero.
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
const EMAIL = "vanuatu.golden@gmail.com", BASE = "http://localhost:3000";
const URL = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");

async function cookies() {
  const admin = createClient(URL, SERVICE), browser = createClient(URL, ANON);
  const { data: l } = await admin.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const { data: v } = await browser.auth.verifyOtp({ email: EMAIL, token: l.properties.email_otp, type: "magiclink" });
  const cap = [];
  const s = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await s.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}
let pass = 0, fail = 0; const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

const HUBS = ["info", "experience", "competency", "career"];
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  await ctx.addCookies(await cookies());
  const page = await ctx.newPage();

  for (const hub of HUBS) {
    console.log(`\n[${hub}] /admin/processes/check/${hub}?org=encre`);
    await page.goto(`${BASE}/admin/processes/check/${hub}?org=encre`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);

    // career 는 placeholder(공용 ProcessCheckManager 미사용) — 섹션 제목 비대상.
    if (hub === "career") {
      const body = (await page.locator("body").textContent()) ?? "";
      ck("[career] placeholder(공용 매니저 미사용 → 섹션 제목 없음)", !/\[액트 관리\]/.test(body) && !/\[액트 체크\]/.test(body),
        "추후 구현 예정 placeholder");
      continue;
    }

    // 섹션 제목 — 공용 SectionTitle(h2) 로 렌더.
    const manageTitle = page.locator("h2", { hasText: "[액트 관리]" });
    const checkTitle = page.locator("h2", { hasText: "[액트 체크]" });
    ck("[액트 관리] 제목 표시", (await manageTitle.count()) > 0);
    ck("[액트 체크] 제목 표시", (await checkTitle.count()) > 0);

    // 공통 스타일 확인(text-sm font-semibold text-foreground tracking-tight mb-2).
    const cls = (await manageTitle.first().getAttribute("class")) ?? "";
    ck("제목 공통 스타일(text-sm/font-semibold/tracking-tight/mb-2)",
      /text-sm/.test(cls) && /font-semibold/.test(cls) && /tracking-tight/.test(cls) && /mb-2/.test(cls), cls);

    // [액트 관리] 가 상태창/로그창 위에 위치하는지 — DOM 순서로 확인.
    const order = await page.evaluate(() => {
      const h2s = Array.from(document.querySelectorAll("h2"));
      const manage = h2s.find((e) => e.textContent?.includes("[액트 관리]"));
      const stateCard = Array.from(document.querySelectorAll("*")).find((e) => e.textContent?.trim() === "상태창");
      if (!manage || !stateCard) return null;
      // compareDocumentPosition: 4 = stateCard follows manage
      return (manage.compareDocumentPosition(stateCard) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    });
    ck("[액트 관리]가 상태창보다 위", order === true, `order=${order}`);

    // 기존 카드/테이블/체크 버튼 유지(회귀).
    const body = (await page.locator("body").textContent()) ?? "";
    ck("상태창/로그창 유지", /상태창/.test(body) && /로그창/.test(body));
    ck("'체크 필요' 또는 '체크 완료' 버튼 존재(테이블 동작 유지)", /체크 필요|체크 완료|체크 중/.test(body));

    // org 쿼리스트링 유지.
    ck("org 쿼리스트링 유지", page.url().includes("org=encre"), page.url());
  }
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally { await browser.close(); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); }
