/**
 * /admin/season-weeks 신규 컬럼(experienceExpansionLineMode) HTTP 검증.
 *
 * 이 엔드포인트(GET /api/admin/season-weeks)는 mode/actAs/demo/snapshot 로 갈라지지 않는
 * 순수 시즌·주차 메타 데이터다(라우트가 loadSeasonWeeks() 단일 SoT 를 파라미터 없이 호출).
 * 따라서 아래 경로들은 "같은 DTO·같은 값"을 내려야 한다 — 그것을 실측으로 입증한다.
 *
 *   1) 일반           GET /api/admin/season-weeks
 *   2) mode=test      GET /api/admin/season-weeks?mode=test
 *   3) actAsTestUserId GET /api/admin/season-weeks?actAsTestUserId=<uuid>
 *   4) demoUserId     GET /api/admin/season-weeks?demoUserId=<uuid>
 *
 * 검증:
 *   · 모두 HTTP 200
 *   · 모든 행에 experienceExpansionLineMode 필드 존재 & ∈ {none,online,offline}
 *   · 4경로 rows 가 바이트 동일(같은 원천 → 같은 값, 테스트 모드 전용 DTO 없음)
 *   · direct(loadSeasonWeeks) == HTTP rows (SoT 일치)
 *   · 확장 기간 SoT(cluster4_experience_extension_periods)와 판정 정합
 *
 * 사전조건: admin dev :3000.
 * Usage: npx tsx --env-file=.env.local scripts/verify-season-weeks-expansion-line-http.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";

const adminBase = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const sb = createClient(
  ensureEnv("NEXT_PUBLIC_SUPABASE_URL"),
  ensureEnv("SUPABASE_SERVICE_ROLE_KEY"),
);

async function makeAdminCookieHeader(): Promise<string> {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const admin = createClient(supabaseUrl, ensureEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const browser = createClient(supabaseUrl, anonKey);
  const { data: linkData, error: linkError } =
    await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  if (linkError || !linkData?.properties?.email_otp)
    throw new Error(linkError?.message ?? "generateLink failed");
  const { data: verifyData, error: verifyError } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties.email_otp,
    type: "magiclink",
  });
  if (verifyError || !verifyData.session)
    throw new Error(verifyError?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) =>
        void captured.push(...items.map((i) => ({ name: i.name, value: i.value }))),
    },
  });
  const { error } = await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  if (error) throw new Error(error.message);
  return captured.map((c) => `${c.name}=${c.value}`).join("; ");
}

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
}

const MODES = new Set(["none", "online", "offline"]);

type Row = Record<string, unknown> & {
  week_id: string;
  week_start_date: string | null;
  week_end_date: string | null;
  experienceExpansionLineMode?: unknown;
};

async function fetchRows(cookie: string, query: string) {
  const url = `${adminBase}/api/admin/season-weeks${query}`;
  const res = await fetch(url, { headers: { cookie }, cache: "no-store" });
  const json = await res.json();
  return {
    url,
    status: res.status,
    ok: res.ok && json?.success === true,
    rows: (json?.data?.rows ?? []) as Row[],
  };
}

// 확장 기간 SoT 를 직접 조회해 기대값을 독립 계산(엔드포인트 판정과 교차검증).
async function expectedModeFor(
  start: string | null,
  end: string | null,
  periods: Array<{ extension_kind: string; start_date: string; end_date: string }>,
): Promise<string> {
  if (!start || !end) return "none";
  const m = periods.find((p) => p.start_date <= end && p.end_date >= start);
  return m ? m.extension_kind : "none";
}

async function main() {
  console.log("== /admin/season-weeks · experienceExpansionLineMode HTTP 검증 ==\n");
  const cookie = await makeAdminCookieHeader();

  // 테스트 유저 표본(actAs/demo 파라미터 실측용) — 없으면 임의 uuid 로도 무해(라우트가 무시).
  const { data: sampleUser } = await sb
    .from("test_user_markers")
    .select("user_id")
    .limit(1)
    .maybeSingle();
  const testUserId =
    (sampleUser as { user_id: string } | null)?.user_id ??
    "00000000-0000-0000-0000-000000000000";

  const normal = await fetchRows(cookie, "");
  const test = await fetchRows(cookie, "?mode=test");
  const actAs = await fetchRows(cookie, `?actAsTestUserId=${testUserId}`);
  const demo = await fetchRows(cookie, `?demoUserId=${testUserId}`);

  console.log(`  경로/상태코드:`);
  console.log(`    일반            ${normal.url} → ${normal.status}`);
  console.log(`    mode=test       ${test.url} → ${test.status}`);
  console.log(`    actAsTestUserId ${actAs.url} → ${actAs.status}`);
  console.log(`    demoUserId      ${demo.url} → ${demo.status}\n`);

  check("① 일반 200", normal.status === 200 && normal.ok);
  check("② mode=test 200", test.status === 200 && test.ok);
  check("③ actAsTestUserId 200", actAs.status === 200 && actAs.ok);
  check("④ demoUserId 200", demo.status === 200 && demo.ok);

  // 모든 행에 필드 존재 + union 값
  const badRows = normal.rows.filter(
    (r) => !MODES.has(String(r.experienceExpansionLineMode)),
  );
  check(
    "모든 행에 experienceExpansionLineMode ∈ {none,online,offline}",
    normal.rows.length > 0 && badRows.length === 0,
    `rows=${normal.rows.length}, invalid=${badRows.length}`,
  );

  // DTO 키 동일 + rows 바이트 동일(테스트 전용 DTO/기본값 없음)
  const keyEq = (a: Row[], b: Row[]) =>
    JSON.stringify(a) === JSON.stringify(b);
  check("일반 == mode=test (rows 동일)", keyEq(normal.rows, test.rows));
  check("일반 == actAsTestUserId (rows 동일)", keyEq(normal.rows, actAs.rows));
  check("일반 == demoUserId (rows 동일)", keyEq(normal.rows, demo.rows));

  // direct(loadSeasonWeeks) == HTTP (SoT 일치)
  const direct = await loadSeasonWeeks();
  const directByKey = new Map(direct.rows.map((r) => [r.week_id, r]));
  let directMismatch = 0;
  for (const r of normal.rows) {
    const d = directByKey.get(r.week_id);
    if (!d || d.experienceExpansionLineMode !== r.experienceExpansionLineMode)
      directMismatch++;
  }
  check(
    "direct(loadSeasonWeeks) == HTTP experienceExpansionLineMode",
    direct.rows.length === normal.rows.length && directMismatch === 0,
    `directRows=${direct.rows.length}, mismatch=${directMismatch}`,
  );

  // 확장 기간 SoT 교차검증(org 중립: organization_slug IS NULL 활성)
  const { data: periodData } = await sb
    .from("cluster4_experience_extension_periods")
    .select("extension_kind,start_date,end_date")
    .eq("is_active", true)
    .is("organization_slug", null);
  const periods = (periodData ?? []) as Array<{
    extension_kind: string;
    start_date: string;
    end_date: string;
  }>;
  let sotMismatch = 0;
  const nonNone: string[] = [];
  for (const r of normal.rows) {
    const expected = await expectedModeFor(
      r.week_start_date,
      r.week_end_date,
      periods,
    );
    if (String(r.experienceExpansionLineMode) !== expected) sotMismatch++;
    if (r.experienceExpansionLineMode !== "none")
      nonNone.push(
        `${r.week_start_date}~${r.week_end_date}=${r.experienceExpansionLineMode}`,
      );
  }
  check(
    "확장 기간 SoT 와 판정 정합",
    sotMismatch === 0,
    `periods=${periods.length}, mismatch=${sotMismatch}`,
  );
  console.log(
    `\n  확장 기간(org-null active): ${periods.length}건` +
      (periods.length
        ? ` → ${periods.map((p) => `${p.extension_kind}[${p.start_date}~${p.end_date}]`).join(", ")}`
        : " (테이블 미적용 시 0 — 전부 none 이 정상)"),
  );
  console.log(
    `  none 이외 주차: ${nonNone.length}건` +
      (nonNone.length ? ` → ${nonNone.slice(0, 8).join(", ")}` : ""),
  );

  console.log(`\n== 결과: ${pass} pass / ${fail} fail ==`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
