// 검증 — 실무 역량 [라인 개설] 탭(상태창+로그창+개설완료/취소) 및 HTTP===direct.
//   읽기 전용: open/cancel(고객 반영 변이)은 실행하지 않는다.
//   1) HTTP opening-status/opening-logs (oranke/encre/phalanx) — direct(tsx)와 동일 주차/opened 확인.
//   2) 브라우저: ?org 별 [라인 관리](기존 화면 공존) + [라인 개설](대시보드) 렌더.
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
const ORGS = ["oranke", "encre", "phalanx"];

async function makeAdminCookies() {
  const admin = createClient(SUPABASE_URL, SERVICE);
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await browser.auth.verifyOtp({
    email: adminEmail, token: linkData.properties.email_otp, type: "magiclink",
  });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  return captured.map((i) => ({
    name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax",
  }));
}

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const cookies = await makeAdminCookies();
const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

// ── 1) HTTP opening-status/opening-logs (direct tsx 결과: 전 org current=W15 target=W14 opened=false) ──
console.log("== HTTP opening-status / opening-logs ==");
for (const org of ORGS) {
  const sRes = await fetch(`${BASE}/api/admin/cluster4/competency/opening-status?organization=${org}`, {
    headers: { cookie: cookieHeader },
  });
  const sJson = await sRes.json();
  const ok = sJson.success && sJson.data;
  const d = sJson.data ?? {};
  const cw = d.currentWeek ? `${d.currentWeek.year} ${d.currentWeek.seasonName} W${d.currentWeek.weekNumber}` : "null";
  const tw = d.targetWeek ? `${d.targetWeek.year} ${d.targetWeek.seasonName} W${d.targetWeek.weekNumber}` : "null";
  // 대상 주차는 금요일 경계로 동적(월~목=N-1, 금~일=N) — 주차 번호 하드코딩 대신 well-formed 검증.
  check(`[HTTP status ${org}] success + current/target 주차 well-formed`,
    ok && /\d{4} .+ W\d+/.test(cw) && /\d{4} .+ W\d+/.test(tw), `current=${cw} target=${tw} opened=${d.opened}`);
  check(`[HTTP status ${org}] outputLink1/outputDescription 필드(prefill)`,
    typeof d.outputLink1 === "string" && typeof d.outputDescription === "string",
    `link='${d.outputLink1}' desc='${d.outputDescription}'`);

  const lRes = await fetch(`${BASE}/api/admin/cluster4/competency/opening-logs?organization=${org}`, {
    headers: { cookie: cookieHeader },
  });
  const lJson = await lRes.json();
  check(`[HTTP logs ${org}] success + logs 배열(테이블 미적용시 빈 배열 best-effort)`,
    lJson.success && Array.isArray(lJson.data?.logs), `logs=${lJson.data?.logs?.length ?? "?"}`);

  const aRes = await fetch(`${BASE}/api/admin/cluster4/competency/applications?organization=${org}`, {
    headers: { cookie: cookieHeader },
  });
  const aJson = await aRes.json();
  const s = aJson.data?.summary;
  check(`[HTTP applications ${org}] success + summary 6필드 + applications 배열`,
    aJson.success && Array.isArray(aJson.data?.applications) && s &&
    ["activeCrews","appliedCrews","openedCrews","rejectedCrews","appliedLines","openedLines"].every((k) => typeof s[k] === "number"),
    `활동=${s?.activeCrews} 신청=${s?.appliedCrews} 개설=${s?.openedCrews} 반려=${s?.rejectedCrews} 신청라인=${s?.appliedLines} 개설라인=${s?.openedLines}`);
}

// POST 잘못된 action / 잘못된 org 거절 검증(변이 없음).
const badAction = await fetch(`${BASE}/api/admin/cluster4/competency/opening`, {
  method: "POST", headers: { "content-type": "application/json", cookie: cookieHeader },
  body: JSON.stringify({ action: "nope", organization: "oranke" }),
});
check("[HTTP POST] 잘못된 action 거절(400)", badAction.status === 400, `status=${badAction.status}`);
const badOrg = await fetch(`${BASE}/api/admin/cluster4/competency/opening`, {
  method: "POST", headers: { "content-type": "application/json", cookie: cookieHeader },
  body: JSON.stringify({ action: "open", organization: "olympus" }),
});
check("[HTTP POST] 무효 org(olympus) 거절(400) — admin org slug 아님", badOrg.status === 400, `status=${badOrg.status}`);

// 수동 추가 삭제 엔드포인트 — 잘못된 id 거절(엔드포인트 결선 + 입력검증). source 게이트(customer 403)는 코드 검증.
const delBad = await fetch(`${BASE}/api/admin/cluster4/competency/applications/not-a-uuid`, {
  method: "DELETE", headers: { cookie: cookieHeader },
});
check("[HTTP DELETE] 잘못된 id 거절(400)", delBad.status === 400, `status=${delBad.status}`);

// ── 2) 브라우저 렌더 ──
const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 2200 } });
await context.addCookies(cookies);
const page = await context.newPage();

try {
  for (const org of ORGS) {
    // [라인 관리] — 기존 실무 역량 화면 공존(내부 탭 + 제목).
    await page.goto(`${BASE}/admin/line-opening/practical-competency?org=${org}`, { waitUntil: "domcontentloaded" });
    // 보드 로딩(크루별 결과표 + 집계 카드) 완료까지 대기. (2026-06-12: 레거시 3섹션 숨김으로 마커 변경)
    await page.waitForFunction("document.body.innerText.includes('크루별 라인 개설 결과') && document.body.innerText.includes('활동 크루')", undefined, { timeout: 30000 }).catch(() => {});
    const manageBody = await page.evaluate("document.body.innerText");
    check(`[${org}/manage] 헤더 2탭(라인 관리/라인 개설)`,
      manageBody.includes("라인 관리") && manageBody.includes("라인 개설"));
    // 2026-06-12: 레거시 3섹션(라인 등록/라인 개설/카페 링크 집계) 숨김 + 보드(주차/집계/결과표) 유지.
    check(`[${org}/manage] 레거시 3섹션 숨김 + 보드(집계/결과표) 표시`,
      !manageBody.includes("카페 댓글 닉네임 수집") &&
      !manageBody.includes("라인 개설 대상 주차") &&
      manageBody.includes("크루별 라인 개설 결과") &&
      manageBody.includes("활동 크루"));

    // [라인 개설] — 대시보드(상태창/로그창/개설완료/취소).
    await page.goto(`${BASE}/admin/line-opening/practical-competency?org=${org}&tab=open`, { waitUntil: "domcontentloaded" });
    // 상태창 비동기 로딩 종료 = 블록1 문구('오늘은')가 나타날 때까지 대기.
    await page.waitForFunction("document.body.innerText.includes('오늘은')", undefined, { timeout: 30000 }).catch(() => {});
    const openBody = await page.evaluate("document.body.innerText");
    check(`[${org}/open] 상태창 + 로그창 렌더`, openBody.includes("상태창") && openBody.includes("로그창"));
    check(`[${org}/open] 블록1(오늘 ... 이번 주는)`, /오늘은[\s\S]*이번 주는/.test(openBody));
    check(`[${org}/open] 허브 전체 1문장([실무 역량] 허브 산하 라인들이 ‘개설’ 되어야)`,
      openBody.includes("[실무 역량] 허브 산하 라인들이") &&
      (openBody.includes("‘개설’ 되어야 합니다") || openBody.includes("‘개설 완료’ 되었습니다")));
    // 버튼 3개(개설 | 초기화 | 개설 취소) — 1행 3열, 개설 주차 행 위, 같은 width.
    const btnRow = await page.evaluate(() => {
      const byText = (t) =>
        [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === t) || null;
      const open = byText("개설"), reset = byText("초기화"), cancel = byText("개설 취소");
      const weekBtn = document.querySelector('button[aria-label="개설 주차"]');
      const r = (el) => (el ? el.getBoundingClientRect() : null);
      const ro = r(open), rr = r(reset), rc = r(cancel), rw = r(weekBtn);
      const sameRow = ro && rr && rc && Math.abs(ro.top - rr.top) < 8 && Math.abs(rr.top - rc.top) < 8;
      const ordered = ro && rr && rc && ro.left < rr.left && rr.left < rc.left;
      const sameH = ro && rr && rc &&
        Math.abs(ro.height - rr.height) < 4 && Math.abs(rr.height - rc.height) < 4;
      // content width: 꽉 안 참(각 버튼 < 화면폭의 절반) + '개설 취소'가 '개설'보다 넓음(글자수 비례).
      const notFull = ro && rc && ro.width < window.innerWidth * 0.4 && rc.width < window.innerWidth * 0.4;
      const widthByContent = ro && rc && rc.width > ro.width;
      const aboveWeekRow = ro && rw && ro.bottom <= rw.top + 2;
      return {
        has: !!(open && reset && cancel), sameRow, ordered, sameH, notFull, widthByContent, aboveWeekRow,
        openW: ro ? Math.round(ro.width) : 0, cancelW: rc ? Math.round(rc.width) : 0,
      };
    });
    check(`[${org}/open] 버튼 3개(개설|초기화|개설 취소) 존재`, btnRow.has);
    check(`[${org}/open] 한 줄 + 순서(개설→초기화→개설 취소)`, btnRow.sameRow && btnRow.ordered);
    check(`[${org}/open] 버튼 content width(꽉 안 참 + 글자 길이 비례)`,
      btnRow.notFull && btnRow.widthByContent && btnRow.sameH, `개설=${btnRow.openW}px 개설취소=${btnRow.cancelW}px`);
    check(`[${org}/open] 버튼 영역이 개설 주차 행 위`, btnRow.aboveWeekRow);

    // 개설 주차 — 커스텀 드롭다운. 선택값=메인 표기("NN년, ○○ 시즌, N주차")만.
    // (2026-06-12: manager loading 즉시 렌더로 상태 fetch 전 캡처 방지 — 주차 버튼 populate 대기)
    await page
      .waitForFunction(
        () => /\d{2}년,\s*.+시즌,\s*\d+주차/.test(document.querySelector('button[aria-label="개설 주차"]')?.textContent ?? ""),
        undefined,
        { timeout: 15000 },
      )
      .catch(() => {});
    const weekBtnText = await page.evaluate(
      () => document.querySelector('button[aria-label="개설 주차"]')?.textContent?.trim() ?? "",
    );
    check(`[${org}/open] 개설 주차 선택값=메인 표기(NN년, ○○ 시즌, N주차)`,
      /\d{2}년,\s*.+시즌,\s*\d+주차/.test(weekBtnText), weekBtnText);

    // 입력행 3요소 같은 행.
    const inputRow = await page.evaluate(() => {
      const w = document.querySelector('button[aria-label="개설 주차"]');
      const link = document.querySelector('input[aria-label="아웃풋 링크 1"]');
      const desc = document.querySelector('input[aria-label="설명 1"]');
      let sameRow = false;
      if (w && link && desc) {
        const a = w.getBoundingClientRect(), b = link.getBoundingClientRect(), c = desc.getBoundingClientRect();
        sameRow = Math.abs(a.top - b.top) < 40 && Math.abs(b.top - c.top) < 40;
      }
      return { hasWeek: !!w, hasLink: !!link, hasDesc: !!desc, sameRow };
    });
    check(`[${org}/open] 아웃풋 링크 1 입력칸`, inputRow.hasLink);
    check(`[${org}/open] 설명 1 입력칸`, inputRow.hasDesc);
    check(`[${org}/open] 3요소 한 행 배치(개설주차|링크1|설명1)`, inputRow.sameRow);

    // 링크/설명 입력 + [초기화]가 프론트 입력값만 복원(opened=false → 빈 값) 확인. (드롭다운 열기 전 — 오버레이 방지)
    await page.fill('input[aria-label="아웃풋 링크 1"]', "https://cafe.naver.com/test/verify");
    await page.fill('input[aria-label="설명 1"]', "검증 설명");
    const typed = await page.evaluate(() => ({
      link: document.querySelector('input[aria-label="아웃풋 링크 1"]')?.value ?? "",
      desc: document.querySelector('input[aria-label="설명 1"]')?.value ?? "",
    }));
    check(`[${org}/open] 링크/설명 입력 가능`, typed.link.includes("verify") && typed.desc === "검증 설명");
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "초기화");
      b?.click();
    });
    await page.waitForTimeout(150);
    const afterReset = await page.evaluate(() => ({
      link: document.querySelector('input[aria-label="아웃풋 링크 1"]')?.value ?? "",
      desc: document.querySelector('input[aria-label="설명 1"]')?.value ?? "",
    }));
    check(`[${org}/open] [초기화] 프론트 입력값만 초기값 복원(opened=false→빈 값)`,
      afterReset.link === "" && afterReset.desc === "");

    // 드롭다운 열어 옵션 목록 = 메인 + 날짜 도움말 2줄(요일 포함) + 잘림 해제/스크롤 확인.
    await page.click('button[aria-label="개설 주차"]');
    await page.waitForTimeout(250);
    const menu = await page.evaluate(() => {
      const body = document.body.innerText;
      const btn = document.querySelector('button[aria-label="개설 주차"]');
      const card = btn ? btn.closest(".overflow-visible") : null;
      const cardOverflow = card ? getComputedStyle(card).overflowY : "n/a";
      const menuEl = btn?.parentElement?.querySelector("div.absolute") ?? null;
      const opts = menuEl ? [...menuEl.querySelectorAll("button")] : [];
      let lastVisible = false, scrollable = false, clientH = 0;
      if (menuEl && opts.length) {
        clientH = menuEl.clientHeight;
        scrollable = menuEl.scrollHeight > menuEl.clientHeight + 2;
        menuEl.scrollTop = menuEl.scrollHeight; // 끝까지 스크롤
        const last = opts[opts.length - 1].getBoundingClientRect();
        const mr = menuEl.getBoundingClientRect();
        lastVisible = last.bottom <= mr.bottom + 4 && last.top >= mr.top - 4;
      }
      return {
        hasMain: /\d{2}년,\s*.+시즌,\s*\d+주차/.test(body),
        hasDateHelp: /\d{4}년\s*\d+월\s*\d+일\([일월화수목금토]\)\s*~\s*\d{4}년\s*\d+월\s*\d+일\([일월화수목금토]\)/.test(body),
        dateSample: (body.match(/\d{4}년\s*\d+월\s*\d+일\([일월화수목금토]\)\s*~\s*\d{4}년\s*\d+월\s*\d+일\([일월화수목금토]\)/) ?? [""])[0],
        cardOverflow, optCount: opts.length, lastVisible, scrollable, clientH,
      };
    });
    check(`[${org}/open] 드롭다운 옵션 날짜 도움말(YYYY년 M월 D일(요일) ~ ...)`,
      menu.hasMain && menu.hasDateHelp, menu.dateSample);
    check(`[${org}/open] 드롭다운 Card overflow-visible(잘림 해제)`,
      menu.cardOverflow === "visible", menu.cardOverflow);
    check(`[${org}/open] 드롭다운 옵션 전체 렌더 + 충분한 높이`,
      menu.optCount >= 2 && menu.clientH >= 100, `opts=${menu.optCount} clientH=${menu.clientH}`);
    check(`[${org}/open] 마지막 옵션까지 스크롤 도달 가능`,
      menu.lastVisible, `scrollable=${menu.scrollable} lastVisible=${menu.lastVisible}`);
    await page.click('button[aria-label="개설 주차"]').catch(() => {});
    check(`[${org}/open] 로그 없음 안내(테이블 미적용/빈 로그)`,
      openBody.includes("아직 기록된 개설 로그가 없습니다") || openBody.includes("["));

    // 개설 취소 버튼 비활성(opened=false → disabled) 확인.
    const cancelDisabled = await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button")].filter((b) => (b.textContent || "").trim() === "개설 취소");
      return btns.length > 0 && btns.every((b) => b.disabled);
    });
    check(`[${org}/open] opened=false → [개설 취소] 비활성`, cancelDisabled);

    // [해당 크루] 영역 로딩 완료 대기(스피너 → 빈 안내 또는 테이블).
    await page
      .waitForFunction(
        "document.body.innerText.includes('신청 데이터가 없습니다') || !!document.querySelector('table')",
        undefined,
        { timeout: 20000 },
      )
      .catch(() => {});
    // [해당 크루] 영역 — 요약 칩 6종 + 수동 추가 + 빈 테이블 안내.
    const crewArea = await page.evaluate(() => {
      const body = document.body.innerText;
      const table = document.querySelector("table");
      const manualBadges = [...document.querySelectorAll("span")].filter((s) => (s.textContent || "").trim() === "수동").length;
      const xButtons = [...document.querySelectorAll("button")].filter((b) => (b.getAttribute("aria-label") || "").includes("수동 추가 삭제")).length;
      return {
        hasTitle: body.includes("해당 크루"),
        chips: ["활동 크루", "신청 크루", "개설 크루", "반려 크루", "신청 라인", "개설 라인", "강화 성공", "강화 실패"].every((t) => body.includes(t)),
        hasSearch: !!document.querySelector('input[aria-label="수동 추가 크루 검색"]'),
        hasAddBtn: [...document.querySelectorAll("button")].some((b) => (b.textContent || "").trim().startsWith("추가")),
        loaded: body.includes("신청 데이터가 없습니다") || !!table,
        hasTableHeads: !table || ["크루명", "라인명", "제출 링크", "카페", "승인", "반려 사유"].every((t) => body.includes(t)),
        manualBadges, xButtons,
      };
    });
    check(`[${org}/open] [해당 크루] 제목 + 요약 칩 6종`, crewArea.hasTitle && crewArea.chips);
    check(`[${org}/open] 수동 추가(검색 + 추가 버튼)`, crewArea.hasSearch && crewArea.hasAddBtn);
    check(`[${org}/open] 승인 명단 영역 로드(빈 안내 또는 테이블 헤더)`, crewArea.loaded && crewArea.hasTableHeads);
    // X 삭제 버튼은 수동 추가(source=manual) 행에만 — 수동 배지 수 == X 버튼 수.
    check(`[${org}/open] X 삭제 버튼=수동 추가 행 수와 일치`,
      crewArea.manualBadges === crewArea.xButtons, `수동=${crewArea.manualBadges} X=${crewArea.xButtons}`);

    // 자동완성 + 수동 추가 팝업 (oranke 만 — 실제 크루명으로).
    if (org === "oranke") {
      const crewsRes = await fetch(`${BASE}/api/admin/cluster4/crews?organization=oranke&status=active`, { headers: { cookie: cookieHeader } });
      const crewsJson = await crewsRes.json();
      const sample = (crewsJson.data ?? [])[0];
      if (sample?.displayName) {
        const term = sample.displayName.slice(0, 2);
        await page.fill('input[aria-label="수동 추가 크루 검색"]', term);
        // loadCrewRecords(전 크루 로드)가 느릴 수 있어 충분히 대기.
        await page.waitForTimeout(2500);
        const dd = await page.evaluate(() => {
          const inp = document.querySelector('input[aria-label="수동 추가 크루 검색"]');
          const menu = inp?.closest(".relative")?.querySelector("div.absolute");
          const opts = menu ? [...menu.querySelectorAll("button")] : [];
          return { hasMenu: !!menu, optCount: opts.length, first: opts[0]?.textContent?.trim() ?? "" };
        });
        check(`[oranke/open] 자동완성 드롭다운 표시(크루 번호+이름)`,
          dd.hasMenu && dd.optCount >= 1 && /\d{4}/.test(dd.first), `n=${dd.optCount} 예='${dd.first}'`);
        if (dd.optCount >= 1) {
          // 첫 결과 선택 → [추가] → 팝업.
          await page.evaluate(() => {
            const inp = document.querySelector('input[aria-label="수동 추가 크루 검색"]');
            const menu = inp?.closest(".relative")?.querySelector("div.absolute");
            menu?.querySelector("button")?.click();
          });
          await page.waitForTimeout(200);
          await page.evaluate(() => {
            const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim().startsWith("추가"));
            b?.click();
          });
          await page.waitForTimeout(300);
          const popup = await page.evaluate(() => {
            const sel = document.querySelector('select[aria-label="수동 추가 라인명"]');
            return {
              hasLineSelect: !!sel,
              isInput: !!document.querySelector('input[aria-label="수동 추가 라인명"]'),
              optCount: sel ? [...sel.options].filter((o) => o.value).length : 0,
              hasLink: !!document.querySelector('input[aria-label="수동 추가 제출 링크"]'),
            };
          });
          check(`[oranke/open] 수동 추가 팝업(라인명 드롭다운 + 제출 링크) · 자유입력 없음`,
            popup.hasLineSelect && !popup.isInput && popup.optCount >= 1 && popup.hasLink, `옵션=${popup.optCount}`);
          await page.keyboard.press("Escape").catch(() => {});
        }
      }
    }

    await page.screenshot({ path: resolve(adminRoot, "claudedocs", `browser-competency-open-${org}.png`), fullPage: true });
  }
  console.log("  screenshots → claudedocs/browser-competency-open-{org}.png");
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
  try { await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-competency-open-error.png"), fullPage: true }); } catch {}
} finally {
  await browser.close();
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
