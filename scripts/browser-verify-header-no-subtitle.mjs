// 브라우저(인증 세션) 검증 — 페이지 헤더 서브타이틀(전역) 제거.
//   · 어드민 각 페이지 상단 헤더가 H1만 노출하고
//     서브타이틀(p.text-sm.text-muted-foreground)을 헤더 영역에 더 이상 두지 않는지
//   · AdminPageHeader 계열(탭 포함)과 인라인 헤더 계열을 모두 확인
//   · 일반 모드와 ?mode=test(QA) 모두 동일하게 적용되는지
// 사용법: node scripts/browser-verify-header-no-subtitle.mjs
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
const admin = createClient(SUPABASE_URL, SERVICE);

async function makeAdminCookies() {
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await browser.auth.verifyOtp({
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

// 페이지 헤더 상태를 DOM 에서 읽는다.
//   - 첫 h1 텍스트
//   - 헤더 영역(h1 의 부모/조부모) 안에 p.text-sm.text-muted-foreground 서브타이틀이 있는지
//   - (참고) 문서 전체에서 헤더 직속(h1 의 형제 또는 부모의 자식) 서브타이틀 개수
async function readHeader(page) {
  return page.evaluate(() => {
    const h1 = document.querySelector("h1");
    if (!h1) return { h1: null, headerSubtitle: false, parentChainSubtitle: false };
    const isSubtitleP = (el) =>
      el &&
      el.tagName === "P" &&
      el.classList.contains("text-sm") &&
      el.classList.contains("text-muted-foreground");
    // h1 의 형제 중 서브타이틀 p
    const siblingSubtitle = Array.from(h1.parentElement?.children ?? []).some(
      (c) => c !== h1 && isSubtitleP(c),
    );
    // h1 의 부모/조부모 컨테이너 안의 서브타이틀 p (헤더 블록 범위)
    const parent = h1.parentElement;
    const grand = parent?.parentElement;
    const inParent = parent ? Array.from(parent.querySelectorAll("p.text-sm.text-muted-foreground")).length : 0;
    // 조부모 직속 자식들 중 서브타이틀(헤더 래퍼가 한 단계 더 있는 경우)
    const inGrandDirect = grand
      ? Array.from(grand.children).filter((c) => isSubtitleP(c)).length
      : 0;
    return {
      h1: h1.textContent?.trim() ?? "",
      h1cls: h1.className,
      siblingSubtitle,
      inParent,
      inGrandDirect,
    };
  });
}

const PAGES = [
  // [경로, 기대 제목 일부, 종류]
  ["/admin/members?org=encre", "크루 관리", "AdminPageHeader"],
  ["/admin/line-opening/practical-info?org=encre", "실무 정보", "AdminPageHeader"],
  ["/admin/line-opening/practical-experience?org=encre", "실무 경험", "AdminPageHeader"],
  ["/admin/line-opening/practical-competency?org=encre", "실무 역량", "AdminPageHeader"],
  ["/admin/processes/check/info?org=encre", "급", "ProcessCheckManager"],
  ["/admin/test-users", "테스트 모드", "inline"],
  ["/admin/season-weeks?org=encre", "주차와 시즌", "inline(SeasonWeeks)"],
  ["/admin/official-rest-periods", "공식 휴식 관리", "inline"],
  ["/admin/periods/register", "기간 등록", "inline"],
  ["/admin/settings/line-opening-windows", "라인 개설 기간", "inline"],
  ["/admin/line-opening/practical-career?org=encre", "실무 경력", "inline"],
  ["/admin/weekly-card-finalization", "주차 카드 집계 확정", "inline"],
  ["/admin/processes/check/irregular?org=encre", "변동 액트", "inline"],
];

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext();
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

try {
  for (const mode of ["", "mode=test"]) {
    console.log(`\n=== MODE: ${mode || "일반"} ===`);
    for (const [path, titlePart, kind] of PAGES) {
      const url = `${BASE}${path}${mode ? (path.includes("?") ? "&" : "?") + mode : ""}`;
      await page.goto(url, { waitUntil: "networkidle" }).catch(() => {});
      const h = await readHeader(page);
      const titleOk = (h.h1 ?? "").includes(titlePart);
      const noSubtitle = h && !h.siblingSubtitle && (h.inGrandDirect === 0);
      check(`[${kind}] ${path} — 제목 노출`, titleOk, h?.h1 ?? "(no h1)");
      check(
        `[${kind}] ${path} — 헤더 서브타이틀 없음`,
        noSubtitle,
        `sibling=${h?.siblingSubtitle} grandDirect=${h?.inGrandDirect} parentAny=${h?.inParent}`,
      );
    }
  }
  console.log(`\n=== RESULT: ${pass} pass / ${fail} fail ===`);
} catch (e) {
  console.error("ERROR:", e);
  fail++;
} finally {
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}
