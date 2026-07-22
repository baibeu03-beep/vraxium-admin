// 실무 정보 = 고정 9종 — 브라우저 DOM 검증(dev :3000, owner 세션).
//
//   [1] 허브=실무 정보 선택 → 제목/안내 문구 · 활동유형 필드 필수
//   [D] 활동유형 미선택 → 필드 오류 · **POST 요청 미발생**
//   [C] 이미 등록된 활동유형은 option disabled + "등록 완료" 표시
//   [A] 9종 모두 등록된 범위(common) → 제출 시 팝업 · POST 미발생 · [라인 정보로 이동]
//   [E] /admin/lines/info — 활동유형 미연결 등록행에 "활동유형 미연결" 상태 + 복구 버튼
//   [B] 미등록 슬롯(encre/wisdom) 정상 등록 → 성공 토스트 · practical-info 탭 9개 유지
//
//   실행: node scripts/browser-verify-info-line-registration-render.mjs
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
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const OWNER_EMAIL = "vanuatu.golden@gmail.com";
const sb = createClient(URL_, SERVICE);

const STAMP = String(Date.now()).slice(-6);
const LINE_NAME = `DOM검증 앙크르 위즈덤 ${STAMP}`;
const LINE_CODE = `IFDM-EC${STAMP}`;
const NAV_TIMEOUT = 180000;
const SEL_TIMEOUT = 120000;

let fail = 0;
const ck = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function sessionCookies() {
  const brow = createClient(URL_, ANON);
  const { data: link, error } = await sb.auth.admin.generateLink({
    type: "magiclink",
    email: OWNER_EMAIL,
  });
  if (error) throw new Error(`generateLink: ${error.message}`);
  const { data: v, error: e2 } = await brow.auth.verifyOtp({
    email: OWNER_EMAIL,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  if (e2) throw new Error(`verifyOtp: ${e2.message}`);
  const cap = [];
  const srv = createServerClient(URL_, ANON, {
    cookies: { getAll: () => [], setAll: (i) => cap.push(...i) },
  });
  await srv.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
  });
  return cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/" }));
}

const tabTexts = (page) =>
  page.$$eval('[role="tab"]', (nodes) => nodes.map((n) => n.textContent.trim()));

// 등록 폼 공통 입력(허브=info). 조직/활동유형은 호출부가 정한다.
async function fillInfoForm(page, { org, activityTypeId }) {
  await page.selectOption('select[aria-label="소속 허브"]', "info");
  await page.fill('input[aria-label="라인명"]', LINE_NAME);
  await page.fill('input[aria-label="라인 코드"]', LINE_CODE);
  await page.selectOption('select[aria-label="소속 클럽"]', org);
  await page.selectOption('select[aria-label="소요 시간"]', "30");
  await page.locator('label:has-text("변동") input[type="radio"]').first().check();
  // 슬롯 점유 현황 조회(조직 변경 트리거) 완료 대기.
  await page.waitForTimeout(1800);
  if (activityTypeId) {
    await page.selectOption("select[data-point-activity-type]", activityTypeId);
  }
}

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addCookies(await sessionCookies());
  const page = await ctx.newPage();

  // POST 발생 여부 감시 — Case A/D 의 "요청 미발생" 판정 근거.
  let postCount = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/api/admin/lines/registrations")) postCount++;
  });

  let registrationId = null;

  try {
    // ── [0] 등록 전 탭 ───────────────────────────────────────────────────
    console.log("\n[0] practical-info 활동유형 탭");
    await page.goto(`${BASE}/admin/line-opening/practical-info?org=encre&tab=open`, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
    await page.waitForSelector('[role="tab"]', { timeout: SEL_TIMEOUT });
    const before = await tabTexts(page);
    ck("탭 9개", before.length === 9, before.join(" | "));

    // ── [1] 허브 선택 시 안내 ────────────────────────────────────────────
    console.log("\n[1] 실무 정보 허브 안내");
    await page.goto(`${BASE}/admin/lines/register`, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
    await page.waitForSelector('select[aria-label="소속 허브"]', { timeout: SEL_TIMEOUT });
    await page.selectOption('select[aria-label="소속 허브"]', "info");
    await page.waitForTimeout(600);
    const body1 = await page.locator("body").innerText();
    ck(
      "안내 문구 표시",
      body1.includes("고정된 9개 활동유형에 정식 라인명과 라인 코드를 연결하는 기능입니다") &&
        body1.includes("새로운 활동유형은 생성되지 않습니다"),
    );
    ck("제목 = 실무 정보 정식 라인 등록", body1.includes("실무 정보 정식 라인 등록"));
    const firstOption = await page.$eval(
      "select[data-point-activity-type] option",
      (o) => o.textContent.trim(),
    );
    ck("기본 옵션 = 활동유형을 선택하세요", firstOption === "활동유형을 선택하세요", firstOption);

    // ── [D] 활동유형 미선택 → 필드 오류 · POST 미발생 ─────────────────────
    console.log("\n[D] 활동유형 미선택 차단");
    postCount = 0;
    await fillInfoForm(page, { org: "encre", activityTypeId: null });
    await page.locator('button:text-is("등록")').last().click();
    await page.waitForTimeout(1500);
    const body2 = await page.locator("body").innerText();
    ck("필드 오류 문구", body2.includes("실무 정보 활동유형을 선택해주세요."));
    ck("POST 요청 미발생", postCount === 0, `${postCount}건`);

    // ── [C] 이미 등록된 활동유형은 선택 불가 ──────────────────────────────
    console.log("\n[C] 등록 완료 활동유형 비활성");
    await page.selectOption('select[aria-label="소속 클럽"]', "common");
    await page.waitForTimeout(2500);
    const commonOptions = await page.$$eval("select[data-point-activity-type] option", (nodes) =>
      nodes.map((n) => ({ value: n.value, text: n.textContent.trim(), disabled: n.disabled })),
    );
    const takenOptions = commonOptions.filter((o) => o.value && o.disabled);
    ck("common 범위: 9종 전부 disabled", takenOptions.length === 9, `${takenOptions.length}`);
    ck(
      '"등록 완료" 표시',
      takenOptions.length > 0 && takenOptions.every((o) => o.text.includes("등록 완료")),
      takenOptions[0]?.text,
    );

    // ── [A] 9종 모두 등록 → 팝업 · POST 미발생 ────────────────────────────
    console.log("\n[A] 9종 모두 등록된 범위 → 팝업 차단");
    const banner = await page
      .locator("[data-info-all-registered]")
      .first()
      .innerText()
      .catch(() => "");
    ck("사전 안내 배너 표시", banner.includes("이미 9개 모두 등록되어 있습니다"), banner.split("\n")[0]);
    postCount = 0;
    await page.locator('button:text-is("등록")').last().click();
    await page.waitForTimeout(1500);
    const dialogText = await page
      .locator('[data-admin-dialog]')
      .first()
      .innerText()
      .catch(() => "");
    ck(
      "팝업 제목 = 실무 정보 라인 추가 불가",
      dialogText.includes("실무 정보 라인 추가 불가"),
      dialogText.split("\n")[0],
    );
    ck("본문 1행", dialogText.includes("실무 정보 라인은 이미 9개 모두 등록되어 있습니다."));
    ck("본문 2행", dialogText.includes("새로운 실무 정보 라인은 추가할 수 없습니다."));
    ck(
      "대안 안내 없음(수정 유도·이동 CTA 미표시)",
      !dialogText.includes("수정해주세요") && !dialogText.includes("라인 정보로 이동"),
      dialogText.replace(/\n/g, " / "),
    );
    ck("POST 요청 미발생", postCount === 0, `${postCount}건`);
    // 확인 버튼 1개로 닫힌다(이동 CTA 없음 · 페이지 이동 없음).
    await page.locator("[data-admin-dialog] [data-admin-dialog-confirm]").first().click();
    await page.waitForTimeout(1200);
    const dialogGone = (await page.locator("[data-admin-dialog]").count()) === 0;
    ck(
      "확인 → 팝업 닫힘 · 페이지 이동 없음",
      dialogGone && page.url().includes("/admin/lines/register"),
      page.url(),
    );

    // ── [E] 활동유형 미연결 등록행 상태 표시 ──────────────────────────────
    console.log("\n[E] 활동유형 미연결 상태 표시");
    await page.goto(`${BASE}/admin/lines/info`, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
    await page.waitForSelector("table tbody tr", { timeout: SEL_TIMEOUT });
    // 허브 필터를 실무 정보로 좁힌다 — 전체 목록은 페이지네이션되어 info 행이 1페이지에 없을 수 있다.
    await page.locator('button[aria-label="허브 필터"]').first().click();
    await page.waitForTimeout(600);
    await page.locator('[role="menu"] label:has-text("실무 정보")').first().click();
    await page.locator('[role="menu"] button:has-text("확인")').first().click();
    await page.waitForTimeout(1500);
    const infoBody = await page.locator("body").innerText();
    const { data: unlinked } = await sb
      .from("line_registrations")
      .select("line_code")
      .eq("hub", "info")
      .is("point_activity_type_id", null)
      .limit(1);
    if ((unlinked ?? []).length > 0) {
      ck("미연결 등록행 상태 표시", infoBody.includes("활동유형 미연결"), unlinked[0].line_code);
      ck("복구 버튼 노출", infoBody.includes("활동유형 연결"));
    } else {
      ck("미연결 등록행 없음(검증 스킵)", true);
    }

    // ── [B] 미등록 슬롯 정상 등록 ─────────────────────────────────────────
    console.log("\n[B] 미등록 슬롯(encre/wisdom) 정상 등록");
    await page.goto(`${BASE}/admin/lines/register`, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
    await page.waitForSelector('select[aria-label="소속 허브"]', { timeout: SEL_TIMEOUT });
    await fillInfoForm(page, { org: "encre", activityTypeId: "wisdom" });
    postCount = 0;
    const [postRes] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/admin/lines/registrations") && r.request().method() === "POST",
        { timeout: SEL_TIMEOUT },
      ),
      page.locator('button:text-is("등록")').last().click(),
    ]);
    const postJson = await postRes.json().catch(() => null);
    ck("등록 POST 201", postRes.status() === 201, `status=${postRes.status()}`);
    registrationId = postJson?.data?.id ?? null;
    ck(
      "pointActivityTypeId = wisdom",
      postJson?.data?.pointActivityTypeId === "wisdom",
      String(postJson?.data?.pointActivityTypeId),
    );
    const toast = await page
      .locator("text=/정식 라인 정보와 포인트 설정이 저장되었습니다/")
      .first()
      .textContent()
      .catch(() => null);
    ck("성공 토스트 문구", Boolean(toast), String(toast ?? ""));
    ck("토스트에 활동유형 라벨", (toast ?? "").includes("[위즈덤]"), String(toast ?? ""));

    // 탭은 여전히 9개, 표시명은 정본 유지.
    await page.goto(`${BASE}/admin/line-opening/practical-info?org=encre&tab=open`, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
    await page.waitForSelector('[role="tab"]', { timeout: SEL_TIMEOUT });
    const after = await tabTexts(page);
    ck("탭 여전히 9개", after.length === 9, after.join(" | "));
    ck("탭 텍스트 불변(정본 라벨)", JSON.stringify(after) === JSON.stringify(before));
    const tooltip = await page
      .locator('[role="tab"]:has-text("위즈덤")')
      .first()
      .getAttribute("title");
    ck("위즈덤 탭 툴팁 = 신규 정식 라인명/코드", (tooltip ?? "").includes(LINE_CODE), String(tooltip));
  } catch (e) {
    console.error(e);
    fail++;
  } finally {
    console.log("\n[정리] 검증 데이터 삭제");
    if (registrationId) {
      const { data: reg } = await sb
        .from("line_registrations")
        .select("organization_slug,point_activity_type_id")
        .eq("id", registrationId)
        .maybeSingle();
      await sb.from("line_registrations").delete().eq("id", registrationId);
      // info 포인트 config_key = 활동유형 id(라인 코드가 아니다).
      if (reg?.point_activity_type_id && reg.organization_slug) {
        await sb
          .from("cluster4_line_point_configs")
          .delete()
          .eq("hub", "info")
          .eq("organization_slug", reg.organization_slug)
          .eq("config_key", reg.point_activity_type_id);
      }
    }
    const { count } = await sb
      .from("activity_types")
      .select("*", { count: "exact", head: true })
      .eq("cluster_id", "practical_info");
    ck("activity_types 9행 유지", count === 9, `${count}`);
    try {
      await page.goto(`${BASE}/admin/line-opening/practical-info?org=encre&tab=open`, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      });
      await page.waitForSelector('[role="tab"]', { timeout: SEL_TIMEOUT });
      const restored = await tabTexts(page);
      ck(`정리 후 탭 ${restored.length}개`, restored.length === 9, restored.join(" | "));
    } catch (e) {
      console.error(e);
      fail++;
    }
    await browser.close();
  }

  console.log(fail === 0 ? "\n✅ ALL PASS" : `\n❌ ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
