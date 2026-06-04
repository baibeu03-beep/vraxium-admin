/**
 * 포인트 표시 정책(2026-06-04) — 고객앱(front, localhost:3001) HTTP 검증.
 *
 *   1) /api/cluster4/weekly-growth/?userId= → data.seasonSummaries[].pointSummary(시즌 상세 페이지네이션)
 *        · 각 시즌 shield=net·lightning=−n, Σ(시즌 star) == 이력서 별, Σ(시즌 shield) == 이력서 방패(net),
 *          Σ(시즌 lightning) == 이력서 번개(−n)  ← 이번 통일의 핵심 (이력서 == Σ시즌페이지)
 *   2) /api/profile/?userId= → badges/point(이력서 카드)·seasonHistories[].seasonPoints
 *   3) /api/profile/summary/?userId= → badges (Sidebar 경량 경로 — 컬럼 교정 확인)
 *   4) raw advantage 미노출: 위 응답들의 표시 필드에 rawAdv 가 그대로 나오면 실패
 *        (rawAdv != net 인 유저로 검증해야 의미 있음 → penalty>0 대상 선정)
 *   npx tsx --env-file=.env.local scripts/verify-point-display-policy-front-http.ts
 */
import { createClient } from "@supabase/supabase-js";

const FRONT = process.env.FRONT_BASE_URL ?? "http://localhost:3001";
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

let fail = 0;
const expectEq = (label: string, actual: unknown, expected: unknown) => {
  const ok = actual === expected;
  if (!ok) fail++;
  console.log(`   ${ok ? "✓" : "✗"} ${label}: ${JSON.stringify(actual)} (기대 ${JSON.stringify(expected)})`);
};

async function getJson(path: string) {
  const res = await fetch(`${FRONT}${path}`);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

async function main() {
  // 대상: 옥지윤 (rawAdv=3 pen=2 net=1 — raw≠net 이라 raw 노출 검증에 유효)
  const { data: prof } = await sb
    .from("user_profiles")
    .select("user_id, display_name")
    .eq("display_name", "옥지윤")
    .maybeSingle();
  if (!prof) throw new Error("옥지윤 미발견");
  const userId = (prof as any).user_id as string;

  const { data: uwp } = await sb
    .from("user_weekly_points")
    .select("points, advantages, penalty")
    .eq("user_id", userId);
  let star = 0, adv = 0, pen = 0;
  for (const r of (uwp ?? []) as any[]) {
    star += r.points ?? 0;
    adv += r.advantages ?? 0;
    pen += r.penalty ?? 0;
  }
  const net = adv - pen;
  console.log(`■ 옥지윤 (${userId.slice(0, 8)}) — 원장: rawAdv=${adv} penalty=${pen} net=${net} star=${star}`);

  // 1) 시즌 상세 페이지네이션 (front weekly-growth)
  const wg = await getJson(`/api/cluster4/weekly-growth/?userId=${userId}`);
  const summaries: any[] = wg?.data?.seasonSummaries ?? [];
  console.log(` 1) seasonSummaries ${summaries.length}개:`);
  let sStar = 0, sShield = 0, sLight = 0;
  for (const s of summaries) {
    const p = s.pointSummary ?? {};
    console.log(`   · ${s.seasonKey}: star=${p.star} shield=${p.shield} lightning=${p.lightning}`);
    if (typeof p.lightning === "number" && p.lightning > 0) {
      console.log("     ✗ lightning > 0 (양수 표기 금지)");
      fail++;
    }
    sStar += p.star ?? 0;
    sShield += p.shield ?? 0;
    sLight += p.lightning ?? 0;
  }
  expectEq("Σ시즌 star == 이력서 별", sStar, star);
  expectEq("Σ시즌 shield == 이력서 방패(net)", sShield, net);
  expectEq("Σ시즌 lightning == 이력서 번개(−pen)", sLight, -pen);
  if (pen > 0) expectEq("raw advantage 미노출 (Σ시즌 shield ≠ rawAdv)", sShield !== adv, true);
  const sps = wg?.data?.seasonPointSummary;
  console.log(`   현재시즌 seasonPointSummary: ${JSON.stringify(sps)}`);
  if (sps && sps.lightning > 0) { console.log("   ✗ 현재시즌 lightning > 0"); fail++; }

  // 2) /api/profile (이력서 카드 SoT)
  const pf = await getJson(`/api/profile/?userId=${userId}`);
  console.log(" 2) /api/profile:");
  expectEq("point.check(별)", pf?.point?.check, star);
  expectEq("point.advantage(방패=net)", pf?.point?.advantage, net);
  expectEq("point.penalty(번개=−pen)", pf?.point?.penalty, -pen);
  expectEq("badges.stars", pf?.badges?.stars, star);
  expectEq("badges.shields(net)", pf?.badges?.shields, net);
  expectEq("badges.lightnings(−pen)", pf?.badges?.lightnings, -pen);
  const sh = (pf?.seasonHistories ?? []).filter((h: any) => h.seasonPoints);
  let hStar = 0, hShield = 0, hLight = 0;
  for (const h of sh) {
    hStar += h.seasonPoints.stars ?? 0;
    hShield += h.seasonPoints.shields ?? 0;
    hLight += h.seasonPoints.lightnings ?? 0;
    if (h.seasonPoints.lightnings > 0) { console.log(`   ✗ seasonHistories lightning > 0 (${h.id})`); fail++; }
  }
  console.log(`   seasonHistories(seasonPoints) ${sh.length}개: Σstars=${hStar} Σshields=${hShield} Σlightnings=${hLight}`);

  // 3) /api/profile/summary (Sidebar 경량 경로)
  const sm = await getJson(`/api/profile/summary/?userId=${userId}`);
  console.log(" 3) /api/profile/summary:");
  expectEq("badges.stars", sm?.badges?.stars, star);
  expectEq("badges.shields(net)", sm?.badges?.shields, net);
  expectEq("badges.lightnings(−pen)", sm?.badges?.lightnings, -pen);

  console.log(`\n${fail === 0 ? "✓ front HTTP 전체 통과" : `✗ 실패 ${fail}건`}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
