// 브라우저 검증 — /admin/integrated/processes/check/* 테이블 셀 스타일 통일(2026-07-27).
//
//   검증 계약:
//     (1) 하위 라우트 전수(club/competency/experience/info/irregular)를 조직 3종 × 모드 2종으로 연다.
//     (2) 본문 셀 기준: "소속 라인 급" · "종류" · "카페" 컬럼 값이 공용 Badge(data-slot="badge")다.
//         빈 값("-"/공백)은 배지 없이 기존 표기를 유지한다(배지 강제 아님).
//     (3) 같은 컬럼의 같은 값 = 같은 색. 페이지/조직/모드가 달라도 동일(computed color 로 대조).
//     (4) 별/방패(po.A·po.B) 셀값은 --point-good(초록), 번개(po.C)는 --point-danger(빨강).
//         값 0 도 색을 유지한다. 헤더/정렬 버튼에는 이 색이 없어야 한다.
//     (5) 일반 모드와 mode=test 가 같은 셀 렌더러를 탄다(컬럼 구성·배지 적용 패턴 동일).
//     (6) 두 모드의 /api/admin/processes/check 응답 DTO 키가 동일하다(표시 변경이 DTO를 건드리지 않음).
//
//   조회 전용 — 클릭/저장/검수/롤백을 하지 않는다(GET 만). snapshot·user_weekly_points 무접촉.
//   run: node scripts/browser-verify-process-check-cell-styles.mjs
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
const g = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = process.env.BASE ?? "http://localhost:3000";
const SUPABASE_URL = g("NEXT_PUBLIC_SUPABASE_URL");
const ANON = g("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = g("SUPABASE_SERVICE_ROLE_KEY");
const admin = createClient(SUPABASE_URL, SERVICE);

// 기본은 전수. 개발 서버가 무거울 때만 ROUTES/ORGS 환경변수로 분할 실행한다(계약은 동일).
const ROUTES = (process.env.ROUTES ?? "info,experience,competency,club,irregular").split(",");
const ORGS = (process.env.ORGS ?? "encre,oranke,phalanx").split(",");
const MODES = ["", "&mode=test"];
// 배지 대상 컬럼 — 헤더 텍스트(정렬/돋보기 제외한 라벨 접두)로 찾는다.
const BADGE_COLUMNS = ["소속 라인 급", "종류", "카페"];

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++; else fail++;
};

async function makeAdminCookies() {
  const { data: adm } = await admin
    .from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = process.env.SMOKE_ADMIN_EMAIL ?? adm?.[0]?.email;
  const b = createClient(SUPABASE_URL, ANON);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await b.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  console.log(`admin = ${email}`);
  return captured.map((i) => ({
    name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax",
  }));
}

// 화면의 모든 표를 훑어 (컬럼 라벨 → 셀 표본)을 수집한다.
//   배지 여부/색은 DOM 과 computed style 로 직접 확인한다(클래스 문자열 신뢰 안 함).
const readTables = (page, pointLabels) =>
  page.evaluate(({ badgeColumns, pointLabels: pl }) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const rgb = (el) => getComputedStyle(el).color;
    const out = { tableCount: 0, headers: [], badgeCells: {}, pointCells: {}, headerPointColored: [] };
    for (const col of badgeColumns) out.badgeCells[col] = [];
    for (const k of ["a", "b", "c"]) out.pointCells[k] = [];

    for (const t of Array.from(document.querySelectorAll("table"))) {
      const ths = Array.from(t.querySelectorAll("thead th"));
      const labels = ths.map((th) => norm(th.textContent));
      if (labels.length === 0) continue;
      out.tableCount += 1;
      if (out.headers.length === 0) out.headers = labels;

      const idxOf = (label) => labels.findIndex((l) => l === label || l.startsWith(label));
      const colIdx = {};
      for (const col of badgeColumns) colIdx[col] = idxOf(col);
      const pointIdx = { a: idxOf(pl.a), b: idxOf(pl.b), c: idxOf(pl.c) };

      // 헤더에는 포인트 색이 없어야 한다 — 헤더 th(및 정렬 버튼)의 색을 수집해 대조용으로 보고.
      for (const key of ["a", "b", "c"]) {
        const i = pointIdx[key];
        if (i < 0) continue;
        const th = ths[i];
        out.headerPointColored.push({ key, color: rgb(th), label: labels[i] });
      }

      for (const tr of Array.from(t.querySelectorAll("tbody tr"))) {
        const tds = Array.from(tr.querySelectorAll("td"));
        if (tds.length < labels.length - 1) continue; // colSpan 안내행 등은 건너뜀
        for (const col of badgeColumns) {
          const i = colIdx[col];
          if (i < 0 || !tds[i]) continue;
          const badge = tds[i].querySelector('[data-slot="badge"],[data-slot="badge-button"]');
          out.badgeCells[col].push({
            text: norm(tds[i].textContent),
            hasBadge: Boolean(badge),
            color: badge ? rgb(badge) : null,
            bg: badge ? getComputedStyle(badge).backgroundColor : null,
            nowrap: badge ? getComputedStyle(badge).whiteSpace : null,
          });
        }
        for (const key of ["a", "b", "c"]) {
          const i = pointIdx[key];
          if (i < 0 || !tds[i]) continue;
          out.pointCells[key].push({ text: norm(tds[i].textContent), color: rgb(tds[i]) });
        }
      }
    }
    return out;
  }, { badgeColumns: BADGE_COLUMNS, pointLabels });

// 조직별 po 표시명(별/방패/번개 …) — 화면 헤더가 조직 config 를 따르므로 검증도 같은 출처를 쓴다.
const POINT_LABELS = {
  encre: { a: "별", b: "방패", c: "번개" },
  oranke: { a: "단감", b: "인절미", c: "어흥" },
  phalanx: { a: "투구", b: "방패", c: "화살" },
};

// globals.css 토큰 실측값 — 라이트 테마 기준으로 브라우저에서 직접 읽어 비교 기준으로 삼는다.
async function readPointTokens(page) {
  return page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.display = "none";
    document.body.appendChild(probe);
    const read = (cls) => {
      probe.className = cls;
      return getComputedStyle(probe).color;
    };
    const good = read("text-point-good");
    const danger = read("text-point-danger");
    probe.remove();
    return { good, danger };
  });
}

async function main() {
  const cookies = await makeAdminCookies();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1800, height: 1200 } });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  // 컬럼별 값 → 색 전역 대조표(페이지/조직/모드를 가로질러 누적).
  const valueColor = {};
  for (const col of BADGE_COLUMNS) valueColor[col] = new Map();
  // 모드별 DTO 키 수집(API 응답 가로채기).
  const dtoKeys = { operating: new Set(), test: new Set() };
  const apiStatus = [];
  page.on("response", async (res) => {
    const u = res.url();
    if (!u.includes("/api/admin/processes/check")) return;
    apiStatus.push({ url: u.replace(BASE, ""), status: res.status() });
    if (res.status() !== 200) return;
    try {
      const j = await res.json();
      const bucket = u.includes("mode=test") ? dtoKeys.test : dtoKeys.operating;
      // 응답 계약 = { success, data: board }. board.acts 가 행 DTO 배열.
      const acts = j?.data?.acts ?? j?.board?.acts ?? j?.acts ?? [];
      for (const a of acts.slice(0, 5)) for (const k of Object.keys(a)) bucket.add(k);
    } catch { /* non-json */ }
  });

  let tokens = null;
  const perRouteMode = {};

  for (const route of ROUTES) {
    for (const org of ORGS) {
      for (const mode of MODES) {
        const modeLabel = mode ? "mode=test" : "일반";
        const url = `${BASE}/admin/integrated/processes/check/${route}?org=${org}${mode}`;
        const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
        const httpOk = resp && resp.status() < 400;
        // 액트 표(헤더에 "소속 라인 급"/"액트 종류"가 있는 표)가 그려질 때까지 대기.
        //   experience 는 팀 탭 선택 후 팀 보드 fetch 가 끝나야 표가 생긴다.
        //   표가 끝내 없으면 "등록된 액트가 없습니다"류 안내(=대상 0건인 정상 빈 상태)로 간주한다.
        const hasActTable = () =>
          page.evaluate(() =>
            Array.from(document.querySelectorAll("table")).some((t) =>
              Array.from(t.querySelectorAll("thead th")).some((th) =>
                /소속 라인 급|액트 종류/.test(th.textContent || ""),
              ),
            ));
        try {
          await page.waitForFunction(
            () => {
              const txt = document.body.innerText || "";
              const found = Array.from(document.querySelectorAll("table")).some((t) =>
                Array.from(t.querySelectorAll("thead th")).some((th) =>
                  /소속 라인 급|액트 종류/.test(th.textContent || ""),
                ),
              );
              return found ||
                /등록된 액트가 없습니다|변동 액트가 없습니다|클럽이 지정|등록된 팀이 없습니다/.test(txt);
            },
            { timeout: 60000, polling: 500 },
          );
        } catch { /* 아래 emptyState 실측으로 드러난다 */ }
        const emptyState = !(await hasActTable());
        if (emptyState) {
          const txt = await page.evaluate(() => {
            const main = document.querySelector("main") ?? document.body;
            return (main.innerText || "").replace(/\s+/g, " ").slice(-200);
          });
          console.log(`    · 액트 표 없음 — 본문 끝: ${txt}`);
        }
        if (!tokens) tokens = await readPointTokens(page);

        const pl = POINT_LABELS[org];
        const r = await readTables(page, pl);
        const key = `${route} | ${org} | ${modeLabel}`;
        perRouteMode[key] = { httpStatus: resp?.status() ?? 0, emptyState, ...r };
        console.log(`\n▸ ${key}  (HTTP ${resp?.status()}, 표 ${r.tableCount}개${emptyState ? ", 빈 상태" : ""})`);
        check("HTTP 정상", Boolean(httpOk), `status=${resp?.status()}`);

        // (2) 배지 적용 — 값이 있는 셀은 배지, 빈 값("-")은 배지 없음.
        for (const col of BADGE_COLUMNS) {
          const cells = r.badgeCells[col] ?? [];
          if (cells.length === 0) { console.log(`    · ${col}: 컬럼 없음/표본 0 (skip)`); continue; }
          const nonEmpty = cells.filter((c) => c.text && c.text !== "-" && c.text !== "—");
          const empty = cells.filter((c) => !c.text || c.text === "-" || c.text === "—");
          check(`${col} 배지 적용(${nonEmpty.length}셀)`, nonEmpty.every((c) => c.hasBadge),
            nonEmpty.filter((c) => !c.hasBadge).slice(0, 3).map((c) => c.text).join(",") || "all badged");
          check(`${col} 빈 값 배지 미적용(${empty.length}셀)`, empty.every((c) => !c.hasBadge));
          check(`${col} nowrap`, nonEmpty.every((c) => c.nowrap === "nowrap"),
            nonEmpty[0]?.nowrap ?? "n/a");
          // (3) 값→색 결정론 — 전역 대조표에 축적하며 충돌 검사.
          let conflict = null;
          for (const c of nonEmpty) {
            const sig = `${c.color}|${c.bg}`;
            const prev = valueColor[col].get(c.text);
            if (prev === undefined) valueColor[col].set(c.text, { sig, where: key });
            else if (prev.sig !== sig) conflict = `${c.text}: ${prev.where}=${prev.sig} vs ${key}=${sig}`;
          }
          check(`${col} 값→색 일관(누적 ${valueColor[col].size}값)`, !conflict, conflict ?? "");
        }

        // (4) 별/방패/번개 셀값 색.
        for (const [k, want] of [["a", "good"], ["b", "good"], ["c", "danger"]]) {
          const cells = r.pointCells[k] ?? [];
          if (cells.length === 0) { console.log(`    · ${pl[k]}: 컬럼 없음/표본 0 (skip)`); continue; }
          const expect = want === "good" ? tokens.good : tokens.danger;
          const bad = cells.filter((c) => c.color !== expect);
          check(`${pl[k]}(po.${k.toUpperCase()}) 셀값 ${want === "good" ? "초록" : "빨강"} (${cells.length}셀)`,
            bad.length === 0, bad.slice(0, 3).map((c) => `${c.text}=${c.color}`).join(",") || expect);
          const zeros = cells.filter((c) => c.text === "0");
          if (zeros.length) check(`${pl[k]} 0 값도 색 유지(${zeros.length}셀)`, zeros.every((c) => c.color === expect));
        }
        // 헤더는 포인트 색을 쓰지 않는다.
        const hdrBad = (r.headerPointColored ?? []).filter(
          (h) => h.color === tokens.good || h.color === tokens.danger,
        );
        if (r.headerPointColored?.length) {
          check("헤더/정렬 버튼에 포인트 색 미적용", hdrBad.length === 0,
            hdrBad.map((h) => `${h.label}=${h.color}`).join(",") || "ok");
        }
      }
    }
  }

  // (5) 일반 vs 테스트 — 같은 라우트/조직에서 컬럼 구성과 배지 적용 패턴이 동일한지.
  console.log("\n▸ 일반 모드 vs mode=test 렌더러 동일성");
  for (const route of ROUTES) {
    for (const org of ORGS) {
      const a = perRouteMode[`${route} | ${org} | 일반`];
      const b = perRouteMode[`${route} | ${org} | mode=test`];
      if (!a || !b) continue;
      // 한쪽이 "표시할 액트 0건"이면 그건 데이터 차이(모드별 대상자/주차)라 렌더러 비교 대상이 아니다.
      if (a.emptyState || b.emptyState) {
        console.log(`  · ${route}/${org} 표 미표시(일반=${a.tableCount} · test=${b.tableCount}) — 데이터 빈 상태, 렌더러 비교 skip`);
        continue;
      }
      check(`${route}/${org} 컬럼 구성 동일`,
        JSON.stringify(a.headers) === JSON.stringify(b.headers),
        `${a.headers.length} vs ${b.headers.length}`);
      for (const col of BADGE_COLUMNS) {
        const ra = (a.badgeCells[col] ?? []).filter((c) => c.text && c.text !== "-");
        const rb = (b.badgeCells[col] ?? []).filter((c) => c.text && c.text !== "-");
        if (ra.length === 0 && rb.length === 0) continue;
        check(`${route}/${org} ${col} 배지 적용률 동일`,
          ra.every((c) => c.hasBadge) === rb.every((c) => c.hasBadge));
      }
    }
  }

  // (6) DTO 키 동일성.
  console.log("\n▸ DTO 무변경(모드 간 키 동일)");
  const ka = [...dtoKeys.operating].sort();
  const kb = [...dtoKeys.test].sort();
  console.log(`  operating keys(${ka.length}): ${ka.join(",")}`);
  console.log(`  test keys(${kb.length}): ${kb.join(",")}`);
  if (ka.length && kb.length) check("두 모드 DTO 키 동일", JSON.stringify(ka) === JSON.stringify(kb));
  const badApi = apiStatus.filter((r) => r.status >= 400);
  check(`API 응답 정상(${apiStatus.length}건)`, badApi.length === 0,
    badApi.slice(0, 5).map((r) => `${r.status} ${r.url}`).join(" | ") || "all 2xx/3xx");

  const realErrors = consoleErrors.filter((e) => !/favicon|Download the React DevTools/i.test(e));
  check(`콘솔 에러 없음(${realErrors.length})`, realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

  await browser.close();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
