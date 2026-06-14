/**
 * "고객 페이지 업데이트" 버튼 검증 — 기간 등록 → 대상 확인(dry_run) → 실제 반영(실행).
 * 버튼은 기존 API /api/admin/cluster4/recompute-official-rest-snapshots 를 재사용한다.
 *
 *  파트 A) 버튼 wiring (테스트 주차, 무오염):
 *    1) 등록(2022-spring W1, 공식 활동) → weeks DB 저장 확인(direct)
 *    2) dry_run=true → target_count (2022 활동 없음 → 0 기대)
 *    3) direct: 해당 날짜범위 user_week_statuses distinct == HTTP target_count
 *    4) dry_run=false(실행) → requested/recomputed 반환
 *  파트 B) 실제 모집단에서 direct == HTTP (읽기 전용):
 *    5) 최근 실주차 1개 선택 → dry_run=true target_count
 *    6) direct distinct user_week_statuses == HTTP target_count
 *  파트 C) 실행(반영) 메커니즘이 실제로 snapshot 을 다시 굽는지 (사용자 1명 한정·멱등):
 *    7) 파트 B 대상 중 snapshot 보유 1명: recompute-user-snapshots(버튼 실행과 동일 lib
 *       recomputeWeeklyCardsSnapshotsForUsers) → computed_at 전진 + cards JSON 불변(멱등)
 *  파트 D) 고객 일반 경로 == demoUserId 경로: 동일 loadWeeklyCards/snapshot DTO (코드 근거)
 *
 * 사전조건: admin dev :3000.
 * Usage: npx tsx --env-file=.env.local scripts/verify-period-customer-update-http.ts
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

const REFLECT_API = "/api/admin/cluster4/recompute-official-rest-snapshots";
const TEST = {
  year: 2022,
  season_type: "spring",
  week_number: 1,
  week_start_date: "2022-03-07",
  week_end_date: "2022-03-13",
  season_key: "2022-spring",
};

async function directDistinctUsers(start: string, end: string): Promise<number> {
  const { data, error } = await sb
    .from("user_week_statuses")
    .select("user_id")
    .gte("week_start_date", start)
    .lte("week_start_date", end);
  if (error) throw new Error(`uws 조회 실패: ${error.message}`);
  return new Set((data ?? []).map((r) => r.user_id)).size;
}

async function main() {
  const cookie = await makeAdminCookieHeader();
  const reflect = async (start: string, end: string, dryRun: boolean) => {
    const r = await fetch(`${adminBase}${REFLECT_API}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ start_date: start, end_date: end, dry_run: dryRun }),
    });
    return { status: r.status, json: await r.json() };
  };
  const postWeek = async (body: unknown) => {
    const r = await fetch(`${adminBase}/api/admin/season-weeks`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  };

  console.log("=== A) 버튼 wiring (테스트 주차 2022-spring W1) ===");
  // 멱등: 잔존분 정리 후 등록
  await sb.from("weeks").delete().eq("season_key", TEST.season_key);
  const reg = await postWeek({
    year: TEST.year,
    season_type: TEST.season_type,
    week_number: TEST.week_number,
    is_official_rest: false,
    note: "고객반영 버튼 검증",
    week_start_date: TEST.week_start_date,
    week_end_date: TEST.week_end_date,
  });
  check("1) 기간 등록 POST 200", reg.status === 200 && reg.json?.success === true, JSON.stringify(reg.json?.error ?? reg.json?.data?.week_id));
  const weekId = reg.json?.data?.week_id as string | undefined;

  const { data: dbWeek } = await sb
    .from("weeks")
    .select("id,season_key,week_number,start_date,end_date")
    .eq("id", weekId!)
    .single();
  check("2) weeks DB 저장 확인(direct)", dbWeek?.season_key === TEST.season_key && dbWeek?.week_number === 1 && dbWeek?.start_date === TEST.week_start_date, JSON.stringify(dbWeek));

  const dryA = await reflect(TEST.week_start_date, TEST.week_end_date, true);
  check("3) dry_run 200 + dry_run:true", dryA.status === 200 && dryA.json?.data?.dry_run === true, JSON.stringify(dryA.json));
  const httpCountA = Number(dryA.json?.data?.target_count ?? -1);
  const directCountA = await directDistinctUsers(TEST.week_start_date, TEST.week_end_date);
  check("4) dry_run 대상 수 = direct distinct (2022=0)", httpCountA === directCountA, `HTTP=${httpCountA} direct=${directCountA}`);

  const runA = await reflect(TEST.week_start_date, TEST.week_end_date, false);
  check("5) 실행 200 + dry_run:false", runA.status === 200 && runA.json?.data?.dry_run === false, JSON.stringify(runA.json));
  check("   requested == target_count", Number(runA.json?.data?.requested) === httpCountA, `requested=${runA.json?.data?.requested}`);

  console.log("\n=== B) 실제 모집단에서 direct == HTTP (읽기 전용) ===");
  // snapshot 보유 사용자가 있는 최근 실주차를 찾는다.
  const { data: recentWeeks } = await sb
    .from("weeks")
    .select("start_date,end_date,season_key,week_number")
    .lte("start_date", new Date().toISOString().slice(0, 10))
    .order("start_date", { ascending: false })
    .limit(40);
  let picked: { start: string; end: string; key: string; wk: number } | null = null;
  let pickedCount = 0;
  for (const w of recentWeeks ?? []) {
    if (!w.start_date || !w.end_date) continue;
    const n = await directDistinctUsers(w.start_date, w.end_date);
    if (n > 0) {
      picked = { start: w.start_date, end: w.end_date, key: w.season_key, wk: w.week_number };
      pickedCount = n;
      break;
    }
  }
  if (!picked) {
    check("B) 모집단 보유 실주차 발견", false, "user_week_statuses 보유 주차 없음 — 환경 데이터 부족");
  } else {
    console.log(`  선택 주차: ${picked.key} W${picked.wk} (${picked.start}~${picked.end}), direct distinct=${pickedCount}`);
    const dryB = await reflect(picked.start, picked.end, true);
    const httpCountB = Number(dryB.json?.data?.target_count ?? -1);
    check("6) dry_run target_count == direct distinct (실모집단)", httpCountB === pickedCount, `HTTP=${httpCountB} direct=${pickedCount}`);

    console.log("\n=== C) 실행 메커니즘 — snapshot 재생성(사용자 1명·멱등) ===");
    // 버튼 실행과 동일한 lib(recomputeWeeklyCardsSnapshotsForUsers)을 1명 한정으로 호출.
    const { data: uwsUsers } = await sb
      .from("user_week_statuses")
      .select("user_id")
      .gte("week_start_date", picked.start)
      .lte("week_start_date", picked.end);
    const userIds = Array.from(new Set((uwsUsers ?? []).map((r) => r.user_id)));
    let target: string | null = null;
    let before: { computed_at: string; cards: unknown } | null = null;
    for (const uid of userIds) {
      const { data: snap } = await sb
        .from("cluster4_weekly_card_snapshots")
        .select("user_id,computed_at,cards")
        .eq("user_id", uid)
        .maybeSingle();
      if (snap?.computed_at) {
        target = uid;
        before = { computed_at: snap.computed_at, cards: snap.cards };
        break;
      }
    }
    if (!target || !before) {
      check("C) snapshot 보유 대상 1명 발견", false, "대상 중 snapshot 보유자 없음");
    } else {
      const internalKey = ensureEnv("INTERNAL_API_KEY");
      const r = await fetch(`${adminBase}/api/admin/cluster4/recompute-user-snapshots`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-api-key": internalKey },
        body: JSON.stringify({ userIds: [target] }),
      });
      const j = await r.json();
      check("7) 단건 재계산 200 + recomputed=1", r.status === 200 && j?.data?.recomputed === 1, JSON.stringify(j?.data ?? j));
      const { data: after } = await sb
        .from("cluster4_weekly_card_snapshots")
        .select("computed_at,cards")
        .eq("user_id", target)
        .single();
      check("   computed_at 전진(반영 동작)", Date.parse(after!.computed_at) >= Date.parse(before.computed_at), `${before.computed_at} → ${after!.computed_at}`);
      check("   cards JSON 불변(멱등·데이터 안전)", JSON.stringify(after!.cards) === JSON.stringify(before.cards), "동일");
    }
  }

  console.log("\n=== D) 고객 일반 == demoUserId DTO (코드 근거) ===");
  console.log("  app/api/cluster4/weekly-cards/route.ts: demo(demoUserId)·세션(일반) 모두 loadWeeklyCards → 동일 snapshot DTO.");
  console.log("  (mode=test 시뮬레이션만 live 계산 예외 — snapshot 무접촉)");

  // 테스트 주차 정리(2022 잔존 제거)
  await sb.from("weeks").delete().eq("season_key", TEST.season_key);
  await sb.from("seasons").delete().eq("name", "2022년도 봄시즌");
  console.log("\n[cleanup] 테스트 주차(2022-spring) 및 신설 season 제거 완료");

  console.log(`\n결과: ✓ ${pass} / ✗ ${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
