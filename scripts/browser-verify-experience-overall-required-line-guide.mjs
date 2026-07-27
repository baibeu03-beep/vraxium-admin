// 브라우저 검증 — 실무 경험 [팀 총괄]: 파트장 라인명 미입력 시 [개설 검수] / [개설 완료] 가
//   **동일한** 누락 안내(팝업 → 스크롤 → 붉은 강조 → 포커스)를 수행하는지 확인한다.
//
//   검증 계약(openingInvalidHighlight SoT · guideToInvalidTarget 공용 경로):
//     (1) 팝업이 열린 시점에 이미 첫 누락 칸이 강조(ring-red-400) + 화면 안으로 스크롤돼 있다.
//     (2) 첫 누락 칸 = 화면 배치 기준 위→아래, 같은 행이면 왼→오른(행 우선) 첫 칸.
//     (3) 팝업 [확인] 후에도 강조가 유지되고 그 칸의 Select 트리거로 포커스가 이동한다.
//     (4) 라인명이 이미 입력된(또는 필수 대상이 아닌) 칸에는 강조가 붙지 않는다(강조 대상은 정확히 1곳).
//     (5) [개설 검수] 경로와 [개설 완료] 경로의 결과가 동일하다.
//
//   비파괴 — 라인명 선택은 로컬 편집(state)일 뿐이고, 검수/완료는 이 검증에서 항상 차단되므로
//   POST 가 나가지 않는다. 필수 누락 칸이 만들어지지 않는 케이스는 클릭하지 않고 스킵한다.
//
//   후보(org/week/team/status)는 scripts/diag-experience-overall-open-candidates.ts 로 뽑는다.
//   run: node scripts/browser-verify-experience-overall-required-line-guide.mjs
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
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL"),
  ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE),
  brow = createClient(URL_, ANON);
const EMAIL = "vanuatu.golden@gmail.com";
const REQUIRED_MESSAGE = "파트장 라인명을 선택해야 개설 검수를 진행할 수 있습니다.";

// (org, week, team, 기대 버튼) 케이스 — status=none → [개설 검수], status=reviewed → [개설 완료].
//   일반 경로(operating)와 mode=test 경로를 모두 돈다(동일 UI 로직 확인).
//   ⚠ week 은 주차 드롭다운에 실제로 존재하는 주차여야 한다(목록 밖 주차를 ?week 로 넣으면
//     트리거에 raw id 가 뜨고 보드가 뜨지 않는다).
const CASES = [
  {
    label: "검수",
    button: "개설 검수",
    org: "encre",
    week: "2d21a7cc-37ce-4223-acac-419bc5fa094b", // 26 여름 4주차 · 개설 대상
    team: "비주얼랩(T)",
  },
  {
    label: "검수",
    button: "개설 검수",
    org: "encre",
    week: "d3260418-fcd3-4c23-875f-e51502cf9bd3", // 26 여름 3주차
    team: "비주얼랩(T)",
  },
  {
    label: "완료",
    button: "개설 완료",
    org: "encre",
    week: "d3260418-fcd3-4c23-875f-e51502cf9bd3", // 검수 완료(status=reviewed) 상태
    team: "사운드(T)",
  },
];
const MODES = [
  { key: "operating", qs: "" },
  { key: "test", qs: "&mode=test" },
];

let pass = 0,
  fail = 0;
const ck = (l, ok, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({
  email: EMAIL,
  token: link.properties.email_otp,
  type: "magiclink",
});
const cap = [];
const srv = createServerClient(URL_, ANON, {
  cookies: { getAll: () => [], setAll: (i) => cap.push(...i) },
});
await srv.auth.setSession({
  access_token: v.session.access_token,
  refresh_token: v.session.refresh_token,
});
const cookies = cap.map((i) => ({
  name: i.name,
  value: i.value,
  domain: "localhost",
  path: "/",
  httpOnly: false,
  secure: false,
  sameSite: "Lax",
}));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
await context.addCookies(cookies);
const page = await context.newPage();

// 표에서 파트장(도출/분석/견문) 셀 상태를 수집한다.
//   · 파트장 셀 = 1단 슬롯에 점수 native <select> 가 있는 셀(일반 크루는 읽기전용 배지).
//   · 필수 대상 = 체크 ON && 점수 >= 1 (validatePartLeaderLineRequirements 와 동일 판정).
//   · order = 행(위→아래) × 열(왼→오른) 행 우선 인덱스 = 기대 이동 순서.
const collectLeaderCells = () =>
  page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll('[data-slot="table-body"] [data-slot="table-row"]'),
    );
    const out = [];
    rows.forEach((row, rowIdx) => {
      const tds = Array.from(row.querySelectorAll('[data-slot="table-cell"]'));
      const cats = tds.slice(-5).slice(0, 3); // 도출/분석/견문
      cats.forEach((td, colIdx) => {
        const wrap = td.querySelector(":scope > div.flex.flex-col");
        if (!wrap) return;
        const scoreSelect = wrap.querySelector("select");
        if (!scoreSelect) return; // 일반 크루(읽기전용 배지) — 파트장 아님.
        const checkbox = wrap.querySelector('input[type="checkbox"]');
        const lineWrap = wrap.children[1] ?? null;
        const trigger = td.querySelector('[data-slot="select-trigger"]');
        if (!trigger || !lineWrap) return;
        // ⚠ 트리거 textContent 에는 폭 계산용 숨김 sizer(모든 옵션 라벨)가 섞여 있다 —
        //   선택값은 반드시 [data-slot="select-value"] 에서 읽는다.
        const valueEl = trigger.querySelector('[data-slot="select-value"]');
        const lineText = (valueEl?.textContent || "").trim();
        out.push({
          rowIdx,
          colIdx,
          order: rowIdx * 100 + colIdx,
          name: (tds[0]?.textContent || "").trim(),
          category: ["도출", "분석", "견문"][colIdx],
          checked: Boolean(checkbox && checkbox.checked),
          score: Number(scoreSelect.value === "" ? -1 : scoreSelect.value),
          hasLine: lineText !== "" && lineText !== "라인명",
          disabled:
            trigger.hasAttribute("disabled") ||
            trigger.getAttribute("aria-disabled") === "true" ||
            trigger.getAttribute("data-disabled") != null,
          invalid: trigger.getAttribute("aria-invalid") === "true",
          highlighted: (lineWrap.className || "").includes("ring-red-400"),
        });
      });
    });
    return out;
  });

// 강조/포커스 현황 — 강조 대상은 정확히 1곳이어야 하고, 그 칸이 화면 안에 보여야 한다.
const measureGuide = () =>
  page.evaluate(() => {
    const triggers = Array.from(document.querySelectorAll('[data-slot="select-trigger"]'));
    const invalid = triggers.filter((t) => t.getAttribute("aria-invalid") === "true");
    const highlightedWraps = Array.from(document.querySelectorAll("div")).filter((d) =>
      (d.className || "").includes("ring-red-400"),
    );
    const target = invalid[0] ?? null;
    const rect = target ? target.getBoundingClientRect() : null;
    // 세로 스크롤 컨테이너(admin 셸의 main 등) — 이미 끝까지 스크롤된 상태면 "중앙"에 놓을 수 없다.
    let scroller = target?.parentElement ?? null;
    while (scroller && scroller !== document.body) {
      const st = getComputedStyle(scroller);
      if (
        /(auto|scroll)/.test(st.overflowY) &&
        scroller.scrollHeight > scroller.clientHeight + 2
      )
        break;
      scroller = scroller.parentElement;
    }
    const atTop = scroller ? scroller.scrollTop <= 2 : window.scrollY <= 2;
    const atBottom = scroller
      ? scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 2
      : false;
    const row = target ? target.closest('[data-slot="table-row"]') : null;
    const td = target ? target.closest('[data-slot="table-cell"]') : null;
    const tds = row ? Array.from(row.querySelectorAll('[data-slot="table-cell"]')) : [];
    return {
      invalidCount: invalid.length,
      highlightCount: highlightedWraps.length,
      targetName: row ? (tds[0]?.textContent || "").trim() : null,
      targetCol: td ? tds.slice(-5).indexOf(td) : -1,
      targetRowIdx: row
        ? Array.from(
            document.querySelectorAll('[data-slot="table-body"] [data-slot="table-row"]'),
          ).indexOf(row)
        : -1,
      inViewport: rect ? rect.top >= 0 && rect.bottom <= window.innerHeight : false,
      // 화면 중앙 부근(block:"center")인지 — 뷰포트 높이의 15~85% 사이면 "명확히 보임"으로 본다.
      roughlyCentered: rect
        ? rect.top > window.innerHeight * 0.05 && rect.bottom < window.innerHeight * 0.95
        : false,
      atScrollLimit: atTop || atBottom,
      focused:
        target != null && document.activeElement === target,
      activeTag: document.activeElement?.getAttribute?.("data-slot") ?? document.activeElement?.tagName ?? null,
    };
  });

const gotoBoard = async (org, week, team, modeQs) => {
  const url = `${BASE}/admin/integrated/line-opening/practical-experience?org=${org}&tab=open&week=${week}${modeQs}`;
  // dev 서버 컴파일 지연으로 첫 goto 가 늦을 수 있다 — 재시도(검증 대상과 무관한 인프라 흔들림).
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      break;
    } catch (err) {
      if (attempt >= 2) throw err;
      await page.waitForTimeout(1500);
    }
  }
  // 팀 탭은 부트(팀 목록 조회) 후에야 나타난다 — 조직 탭과 같은 role="tab" 이라 팀명으로 기다린다.
  const tab = page.locator('button[role="tab"]', { hasText: team }).first();
  await tab.waitFor({ state: "visible", timeout: 40000 });
  await page.waitForTimeout(600);
  await tab.click({ timeout: 15000 });
  await page.waitForTimeout(1500);
  // 파트 드롭다운 → 팀 총괄.
  await page.locator('[data-slot="select-trigger"].w-56').first().click({ timeout: 15000 });
  await page.waitForTimeout(500);
  await page
    .locator('[data-slot="select-content"]:visible [data-slot="select-item"]', {
      hasText: "팀 총괄",
    })
    .first()
    .click({ timeout: 15000 });
  // 보드(표) 렌더 대기.
  await page
    .locator('[data-slot="table-body"] [data-slot="table-row"]')
    .first()
    .waitFor({ state: "visible", timeout: 30000 });
  await page.waitForTimeout(1200);
};

// 지정한 파트장 셀의 라인명을 바꾼다 — 로컬 state 만 변경(저장 없음).
//   optionIndex 0 = '-'(보이드=비우기), 1 이상 = 실제 라인(채우기).
const pickLine = async (rowIdx, colIdx, optionIndex) => {
  const trigger = page
    .locator('[data-slot="table-body"] [data-slot="table-row"]')
    .nth(rowIdx)
    .locator('[data-slot="table-cell"]')
    .nth(3 + colIdx) // 이름/파트/클래스 3열 뒤가 도출/분석/견문.
    .locator('[data-slot="select-trigger"]')
    .first();
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click({ timeout: 10000 });
  await page.waitForTimeout(400);
  // ⚠ 닫힌 드롭다운의 항목도 DOM 에 남아 있다 — 지금 열린 팝업(:visible)으로 한정해야 한다.
  const items = page.locator(
    '[data-slot="select-content"]:visible [data-slot="select-item"]',
  );
  const n = await items.count();
  if (optionIndex >= n) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    return false;
  }
  await items.nth(optionIndex).click({ timeout: 10000 });
  await page.waitForTimeout(400);
  return true;
};
const clearLine = (rowIdx, colIdx) => pickLine(rowIdx, colIdx, 0);

// 두 가지 배치로 검증한다.
//   first  = 누락 칸이 여러 개일 때 첫 칸(위→아래·왼→오른)으로 이동하는가.
//   second = 첫 칸을 채워 넣으면 이동 대상이 "그 다음 누락 칸"으로 옮겨가는가(순서 판정이 실제로 작동).
const STRATEGIES = ["first", "second"];

for (const c of CASES) {
  for (const m of MODES) {
    for (const strategy of STRATEGIES) {
    const tag = `${c.org}/${c.team}/${c.label}/${m.key}/${strategy}`;
    try {
      await gotoBoard(c.org, c.week, c.team, m.qs);

      const before = await collectLeaderCells();
      const editable = before.filter((x) => !x.disabled);
      if (editable.length === 0) {
        ck(`[${tag}] 편집 가능한 파트장 라인명 칸 없음(스킵)`, true, `수집 ${before.length}칸`);
        continue;
      }
      // 필수 대상(체크 ON · 점수>=1) 중 라인명이 채워진 칸들 — 마지막 1칸은 남겨 "이미 입력된 칸"
      //   대조군으로 쓰고 나머지를 비운다(누락 2곳 이상이면 순서 판정도 함께 검증된다).
      const required = editable
        .filter((x) => x.checked && x.score >= 1)
        .sort((a, b) => a.order - b.order);
      if (required.length === 0) {
        ck(`[${tag}] 필수 대상(체크·1점 이상) 파트장 칸 없음(스킵)`, true, "");
        continue;
      }
      const filled = required.filter((x) => x.hasLine);
      const toClear = filled.length > 1 ? filled.slice(0, -1) : filled;
      for (const cell of toClear) await clearLine(cell.rowIdx, cell.colIdx);

      const readMissing = async () => {
        const cells = await collectLeaderCells();
        return {
          cells,
          missing: cells
            .filter((x) => !x.disabled && x.checked && x.score >= 1 && !x.hasLine)
            .sort((a, b) => a.order - b.order),
        };
      };
      let { cells: after, missing } = await readMissing();
      // second 배치: 첫 누락 칸을 실제 라인으로 채워 이동 대상이 다음 칸으로 옮겨가는지 본다.
      if (strategy === "second") {
        if (missing.length < 2) {
          ck(`[${tag}] 누락 칸 2개 미만(순서 검증 스킵)`, true, `누락 ${missing.length}`);
          continue;
        }
        const first = missing[0];
        let ok = await pickLine(first.rowIdx, first.colIdx, 1);
        ({ cells: after, missing } = await readMissing());
        // 드롭다운 클릭이 튕기는 경우가 있어 1회 재시도 — 그래도 안 채워지면 이 배치는 스킵.
        if (ok && missing[0] && missing[0].order === first.order) {
          ok = await pickLine(first.rowIdx, first.colIdx, 1);
          ({ cells: after, missing } = await readMissing());
        }
        if (!ok || (missing[0] && missing[0].order === first.order)) {
          ck(`[${tag}] 첫 칸 채우기 실패(순서 검증 스킵)`, true, "선택 가능한 라인 옵션 없음/클릭 무반응");
          continue;
        }
      }
      if (missing.length === 0) {
        ck(`[${tag}] 누락 칸 생성 실패(스킵 — 클릭 없음)`, true, "");
        continue;
      }
      const expected = missing[0];
      const keptFilled = after.filter((x) => x.checked && x.score >= 1 && x.hasLine);
      if (strategy === "second") {
        ck(
          `[${tag}] 첫 칸을 채운 뒤 대상이 다음 칸으로 이동(사전 조건)`,
          keptFilled.length > 0 && expected.order > Math.min(...keptFilled.map((k) => k.order)),
          `채운 칸 ${keptFilled.length} · 기대 대상 ${expected.name}/${expected.category}`,
        );
      }

      // 버튼 클릭 → 필수 입력 안내 팝업. 비활성(개설 기간/상태 게이트)이면 사유와 함께 스킵.
      const actionBtn = page.locator("button", { hasText: c.button }).first();
      const btnState = await actionBtn.evaluate((el) => ({
        disabled: el.hasAttribute("disabled"),
        title: el.getAttribute("title") ?? el.parentElement?.getAttribute("title") ?? "",
      }));
      if (btnState.disabled) {
        ck(`[${tag}] [${c.button}] 버튼 비활성(스킵)`, true, btnState.title || "사유 없음");
        continue;
      }
      await actionBtn.click({ timeout: 10000 });
      const dialog = page.locator('[role="alertdialog"]');
      const appeared = await dialog
        .first()
        .waitFor({ state: "visible", timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      ck(`[${tag}] [${c.button}] → 필수 입력 안내 팝업`, appeared);
      if (!appeared) continue;
      const body = (await dialog.first().innerText()).replace(/\s+/g, " ");
      ck(`[${tag}] 팝업 문구 = 파트장 라인명 필수`, body.includes(REQUIRED_MESSAGE), body.slice(0, 80));

      // (1) 팝업이 열린 시점에 이미 강조 + 스크롤 완료(smooth 스크롤 정착 대기).
      await page.waitForTimeout(700);
      const open = await measureGuide();
      ck(
        `[${tag}] 팝업 시점 강조 1곳`,
        open.invalidCount === 1 && open.highlightCount === 1,
        `invalid=${open.invalidCount} highlight=${open.highlightCount}`,
      );
      ck(
        `[${tag}] 첫 누락 칸(위→아래·왼→오른)`,
        open.targetRowIdx === expected.rowIdx && open.targetCol === expected.colIdx,
        `기대 ${expected.name}/${expected.category}(r${expected.rowIdx}c${expected.colIdx}) · 실제 r${open.targetRowIdx}c${open.targetCol}(${open.targetName}) · 누락 ${missing.length}곳`,
      );
      // 스크롤 컨테이너가 이미 끝(위/아래)에 닿아 있으면 중앙 배치는 물리적으로 불가 — 화면에 보이면 통과.
      ck(
        `[${tag}] 대상 칸이 화면에 보임(중앙 부근)`,
        open.inViewport && (open.roughlyCentered || open.atScrollLimit),
        `inViewport=${open.inViewport} centered=${open.roughlyCentered} atLimit=${open.atScrollLimit}`,
      );
      await page
        .screenshot({
          path: resolve(adminRoot, "claudedocs", `exp-required-line-${c.org}-${c.label}-${m.key}-${strategy}-dialog.png`),
        })
        .catch(() => {});

      // (2) [확인] → 팝업 닫힘 후 강조 유지 + 포커스 이동.
      await page.locator('[role="alertdialog"] button', { hasText: "확인" }).first().click();
      await dialog.first().waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
      // 팝업 포커스 복원 → 그 뒤 재확정(200ms)까지 기다린 다음 측정. 강조 해제(1.6s) 전이어야 한다.
      await page.waitForTimeout(500);
      const closed = await measureGuide();
      ck(
        `[${tag}] 확인 후 강조 유지(1곳)`,
        closed.invalidCount === 1 && closed.highlightCount === 1,
        `invalid=${closed.invalidCount} highlight=${closed.highlightCount}`,
      );
      ck(
        `[${tag}] 확인 후 대상 동일 + 화면에 보임`,
        closed.targetRowIdx === expected.rowIdx &&
          closed.targetCol === expected.colIdx &&
          closed.inViewport,
        `r${closed.targetRowIdx}c${closed.targetCol} inViewport=${closed.inViewport}`,
      );
      ck(
        `[${tag}] 확인 후 대상 Select 트리거로 포커스 이동`,
        closed.focused,
        `activeElement=${closed.activeTag}`,
      );

      // (3) 이미 입력된 칸에는 강조 없음.
      const dirty = (await collectLeaderCells()).filter(
        (x) => (x.invalid || x.highlighted) && x.hasLine,
      );
      ck(
        `[${tag}] 입력된 칸에는 오류 효과 없음`,
        dirty.length === 0,
        dirty.length ? dirty.map((d) => `${d.name}/${d.category}`).join(",") : `대조군 ${keptFilled.length}칸`,
      );

      // (4) 강조 자동 해제(약 1.6s) — 무한 깜빡임 금지.
      await page.waitForTimeout(2200);
      const late = await measureGuide();
      ck(
        `[${tag}] 1.6s 후 강조 자동 해제`,
        late.invalidCount === 0 && late.highlightCount === 0,
        `invalid=${late.invalidCount} highlight=${late.highlightCount}`,
      );
      // 개설 완료 확인 팝업("…개설 완료하시겠습니까?")이 뜨지 않았는지 = 검증이 POST 앞에서 차단.
      const strayText = await page
        .locator('[role="alertdialog"]:visible, [role="dialog"]:visible')
        .allInnerTexts();
      const confirmShown = strayText.some((t) => t.includes("개설 완료하시겠습니까"));
      ck(
        `[${tag}] 후속 확인 팝업 없음(POST 차단)`,
        !confirmShown,
        strayText.length ? strayText.join(" | ").replace(/\s+/g, " ").slice(0, 80) : "열린 팝업 없음",
      );
    } catch (e) {
      ck(`[${tag}] 실행 오류`, false, e?.message ?? String(e));
      try {
        await page.screenshot({
          path: resolve(
            adminRoot,
            "claudedocs",
            `exp-required-line-${c.org}-${c.label}-${m.key}-${strategy}-error.png`,
          ),
          fullPage: true,
        });
      } catch {}
    }
    }
  }
}

await browser.close();
console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
