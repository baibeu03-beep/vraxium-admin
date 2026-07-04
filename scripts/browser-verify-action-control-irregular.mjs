// 브라우저(인증 세션) 스모크 — Action Control ↩ 변동(비정규) 액트 보드 통합.
//   1) /admin/processes/check/irregular?org=encre&mode=test 렌더(크래시 없음)
//   2) 완료된 수동 부여 행에 ↩ '실행 취소' 버튼 렌더(공용 ActionControl)
//   3) ↩ 클릭 → 공용 확인 모달(role=alertdialog) → '↩ 실행 취소' 확정 → 행 삭제 + 성공 배너
//   4) 링크 신청(완료) 행: 버튼이 호출하는 바로 그 rollback 경로 라운드트립 → pending 복원(재테스트 가능)
//   ※ 서비스/HTTP 전수·direct==HTTP·snapshot 은 verify-action-control-irregular-rollback{.ts,-http.mjs}.
// 사용법: SMOKE_BASE_URL=http://localhost:3000 node scripts/browser-verify-action-control-irregular.mjs
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
const ORG = "encre", TAG = "[QA] ac-irr-browser", QA_ADMIN = "c28b2409-4118-49fc-a42e-68e18dbd194c";
const T = "process_irregular_acts", RECIP = "process_check_review_recipients";

async function makeAdminCookies() {
  const b = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await b.auth.verifyOtp({ email: adminEmail, token: linkData.properties.email_otp, type: "magiclink" });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (items) => captured.push(...items) } });
  await server.auth.setSession({ access_token: verifyData.session.access_token, refresh_token: verifyData.session.refresh_token });
  return captured.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => { console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); ok ? pass++ : fail++; };

async function cleanup() {
  const rows = (await admin.from(T).select("id").like("act_name", `${TAG}%`)).data ?? [];
  if (rows.length) await admin.from(RECIP).delete().in("ref_id", rows.map((x) => x.id));
  await admin.from(T).delete().like("act_name", `${TAG}%`);
}

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext();
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

try {
  await cleanup();
  // 앵커 — encre 테스트 유저 + 현재(쓰기) 주차. same-origin fetch 를 위해 먼저 페이지 진입.
  const markers = new Set(((await admin.from("test_user_markers").select("user_id")).data ?? []).map((x) => x.user_id));
  const tester = ((await admin.from("user_profiles").select("user_id").eq("organization_slug", ORG)).data ?? []).find((u) => markers.has(u.user_id))?.user_id;
  await page.goto(`${BASE}/admin/processes/check/irregular?org=${ORG}&mode=test`, { waitUntil: "networkidle" });
  const boardProbe = await page.evaluate(async (b) => (await (await fetch(`${b}/api/admin/processes/check/irregular?org=encre&mode=test`, { cache: "no-store" })).json()), BASE);
  const weekId = boardProbe?.data?.week?.weekId;
  check("[전제] 테스트 유저 + 현재 주차 확보", !!tester && !!weekId, `week=${weekId}`);

  // 완료된 수동 부여 시드(현재 주차) + recipient 1.
  const mg = (await admin.from(T).insert({
    organization_slug: ORG, week_id: weekId, kind: "manual_grant", act_name: `${TAG} 수동`,
    applicant_admin_id: QA_ADMIN, applicant_admin_name: "QA", crew_reaction: "partial",
    point_a: 3, point_b: 0, point_c: 0, review_link: null, scheduled_check_at: new Date().toISOString(),
    status: "completed", completed_at: new Date().toISOString(), scope_mode: "test", attempt_count: 0,
  }).select("id").maybeSingle()).data;
  const mgId = mg?.id;
  await admin.from(RECIP).insert({ source: "irregular", ref_id: mgId, organization_slug: ORG, scope_mode: "test", user_id: tester, nickname: "qa", match_type: "matched", match_reason: "manual" });

  // 1) 시드 반영을 위해 보드 재로드.
  await page.goto(`${BASE}/admin/processes/check/irregular?org=${ORG}&mode=test`, { waitUntil: "networkidle" });
  const bodyText = await page.locator("body").innerText();
  check("보드 렌더(에러 배너 없음)", !/Application error|Unhandled Runtime/i.test(bodyText));

  // 2) 시드 행의 ↩ 실행 취소 버튼 렌더.
  const rowCell = page.locator(`[data-ir-rollback="${mgId}"]`);
  await rowCell.waitFor({ state: "visible", timeout: 10000 });
  const rbBtn = rowCell.getByRole("button", { name: /실행 취소/ });
  check("완료 행에 ↩ '실행 취소' 버튼 렌더", (await rbBtn.count()) === 1);

  // 3) ↩ 클릭 → 공용 확인 모달 → 확정.
  await rbBtn.click();
  const dialog = page.locator('[role="alertdialog"]');
  await dialog.waitFor({ state: "visible", timeout: 5000 });
  const dlgText = await dialog.innerText();
  check("공용 확인 모달(alertdialog) 노출 · '실행하기 전' 문구", /실행하기 전|실행 전|되돌립니다/.test(dlgText));
  await dialog.getByRole("button", { name: /실행 취소/ }).click();

  // 배너 + DB 반영(행 삭제) 대기.
  await page.waitForTimeout(2500);
  const gone = (await admin.from(T).select("id").eq("id", mgId).maybeSingle()).data;
  check("[UI 라운드트립] 수동 부여 행 삭제(실행 전 복원)", !gone);
  const banner = await page.locator("body").innerText();
  check("성공 배너 노출('실행 전(부여 없음)')", /부여 없음|되돌렸습니다/.test(banner), banner.split("\n").find((l) => /되돌|부여 없음/.test(l)) ?? "");

  // 4) 링크 신청(완료) → 버튼이 호출하는 rollback 경로 라운드트립 → pending 복원.
  const rr = (await admin.from(T).insert({
    organization_slug: ORG, week_id: weekId, kind: "review_request", act_name: `${TAG} 검수`,
    applicant_admin_id: QA_ADMIN, applicant_admin_name: "QA", crew_reaction: "all",
    point_a: 0, point_b: 0, point_c: 0, review_link: "https://cafe.naver.com/qa-br",
    scheduled_check_at: new Date(Date.now() + 86_400_000).toISOString(),
    status: "completed", completed_at: new Date().toISOString(), scope_mode: "test", attempt_count: 0,
  }).select("id").maybeSingle()).data;
  const rrRb = await page.evaluate(async ([b, id]) => {
    const r = await fetch(`${b}/api/admin/processes/check/irregular/rollback`, {
      method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
      body: JSON.stringify({ id, organization: "encre", mode: "test" }),
    });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  }, [BASE, rr.id]);
  check("[browser] 링크 신청 rollback 200 · status=pending", rrRb.status === 200 && rrRb.body?.data?.status === "pending", `status=${rrRb.status}`);
  const rrDb = (await admin.from(T).select("status,scheduled_check_at").eq("id", rr.id).maybeSingle()).data;
  check("[browser] DB pending·scheduled null(재테스트 가능·행 유지)", rrDb?.status === "pending" && rrDb?.scheduled_check_at === null);

  check("콘솔 에러 없음", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
} catch (e) {
  check("예외 없음", false, String(e?.stack ?? e?.message ?? e));
} finally {
  await cleanup();
  await browser.close();
  console.log(fail === 0 ? `\n✅ ALL PASS (${pass})` : `\n❌ ${fail} FAIL / ${pass} pass`);
  process.exit(fail === 0 ? 0 : 1);
}
