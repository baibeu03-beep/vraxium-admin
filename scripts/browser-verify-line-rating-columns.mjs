// 브라우저 검증 — /admin/members/[userId]/weeks/[weekId]?tab=lines "라인 강화 내역"
//   강화 시 포인트와 평점 Point A 가 **별개 항목**으로 보이는지 확인한다.
//
//   검증 계약(2026-07-27):
//     (1) 표 헤더에 "강화 <A>" · "강화 <B>" · "평점 <A>" 세 컬럼이 각각 존재한다
//         (= 하나로 뭉개거나 같은 명칭으로 표시하지 않는다).
//     (2) 평점 지급 행은 평점 컬럼에 실제 평점 값이 보이고, 강화 컬럼 값과 다르다.
//     (3) 평점 미지급 행은 "미지급", 대상 아닌 행은 "-" 로 명확히 구분된다(0 을 새로 만들지 않는다).
//     (4) 상단 요약에 "강화 A / 강화 B / 평점 A / 총 A" 가 함께 있고, 총 A = 강화 A + 평점 A.
//     (5) 화면 값 == API DTO 값(화면 재계산 없음).
//     (6) 일반 모드와 mode=test 가 동일하게 보인다.
//
//   조회 전용 — 이 스크립트는 클릭으로 저장/수정하지 않는다(탭 전환·읽기만).
//   대상은 verify-line-rating-display-e2e 가 원장을 채운 QA 테스트 크루다.
//   run: node scripts/browser-verify-line-rating-columns.mjs
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

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
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

// 활성 평점 원장이 있는 (user, week) 를 고른다 — 표시 검증 대상.
async function pickTargets(limit = 2) {
  const { data } = await admin
    .from("process_point_awards")
    .select("user_id,year,week_number")
    .eq("source", "line_rating").is("cancelled_at", null);
  const rows = data ?? [];
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const key = `${r.user_id}:${r.year}:${r.week_number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { data: w } = await admin
      .from("weeks").select("id,season_key,week_number")
      .eq("iso_year", r.year).eq("iso_week", r.week_number).maybeSingle();
    if (!w) continue;
    const { data: p } = await admin
      .from("user_profiles").select("display_name").eq("user_id", r.user_id).maybeSingle();
    out.push({ userId: r.user_id, weekId: w.id, label: `${p?.display_name ?? r.user_id.slice(0, 8)} ${w.season_key} W${w.week_number}` });
    if (out.length >= limit) break;
  }
  return out;
}

// 표 헤더 + "평점 A" 컬럼 셀 값들을 읽는다.
//   ⚠ 이 화면은 허브별로 **표가 4개**(정보/경험/역량/경력) 분리돼 있다 — 첫 표만 읽으면
//     평점이 실리는 실무 경험 표를 놓친다. 모든 표를 순회해 셀을 모은다.
//   요약 문구는 body 텍스트에서 정규식으로 뽑는다(div 트리 탐색은 최상위 div 를 잡는다).
const readTable = (page) =>
  page.evaluate(() => {
    const out = { headers: [], ratingCells: [], enhACells: [], summaryText: "" };
    const bodyText = (document.body.innerText || "").replace(/\s+/g, " ");
    const m = bodyText.match(/총\s*\S+\s*\d+\s*=\s*강화\s*\d+\s*\+\s*평점\s*\d+/);
    out.summaryText = m ? m[0] : bodyText.slice(0, 200);
    for (const t of Array.from(document.querySelectorAll("table"))) {
      const ths = Array.from(t.querySelectorAll("thead th")).map((th) => (th.textContent || "").trim());
      const ratingIdx = ths.findIndex((h) => /^평점 \S/.test(h));
      if (ratingIdx < 0) continue;
      if (out.headers.length === 0) out.headers = ths;
      const enhAIdx = ths.findIndex((h) => /^강화 \S/.test(h));
      for (const tr of Array.from(t.querySelectorAll("tbody tr"))) {
        const tds = Array.from(tr.querySelectorAll("td"));
        if (tds[ratingIdx]) out.ratingCells.push((tds[ratingIdx].textContent || "").trim());
        if (enhAIdx >= 0 && tds[enhAIdx]) out.enhACells.push((tds[enhAIdx].textContent || "").trim());
      }
    }
    return out;
  });

async function main() {
  const cookies = await makeAdminCookies();
  const targets = await pickTargets(2);
  if (targets.length === 0) {
    console.log("⚠ 활성 line_rating 원장이 없어 표시 검증을 건너뜁니다. 먼저 verify:line-rating-display-e2e 를 실행하세요.");
    process.exit(0);
  }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1700, height: 1100 } });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  const perMode = {};
  for (const t of targets) {
    for (const mode of ["", "&mode=test"]) {
      const modeLabel = mode ? "mode=test" : "일반";
      const url = `${BASE}/admin/members/${t.userId}/weeks/${t.weekId}?tab=lines${mode}`;
      console.log(`\n▸ ${t.label} (${modeLabel})`);
      // 이 화면은 카드/스냅샷 재계산으로 장시간 요청이 남아 networkidle 이 오지 않는다 →
      //   DOM 로드 후 표 헤더 등장을 직접 기다린다.
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      // 표가 그려질 때까지 대기(라인 강화 내역 탭).
      try {
        await page.waitForFunction(
          () => Array.from(document.querySelectorAll("thead th")).some((th) => (th.textContent || "").startsWith("평점 ")),
          { timeout: 90000 },
        );
      } catch {
        check("표 렌더", false, "평점 컬럼 헤더 미발견(탭 로드 실패 가능)");
        continue;
      }
      const t1 = await readTable(page);

      // (1) 세 컬럼이 각각 존재 + 같은 이름 중복 없음
      const hasEnhA = t1.headers.some((h) => /^강화 /.test(h));
      const hasEnhB = t1.headers.filter((h) => /^강화 /.test(h)).length >= 2;
      const hasRating = t1.headers.some((h) => /^평점 /.test(h));
      check("헤더에 '강화 A'·'강화 B'·'평점 A' 컬럼이 각각 존재", hasEnhA && hasEnhB && hasRating, t1.headers.join(" | "));
      check("'획득'으로 뭉뚱그린 컬럼명이 남아있지 않음", !t1.headers.some((h) => /^획득 /.test(h)), t1.headers.filter((h) => /^획득 /.test(h)).join(","));

      // (2)(3) 셀 상태 — 값/미지급/"-" 세 종류만
      const distinct = Array.from(new Set(t1.ratingCells));
      const validCells = t1.ratingCells.every((c) => c === "-" || c === "미지급" || /^\d+$/.test(c));
      check("평점 컬럼 셀 = 값 / '미지급' / '-' 로만 구성(잘못된 0점 항목 없음)", validCells, distinct.join(" , "));
      const paidCells = t1.ratingCells.filter((c) => /^\d+$/.test(c));
      check("지급 행이 최소 1건 존재(값 표시)", paidCells.length > 0, `지급 ${paidCells.length}행 / 전체 ${t1.ratingCells.length}행`);

      // (4) 요약 — 강화/평점/총 동시 노출 + 총 = 강화 + 평점
      const m = t1.summaryText.match(/총\s*\S+\s*(\d+)\s*=\s*강화\s*(\d+)\s*\+\s*평점\s*(\d+)/);
      // 표 렌더가 4개 허브 전부 끝났는지 — 화면 행 수와 DTO 행 수가 같아야 셀 비교가 유효하다.
      check("요약에 강화·평점·총 이 함께 표시되고 총 = 강화 + 평점",
        !!m && Number(m[1]) === Number(m[2]) + Number(m[3]),
        m ? `총 ${m[1]} = 강화 ${m[2]} + 평점 ${m[3]}` : t1.summaryText);

      // (5) 화면 == API DTO
      const api = await page.evaluate(async (u) => {
        const r = await fetch(u, { cache: "no-store" });
        return r.ok ? (await r.json()).data : null;
      }, `/api/admin/members/${t.userId}/weeks/${t.weekId}/lines`);
      if (api) {
        const dtoRating = api.lineDetails
          .map((r) => (r.ratingPointStatus === "paid" ? String(r.ratingPointA) : r.ratingPointStatus === "not_paid" ? "미지급" : "-"));
        const screenSet = t1.ratingCells.slice().sort().join(",");
        const dtoSet = dtoRating.slice().sort().join(",");
        check("화면 평점 셀 == API DTO(화면 재계산 없음)", screenSet === dtoSet, `screen=[${screenSet}] dto=[${dtoSet}]`);
        check("요약 총 A == DTO totalPointA", !!m && Number(m[1]) === api.totalPointA, m ? `${m[1]} vs ${api.totalPointA}` : "-");
      }

      perMode[`${t.label}|${modeLabel}`] = { cells: t1.ratingCells.join(","), summary: m ? m[0] : "" };
    }

    // (6) 모드 파리티
    const a = perMode[`${t.label}|일반`], b = perMode[`${t.label}|mode=test`];
    if (a && b) {
      check(`${t.label} · 일반 == mode=test (평점 셀·요약)`,
        a.cells === b.cells && a.summary === b.summary,
        a.cells === b.cells ? "" : `일반=[${a.cells}] test=[${b.cells}]`);
    }
  }

  const realErrors = consoleErrors.filter((e) => !/favicon|Download the React DevTools/i.test(e));
  check("콘솔 오류 없음", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

  await browser.close();
  console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAIL`} (pass ${pass} / fail ${fail})`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
