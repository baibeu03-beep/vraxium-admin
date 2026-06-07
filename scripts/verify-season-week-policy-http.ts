/**
 * 시즌/주차 정책 확정(2026-06-07) 검증 — HTTP + direct + snapshot 지문.
 *   A) 현재 시즌/주차 = 오늘 날짜 기준: 미래 시즌(2026-summer W1) 선등록 후에도
 *      test-users seasonName · current-week · front weekly-growth seasonSummary ·
 *      season-weeks is_current_week 전부 불변 (구 started_at DESC 규칙이면 flip 됐음을 함께 입증)
 *   B) 시험기간 고정 휴식: 봄/가을 6~8·14~16주차 공식 활동 등록 400 차단,
 *      공식 휴식 등록은 성공(season_rule 커버 → period 미생성)
 *   C) 일반 주차: 관리자 선택값(활동/휴식) 그대로 기간 정보 반영
 *   D) direct ↔ HTTP 일치, snapshot 지문 불변
 * 사전조건: admin dev :3000. 종료 후 cleanup-period-register-test.ts 실행 필요.
 * Usage: npx tsx --env-file=.env.local scripts/verify-season-week-policy-http.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const adminBase = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const frontBase = process.env.DIAG_FRONT_BASE ?? "https://vraxium.vercel.app";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const AHN = "ff6adaf8-8993-4b5b-b5ea-a4fa1036cdee"; // T안건우 — front 고객 화면 표본

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

async function snapshotFingerprint() {
  const { count } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id", { count: "exact", head: true });
  const { data: latest } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("updated_at")
    .order("updated_at", { ascending: false })
    .limit(1);
  return { count: count ?? 0, latest: latest?.[0]?.updated_at ?? null };
}

// 종전(결함) 규칙 재현: ended_at IS NULL 우선 → started_at DESC → season_index DESC
function oldRulePick(
  rows: { name: string; started_at: string | null; ended_at: string | null; season_index: number | null }[],
) {
  return [...rows].sort((a, b) => {
    const openDelta =
      Number(a.ended_at === null ? 0 : 1) - Number(b.ended_at === null ? 0 : 1);
    if (openDelta !== 0) return openDelta;
    const startDelta = (b.started_at ?? "").localeCompare(a.started_at ?? "");
    if (startDelta !== 0) return startDelta;
    return (b.season_index ?? 0) - (a.season_index ?? 0);
  })[0]?.name ?? null;
}

async function main() {
  const cookie = await makeAdminCookieHeader();
  const getJson = async (path: string) => {
    const r = await fetch(`${adminBase}${path}`, { headers: { cookie }, cache: "no-store" });
    const j = await r.json();
    if (!r.ok || !j.success) throw new Error(`GET ${path} 실패 ${r.status}: ${j?.error}`);
    return j.data;
  };
  const post = async (body: unknown) => {
    const r = await fetch(`${adminBase}/api/admin/season-weeks`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  };
  const frontSeasonSummary = async () => {
    const r = await fetch(`${frontBase}/api/cluster4/weekly-growth?userId=${AHN}`, {
      cache: "no-store",
    });
    const j = await r.json().catch(() => null);
    return j?.data?.seasonSummary ?? null;
  };

  console.log("=== 0) snapshot 지문 (before) ===");
  const snapBefore = await snapshotFingerprint();
  console.log(`  count=${snapBefore.count}, latest=${snapBefore.latest}`);

  console.log("\n=== A-1) 현재 시즌/주차 베이스라인 (오늘 기준) ===");
  const testUsersBefore = await getJson("/api/admin/test-users");
  const seasonNameBefore = testUsersBefore?.[0]?.seasonName ?? null;
  check('test-users seasonName="2026년도 봄시즌"', seasonNameBefore === "2026년도 봄시즌", String(seasonNameBefore));
  const cwBefore = await getJson("/api/admin/cluster4/current-week");
  check("current-week seasonKey=2026-spring(오늘 포함 시즌)", cwBefore.seasonKey === "2026-spring", `${cwBefore.seasonKey} W${cwBefore.weekNumber}`);
  const swBefore = await getJson("/api/admin/season-weeks");
  const currentIdsBefore = swBefore.rows
    .filter((r: any) => r.is_current_week)
    .map((r: any) => r.week_id)
    .sort();
  const frontBefore = await frontSeasonSummary();
  console.log(`  front seasonSummary(before)=${JSON.stringify(frontBefore)?.slice(0, 200)}`);

  console.log("\n=== A-2) 미래 시즌/주차 선등록 (2026-summer W1, 시즌 행 신설 유발) ===");
  const future = await post({
    year: 2026,
    season_type: "summer",
    week_number: 1,
    is_official_rest: false,
    note: "미래 주차 선등록 검증",
    week_start_date: "2026-06-29",
    week_end_date: "2026-07-05",
  });
  check("미래 주차 POST 200", future.status === 200 && future.json?.success === true, JSON.stringify(future.json));

  // 신설 seasons 행(미래 started_at) 존재 = 종전 규칙이면 flip 되는 조건이 실제로 성립함을 입증
  const { data: seasonsNow, error: sErr } = await sb
    .from("seasons")
    .select("name,started_at,ended_at,season_index");
  if (sErr) throw new Error(sErr.message);
  const summerRow = (seasonsNow ?? []).find((s) => s.name === "2026년도 여름시즌");
  check("seasons에 미래 시즌 행 신설(started_at=2026-06-29 > 오늘)", Boolean(summerRow), JSON.stringify(summerRow));
  check(
    "구 규칙(started_at DESC)이라면 여름으로 flip 됐을 조건",
    oldRulePick(seasonsNow as any) === "2026년도 여름시즌",
    `구규칙 선택=${oldRulePick(seasonsNow as any)}`,
  );

  console.log("\n=== A-3) 등록 후 현재 시즌/주차 불변 확인 ===");
  const testUsersAfter = await getJson("/api/admin/test-users");
  const seasonNameAfter = testUsersAfter?.[0]?.seasonName ?? null;
  check("test-users seasonName 불변(=2026년도 봄시즌)", seasonNameAfter === "2026년도 봄시즌", String(seasonNameAfter));
  const cwAfter = await getJson("/api/admin/cluster4/current-week");
  check(
    "current-week 불변",
    cwAfter.seasonKey === cwBefore.seasonKey && cwAfter.weekNumber === cwBefore.weekNumber,
    `${cwAfter.seasonKey} W${cwAfter.weekNumber}`,
  );
  const swAfter = await getJson("/api/admin/season-weeks");
  const currentIdsAfter = swAfter.rows
    .filter((r: any) => r.is_current_week)
    .map((r: any) => r.week_id)
    .sort();
  check("season-weeks is_current_week 행 집합 불변", JSON.stringify(currentIdsBefore) === JSON.stringify(currentIdsAfter), `${currentIdsBefore.length}건`);
  const futureRow = swAfter.rows.find((r: any) => r.week_id === future.json?.data?.week_id);
  check("미래 주차 행 is_current_week=false", futureRow?.is_current_week === false);
  const frontAfter = await frontSeasonSummary();
  check(
    "front(고객 화면) weekly-growth seasonSummary 불변",
    JSON.stringify(frontBefore) === JSON.stringify(frontAfter),
    JSON.stringify(frontAfter)?.slice(0, 120),
  );

  console.log("\n=== B) 시험기간 고정 휴식 — 공식 활동 차단 ===");
  const examActive = await post({
    year: 2022,
    season_type: "spring",
    week_number: 6,
    is_official_rest: false,
    note: null,
    week_start_date: "2022-04-11",
    week_end_date: "2022-04-17",
  });
  check("봄 W6 공식 활동 → 400", examActive.status === 400, `실제=${examActive.status}`);
  check(
    '메시지="해당 주차는 시험기간 공식 휴식 주차입니다."',
    examActive.json?.error === "해당 주차는 시험기간 공식 휴식 주차입니다.",
    String(examActive.json?.error),
  );
  const examActive2 = await post({
    year: 2022,
    season_type: "autumn",
    week_number: 14,
    is_official_rest: false,
    note: null,
    week_start_date: "2022-12-05",
    week_end_date: "2022-12-11",
  });
  check("가을 W14 공식 활동 → 400", examActive2.status === 400 && examActive2.json?.error === "해당 주차는 시험기간 공식 휴식 주차입니다.", `${examActive2.status}`);

  const examRest = await post({
    year: 2022,
    season_type: "spring",
    week_number: 6,
    is_official_rest: true,
    note: "1학기 중간고사",
    week_start_date: "2022-04-11",
    week_end_date: "2022-04-17",
  });
  check("봄 W6 공식 휴식 → 200", examRest.status === 200 && examRest.json?.success === true, JSON.stringify(examRest.json?.data ?? examRest.json));
  check("season_rule 커버 → period 미생성(rest_period_id=null)", examRest.json?.data?.rest_period_id === null, String(examRest.json?.data?.rest_period_id));

  console.log("\n=== C) 일반 주차 — 관리자 선택값 그대로 반영 ===");
  const winterActive = await post({
    year: 2022,
    season_type: "winter",
    week_number: 6,
    is_official_rest: false,
    note: "일반 활동 주차",
    week_start_date: "2022-02-07",
    week_end_date: "2022-02-13",
  });
  check("겨울 W6(시험기간 아님) 공식 활동 → 200", winterActive.status === 200, JSON.stringify(winterActive.json?.error ?? "ok"));
  const winterRest = await post({
    year: 2022,
    season_type: "winter",
    week_number: 7,
    is_official_rest: true,
    note: "설 연휴 검증",
    week_start_date: "2022-02-14",
    week_end_date: "2022-02-20",
  });
  check("겨울 W7 공식 휴식 → 200 + period 생성", winterRest.status === 200 && Boolean(winterRest.json?.data?.rest_period_id), String(winterRest.json?.data?.rest_period_id));

  const swFinal = await getJson("/api/admin/season-weeks");
  const rowOf = (key: string, num: number) =>
    swFinal.rows.find((r: any) => r.season_key === key && r.week_number === num);
  const springW6 = rowOf("2022-spring", 6);
  check("기간 정보: 봄 W6=공식 휴식 + season_rule 출처", springW6?.is_official_rest === true && springW6?.official_rest_sources?.includes("season_rule"), JSON.stringify(springW6?.official_rest_sources));
  const winterW6 = rowOf("2022-winter", 6);
  check("기간 정보: 겨울 W6=공식 활동(선택값 그대로)", winterW6?.is_official_rest === false, JSON.stringify(winterW6?.official_rest_sources));
  const winterW7 = rowOf("2022-winter", 7);
  check("기간 정보: 겨울 W7=공식 휴식(선택값 그대로·date_period)", winterW7?.is_official_rest === true && winterW7?.official_rest_sources?.includes("date_period"), JSON.stringify(winterW7?.official_rest_sources));
  // conflict 무증가(신규 행 legacy=신규 판정 일치)
  const newIds = new Set(
    [future, examRest, winterActive, winterRest].map((r) => r.json?.data?.week_id),
  );
  const newConflicts = (swFinal.conflicts ?? []).filter((c: any) => newIds.has(c.week_id));
  check("신규 등록 행 conflict 0건", newConflicts.length === 0, JSON.stringify(newConflicts));

  console.log("\n=== D) direct ↔ HTTP 일치 ===");
  for (const [label, key, num] of [
    ["봄 W6", "2022-spring", 6],
    ["겨울 W6", "2022-winter", 6],
    ["겨울 W7", "2022-winter", 7],
    ["여름(미래) W1", "2026-summer", 1],
  ] as const) {
    const { data: dw, error } = await sb
      .from("weeks")
      .select("season_key,week_number,start_date,end_date,is_official_rest,holiday_name")
      .eq("season_key", key)
      .eq("week_number", num)
      .single();
    if (error) throw new Error(`${label} direct 조회 실패: ${error.message}`);
    const hr = rowOf(key, num);
    check(
      `${label}: direct == HTTP(키·날짜·비고)`,
      dw.season_key === hr?.season_key &&
        dw.week_number === hr?.week_number &&
        dw.start_date === hr?.week_start_date &&
        dw.end_date === hr?.week_end_date &&
        (dw.holiday_name ?? null) === (hr?.holiday_name ?? null),
      `${dw.start_date}`,
    );
  }

  console.log("\n=== E) snapshot 지문 (after) ===");
  const snapAfter = await snapshotFingerprint();
  check("snapshot 행수 불변", snapAfter.count === snapBefore.count, `${snapBefore.count} → ${snapAfter.count}`);
  check("snapshot 최신 updated_at 불변", snapAfter.latest === snapBefore.latest, `${snapAfter.latest}`);

  console.log(`\n결과: ✓ ${pass} / ✗ ${fail}`);
  console.log("테스트 등록 잔존 — cleanup-period-register-test.ts 로 정리하세요.");
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
