// 브라우저 검증 — /admin/processes/check/irregular 변동 액트.
//   버튼(수동 입력/검수 링크·1행2열) · 요약 5칸 · 표 헤더 종류→카페→… 순 · 시드 행 표시(카페 파생).
//   서비스롤로 시드 1행 생성 → 표시 확인 → cleanup(net-zero). 전제: dev 서버 + 마이그레이션 적용.
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
  await cleanup();

  // 시드 1행 — operating 보드 주차로 저장하기 위해 API 로 생성(주차 산출 위임).
  const markers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x) => x.user_id));
  const opTarget = (((await sb.from("user_profiles").select("user_id,display_name").eq("organization_slug", ORG)).data ?? []).find((u) => !markers.has(u.user_id) && (u.display_name ?? "").trim().length >= 2));
  if (!opTarget) { console.log("⚠ 운영 대상 없음"); await cleanup(); process.exit(2); }
  const cookieHdr = cks.map((c) => `${c.name}=${c.value}`).join("; ");
  const seed = await fetch(`${BASE}/api/admin/processes/check/irregular`, {
    method: "POST", headers: { "Content-Type": "application/json", cookie: cookieHdr },
    body: JSON.stringify({ organization: ORG, kind: "manual_grant", act_name: `${TAG} 표시행`, target_user_ids: [opTarget.user_id], point_a: 7, point_b: 1, point_c: 0, crew_reaction: "partial", point_mode: "ab" }),
  });
  ck("[시드] 수동부여 생성 201", seed.status === 201);
  // 검수 링크(체크 대기) 시드 — 상태 버튼→상세→체크 취소 동작 확인용.
  const seedRR = await fetch(`${BASE}/api/admin/processes/check/irregular`, {
    method: "POST", headers: { "Content-Type": "application/json", cookie: cookieHdr },
    body: JSON.stringify({ organization: ORG, kind: "review_request", act_name: `${TAG} 대기행`, review_link: "https://cafe.naver.com/x/req", scheduled_check_at: new Date(Date.now() + 86_400_000).toISOString(), point_a: 2, point_b: 1, point_c: 1 }),
  });
  ck("[시드] 검수신청(대기) 생성 201", seedRR.status === 201);

  const ctx = await browser.newContext();
  await ctx.addCookies(cks);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/processes/check/irregular?org=${ORG}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const body = (await page.locator("body").textContent()) ?? "";

  // 버튼 2종.
  ck("[버튼] 수동 입력", await page.getByRole("button", { name: "수동 입력" }).count() > 0);
  ck("[버튼] 검수 링크", await page.getByRole("button", { name: "검수 링크" }).count() > 0);

  // 요약 5칸 라벨.
  for (const lbl of ["전체 갯수", "검수 링크", "수동 입력", "체크 완료", "체크 대기"]) {
    ck(`[요약] ${lbl} 표시`, body.includes(lbl));
  }

  // 표 헤더 순서: 종류 → 카페 → 액트명(변동).
  const headers = await page.locator("thead th").allTextContents();
  const h = headers.map((t) => t.trim());
  const iKind = h.indexOf("종류"), iCafe = h.indexOf("카페"), iAct = h.findIndex((t) => t.includes("액트명"));
  ck("[헤더] 종류 → 카페 → 액트명 순서", iKind >= 0 && iCafe === iKind + 1 && iAct === iCafe + 1, JSON.stringify(h));

  // 시드 행 표시 + 카페=미발생(수동부여 파생).
  ck("[행] 시드 액트명 표시", body.includes(`${TAG} 표시행`));
  const rowText = (await page.locator("tbody tr", { hasText: `${TAG} 표시행` }).first().textContent()) ?? "";
  ck("[행] 수동 입력 → 카페 '미발생' 표시", rowText.includes("미발생"));
  ck("[행] 수동 입력 → 상태 '체크 완료'", rowText.includes("체크 완료"));

  // ── 상태 버튼 통합 — 별도 [상세] 버튼 제거, 상태 버튼이 상세 역할 ──
  ck("[버튼통합] 목록에 '상세' 버튼 없음", (await page.getByRole("button", { name: "상세" }).count()) === 0);

  // 체크 대기 행: 관리 셀 버튼 1개(상태 버튼만) → 클릭 시 상세 모달 + 체크 취소.
  const waitRow = page.locator("tbody tr", { hasText: `${TAG} 대기행` }).first();
  const waitBtns = await waitRow.locator("td:last-child button").count();
  ck("[체크대기] 행 관리 버튼 1개", waitBtns === 1, `n=${waitBtns}`);
  await waitRow.getByRole("button", { name: "체크 대기" }).click();
  await page.waitForTimeout(400);
  ck("[체크대기] 상태 버튼 클릭 → 상세 모달 + 체크 취소 버튼", (await page.getByRole("button", { name: "체크 취소" }).count()) > 0);
  await page.locator(".fixed.inset-0.z-50").getByRole("button", { name: "체크 취소" }).first().click(); // 상세 모달의 체크 취소
  await page.waitForTimeout(300);
  // 확인 다이얼로그(z-[60]) 수락 — 동일 라벨 '체크 취소'.
  await page.locator(".fixed.inset-0.z-\\[60\\]").getByRole("button", { name: "체크 취소" }).click();
  await page.waitForTimeout(600);
  ck("[체크대기] 체크 취소 → 행 제거", (await page.locator("tbody tr", { hasText: `${TAG} 대기행` }).count()) === 0);

  // 체크 완료 행: 관리 셀 버튼 1개(중복 없음) → 클릭 시 상세 모달.
  const doneRow = page.locator("tbody tr", { hasText: `${TAG} 표시행` }).first();
  const doneStatusBtn = doneRow.getByRole("button", { name: "체크 완료" });
  await doneStatusBtn.waitFor({ state: "visible", timeout: 5000 }); // 보드 리로드 안정화 대기
  const doneBtns = await doneRow.getByRole("button").count(); // 크루반응은 <select>라 버튼 아님
  ck("[체크완료] 행 관리 버튼 1개(중복 없음)", doneBtns === 1, `n=${doneBtns}`);
  await doneStatusBtn.click();
  await page.waitForTimeout(400);
  ck("[체크완료] 상태 버튼 클릭 → 상세 모달 열림(닫기 버튼)", (await page.getByRole("button", { name: "닫기" }).count()) > 0);
  await page.getByRole("button", { name: "닫기" }).click();
  await page.waitForTimeout(200);

  // ── 수동 입력 모달 — 자동완성 검색 → 확인 → 명단 추가 → 인원 수 ──
  await page.getByRole("button", { name: "수동 입력" }).click();
  await page.waitForTimeout(400);
  ck("[모달] 대상 크루 0명 초기표시", ((await page.locator("text=대상 크루 0명").count()) > 0));
  ck("[모달] 버튼 초기화/체크 완료 존재", (await page.getByRole("button", { name: "초기화" }).count()) > 0 && (await page.getByRole("button", { name: "체크 완료" }).count()) > 0);
  ck("[모달] 체크 신청/취소 버튼 없음", (await page.getByRole("button", { name: "체크 신청" }).count()) === 0 && (await page.getByRole("button", { name: "체크 취소" }).count()) === 0);
  // 포인트 드롭다운 0~20 — 0 옵션 존재.
  ck("[모달] 포인트 A 드롭다운 0 선택 가능", (await page.locator('select[aria-label="포인트 A"] option[value="0"]').count()) > 0 && (await page.locator('select[aria-label="포인트 A"] option[value="20"]').count()) > 0);

  // 수동 입력는 '부분' 고정(전원 선택 불가) + 포인트 방식(A+B|C) 라디오. 구 필수/선택/선발/없음 비노출.
  //   ⚠ 목록 행에도 '액트 종류' select 가 있으므로 모달 컨테이너로 스코프(strict 모드 회피).
  const modal = page.locator(".fixed.inset-0.z-50").last();
  const cSel = modal.locator('select[aria-label="포인트 C"]');
  ck("[수동] 액트 종류 '부분 (수동 입력 고정)' 표시", (await modal.getByText("부분 (수동 입력 고정)").count()) > 0);
  ck("[수동] 액트 종류 select(전원 선택) 없음", (await modal.locator('select[aria-label="액트 종류"]').count()) === 0);
  ck("[수동] 포인트 방식 라디오 2개(A+B 부여/C 부여)", (await modal.getByRole("radio").count()) === 2);
  const bodyTxt = await modal.innerText();
  ck("[수동] 구 옵션(필수/선택/선발/없음) 비노출", !["필수", "선발"].some((w) => bodyTxt.includes(w)));
  // 기본 A+B 부여 → 포인트 C 비활성. C 부여 라디오 → A/B 비활성.
  ck("[규칙] 기본 A+B 부여 → 포인트 C 비활성", await cSel.isDisabled());
  await modal.getByRole("radio", { name: "C 부여" }).click();
  await page.waitForTimeout(200);
  ck("[규칙] C 부여 → 포인트 C 활성·포인트 A 비활성", !(await cSel.isDisabled()) && (await modal.locator('select[aria-label="포인트 A"]').isDisabled()));

  const term = (opTarget.display_name ?? "").trim();
  await page.getByPlaceholder("이름으로 검색").fill(term);
  // 디바운스 + 크루 로딩(org 전체 user_profiles·멤버십·학력)은 수 초 걸릴 수 있어 충분히 대기.
  const sugg = page.locator("button", { hasText: term }).first();
  await sugg.waitFor({ state: "visible", timeout: 12000 }).catch(() => {});
  if (await sugg.count() > 0) {
    await sugg.click();
    await page.getByRole("button", { name: "확인" }).click();
    await page.waitForTimeout(300);
    ck("[모달] 명단에 크루 1명 추가 · '대상 크루 1명'", (await page.locator("text=대상 크루 1명").count()) > 0);
    const modal = (await page.locator("body").textContent()) ?? "";
    ck("[모달] 명단 표에 크루명 표시", modal.includes(term));
  } else {
    ck("[모달] 자동완성 결과(크루 검색)", false, `'${term}' 검색 결과 없음`);
  }
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally { await cleanup(); await browser.close(); console.log("(cleanup — net-zero)"); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); }
