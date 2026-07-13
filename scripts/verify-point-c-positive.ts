/**
 * 포인트 C 부호 정규화 검증 (2026-07-13).
 *   정책: Point C(penalty) 는 DTO·화면에서 항상 0 이상(양수). 최종 Point B(shield) = advantages − pointC (음수 가능).
 *         lightning(= −pointC) 은 하위호환 deprecated 필드로 병기.
 *
 *   방법(실 HTTP + snapshot + direct):
 *     - MY 변경 범위는 "user_weekly_points → 카드 DTO" 변환(pointC/shield/lightning)이다.
 *       적립(era) 게이트는 무관하며(테스트 W13 예외 폐지됨), 검증은 uwp 를 직접 seed 해
 *       변환·경로 파리티만 대상으로 한다(테스트유저 1명·W13·전 과정 원복·운영 무접촉).
 *     - 요구된 4 케이스(rawA=10, rawB, C)를 uwp 에 직접 써서 실제 HTTP 로 확인.
 *
 *   경로 파리티: direct == snapshot == HTTP(demo,mode=test) == HTTP(internal,userId,mode無=일반) == HTTP(internal,userId,mode=test).
 *     route 는 세 경로 모두 loadWeeklyCards(userId) 단일 SoT — mode/경로 무관 동일 DTO.
 *
 *   npx tsx --env-file=.env.local scripts/verify-point-c-positive.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import {
  readWeeklyCardsSnapshot,
  recomputeAndStoreWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const INTERNAL_KEY = process.env.INTERNAL_API_KEY || "";
const ADMIN_EMAIL = "vanuatu.golden@gmail.com";
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });
const J = (o: unknown) => JSON.stringify(o);
let pass = 0,
  fail = 0;
const ck = (l: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};

async function cookie() {
  const brow = createClient(URL, ANON);
  const { data: link } = await sb.auth.admin.generateLink({
    type: "magiclink",
    email: ADMIN_EMAIL,
  });
  const { data: v } = await brow.auth.verifyOtp({
    email: ADMIN_EMAIL,
    token: link!.properties.email_otp,
    type: "magiclink",
  });
  const cap: any[] = [];
  const srv = createServerClient(URL, ANON, {
    cookies: { getAll: () => [], setAll: (i: any) => cap.push(...i) },
  });
  await srv.auth.setSession({
    access_token: v.session!.access_token,
    refresh_token: v.session!.refresh_token,
  });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

// ── 1) 순수 공식: 요구된 4 케이스 ──
function pureFormula() {
  console.log("── 1) 순수 공식(요구 4케이스): finalB = rawB − C, pointC ≥ 0 ──");
  const cases = [
    { rawA: 10, rawB: 100, c: 0, finalB: 100 },
    { rawA: 10, rawB: 100, c: 30, finalB: 70 },
    { rawA: 10, rawB: 30, c: 30, finalB: 0 },
    { rawA: 10, rawB: 20, c: 30, finalB: -10 },
  ];
  for (const t of cases) {
    const pointC = t.c;
    const finalB = t.rawB - pointC;
    ck(
      `case A=${t.rawA} B=${t.rawB} C=${t.c} → finalB=${finalB}, pointC=${pointC}`,
      finalB === t.finalB && pointC >= 0 && pointC === t.c,
      `finalB=${finalB}(exp ${t.finalB})`,
    );
  }
}

async function main() {
  pureFormula();

  // ── 2) 셋업: test 유저(oranke) + W13 ──
  const markers = new Set(
    ((await sb.from("test_user_markers").select("user_id")).data ?? []).map(
      (x: any) => x.user_id,
    ),
  );
  const oranke = ((
    await sb
      .from("user_profiles")
      .select("user_id")
      .eq("organization_slug", "oranke")
  ).data ?? []) as any[];
  const user = oranke.find((u) => markers.has(u.user_id))?.user_id;
  const week = (
    await sb
      .from("weeks")
      .select("id,iso_year,iso_week,start_date")
      .eq("season_key", "2026-spring")
      .eq("week_number", 13)
      .maybeSingle()
  ).data as any;
  console.log("\n── 2) 실경로 seed(uwp 직접) + 파리티 (test유저 W13 · 원복) ──");
  ck(
    "[셋업] test유저·W13 존재",
    !!user && !!week?.id,
    J({ user: user?.slice(0, 8), week: week?.id?.slice(0, 8) }),
  );
  ck("[셋업] INTERNAL_API_KEY 존재(일반 경로 파리티용)", !!INTERNAL_KEY);
  if (!user || !week?.id) {
    console.log(`\n결과: ${pass} pass / ${fail} fail (셋업 실패)`);
    process.exit(2);
  }
  const iso = { y: week.iso_year as number, w: week.iso_week as number };
  const startDate = week.start_date as string;

  const origRow = (
    await sb
      .from("user_weekly_points")
      .select("id,points,advantages,penalty,checks_migrated")
      .eq("user_id", user)
      .eq("year", iso.y)
      .eq("week_number", iso.w)
      .maybeSingle()
  ).data as any;

  // uwp 를 직접 지정값으로 세팅(없으면 insert). 반환 = 성공 여부.
  const setUwp = async (points: number, advantages: number, penalty: number) => {
    if (origRow) {
      const { error } = await sb
        .from("user_weekly_points")
        .update({ points, advantages, penalty })
        .eq("id", origRow.id);
      return !error ? null : error.message;
    }
    const { error } = await sb.from("user_weekly_points").insert({
      user_id: user,
      year: iso.y,
      week_number: iso.w,
      points,
      advantages,
      penalty,
    });
    return !error ? null : error.message;
  };

  const ck0 = await cookie();
  const api = async (path: string, init: any = {}) => {
    const res = await fetch(`http://localhost:3000${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        cookie: ck0,
        ...(init.headers ?? {}),
      },
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const findCard = (cards: any[]) =>
    cards.find((c) => c.startDate === startDate) ??
    cards.find((c) => c.weekNumber === 13 && c.seasonKey === "2026-spring");

  // 요구된 4 케이스 (rawA=10). uwp.penalty 는 합계 컬럼이라 20 초과 가능.
  const cases = [
    { name: "A10 B100 C0  → finalB 100", A: 10, B: 100, C: 0, shield: 100 },
    { name: "A10 B100 C30 → finalB 70", A: 10, B: 100, C: 30, shield: 70 },
    { name: "A10 B30  C30 → finalB 0", A: 10, B: 30, C: 30, shield: 0 },
    { name: "A10 B20  C30 → finalB -10", A: 10, B: 20, C: 30, shield: -10 },
  ];

  let negativeSeen = false;
  for (const t of cases) {
    const expPoints = { star: t.A, shield: t.shield, pointC: t.C, lightning: -t.C };
    console.log(`\n  ▶ ${t.name}`);
    const setErr = await setUwp(t.A, t.B, t.C);
    ck(`    [seed] uwp {points:${t.A}, advantages:${t.B}, penalty:${t.C}}`, setErr === null, setErr ?? "");
    if (setErr) continue;
    await recomputeAndStoreWeeklyCardsSnapshot(user);
    if (t.shield < 0) negativeSeen = true;

    const eq = (p: any) =>
      !!p &&
      p.star === expPoints.star &&
      p.shield === expPoints.shield &&
      p.pointC === expPoints.pointC &&
      p.lightning === expPoints.lightning;

    // direct
    const direct = findCard((await getCluster4WeeklyCardsForProfileUser(user)) as any[]);
    ck(
      `    [direct] {star:${t.A}, shield:${t.shield}(=B−C), pointC:${t.C}(≥0), lightning:${-t.C}}`,
      eq(direct?.points),
      `points=${J(direct?.points)}`,
    );
    ck(`    [direct] pointC ≥ 0 (마이너스 부호 없음)`, (direct?.points?.pointC ?? -1) >= 0);
    ck(`    [direct] shield = B − C 정확`, direct?.points?.shield === t.B - t.C, `shield=${direct?.points?.shield}`);

    // snapshot 생성 == 조회
    const snap = await readWeeklyCardsSnapshot(user);
    const snapCard =
      snap.status === "hit" || snap.status === "stale" ? findCard(snap.cards as any[]) : null;
    ck(
      `    [snapshot] 생성==조회 (points == direct)`,
      (snap.status === "hit" || snap.status === "stale") && eq(snapCard?.points),
      `snapStatus=${snap.status} points=${J(snapCard?.points)}`,
    );

    // HTTP demo(mode=test)
    const hDemo = await api(`/api/cluster4/weekly-cards?demoUserId=${user}&mode=test`);
    const cDemo = findCard(hDemo.json?.data ?? []);
    ck(`    [HTTP demo mode=test] == direct`, hDemo.status === 200 && eq(cDemo?.points), `http=${hDemo.status} points=${J(cDemo?.points)}`);

    // HTTP internal(userId, mode無) = 일반 사용자 경로
    const hNorm = await api(`/api/cluster4/weekly-cards?userId=${user}`, {
      headers: { "x-internal-api-key": INTERNAL_KEY },
    });
    const cNorm = findCard(hNorm.json?.data ?? []);
    ck(`    [HTTP internal userId · 일반경로] == direct`, hNorm.status === 200 && eq(cNorm?.points), `http=${hNorm.status} points=${J(cNorm?.points)}`);

    // HTTP internal(userId, mode=test) — mode 불변
    const hNormT = await api(`/api/cluster4/weekly-cards?userId=${user}&mode=test`, {
      headers: { "x-internal-api-key": INTERNAL_KEY },
    });
    const cNormT = findCard(hNormT.json?.data ?? []);
    ck(
      `    [HTTP internal userId · mode=test] == mode無 (mode 무관)`,
      hNormT.status === 200 && eq(cNormT?.points) && J(cNormT?.points) === J(cNorm?.points),
      `http=${hNormT.status} points=${J(cNormT?.points)}`,
    );
  }
  ck("[음수] 최종 Point B 음수 케이스 관측(shield<0 & pointC>0)", negativeSeen);

  // ── 3) 원복 ──
  console.log("\n── 3) 원복 ──");
  if (origRow) {
    await sb
      .from("user_weekly_points")
      .update({
        points: origRow.points,
        advantages: origRow.advantages,
        penalty: origRow.penalty,
        checks_migrated: origRow.checks_migrated,
      })
      .eq("id", origRow.id);
  } else {
    await sb
      .from("user_weekly_points")
      .delete()
      .eq("user_id", user)
      .eq("year", iso.y)
      .eq("week_number", iso.w);
  }
  await recomputeAndStoreWeeklyCardsSnapshot(user);
  const after = (
    await sb
      .from("user_weekly_points")
      .select("points,advantages,penalty")
      .eq("user_id", user)
      .eq("year", iso.y)
      .eq("week_number", iso.w)
      .maybeSingle()
  ).data as any;
  const back = origRow
    ? after?.points === origRow.points &&
      after?.advantages === origRow.advantages &&
      after?.penalty === origRow.penalty
    : !after;
  ck("[원복] uwp 원상복구", back, `after=${J(after)} orig=${J(origRow ? { points: origRow.points, advantages: origRow.advantages, penalty: origRow.penalty } : "(none)")}`);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e?.stack ?? e);
  process.exit(1);
});
