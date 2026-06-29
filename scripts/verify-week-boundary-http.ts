/**
 * verify-week-boundary-http.ts
 * 주차/시즌 경계(월요일 00:01 KST) — HTTP ↔ direct 일치 + snapshot 무영향 + demo==normal 검증.
 *
 *   A) /api/admin/cluster4/current-week (운영자 화면) == direct describeCurrentWeek(getCurrentActivityDateIso())
 *   B) current-week 호출은 순수 캘린더 — snapshot 행수/최신 updated_at 불변(재계산 없음)
 *   C) demo(demoUserId) 경로 == 일반(internal userId) 경로: 같은 테스트 유저 카드/envelope 동일
 *      (ENABLE_DEMO_MODE 미설정이면 demo 경로 401 → 경고 후 skip)
 *
 * 사전조건: admin dev :3000 (ENABLE_DEMO_MODE=1 권장 — C 검증용).
 * 실행: npx tsx --env-file=.env.local scripts/verify-week-boundary-http.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { describeCurrentWeek } from "@/lib/cluster4WeekPolicy";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";

const base = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const internalKey = process.env.INTERNAL_API_KEY ?? "";

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

let pass = 0, fail = 0, warn = 0;
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

// 카드/envelope 비교 시 시간 의존(growthInfo 등) 필드 제외하고 안정 비교.
function stable(j: any) {
  return JSON.stringify({
    cards: j?.data ?? null,
    areaSixCircles: j?.areaSixCircles ?? null,
    seasonAreaProgress: j?.seasonAreaProgress ?? null,
    areaSixCirclesBySeason: j?.areaSixCirclesBySeason ?? null,
    seasonAreaProgressBySeason: j?.seasonAreaProgressBySeason ?? null,
  });
}

async function main() {
  const cookie = await makeAdminCookieHeader();

  console.log("=== A) current-week: HTTP == direct ===");
  const cur = describeCurrentWeek(getCurrentActivityDateIso());
  if (!cur) throw new Error("direct describeCurrentWeek null (달력 갭?)");
  const r = await fetch(`${base}/api/admin/cluster4/current-week`, {
    headers: { cookie },
    cache: "no-store",
  });
  const j = await r.json();
  check("current-week HTTP 200/success", r.ok && j.success === true, `${r.status}`);
  check(
    "seasonKey 일치",
    j.data?.seasonKey === cur.seasonKey,
    `http=${j.data?.seasonKey} direct=${cur.seasonKey}`,
  );
  check(
    "weekNumber 일치",
    j.data?.weekNumber === cur.weekNumber,
    `http=${j.data?.weekNumber} direct=${cur.weekNumber}`,
  );
  check(
    "startDate(주차 시작일) 일치",
    j.data?.startDate === cur.weekStart,
    `http=${j.data?.startDate} direct=${cur.weekStart}`,
  );

  console.log("\n=== B) current-week 는 snapshot 무영향(순수 캘린더) ===");
  const before = await snapshotFingerprint();
  await fetch(`${base}/api/admin/cluster4/current-week`, { headers: { cookie }, cache: "no-store" });
  const after = await snapshotFingerprint();
  check("snapshot 행수 불변", before.count === after.count, `${before.count} → ${after.count}`);
  check("snapshot 최신 updated_at 불변", before.latest === after.latest, `${after.latest}`);

  console.log("\n=== C) demo(demoUserId) == 일반(internal userId) ===");
  // 스냅샷 보유 테스트 유저 1명 선택(이름 'T' 시작).
  const { data: testUser } = await sb
    .from("user_profiles")
    .select("user_id,display_name")
    .like("display_name", "T%")
    .limit(1)
    .maybeSingle();
  const uid = (testUser as any)?.user_id as string | undefined;
  if (!uid) {
    console.log("  ⚠ 테스트 유저(이름 T 시작) 없음 → C skip");
    warn++;
  } else if (!internalKey) {
    console.log("  ⚠ INTERNAL_API_KEY 없음 → C skip");
    warn++;
  } else {
    // 워밍업: 오늘이 주차 경계 직후면 첫 조회가 boundary-stale lazy 재계산을 유발한다.
    //   두 경로 비교가 재계산과 레이스하지 않도록 한 번 데우고 잠깐 안정화한 뒤 비교한다.
    await fetch(`${base}/api/cluster4/weekly-cards?userId=${uid}`, {
      headers: { "x-internal-api-key": internalKey },
      cache: "no-store",
    });
    await new Promise((r) => setTimeout(r, 1500));

    const normalRes = await fetch(`${base}/api/cluster4/weekly-cards?userId=${uid}`, {
      headers: { "x-internal-api-key": internalKey },
      cache: "no-store",
    });
    const normalJson = await normalRes.json();
    const demoRes = await fetch(
      `${base}/api/cluster4/weekly-cards?demoUserId=${uid}&mode=test`,
      { cache: "no-store" },
    );
    const demoJson = await demoRes.json();

    if (demoRes.status === 401 || demoJson?.error?.code === "demo_mode") {
      console.log("  ⚠ ENABLE_DEMO_MODE 미설정 → demo 경로 401, C skip (구조상 동일 loadWeeklyCards)");
      warn++;
    } else {
      check("normal(internal) 200/success", normalRes.ok && normalJson.success === true, `${normalRes.status}`);
      check("demo 200/success", demoRes.ok && demoJson.success === true, `${demoRes.status}`);
      check(
        "demo 카드/envelope == normal 카드/envelope (같은 기준)",
        stable(demoJson) === stable(normalJson),
        `user=${uid}`,
      );
    }
  }

  console.log(`\n결과: ✓ ${pass} / ✗ ${fail} / ⚠ ${warn}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
