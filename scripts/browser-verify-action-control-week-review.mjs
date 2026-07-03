// 브라우저 검증 — 주차 검수(team-parts) ⚡/↩ additive. 실제 확정/취소 없이(모달 취소+가로채기) 배선·문구만.
//   /admin/team-parts/info/weeks/[weekId]?club=encre 의 기존 [주차 검수] 버튼 옆 ⚡ 즉시 실행 / ↩ 실행 취소.
// 사용법: SMOKE_BASE_URL=http://localhost:3000 node scripts/browser-verify-action-control-week-review.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const req = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = req("@supabase/supabase-js");
const { createServerClient } = req("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const U = get("NEXT_PUBLIC_SUPABASE_URL"), A = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), S = get("SUPABASE_SERVICE_ROLE_KEY");
const admin = createClient(U, S);
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000", ORG = "encre";
async function cookies() { const b = createClient(U, A); const { data: l } = await admin.auth.admin.generateLink({ type: "magiclink", email: process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com" }); const { data: v } = await b.auth.verifyOtp({ email: process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com", token: l.properties.email_otp, type: "magiclink" }); const cap = []; const sv = createServerClient(U, A, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } }); await sv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token }); return cap.map(i => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" })); }
let pass = 0, fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

const br = await chromium.launch({ channel: "chromium", headless: true });
const ctx = await br.newContext({ viewport: { width: 1400, height: 1400 } });
await ctx.addCookies(await cookies());
const page = await ctx.newPage();
const captured = [];
// review POST/DELETE 가로채 실제 실행 차단(모달 취소하면 애초에 안 감; 이중 안전).
await page.route("**/api/admin/team-parts/info/weeks/**/review**", async (r) => { const m = r.request().method(); if (m === "POST" || m === "DELETE") { captured.push(m); await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, ok: true, data: { reverted: true }, reviewed: true }) }); } else await r.continue(); });

try {
  // 유효한 관리 주차 id 확보(목록 API).
  await page.goto(`${BASE}/admin/team-parts/info/weeks?club=${ORG}`, { waitUntil: "domcontentloaded" });
  const list = await page.evaluate(async ([b, o]) => { const r = await fetch(`${b}/api/admin/team-parts/info/weeks?club=${o}`, { cache: "no-store" }); return r.ok ? await r.json() : null; }, [BASE, ORG]);
  const items = list?.data?.items ?? [];
  const weekId = items[0]?.weekId ?? items[0]?.week_id ?? null;
  ck("관리 주차 id 확보", !!weekId, weekId ? String(weekId).slice(0, 8) : "none");
  if (!weekId) throw new Error("no weekId");

  await page.goto(`${BASE}/admin/team-parts/info/weeks/${weekId}?club=${ORG}`, { waitUntil: "networkidle", timeout: 45000 });
  const bodyText = await page.locator("body").innerText();
  ck("주차 상세 렌더(에러 없음)", !/Application error|Unhandled Runtime/i.test(bodyText));
  // 기존 [주차 검수] 버튼 유지.
  ck("기존 [주차 검수] 버튼 유지", (await page.locator("[data-review-button]").count()) > 0);
  // 공용 ⚡/↩ 추가.
  const ac = page.locator("[data-ac-week-review]");
  await ac.first().waitFor({ timeout: 10000 });
  const zap = ac.getByRole("button", { name: /즉시 실행/ });
  const undo = ac.getByRole("button", { name: /실행 취소/ });
  ck("⚡ '즉시 실행' 추가 렌더", (await zap.count()) > 0);
  ck("↩ '실행 취소' 추가 렌더", (await undo.count()) > 0);

  // ⚡ 확인 모달(지정 문구) → 취소(확정 안 함).
  const reviewedAlready = await page.locator('[data-reviewed="true"]').count() > 0;
  if (!reviewedAlready && !(await zap.first().isDisabled())) {
    await zap.first().click();
    const dlg = page.locator('[role="alertdialog"]');
    await dlg.waitFor({ timeout: 8000 });
    const t = await dlg.innerText();
    ck("⚡ 확인 모달 지정 문구", t.includes("현재 주차의 활동 결과를 확정합니다") && t.includes("성장 성공/실패") && t.includes("정말 실행하시겠습니까"), t.replace(/\s+/g, " ").slice(0, 50));
    ck("⚡ 확인 버튼 '⚡ 즉시 실행'", (await dlg.getByRole("button").allInnerTexts()).some(x => x.includes("⚡") && x.includes("즉시 실행")));
    await dlg.getByRole("button", { name: "취소" }).click();
    ck("모달 취소 → 검수 미실행(POST 없음)", !captured.includes("POST"));
    // 미확정 상태면 ↩ 비활성 + 사유.
    ck("미확정 시 ↩ 비활성(사유 tooltip)", await undo.first().isDisabled() && ((await undo.first().getAttribute("title"))?.includes("확정") ?? false));
  } else {
    console.log("  · 이미 검수 완료 상태 → ↩ 활성; ⚡ 비활성(정상). 반대 상태는 direct/HTTP 로 검증.");
    ck("검수 완료 시 ↩ 활성", !(await undo.first().isDisabled()));
  }
} catch (e) { ck("예외 없음", false, String(e?.message ?? e).slice(0, 160)); }
await br.close();
console.log(fail === 0 ? `\n✅ ALL PASS (${pass}) — 주차 검수 ⚡/↩ 렌더·문구(프로덕션 무접촉)` : `\n❌ ${fail} FAIL / ${pass} pass`);
process.exit(fail === 0 ? 0 : 1);
