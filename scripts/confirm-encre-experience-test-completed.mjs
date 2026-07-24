// 완료 후 확인 — HTTP API + 브라우저에서 "체크 완료(0명)"으로 내려/보이는지.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __d = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__d, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const r = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = r("@supabase/supabase-js");
const { createServerClient } = r("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const URL = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const EMAIL = "vanuatu.golden@gmail.com", BASE = "http://localhost:3000";
const sb = createClient(URL, SERVICE);
const TEAM_ID = "ad6304ba-c566-445a-afd6-1b1bb8939925";
const ACT_ID = "86d67cb2-d46d-408b-ae9a-2970706d7531";
const TEAM = "비주얼랩(T) 팀", ACT = "[브리핑] 팀 시작";

let pass = 0, fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function ckCookies() {
  const brow = createClient(URL, ANON);
  const { data: l } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: l.properties.email_otp, type: "magiclink" });
  const cap = [];
  const s = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await s.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap;
}

const capCookies = await ckCookies();
const cookieHdr = capCookies.map((i) => `${i.name}=${i.value}`).join("; ");

// ── 6. HTTP API ──
console.log("── 6. HTTP API: 체크 완료(0명) ──");
const res = await fetch(`${BASE}/api/admin/processes/check?hub=experience&org=encre&team=${TEAM_ID}&scope=team_all&mode=test`, { headers: { cookie: cookieHdr } });
const json = await res.json().catch(() => ({}));
const act = (json.data?.acts ?? []).find((a) => a.actId === ACT_ID);
ck("[HTTP] 200", res.status === 200);
ck("[HTTP] 액트 status=completed", act?.status === "completed", act?.status);
ck("[HTTP] checkedCrewCount=0 (체크 완료(0명))", act?.checkedCrewCount === 0, `cc=${act?.checkedCrewCount}`);
ck("[HTTP] reviewerDebug.resolutionStatus=comments_found_no_match", act?.reviewerDebug?.resolutionStatus === "comments_found_no_match", act?.reviewerDebug?.resolutionStatus);
ck("[HTTP] unmatchedCommentAuthors=35", act?.reviewerDebug?.unmatchedCommentAuthors?.length === 35, `n=${act?.reviewerDebug?.unmatchedCommentAuthors?.length}`);

// ── 7. 브라우저 ──
console.log("── 7. 브라우저: 체크 완료 표시 ──");
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  await ctx.addCookies(capCookies.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" })));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/processes/check/experience?org=encre&mode=test`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  const tab = page.getByRole("button", { name: TEAM });
  if (await tab.count()) { await tab.first().click(); await page.waitForTimeout(900); }
  const rowAll = page.locator("tr", { hasText: ACT });
  const rowTxt = (await rowAll.first().textContent()) ?? "";
  ck("[브라우저] 행이 '체크 완료' 표시(체크 대기 아님)", rowTxt.includes("체크 완료") && !rowTxt.includes("체크 대기"), rowTxt.replace(/\s+/g, " ").slice(0, 80));

  // 팀 총괄 → 액트 클릭 → 팝업 "체크 크루 수 0" + 진단.
  await page.selectOption('select[aria-label="파트 구분 범위"]', "overall");
  await page.waitForTimeout(900);
  const row = page.locator("tr", { hasText: ACT });
  const btn = row.first().getByRole("button", { name: "체크 완료" });
  if (await btn.count()) { await btn.first().click(); await page.waitForTimeout(700); }
  const dlg = (await page.locator('[class*="max-w-md"]').last().textContent()) ?? "";
  ck("[브라우저] 팝업 '체크 크루 수' 0 표시", /체크 크루 수\s*0/.test(dlg.replace(/\s+/g, " ")), dlg.includes("체크 크루 수") ? "있음" : "없음");
  ck("[브라우저] 팝업 진단 '댓글 있으나 스코프 내 매칭 0'", dlg.includes("매칭 0") || dlg.includes("스코프 내 매칭"), "");
} finally {
  await browser.close();
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
