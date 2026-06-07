/**
 * 기간 등록(POST /api/admin/season-weeks) 검증 — HTTP + direct + snapshot 지문.
 *   1) snapshot 지문(before): cluster4_weekly_card_snapshots 행수·최신 updated_at
 *   2) HTTP GET 베이스라인: 2022-spring W1 부재 확인
 *   3) HTTP POST 등록(2022-spring W1, 2022-03-07~13, 공식 활동, 비고)
 *   4) HTTP POST 동일 조합 재시도 → 409 "동일한 주차 정보를 가진 기간이 있습니다."
 *   5) HTTP GET 재조회: 신규 행 노출 + 행수 +1 (기간 정보와 동일 API/DTO)
 *   6) direct: weeks/season_definitions 직접 조회로 동일 행 구성 → HTTP 행과 필드 비교
 *   7) snapshot 지문(after): before 와 동일(무영향) 확인
 *   유지: 등록 행은 브라우저 검증을 위해 남긴다 (cleanup 은 별도 스크립트).
 * 사전조건: admin dev :3000.
 * Usage: npx tsx --env-file=.env.local scripts/verify-period-register-http.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

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

const TEST = {
  year: 2022,
  season_type: "spring",
  week_number: 1,
  is_official_rest: false,
  note: "기간 등록 검증 테스트",
  week_start_date: "2022-03-07",
  week_end_date: "2022-03-13",
  season_key: "2022-spring",
};

async function snapshotFingerprint() {
  const { count, error } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id", { count: "exact", head: true });
  if (error) throw new Error(`snapshot count 실패: ${error.message}`);
  const { data: latest, error: lErr } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("updated_at")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (lErr) throw new Error(`snapshot latest 실패: ${lErr.message}`);
  return { count: count ?? 0, latest: latest?.[0]?.updated_at ?? null };
}

async function main() {
  const cookie = await makeAdminCookieHeader();
  const get = async () => {
    const r = await fetch(`${adminBase}/api/admin/season-weeks`, {
      headers: { cookie },
      cache: "no-store",
    });
    const j = await r.json();
    if (!r.ok || !j.success) throw new Error(`GET 실패 ${r.status}: ${j?.error}`);
    return j.data as { rows: any[]; seasons: any[] };
  };
  const post = async (body: unknown) => {
    const r = await fetch(`${adminBase}/api/admin/season-weeks`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  };

  console.log("=== 1) snapshot 지문 (before) ===");
  const snapBefore = await snapshotFingerprint();
  console.log(`  count=${snapBefore.count}, latest=${snapBefore.latest}`);

  console.log("\n=== 2) HTTP GET 베이스라인 ===");
  const before = await get();
  const existed = before.rows.find(
    (r) => r.season_key === TEST.season_key && r.week_number === TEST.week_number,
  );
  check("2022-spring W1 부재(베이스라인)", !existed);
  console.log(`  rows=${before.rows.length}`);

  console.log("\n=== 3) HTTP POST 등록 ===");
  const reg = await post({
    year: TEST.year,
    season_type: TEST.season_type,
    week_number: TEST.week_number,
    is_official_rest: TEST.is_official_rest,
    note: TEST.note,
    week_start_date: TEST.week_start_date,
    week_end_date: TEST.week_end_date,
  });
  check("POST 200 + success", reg.status === 200 && reg.json?.success === true, JSON.stringify(reg.json));
  const weekId = reg.json?.data?.week_id as string | undefined;

  console.log("\n=== 4) 동일 조합 재등록 → 409 ===");
  const dup = await post({
    year: TEST.year,
    season_type: TEST.season_type,
    week_number: TEST.week_number,
    is_official_rest: true,
    note: null,
    week_start_date: "2022-03-14",
    week_end_date: "2022-03-20",
  });
  check("409 반환", dup.status === 409, `실제=${dup.status}`);
  check(
    '메시지="동일한 주차 정보를 가진 기간이 있습니다."',
    dup.json?.error === "동일한 주차 정보를 가진 기간이 있습니다.",
    `실제=${dup.json?.error}`,
  );

  console.log("\n=== 5) HTTP GET 재조회 (기간 정보와 동일 API) ===");
  const after = await get();
  check("rows +1", after.rows.length === before.rows.length + 1, `${before.rows.length} → ${after.rows.length}`);
  const httpRow = after.rows.find((r) => r.week_id === weekId);
  check("신규 행 노출(week_id 매칭)", Boolean(httpRow));
  if (httpRow) {
    check("season_key", httpRow.season_key === TEST.season_key, httpRow.season_key);
    check("week_number", httpRow.week_number === TEST.week_number, String(httpRow.week_number));
    check("week_start_date", httpRow.week_start_date === TEST.week_start_date, httpRow.week_start_date);
    check("week_end_date", httpRow.week_end_date === TEST.week_end_date, httpRow.week_end_date);
    check("is_official_rest=false", httpRow.is_official_rest === false, String(httpRow.is_official_rest));
    check("holiday_name=비고", httpRow.holiday_name === TEST.note, String(httpRow.holiday_name));
    check("is_transition=false", httpRow.is_transition === false, String(httpRow.is_transition));
  }
  // 필터/정렬/결과 수 (SeasonWeeksTable 로직 미러): 년도=주차 시작일 4자리
  const rows2022 = after.rows.filter(
    (r) => (r.week_start_date ?? "").slice(0, 4) === "2022",
  );
  check("년도 필터(2022) 결과 수=1", rows2022.length === 1, String(rows2022.length));
  const sorted = [...after.rows]
    .filter((r) => r.week_start_date)
    .sort((a, b) => a.week_start_date.localeCompare(b.week_start_date));
  check("오래된 순 정렬 1행=신규 행(2022 가 최고(最古))", sorted[0]?.week_id === weekId, sorted[0]?.week_start_date);

  console.log("\n=== 6) direct ↔ HTTP 비교 ===");
  const { data: directWeek, error: dErr } = await sb
    .from("weeks")
    .select("id,season_id,season_key,week_number,start_date,end_date,is_official_rest,holiday_name,iso_year,iso_week,week_index,check_threshold,result_published_at")
    .eq("id", weekId!)
    .single();
  if (dErr) throw new Error(`direct weeks 조회 실패: ${dErr.message}`);
  check("direct.season_key == HTTP", directWeek.season_key === httpRow?.season_key);
  check("direct.week_number == HTTP", directWeek.week_number === httpRow?.week_number);
  check("direct.start_date == HTTP", directWeek.start_date === httpRow?.week_start_date);
  check("direct.end_date == HTTP", directWeek.end_date === httpRow?.week_end_date);
  check("direct.is_official_rest == HTTP", directWeek.is_official_rest === httpRow?.is_official_rest);
  check("direct.holiday_name == HTTP", directWeek.holiday_name === httpRow?.holiday_name);
  check("direct iso 컨벤션(2022-03-07=ISO 2022-W10)", directWeek.iso_year === 2022 && directWeek.iso_week === 10 && directWeek.week_index === 10, `iso=${directWeek.iso_year}-W${directWeek.iso_week}, idx=${directWeek.week_index}`);
  check("check_threshold 미설정(null)", directWeek.check_threshold === null, String(directWeek.check_threshold));
  check("result_published_at 없음", directWeek.result_published_at === null, String(directWeek.result_published_at));
  // 신설 seasons 행 검증 (find-or-create)
  const { data: seasonRow, error: sErr } = await sb
    .from("seasons")
    .select("id,name,season_index,started_at,ended_at")
    .eq("id", directWeek.season_id)
    .single();
  if (sErr) throw new Error(`seasons 조회 실패: ${sErr.message}`);
  check("seasons find-or-create: name=2022년도 봄시즌", seasonRow.name === "2022년도 봄시즌", seasonRow.name);
  check("seasons started_at=정의 시작일", String(seasonRow.started_at).startsWith("2022-03-07"), String(seasonRow.started_at));
  check("seasons ended_at 보유(현재 시즌 해석 무영향)", seasonRow.ended_at != null, String(seasonRow.ended_at));
  console.log(`  신설 season_id=${seasonRow.id}, idx=${seasonRow.season_index}`);

  console.log("\n=== 6.5) 공식 휴식 등록 → 판정 SoT(official_rest_periods) 연동 ===");
  const rest = await post({
    year: TEST.year,
    season_type: TEST.season_type,
    week_number: 2,
    is_official_rest: true,
    note: "휴식 등록 검증",
    week_start_date: "2022-03-14",
    week_end_date: "2022-03-20",
  });
  check("휴식 POST 200 + success", rest.status === 200 && rest.json?.success === true, JSON.stringify(rest.json));
  const restPeriodId = rest.json?.data?.rest_period_id as string | null;
  check("rest_period_id 발급", Boolean(restPeriodId), String(restPeriodId));
  const afterRest = await get();
  const restRow = afterRest.rows.find(
    (r) => r.season_key === TEST.season_key && r.week_number === 2,
  );
  check("휴식 행 is_official_rest=true(판정 반영)", restRow?.is_official_rest === true, JSON.stringify(restRow?.official_rest_sources));
  check(
    "sources=date_period+legacy_iso_week",
    Array.isArray(restRow?.official_rest_sources) &&
      restRow.official_rest_sources.includes("date_period") &&
      restRow.official_rest_sources.includes("legacy_iso_week"),
    JSON.stringify(restRow?.official_rest_sources),
  );
  check("holiday_name=비고", restRow?.holiday_name === "휴식 등록 검증", String(restRow?.holiday_name));
  // 활동 필터(공식 휴식) 미러: 2022 행 중 휴식=1건
  const rest2022 = afterRest.rows.filter(
    (r) => (r.week_start_date ?? "").slice(0, 4) === "2022" && r.is_official_rest,
  );
  check("활동=공식 휴식 필터(2022) 결과 1건", rest2022.length === 1, String(rest2022.length));
  // conflict 에 신규 휴식 행 없음 (legacy 와 신규 판정 일치)
  const conflictsAfter = (afterRest as any).conflicts ?? [];
  const w2Conflict = conflictsAfter.find(
    (c: any) => c.season_key === TEST.season_key && c.week_number === 2,
  );
  check("휴식 행 conflict 미발생(legacy=신규 판정 일치)", !w2Conflict, JSON.stringify(w2Conflict ?? null));
  // direct: official_rest_periods 행 존재
  if (restPeriodId) {
    const { data: periodRow, error: pErr } = await sb
      .from("official_rest_periods")
      .select("id,name,type,start_date,end_date,is_active")
      .eq("id", restPeriodId)
      .single();
    if (pErr) throw new Error(`period 조회 실패: ${pErr.message}`);
    check(
      "direct period: temporary·날짜 일치·active",
      periodRow.type === "temporary" &&
        periodRow.start_date === "2022-03-14" &&
        periodRow.end_date === "2022-03-20" &&
        periodRow.is_active === true,
      JSON.stringify(periodRow),
    );
  }

  console.log("\n=== 7) snapshot 지문 (after) ===");
  const snapAfter = await snapshotFingerprint();
  check("snapshot 행수 불변", snapAfter.count === snapBefore.count, `${snapBefore.count} → ${snapAfter.count}`);
  check("snapshot 최신 updated_at 불변", snapAfter.latest === snapBefore.latest, `${snapBefore.latest} → ${snapAfter.latest}`);

  console.log(`\n결과: ✓ ${pass} / ✗ ${fail}`);
  console.log(`테스트 등록 잔존(브라우저 검증용): week_id=${weekId}, season_id=${seasonRow.id}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
