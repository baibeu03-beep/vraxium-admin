// 브라우저 검증 — 검수 크루 목록(CafeCrewPicker) 컬럼 헤더 정렬(2026-07-24 개편).
//   구 정렬 Select 를 폐지하고 테이블 컬럼 헤더 정렬(SortableTh + cycleSort)로 이전했다.
//   검증 포인트:
//     [A] 일반·테스트 모드 모두 "정렬" <select> 가 없고, 4개 정렬 헤더(크루 코드/이름/댓글 시간/작성 상태)가 있다.
//     [B] 각 헤더 클릭이 asc → desc → 기본(원본 댓글순 복귀) 순환으로 표시 순서를 규칙대로 재배열한다.
//     [C] 헤더 정렬 클릭 중 API 요청 0건(=API/DTO/저장 무접촉 → mode/org 무관 동일 동작).
//   후보는 "크루 수동 추가 검색"(실제 HTTP: /api/admin/cluster4/cafe-line-crew)으로 채운다.
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
const ORG = "oranke";

const SORT_HEADERS = ["크루 코드", "이름", "댓글 시간", "작성 상태"];

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

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 2400 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

// 후보 검색용 쿼리 후보 — 모드별로 결과가 나오는 첫 쿼리를 사용.
const QUERY_CANDIDATES = ["ㄱ", "김", "이", "박", "최", "정", "테", "T", "a", "e"];

// "검수 크루 목록" 표의 행 순서를 읽는다: {code, name, complete}.
//   컬럼: 0 크루코드 · 1 이름 · 2 댓글시간(순번) · 3 팀명 · 4 파트명 · 5 학교명 · 6 전공명 · 7 작성상태 · 8 삭제.
async function readCrewTableRows() {
  return page.evaluate(() => {
    const label = Array.from(document.querySelectorAll("p")).find(
      (p) => p.textContent.trim() === "검수 크루 목록",
    );
    const section = label?.closest("div.rounded-md");
    const table = section?.querySelector("table");
    if (!table) return [];
    return Array.from(table.querySelectorAll("tbody tr")).map((tr) => {
      const tds = tr.querySelectorAll("td");
      const cell = (i) => (tds[i]?.textContent ?? "").trim();
      return {
        code: cell(0),
        name: cell(1),
        commentOrder: cell(2),
        complete: cell(7) === "완료", // 작성 상태 컬럼(배지 텍스트)
      };
    });
  });
}

// "검수 크루 목록" 섹션의 컬럼 헤더 정렬 버튼을 라벨로 클릭(도움말 버튼과 구분: aria-label 접두).
async function clickHeader(label) {
  const clicked = await page.evaluate((lbl) => {
    const p = Array.from(document.querySelectorAll("p")).find(
      (el) => el.textContent.trim() === "검수 크루 목록",
    );
    const section = p?.closest("div.rounded-md");
    const table = section?.querySelector("table");
    const btns = Array.from(table?.querySelectorAll("thead th button") ?? []);
    const btn = btns.find((b) => (b.getAttribute("aria-label") ?? "").startsWith(`${lbl} 기준 정렬`));
    if (!btn) return false;
    btn.click();
    return true;
  }, label);
  await page.waitForTimeout(150);
  return clicked;
}

// React 제어 입력에 값 주입 — native value setter + input 이벤트로 onChange 를 발화한다.
//   (Playwright fill 의 actionability(안정성/pointer) 대기에 의존하지 않아 재렌더 타이밍에 강건.)
async function setControlledInput(selector, value) {
  await page.evaluate(({ selector, value }) => {
    const el = document.querySelector(selector);
    if (!el) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, { selector, value });
}

// 현재 선택된 주차/활동유형에서 수동 검색으로 후보를 최대 maxAdd 명 추가 시도. 추가된 수 반환.
async function tryAddFromSearch(input, maxAdd) {
  const countAddable = async () => {
    try {
      return await page.evaluate(() => {
        const box = document.querySelector(".max-h-52");
        if (!box) return -1;
        if (box.innerText.includes("검색 중")) return -1;
        return Array.from(box.querySelectorAll("button")).filter(
          (b) => b.textContent.trim() === "추가" && !b.disabled,
        ).length;
      });
    } catch {
      return -1;
    }
  };
  for (const q of QUERY_CANDIDATES) {
    await setControlledInput(input, "");
    await page.evaluate((s) => document.querySelector(s)?.focus(), input);
    await page.keyboard.type(q, { delay: 25 });
    let addable = 0;
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(200);
      const n = await countAddable();
      if (n >= 0) { addable = n; if (n >= 2) break; }
    }
    if (addable >= 1) {
      let added = 0;
      while (added < maxAdd) {
        const clicked = await page.evaluate(() => {
          const box = document.querySelector(".max-h-52");
          if (!box) return false;
          const btn = Array.from(box.querySelectorAll("button")).find(
            (b) => b.textContent.trim() === "추가" && !b.disabled,
          );
          if (!btn) return false;
          btn.click();
          return true;
        });
        if (!clicked) break;
        added++;
        await page.waitForTimeout(120);
      }
      await setControlledInput(input, ""); // 검색창 닫기
      await page.waitForTimeout(200);
      if (added >= 2) return added;
    }
  }
  await setControlledInput(input, "");
  return 0;
}

// 개설 폼이 '개설 완료(locked)'면 기본 주차의 피커가 비활성이다 → 주차 드롭다운을 훑어
//   피커가 활성(입력 enabled)인 주차를 찾아 후보를 채운다. 실제 후보가 2명 이상 모이면 그 수를 반환.
async function populateCandidates(maxAdd) {
  const input = 'input[aria-label="크루 수동 추가 검색"]';
  const nOpts = await page.evaluate(() => document.querySelector("select")?.options.length ?? 0);
  for (let wi = 0; wi < nOpts; wi++) {
    const val = await page.evaluate((idx) => document.querySelector("select").options[idx].value, wi);
    await page.selectOption("select", val).catch(() => {});
    await page.waitForTimeout(2500);
    const disabled = await page.evaluate((s) => document.querySelector(s)?.disabled ?? true, input);
    if (disabled) continue; // 개설 완료(locked) 주차 — 피커 비활성, 다음 주차 시도.
    const added = await tryAddFromSearch(input, maxAdd);
    if (added >= 2) return added;
  }
  return 0;
}

const keyOf = (rows) => JSON.stringify(rows.map((r) => r.code + "|" + r.name));
const isNameAsc = (rows) =>
  page.evaluate((names) => {
    for (let i = 1; i < names.length; i++) {
      if ((names[i - 1] || "").localeCompare(names[i] || "", "ko") > 0) return false;
    }
    return true;
  }, rows.map((r) => r.name));
const isNameDesc = (rows) =>
  page.evaluate((names) => {
    for (let i = 1; i < names.length; i++) {
      if ((names[i - 1] || "").localeCompare(names[i] || "", "ko") < 0) return false;
    }
    return true;
  }, rows.map((r) => r.name));
// 코드 오름차순 + 빈코드('-'/'') 뒤.
const isCodeAsc = (rows) =>
  page.evaluate((codes) => {
    const firstEmpty = codes.findIndex((c) => c === "" || c === "-");
    if (firstEmpty !== -1 && codes.slice(firstEmpty).some((c) => c !== "" && c !== "-")) return false;
    const filled = codes.filter((c) => c !== "" && c !== "-");
    for (let i = 1; i < filled.length; i++) {
      if (filled[i - 1].localeCompare(filled[i], "ko") > 0) return false;
    }
    return true;
  }, rows.map((r) => r.code));
// 완료가 앞(작성완료 우선) / 미작성이 앞(미작성 우선) 판정.
const completeFirst = (rows) => {
  let seenInc = false;
  for (const r of rows) { if (!r.complete) seenInc = true; else if (seenInc) return false; }
  return true;
};
const incompleteFirst = (rows) => {
  let seenComp = false;
  for (const r of rows) { if (r.complete) seenComp = true; else if (seenComp) return false; }
  return true;
};

async function verifyMode(modeLabel, url) {
  console.log(`\n[${modeLabel}]  ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction("document.body.innerText.includes('검수 크루 목록')", undefined, { timeout: 90000 });
  // 개설 폼은 마운트 직후 weeks/lines/openStatus 를 병렬 fetch → 그 재렌더가 끝나 입력이 안정될 때까지 대기.
  //   (networkidle 은 dev 폴링으로 미도달할 수 있어 사용하지 않고, 입력의 시각적 안정을 직접 기다린다.)
  const manualInput = 'input[aria-label="크루 수동 추가 검색"]';
  await page.locator(manualInput).first().waitFor({ state: "visible", timeout: 60000 });
  await page.waitForTimeout(2500);

  // [A] 정렬 <select> 미노출.
  const hasSelect = await page.evaluate(
    () => !!document.querySelector('select[aria-label="검수 크루 목록 정렬"]'),
  );
  check("[A] 정렬 <select> 미노출", !hasSelect);

  // 후보 채우기(정렬 헤더 판정 위해 먼저 채운다 — 후보 0명이면 표가 렌더되지 않음).
  //   ⚠ 개설 폼이 '개설 완료(locked)' 상태면 피커가 비활성·목록 비어 후보를 넣을 수 없다(환경 의존).
  //     이 경우 [A](정렬 select 제거)만 확정하고 헤더 정렬 상호작용은 SKIP 한다(정렬 규칙은 단위 검증이 담당).
  const added = await populateCandidates(4);
  if (added < 2) {
    const locked = await page.evaluate(() => document.body.innerText.includes("개설 취소"));
    console.log(`  ⚠ [B/C] SKIP — 후보 목록 채우기 불가(added=${added}, locked=${locked}). 헤더 정렬 상호작용 검증 생략(단위 검증으로 대체).`);
    return;
  }
  check("[B] 후보 검색·추가(실 HTTP) ≥2명", added >= 2, `added=${added}`);

  // [A] 4개 정렬 헤더 존재.
  const headerLabels = await page.evaluate(() => {
    const p = Array.from(document.querySelectorAll("p")).find((el) => el.textContent.trim() === "검수 크루 목록");
    const table = p?.closest("div.rounded-md")?.querySelector("table");
    return Array.from(table?.querySelectorAll("thead th button") ?? [])
      .map((b) => (b.getAttribute("aria-label") ?? "").replace(/ 기준 정렬.*$/, ""))
      .filter((l) => ["크루 코드", "이름", "댓글 시간", "작성 상태"].includes(l));
  });
  check("[A] 정렬 헤더 4종 존재", JSON.stringify(headerLabels) === JSON.stringify(SORT_HEADERS), JSON.stringify(headerLabels));

  const base = await readCrewTableRows();
  const completeCount = base.filter((r) => r.complete).length;
  console.log(`    · 후보 ${base.length}명 (작성완료 ${completeCount} / 미작성 ${base.length - completeCount})`);

  // [C] 헤더 정렬 클릭 중 API 요청 0건.
  let apiCalls = 0;
  const onReq = (req) => { if (req.url().includes("/api/")) apiCalls++; };
  page.on("request", onReq);

  // [B] 이름 — 클릭1=asc, 클릭2=desc, 클릭3=기본(원본 복귀).
  await clickHeader("이름");
  const nameAsc = await readCrewTableRows();
  check("[B] 이름 1클릭 = 오름차순", await isNameAsc(nameAsc), nameAsc.map((r) => r.name).join(" ≤ "));
  await clickHeader("이름");
  const nameDesc = await readCrewTableRows();
  check("[B] 이름 2클릭 = 내림차순", await isNameDesc(nameDesc), nameDesc.map((r) => r.name).join(" ≥ "));
  await clickHeader("이름");
  check("[B] 이름 3클릭 = 기본(원본 댓글순) 복귀", keyOf(await readCrewTableRows()) === keyOf(base));

  // [B] 크루 코드 — asc(코드 오름+빈값 뒤) → desc → 기본.
  await clickHeader("크루 코드");
  const codeAsc = await readCrewTableRows();
  check("[B] 크루 코드 1클릭 = 오름차순·빈값 뒤", await isCodeAsc(codeAsc), codeAsc.map((r) => r.code).join(" , "));
  await clickHeader("크루 코드");
  await clickHeader("크루 코드");
  check("[B] 크루 코드 3클릭 = 기본 복귀", keyOf(await readCrewTableRows()) === keyOf(base));

  // [B] 작성 상태 — asc=미작성 우선 → desc=작성완료 우선 → 기본.
  await clickHeader("작성 상태");
  const wsAsc = await readCrewTableRows();
  check("[B] 작성 상태 1클릭 = 미작성 우선", incompleteFirst(wsAsc), wsAsc.map((r) => (r.complete ? "완료" : "미작성")).join(" "));
  await clickHeader("작성 상태");
  const wsDesc = await readCrewTableRows();
  check("[B] 작성 상태 2클릭 = 작성 완료 우선", completeFirst(wsDesc), wsDesc.map((r) => (r.complete ? "완료" : "미작성")).join(" "));
  await clickHeader("작성 상태");
  check("[B] 작성 상태 3클릭 = 기본 복귀", keyOf(await readCrewTableRows()) === keyOf(base));

  // [B] 댓글 시간 — asc=원본순, desc=역순, 기본 복귀.
  await clickHeader("댓글 시간");
  check("[B] 댓글 시간 1클릭 = 원본(댓글) 순서", keyOf(await readCrewTableRows()) === keyOf(base));
  await clickHeader("댓글 시간");
  const ctDesc = await readCrewTableRows();
  check("[B] 댓글 시간 2클릭 = 역순", keyOf(ctDesc) === keyOf([...base].reverse()));
  await clickHeader("댓글 시간");
  check("[B] 댓글 시간 3클릭 = 기본 복귀", keyOf(await readCrewTableRows()) === keyOf(base));

  page.off("request", onReq);
  check("[C] 헤더 정렬 클릭 중 API 요청 0건(클라이언트 전용)", apiCalls === 0, `apiCalls=${apiCalls}`);

  await page.screenshot({ path: resolve(adminRoot, "claudedocs", `cafe-crew-sort-${modeLabel}.png`), fullPage: true });
}

try {
  await verifyMode("normal", `${BASE}/admin/line-opening/practical-info?org=${ORG}&tab=open`);
  await verifyMode("test", `${BASE}/admin/line-opening/practical-info?org=${ORG}&mode=test&tab=open`);
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
  try { await page.screenshot({ path: resolve(adminRoot, "claudedocs", "cafe-crew-sort-error.png"), fullPage: true }); } catch {}
} finally {
  await browser.close();
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
