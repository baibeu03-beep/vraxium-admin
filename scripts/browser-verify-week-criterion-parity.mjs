// 브라우저(인증 세션) 검증 — 같은 조직·같은 주차에서 세 화면의 기준값이 일치하는가.
//
//   ① /admin/team-parts/info/weeks/[weekId]?club=<org>            [data-week-recognition-count]
//   ② /admin/team-parts/info/crew-week-results/<org>/[weekId]     [data-criterion-point-a]
//   ③ 크루 페이지(주차 카드) 기준값 = 위 두 값과 동일한 원천(cluster4_week_opening_configs
//      .recognition_count_n) — 화면 대신 크루 카드 DTO(experienceGrowth.checkGate.required)로 확인한다.
//
//   일반 모드 / mode=test 양쪽, 조직별 전 대상 주차를 순회한다.
//   기대: 세 값 == DB latch. [data-week-recognition-pending] 은 "재확인 시 값"(보조 안내)이라
//         기준값과 달라도 실패가 아니다(오히려 확정값과 다를 때만 노출된다).
//
// 사용법: node scripts/browser-verify-week-criterion-parity.mjs
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
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const admin = createClient(SUPABASE_URL, get("SUPABASE_SERVICE_ROLE_KEY"));

async function makeAdminCookies() {
  const { data: adm } = await admin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? adm?.[0]?.email;
  const b = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await b.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties.email_otp,
    type: "magiclink",
  });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  console.log(`admin = ${adminEmail}`);
  return captured.map((i) => ({
    name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax",
  }));
}

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const num = (t) => {
  if (t == null) return null;
  const m = String(t).replace(/[, ]/g, "").match(/-?\d+/);
  return m ? Number(m[0]) : null;
};

async function readAttr(page, selector, timeoutMs = 25000) {
  try {
    await page.waitForSelector(selector, { timeout: timeoutMs });
  } catch {
    return { found: false, text: null, pending: null };
  }
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const pend = document.querySelector("[data-week-recognition-pending]");
    return {
      found: !!el,
      text: el?.textContent?.trim() ?? null,
      pending: pend ? pend.getAttribute("data-week-recognition-pending") : null,
    };
  }, selector);
}

async function main() {
  const cookies = await makeAdminCookies();

  const { data: cfg } = await admin
    .from("cluster4_week_opening_configs")
    .select("week_id, organization_slug, recognition_count_n")
    .eq("open_confirmed", true)
    .not("recognition_count_n", "is", null);
  const targets = (cfg ?? []).filter((r) => ["encre", "oranke", "phalanx"].includes(r.organization_slug));
  const { data: wk } = await admin
    .from("weeks")
    .select("id, season_key, week_number")
    .in("id", [...new Set(targets.map((t) => t.week_id))]);
  const label = new Map((wk ?? []).map((w) => [w.id, `${w.season_key} W${w.week_number}`]));

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  for (const t of targets) {
    const org = t.organization_slug;
    const weekId = t.week_id;
    const db = t.recognition_count_n;
    const name = `${org} ${label.get(weekId) ?? weekId}`;

    for (const mode of ["operating", "test"]) {
      const q = mode === "test" ? "&mode=test" : "";
      console.log(`\n[${name}][${mode}] DB latch = ${db}`);

      // ① 활동 관리 상세 — 이번 주 활동 인정 개수
      await page.goto(`${BASE}/admin/team-parts/info/weeks/${weekId}?club=${org}${q}`, {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      });
      const a = await readAttr(page, "[data-week-recognition-count]", 90000);
      // 라이브 미리보기(300ms 디바운스)가 도착한 뒤에도 확정값이 유지되는지 본다.
      await page.waitForTimeout(2500);
      const a2 = await readAttr(page, "[data-week-recognition-count]", 5000);
      check(`① 이번 주 활동 인정 개수 == DB`, num(a.text) === db, `화면=${a.text} db=${db}`);
      check(`① 미리보기 도착 후에도 확정값 유지`, num(a2.text) === db, `화면=${a2.text} db=${db}`);
      if (a2.pending != null) {
        console.log(`     ℹ 보조 안내(재확인 시 값) = ${a2.pending} (기준값 아님)`);
      }

      // ② 주차 결과(크루) — 주차 성장 성공 별 기준
      const qs = mode === "test" ? "?mode=test" : "";
      await page.goto(
        `${BASE}/admin/team-parts/info/crew-week-results/${org}/${weekId}${qs}`,
        { waitUntil: "domcontentloaded", timeout: 90000 },
      );
      // 셀(투영 번들)이 비동기로 도착하기 전에는 "-" 다 → 숫자가 찍힐 때까지 기다린다.
      await page
        .waitForFunction(
          () => {
            const el = document.querySelector("[data-criterion-point-a]");
            return !!el && /\d/.test(el.textContent ?? "");
          },
          { timeout: 90000 },
        )
        .catch(() => {});
      const b = await readAttr(page, "[data-criterion-point-a]", 5000);
      check(`② 주차 성장 성공 별 기준 == DB`, num(b.text) === db, `화면=${b.text} db=${db}`);

      check(`①==② (같은 조직·같은 주차)`, num(a.text) === num(b.text), `${a.text} vs ${b.text}`);
    }

    // ③ 크루 페이지 기준값 — 크루 카드 DTO(같은 원천)
    const { data: uws } = await admin
      .from("user_week_statuses")
      .select("user_id")
      .limit(200);
    const ids = [...new Set((uws ?? []).map((r) => r.user_id))];
    const { data: profs } = await admin
      .from("user_profiles")
      .select("user_id")
      .eq("organization_slug", org)
      .in("user_id", ids.slice(0, 200))
      .limit(4);
    let seen = false;
    for (const p of profs ?? []) {
      const r = await page.evaluate(
        async (uid) => {
          const res = await fetch(`/api/admin/crews/${uid}/cluster4/weekly-growth`, { cache: "no-store" });
          return { status: res.status, json: await res.json().catch(() => null) };
        },
        p.user_id,
      );
      const card = (r.json?.data?.weeklyCards ?? []).find((c) => c.weekId === weekId);
      const req = card?.experienceGrowth?.checkGate?.required ?? null;
      if (req == null) continue;
      check(`③ 크루 페이지 기준값 == DB`, req === db, `crew=${p.user_id} required=${req} db=${db}`);
      seen = true;
      break;
    }
    if (!seen) console.log(`     ℹ [${name}] 표본 크루에 이 주차 기준 게이트 없음(검수 전 주차 등).`);
  }

  await browser.close();
  const noisy = consoleErrors.filter((e) => !/favicon|Download the React DevTools/i.test(e));
  check("콘솔 오류 0", noisy.length === 0, noisy.slice(0, 3).join(" | "));
  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"} — pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
