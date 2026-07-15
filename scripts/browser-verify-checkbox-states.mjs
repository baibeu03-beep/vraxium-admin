// 브라우저 검증 — 공통 Checkbox SoT(components/ui/checkbox.tsx + .admin-checkbox + accent 토큰).
//   실제 HTTP 어드민 화면(operating + mode=test) & 라이트/다크에서:
//   1) accent 토큰(--checkbox-accent/-text/-row)이 테마별로 resolve 되는지
//   2) .admin-checkbox 의 체크/미체크/indeterminate/disabled/readonly 가 서로 구분되는지
//      (appearance:none 커스텀 렌더 + 체크마크 ::after + accent 채움)
//   3) Tailwind 유틸(text-checkbox-accent-text / bg-checkbox-accent-row)이 생성돼 강조에 쓰이는지
//   4) 실제 페이지에 .admin-checkbox 가 렌더되고 스크린샷.
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

let pass = 0, fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1200 } });
await context.addCookies(cookies);
const page = await context.newPage();
page.setDefaultNavigationTimeout(120000);

// 실 문서 컨텍스트에서 .admin-checkbox / 유틸 probe 를 만들고 computed style 을 읽는다.
const probe = () =>
  page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const tok = {
      accent: root.getPropertyValue("--checkbox-accent").trim(),
      text: root.getPropertyValue("--checkbox-accent-text").trim(),
      row: root.getPropertyValue("--checkbox-accent-row").trim(),
    };
    const made = [];
    const mk = (fn) => {
      const i = document.createElement("input");
      i.type = "checkbox";
      i.className = "admin-checkbox";
      fn?.(i);
      document.body.appendChild(i);
      made.push(i);
      return i;
    };
    const unchecked = mk();
    const checked = mk((i) => (i.checked = true));
    const indet = mk((i) => (i.indeterminate = true));
    const disabled = mk((i) => { i.checked = true; i.disabled = true; });
    const readonly = mk((i) => { i.checked = true; i.setAttribute("data-readonly", "true"); });
    const cs = (el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, border: s.borderTopColor, opacity: s.opacity, appearance: s.appearance };
    };
    const after = (el) => getComputedStyle(el, "::after").content;
    // Tailwind 유틸 생성 확인
    const plain = document.createElement("span"); document.body.appendChild(plain); made.push(plain);
    const utilText = document.createElement("span"); utilText.className = "text-checkbox-accent-text"; document.body.appendChild(utilText); made.push(utilText);
    const utilBg = document.createElement("span"); utilBg.className = "bg-checkbox-accent-row"; document.body.appendChild(utilBg); made.push(utilBg);
    const out = {
      tok,
      unchecked: cs(unchecked), uncheckedAfter: after(unchecked),
      checked: cs(checked), checkedAfter: after(checked),
      indet: cs(indet), indetAfter: after(indet),
      disabled: cs(disabled),
      readonly: cs(readonly), readonlyAfter: after(readonly),
      plainColor: getComputedStyle(plain).color,
      utilText: getComputedStyle(utilText).color,
      utilBg: getComputedStyle(utilBg).backgroundColor,
      realCount: document.querySelectorAll(".admin-checkbox").length,
    };
    made.forEach((e) => e.remove());
    return out;
  });

function assertTheme(tag, p) {
  ck(`[${tag}] accent 토큰 resolve`, !!p.tok.accent && !!p.tok.text && !!p.tok.row, `accent=${p.tok.accent}`);
  ck(`[${tag}] 커스텀 렌더(appearance:none)`, p.checked.appearance === "none", `appearance=${p.checked.appearance}`);
  ck(`[${tag}] 체크≠미체크 배경(강조 채움)`, p.checked.bg !== p.unchecked.bg, `checked=${p.checked.bg} unchecked=${p.unchecked.bg}`);
  ck(`[${tag}] 체크마크 ::after 존재`, p.checkedAfter !== "none" && p.uncheckedAfter === "none", `checked=${p.checkedAfter} unchecked=${p.uncheckedAfter}`);
  ck(`[${tag}] indeterminate 채움+막대`, p.indet.bg === p.checked.bg && p.indetAfter !== "none", `bg=${p.indet.bg} after=${p.indetAfter}`);
  ck(`[${tag}] disabled 흐려짐(opacity<1)`, parseFloat(p.disabled.opacity) < 1, `opacity=${p.disabled.opacity}`);
  ck(`[${tag}] readonly ≠ 체크 채움(혼동 방지)`, p.readonly.bg !== p.checked.bg, `readonly=${p.readonly.bg} checked=${p.checked.bg}`);
  ck(`[${tag}] 라벨 강조 유틸 생성(text≠기본색)`, p.utilText !== p.plainColor, `util=${p.utilText} plain=${p.plainColor}`);
  ck(`[${tag}] 행 강조 유틸 생성(bg 채워짐)`, p.utilBg !== "rgba(0, 0, 0, 0)" && p.utilBg !== "transparent", `bg=${p.utilBg}`);
}

async function verify(org, mode) {
  const tag = `${org}${mode ? "/test" : "/operating"}`;
  await page.goto(`${BASE}/admin/line-opening/practical-career?org=${org}${mode ? "&mode=test" : ""}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);

  // 라이트 — ThemeProvider SoT = html.dark class (data-theme 아님).
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.waitForTimeout(200);
  const light = await probe();
  assertTheme(`${tag} light`, light);

  // 다크 — html.dark class → 토큰이 테마별로 갈라지고 여전히 구분되는지
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.waitForTimeout(300);
  const dark = await probe();
  assertTheme(`${tag} dark`, dark);
  ck(`[${tag}] 다크 accent 토큰이 라이트와 다름(테마 대응)`, dark.tok.accent !== light.tok.accent, `light=${light.tok.accent} dark=${dark.tok.accent}`);
  await page.screenshot({ path: resolve(adminRoot, "claudedocs", `checkbox-states-${org}${mode ? "-test" : ""}-dark.png`) });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

try {
  await verify("encre", false); // operating
  await verify("encre", true);  // mode=test — 동일 컴포넌트/스타일 검증
  await verify("oranke", false);
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
} finally {
  await browser.close();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
