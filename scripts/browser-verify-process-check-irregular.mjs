// 브라우저 검증 — /admin/processes/check/irregular 변동 액트 (신규 UI).
//   주차 드롭다운(현재 시즌 W1~현재·날짜범위·상태) · [전원][부분] 버튼 · 통계 7칸 ·
//   표 헤더 12열(종류|액트 종류|액트명(비정규)|신청자|소요 시간(m)|액트 신청 사유|po A|po B|po C|신청 시점(실제)|검수 시점(실제)|체크 상태) ·
//   검수 시점 자동 완료 · 부분>수동 입력 모달(X 초기화·중복 팝업) · 과거 주차 조회 전용.
//   전제: dev 서버 + 2026-06-15_process_irregular_acts.sql 적용.
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
const ORG = "oranke", TAG = "ZZ-irr-browser";
const sb = createClient(URL, SERVICE);

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
  const rows = (await sb.from("process_irregular_acts").select("id").like("act_name", `${TAG}%`)).data ?? [];
  if (rows.length) await sb.from("process_check_review_recipients").delete().in("ref_id", rows.map((r) => r.id));
  await sb.from("process_irregular_acts").delete().like("act_name", `${TAG}%`);
}

const probe = await sb.from("process_irregular_acts").select("id").limit(1);
if (probe.error) { console.log(`⚠ 마이그레이션 미적용(${probe.error.code}) — 적용 후 재실행`); process.exit(2); }

const browser = await chromium.launch();
try {
  const cks = await cookies();
  const cookieHdr = cks.map((c) => `${c.name}=${c.value}`).join("; ");
  await cleanup();

  // 현재/과거 주차 weekId 확보(보드 GET).
  const board = JSON.parse(await (await fetch(`${BASE}/api/admin/processes/check/irregular?org=${ORG}`, { headers: { cookie: cookieHdr } })).text());
  const curId = board.data.selectedWeekId;
  const pastOpt = (board.data.weeks ?? []).find((w) => !w.isCurrent && w.weekId);
  ck("[전제] 현재/과거 주차 weekId 확보", !!curId && !!pastOpt, `cur=${!!curId} past=${pastOpt?.weekNumber}`);

  // 시드: 수동 부여(체크 완료) · 검수신청(체크 대기·미래) · 자동완료(검수시점 과거·직접 insert).
  const markers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x) => x.user_id));
  const opTarget = (((await sb.from("user_profiles").select("user_id,display_name").eq("organization_slug", ORG)).data ?? []).find((u) => !markers.has(u.user_id) && (u.display_name ?? "").trim().length >= 2));
  if (!opTarget) { console.log("⚠ 운영 대상 없음"); await cleanup(); process.exit(2); }
  const seed1 = await fetch(`${BASE}/api/admin/processes/check/irregular`, {
    method: "POST", headers: { "Content-Type": "application/json", cookie: cookieHdr },
    body: JSON.stringify({ organization: ORG, kind: "manual_grant", act_name: `${TAG} 표시행`, target_user_ids: [opTarget.user_id], point_a: 7, point_b: 1, point_c: 0, crew_reaction: "partial", point_mode: "ab" }),
  });
  ck("[시드] 부분 수동 부여 생성 201", seed1.status === 201);
  const seed2 = await fetch(`${BASE}/api/admin/processes/check/irregular`, {
    method: "POST", headers: { "Content-Type": "application/json", cookie: cookieHdr },
    body: JSON.stringify({ organization: ORG, kind: "review_request", act_name: `${TAG} 대기행`, crew_reaction: "all", review_link: "https://cafe.naver.com/x/req", scheduled_check_at: new Date(Date.now() + 86_400_000).toISOString(), point_a: 2, point_b: 1, point_c: 0, point_mode: "ab" }),
  });
  ck("[시드] 전원 검수신청(대기) 생성 201", seed2.status === 201);
  // 자동완료 시드 — 검수시점 과거(직접 insert, createX 는 미래만 허용).
  await sb.from("process_irregular_acts").insert({
    organization_slug: ORG, week_id: curId, kind: "review_request", act_name: `${TAG} 자동완료행`,
    applicant_admin_id: null, applicant_admin_name: "검증관리자", target_user_id: null, target_user_name: null,
    scope_mode: "operating", duration_minutes: 10, reason: "auto", point_a: 3, point_b: 2, point_c: 0,
    crew_reaction: "all", review_link: "https://cafe.naver.com/x/auto", scheduled_check_at: new Date(Date.now() - 3600_000).toISOString(),
    status: "pending", completed_at: null,
  });

  const ctx = await browser.newContext();
  await ctx.addCookies(cks);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/processes/check/irregular?org=${ORG}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const body = (await page.locator("body").textContent()) ?? "";

  // ── 용어 통일 — 보드(표/통계)에 구 용어 '검수 링크/검수 신청/수동 입력' 미노출 + 신규 용어 노출 ──
  ck("[용어] 보드에 '검수 링크' 없음", !body.includes("검수 링크"));
  ck("[용어] 보드에 '검수 신청' 없음", !body.includes("검수 신청"));
  ck("[용어] 보드에 '수동 입력' 없음", !body.includes("수동 입력"));
  ck("[용어] 보드에 '링크 신청' · '수동 부여' 노출", body.includes("링크 신청") && body.includes("수동 부여"));

  // ── 버튼 [전원][부분] ──
  ck("[버튼] 전원", await page.getByRole("button", { name: "전원", exact: true }).count() > 0);
  ck("[버튼] 부분", await page.getByRole("button", { name: "부분", exact: true }).count() > 0);

  // ── 통계 7칸 ──
  for (const lbl of ["전체 갯수", "링크 신청", "수동 부여", "체크 완료", "체크 대기", "전원", "부분"]) {
    ck(`[통계] ${lbl} 표시`, body.includes(lbl));
  }

  // ── 주차 드롭다운 + 날짜범위 + 상태 ──
  ck("[주차] 주차 선택 드롭다운 존재", (await page.locator('select[aria-label="주차 선택"]').count()) > 0);
  ck("[주차] (YYYY-MM-DD ~ YYYY-MM-DD) 날짜범위 표시", /\(\d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}\)/.test(body));
  ck("[주차] 주차 상태(공식 활동/휴식 주차) 표시", body.includes("공식 활동 주차") || body.includes("공식 휴식 주차"));

  // ── 표 헤더 12열 순서 ──
  const h = (await page.locator("thead th").allTextContents()).map((t) => t.trim());
  const expected = ["종류", "액트 종류", "액트명(비정규)", "신청자", "소요 시간(m)", "액트 신청 사유", "po A", "po B", "po C", "신청 시점(실제)", "검수 시점(실제)", "체크 상태"];
  ck("[헤더] 12열 순서 정확", JSON.stringify(h) === JSON.stringify(expected), JSON.stringify(h));

  // ── 시드 행 표시 ──
  ck("[행] 부분 수동 부여 → 체크 완료 + '부분'", (() => { const r = body; return r.includes(`${TAG} 표시행`); })());
  const mgRow = (await page.locator("tbody tr", { hasText: `${TAG} 표시행` }).first().textContent()) ?? "";
  ck("[행] 수동 부여 행 — 액트 종류 '부분' · 상태 '체크 완료'", mgRow.includes("부분") && mgRow.includes("체크 완료"));
  const waitRow = (await page.locator("tbody tr", { hasText: `${TAG} 대기행` }).first().textContent()) ?? "";
  ck("[행] 전원 검수신청(미래) — 액트 종류 '전원' · 상태 '체크 대기'", waitRow.includes("전원") && waitRow.includes("체크 대기"));
  // 자동완료 — 검수시점 과거 review_request 가 '체크 완료'로 표시.
  const autoRow = (await page.locator("tbody tr", { hasText: `${TAG} 자동완료행` }).first().textContent()) ?? "";
  ck("[자동완료] 과거 검수시점 행 = 브라우저 '체크 완료' 표시", autoRow.includes("체크 완료"));

  // ── [전원] 다이얼로그 — 검수 링크 신청 · 액트 종류 전원 고정 · 포인트 라디오 없음 ──
  await page.getByRole("button", { name: "전원", exact: true }).click();
  await page.waitForTimeout(400);
  const allModal = page.locator(".fixed.inset-0.z-50").last();
  ck("[전원] 모달 — '링크 신청' 제목", (await allModal.getByText("링크 신청").count()) > 0);
  ck("[전원] 액트 종류 '전원 (고정)'", (await allModal.getByText("전원 (고정)").count()) > 0);
  ck("[전원] 포인트 방식 라디오 없음(전원=A/B/C 자유)", (await allModal.getByRole("radio").count()) === 0);
  ck("[전원] 포인트 A/B/C 모두 활성", !(await allModal.locator('select[aria-label="포인트 A"]').isDisabled()) && !(await allModal.locator('select[aria-label="포인트 C"]').isDisabled()));
  ck("[전원] 링크 입력 존재", (await allModal.getByPlaceholder("https://cafe.naver.com/...").count()) > 0);
  // 하단 버튼 순서: 초기화 | 체크 신청 | 체크 취소.
  const allBtns = (await allModal.locator("div.mt-4.flex button").allTextContents()).map((t) => t.trim());
  ck("[전원] 하단 버튼 '초기화 | 체크 신청 | 체크 취소' 순서", JSON.stringify(allBtns) === JSON.stringify(["초기화", "체크 신청", "체크 취소"]), JSON.stringify(allBtns));
  await allModal.getByRole("button", { name: "체크 취소" }).click();
  await page.waitForTimeout(300);

  // ── [부분] → 선택 팝업(검수 링크/수동 입력) ──
  // 부분 > 검수 링크 — 하단 버튼 순서 확인 후 닫기.
  await page.getByRole("button", { name: "부분", exact: true }).click();
  await page.waitForTimeout(300);
  ck("[부분] 선택 팝업 — 링크 신청/수동 부여 버튼", (await page.getByRole("button", { name: "링크 신청" }).count()) > 0 && (await page.getByRole("button", { name: "수동 부여" }).count()) > 0);
  await page.getByRole("button", { name: "링크 신청" }).click();
  await page.waitForTimeout(400);
  const partReviewModal = page.locator(".fixed.inset-0.z-50").last();
  ck("[부분-검수] 액트 종류 '부분 (고정)'", (await partReviewModal.getByText("부분 (고정)").count()) > 0);
  const partBtns = (await partReviewModal.locator("div.mt-4.flex button").allTextContents()).map((t) => t.trim());
  ck("[부분-검수] 하단 버튼 '초기화 | 체크 신청 | 체크 취소' 순서", JSON.stringify(partBtns) === JSON.stringify(["초기화", "체크 신청", "체크 취소"]), JSON.stringify(partBtns));
  await partReviewModal.getByRole("button", { name: "체크 취소" }).click();
  await page.waitForTimeout(300);

  // 부분 > 수동 입력.
  await page.getByRole("button", { name: "부분", exact: true }).click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "수동 부여" }).click();
  await page.waitForTimeout(400);
  const mModal = page.locator(".fixed.inset-0.z-50").last();
  ck("[수동] 액트 종류 '부분 (수동 부여 고정)'", (await mModal.getByText("부분 (수동 부여 고정)").count()) > 0);
  ck("[수동] 포인트 방식 라디오 없음(X 초기화 방식)", (await mModal.getByRole("radio").count()) === 0);
  ck("[수동] X 초기화 버튼(포인트 C 초기화) 존재", (await mModal.locator('button[aria-label="포인트 C 초기화"]').count()) > 0);
  ck("[수동] 대상 크루 0명 초기 표시", (await mModal.getByText("대상 크루 0명").count()) > 0);

  // 포인트 규칙: A 입력 → C 잠금 / C 초기화하면 다시 활성 흐름 확인.
  const aSel = mModal.locator('select[aria-label="포인트 A"]');
  const cSel = mModal.locator('select[aria-label="포인트 C"]');
  await aSel.selectOption("4");
  await page.waitForTimeout(150);
  ck("[수동] 포인트 A 입력 시 포인트 C 비활성", await cSel.isDisabled());
  await mModal.locator('button[aria-label="포인트 A 초기화"]').click();
  await page.waitForTimeout(150);
  ck("[수동] A 초기화(X) → 포인트 C 다시 활성", !(await cSel.isDisabled()));

  // 대상 크루 검색 → 확인 → 명단 추가 → 중복 추가 시 안내 팝업.
  const term = (opTarget.display_name ?? "").trim();
  await mModal.getByPlaceholder("이름으로 검색").fill(term);
  const sugg = mModal.locator("button", { hasText: term }).first();
  await sugg.waitFor({ state: "visible", timeout: 12000 }).catch(() => {});
  if (await sugg.count() > 0) {
    await sugg.click();
    await mModal.getByRole("button", { name: "확인" }).click();
    await page.waitForTimeout(300);
    ck("[수동] 명단 크루 1명 추가('대상 크루 1명')", (await mModal.getByText("대상 크루 1명").count()) > 0);
    // 중복 추가 — 같은 크루 재검색 → 확인 → '이미 명단에 기재되었습니다' 팝업.
    await mModal.getByPlaceholder("이름으로 검색").fill(term);
    const sugg2 = mModal.locator("button", { hasText: term }).first();
    await sugg2.waitFor({ state: "visible", timeout: 12000 }).catch(() => {});
    if (await sugg2.count() > 0) {
      await sugg2.click();
      await mModal.getByRole("button", { name: "확인" }).click();
      await page.waitForTimeout(300);
      ck("[수동] 중복 추가 → '이미 명단에 기재되었습니다' 팝업", (await page.getByText("이미 명단에 기재되었습니다").count()) > 0);
    } else ck("[수동] 중복 추가 재검색", false, "재검색 결과 없음");
  } else ck("[수동] 자동완성 결과(크루 검색)", false, `'${term}' 검색 결과 없음`);

  // ── 과거 주차 선택 → 버튼 비활성 + 조회 전용 ──
  //   (모달/확인 팝업 teardown 대신 페이지 리로드로 깨끗한 상태에서 검증)
  if (pastOpt?.weekId) {
    await page.goto(`${BASE}/admin/processes/check/irregular?org=${ORG}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    await page.locator('select[aria-label="주차 선택"]').selectOption(pastOpt.weekId);
    await page.waitForTimeout(900);
    ck("[과거] 조회 전용 배지 표시", (await page.getByText("조회 전용").count()) > 0);
    ck("[과거] [전원] 버튼 비활성", await page.getByRole("button", { name: "전원", exact: true }).isDisabled());
    ck("[과거] [부분] 버튼 비활성", await page.getByRole("button", { name: "부분", exact: true }).isDisabled());
  }
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally { await cleanup(); await browser.close(); console.log("(cleanup — net-zero)"); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); }
