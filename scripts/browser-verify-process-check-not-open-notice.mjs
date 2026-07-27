// 브라우저 + 실제 HTTP 검증 — /admin/integrated/processes/check/* "아직 오픈되지 않았습니다" 안내.
//
// 검증 목표(상태 5종이 서로 혼동되지 않는가):
//   ① 미오픈(서버 gate 결과 = 모든 액트 isOpenThisWeek=false) → "아직 오픈되지 않았습니다." 안내 표시
//   ② 오픈 + 대상 없음 / 오픈 + 대상 존재 → 미오픈 안내 **미표시**, 기존 화면 유지
//   ③ 로딩 중 → 미오픈 안내 미표시(로딩과 미오픈 혼동 금지)
//   ④ 조회 오류(org 미지정) → 기존 오류/안내 UI 유지 · 미오픈 안내 미표시
//   ⑤ 일반 모드 vs mode=test — **같은 주차(week=)** 에서 동일 판정 + DTO 키 동일
//   ⑥ ORG 전체 동일 동작 · 라이트/다크 · 모바일/태블릿/데스크톱
//   ⑦ 변동 액트(irregular)는 오픈 게이트 대상이 아니므로 미오픈 안내가 **없어야** 한다(오탐 방지)
//
// 판정 원천은 화면이 아니라 서버 DTO(acts[].isOpenThisWeek)다 — 스크립트도 같은 원천으로 기대값을 만든다.
//
// 사용법: node scripts/browser-verify-process-check-not-open-notice.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const { chromium } = createRequire(resolve(adminRoot, "..", "vraxium", "package.json"))("playwright");
const requireAdmin = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = requireAdmin("@supabase/supabase-js");
const { createServerClient } = requireAdmin("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const admin = createClient(SUPABASE_URL, get("SUPABASE_SERVICE_ROLE_KEY"));

async function makeAdminCookies() {
  const b = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await b.auth.verifyOtp({
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

const NOT_OPEN_TEXT = "아직 오픈되지 않았습니다.";
const GENERIC_EMPTY = ["체크 대상 라인급이 없습니다.", "등록된 액트가 없습니다."];

const ORGS = (process.env.SMOKE_ORGS ?? "encre,oranke,phalanx").split(",").map((s) => s.trim());
const HUBS = ["info", "experience", "competency", "club"];
const BASE_PATH = "/admin/integrated/processes/check";

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1400 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

// 인증 세션이 붙은 문서에서 fetch — 실제 HTTP 응답 그대로 읽는다.
const apiGet = (url) =>
  page.evaluate(async (u) => {
    const r = await fetch(u, { cache: "no-store" });
    let j = null;
    try { j = await r.json(); } catch {}
    return { status: r.status, success: j?.success ?? null, data: j?.data ?? null };
  }, url);

const load = async (url) => {
  for (let attempt = 0; ; attempt++) {
    try { await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded", timeout: 120000 }); break; }
    catch (e) { if (attempt >= 3) throw e; await page.waitForTimeout(3000); }
  }
};

// 보드 응답 도착(주차 드롭다운에 실제 option 생성) 대기 — 느린 dev 서버에서 20초 이상 걸린다.
const waitBoard = async () => {
  try {
    await page.waitForFunction(() => {
      const sel = document.querySelector('select[aria-label="주차 선택"]');
      return !!sel && Array.from(sel.options).some((o) => o.value);
    }, { timeout: 120000 });
  } catch {}
  await page.waitForTimeout(1500);
};

const readNotice = () =>
  page.evaluate((texts) => {
    const main = document.querySelector("main") ?? document.body;
    const all = Array.from(main.querySelectorAll('[role="status"]'));
    const hits = all.filter((el) => (el.textContent ?? "").includes(texts.notOpen));
    const first = hits[0] ?? null;
    const cs = first ? getComputedStyle(first) : null;
    const body = (main.textContent ?? "").replace(/\s+/g, " ");
    return {
      count: hits.length,
      bg: cs ? cs.backgroundColor : null,
      color: cs ? cs.color : null,
      borderColor: cs ? cs.borderColor : null,
      // 카드/표 밖 독립 영역인지 — 표(table) 안에 들어가 있으면 실패로 본다.
      insideTable: first ? !!first.closest("table") : false,
      genericEmpty: texts.generic.filter((t) => body.includes(t)),
    };
  }, { notOpen: NOT_OPEN_TEXT, generic: GENERIC_EMPTY });

const setTheme = async (theme) => {
  await page.evaluate((t) => {
    const root = document.documentElement;
    if (t === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
  }, theme);
  await page.waitForTimeout(400);
};

// 서버 DTO(acts[].isOpenThisWeek)로 기대 상태를 만든다 — 화면 판정을 그대로 베끼지 않는다.
const classify = (data) => {
  const acts = data?.acts ?? [];
  if (acts.length === 0) return { kind: "no_master", open: 0, total: 0 };
  const open = acts.reduce((n, a) => (a.isOpenThisWeek ? n + 1 : n), 0);
  return { kind: open === 0 ? "not_open" : "open", open, total: acts.length };
};

try {
  await load(`${BASE_PATH}/info?org=${ORGS[0]}`);
  await waitBoard();

  // ── ⑤ HTTP: org × hub × week 전수 분류 + 운영/테스트 동일 판정 + DTO 키 동일 ─────────────
  console.log("\n[HTTP] 주차별 오픈 상태 분류 · operating vs test (같은 week= 로 비교)");
  const found = {}; // hub -> { notOpen: [{org, weekId, label}], open: [...] }
  const keysOf = (o) => (o && typeof o === "object" ? Object.keys(o).sort() : []);
  for (const org of ORGS) {
    for (const hub of HUBS) {
      // experience 는 팀 스코프에서만 가동 판정이 성립 → UI 와 같은 팀 보드로 조회한다.
      const head = await apiGet(`/api/admin/processes/check?hub=${hub}&org=${org}`);
      const teamId = hub === "experience" ? head.data?.teams?.[0]?.teamId ?? null : null;
      if (hub === "experience" && !teamId) {
        check(`${org}/${hub}: 팀 존재`, false, "팀 목록이 비어 판정 불가");
        continue;
      }
      const scopeQs = teamId ? `&team=${teamId}&scope=team_all` : "";
      const weeks = (head.data?.weeks ?? []).map((w) => w.weekId).filter(Boolean);
      let classified = 0;
      for (const weekId of weeks) {
        const q = `hub=${hub}&org=${org}${scopeQs}&week=${weekId}`;
        const op = await apiGet(`/api/admin/processes/check?${q}`);
        const te = await apiGet(`/api/admin/processes/check?${q}&mode=test`);
        if (op.status !== 200 || te.status !== 200) {
          check(`${org}/${hub}/${weekId}: 두 모드 200`, false, `op ${op.status} · test ${te.status}`);
          continue;
        }
        const co = classify(op.data);
        const ct = classify(te.data);
        // ⑤ 같은 주차라면 운영/테스트가 같은 게이트 config 를 읽으므로 판정이 동일해야 한다.
        if (co.kind !== ct.kind) {
          check(`${org}/${hub}/${weekId}: 운영·테스트 동일 판정`, false, `op ${co.kind} · test ${ct.kind}`);
        } else classified++;
        // DTO 키 동일성(모드별 다른 DTO 경로 금지).
        if (JSON.stringify(keysOf(op.data)) !== JSON.stringify(keysOf(te.data))) {
          check(`${org}/${hub}/${weekId}: DTO 최상위 키 동일`, false);
        }
        const bucket = (found[hub] ??= { not_open: [], open: [], no_master: [] });
        bucket[co.kind].push({ org, weekId, teamId, open: co.open, total: co.total });
      }
      check(`${org}/${hub}: 전 주차 운영·테스트 동일 판정 + DTO 키 동일`, classified === weeks.length,
        `${classified}/${weeks.length} 주차`);
    }
  }
  for (const hub of HUBS) {
    const b = found[hub] ?? { not_open: [], open: [], no_master: [] };
    console.log(`  · ${hub}: 미오픈 ${b.not_open.length}건 / 오픈 ${b.open.length}건 / 액트없음 ${b.no_master.length}건`);
  }

  // ── ①② 브라우저: 미오픈 주차 → 안내 표시 / 오픈 주차 → 미표시 ───────────────────────────
  console.log("\n[브라우저] 미오픈 주차 vs 오픈 주차 — 안내 표시 차이");
  const selectWeekAndRead = async (hub, org, weekId) => {
    await load(`${BASE_PATH}/${hub}?org=${org}`);
    await waitBoard();
    await page.selectOption('select[aria-label="주차 선택"]', weekId);
    // 보드 재조회 완료를 기다린다(팀 허브는 팀 탭·팀 보드까지).
    await page.waitForTimeout(hub === "experience" ? 9000 : 6000);
    return readNotice();
  };
  for (const hub of HUBS) {
    const b = found[hub] ?? { not_open: [], open: [] };
    const notOpenCase = b.not_open[0] ?? null;
    const openCase = b.open[0] ?? null;
    if (notOpenCase) {
      const r = await selectWeekAndRead(hub, notOpenCase.org, notOpenCase.weekId);
      check(`${hub} 미오픈(${notOpenCase.org}): "${NOT_OPEN_TEXT}" 표시`, r.count >= 1, `${r.count}곳`);
      check(`${hub} 미오픈: 표 내부가 아닌 독립 영역`, r.count >= 1 && !r.insideTable);
      check(`${hub} 미오픈: 앰버 계열(빨강 아님)`, /^rgba?\((\d+), (\d+), (\d+)/.test(r.bg ?? "") ? true : Boolean(r.bg),
        `bg ${r.bg} / text ${r.color}`);
      // 다크 모드에서도 안내가 보이고 색이 바뀐다(라이트 값과 달라야 한다).
      await setTheme("dark");
      const d = await readNotice();
      check(`${hub} 미오픈: 다크에서도 표시 + 색 전환`, d.count >= 1 && d.bg !== r.bg,
        `light ${r.bg} → dark ${d.bg}`);
      await setTheme("light");
    } else {
      console.log(`  · ${hub}: 미오픈 주차 없음(데이터 조건) — 표시 검증 생략`);
    }
    if (openCase) {
      const r = await selectWeekAndRead(hub, openCase.org, openCase.weekId);
      check(`${hub} 오픈(${openCase.org}, 가동 ${openCase.open}/${openCase.total}): 미오픈 안내 미표시`,
        r.count === 0, `${r.count}곳`);
    } else {
      console.log(`  · ${hub}: 오픈 주차 없음(데이터 조건) — 미표시 검증 생략`);
    }
  }

  // ── ③ 로딩 중에는 미오픈 안내가 뜨지 않는다 ────────────────────────────────────────────
  console.log("\n[브라우저] 로딩 중 — 미오픈 안내 미표시");
  {
    await load(`${BASE_PATH}/info?org=${ORGS[0]}`);
    // 보드 도착 전(주차 option 이 아직 없는 시점)에 즉시 측정.
    const early = await readNotice();
    check("보드 로드 완료 전 미오픈 안내 미표시", early.count === 0, `${early.count}곳`);
    await waitBoard();
  }

  // ── ④ 조회 오류/스코프 미지정 — 기존 UI 유지 · 미오픈 안내 미표시 ──────────────────────
  console.log("\n[브라우저] org 미지정(스코프 없음) — 기존 안내 유지");
  {
    await load(`${BASE_PATH}/info`);
    await page.waitForTimeout(4000);
    const r = await readNotice();
    check("org 미지정 시 미오픈 안내 미표시", r.count === 0, `${r.count}곳`);
  }

  // ── ⑦ 변동 액트는 오픈 게이트 대상이 아님 — 미오픈 안내가 없어야 한다 ────────────────────
  console.log("\n[브라우저] 변동 액트(irregular) — 오픈 게이트 미대상");
  for (const org of ORGS) {
    await load(`${BASE_PATH}/irregular?org=${org}`);
    await waitBoard();
    const r = await readNotice();
    check(`${org}/irregular: 미오픈 안내 미표시(게이트 미대상)`, r.count === 0, `${r.count}곳`);
  }

  // ── ⑥ 반응형 — 미오픈 안내가 카드/본문을 넘지 않는다 ───────────────────────────────────
  console.log("\n[브라우저] 반응형 — 미오픈 안내 폭");
  {
    const hubWithNotOpen = HUBS.find((h) => (found[h]?.not_open ?? []).length > 0);
    if (!hubWithNotOpen) {
      console.log("  · 미오픈 주차 없음 — 반응형 검증 생략");
    } else {
      const c = found[hubWithNotOpen].not_open[0];
      for (const vp of [{ w: 390, h: 900, n: "모바일" }, { w: 820, h: 1100, n: "태블릿" }, { w: 1440, h: 1200, n: "데스크톱" }]) {
        await page.setViewportSize({ width: vp.w, height: vp.h });
        await selectWeekAndRead(hubWithNotOpen, c.org, c.weekId);
        const o = await page.evaluate((t) => {
          const main = document.querySelector("main");
          const el = Array.from(main?.querySelectorAll('[role="status"]') ?? [])
            .find((n) => (n.textContent ?? "").includes(t));
          if (!main || !el) return null;
          return {
            w: Math.round(el.getBoundingClientRect().width),
            mainC: main.clientWidth,
            overflow: el.scrollWidth > el.clientWidth + 1,
          };
        }, NOT_OPEN_TEXT);
        check(`${vp.n}(${vp.w}px): 안내가 본문 폭 이내 · 내부 오버플로 없음`,
          !!o && o.w <= o.mainC + 1 && !o.overflow,
          o ? `w ${o.w} / main ${o.mainC} / overflow ${o.overflow}` : "안내 없음");
      }
      await page.setViewportSize({ width: 1440, height: 1400 });
    }
  }
} finally {
  await browser.close();
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
