/**
 * Cluster4 4허브 rate(강화율/주차/시즌) — not_applicable 제외 & demo==normal DTO 검증.
 *   npx tsx --env-file=.env.local scripts/diag-cluster4-rate-not-applicable.ts [profileUserId]
 *
 * snapshot-only 구조이므로 4개 소스를 모두 비교한다:
 *   (L) live recompute   = getCluster4WeeklyCardsForProfileUser(userId)  ← 신정책 즉시 계산값
 *   (S) stored snapshot  = readWeeklyCardsSnapshot(userId)                ← 실제 저장/서빙값
 *   (Hc) HTTP demo weekly-cards   ?demoUserId=                            ← 브라우저 실수신값(카드)
 *   (Hg) HTTP demo weekly-growth  ?demoUserId=                            ← 브라우저 실수신값(성장)
 *
 * 검증 항목:
 *   1) not_applicable 라인이 분자/분모에 들어가는가 (enhancementStatus=not_applicable → denominator null 이어야 함)
 *   2) 카드 growthDenominator == Σ(part별 1회, denominator!=null) — 즉 분모가 not_applicable 제외 합과 일치
 *   3) area-7 4허브 rate/count/total (= earned/total) — not_applicable 제외 누적
 *   4) (S)==(L)? 다르면 stale snapshot (재계산 필요)
 *   5) (Hc)==(L)? 브라우저값이 신정책과 일치하는가
 *   6) (Hg) weekly-growth demo == direct getWeeklyGrowth
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { listTestUsers } from "@/lib/testUsers";
import {
  getWeeklyGrowth,
} from "@/lib/cluster4WeeklyGrowthData";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import {
  computeAreaSixCircles,
  computeSeasonAreaProgress,
} from "@/lib/cluster4SeasonCircles";
import { getSeasonForDate, seasonDbKey } from "@/lib/seasonCalendar";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

const BASE = process.env.BASE_URL || "http://localhost:3000";

function currentSeasonKey(): string | null {
  const s = getSeasonForDate(new Date().toISOString().slice(0, 10));
  return s ? seasonDbKey(s) : null;
}

type Card = Cluster4WeeklyCardDto;

// 카드 1장에서 part별(1회) 라인 분모/분자/enhancementStatus 를 추린다.
function perPartLines(card: Card) {
  const seen = new Set<string>();
  const out: {
    part: string;
    enhancementStatus: string;
    numerator: number | null;
    denominator: number | null;
    rate: number | null;
  }[] = [];
  for (const l of Array.isArray(card.lines) ? card.lines : []) {
    if (seen.has(l.partType)) continue;
    seen.add(l.partType);
    out.push({
      part: l.partType,
      enhancementStatus: l.enhancementStatus,
      numerator: l.numerator,
      denominator: l.denominator,
      rate: l.rate,
    });
  }
  return out;
}

// 검증 1+2: not_applicable 누수 / 카드 분모 일치.
function auditCards(label: string, cards: Card[]) {
  let leaks = 0;
  let denMismatch = 0;
  let naLines = 0;
  for (const c of cards) {
    const parts = perPartLines(c);
    let denSum = 0;
    let numSum = 0;
    for (const p of parts) {
      const isNA =
        p.enhancementStatus === "not_applicable" ||
        p.enhancementStatus === "해당 없음";
      if (isNA) {
        naLines++;
        // not_applicable 인데 분모/분자가 비어있지 않으면 누수.
        if (p.denominator != null || p.numerator != null) {
          leaks++;
          console.log(
            `   ❌ [${label}] week=${c.weekNumber} part=${p.part} NA but num=${p.numerator} den=${p.denominator}`,
          );
        }
        continue;
      }
      if (p.denominator != null) denSum += p.denominator;
      if (p.numerator != null) numSum += p.numerator;
    }
    // 카드 분모/분자가 not_applicable 제외 part 합과 일치하는지(휴식주차 제외).
    if (!c.isRestWeek) {
      if (c.growthDenominator !== denSum || c.growthNumerator !== numSum) {
        denMismatch++;
        console.log(
          `   ⚠ [${label}] week=${c.weekNumber} card(${c.growthNumerator}/${c.growthDenominator}) != Σpart(${numSum}/${denSum})`,
        );
      }
    }
  }
  console.log(
    `  [${label}] cards=${cards.length} NA라인=${naLines} 누수=${leaks} 카드분모불일치=${denMismatch} → ${leaks === 0 && denMismatch === 0 ? "✅" : "❌"}`,
  );
  return { leaks, denMismatch, naLines };
}

function printArea7(label: string, cards: Card[]) {
  const sk = currentSeasonKey();
  const prog = computeSeasonAreaProgress(cards, sk);
  const circ = computeAreaSixCircles(cards, sk);
  console.log(`  [${label}] area-7 4허브 강화율 (rate / count(earned) / total):`);
  for (const p of prog) {
    console.log(
      `     ${p.label.padEnd(6)} rate=${String(p.rate).padStart(3)}%  count=${p.earned}  total=${p.total}`,
    );
  }
  console.log(
    `  [${label}] area-6 시즌성장률 seasonGrowth=${circ.seasonGrowth}% (completedLines=${circ.completedLines}/availableLines=${circ.availableLines})`,
  );
  return { prog, circ };
}

// 카드 배열을 비교 가능한 정규형(JSON)으로. rate/num/den + per-line 만 추린다.
function cardRateShape(cards: Card[]) {
  return cards.map((c) => ({
    weekNumber: c.weekNumber,
    r: c.weeklyGrowthRate,
    n: c.growthNumerator,
    d: c.growthDenominator,
    lines: (Array.isArray(c.lines) ? c.lines : []).map((l) => ({
      p: l.partType,
      e: l.enhancementStatus,
      n: l.numerator,
      d: l.denominator,
      r: l.rate,
    })),
  }));
}

async function httpJson(path: string): Promise<any | null> {
  try {
    const res = await fetch(`${BASE}${path}`);
    const json: any = await res.json();
    return json;
  } catch (e) {
    console.log(`  HTTP ${path} 실패: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

async function pickUser(override: string | null) {
  const users = await listTestUsers();
  console.log(`[scan] test users = ${users.length}`);
  if (override) {
    const u = users.find((x) => x.userId === override);
    return { userId: override, name: u?.name ?? "(override)" };
  }
  // 라인이 가장 풍부한(=not_applicable 섞일 가능성 높은) 유저 우선.
  let best: { userId: string; name: string; score: number } | null = null;
  for (const u of users) {
    try {
      const cards = await getCluster4WeeklyCardsForProfileUser(u.userId);
      let lineCount = 0;
      for (const c of cards) lineCount += (c.lines ?? []).length;
      if (!best || lineCount > best.score)
        best = { userId: u.userId, name: u.name, score: lineCount };
    } catch {
      continue;
    }
  }
  return best;
}

async function main() {
  const picked = await pickUser(process.argv[2] || null);
  if (!picked) {
    console.log("❌ 테스트 유저 없음");
    return;
  }
  console.log(`\n[target] name=${picked.name} userId=${picked.userId}\n`);

  // (L) live recompute
  console.log("──────── (L) live recompute (getCluster4WeeklyCardsForProfileUser) ────────");
  const live = await getCluster4WeeklyCardsForProfileUser(picked.userId);
  const lAudit = auditCards("L", live);
  printArea7("L", live);

  // (S) stored snapshot
  console.log("\n──────── (S) stored snapshot (readWeeklyCardsSnapshot) ────────");
  const snap = await readWeeklyCardsSnapshot(picked.userId);
  if (snap.status === "hit" || snap.status === "stale") {
    console.log(`  snapshot status=${snap.status}${snap.status === "stale" ? `(${snap.reason})` : ""} computedAt=${snap.computedAt}`);
    auditCards("S", snap.cards);
    printArea7("S", snap.cards);
    const sEqL =
      JSON.stringify(cardRateShape(snap.cards)) ===
      JSON.stringify(cardRateShape(live));
    console.log(`  (검증4) stored snapshot == live recompute : ${sEqL ? "✅ 동일(snapshot fresh)" : "❌ 상이 → STALE (재계산 필요)"}`);
  } else {
    console.log(`  snapshot status=${snap.status} (저장된 카드 없음)`);
  }

  // (Hc) HTTP demo weekly-cards
  console.log("\n──────── (Hc) HTTP demo weekly-cards ?demoUserId= ────────");
  const hc = await httpJson(`/api/cluster4/weekly-cards?demoUserId=${picked.userId}`);
  if (hc?.success && Array.isArray(hc.data)) {
    const hcCards = hc.data as Card[];
    auditCards("Hc", hcCards);
    console.log(`  [Hc] area-7 (서버 응답 seasonAreaProgress):`);
    for (const p of hc.seasonAreaProgress ?? [])
      console.log(`     ${String(p.label).padEnd(6)} rate=${String(p.rate).padStart(3)}%  count=${p.earned}  total=${p.total}`);
    console.log(
      `  [Hc] area-6 seasonGrowth=${hc.areaSixCircles?.seasonGrowth}% (${hc.areaSixCircles?.completedLines}/${hc.areaSixCircles?.availableLines})`,
    );
    const hcEqL =
      JSON.stringify(cardRateShape(hcCards)) ===
      JSON.stringify(cardRateShape(live));
    console.log(`  (검증5) HTTP demo weekly-cards == live recompute : ${hcEqL ? "✅ 동일" : "❌ 상이 → 브라우저는 STALE snapshot 노출 중"}`);
  } else {
    console.log(`  HTTP weekly-cards demo 응답 실패: ${JSON.stringify(hc?.error ?? hc)}`);
  }

  // (Hg) HTTP demo weekly-growth vs direct
  console.log("\n──────── (Hg) HTTP demo weekly-growth ?demoUserId= ────────");
  const directGrowth = await getWeeklyGrowth(picked.userId);
  const hg = await httpJson(`/api/cluster4/weekly-growth?demoUserId=${picked.userId}`);
  if (hg?.success && hg.data && directGrowth) {
    const norm = (g: any) =>
      JSON.stringify(
        g.weeklyCards.map((c: any) => ({
          w: c.weekNumber,
          r: c.weeklyGrowth?.rate,
          n: c.weeklyGrowth?.completedLines,
          d: c.weeklyGrowth?.availableLines,
        })),
      );
    const eq = norm(hg.data) === norm(directGrowth);
    console.log(`  (검증6) weekly-growth demo == direct getWeeklyGrowth : ${eq ? "✅ 동일 DTO" : "❌ 상이"}`);
    console.log(`  seasonGrowthRates(direct): ${JSON.stringify(directGrowth.seasonGrowthRates.map((s) => ({ k: s.seasonKey, rate: s.rate, c: s.totalCompleted, t: s.totalAvailable })))}`);
  } else {
    console.log(`  weekly-growth demo 응답 실패 또는 direct null`);
  }

  console.log("\n──────── 결과 요약 ────────");
  console.log(`  (1) live not_applicable 누수 : ${lAudit.leaks === 0 ? "✅ 없음" : `❌ ${lAudit.leaks}건`}`);
  console.log(`  (2) live 카드 분모=Σpart    : ${lAudit.denMismatch === 0 ? "✅ 일치" : `❌ ${lAudit.denMismatch}건`}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
