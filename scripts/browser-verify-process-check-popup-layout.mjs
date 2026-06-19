// 브라우저 검증 — 프로세스 체크 '체크 필요' 팝업(공용 ProcessCheckActDialog) 레이아웃 개편.
//   요구사항:
//     1) '체크 필요' 팝업 크기 = '수동 입력' 팝업 크기(max-w-2xl, 동일 너비)
//     2) 상단 1행 3열: 액트명 / 소속 라인급 / 액트 종류
//     3) 그 아래 검수 링크 입력 영역
//     4) 그 아래 1행 2열: 검수 시점 / 체크 크루 인원수
//     5) 그 아래 체크 크루 명단(이름/소속 팀/소속 파트/클래스)
//     6) 크루 없으면 안내 문구("아직 체크 완료된 크루가 없습니다.")
//     8) 기존 버튼(초기화/체크 신청/체크 취소/닫기) 유지
//   세팅(서비스키): info/oranke/test(W13) 에 테스트 마스터 2종(필수·needed / 선별·needed) 삽입.
//   ※ 팝업은 단일 공용 컴포넌트 — info 에서 검증되면 experience/competency/career 동일.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const r = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = r("@supabase/supabase-js");
const { createServerClient } = r("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const URL = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const BASE = "http://localhost:3000", EMAIL = "vanuatu.golden@gmail.com";
const ORG = "oranke", HUB = "info", TAG = "ZZ-layout";
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });
let pass = 0, fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cleanup() {
  const acts = (await sb.from("process_acts").select("id").like("act_name", `${TAG}%`)).data ?? [];
  const ids = acts.map((a) => a.id);
  if (ids.length) {
    await sb.from("process_check_statuses").delete().in("act_id", ids);
    await sb.from("process_check_logs").delete().in("act_id", ids);
  }
  await sb.from("process_acts").delete().like("act_name", `${TAG}%`);
  await sb.from("process_line_groups").delete().like("name", `${TAG}%`);
}
async function mkAct(label, actType) {
  const { data: g } = await sb.from("process_line_groups").insert({ hub: HUB, name: `${TAG}-${label}` }).select("id").single();
  const { data: a } = await sb.from("process_acts").insert({
    line_group_id: g.id, hub: HUB, act_name: `${TAG}-${label}`, duration_minutes: 30,
    occur_week: "N", occur_dow: 1, occur_time: "10:00", check_week: "N", check_dow: 3, check_time: "12:00",
    point_check: 5, point_advantage: 2, point_penalty: 0, cafe: "occur", check_target: "check", act_type: actType, is_active: true,
  }).select("id").single();
  return { actId: a.id, groupId: g.id };
}

const browser = await chromium.launch();
try {
  await cleanup();
  // 쿠키 로그인.
  const brow = createClient(URL, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
  const cap = []; const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });

  await mkAct("필수needed", "required");
  await mkAct("선별needed", "selection");

  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await ctx.addCookies(cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" })));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/processes/check/${HUB}?org=${ORG}&mode=test`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  ck("[6] org 쿼리스트링 유지", page.url().includes("org=oranke"), page.url());

  const rowOf = (name) => page.locator("tr", { hasText: name });
  const panel = () => page.locator("div.fixed.inset-0").last().locator(":scope > div").first();
  const closeDialog = async () => {
    const overlay = page.locator("div.fixed.inset-0").last();
    if (await overlay.count()) await overlay.click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.waitForTimeout(400);
  };

  // ── 필수·needed → '체크 필요' 팝업(ProcessCheckActDialog) 직접 ──
  await rowOf(`${TAG}-필수needed`).locator("button").first().click();
  await page.waitForTimeout(500);

  // 1) 팝업 크기 — needed 패널 너비 측정 + max-w-2xl 클래스.
  const neededBox = await panel().boundingBox();
  const neededClass = (await panel().getAttribute("class")) ?? "";
  ck("[1] '체크 필요' 팝업 max-w-2xl", /max-w-2xl/.test(neededClass), neededClass.match(/max-w-\S+/)?.[0]);

  // 2) 상단 1행 3열 — 액트명/소속 라인급/액트 종류 한 grid-cols-3 안.
  const grid3 = panel().locator("div.grid.grid-cols-3").filter({ hasText: "액트명" });
  const g3has = (await grid3.count()) > 0
    && (await grid3.first().getByText("액트명").count()) > 0
    && (await grid3.first().getByText("소속 라인급").count()) > 0
    && (await grid3.first().getByText("액트 종류").count()) > 0;
  ck("[2] 1행 3열(액트명/소속 라인급/액트 종류)", g3has);

  // 3) 검수 링크 입력 영역 — 그리드3 아래.
  const reviewInput = panel().getByPlaceholder("https://cafe.naver.com/...");
  ck("[3] 검수 링크 입력 노출", (await reviewInput.count()) > 0);

  // 4) 1행 2열 — 검수 시점 / 체크 크루 인원수.
  const grid2 = panel().locator("div.grid.grid-cols-2").filter({ hasText: "검수 시점" });
  const g2has = (await grid2.count()) > 0
    && (await grid2.first().getByText("검수 시점").count()) > 0
    && (await grid2.first().getByText("체크 크루 인원수").count()) > 0;
  ck("[4] 1행 2열(검수 시점/체크 크루 인원수)", g2has);

  // 5) 체크 크루 명단 헤더(이름/소속 팀/소속 파트/클래스).
  const ptxt = (await panel().textContent()) ?? "";
  const hasCrewHeaders = ["이름", "소속 팀", "소속 파트", "클래스"].every((h) => ptxt.includes(h));
  ck("[5] 체크 크루 명단 헤더(이름/소속 팀/소속 파트/클래스)", hasCrewHeaders);

  // 6) 크루 없으면 안내 문구.
  ck("[6] 빈 명단 안내 문구", ptxt.includes("아직 체크 완료된 크루가 없습니다."));

  // 8) 기존 버튼 유지(초기화/체크 신청/체크 취소/닫기).
  const btn = (n) => panel().getByRole("button", { name: n });
  const btnsOk =
    (await btn("초기화").count()) > 0 &&
    (await btn("체크 신청").count()) > 0 &&
    (await btn("체크 취소").count()) > 0 &&
    (await btn("닫기").count()) > 0;
  ck("[8] 버튼 4종 유지(초기화/체크 신청/체크 취소/닫기)", btnsOk);
  await closeDialog();

  // 1) 수동 입력 팝업 너비 측정 → '체크 필요' 와 동일.
  await rowOf(`${TAG}-선별needed`).locator("button").first().click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: /수동 입력/ }).first().click();
  await page.waitForTimeout(500);
  const manualBox = await panel().boundingBox();
  const widthEq = neededBox && manualBox && Math.abs(neededBox.width - manualBox.width) <= 2;
  ck("[1] '체크 필요' 너비 == '수동 입력' 너비", !!widthEq, `needed=${neededBox?.width} manual=${manualBox?.width}`);
  await closeDialog();
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally {
  await cleanup().catch(() => {});
  await browser.close();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
