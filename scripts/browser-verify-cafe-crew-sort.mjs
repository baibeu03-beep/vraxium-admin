// 브라우저 검증 — 검수 크루 목록(CafeCrewPicker) 표시 정렬(2026-07-12).
//   목표: /admin/line-opening/practical-info 개설 탭의 "검수 크루 목록"에
//   정렬 Select(댓글 시간순/이름순/크루 코드순/미작성 우선/작성 완료 우선)를 추가.
//   검증 포인트:
//     [A] 일반 모드·테스트 모드 모두 동일한 5개 정렬 옵션이 노출된다.
//     [B] 각 정렬 옵션이 표시 순서를 규칙대로 재배열한다(클라이언트 전용).
//     [C] 정렬 변경 시 API 요청이 0건(=API/DTO/저장 무접촉 → mode/org 무관 동일 동작).
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

const EXPECTED_OPTIONS = [
  "댓글 시간순",
  "이름순",
  "크루 코드순",
  "미작성 우선",
  "작성 완료 우선",
];
// 정렬 value → label (컴포넌트 CREW_SORT_OPTIONS 와 동일).
const OPTION_VALUES = ["comment", "name", "crewCode", "incompleteFirst", "completeFirst"];

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
async function readCrewTableRows() {
  return page.evaluate(() => {
    // "검수 크루 목록" 라벨을 가진 섹션 안의 표만 대상으로.
    const label = Array.from(document.querySelectorAll("p")).find(
      (p) => p.textContent.trim() === "검수 크루 목록",
    );
    const section = label?.closest("div.rounded-md");
    const table = section?.querySelector("table");
    if (!table) return [];
    return Array.from(table.querySelectorAll("tbody tr")).map((tr) => {
      const tds = tr.querySelectorAll("td");
      const cell = (i) => (tds[i]?.textContent ?? "").trim();
      const filled = (s) => s !== "" && s !== "-";
      const team = cell(2), part = cell(3), school = cell(4), major = cell(5);
      return {
        code: cell(0),
        name: cell(1),
        complete: filled(team) && filled(part) && filled(school) && filled(major),
      };
    });
  });
}

// 수동 검색으로 후보를 최대 maxAdd 명 추가한다. 추가된 수 반환.
async function populateCandidates(maxAdd) {
  const input = 'input[aria-label="크루 수동 추가 검색"]';
  const countAddable = async () => {
    // 페이지가 초기 마운트 직후 같은 URL 로 client replace 하는 경우가 있어(soft nav)
    // evaluate 컨텍스트가 순간 파괴될 수 있다 → 실패 시 -1 로 폴백(다음 폴에서 재시도).
    try {
      return await page.evaluate(() => {
        const box = document.querySelector(".max-h-52");
        if (!box) return -1; // 아직 렌더 전
        if (box.innerText.includes("검색 중")) return -1; // 로딩 중
        return Array.from(box.querySelectorAll("button")).filter(
          (b) => b.textContent.trim() === "추가" && !b.disabled,
        ).length;
      });
    } catch {
      return -1;
    }
  };
  for (const q of QUERY_CANDIDATES) {
    await page.fill(input, "");
    await page.fill(input, q);
    // 디바운스(300ms) + 응답 대기 — dev 최초 라우트 컴파일이 느릴 수 있어 최대 8s 폴링.
    let addable = 0;
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(200);
      const n = await countAddable();
      if (n >= 0) { addable = n; if (n >= 2) break; }
    }
    if (addable >= 2) {
      // 결과의 "추가" 버튼을 최대 maxAdd 개 클릭.
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
      await page.fill(input, ""); // 검색창 닫기
      await page.waitForTimeout(200);
      return added;
    }
  }
  await page.fill(input, "");
  return 0;
}

// 정렬 Select 를 value 로 변경.
async function setSort(value) {
  await page.selectOption('select[aria-label="검수 크루 목록 정렬"]', value);
  await page.waitForTimeout(150);
}

async function verifyMode(modeLabel, url) {
  console.log(`\n[${modeLabel}]  ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("document.body.innerText.includes('검수 크루 목록')", undefined, { timeout: 60000 });
  // 초기 마운트 직후의 client replace(soft nav)가 끝나도록 정착 대기.
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1500);

  // [A] 정렬 Select + 5개 옵션 노출.
  const opts = await page.evaluate(() => {
    const sel = document.querySelector('select[aria-label="검수 크루 목록 정렬"]');
    if (!sel) return null;
    return {
      values: Array.from(sel.options).map((o) => o.value),
      labels: Array.from(sel.options).map((o) => o.text.trim()),
      value: sel.value,
    };
  });
  check("[A] 정렬 Select 존재", !!opts);
  if (opts) {
    check("[A] 옵션 라벨 5종 일치", JSON.stringify(opts.labels) === JSON.stringify(EXPECTED_OPTIONS), JSON.stringify(opts.labels));
    check("[A] 옵션 value 5종 일치", JSON.stringify(opts.values) === JSON.stringify(OPTION_VALUES), JSON.stringify(opts.values));
    check("[A] 기본값 = 댓글 시간순(comment)", opts.value === "comment", `value=${opts.value}`);
  }
  // 옛 고정 문구 "댓글 시간순" 단독 <p> 는 제거되어야(옵션 텍스트로만 존재).
  const legacyFixed = await page.evaluate(() =>
    Array.from(document.querySelectorAll("p")).some((p) => p.textContent.includes("검수 크루 목록 · 댓글 시간순")),
  );
  check("[A] 옛 고정 문구('검수 크루 목록 · 댓글 시간순') 제거", !legacyFixed);

  // 후보 채우기.
  const added = await populateCandidates(4);
  check("[B] 후보 검색·추가(실 HTTP) ≥2명", added >= 2, `added=${added}`);
  if (added < 2) return;

  // 기준(comment) 순서.
  await setSort("comment");
  const base = await readCrewTableRows();
  const completeCount = base.filter((r) => r.complete).length;
  console.log(`    · 후보 ${base.length}명 (작성완료 ${completeCount} / 미작성 ${base.length - completeCount})`);

  // [C] 정렬 변경 시 API 요청 0건 카운트.
  let apiCalls = 0;
  const onReq = (req) => { if (req.url().includes("/api/")) apiCalls++; };
  page.on("request", onReq);

  // [B] 이름순 — name localeCompare 비내림차순(브라우저 자체 비교로 판정).
  await setSort("name");
  const byName = await readCrewTableRows();
  const nameOk = await page.evaluate((names) => {
    for (let i = 1; i < names.length; i++) {
      if ((names[i - 1] || "").localeCompare(names[i] || "", "ko") > 0) return false;
    }
    return true;
  }, byName.map((r) => r.name));
  check("[B] 이름순: 이름 오름차순", nameOk, byName.map((r) => r.name).join(" ≤ "));

  // [B] 크루 코드순 — 채워진 코드 오름차순 + 빈 코드('-')는 뒤.
  await setSort("crewCode");
  const byCode = await readCrewTableRows();
  const codeOk = await page.evaluate((codes) => {
    const filled = codes.filter((c) => c !== "" && c !== "-");
    const empties = codes.filter((c) => c === "" || c === "-");
    // 채워진 것 먼저(연속), 그 다음 빈 것.
    const firstEmptyIdx = codes.findIndex((c) => c === "" || c === "-");
    if (firstEmptyIdx !== -1 && codes.slice(firstEmptyIdx).some((c) => c !== "" && c !== "-")) return false;
    for (let i = 1; i < filled.length; i++) {
      if (filled[i - 1].localeCompare(filled[i], "ko") > 0) return false;
    }
    return true;
  }, byCode.map((r) => r.code));
  check("[B] 크루 코드순: 코드 오름차순·빈값 뒤", codeOk, byCode.map((r) => r.code).join(" , "));

  // [B] 미작성 우선 — 미작성(complete=false) 이 앞, 작성완료가 뒤.
  await setSort("incompleteFirst");
  const byIncomplete = await readCrewTableRows();
  const incFirstLastFalse = byIncomplete.map((r) => r.complete);
  const incOk = (() => {
    let seenComplete = false;
    for (const c of incFirstLastFalse) {
      if (c) seenComplete = true;
      else if (seenComplete) return false; // 완료 뒤에 미작성이 나오면 위반
    }
    return true;
  })();
  check("[B] 미작성 우선: 미작성이 앞", incOk, incFirstLastFalse.map((c) => (c ? "완료" : "미작성")).join(" "));

  // [B] 작성 완료 우선 — 작성완료가 앞, 미작성이 뒤.
  await setSort("completeFirst");
  const byComplete = await readCrewTableRows();
  const compFlags = byComplete.map((r) => r.complete);
  const compOk = (() => {
    let seenIncomplete = false;
    for (const c of compFlags) {
      if (!c) seenIncomplete = true;
      else if (seenIncomplete) return false; // 미작성 뒤에 완료가 나오면 위반
    }
    return true;
  })();
  check("[B] 작성 완료 우선: 완료가 앞", compOk, compFlags.map((c) => (c ? "완료" : "미작성")).join(" "));

  // 기준으로 복귀 시 원래(comment) 순서 그대로 복원되는지(안정성).
  await setSort("comment");
  const back = await readCrewTableRows();
  const restored = JSON.stringify(back.map((r) => r.code + "|" + r.name)) === JSON.stringify(base.map((r) => r.code + "|" + r.name));
  check("[B] 댓글 시간순 복귀 = 원본 순서 복원", restored);

  page.off("request", onReq);
  // [C] 정렬 5회 변경 동안 API 호출 0건.
  check("[C] 정렬 변경 중 API 요청 0건(클라이언트 전용)", apiCalls === 0, `apiCalls=${apiCalls}`);

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
