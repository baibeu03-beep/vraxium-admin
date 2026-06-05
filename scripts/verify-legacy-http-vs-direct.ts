/**
 * HTTP(스냅샷) vs direct(실시간 계산) 정합 검증 — 레거시 통합 라인 정책.
 *   npx tsx --env-file=.env.local scripts/verify-legacy-http-vs-direct.ts <testerId> <realUserId>
 *
 *   1) GET /api/cluster4/weekly-cards?demoUserId=<tester>  (데모 경로)
 *   2) GET /api/cluster4/weekly-cards?userId=<real> + x-internal-api-key (internal 경로)
 *   3) 각 응답 cards 를 direct getCluster4WeeklyCardsForProfileUser 결과와 deep-compare
 *   4) GET /api/cluster4/weekly-growth?demoUserId=<tester> 레거시 주차 lineBreakdown 확인
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM } from "@/lib/lineAvailability";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";

function diffObjects(a: any, b: any, path = "", out: string[] = [], cap = 25): string[] {
  if (out.length >= cap) return out;
  if (a === b) return out;
  if (typeof a !== typeof b || a === null || b === null) {
    out.push(`${path}: ${JSON.stringify(a)?.slice(0, 80)} ≠ ${JSON.stringify(b)?.slice(0, 80)}`);
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push(`${path}.length: ${a.length} ≠ ${b.length}`);
      return out;
    }
    for (let i = 0; i < a.length; i++) diffObjects(a[i], b[i], `${path}[${i}]`, out, cap);
    return out;
  }
  if (typeof a === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) diffObjects(a[k], b[k], `${path}.${k}`, out, cap);
    return out;
  }
  out.push(`${path}: ${JSON.stringify(a)?.slice(0, 80)} ≠ ${JSON.stringify(b)?.slice(0, 80)}`);
  return out;
}

// 라인 정렬 키 — 카드 lines 배열 순서는 의미가 없을 수 있어 정렬 후 비교한다.
function normalizeCards(cards: any[]): any[] {
  return cards.map((c) => ({
    ...c,
    lines: [...(c.lines ?? [])].sort((x, y) =>
      `${x.partType}|${x.experienceSlotOrder}|${x.lineId}|${x.enhancementStatus}`.localeCompare(
        `${y.partType}|${y.experienceSlotOrder}|${y.lineId}|${y.enhancementStatus}`,
      ),
    ),
  }));
}

async function fetchCards(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers });
  const body: any = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function main() {
  const [testerId, realId] = process.argv.slice(2);
  if (!testerId || !realId) {
    console.error("usage: verify-legacy-http-vs-direct.ts <testerId> <realUserId>");
    process.exit(1);
  }
  let ok = true;

  // 1) demo 경로 (테스터)
  {
    const { status, body } = await fetchCards(
      `${BASE}/api/cluster4/weekly-cards?demoUserId=${testerId}`,
    );
    console.log(`demo HTTP status=${status} success=${body?.success} cards=${body?.data?.length}`);
    if (status !== 200 || !body?.success) { ok = false; }
    else {
      const direct = await getCluster4WeeklyCardsForProfileUser(testerId);
      const diffs = diffObjects(normalizeCards(body.data), normalizeCards(direct), "cards");
      if (diffs.length) {
        ok = false;
        console.log(`✗ demo HTTP vs direct 불일치 ${diffs.length}건:`);
        for (const d of diffs) console.log(`   ${d}`);
      } else {
        console.log("✓ demo HTTP == direct (deep-equal)");
      }
      // 레거시 카드 구조 스팟체크
      const legacy = body.data.filter((c: any) => c.startDate < CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM);
      const bad = legacy.filter((c: any) => {
        const exp = c.lines.filter((l: any) => l.partType === "experience" && l.lineId != null);
        const others = c.lines.filter((l: any) => l.partType !== "experience" && l.lineId != null);
        return others.length > 0 || exp.length > 1;
      });
      console.log(`  레거시 카드 ${legacy.length} | 구조 위반 ${bad.length}`);
      if (bad.length) ok = false;
    }
  }

  // 2) internal 경로 (실유저)
  {
    const { status, body } = await fetchCards(
      `${BASE}/api/cluster4/weekly-cards?userId=${realId}`,
      { "x-internal-api-key": process.env.INTERNAL_API_KEY ?? "" },
    );
    console.log(`internal HTTP status=${status} success=${body?.success} cards=${body?.data?.length}`);
    if (status !== 200 || !body?.success) { ok = false; }
    else {
      const direct = await getCluster4WeeklyCardsForProfileUser(realId);
      const diffs = diffObjects(normalizeCards(body.data), normalizeCards(direct), "cards");
      if (diffs.length) {
        ok = false;
        console.log(`✗ internal HTTP vs direct 불일치 ${diffs.length}건:`);
        for (const d of diffs) console.log(`   ${d}`);
      } else {
        console.log("✓ internal HTTP == direct (deep-equal)");
      }
    }
  }

  // 3) weekly-growth (실시간 경로) — 레거시 주차 lineBreakdown 게이트 확인
  {
    const { status, body } = await fetchCards(
      `${BASE}/api/cluster4/weekly-growth?demoUserId=${testerId}`,
    );
    const cards = body?.data?.weeklyCards ?? body?.weeklyCards ?? [];
    console.log(`weekly-growth HTTP status=${status} cards=${cards.length}`);
    if (status !== 200) ok = false;
    let bad = 0;
    for (const c of cards) {
      if (!(c.startDate < CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM)) continue;
      const lb = c.lineBreakdown;
      if (!lb) continue;
      const isRest = c.resultStatus === "personal_rest" || c.resultStatus === "official_rest";
      if (lb.info.available !== 0 || lb.ability.available !== 0 || lb.career.available !== 0) {
        bad++;
        console.log(
          `  ✗ ${c.startDate} 비경험 분모 잔존: info=${lb.info.available} ability=${lb.ability.available} career=${lb.career.available}`,
        );
      }
      if (!isRest && !c.isTransition && lb.experience.available !== 1 && c.weekId) {
        bad++;
        console.log(`  ✗ ${c.startDate} 경험 분모=${lb.experience.available} (기대 1)`);
      }
    }
    console.log(bad ? `✗ weekly-growth 레거시 게이트 위반 ${bad}건` : "✓ weekly-growth 레거시 게이트 OK");
    if (bad) ok = false;
  }

  console.log(ok ? "\n전체 PASS" : "\n전체 FAIL");
  process.exit(ok ? 0 : 1);
}
main();
