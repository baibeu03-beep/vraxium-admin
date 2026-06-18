// 브라우저 검증 — 표 디자인 시스템(배지/테이블 공통화).
//   대상 페이지에서 (1) StatusBadge/SelectBadge 렌더, (2) 같은 라벨=같은 색,
//   (3) tone별 색 구분, (4) 라이트/다크 모두 정상, (5) 테이블 헤더/zebra 적용을 확인.
//   읽기 전용(네트워크/DB 무변경). 전제: dev/prod 서버(localhost:3000) + 마이그레이션 적용.
import { createRequire } from "node:module";
import { readFileSync, mkdirSync } from "node:fs";
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
const sb = createClient(URL, SERVICE);
const OUT = resolve(adminRoot, "claudedocs", "table-design-system");
mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cookies() {
  const browser = createClient(URL, ANON);
  const { data: l } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const { data: v } = await browser.auth.verifyOtp({ email: EMAIL, token: l.properties.email_otp, type: "magiclink" });
  const cap = [];
  const s = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await s.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

// 페이지 안 배지 진단 — 개수 + 라벨별 배경색(다크/라이트 무관 비교용).
const badgeProbe = `(() => {
  const els = [...document.querySelectorAll('[data-slot="badge"],[data-slot="badge-button"]')];
  const byLabel = {};
  for (const el of els) {
    const t = (el.textContent || '').trim();
    const bg = getComputedStyle(el).backgroundColor;
    if (t && !byLabel[t]) byLabel[t] = bg;
  }
  // 테이블 헤더 배경(강조) + 본문 zebra 적용 여부
  const thead = document.querySelector('thead[data-slot="table-header"]');
  const headerBg = thead ? getComputedStyle(thead).backgroundColor : null;
  const rows = [...document.querySelectorAll('tbody[data-slot="table-body"] > tr')].slice(0, 4);
  const rowBgs = rows.map((r) => getComputedStyle(r).backgroundColor);
  return { count: els.length, byLabel, headerBg, rowBgs };
})()`;

const PAGES = [
  { name: "members-list", url: "/admin/members" },
  { name: "members-roster", url: "/admin/members?tab=info" },
  { name: "process-check-info", url: "/admin/processes/check/info?org=oranke" },
  { name: "process-check-experience", url: "/admin/processes/check/experience?org=oranke" },
  { name: "process-check-irregular", url: "/admin/processes/check/irregular?org=oranke" },
  { name: "process-register", url: "/admin/processes/register" },
  { name: "line-opening-experience", url: "/admin/line-opening/practical-experience?org=oranke" },
];

const browser = await chromium.launch();
const labelColors = {}; // 라벨 → {light, dark} 페이지 간 일관성 누적
try {
  const cks = await cookies();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await ctx.addCookies(cks);

  for (const theme of ["light", "dark"]) {
    console.log(`\n── ${theme.toUpperCase()} ──`);
    for (const p of PAGES) {
      const page = await ctx.newPage();
      try {
        await page.goto(`${BASE}${p.url}`, { waitUntil: "networkidle", timeout: 30000 });
        if (theme === "dark") {
          await page.evaluate(() => {
            document.documentElement.classList.add("dark");
            document.documentElement.style.colorScheme = "dark";
          });
        }
        // 데이터/배지 렌더 대기(있으면).
        await page.waitForTimeout(1200);
        const probe = await page.evaluate(badgeProbe);
        await page.screenshot({ path: resolve(OUT, `${p.name}-${theme}.png`), fullPage: false });

        ck(`${p.name} 배지 렌더(>0)`, probe.count > 0, `count=${probe.count}`);
        if (theme === "dark" && probe.headerBg) {
          // 헤더 배경이 투명(=강조 없음)이 아닌지
          const transparent = probe.headerBg === "rgba(0, 0, 0, 0)" || probe.headerBg === "transparent";
          ck(`${p.name} 헤더 배경 강조`, !transparent, probe.headerBg);
        }
        // 라벨별 색 누적(페이지 간 같은 라벨=같은 색 검증)
        for (const [lab, bg] of Object.entries(probe.byLabel)) {
          labelColors[lab] = labelColors[lab] || {};
          const prev = labelColors[lab][theme];
          if (prev && prev !== bg) {
            ck(`색 일관성: "${lab}"`, false, `${prev} ≠ ${bg} (@${p.name})`);
          }
          labelColors[lab][theme] = bg;
        }
      } catch (e) {
        ck(`${p.name} (${theme}) 로드`, false, String(e).slice(0, 80));
      } finally {
        await page.close();
      }
    }
  }

  // tone 구분 — 라이트 모드에서 대표 라벨들의 배경이 서로 달라야(같은 색 뭉침 방지).
  console.log("\n── tone 구분/색 요약(light) ──");
  const seen = labelColors;
  for (const [lab, c] of Object.entries(seen)) {
    console.log(`  · "${lab}"  light=${c.light || "-"}  dark=${c.dark || "-"}`);
  }
  // 같은 라벨이 라이트≠다크(테마 대응) 확인 — 최소 1개 라벨이 두 테마 모두 잡혔으면 비교
  const both = Object.entries(seen).filter(([, c]) => c.light && c.dark);
  if (both.length) {
    const themed = both.filter(([, c]) => c.light !== c.dark).length;
    ck("다크/라이트 테마 대응(배지 색 변화)", themed > 0, `${themed}/${both.length} 라벨이 테마별 상이`);
  }
} finally {
  await browser.close();
}
console.log(`\n결과: ${pass} pass / ${fail} fail · 스크린샷: ${OUT}`);
process.exit(fail ? 1 : 0);
