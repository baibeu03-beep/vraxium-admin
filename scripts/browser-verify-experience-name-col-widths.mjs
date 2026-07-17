// 브라우저 검증 — 실무 경험 [라인 개설] 표:
//   (1) 이름 열에 역할 라벨(파트장)이 남아있지 않은지
//   (2) 클래스 열은 그대로 파트장/정규 등을 표시하는지
//   (3) 이름/파트/클래스 열 축소 + 나머지 업무 열 확대가 반영됐는지(colgroup 단일 기준)
//   (4) 헤더/본문 열 정렬 일치·새로운 가로 스크롤/셀 겹침·이름 줄바꿈 회귀가 없는지
//   비파괴(mutation 없음) — 표시·레이아웃만 측정. org × mode 전수.
//   대상 표 2종: [팀 총괄] 보드(ExperienceTeamOverallBoard) + [파트] 입력 그리드(ExperiencePartLeadInput).
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
// 기록용 — 변경 전/후 비교를 위해 측정치를 JSON 으로 덤프한다.
const DUMP = process.env.VERIFY_DUMP ? resolve(adminRoot, process.env.VERIFY_DUMP) : null;

let pass = 0,
  fail = 0;
const ck = (l, ok, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  if (ok) pass++;
  else fail++;
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
const listOptions = () =>
  page.locator('[data-slot="select-item"]').allTextContents();
const pickOption = async (text) => {
  await page.locator('[data-slot="select-item"]', { hasText: text }).first().click({ timeout: 10000 });
  await page.waitForTimeout(1500);
};

// 표 측정 — 헤더 라벨/폭, 본문 첫 3열(이름/파트/클래스) 텍스트 + 줄 수 + overflow, 가로 스크롤.
const measureTable = () =>
  page.evaluate(() => {
    const tbl = document.querySelector('[data-slot="table"]');
    if (!tbl) return null;
    const scroller = tbl.closest(".overflow-x-auto");
    const ths = Array.from(tbl.querySelectorAll('[data-slot="table-head"]'));
    const headers = ths.map((th) => ({
      label: (th.textContent || "").trim(),
      w: Math.round(th.getBoundingClientRect().width * 10) / 10,
      left: Math.round(th.getBoundingClientRect().left * 10) / 10,
    }));
    const rows = Array.from(
      tbl.querySelectorAll('[data-slot="table-body"] [data-slot="table-row"]'),
    );
    const body = rows.map((row) => {
      const tds = Array.from(row.querySelectorAll('[data-slot="table-cell"]'));
      const cell = (td) => {
        if (!td) return null;
        const r = td.getBoundingClientRect();
        const cs = getComputedStyle(td);
        const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
        // 텍스트 실제 줄 수 — 셀 안 텍스트 노드를 Range 로 감싸 client rect 수를 센다.
        let lines = null;
        const rng = document.createRange();
        rng.selectNodeContents(td);
        const rects = Array.from(rng.getClientRects()).filter((x) => x.height > 1);
        if (rects.length) {
          const tops = new Set(rects.map((x) => Math.round(x.top)));
          lines = tops.size;
        }
        return {
          text: (td.textContent || "").trim(),
          w: Math.round(r.width * 10) / 10,
          left: Math.round(r.left * 10) / 10,
          // overflow = 내용이 셀 폭을 넘어 삐져나감(셀 겹침 신호).
          overflow: Math.round(td.scrollWidth - td.clientWidth),
          lines,
          lineHeight: Math.round(lh),
        };
      };
      return {
        name: cell(tds[0]),
        part: cell(tds[1]),
        klass: cell(tds[2]),
        // 마지막 업무 열들(도출/분석/견문/…) 폭
        workW: tds.slice(3).map((td) => Math.round(td.getBoundingClientRect().width * 10) / 10),
      };
    });
    return {
      headers,
      body,
      tableW: Math.round(tbl.getBoundingClientRect().width * 10) / 10,
      scroll: scroller
        ? {
            clientW: scroller.clientWidth,
            scrollW: scroller.scrollWidth,
            overflows: scroller.scrollWidth > scroller.clientWidth + 1,
          }
        : null,
    };
  });

// 역할 라벨(파트장) 이 이름 열에 남아있는지 — 텍스트 + 기존 라벨 span(text-sky-700) 둘 다 확인.
const nameRoleLeak = () =>
  page.evaluate(() => {
    const tbl = document.querySelector('[data-slot="table"]');
    if (!tbl) return null;
    const rows = Array.from(
      tbl.querySelectorAll('[data-slot="table-body"] [data-slot="table-row"]'),
    );
    const leaks = [];
    for (const row of rows) {
      const td = row.querySelector('[data-slot="table-cell"]');
      if (!td) continue;
      const t = (td.textContent || "").trim();
      const hasSpan = !!td.querySelector("span");
      if (/파트장|팀장|에이전트|\(|\)/.test(t) || hasSpan) {
        leaks.push({ text: t, hasSpan });
      }
    }
    return leaks;
  });

const dump = {};

for (const org of ORGS) {
  for (const m of MODES) {
    const tag = `${org}/${m.key}`;
    try {
      const weekQs = process.env.VERIFY_WEEK
        ? `&week=${encodeURIComponent(process.env.VERIFY_WEEK)}`
        : "";
      await gotoAndReady(
        `${BASE}/admin/line-opening/practical-experience?org=${org}&tab=open${m.qs}${weekQs}`,
      );

      await openSelect();
      const opts = await listOptions();
      const hasOverall = opts.some((o) => o.includes("팀 총괄"));
      const partOpt = opts.find((o) => !o.includes("팀 총괄"));

      // ── (A) 팀 총괄 보드 ──
      if (hasOverall) {
        await pickOption("팀 총괄");
        const t = await measureTable();
        if (!t || t.body.length === 0) {
          ck(`[${tag}] 총괄: 행 없음(스킵)`, true, "0 rows");
        } else {
          dump[`${tag}/overall`] = t;
          const leaks = await nameRoleLeak();
          ck(
            `[${tag}] 총괄 이름열 역할 라벨 없음`,
            leaks.length === 0,
            leaks.length ? leaks.slice(0, 3).map((l) => l.text).join(" | ") : `${t.body.length}행`,
          );
          // 클래스 열은 값 유지(빈칸/'-' 아님).
          const klassVals = t.body.map((r) => r.klass?.text ?? "");
          const klassEmpty = klassVals.filter((x) => !x || x === "-");
          ck(
            `[${tag}] 총괄 클래스 열 값 유지`,
            klassEmpty.length === 0,
            `값: ${[...new Set(klassVals)].slice(0, 4).join(",")}`,
          );
          // 헤더/본문 좌표 정렬 일치(Δ≤1px).
          const misalign = t.body.filter((r) => {
            const hs = t.headers;
            return (
              Math.abs((r.name?.left ?? 0) - (hs[0]?.left ?? 0)) > 1 ||
              Math.abs((r.part?.left ?? 0) - (hs[1]?.left ?? 0)) > 1 ||
              Math.abs((r.klass?.left ?? 0) - (hs[2]?.left ?? 0)) > 1
            );
          });
          ck(`[${tag}] 총괄 헤더/본문 열 정렬 일치`, misalign.length === 0, `${t.body.length}행 검사`);
          // 셀 겹침(overflow) 없음.
          const ov = t.body.filter(
            (r) => (r.name?.overflow ?? 0) > 0 || (r.part?.overflow ?? 0) > 0 || (r.klass?.overflow ?? 0) > 0,
          );
          ck(
            `[${tag}] 총괄 좌측 3열 셀 넘침 없음`,
            ov.length === 0,
            ov.length ? ov.slice(0, 3).map((r) => `${r.name?.text}:${r.name?.overflow}px`).join(" | ") : "0",
          );
          // 이름 1줄(일반 이름 기준).
          const wrapped = t.body.filter((r) => (r.name?.lines ?? 1) > 1);
          ck(
            `[${tag}] 총괄 이름 1줄 표시`,
            wrapped.length === 0,
            wrapped.length
              ? `줄바꿈: ${wrapped.map((r) => `${r.name?.text}(${r.name?.lines}줄)`).slice(0, 3).join(",")}`
              : `${t.body.length}행 모두 1줄`,
          );
          const w = t.body[0];
          console.log(
            `    · 총괄 폭 이름=${w.name?.w} 파트=${w.part?.w} 클래스=${w.klass?.w} 업무=${w.workW.join("/")} (표 ${t.tableW}px, 스크롤 ${t.scroll?.scrollW}/${t.scroll?.clientW})`,
          );
        }
        await openSelect();
      }

      // ── (B) 파트 입력 그리드 ──
      if (partOpt) {
        await pickOption(partOpt);
        const t = await measureTable();
        if (!t || t.body.length === 0) {
          ck(`[${tag}] 파트(${partOpt}): 행 없음(스킵)`, true, "0 rows");
        } else {
          dump[`${tag}/part`] = t;
          const leaks = await nameRoleLeak();
          ck(
            `[${tag}] 파트 이름열 역할 라벨 없음`,
            leaks.length === 0,
            leaks.length ? leaks.slice(0, 3).map((l) => l.text).join(" | ") : `${t.body.length}행`,
          );
          const ov = t.body.filter(
            (r) => (r.name?.overflow ?? 0) > 0 || (r.part?.overflow ?? 0) > 0 || (r.klass?.overflow ?? 0) > 0,
          );
          ck(`[${tag}] 파트 좌측 3열 셀 넘침 없음`, ov.length === 0, ov.length ? `${ov.length}건` : "0");
          const wrapped = t.body.filter((r) => (r.name?.lines ?? 1) > 1);
          ck(
            `[${tag}] 파트 이름 1줄 표시`,
            wrapped.length === 0,
            wrapped.length ? wrapped.map((r) => `${r.name?.text}(${r.name?.lines}줄)`).slice(0, 3).join(",") : `${t.body.length}행 모두 1줄`,
          );
          const w = t.body[0];
          console.log(
            `    · 파트 폭 이름=${w.name?.w} 파트명=${w.part?.w} 클래스=${w.klass?.w} 업무=${w.workW.join("/")} (표 ${t.tableW}px, 스크롤 ${t.scroll?.scrollW}/${t.scroll?.clientW})`,
          );
        }
      } else {
        await page.keyboard.press("Escape").catch(() => {});
      }
    } catch (e) {
      ck(`[${tag}] 반복 실행 오류`, false, e?.message ?? String(e));
      try {
        await page.screenshot({
          path: resolve(adminRoot, "claudedocs", `exp-name-col-${org}-${m.key}-error.png`),
          fullPage: true,
        });
      } catch {}
    }
  }
}

await browser.close();
if (DUMP) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(DUMP, JSON.stringify(dump, null, 2), "utf8");
  console.log(`\n측정 덤프: ${DUMP}`);
}
console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
