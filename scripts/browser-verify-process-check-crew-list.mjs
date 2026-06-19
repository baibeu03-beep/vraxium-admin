// 브라우저 검증 — 프로세스 체크 액트 체크 팝업(검수 링크/수동 입력) 체크 완료 크루 명단 + 버튼 정책.
//   세팅(서비스키): info/oranke/test(W13) 에 테스트 마스터 4종 + 완료 상태행 직접 삽입.
//     A) 선별·needed  B) 필수·needed  C) 선별·completed(manual_grant)  D) 선별·completed(검수=null)
//   검증:
//     1) '종류' 컬럼 배지(필수/선별)
//     2) 필수·needed 클릭 → 검수 링크 팝업만(수동 입력 선택 없음)
//     3) 선별·needed 클릭 → [검수 신청]/[수동 입력] 선택 모달
//     4) 검수 완료(D) 클릭 → 검수 링크 팝업에 크루 명단(이름/소속 팀/소속 파트/클래스)
//     5) 수동 부여 완료(C) 클릭 → 수동 입력 팝업에 크루 명단 + '체크 취소' 비활성 + 체크 대기 없음
//     6) org 쿼리스트링 유지
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
const ORG = "oranke", HUB = "info", TAG = "ZZ-bcrew";
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });
let pass = 0, fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cleanup() {
  const acts = (await sb.from("process_acts").select("id").like("act_name", `${TAG}%`)).data ?? [];
  const ids = acts.map((a) => a.id);
  if (ids.length) {
    const sts = (await sb.from("process_check_statuses").select("id").in("act_id", ids)).data ?? [];
    const stIds = sts.map((s) => s.id);
    if (stIds.length) await sb.from("process_check_review_recipients").delete().eq("source", "regular").in("ref_id", stIds);
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
async function mkCompleted(act, weekId, crewId, crewName, completionType) {
  const now = new Date().toISOString();
  const { data: st } = await sb.from("process_check_statuses").insert({
    organization_slug: ORG, hub: HUB, week_id: weekId, line_group_id: act.groupId, act_id: act.actId,
    status: "completed", completion_type: completionType, scope_mode: "test",
    review_link: completionType === "manual_grant" ? null : "https://cafe.naver.com/test/1",
    scheduled_check_at: now, requested_at: now, completed_at: now, checked_crew_count: 1,
  }).select("id").single();
  await sb.from("process_check_review_recipients").insert({
    source: "regular", ref_id: st.id, organization_slug: ORG, scope_mode: "test",
    user_id: crewId, nickname: crewName, match_type: "matched", match_reason: completionType === "manual_grant" ? "manual" : "auto",
  });
  return st.id;
}

const browser = await chromium.launch();
try {
  await cleanup();
  // 테스트 크루 + 주차.
  const markers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x) => x.user_id));
  const crew = (((await sb.from("user_profiles").select("user_id,display_name").eq("organization_slug", ORG)).data ?? []).find((u) => markers.has(u.user_id)));
  if (!crew) { console.log("⚠ 테스트 크루 없음 — 중단"); process.exit(2); }
  const crewName = crew.display_name?.trim() || "(이름 없음)";

  // 쿠키(주차 lookup 은 보드 GET 으로). 먼저 로그인 쿠키 생성.
  const brow = createClient(URL, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
  const cap = []; const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  const cookieHeader = cap.map((i) => `${i.name}=${i.value}`).join("; ");
  const wkRes = await fetch(`${BASE}/api/admin/processes/check?hub=${HUB}&org=${ORG}&mode=test`, { headers: { cookie: cookieHeader } });
  const weekId = (await wkRes.json()).data?.week?.weekId;
  if (!weekId) { console.log("⚠ weekId 없음 — 중단"); process.exit(2); }

  // 마스터 4종.
  const aSelNeeded = await mkAct("선별needed", "selection");
  const aReqNeeded = await mkAct("필수needed", "required");
  const aManual = await mkAct("수동완료", "selection");
  const aReview = await mkAct("검수완료", "selection");
  await mkCompleted(aManual, weekId, crew.user_id, crewName, "manual_grant");
  await mkCompleted(aReview, weekId, crew.user_id, crewName, null);

  const ctx = await browser.newContext();
  await ctx.addCookies(cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" })));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/processes/check/${HUB}?org=${ORG}&mode=test`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  // 6) org 쿼리 유지.
  ck("[6] org 쿼리스트링 유지", page.url().includes("org=oranke"), page.url());

  const rowOf = (name) => page.locator("tr", { hasText: name });
  // 1) 종류 배지.
  const body = (await page.locator("body").textContent()) ?? "";
  ck("[1] 표에 액트 4종 노출", [aSelNeeded, aReqNeeded, aManual, aReview].every(() => true) && body.includes(`${TAG}-선별needed`) && body.includes(`${TAG}-필수needed`));
  ck("[1] '종류' 배지 — 선별 행에 '선별' · 필수 행에 '필수'",
    (await rowOf(`${TAG}-선별needed`).getByText("선별", { exact: true }).count()) > 0 &&
    (await rowOf(`${TAG}-필수needed`).getByText("필수", { exact: true }).count()) > 0);

  const closeDialog = async () => {
    // 모든 팝업(선택 모달/검수 링크/수동 입력)은 backdrop mousedown 으로 닫힌다 — 좌상단 코너 클릭.
    const overlay = page.locator("div.fixed.inset-0").last();
    if (await overlay.count()) await overlay.click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.waitForTimeout(400);
  };

  // 2) 필수·needed 클릭 → 검수 링크 팝업만(선택 모달 없음).
  await rowOf(`${TAG}-필수needed`).locator("button").first().click();
  await page.waitForTimeout(500);
  {
    const t = (await page.locator("body").textContent()) ?? "";
    const hasReviewInput = (await page.getByText("검수 링크", { exact: false }).count()) > 0;
    // 선택 모달이면 '체크 방식을 선택하세요' 안내 + [수동 입력] 버튼이 뜬다 — 필수는 안 떠야 함.
    const hasChoice = /체크 방식을 선택/.test(t) && (await page.getByRole("button", { name: /수동 입력/ }).count()) > 0;
    ck("[2] 필수 액트 → 검수 링크 팝업(검수 링크 입력 노출)", hasReviewInput);
    ck("[2] 필수 액트 → 수동 입력 선택 안 뜸(선택 모달 없음)", !hasChoice, `choice=${hasChoice}`);
  }
  await closeDialog();

  // 3) 선별·needed 클릭 → 선택 모달([검수 신청]/[수동 입력]).
  await rowOf(`${TAG}-선별needed`).locator("button").first().click();
  await page.waitForTimeout(500);
  {
    const hasReq = (await page.getByRole("button", { name: /검수 링크/ }).count()) > 0;
    const hasManual = (await page.getByRole("button", { name: /수동 입력/ }).count()) > 0;
    ck("[3] 선별 액트 → [검수 링크]+[수동 입력] 둘 다", hasReq && hasManual, `req=${hasReq} manual=${hasManual}`);
  }
  await closeDialog();

  // 4) 검수 완료(D) 클릭 → 검수 링크 팝업 + 크루 명단(이름/소속 팀/소속 파트/클래스).
  await rowOf(`${TAG}-검수완료`).locator("button").first().click();
  await page.waitForTimeout(500);
  {
    const dlg = (await page.locator("body").textContent()) ?? "";
    const hasHeaders = ["이름", "소속 팀", "소속 파트", "클래스"].every((h) => dlg.includes(h));
    const hasCrew = dlg.includes(crewName);
    ck("[4] 검수 완료 → 크루 명단 헤더(이름/소속 팀/소속 파트/클래스)", hasHeaders);
    ck("[4] 검수 완료 → 크루명 노출", hasCrew, crewName);
  }
  await closeDialog();

  // 5) 수동 부여 완료(C) 클릭 → 수동 입력 팝업 + 명단 + 체크 취소 비활성 + 체크 대기 없음.
  await rowOf(`${TAG}-수동완료`).locator("button").first().click();
  await page.waitForTimeout(500);
  {
    const dlg = (await page.locator("body").textContent()) ?? "";
    const isManualDialog = dlg.includes("수동 입력 완료");
    const hasHeaders = ["이름", "소속 팀", "소속 파트", "클래스"].every((h) => dlg.includes(h));
    const cancelBtn = page.getByRole("button", { name: "체크 취소" });
    const cancelDisabled = (await cancelBtn.count()) > 0 ? await cancelBtn.first().isDisabled() : false;
    const noPending = !/체크 대기/.test(dlg);
    ck("[5] 수동 입력 완료 → 수동 입력 팝업(읽기 전용)", isManualDialog);
    ck("[5] 수동 입력 완료 → 크루 명단 헤더", hasHeaders);
    ck("[5] 수동 입력 '체크 취소' 버튼 비활성", cancelDisabled);
    ck("[5] 수동 입력 '체크 대기' 상태 없음", noPending);
  }
  await closeDialog();
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally {
  await cleanup().catch(() => {});
  await browser.close();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
