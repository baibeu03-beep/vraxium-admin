// 브라우저 검증 — 실무 경험 [팀 총괄] 평점 드롭다운 구성(2026-07-28 '-' 옵션 폐지).
//   사전조건: admin dev :3000. 실행: node scripts/browser-verify-experience-score-select-options.mjs
//   검증: 실제 렌더된 평점 select 전부가
//     (1) 옵션 11개 = 0~10 뿐이고,
//     (2) '-'(value="") 옵션이 하나도 없으며,
//     (3) 현재 표시값(초기값 포함)이 '-'/빈값이 아니라 0~10 중 하나다.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const { chromium } = createRequire(resolve(adminRoot, "..", "vraxium", "package.json"))("playwright");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE);
const brow = createClient(URL_, ANON);
const OWNER_EMAIL = "vanuatu.golden@gmail.com";

// 팀 총괄 보드가 확실히 렌더되는 대상(기존 브라우저 검증 스크립트와 동일 fixture).
const ORG = "phalanx";
const TEAM_NAME = "운영(T)";
const WEEK_ID = "d3260418-fcd3-4c23-875f-e51502cf9bd3";

async function cookiesFor(email) {
  const { data: link, error } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw new Error(`generateLink: ${error.message}`);
  const { data: v, error: e2 } = await brow.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  if (e2) throw new Error(`verifyOtp: ${e2.message}`);
  const cap = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

let fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

const EXPECTED = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];

const browser = await chromium.launch({ channel: "chromium", headless: true });
try {
  const cookies = await cookiesFor(OWNER_EMAIL);
  const ctx = await browser.newContext();
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("   [pageerror]", e.message));

  // dev 서버는 HMR 소켓이 계속 열려 있어 networkidle 이 오지 않는다 — DOM 로드 후 고정 대기.
  await page.goto(`${BASE}/admin/integrated/line-opening/practical-experience?org=${ORG}&tab=open&mode=test&week=${WEEK_ID}`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(8000);

  const teamTab = page.getByRole("tab", { name: new RegExp(TEAM_NAME.replace(/[()]/g, "\\$&")) });
  if (await teamTab.count()) { await teamTab.first().click(); await page.waitForTimeout(1200); }

  // 파트 드롭다운에서 "팀 총괄" 선택 — 파트장 평점 select 가 있는 화면.
  //   ⚠ combobox 는 헤더(주차/파트) 외에 표 안의 라인명 select 도 전부 잡힌다(그쪽엔 '-' 옵션이 정상
  //     존재 = 라인 미선택). 파트 드롭다운만 텍스트로 골라야 엉뚱한 드롭다운을 열지 않는다.
  //     헤더 combobox 는 [주차, 파트] 순서라 파트 = nth(1). 그리드가 그려지기 전에 확정한다.
  const partCombo = page.getByRole("combobox").nth(1);
  await partCombo.waitFor({ state: "visible", timeout: 60000 });
  const partComboText = (await partCombo.textContent())?.trim() ?? "";
  ck("파트 드롭다운 발견", /총괄|신청|파트|응대|정책/.test(partComboText), `트리거="${partComboText}"`);
  await partCombo.click();
  await page.waitForTimeout(800);
  const overallOpt = page.getByRole("option", { name: /팀 총괄/ });
  ck("파트 드롭다운에 [팀 총괄] 옵션 존재", (await overallOpt.count()) > 0);
  await overallOpt.first().click();
  // 보드는 team-overall GET 이후에 그려진다 — 평점 select 가 나타날 때까지 기다린다.
  await page.waitForSelector('select[aria-label$="점수"]', { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const onOverall = await page.getByText("아웃풋 링크").count();
  ck("팀 총괄(개설 검수) 보드 진입", onOverall > 0);

  const selects = await page.evaluate(() =>
    Array.from(document.querySelectorAll('select[aria-label$="점수"]')).map((s) => ({
      label: s.getAttribute("aria-label"),
      values: Array.from(s.options).map((o) => o.value),
      texts: Array.from(s.options).map((o) => o.textContent.trim()),
      value: s.value,
    })),
  );

  console.log(`\n▶ 평점 select ${selects.length}개 발견`);
  ck("평점 select 가 렌더됨(대상 화면 진입 성공)", selects.length > 0, `${selects.length}개`);
  if (selects.length > 0) {
    console.log(`   예: ${selects[0].label} → 옵션 [${selects[0].texts.join(",")}] · 현재값 "${selects[0].value}"`);
  }

  const badOptions = selects.filter((s) => JSON.stringify(s.values) !== JSON.stringify(EXPECTED));
  ck("모든 평점 select 옵션 = 0~10 11개뿐", badOptions.length === 0,
    badOptions.length ? `위반 ${badOptions.length}개 예: ${badOptions[0].label} [${badOptions[0].values.join(",")}]` : `${selects.length}개 전부 일치`);

  const dashOptions = selects.filter((s) => s.values.includes("") || s.texts.includes("-"));
  ck("'-'(미선택) 옵션 0개", dashOptions.length === 0,
    dashOptions.length ? `잔존 ${dashOptions.length}개 예: ${dashOptions[0].label}` : "전부 제거됨");

  const emptyValues = selects.filter((s) => !EXPECTED.includes(s.value));
  ck("현재 표시값(초기값 포함)이 전부 0~10", emptyValues.length === 0,
    emptyValues.length ? `위반 ${emptyValues.length}개 예: ${emptyValues[0].label}="${emptyValues[0].value}"` : `${selects.length}개 전부 0~10`);

  await page.close();
  await ctx.close();
} finally {
  await browser.close();
}
console.log(fail === 0 ? "\n✅ 전체 통과" : `\n❌ 실패 ${fail}건`);
process.exit(fail === 0 ? 0 : 1);
