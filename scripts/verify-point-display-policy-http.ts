/**
 * 포인트 표시 정책(2026-06-04 통일) 실제 HTTP 검증 — admin dev 서버 필요(localhost:3000).
 *
 *   표면:
 *     1) GET /api/admin/crews/{uuid}/resume-card                  → computed.totalStars/Shields/Lightnings
 *     2) GET /api/admin/crews/{uuid}/cluster4/weekly-growth       → seasonPointSummary
 *     3) GET /api/cluster4/weekly-cards?demoUserId={tester}&userId={target} → data[].points (demo 경로 + snapshot v15)
 *     4) GET /api/cluster4/weekly-growth?demoUserId={tester}&userId={target} → seasonPointSummary (demo 경로)
 *
 *   기대치: user_weekly_points 원장 독립 재계산. raw advantage 가 응답의 표시 필드에
 *   섞이지 않는지(방패=net·번개=−pen)와 direct 결과와의 일치를 함께 확인한다.
 *   npx tsx --env-file=.env.local scripts/verify-point-display-policy-http.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

const sb = createClient(
  ensureEnv("NEXT_PUBLIC_SUPABASE_URL"),
  ensureEnv("SUPABASE_SERVICE_ROLE_KEY"),
);

async function makeAdminCookieHeader() {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const browser = createClient(supabaseUrl, anonKey);
  const { data: linkData, error: linkError } = await sb.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  if (linkError || !linkData?.properties?.email_otp) {
    throw new Error(linkError?.message ?? "Failed to generate admin magic link");
  }
  const { data: verifyData, error: verifyError } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties.email_otp,
    type: "magiclink",
  });
  if (verifyError || !verifyData.session) {
    throw new Error(verifyError?.message ?? "Failed to verify admin OTP");
  }
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll() {
        return [];
      },
      setAll(items) {
        captured.push(...items.map((i) => ({ name: i.name, value: i.value })));
      },
    },
  });
  const { error: setError } = await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  if (setError) throw new Error(setError.message);
  return captured.map((c) => `${c.name}=${c.value}`).join("; ");
}

type Raw = { star: number; adv: number; pen: number };

async function fetchRaw(userId: string): Promise<{ total: Raw; byWeek: Map<string, Raw> }> {
  const { data, error } = await sb
    .from("user_weekly_points")
    .select("week_start_date, points, advantages, penalty")
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  const total: Raw = { star: 0, adv: 0, pen: 0 };
  const byWeek = new Map<string, Raw>();
  for (const r of (data ?? []) as any[]) {
    total.star += r.points ?? 0;
    total.adv += r.advantages ?? 0;
    total.pen += r.penalty ?? 0;
    if (r.week_start_date) {
      const w = byWeek.get(r.week_start_date) ?? { star: 0, adv: 0, pen: 0 };
      w.star += r.points ?? 0;
      w.adv += r.advantages ?? 0;
      w.pen += r.penalty ?? 0;
      byWeek.set(r.week_start_date, w);
    }
  }
  return { total, byWeek };
}

let fail = 0;
function expectEq(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) fail++;
  console.log(`   ${ok ? "✓" : "✗"} ${label}: ${actual} (기대 ${expected})`);
}

async function main() {
  // 대상 — penalty>0 실유저(옥지윤) + penalty>0 테스터 1명
  const { data: prof } = await sb
    .from("user_profiles")
    .select("user_id, display_name")
    .eq("display_name", "옥지윤")
    .maybeSingle();
  if (!prof) throw new Error("옥지윤 미발견");
  const realId = (prof as any).user_id as string;

  const { data: markers } = await sb.from("test_user_markers").select("user_id").limit(200);
  const testerSet = new Set((markers ?? []).map((m: any) => m.user_id));
  // penalty>0 테스터 탐색
  let testerId: string | null = null;
  for (const id of testerSet) {
    const { data } = await sb
      .from("user_weekly_points")
      .select("penalty")
      .eq("user_id", id)
      .gt("penalty", 0)
      .limit(1);
    if ((data ?? []).length > 0) {
      testerId = id;
      break;
    }
  }
  if (!testerId) throw new Error("penalty>0 테스터 미발견");

  const cookie = await makeAdminCookieHeader();
  const get = async (path: string) => {
    const res = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return res.json();
  };

  for (const [label, userId] of [
    ["실유저 옥지윤", realId],
    ["테스터", testerId],
  ] as const) {
    const raw = await fetchRaw(userId);
    const t = raw.total;
    console.log(`\n■ [${label}] ${userId.slice(0, 8)} — 원장: rawAdv=${t.adv} penalty=${t.pen} net=${t.adv - t.pen} star=${t.star}`);

    // 1) 이력서 카드
    const rc = await get(`/api/admin/crews/${userId}/resume-card`);
    const computed = rc?.data?.computed ?? rc?.computed;
    console.log(" 1) resume-card HTTP:");
    expectEq("totalStars", computed?.totalStars, t.star);
    expectEq("totalShields(net)", computed?.totalShields, t.adv - t.pen);
    expectEq("totalLightnings(−pen)", computed?.totalLightnings, -t.pen);

    // 2) weekly-growth (admin crews 경로) seasonPointSummary
    const wg = await get(`/api/admin/crews/${userId}/cluster4/weekly-growth`);
    const sps = wg?.data?.seasonPointSummary ?? wg?.seasonPointSummary;
    console.log(` 2) weekly-growth HTTP seasonPointSummary: ${JSON.stringify(sps)}`);
    if (sps) expectEq("lightning ≤ 0", sps.lightning <= 0, true);

    // 3) weekly-cards (demo 경로: demoUserId=테스터, userId=대상) — snapshot v15
    const wc = await get(`/api/cluster4/weekly-cards?demoUserId=${testerId}&userId=${userId}`);
    const cards: any[] = wc?.data ?? [];
    let checked = 0;
    let mismatch = 0;
    const samples: string[] = [];
    for (const c of cards) {
      const w = raw.byWeek.get(c.startDate);
      if (!w) continue;
      checked++;
      const ok =
        c.points?.star === w.star &&
        c.points?.shield === w.adv - w.pen &&
        c.points?.lightning === -w.pen;
      if (!ok) mismatch++;
      if (samples.length < 3 && (w.pen > 0 || w.adv > 0)) {
        samples.push(
          `${c.startDate}: raw(adv=${w.adv},pen=${w.pen}) → HTTP(star=${c.points?.star},shield=${c.points?.shield},lightning=${c.points?.lightning})${ok ? "" : " ✗"}`,
        );
      }
    }
    console.log(` 3) weekly-cards HTTP(demo): cards=${cards.length}, 검사 ${checked}주, 불일치 ${mismatch}건${mismatch ? " ✗" : " ✓"}`);
    samples.forEach((s) => console.log(`   · ${s}`));
    if (mismatch) fail++;

    // 4) weekly-growth (demo 경로) seasonPointSummary
    const wgd = await get(`/api/cluster4/weekly-growth?demoUserId=${testerId}&userId=${userId}`);
    const spsD = wgd?.data?.seasonPointSummary;
    console.log(` 4) weekly-growth HTTP(demo) seasonPointSummary: ${JSON.stringify(spsD)}`);
    if (sps && spsD) {
      expectEq("demo == admin-crews (star)", spsD.star, sps.star);
      expectEq("demo == admin-crews (shield)", spsD.shield, sps.shield);
      expectEq("demo == admin-crews (lightning)", spsD.lightning, sps.lightning);
    }
  }

  console.log(`\n${fail === 0 ? "✓ HTTP 전체 통과" : `✗ 실패 ${fail}건`}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
