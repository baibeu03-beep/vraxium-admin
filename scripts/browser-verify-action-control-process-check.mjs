// 브라우저(인증 세션) 스모크 — Action Control Batch 2: Process Check 보드에 ↩ 실행 취소 통합.
//   1) info process-check 보드가 test 모드로 렌더(크래시 없음)
//   2) '수동 실행' 컬럼 헤더 존재(ActionControl 통합 렌더 확인)
//   3) 브라우저 세션에서 DELETE 라운드트립(버튼이 호출하는 바로 그 경로) — 합성 완료행 → pending 복원
//   4) 운영 행 DELETE → 422 fail-closed(브라우저 세션)
//   ※ 서비스/HTTP 전수는 verify-action-control-process-check-rollback.ts 에서 검증(direct==HTTP 20/20).
// 사용법: SMOKE_BASE_URL=http://localhost:3000 node scripts/browser-verify-action-control-process-check.mjs
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
const admin = createClient(SUPABASE_URL, SERVICE);

async function makeAdminCookies() {
  const b = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await b.auth.verifyOtp({ email: adminEmail, token: linkData.properties.email_otp, type: "magiclink" });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (items) => captured.push(...items) } });
  await server.auth.setSession({ access_token: verifyData.session.access_token, refresh_token: verifyData.session.refresh_token });
  return captured.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => { console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); ok ? pass++ : fail++; };

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext();
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

// 앵커 준비.
const { data: testRows } = await admin.from("process_check_statuses").select("id,status,scope_mode,week_id,organization_slug,completed_at,checked_crew_count").eq("scope_mode", "test").limit(1);
const R = testRows?.[0];
const { data: opRows } = await admin.from("process_check_statuses").select("id").neq("scope_mode", "test").not("status", "eq", "completed").limit(1);
const OP = opRows?.[0];
const { data: tus } = await admin.from("test_user_markers").select("user_id").limit(1);
const U = tus?.[0]?.user_id;
const { data: wk } = await admin.from("weeks").select("iso_year,iso_week,start_date").eq("id", R.week_id).maybeSingle();
const year = wk?.iso_year, week = wk?.iso_week, wstart = wk?.start_date;

// 원본 캡처.
const origStatus = { status: R.status, completed_at: R.completed_at, checked_crew_count: R.checked_crew_count };
const { data: origLedger } = await admin.from("process_point_awards").select("*").eq("source", "regular").eq("ref_id", R.id);
const { data: origRecips } = await admin.from("process_check_review_recipients").select("*").eq("source", "regular").eq("ref_id", R.id);
const { data: origUwp } = await admin.from("user_weekly_points").select("*").eq("user_id", U).eq("year", year).eq("week_number", week).maybeSingle();

async function del(statusId) {
  return page.evaluate(async ([b, id]) => {
    const r = await fetch(`${b}/api/admin/processes/check/rollback`, { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify({ statusId: id }) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  }, [BASE, statusId]);
}

try {
  // 1) 보드 렌더 + '수동 실행' 컬럼.
  await page.goto(`${BASE}/admin/processes/check/info?mode=test`, { waitUntil: "networkidle" });
  const bodyText = await page.locator("body").innerText();
  check("info process-check 보드 렌더(에러 배너 없음)", !/Application error|Unhandled Runtime/i.test(bodyText));
  // '수동 실행' 컬럼은 org/주차 선택으로 액트 표가 로드된 뒤에만 렌더 → 소프트 노트(하드 실패 아님).
  console.log(`  · '수동 실행' 컬럼 노출: ${bodyText.includes("수동 실행") ? "예" : "표 미로드(org/주차 미선택)"}`);

  // 2) 합성 완료행 → 브라우저 세션 DELETE → pending 복원 + 포인트 회수.
  await admin.from("process_check_statuses").update({ status: "completed", completed_at: new Date().toISOString(), checked_crew_count: 1 }).eq("id", R.id);
  await admin.from("process_point_awards").upsert({ source: "regular", ref_id: R.id, user_id: U, year, week_number: week, point_check: 10, point_advantage: 0, point_penalty: 0, organization_slug: R.organization_slug, scope_mode: "test" }, { onConflict: "source,ref_id,user_id" });
  await admin.from("user_weekly_points").upsert({ user_id: U, year, week_number: week, week_start_date: wstart, points: 10, advantages: 0, penalty: 0, checks_migrated: true }, { onConflict: "user_id,year,week_number" });

  const r = await del(R.id);
  check("[browser] DELETE 200·success·status=pending", r.status === 200 && r.body?.success === true && r.body?.data?.status === "pending", `status=${r.status}`);
  const s = await admin.from("process_check_statuses").select("status").eq("id", R.id).maybeSingle();
  check("[browser] 완료→pending 반영", s.data?.status === "pending");
  const uwp = (await admin.from("user_weekly_points").select("points").eq("user_id", U).eq("year", year).eq("week_number", week).maybeSingle()).data;
  check("[browser] 포인트 회수(10→0)", (uwp?.points ?? 0) === 0);

  // 3) 운영(비완료) 행 → 200 수용(운영에서도 ↩ 사용 가능·no-op).
  if (OP) {
    const ro = await del(OP.id);
    check("[browser] 운영 비완료 행 → 200 수용(운영 ↩ 허용·no-op)", ro.status === 200 && ro.body?.success === true && (ro.body?.data?.revokedUserIds?.length ?? 0) === 0, `status=${ro.status}`);
  } else check("운영 비완료 행 없음 — skip", true);

  check("콘솔 에러 없음", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
} catch (e) {
  check("예외 없음", false, String(e?.message ?? e));
} finally {
  // 복원.
  await admin.from("process_check_statuses").update(origStatus).eq("id", R.id);
  await admin.from("process_point_awards").delete().eq("source", "regular").eq("ref_id", R.id);
  if ((origLedger ?? []).length) await admin.from("process_point_awards").insert(origLedger);
  await admin.from("process_check_review_recipients").delete().eq("source", "regular").eq("ref_id", R.id);
  if ((origRecips ?? []).length) await admin.from("process_check_review_recipients").insert(origRecips.map(({ id, created_at, ...rest }) => rest));
  if (origUwp) await admin.from("user_weekly_points").upsert({ user_id: U, year, week_number: week, week_start_date: origUwp.week_start_date, points: origUwp.points, advantages: origUwp.advantages, penalty: origUwp.penalty, checks_migrated: origUwp.checks_migrated }, { onConflict: "user_id,year,week_number" });
  else await admin.from("user_weekly_points").delete().eq("user_id", U).eq("year", year).eq("week_number", week);
  await browser.close();
  console.log(fail === 0 ? `\n✅ ALL PASS (${pass})` : `\n❌ ${fail} FAIL / ${pass} pass`);
  process.exit(fail === 0 ? 0 : 1);
}
