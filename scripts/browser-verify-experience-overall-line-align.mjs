// 브라우저 검증 — 실무 경험 [팀 총괄] 보드: 5개 평가 컬럼(도출/분석/견문/관리/확장)의
//   라인명 드롭다운 상단 Y좌표가 같은 행 안에서 모두 일치하는지 측정한다(정렬 회귀 방지).
//   근본원인이던 "컬럼별 점수/안내 슬롯 높이 차이"를 공통 1단 슬롯(min-h)으로 통일한 뒤의 검증.
//   비파괴(mutation 없음) — 표시·정렬만. org × mode 전수. 각 행에서 라인명 트리거들의 top Δ<=2px 를 통과 기준.
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
const ORGS = process.env.VERIFY_ORG ? [process.env.VERIFY_ORG] : ["encre", "oranke", "phalanx"];
const ALL_MODES = [
  { key: "operating", qs: "" },
  { key: "test", qs: "&mode=test" },
];
const MODES = process.env.VERIFY_MODE
  ? ALL_MODES.filter((mode) => mode.key === process.env.VERIFY_MODE)
  : ALL_MODES;

let pass = 0, fail = 0;
const ck = (l, ok, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1400 } });
await context.addCookies(cookies);
const page = await context.newPage();

const gotoAndReady = async (url) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    } catch {
      await page.waitForTimeout(900);
      continue;
    }
    const ready = await page
      .waitForSelector('[data-slot="select-trigger"].w-56', { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (ready) {
      await page.waitForTimeout(800);
      return;
    }
    await page.waitForTimeout(900);
  }
  throw new Error("part Select 트리거 미등장(부트 실패)");
};

const openSelect = async () => {
  await page.locator('[data-slot="select-trigger"].w-56').first().click({ timeout: 10000 });
  await page.waitForTimeout(400);
};
const pickOption = async (text) => {
  await page.locator('[data-slot="select-item"]', { hasText: text }).first().click({ timeout: 10000 });
  await page.waitForTimeout(1500);
};

// 보드 각 행에서 5개 평가 셀(마지막 5개 td)의 라인명 트리거 top 좌표를 수집한다.
//   · 라인명 트리거 = 셀 안의 [data-slot="select-trigger"](Radix). 점수는 native <select>라 제외.
//   · 관리(일반 크루)·확장(비확장 주간)은 트리거가 없을 수 있음 — 그 경우 셀의 1단 슬롯 bottom 을 대신
//     사용하지 않고, "트리거 있는 컬럼끼리" top 일치 + 각 셀 1단 슬롯 높이 동일을 함께 본다.
const measureRows = () =>
  page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-slot="table-body"] [data-slot="table-row"]'));
    return rows.map((row) => {
      const tds = Array.from(row.querySelectorAll('[data-slot="table-cell"]'));
      const catCells = tds.slice(-5); // 도출/분석/견문/관리/확장
      const cells = catCells.map((td) => {
        const trig = td.querySelector('[data-slot="select-trigger"]');
        // 1단 슬롯 = 셀 콘텐츠 wrapper(flex-col)의 첫 자식 div.
        const wrap = td.querySelector(":scope > div.flex.flex-col");
        const slot = wrap ? wrap.firstElementChild : null;
        return {
          trigTop: trig ? Math.round(trig.getBoundingClientRect().top) : null,
          slotH: slot ? Math.round(slot.getBoundingClientRect().height) : null,
        };
      });
      const name = (tds[0]?.textContent || "").trim();
      return { name, cells };
    });
  });

for (const org of ORGS) {
  for (const m of MODES) {
    const tag = `${org}/${m.key}`;
    try {
      const weekQs = process.env.VERIFY_WEEK ? `&week=${encodeURIComponent(process.env.VERIFY_WEEK)}` : "";
      await gotoAndReady(`${BASE}/admin/line-opening/practical-experience?org=${org}&tab=open${m.qs}${weekQs}`);

      // 팀 총괄 보드 렌더.
      await openSelect();
      const hasOverall = await page.locator('[data-slot="select-item"]', { hasText: "팀 총괄" }).count();
      if (!hasOverall) {
        await page.keyboard.press("Escape");
        ck(`[${tag}] 팀 총괄 옵션 없음(스킵)`, true, "no overall option");
        continue;
      }
      await pickOption("팀 총괄");

      // 표를 뷰포트로.
      await page.evaluate(() => {
        const tbl = document.querySelector('[data-slot="table"]') || document.querySelector("table");
        if (tbl) tbl.scrollIntoView({ block: "center" });
      }).catch(() => {});
      await page.waitForTimeout(400);

      const rows = await measureRows();
      if (rows.length === 0) {
        ck(`[${tag}] 대상 크루 행 없음(스킵)`, true, "0 rows");
        continue;
      }

      // (A) 같은 행에서 라인명 트리거 top 이 모두 일치(Δ<=2px).
      let alignBad = [];
      let slotBad = [];
      let rowsWithTrigs = 0;
      for (const r of rows) {
        const tops = r.cells.map((c) => c.trigTop).filter((t) => t != null);
        const slots = r.cells.map((c) => c.slotH).filter((h) => h != null);
        if (tops.length >= 2) {
          rowsWithTrigs++;
          const min = Math.min(...tops), max = Math.max(...tops);
          if (max - min > 2) alignBad.push(`${r.name}:Δ${max - min}(${tops.join(",")})`);
        }
        // 1단 슬롯 높이도 컬럼 간 동일해야(min-h 통일) — Δ<=2px.
        if (slots.length >= 2) {
          const min = Math.min(...slots), max = Math.max(...slots);
          if (max - min > 2) slotBad.push(`${r.name}:Δ${max - min}(${slots.join(",")})`);
        }
      }
      ck(`[${tag}] 행별 라인명 트리거 top 일치(Δ≤2px)`, alignBad.length === 0, alignBad.length ? alignBad.slice(0, 4).join(" | ") : `${rowsWithTrigs}행 검사`);
      ck(`[${tag}] 행별 1단 슬롯 높이 동일(Δ≤2px)`, slotBad.length === 0, slotBad.length ? slotBad.slice(0, 4).join(" | ") : `${rows.length}행 검사`);

      // (B) 전 행 통틀어 슬롯 높이 SoT(min-h 48) 준수 — 모든 슬롯 >=48px.
      const allSlots = rows.flatMap((r) => r.cells.map((c) => c.slotH).filter((h) => h != null));
      const under = allSlots.filter((h) => h < 48);
      ck(`[${tag}] 1단 슬롯 min-h(48px) 준수`, under.length === 0, under.length ? `${under.length}개 <48px: ${under.slice(0, 5).join(",")}` : `n=${allSlots.length}`);

      await page.screenshot({ path: resolve(adminRoot, "claudedocs", `exp-line-align-${org}-${m.key}.png`), fullPage: false }).catch(() => {});
    } catch (e) {
      ck(`[${tag}] 반복 실행 오류`, false, e?.message ?? String(e));
      try { await page.screenshot({ path: resolve(adminRoot, "claudedocs", `exp-line-align-${org}-${m.key}-error.png`), fullPage: true }); } catch {}
    }
  }
}

await browser.close();
console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
