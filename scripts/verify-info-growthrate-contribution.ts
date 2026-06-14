// 검증(READ-ONLY) — 실무 정보(part_type='info') 라인이 최종 weeklyGrowthRate(성장률)에
// "직접" 반영되는지(= 강화율뿐 아니라 성장률 분모/분자에도 합산되는지) 확인.
//   사전: dev 서버(:3000). 실행: npx tsx --env-file=.env.local scripts/verify-info-growthrate-contribution.ts
// 기준: 1) direct function  2) HTTP API  3) 고객 DTO(Cluster4WeeklyCardDto)
// DB write 0 · snapshot 무접촉.

import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE);

let pass = 0;
let fail = 0;
const ck = (l: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};

async function cookie(): Promise<string> {
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: ADMIN_EMAIL });
  const otp = link.properties?.email_otp;
  if (!otp) throw new Error("otp 없음");
  const { data: v } = await browser.auth.verifyOtp({ email: ADMIN_EMAIL, token: otp, type: "magiclink" });
  const cap: Array<{ name: string; value: string }> = [];
  const srv = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session!.access_token, refresh_token: v.session!.refresh_token });
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}

// 카드 lines 에서 part_type별 강화율 A/B 를 직접 재집계(=breakdownFromLines 와 동일 규칙).
function recountByHub(card: Cluster4WeeklyCardDto) {
  const hub = {
    information: { c: 0, a: 0 },
    competency: { c: 0, a: 0 },
    experience: { c: 0, a: 0 },
    career: { c: 0, a: 0 },
  } as Record<string, { c: number; a: number }>;
  for (const line of card.lines) {
    if (line.enhancementStatus === "not_applicable") continue;
    const k = line.partType;
    if (!hub[k]) continue;
    hub[k].a += 1;
    if (line.enhancementStatus === "success") hub[k].c += 1;
  }
  return hub;
}

async function main() {
  const c = await cookie();
  // dev 서버 ready 대기.
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/admin/cluster4/admin-org`, { headers: { cookie: c } })).status === 200) break;
    } catch {/* wait */}
    await new Promise((r) => setTimeout(r, 2000));
  }

  const snapBefore =
    (await sb.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true })).count ?? 0;

  // 분석 대상 = info 라인이 실제로 칸에 실린(강화율 분모>0) 사용자/카드 후보 탐색.
  // user_profiles 에서 일부 표본을 직접 compute 해 info.available>0 카드를 찾는다.
  const { data: profs } = await sb
    .from("user_profiles")
    .select("user_id,display_name,organization_slug")
    .eq("organization_slug", "oranke")
    .limit(120);
  const candidates = ((profs ?? []) as Array<{ user_id: string; display_name: string | null }>);

  let found: { userId: string; name: string; card: Cluster4WeeklyCardDto } | null = null;
  for (const p of candidates) {
    let cards: Cluster4WeeklyCardDto[];
    try {
      cards = await getCluster4WeeklyCardsForProfileUser(p.user_id);
    } catch {
      continue;
    }
    for (const card of cards) {
      if (card.isRestWeek) continue;
      const hub = recountByHub(card);
      if (hub.information.a > 0 && (card.growthDenominator ?? 0) > 0) {
        found = { userId: p.user_id, name: p.display_name ?? "(이름없음)", card };
        break;
      }
    }
    if (found) break;
  }

  if (!found) {
    console.log("  ! info 라인 칸(강화율 분모>0)이 실린 카드를 표본에서 찾지 못함 — 표본 확대 필요");
    process.exit(2);
  }

  const { userId, name, card } = found;
  console.log(`\n분석 대상: ${name} (${userId}) / week=${card.weekLabel} (${card.weekId})`);
  const hub = recountByHub(card);
  console.log(
    `  hub 강화율 A/B → info ${hub.information.c}/${hub.information.a} · 역량 ${hub.competency.c}/${hub.competency.a} · 경험 ${hub.experience.c}/${hub.experience.a} · 커리어 ${hub.career.c}/${hub.career.a}`,
  );
  console.log(`  카드 성장률 분자/분모 = ${card.growthNumerator}/${card.growthDenominator} (rate=${card.weeklyGrowthRate})`);

  const sumC = hub.information.c + hub.competency.c + hub.experience.c + hub.career.c;
  const sumA = hub.information.a + hub.competency.a + hub.experience.a + hub.career.a;

  // ── 1. direct: 성장률 분모/분자 = 4허브(info 포함) 합산과 정확히 일치 ──
  ck(
    "[direct] growthDenominator = 4허브 합산(info 포함)",
    card.growthDenominator === sumA,
    `카드 ${card.growthDenominator} == 합산 ${sumA}`,
  );
  ck(
    "[direct] growthNumerator = 4허브 합산(info 포함)",
    card.growthNumerator === sumC,
    `카드 ${card.growthNumerator} == 합산 ${sumC}`,
  );

  // ── 2. direct: info 를 제외하면 분모/분자가 줄어든다 = info 가 성장률에 직접 기여 ──
  const exInfoA = sumA - hub.information.a;
  const exInfoC = sumC - hub.information.c;
  ck(
    "[direct] info 제외 시 성장률 분모 감소(= info 직접 기여)",
    exInfoA < (card.growthDenominator ?? 0),
    `info제외 분모 ${exInfoA} < 전체 ${card.growthDenominator} (info 기여 ${hub.information.a}칸)`,
  );

  // ── 3. info 라인 칸이 강화율(numerator/denominator)도 동시에 갖는지(허브 강화율 반영) ──
  const infoLines = card.lines.filter(
    (l) => l.partType === "information" && l.enhancementStatus !== "not_applicable",
  );
  ck(
    "[direct] info 라인 칸이 강화율 분모(denominator)도 보유",
    infoLines.length > 0 && infoLines.every((l) => (l.denominator ?? 0) > 0),
    `info 칸 ${infoLines.length}개, denominator=${infoLines.map((l) => l.denominator).join(",")}`,
  );

  // ── 4. HTTP API: 동일 사용자 카드의 성장률 분모/분자 == direct ──
  const res = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${userId}`, { headers: { cookie: c } });
  const json = await res.json();
  const httpCards: Cluster4WeeklyCardDto[] = json?.data ?? [];
  const httpCard = httpCards.find((x) => x.weekId === card.weekId) ?? null;
  ck("[HTTP] 응답 성공 + 해당 주차 카드 존재", res.status === 200 && !!httpCard, `status=${res.status}`);
  if (httpCard) {
    ck(
      "[HTTP==direct] growthNumerator/Denominator 일치",
      httpCard.growthNumerator === card.growthNumerator &&
        httpCard.growthDenominator === card.growthDenominator,
      `HTTP ${httpCard.growthNumerator}/${httpCard.growthDenominator} == direct ${card.growthNumerator}/${card.growthDenominator}`,
    );
    ck(
      "[HTTP==direct] weeklyGrowthRate 일치",
      httpCard.weeklyGrowthRate === card.weeklyGrowthRate,
      `HTTP ${httpCard.weeklyGrowthRate} == direct ${card.weeklyGrowthRate}`,
    );
    // ── 5. 고객 DTO: HTTP 응답(=고객 DTO)의 info 칸도 성장률 합산에 포함되는지 재집계 ──
    const httpHub = recountByHub(httpCard);
    const httpSumA =
      httpHub.information.a + httpHub.competency.a + httpHub.experience.a + httpHub.career.a;
    ck(
      "[고객DTO] growthDenominator = 고객 lines 4허브 합산(info 포함)",
      httpCard.growthDenominator === httpSumA && httpHub.information.a > 0,
      `DTO ${httpCard.growthDenominator} == 합산 ${httpSumA} (info ${httpHub.information.a}칸)`,
    );
  }

  const snapAfter =
    (await sb.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true })).count ?? 0;
  ck("[격리] snapshot count 불변", snapAfter === snapBefore, `${snapBefore}→${snapAfter}`);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
