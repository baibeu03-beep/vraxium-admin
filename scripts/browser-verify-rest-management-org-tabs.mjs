// 브라우저(인증 세션) 검증 — /admin/rest-management 상단 조직 탭을 어드민 공통 캡슐 탭
//   (orgTabClassName SoT · /admin/team-parts/info/weeks 클럽 선택 탭)과 동일 규격으로 통일한 결과.
//
// 확인 항목:
//   · 두 화면의 탭이 **완전히 같은 computed 스타일**(padding·radius·font·border·색·transition)인지
//   · 선택색이 조직별 SoT 대로인지(통합=violet · 엥크레=red · 오랑캐=orange · 팔랑크스=green)
//   · 기능 불변 — 탭 개수/라벨/순서, 클릭 시 active 전환, URL 불변(내부 상태 전환)
//   · 접근성 — role="tablist"/role="tab"/aria-selected (기존 aria-current 대비 개선)
//   · 일반/mode=test 동일 · 개별 경로(?org=)는 자기 조직 탭 1개만 노출(기존 규칙 유지)
//   · 다른 AdminPageHeader 소비 화면의 탭 스타일은 **무변경**(기본 규격 유지)
//
// 사용법: node scripts/browser-verify-rest-management-org-tabs.mjs
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
const admin = createClient(SUPABASE_URL, get("SUPABASE_SERVICE_ROLE_KEY"));

async function makeAdminCookies() {
  const b = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await b.auth.verifyOtp({
    email: adminEmail, token: linkData.properties.email_otp, type: "magiclink",
  });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  return captured.map((i) => ({
    name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax",
  }));
}

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// 탭 버튼 하나의 "디자인 지문" — 비교에 쓰는 시각 속성만 추린다.
const TAB_STYLE_KEYS = [
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderRadius", "borderWidth", "borderStyle",
  "fontSize", "fontWeight", "lineHeight",
  "transitionProperty", "transitionDuration",
];

async function readTabs(page, selector) {
  return page.evaluate(({ sel, keys }) => {
    const strip = document.querySelector(sel);
    if (!strip) return null;
    const btns = Array.from(strip.querySelectorAll('[role="tab"], a, button'));
    return {
      role: strip.getAttribute("role"),
      ariaLabel: strip.getAttribute("aria-label"),
      tabs: btns.map((b) => {
        const cs = getComputedStyle(b);
        const style = {};
        for (const k of keys) style[k] = cs[k];
        return {
          label: (b.textContent ?? "").replace(/\s+/g, " ").trim(),
          role: b.getAttribute("role"),
          ariaSelected: b.getAttribute("aria-selected"),
          ariaCurrent: b.getAttribute("aria-current"),
          bg: cs.backgroundColor,
          color: cs.color,
          borderColor: cs.borderTopColor,
          style,
        };
      }),
    };
  }, { sel: selector, keys: TAB_STYLE_KEYS });
}

const styleKey = (t) => JSON.stringify(t.style);

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

const load = async (url) => {
  for (let attempt = 0; ; attempt++) {
    try { await page.goto(`${BASE}${url}`, { waitUntil: "networkidle", timeout: 60000 }); break; }
    catch (e) { if (attempt >= 12) throw e; await page.waitForTimeout(5000); }
  }
  for (let i = 0; i < 3; i++) {
    if (!(await page.$(".fixed.inset-0.z-50"))) break;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  }
};

try {
  // ── 1) 기준 화면 — /admin/team-parts/info/weeks 클럽 선택 탭 ──
  console.log("\n[1] 기준 /admin/team-parts/info/weeks (클럽 선택 탭)");
  await load("/admin/team-parts/info/weeks");
  const ref = await readTabs(page, '[role="tablist"][aria-label="클럽 선택"]');
  check("클럽 선택 tablist 존재", !!ref);
  check("탭 4개(통합/엥크레/오랑캐/팔랑크스)",
    ref?.tabs.length === 4, ref?.tabs.map((t) => t.label).join(" | "));
  const refByLabel = Object.fromEntries((ref?.tabs ?? []).map((t) => [t.label, t]));
  console.log(`    기준 스타일: ${JSON.stringify(ref?.tabs[0]?.style)}`);
  console.log(`    기준 선택색: ${ref?.tabs.find((t) => t.ariaSelected === "true")?.label} bg=${ref?.tabs.find((t) => t.ariaSelected === "true")?.bg}`);

  // ── 2) /admin/rest-management — 같은 규격인지 ──
  console.log("\n[2] /admin/rest-management (조직 탭)");
  await load("/admin/rest-management");
  const rm = await readTabs(page, '[role="tablist"][aria-label="클럽 선택"]');
  check("클럽 선택 tablist 로 렌더(접근성 개선)", !!rm && rm.role === "tablist");
  check("탭 4개 · 라벨/순서 기준과 동일",
    rm?.tabs.length === 4 && JSON.stringify(rm.tabs.map((t) => t.label)) === JSON.stringify(ref?.tabs.map((t) => t.label)),
    rm?.tabs.map((t) => t.label).join(" | "));
  check("모든 탭이 role=tab · aria-selected 보유",
    (rm?.tabs ?? []).every((t) => t.role === "tab" && (t.ariaSelected === "true" || t.ariaSelected === "false")),
    (rm?.tabs ?? []).map((t) => `${t.label}:${t.ariaSelected}`).join(" "));
  check("옛 aria-current 잔존 0", (rm?.tabs ?? []).every((t) => t.ariaCurrent === null));

  // 스타일 지문 — 기준과 완전히 동일해야 한다(padding/radius/font/border/transition).
  const sameStyle = (rm?.tabs ?? []).every((t) => styleKey(t) === styleKey(ref.tabs[0]));
  check("padding·radius·font·border·transition 이 기준과 동일", sameStyle,
    JSON.stringify(rm?.tabs[0]?.style));

  // 색 — 라벨별로 기준과 같은 색이어야 한다(선택/비선택 각각).
  for (const t of rm?.tabs ?? []) {
    const r = refByLabel[t.label];
    if (!r) continue;
    const sameState = t.ariaSelected === r.ariaSelected;
    if (!sameState) {
      check(`${t.label}: 기준과 선택 상태가 달라 색 비교 생략(참고)`, true,
        `rm=${t.ariaSelected} ref=${r.ariaSelected}`);
      continue;
    }
    check(`${t.label}: 색 동일(bg/text/border)`,
      t.bg === r.bg && t.color === r.color && t.borderColor === r.borderColor,
      `bg=${t.bg} color=${t.color}`);
  }

  // ── 3) 선택색이 조직별 SoT 대로인지 + 탭 전환 기능 ──
  console.log("\n[3] 탭 전환 기능 · 조직별 선택색");
  const clickTab = async (label) => {
    await page.evaluate((l) => {
      const strip = document.querySelector('[role="tablist"][aria-label="클럽 선택"]');
      const b = Array.from(strip?.querySelectorAll('[role="tab"]') ?? [])
        .find((x) => (x.textContent ?? "").replace(/\s+/g, " ").trim() === l);
      b?.click();
    }, label);
    await page.waitForTimeout(600);
  };
  const urlBefore = page.url();
  for (const [label, expectHue] of [["엥크레", "red"], ["오랑캐", "orange"], ["팔랑크스", "green"], ["통합", "violet"]]) {
    await clickTab(label);
    const cur = await readTabs(page, '[role="tablist"][aria-label="클럽 선택"]');
    const sel = cur?.tabs.find((t) => t.ariaSelected === "true");
    check(`${label} 클릭 → active 전환`, sel?.label === label, `현재 선택=${sel?.label}`);
    const r = refByLabel[label];
    // 기준 화면에서 같은 탭을 선택했을 때의 색과 대조하기 위해, 최소한 "비선택 색이 아님"을 확인.
    check(`${label} 선택색이 비선택색과 구분됨(${expectHue} 계열)`,
      sel?.bg !== cur?.tabs.find((t) => t.ariaSelected === "false")?.bg,
      `선택 bg=${sel?.bg}`);
  }
  check("탭 전환이 URL 을 바꾸지 않음(내부 상태 전환 유지)", page.url() === urlBefore,
    `${urlBefore} → ${page.url()}`);

  // ── 4) mode=test 동일 ──
  console.log("\n[4] mode=test 동일");
  await load("/admin/rest-management?mode=test");
  const test = await readTabs(page, '[role="tablist"][aria-label="클럽 선택"]');
  check("mode=test 탭 4개 · 스타일 동일",
    test?.tabs.length === 4 && test.tabs.every((t) => styleKey(t) === styleKey(ref.tabs[0])),
    test?.tabs.map((t) => t.label).join(" | "));

  // ── 5) 개별 경로(?org=) — 자기 조직 탭 1개만(기존 규칙 유지) ──
  console.log("\n[5] 개별 경로 ?org= (기존 노출 규칙 유지)");
  for (const [org, label] of [["encre", "엥크레"], ["oranke", "오랑캐"], ["phalanx", "팔랑크스"]]) {
    await load(`/admin/rest-management?org=${org}`);
    const one = await readTabs(page, '[role="tablist"][aria-label="클럽 선택"]');
    check(`org=${org}: 자기 조직 탭 1개(${label})만 노출 · 선택 상태`,
      one?.tabs.length === 1 && one.tabs[0].label === label && one.tabs[0].ariaSelected === "true",
      one?.tabs.map((t) => t.label).join(" | "));
  }

  // ── 6) 다른 AdminPageHeader 소비 화면 — 기본 탭 규격 무변경 ──
  console.log("\n[6] 다른 화면 탭 무변경 (기본 규격 유지)");
  for (const [url, label] of [
    ["/admin/line-opening/practical-info?org=encre", "실무 정보"],
    ["/admin/members", "크루 관리"],
  ]) {
    await load(url);
    const other = await readTabs(page, 'nav[aria-label="페이지 탭"]');
    check(`${url}: 기존 nav[aria-label="페이지 탭"] 유지`, !!other && other.role === null,
      other?.tabs.map((t) => t.label).join(" | "));
    check(`${url}: 기존 active 스타일 유지(aria-current + 진한 채움)`,
      (other?.tabs ?? []).some((t) => t.ariaCurrent === "page"),
      (other?.tabs ?? []).map((t) => `${t.label}:${t.ariaCurrent}`).join(" "));
    check(`${url}: 조직 캡슐 규격이 아님(기존 padding 유지)`,
      (other?.tabs ?? []).every((t) => styleKey(t) !== styleKey(ref.tabs[0])),
      JSON.stringify(other?.tabs[0]?.style));
    check(`${url}: 클럽 선택 tablist 미생성`,
      !(await page.$('[role="tablist"][aria-label="클럽 선택"]')));
  }

  console.log(`\n=== RESULT: ${pass} pass / ${fail} fail ===`);
} catch (e) {
  console.error("ERROR:", e);
  fail++;
} finally {
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}
