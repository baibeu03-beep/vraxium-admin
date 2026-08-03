/**
 * "해당 시기" 반기 기능 — 실제 HTTP 검증(가동 중 dev :3000). READ-ONLY.
 *   Usage: npx tsx --env-file=.env.local scripts/verify-half-period-http.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ORGANIZATIONS } from "@/lib/organizations";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let fail = 0;
const ck = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

async function cookieHeader(): Promise<string> {
  const { data: admins } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const email = (admins?.[0] as { email: string } | undefined)?.email;
  assert(email, "활성 admin_users 이메일 없음");
  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  assert(link.properties?.email_otp, "generateLink 실패");
  const { data: verified } = await anon.auth.verifyOtp({
    email,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  assert(verified.session, "verifyOtp 실패");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) => captured.push(...items.map(({ name, value }) => ({ name, value }))),
    },
  });
  await server.auth.setSession({
    access_token: verified.session.access_token,
    refresh_token: verified.session.refresh_token,
  });
  return captured.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function getSummary(cookie: string, params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${baseUrl}/api/admin/team-parts/info/summary${qs ? `?${qs}` : ""}`, {
    headers: { cookie },
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function getInfo(cookie: string, params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${baseUrl}/api/admin/team-parts/info?${qs}`, { headers: { cookie } });
  const json = await res.json();
  return { status: res.status, json };
}

const PERIOD_META_KEYS = [
  "period", "periodLabel", "periodStart", "periodEndExclusive", "asOfDate",
  "asOfWeekId", "asOfWeekStart", "seasonKey", "seasonLabel", "seasonYear",
  "weekNumber", "weekLabel", "isCurrentHalf", "rosterSource", "structureSource",
].sort();

async function main() {
  const cookie = await cookieHeader();

  // ── 1) period 미지정 → 현재 반기(2026-H2)로 해석 ──
  console.log("\n[1. period 미지정]");
  {
    const { status, json } = await getSummary(cookie, {});
    ck("HTTP 200", status === 200);
    ck("period.isCurrentHalf === true", json?.data?.period?.isCurrentHalf === true);
    ck("period.period === 2026-H2", json?.data?.period?.period === "2026-H2");
    ck("rosterSource/structureSource === live",
      json?.data?.period?.rosterSource === "live" && json?.data?.period?.structureSource === "live");
  }

  // ── 2) 명시적 2026-H2(현재) — 미지정과 완전히 같은 결과 ──
  console.log("\n[2. period=2026-H2 (명시적 현재)]");
  {
    const noParam = await getSummary(cookie, {});
    const explicit = await getSummary(cookie, { period: "2026-H2" });
    ck("period 미지정 == period=2026-H2 (byte-identical)",
      JSON.stringify(noParam.json.data) === JSON.stringify(explicit.json.data));
  }

  // ── 3) 과거 반기들 — DTO 메타 + null/숫자 정합 ──
  const CASES: Array<{ period: string; expectRoster: string; expectStruct: string }> = [
    { period: "2022-H1", expectRoster: "unavailable", expectStruct: "unavailable" },
    { period: "2024-H2", expectRoster: "position_history", expectStruct: "position_history" },
    { period: "2026-H1", expectRoster: "position_history", expectStruct: "position_history" },
  ];
  for (const c of CASES) {
    console.log(`\n[3. period=${c.period}]`);
    const { status, json } = await getSummary(cookie, { period: c.period });
    ck("HTTP 200", status === 200, `status=${status}`);
    const meta = json?.data?.period;
    ck("period 메타 키 완전 일치", JSON.stringify(Object.keys(meta ?? {}).sort()) === JSON.stringify(PERIOD_META_KEYS),
      JSON.stringify(Object.keys(meta ?? {}).sort()));
    ck(`rosterSource === ${c.expectRoster}`, meta?.rosterSource === c.expectRoster, meta?.rosterSource);
    ck(`structureSource === ${c.expectStruct}`, meta?.structureSource === c.expectStruct, meta?.structureSource);
    ck("isCurrentHalf === false", meta?.isCurrentHalf === false);
    const rows = json?.data?.rows ?? [];
    ck("행 수 == 조직 수", rows.length === ORGANIZATIONS.length);
    for (const r of rows) {
      const staffType = c.expectRoster === "unavailable" ? "null" : "number";
      const actualType = r.staffCount === null ? "null" : typeof r.staffCount;
      ck(`${r.clubId}.staffCount 타입=${staffType}`, actualType === staffType, `실제=${actualType}(${r.staffCount})`);
      const partType = c.expectStruct === "unavailable" ? "null" : "number";
      const actualPartType = r.partCount === null ? "null" : typeof r.partCount;
      ck(`${r.clubId}.partCount 타입=${partType}`, actualPartType === partType, `실제=${actualPartType}(${r.partCount})`);
    }
  }

  // ── 4) 잘못된 period 값 → 400 이 아니라 현재 반기로 안전 보정 ──
  console.log("\n[4. 잘못된 period 값 보정]");
  {
    const { status, json } = await getSummary(cookie, { period: "garbage-value" });
    ck("HTTP 200(400 아님)", status === 200, `status=${status}`);
    ck("현재 반기로 보정됨", json?.data?.period?.period === "2026-H2", json?.data?.period?.period);
  }
  {
    const { status, json } = await getSummary(cookie, { period: "2099-H1" }); // 옵션 10개 밖
    ck("범위 밖 값도 200 + 현재 반기 보정", status === 200 && json?.data?.period?.period === "2026-H2");
  }

  // ── 5) 클럽 상세 API(info) — period 배선 ──
  console.log("\n[5. 클럽 상세 API period]");
  for (const period of ["2026-H1", "2024-H2"]) {
    const { status, json } = await getInfo(cookie, { organization: "encre", period });
    ck(`상세 encre period=${period} 200`, status === 200, `status=${status}`);
    ck("selectedHalfKey 반영", json?.data?.selectedHalfKey === period, json?.data?.selectedHalfKey);
    // 상단 요약 카운트도 그 반기 기준(오늘 날짜는 실제 오늘 그대로).
    ck("summary.counts 존재", typeof json?.data?.summary?.counts?.totalTeams === "number");
  }
  // half= 하위호환 alias
  {
    const { json } = await getInfo(cookie, { organization: "encre", half: "2025-H2" });
    ck("half= alias 도 동작", json?.data?.selectedHalfKey === "2025-H2", json?.data?.selectedHalfKey);
  }

  // ── 6) 일반(operating) vs test 비교 ──
  //   ⚠ 이 환경은 현재 QA_HIDE_REAL_USERS=true(lib/qaFixedScope.ts) 로 운영/테스트 모드가
  //     "같은 논리적 모집단"(테스트 마커 유저)으로 강제 고정돼 있다. 이 조건에서는 operating과
  //     test 응답이 완전히 동일해야 한다(스코프가 실제로 같기 때문). 이 동일성은 코드가 mode 를
  //     무시해서가 아니라, 현재 환경 설정이 두 모드를 같은 모집단으로 좁혀서 생기는 결과다.
  console.log("\n[6. 일반(operating) vs test — 동일 논리적 모집단(QA 스위치로 인해 현재 동일)]");
  for (const period of ["2026-H2", "2026-H1", "2024-H2"]) {
    const op = await getSummary(cookie, { period });
    const te = await getSummary(cookie, { period, mode: "test" });
    const sameKeys = JSON.stringify(Object.keys(op.json.data).sort()) === JSON.stringify(Object.keys(te.json.data).sort());
    ck(`period=${period} DTO 키 동일`, sameKeys);
    const sameMeta = JSON.stringify(op.json.data.period) === JSON.stringify(te.json.data.period);
    ck(`period=${period} period 메타 완전 동일`, sameMeta);
    const sameRows = JSON.stringify(op.json.data.rows) === JSON.stringify(te.json.data.rows);
    ck(`period=${period} rows 완전 동일(QA 스위치 하 동일 모집단)`, sameRows,
      sameRows ? "" : `op=${JSON.stringify(op.json.data.rows)} test=${JSON.stringify(te.json.data.rows)}`);
    const sameTotals = JSON.stringify(op.json.data.totals) === JSON.stringify(te.json.data.totals);
    ck(`period=${period} totals 완전 동일`, sameTotals);
  }

  console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAIL`}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
