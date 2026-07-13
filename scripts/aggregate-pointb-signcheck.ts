/**
 * 최종 Point B 부호 실데이터 감사 (2026-07-13).
 *   finalPointB = rawPointB(Σadvantages) − pointC(Σpenalty).
 *   전체 사용자(운영/테스트) 대상으로:
 *     - 누적(per-user): Σadv, Σpen, net=Σadv−Σpen. min(net)·음수 사용자 목록.
 *     - 주차(per user·week): adv−pen. min·음수 (user,week) 목록.
 *   목적: 어드민 화면 "모두 양수"가 실데이터상 정상(min≥0)인지, 아니면 clamp/formatter 은닉인지 판정.
 *
 *   npx tsx --env-file=.env.local scripts/aggregate-pointb-signcheck.ts
 */
import { createClient } from "@supabase/supabase-js";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });

async function main() {
  // 테스트 유저 마커
  const markers = new Set(
    ((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x: any) => x.user_id),
  );

  // user_weekly_points 전량 페이지네이션
  type Cum = { a: number; b: number; c: number };
  const cum = new Map<string, Cum>();
  const weekNeg: Array<{ user: string; y: number; w: number; adv: number; pen: number; net: number }> = [];
  let weekMin = Infinity;
  let weekMinKey = "";
  let rowCount = 0;
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await sb
      .from("user_weekly_points")
      .select("user_id,year,week_number,points,advantages,penalty")
      .order("user_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    for (const r of rows as any[]) {
      rowCount++;
      const adv = r.advantages ?? 0;
      const pen = r.penalty ?? 0;
      const acc = cum.get(r.user_id) ?? { a: 0, b: 0, c: 0 };
      acc.a += r.points ?? 0;
      acc.b += adv;
      acc.c += pen;
      cum.set(r.user_id, acc);
      const net = adv - pen;
      if (net < weekMin) {
        weekMin = net;
        weekMinKey = `${r.user_id} y${r.year}w${r.week_number} adv=${adv} pen=${pen}`;
      }
      if (net < 0) weekNeg.push({ user: r.user_id, y: r.year, w: r.week_number, adv, pen, net });
    }
    if (rows.length < PAGE) break;
    from += PAGE;
  }

  // 누적 집계
  let cumMin = Infinity;
  let cumMinUser = "";
  const cumNeg: Array<{ user: string; b: number; c: number; net: number; test: boolean }> = [];
  let opUsers = 0,
    testUsers = 0;
  for (const [uid, v] of cum) {
    const net = v.b - v.c;
    const isTest = markers.has(uid);
    isTest ? testUsers++ : opUsers++;
    if (net < cumMin) {
      cumMin = net;
      cumMinUser = `${uid} Σadv=${v.b} Σpen=${v.c}`;
    }
    if (net < 0) cumNeg.push({ user: uid, b: v.b, c: v.c, net, test: isTest });
  }

  const split = (arr: Array<{ test: boolean }>) => ({
    op: arr.filter((x) => !x.test).length,
    test: arr.filter((x) => x.test).length,
  });

  console.log("═══ 최종 Point B 부호 감사 (finalB = Σadv − Σpen) ═══");
  console.log(`user_weekly_points 행수: ${rowCount}`);
  console.log(`사용자 수: 총 ${cum.size} (운영 ${opUsers} · 테스트 ${testUsers})`);
  console.log("");
  console.log("── [누적 per-user] net = Σadvantages − Σpenalty (어드민 members Net / 고객 시즌누적 방패 기준) ──");
  console.log(`  min(Σadv − Σpen) = ${cumMin}  @ ${cumMinUser}`);
  console.log(`  net < 0 사용자 수 = ${cumNeg.length}  (운영 ${split(cumNeg).op} · 테스트 ${split(cumNeg).test})`);
  for (const n of cumNeg.slice(0, 30))
    console.log(`    ⚠ ${n.user}  Σadv=${n.b} Σpen=${n.c} → net=${n.net} ${n.test ? "(test)" : ""}`);
  if (cumNeg.length > 30) console.log(`    … 외 ${cumNeg.length - 30}명`);
  console.log("");
  console.log("── [주차 per-week] net = advantages − penalty (고객 카드 방패 shield 기준) ──");
  console.log(`  min(adv − pen) = ${weekMin}  @ ${weekMinKey}`);
  console.log(`  주차 net < 0 인 (user,week) 수 = ${weekNeg.length}`);
  const weekNegUsers = new Set(weekNeg.map((x) => x.user));
  const weekNegOp = [...weekNegUsers].filter((u) => !markers.has(u)).length;
  console.log(`  해당 사용자 수 = ${weekNegUsers.size} (운영 ${weekNegOp} · 테스트 ${weekNegUsers.size - weekNegOp})`);
  for (const n of weekNeg.slice(0, 30))
    console.log(`    ⚠ ${n.user} y${n.y}w${n.w}  adv=${n.adv} pen=${n.pen} → ${n.net} ${markers.has(n.user) ? "(test)" : ""}`);
  if (weekNeg.length > 30) console.log(`    … 외 ${weekNeg.length - 30}건`);
  console.log("");
  console.log("═══ 판정 ═══");
  console.log(`  누적 min = ${cumMin} → ${cumMin >= 0 ? "0 이상: 누적 최종B 전원 양수(정상)" : "음수 존재: 최종B 음수 사용자 있음"}`);
  console.log(`  주차 min = ${weekMin} → ${weekMin >= 0 ? "0 이상: 주차 shield 전원 양수(정상)" : "음수 존재: shield 음수 주차 있음 → API/UI 음수 노출 확인 필요"}`);

  // 부수 출력: 음수 케이스가 있으면 대조용 user id 를 파일로 남김
  const negUserForHttp =
    weekNeg[0]?.user ?? cumNeg[0]?.user ?? null;
  if (negUserForHttp) console.log(`\n  대조 대상 user(HTTP/UI 확인용): ${negUserForHttp}`);
  else console.log(`\n  음수 케이스 없음 → HTTP/UI 대조 불필요(전원 양수는 실데이터상 정상).`);
}

main().catch((e) => {
  console.error("FATAL:", e?.stack ?? e);
  process.exit(1);
});
