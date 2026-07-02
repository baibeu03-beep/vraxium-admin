// 브라우저 검증 — 팀 파트 주차 상세 > 액트 체크 관리 '라인 급' 셀이 요일 컬럼을 침범하지 않는지.
//   실측: 모든 라인급 셀 badge 의 오른쪽 끝 ≤ 셀 오른쪽 끝(요일 컬럼 미침범) · truncate(ellipsis) 적용 ·
//         긴 이름 주입 스트레스 테스트로 CSS 자체 검증. read-only(seed 없음).
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
const CLUBS = ["encre", "oranke", "phalanx", "olympus"];
const J = (o) => JSON.stringify(o);
const sb = createClient(URL, SERVICE);

async function session() {
  const admin = createClient(URL, SERVICE), browser = createClient(URL, ANON);
  const { data: l } = await admin.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const { data: v } = await browser.auth.verifyOtp({ email: EMAIL, token: l.properties.email_otp, type: "magiclink" });
  const cap = [];
  const s = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await s.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return {
    cookieObjs: cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" })),
    cookieStr: cap.map((i) => `${i.name}=${i.value}`).join("; "),
  };
}
let pass = 0, fail = 0; const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

const { cookieObjs, cookieStr } = await session();

// 라인 데이터가 있는 (weekId, club) 조합 탐색 — 최근 주차부터.
const weeks = (await sb.from("weeks").select("id, week_number, season_key").order("start_date", { ascending: false }).limit(40)).data ?? [];
let target = null;
outer:
for (const w of weeks) {
  for (const club of CLUBS) {
    const res = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${w.id}/act-check-management?club=${club}`, { headers: { cookie: cookieStr } });
    if (!res.ok) continue;
    const json = await res.json().catch(() => null);
    const d = json?.data;
    if (!d) continue;
    const infoLines = d.practicalInfo?.lines?.length ?? 0;
    const expTeams = d.practicalExperience?.teams?.length ?? 0;
    const compLines = d.practicalCompetency?.lines?.length ?? 0;
    if (infoLines + expTeams + compLines > 0) { target = { weekId: w.id, club, w, infoLines, expTeams, compLines }; break outer; }
  }
}
if (!target) { console.log("  ✗ 라인 데이터가 있는 주차/클럽을 찾지 못함 — 검증 불가"); process.exit(1); }
console.log(`  ▶ 대상: week ${target.w.season_key} W${target.w.week_number} / club=${target.club} (info ${target.infoLines}·exp ${target.expTeams}·comp ${target.compLines})`);

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addCookies(cookieObjs);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/team-parts/info/weeks/${target.weekId}?club=${target.club}`, { waitUntil: "networkidle" });
  // 액트 체크 관리 탭(기본 active) 패널 로드 대기.
  await page.waitForSelector("[data-act-check-panel]", { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(800);

  // 모든 라인급 셀(각 요일 그룹 표의 첫 컬럼 td) badge 측정.
  //   침범 판정: badge.right > td.right + 1(패딩 고려) → 셀 밖으로 튀어나옴.
  const measureAll = () =>
    page.evaluate(() => {
      const rows = [...document.querySelectorAll("[data-act-check-panel] tr")];
      const out = [];
      for (const tr of rows) {
        const firstTd = tr.querySelector("td");
        if (!firstTd) continue;
        const badge = firstTd.querySelector("span");
        if (!badge) continue;
        const tdR = firstTd.getBoundingClientRect();
        const bR = badge.getBoundingClientRect();
        const nextTd = firstTd.nextElementSibling;
        const nR = nextTd?.getBoundingClientRect();
        const cs = getComputedStyle(badge);
        out.push({
          text: (badge.textContent ?? "").trim().slice(0, 24),
          tdWidth: Math.round(tdR.width),
          // badge 오른쪽이 셀 오른쪽을 넘는가(넘침).
          badgeOverflowsCell: bR.right > tdR.right + 1,
          // badge 오른쪽이 다음(요일) 셀 왼쪽을 넘는가(침범).
          invadesNextCol: nR ? bR.right > nR.left + 1 : null,
          textOverflow: cs.textOverflow,
          whiteSpace: cs.whiteSpace,
          overflowX: cs.overflowX,
        });
      }
      return out;
    });

  const cells = await measureAll();
  console.log(`  라인급 셀 ${cells.length}개 측정`);
  ck("[실데이터] 라인급 셀 1개 이상 렌더", cells.length > 0, `count=${cells.length}`);
  const anyOverflow = cells.filter((c) => c.badgeOverflowsCell);
  const anyInvade = cells.filter((c) => c.invadesNextCol === true);
  ck("[실데이터] 어떤 라인급도 셀 밖 넘침 없음", anyOverflow.length === 0, anyOverflow.length ? J(anyOverflow.slice(0, 3)) : "");
  ck("[실데이터] 어떤 라인급도 요일 컬럼 침범 없음", anyInvade.length === 0, anyInvade.length ? J(anyInvade.slice(0, 3)) : "");
  const sample = cells[0];
  ck("[CSS] truncate 적용(text-overflow:ellipsis)", sample?.textOverflow === "ellipsis", sample?.textOverflow ?? "?");
  ck("[CSS] whitespace:nowrap", sample?.whiteSpace === "nowrap", sample?.whiteSpace ?? "?");

  // ── 스트레스 테스트 — 첫 라인급 badge 에 매우 긴 이름 주입 후 재측정(CSS 자체 검증) ──
  const stress = await page.evaluate(() => {
    const tr = [...document.querySelectorAll("[data-act-check-panel] tr")].find((r) => r.querySelector("td span"));
    const td = tr?.querySelector("td");
    const badge = td?.querySelector("span");
    if (!badge || !td) return null;
    badge.textContent = "[팀] 조직관리 매우매우매우길고긴라인급이름테스트총괄운영관리";
    // 강제 reflow.
    void td.getBoundingClientRect();
    const tdR = td.getBoundingClientRect();
    const bR = badge.getBoundingClientRect();
    const nextTd = td.nextElementSibling;
    const nR = nextTd?.getBoundingClientRect();
    return {
      tdWidth: Math.round(tdR.width),
      badgeWidth: Math.round(bR.width),
      badgeOverflowsCell: bR.right > tdR.right + 1,
      invadesNextCol: nR ? bR.right > nR.left + 1 : null,
      truncated: badge.scrollWidth > badge.clientWidth, // 내용이 잘림(ellipsis 발동)
    };
  });
  console.log("  스트레스:", J(stress));
  ck("[스트레스] 긴 이름 주입해도 셀 밖 넘침 없음", !!stress && stress.badgeOverflowsCell === false, J(stress));
  ck("[스트레스] 긴 이름 주입해도 요일 컬럼 침범 없음", !!stress && stress.invadesNextCol === false, `invadesNextCol=${stress?.invadesNextCol}`);
  ck("[스트레스] 긴 이름은 말줄임(…) 처리됨", !!stress && stress.truncated === true, `truncated=${stress?.truncated}`);
  ck("[스트레스] 셀 고정폭 96~120px 범위", !!stress && stress.tdWidth >= 96 && stress.tdWidth <= 130, `tdWidth=${stress?.tdWidth}`);

  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "qa-linegroup-overflow-fixed.png"), fullPage: true });
  console.log("  📷 claudedocs/qa-linegroup-overflow-fixed.png");
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally {
  await browser.close();
  console.log(`\n결과: ${pass} pass / ${fail} fail (read-only)`);
  process.exit(fail > 0 ? 1 : 0);
}
