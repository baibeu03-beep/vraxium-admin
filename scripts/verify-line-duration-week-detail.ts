/**
 * 회원 주차 상세 > 라인 강화 내역 — 소요 시간 컬럼 HTTP + 브라우저 검증.
 *   npx tsx --env-file=.env.local scripts/verify-line-duration-week-detail.ts
 * 사전 조건: dev 서버(3000) 기동.
 *
 * ⚠ 실제 원장(common info 3행)에 duration 을 잠시 설정하고 finally 에서 **반드시 원복**한다.
 */
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// playwright 는 admin repo 에 없다 — 기존 browser-verify-*.mjs 와 동일하게 front repo(../vraxium)
//   의 playwright 를 빌려 쓴다(이 저장소의 확립된 관례).
const adminRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright") as {
  chromium: typeof import("playwright-core").chromium;
};

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(n: string) {
  const v = process.env[n];
  if (!v) throw new Error(`Missing env: ${n}`);
  return v;
}
const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
const serviceKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");
const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (ok) pass++;
  else fail++;
}

// (act, duration) fixture — 원복용 이전값 보관.
const FIXTURE: Array<{ act: string; dur: number }> = [
  { act: "wisdom", dur: 30 },
  { act: "essay", dur: 60 },
  { act: "calendar", dur: 120 },
];
const restore: Array<{ id: string; prev: number | null }> = [];

async function makeAdminCookiePairs() {
  const admin = createClient(supabaseUrl, serviceKey);
  const browser = createClient(supabaseUrl, anonKey);
  const { data: l, error: le } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  if (le || !l?.properties?.email_otp) throw new Error(le?.message ?? "generateLink failed");
  const { data: v, error: ve } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: l.properties.email_otp,
    type: "magiclink",
  });
  if (ve || !v.session) throw new Error(ve?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items.map((i) => ({ name: i.name, value: i.value }))) },
  });
  const { error: se } = await server.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
  });
  if (se) throw new Error(se.message);
  return captured;
}

type Row = { lineName?: string; type?: string | null; estimatedDurationMinutes?: unknown };

async function main() {
  // ── fixture: common info 3행에 duration 설정 ──
  for (const f of FIXTURE) {
    const { data } = await sb
      .from("line_registrations")
      .select("id,estimated_duration_minutes")
      .eq("hub", "info")
      .eq("point_activity_type_id", f.act)
      .eq("organization_slug", "common")
      .maybeSingle();
    if (!data) continue;
    restore.push({ id: data.id, prev: data.estimated_duration_minutes });
    await sb.from("line_registrations").update({ estimated_duration_minutes: f.dur }).eq("id", data.id);
  }
  console.log(`fixture: ${FIXTURE.map((f) => `${f.act}=${f.dur}`).join(" · ")}\n`);

  const pairs = await makeAdminCookiePairs();
  const cookieHeader = pairs.map((i) => `${i.name}=${i.value}`).join("; ");

  // 라인이 배정된 (user, week) 찾기.
  //   ⚠ 대상은 반드시 test_user_markers 등재 유저여야 한다 — lib/qaFixedScope.QA_HIDE_REAL_USERS 가
  //     전달 mode 와 무관하게 모집단을 test 로 고정하므로(userScope.ts:78), 실사용자를 쓰면 422 다.
  //     이건 이 코드베이스의 현재 QA 상태이자 의도된 설계다(버그 아님).
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testIds = (markers ?? []).map((m) => (m as { user_id: string }).user_id);
  if (!testIds.length) throw new Error("test_user_markers 가 비어 검증 불가");
  const { data: tgt } = await sb
    .from("cluster4_line_targets")
    .select("target_user_id,week_id")
    .in("target_user_id", testIds.slice(0, 150))
    .limit(1)
    .maybeSingle();
  if (!tgt) throw new Error("테스트 유저의 라인 대상자 행이 없어 검증 불가");
  const userId = tgt.target_user_id as string;
  const weekId = tgt.week_id as string;
  console.log(`대상(test user): userId=${userId} weekId=${weekId}\n`);

  // ── 1) HTTP — DTO 에 값이 실리는가 ──
  console.log("=== 1) HTTP: /api/admin/members/[user_id]/weeks/[week_id]/lines ===");
  const api = async (qs: string) => {
    const res = await fetch(`${baseUrl}/api/admin/members/${userId}/weeks/${weekId}/lines${qs}`, {
      headers: { Cookie: cookieHeader },
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const r = await api("");
  check("HTTP 200", r.status === 200, `status=${r.status} ${String(r.json.error ?? "").slice(0, 80)}`);
  const rows = ((r.json as { data?: { lineDetails?: Row[] } }).data?.lineDetails ?? []) as Row[];
  check("라인 행 존재", rows.length > 0, `rows=${rows.length}`);
  check("모든 행에 estimatedDurationMinutes 키 존재", rows.every((x) => "estimatedDurationMinutes" in x));
  check(
    "값이 30|60|90|120|null 만",
    rows.every((x) => x.estimatedDurationMinutes === null || [30, 60, 90, 120].includes(x.estimatedDurationMinutes as number)),
  );
  const withValue = rows.filter((x) => x.estimatedDurationMinutes !== null);
  check("fixture 값이 실제로 실림(30/60/120 중 존재)", withValue.length > 0, `설정된 행 ${withValue.length}건`);
  const nullRows = rows.filter((x) => x.estimatedDurationMinutes === null);
  check("미설정 라인은 null 로 내려옴", nullRows.length > 0, `null 행 ${nullRows.length}건`);

  // ── 2) 경로 동일성 ──
  console.log("\n=== 2) 일반 / mode=test / actAsTestUserId / demoUserId 동일성 ===");
  const sig = (rs: Row[]) => JSON.stringify(rs.map((x) => [x.lineName, x.estimatedDurationMinutes, typeof x.estimatedDurationMinutes]));
  const base = sig(rows);
  for (const [label, qs] of [
    ["mode=test", "?mode=test"],
    ["actAsTestUserId", "?actAsTestUserId=00000000-0000-0000-0000-000000000001"],
    ["demoUserId", "?demoUserId=00000000-0000-0000-0000-000000000002"],
  ] as const) {
    const v = await api(qs);
    const vr = ((v.json as { data?: { lineDetails?: Row[] } }).data?.lineDetails ?? []) as Row[];
    check(`${label}: status 동일(${r.status})`, v.status === r.status, `got=${v.status}`);
    check(`${label}: DTO key/값/타입 동일`, sig(vr) === base);
  }

  // ── 3) 브라우저 렌더 ──
  console.log("\n=== 3) 브라우저 렌더 (라인 강화 내역 탭) ===");
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addCookies(
      pairs.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" })),
    );
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}/admin/members/${userId}/weeks/${weekId}?tab=lines`, {
      waitUntil: "networkidle",
      timeout: 60000,
    });
    await page.waitForTimeout(2500);

    const headers = await page.locator("th").allInnerTexts();
    check("표 헤더에 '소요 시간' 존재", headers.some((h) => h.includes("소요 시간")), headers.join(" | ").slice(0, 140));

    const body = await page.locator("body").innerText();
    const hasFormatted = /\b(0\.5|1|1\.5|2) h\b/.test(body);
    check("포맷된 값(0.5 h / 1 h / 1.5 h / 2 h)이 화면에 렌더", hasFormatted);

    // 헤더 수 == 첫 바디 행 셀 수 (컬럼 정렬 깨짐 방지)
    const firstTable = page.locator("table").first();
    const thCount = await firstTable.locator("thead th").count();
    const tdCount = await firstTable.locator("tbody tr").first().locator("td").count();
    check("헤더/바디 셀 수 일치(정렬 안 깨짐)", thCount === tdCount, `th=${thCount} td=${tdCount}`);

    // 라인명 컬럼이 과도하게 좁아지지 않았는지 — 실폭 확인
    const nameW = await firstTable.locator("thead th").nth(1).evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
    check("라인명 컬럼 폭 >= 200px (과도 축소 아님)", nameW >= 200, `${Math.round(nameW)}px`);

    // 데스크톱 폭에서 표 자체를 캡처(눈으로 확인용) — 첫 허브 그룹 표.
    await firstTable.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await firstTable.screenshot({ path: "scratchpad-line-duration-table.png" });
    console.log("  · 표 스크린샷: scratchpad-line-duration-table.png");

    // 가로 스크롤: 좁은 폭에서 body 가 아니라 표 컨테이너가 스크롤해야 한다
    await page.setViewportSize({ width: 768, height: 900 });
    await page.waitForTimeout(600);
    const bodyOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    check("좁은 폭(768px)에서 페이지 가로 스크롤 없음(표 컨테이너가 스크롤)", !bodyOverflow);
  } finally {
    await browser.close();
  }

  console.log(`\n결과: pass=${pass} fail=${fail}`);
}

main()
  .catch((e) => {
    console.error(e);
    fail++;
  })
  .finally(async () => {
    for (const rr of restore) {
      await sb.from("line_registrations").update({ estimated_duration_minutes: rr.prev }).eq("id", rr.id);
    }
    console.log(`· 원장 ${restore.length}행 duration 원복 완료`);
    process.exit(fail > 0 ? 1 : 0);
  });
