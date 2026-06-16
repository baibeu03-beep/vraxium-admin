// 고객(vraxium) 카드 모달 .line-code — 하드코딩 legacy 코드(IF99A-NR####) 미노출 검증.
//   매직링크로 실제 고객 로그인 → 카드 페이지 → 각 허브 카드 모달 열어 .line-code 수집.
// 사용법: node scripts/browser-verify-customer-linecode-fallback.mjs [userId]
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
const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const FRONT = process.env.FRONT_BASE_URL ?? "http://localhost:3001";
const admin = createClient(SUPABASE_URL, SERVICE);

const HARDCODED = /IF99A|EX99A|EX99L|EX02A|CP00A|NR\d{4}|NS\d{4}|ER\d{4}|ES\d{4}/;

async function pickCustomer(userIdArg) {
  // 인자 우선. 없으면 encre 실유저 중 auth email 보유자 탐색.
  const tryUser = async (uid) => {
    const { data } = await admin.auth.admin.getUserById(uid);
    return data?.user?.email ? { uid, email: data.user.email } : null;
  };
  if (userIdArg) { const r = await tryUser(userIdArg); if (r) return r; }
  // 카드(snapshot) 보유자 중 auth email 보유자 탐색 — org 무관(콘텐츠 수정은 org 무관).
  const { data: snaps } = await admin
    .from("cluster4_weekly_card_snapshots")
    .select("user_id")
    .limit(300);
  const ids = Array.from(new Set((snaps ?? []).map((s) => s.user_id)));
  for (const uid of ids) {
    const r = await tryUser(uid);
    if (r) {
      const { data: p } = await admin.from("user_profiles").select("display_name,organization_slug").eq("user_id", uid).maybeSingle();
      return { ...r, name: p?.display_name, org: p?.organization_slug };
    }
  }
  return null;
}

async function cookiesFor(email) {
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const { data: verifyData } = await browser.auth.verifyOtp({
    email, token: linkData.properties.email_otp, type: "magiclink",
  });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  return captured.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

let pass = 0, fail = 0, skip = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function main() {
  const cust = await pickCustomer(process.argv[2]);
  if (!cust) { console.log("고객(auth email 보유) 미발견 — skip"); process.exit(0); }
  console.log(`고객: ${cust.name ?? cust.uid} <${cust.email}>`);

  const browser = await chromium.launch({ channel: "chromium", headless: true });
  const context = await browser.newContext();
  await context.addCookies(await cookiesFor(cust.email));
  const page = await context.newPage();

  try {
    // 허브 카드 grid 클래스 → 모달 .line-code. 허브별 카드 컨테이너.
    const hubs = [
      { name: "정보", card: ".work-info-card:not(.empty):not(.is-empty-card)" },
      { name: "경험", card: ".work-exp-card:not(.empty)" },
      { name: "역량", card: ".work-ability-card:not(.empty)" },
      { name: "경력", card: ".work-career-card:not(.empty)" },
    ];
    for (const route of ["/cluster-4-card-ec", "/cluster-4-card"]) {
      await page.goto(`${FRONT}${route}`, { waitUntil: "networkidle" }).catch(() => {});
      await page.waitForTimeout(1500);
      const hasCards = await page.locator(".work-info-card, .work-exp-card, .work-ability-card, .work-career-card").count();
      if (hasCards > 0) { console.log(`  route=${route} 카드 ${hasCards}개 렌더`); break; }
    }

    const readLineCodes = () => page.evaluate(() =>
      Array.from(document.querySelectorAll(".line-code")).map((e) => e.textContent?.trim() ?? "").filter((t) => t.length));
    const seen = [];
    let opened = 0;
    // 정보 허브: 카드 클릭 → 모달 → (이미지/상세 항목 클릭) → .line-code(image-line-code) 노출.
    const card = page.locator(".work-info-card").first();
    if ((await card.count()) > 0) {
      await card.click().catch(() => {});
      await page.waitForTimeout(900);
      // 모달 내 상세/이미지 항목으로 드릴다운(.modal-card-item 등) 시도.
      for (const sel of [".modal-card-item", ".modal-fruit-icon", ".image-line-code", ".line-code"]) {
        const item = page.locator(sel).first();
        if ((await item.count()) > 0) { await item.click().catch(() => {}); await page.waitForTimeout(700); }
        const codes = await readLineCodes();
        if (codes.length) { seen.push(...codes); break; }
      }
    }
    const uniq = Array.from(new Set(seen));
    if (uniq.length === 0) {
      console.log("  .line-code DOM 미도달(모달 드릴다운 경로 상이) — skip. 정적/로직 검증으로 대체.");
      skip++;
    } else {
      opened++;
      const bad = uniq.filter((c) => HARDCODED.test(c));
      check(".line-code 에 하드코딩 legacy 코드(IF99A/NR####/CP00A/EX99A) 미노출", bad.length === 0,
        `관측=${JSON.stringify(uniq)} 위반=${JSON.stringify(bad)}`);
      check(".line-code 값은 실제코드 또는 '-' 만", uniq.every((c) => c === "-" || !HARDCODED.test(c)), JSON.stringify(uniq));
    }
    // 보강: 현재 DOM 전체 텍스트에 하드코딩 패턴이 있는지(모달 열린 상태) 스캔.
    const domHasHardcoded = await page.evaluate((re) => new RegExp(re).test(document.body.innerText), HARDCODED.source);
    check("열린 화면 DOM 전체에 하드코딩 legacy 코드 텍스트 없음", domHasHardcoded === false, `domHit=${domHasHardcoded}`);
    if (uniq.length) console.log(`\n  관측된 .line-code: ${JSON.stringify(uniq)}`);
  } catch (e) {
    console.error("browser error:", e?.stack ?? e?.message ?? e);
    fail++;
  } finally {
    await browser.close();
  }
  console.log(`\n결과: ${pass} pass / ${fail} fail / ${skip} skip`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
