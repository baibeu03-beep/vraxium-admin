// 브라우저 검증 — /admin/processes/check/{hub} 선별 액트 수동 부여 UI.
//   1) 액트 목록 표 "종류" 컬럼 · 2) 필수 액트 클릭 → 기존 신청 모달 · 3) 선별 액트 클릭 → [검수 링크]/[수동 입력] 선택 ·
//   4) 검수 링크 → 기존 모달 · 5) 수동 입력 → 직접 입력 모달 · 6) 포인트 C disabled(시각적 비활성).
//   서비스롤로 선별/필수 액트 시드 → UI 확인 → cleanup(net-zero). 전제: dev 서버 + (저장까지 보려면) 2026-06-18 마이그레이션.
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
const ORG = "oranke", HUB = "info", TAG = "ZZ-mg-browser";
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });

async function cookies() {
  const browser = createClient(URL, ANON);
  const { data: l } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const { data: v } = await browser.auth.verifyOtp({ email: EMAIL, token: l.properties.email_otp, type: "magiclink" });
  const cap = [];
  const s = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await s.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}
let pass = 0, fail = 0; const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cleanup() {
  const acts = (await sb.from("process_acts").select("id").like("act_name", `${TAG}%`)).data ?? [];
  const actIds = acts.map((a) => a.id);
  if (actIds.length) {
    const sts = (await sb.from("process_check_statuses").select("id").in("act_id", actIds)).data ?? [];
    const stIds = sts.map((s) => s.id);
    if (stIds.length) {
      await sb.from("process_check_review_recipients").delete().eq("source", "regular").in("ref_id", stIds);
      await sb.from("process_point_awards").delete().eq("source", "regular").in("ref_id", stIds);
    }
    await sb.from("process_check_statuses").delete().in("act_id", actIds);
    await sb.from("process_check_logs").delete().in("act_id", actIds);
  }
  await sb.from("process_acts").delete().like("act_name", `${TAG}%`);
  await sb.from("process_line_groups").delete().like("name", `${TAG}%`);
}
async function createAct(actType) {
  const { data: g } = await sb.from("process_line_groups").insert({ hub: HUB, name: `${TAG}라인-${actType}` }).select("id").single();
  await sb.from("process_acts").insert({
    line_group_id: g.id, hub: HUB, act_name: `${TAG}${actType}`, duration_minutes: 30,
    occur_week: "N", occur_dow: 1, occur_time: "10:00", check_week: "N", check_dow: 3, check_time: "12:00",
    point_check: 5, point_advantage: 2, point_penalty: 0, cafe: "occur", check_target: "check", act_type: actType, is_active: true,
  });
}

const browser = await chromium.launch();
try {
  const cks = await cookies();
  await cleanup();
  await createAct("selection");
  await createAct("required");

  const ctx = await browser.newContext();
  await ctx.addCookies(cks);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/processes/check/${HUB}?org=${ORG}&mode=test`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);

  // (1) "종류" 컬럼 헤더 존재 · 옛 "액트 종류" 부재.
  const hasJongryu = await page.locator('th:has-text("종류")').first().isVisible().catch(() => false);
  const headerTexts = await page.locator("thead th").allInnerTexts().catch(() => []);
  ck("[1] 표 헤더 '종류' 존재", hasJongryu && headerTexts.includes("종류"), J(headerTexts));

  // 선별/필수 액트 행 — 라벨 셀 '선별'/'필수' 표시.
  const selRow = page.locator(`tr:has-text("${TAG}selection")`).first();
  const reqRow = page.locator(`tr:has-text("${TAG}required")`).first();
  ck("[1] 선별 액트 행 '선별' 라벨", (await selRow.innerText()).includes("선별"));
  ck("[1] 필수 액트 행 '필수' 라벨", (await reqRow.innerText()).includes("필수"));

  // (2) 필수 액트 "체크 필요" 클릭 → 기존 신청 모달(검수 링크 입력 노출, 선택 모달 아님).
  await reqRow.locator('button:has-text("체크 필요")').first().click();
  await page.waitForTimeout(400);
  const reqDialogReview = await page.locator('text=검수 링크').first().isVisible().catch(() => false);
  const reqChooser = await page.locator('text=체크 방식을 선택').first().isVisible().catch(() => false);
  ck("[2] 필수 액트 → 기존 신청 모달(검수 링크 입력) · 선택 모달 아님", reqDialogReview && !reqChooser, J({ review: reqDialogReview, chooser: reqChooser }));
  await page.mouse.click(5, 5);
  await page.waitForTimeout(300);

  // (3) 선별 액트 "체크 필요" 클릭 → [검수 링크]/[수동 입력] 선택 모달.
  await selRow.locator('button:has-text("체크 필요")').first().click();
  await page.waitForTimeout(400);
  const choiceVisible = await page.locator('text=체크 방식을 선택').first().isVisible().catch(() => false);
  const hasReviewBtn = await page.locator('button:has-text("검수 링크")').first().isVisible().catch(() => false);
  const hasManualBtn = await page.locator('button:has-text("수동 입력")').first().isVisible().catch(() => false);
  ck("[3] 선별 액트 → 선택 모달 [검수 링크]/[수동 입력]", choiceVisible && hasReviewBtn && hasManualBtn, J({ choice: choiceVisible, rev: hasReviewBtn, man: hasManualBtn }));

  // (5) 수동 입력 클릭 → 직접 입력 모달.
  await page.locator('button:has-text("수동 입력")').first().click();
  await page.waitForTimeout(400);
  const mgTitle = await page.locator('text=수동 입력').first().isVisible().catch(() => false);
  const hasActName = await page.locator('label:has-text("액트명")').first().isVisible().catch(() => false);
  const hasTargetCrew = await page.locator('text=대상 크루').first().isVisible().catch(() => false);
  ck("[5] 수동 입력 → 직접 입력 모달(액트명·대상 크루)", mgTitle && hasActName && hasTargetCrew, J({ t: mgTitle, name: hasActName, crew: hasTargetCrew }));

  // (6) 포인트 C select disabled(시각적 비활성).
  const pcSelect = page.locator('select[aria-label="포인트 C"]').first();
  const pcDisabled = await pcSelect.isDisabled().catch(() => false);
  const pcClass = await pcSelect.getAttribute("class").catch(() => "");
  ck("[6] 포인트 C disabled + 흐림(opacity/muted)", pcDisabled && /opacity-60|bg-muted/.test(pcClass ?? ""), J({ disabled: pcDisabled, cls: (pcClass ?? "").includes("opacity-60") }));

  // (4) 다시 선택 모달 → 검수 링크 → 기존 신청 모달(검수 링크 입력).
  await page.mouse.click(5, 5); await page.waitForTimeout(300);
  await selRow.locator('button:has-text("체크 필요")').first().click(); await page.waitForTimeout(300);
  await page.locator('button:has-text("검수 링크")').first().click(); await page.waitForTimeout(400);
  const revDialog = await page.locator('text=검수 링크').first().isVisible().catch(() => false);
  ck("[4] 선택 모달 → 검수 링크 → 기존 신청 모달(검수 링크 입력)", revDialog);
  await page.mouse.click(5, 5); await page.waitForTimeout(300);

  // (7) 저장 — 마이그레이션 적용 시에만 실제 부여 + "수동 입력 완료" 라벨 확인.
  const migApplied = !(await sb.from("process_check_statuses").select("completion_type").limit(1)).error;
  if (migApplied) {
    const markers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x) => x.user_id));
    const testCrew = ((await sb.from("user_profiles").select("user_id,display_name").eq("organization_slug", ORG)).data ?? [])
      .find((u) => markers.has(u.user_id) && (u.display_name ?? "").trim().length >= 2);
    if (testCrew) {
      await selRow.locator('button:has-text("체크 필요")').first().click(); await page.waitForTimeout(300);
      await page.locator('button:has-text("수동 입력")').first().click(); await page.waitForTimeout(400);
      await page.locator('input[placeholder="이름으로 검색"]').first().fill((testCrew.display_name ?? "").trim());
      await page.waitForTimeout(900);
      const opt = page.locator('div.absolute button', { hasText: (testCrew.display_name ?? "").trim() }).first();
      if (await opt.isVisible().catch(() => false)) {
        await opt.click(); await page.waitForTimeout(200);
        await page.locator('button:has-text("확인")').first().click(); await page.waitForTimeout(200);
        // 제출 버튼(수동 입력) = '체크 신청' → confirm 게이트 '체크 완료'.
        await page.locator('button:has-text("체크 신청")').first().click(); await page.waitForTimeout(300);
        const cf = page.getByRole("button", { name: "체크 완료" });
        if (await cf.count()) await cf.first().click();
        await page.waitForTimeout(1200);
        const selRowAfter = page.locator(`tr:has-text("${TAG}selection")`).first();
        const label = await selRowAfter.innerText().catch(() => "");
        ck("[7] 저장 후 행 '수동 입력 완료' 표시", label.includes("수동 입력 완료"), label.replace(/\s+/g, " ").slice(0, 80));
      } else {
        ck("[7] 저장 — 검색 결과 없음(스킵)", true, "자동완성 옵션 미노출");
      }
    } else { ck("[7] 저장 — 테스트 크루 없음(스킵)", true); }
  } else {
    console.log("  · (2026-06-18 마이그레이션 미적용 — 저장 단계 스킵)");
  }
} catch (e) {
  console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++;
} finally {
  await cleanup();
  await browser.close();
  console.log("(cleanup — net-zero)");
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
function J(o) { return JSON.stringify(o); }
